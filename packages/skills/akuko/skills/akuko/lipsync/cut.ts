/**
 * akuko — the line audio for a lip-sync: find it, or cut it (WP-28b).
 *
 * The lip-sync provider takes the spoken line as a **16-bit PCM WAV file**
 * already cut to the shot. Where it comes from, in this order:
 *
 *   1. The line's own clip (`audio.lines[].clip_uri`), as it is, when the shot
 *      has exactly one spoken line and the clip is a 16-bit PCM WAV that can be
 *      read: inside the project folder, or inside a folder the person named
 *      with `--allow-root` for this run (never remembered, never invented).
 *      A clip in another WAV format (24-bit, float) is converted: cut whole,
 *      as a slice of the clip.
 *   2. Else a **slice of `audio.master`**, the span `plan.ts` `wantedSpan()`
 *      gives (the lines plus a small pad, inside the shot).
 *
 * A cut is a new file in `lipsync/cuts/`, recorded exactly per WP-26's slice
 * contract (lib/state.md §"Rules guard (WP-26)"), so the rules guard can
 * check it before anything is uploaded:
 *
 *     id        <shot>_linecut     kind vo · stage motion · owner = the shot
 *     provider  "akuko-cut"        (SLICE_PROVIDER)
 *     tags      lipsync-audio, slice-of:sha256:<source>@<in_s>-<out_s> (sliceTag()), lines:<ids>
 *     file      { uri, mime: audio/wav, hash: <sha256 of the cut> }
 *     film      the span on the master clock (a master slice)
 *
 * It is recorded `pending-review`: like every file akuko records, a person
 * listens to it on the board. That is not what lets it run (the key frame and
 * an available audio file are); it is what lets the stage be approved.
 *
 * The master is streamed once per run (`sound/wav.ts` `sliceWavTo16`), never
 * loaded whole, and hashed in the same pass. When `audio.master.sha256` is
 * recorded, a master that no longer matches it is refused. When it is not
 * recorded, the computed hash is used for the slice tags and the person is
 * told to record it (`cli.ts record-master-hash`); nothing here writes
 * `audio.master`.
 */

import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AkukoProject, Asset, AudioLine, Shot } from '../schema/akuko-project.ts';
import { freeName, writeFileAtomic } from '../hosts/local.ts';
import { SLICE_PROVIDER, parseSliceTag, sha256Bytes, sha256File, sliceTag } from '../rules/refs.ts';
import { framesOf, isPcm16, readWavLayout, sliceWavTo16, type FrameRange, type WavLayout } from '../sound/wav.ts';
import { removedAt } from '../decisions/fold.ts';
import {
  CUT_TAG,
  LIPSYNC_STAGE,
  assetIdFor,
  cutIdFor,
  currentUnits,
  orphanLine,
  orphanedUnits,
  secs,
  shotOf,
  spokenLines,
  wantedSpan,
  type Audio,
  type AudioLookup,
  type Span,
} from './plan.ts';

/** Where cuts are written, relative to the project folder. */
export const CUT_DIR = 'lipsync/cuts';

export interface AudioContext {
  /** The project folder. */
  projectDir: string;
  /** Folders outside the project the person named for this run (`--allow-root`). Never stored. */
  allowRoots?: string[];
  /** `master`: the person chose the master cut over a line's own clip, for this run (`--from master`). */
  from?: 'master';
  /** Only this part's lip-syncs are looked up, cut or hashed (`--part P7`, WP-32). */
  part?: string;
}

const scopeOf = (ctx: Pick<AudioContext, 'part'>): { part?: string } => (ctx.part !== undefined ? { part: ctx.part } : {});

/** Added to what the spend line says about audio read from outside the project folder (a line clip there, or one read through --allow-root). */
export const OUTSIDE_WARNING = 'a file outside the project; check it holds only speech that may leave your machine (line clips can be cut from an unbleeped reference)';

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (root: string, p: string): boolean => {
  const rel = relative(norm(root), norm(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** A uri as a path: relative to the project folder (it may go up out of it), absolute, or `file://`. Undefined for any other scheme. */
export function pathOf(uri: string, projectDir: string): string | undefined {
  if (uri.startsWith('file://')) return fileURLToPath(uri);
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) return undefined;
  return isAbsolute(uri) ? uri : resolve(projectDir, uri);
}

/** The real path of `uri` when it is a readable file inside the project folder or an allowed root; else why not. */
async function readable(uri: string, ctx: AudioContext): Promise<{ path: string; outside: boolean } | { why: string }> {
  const p = pathOf(uri, ctx.projectDir);
  if (!p) return { why: `${uri} is not a local file` };
  let real: string;
  try { real = await realpath(p); } catch { return { why: `${uri} is not there` }; }
  const roots: string[] = [];
  for (const r of [ctx.projectDir, ...(ctx.allowRoots ?? [])]) {
    try { roots.push(await realpath(resolve(r))); } catch { /* a root that does not exist admits nothing */ }
  }
  if (!roots.some((r) => inside(r, real))) {
    return { why: `${uri} is outside the project folder; it can be read only if the person names its folder with --allow-root for this run` };
  }
  // Inside the project folder itself, or only through an allowed root (a project folder that doesn't resolve counts as outside).
  const project = await realpath(resolve(ctx.projectDir)).catch(() => undefined);
  return { path: real, outside: project === undefined || !inside(project, real) };
}

const lineIds = (lines: AudioLine[]): string => lines.map((l) => l.id).join(',');
const sameSpan = (a: { in_s: number; out_s: number }, b: { in_s: number; out_s: number }): boolean =>
  Math.abs(a.in_s - b.in_s) < 1e-6 && Math.abs(a.out_s - b.out_s) < 1e-6;

/** The recorded cut for a shot, if any. */
export const cutAsset = (p: AkukoProject, shotId: string): Asset | undefined => p.assets.find((a) => a.id === cutIdFor(shotId) && a.provider === SLICE_PROVIDER);

/** What a shot's audio should be, before anything is read: its clip (one spoken line with a `clip_uri`), else a master span. */
export function audioSource(p: AkukoProject, shot: Shot): { lines: AudioLine[]; clip?: AudioLine; span?: Span; why?: string } {
  const lines = spokenLines(p, shot);
  if (lines.length === 0) return { lines, why: 'the shot has no spoken line' };
  const clip = lines.length === 1 && lines[0]!.clip_uri ? lines[0] : undefined;
  const span = wantedSpan(p, shot, lines);
  const why = span ? undefined
    : !p.audio?.master ? (lines.length > 1 ? `the shot has ${lines.length} spoken lines (${lineIds(lines)}); one span of them can only be cut from audio.master, and the project has none` : `${clip ? `line ${lines[0]!.id}'s clip can't be used as it is` : `line ${lines[0]!.id} has no clip_uri`} and the project has no audio.master to cut it from`)
    : `the line${lines.length === 1 ? '' : 's'} ${lineIds(lines)} fall outside the shot's film time or the master`;
  return { lines, ...(clip ? { clip } : {}), ...(span ? { span } : {}), ...(why ? { why } : {}) };
}

/** Seconds of a 16-bit WAV file, from its header. */
async function secondsOf(path: string): Promise<{ layout: WavLayout; seconds: number }> {
  const layout = await readWavLayout(path);
  return { layout, seconds: layout.frames / layout.sampleRate };
}

/**
 * The audio a lip-sync unit would send now, looked up on disk. Order: the
 * line's own clip as it is (16-bit PCM, readable); else the recorded cut, if
 * it still matches what the shot needs (same source and span), its file is
 * there with the recorded hash, and the person has not sent it back.
 */
export async function resolveAudio(p: AkukoProject, shot: Shot, ctx: AudioContext): Promise<AudioLookup> {
  const src = audioSource(p, shot);
  if (src.lines.length === 0) return { ok: false, why: src.why ?? 'no spoken line' };
  const notes: string[] = [];
  if (src.clip && ctx.from !== 'master') {
    const r = await readable(src.clip.clip_uri!, ctx);
    if ('path' in r) {
      try {
        const { layout, seconds } = await secondsOf(r.path);
        if (isPcm16(layout)) {
          return { ok: true, audio: { id: src.clip.id, uri: src.clip.clip_uri!, seconds, sha256: await sha256File(r.path), says: `line ${src.clip.id}'s own clip${r.outside ? `, ${OUTSIDE_WARNING}` : ''}` } };
        }
        notes.push(`its clip is ${layout.bits}-bit ${layout.encoding === 'float' ? 'float' : 'PCM'}, so it needs a 16-bit copy`);
      } catch (err) {
        notes.push(`its clip ${src.clip.clip_uri} can't be used (${err instanceof Error ? err.message : String(err)})`);
      }
    } else {
      notes.push(r.why);
    }
  }
  const cut = cutAsset(p, shot.id);
  const want = await wantedCut(p, shot, ctx);
  if (cut && cut.file && 'source' in want) {
    const tag = cut.tags.map(parseSliceTag).find((t) => t !== undefined);
    const fresh = tag && sameSpan(tag, want.span) && (want.source.sha256 === undefined || want.source.sha256 === tag.sha256);
    if (cut.status === 'needs-rework') return { ok: false, why: `the person sent the line audio ${cut.id} back; fix the line's times or clip, then run plan to cut it again` };
    if (fresh) {
      const path = pathOf(cut.file.uri, ctx.projectDir);
      if (path && existsSync(path)) {
        const sha256 = await sha256File(path);
        if (cut.file.hash !== undefined && cut.file.hash !== sha256) return { ok: false, why: `the cut ${cut.file.uri} has changed since it was recorded; run plan to cut it again` };
        const { seconds } = await secondsOf(path);
        return { ok: true, audio: { id: cut.id, uri: cut.file.uri, seconds, sha256, says: want.says, ...(want.source.kind === 'master' ? { film: want.span } : {}) } };
      }
    }
  }
  const why = 'source' in want ? 'not cut yet: run plan (it cuts the line audio, free)' : want.why;
  return { ok: false, why: [...notes, why].join('; ') };
}

/** Audio lookups for every lip-sync still asked for (`currentUnits`: removed rows and orphans left out). */
export async function resolveAll(p: AkukoProject, ctx: AudioContext): Promise<Map<string, AudioLookup>> {
  const out = new Map<string, AudioLookup>();
  for (const a of currentUnits(p, scopeOf(ctx))) {
    const shot = p.shots.find((s) => s.id === a.owner);
    out.set(a.id, shot ? await resolveAudio(p, shot, ctx) : { ok: false, why: 'its shot is gone' });
  }
  return out;
}

type Wanted =
  | { source: { kind: 'master' | 'clip'; uri: string; path: string; sha256?: string }; span: Span; says: string }
  | { why: string };

/**
 * The cut a shot needs, when it needs one (its clip is not usable as it is):
 * a 16-bit copy of its clip, or a master span. `sha256` is the recorded master
 * hash when there is one (the cut run checks the file against it).
 */
async function wantedCut(p: AkukoProject, shot: Shot, ctx: AudioContext): Promise<Wanted> {
  const src = audioSource(p, shot);
  if (src.clip && ctx.from !== 'master') {
    const r = await readable(src.clip.clip_uri!, ctx);
    if ('path' in r) {
      try {
        const { layout, seconds } = await secondsOf(r.path);
        if (!isPcm16(layout)) {
          return { source: { kind: 'clip', uri: src.clip.clip_uri!, path: r.path, sha256: await sha256File(r.path) }, span: { in_s: 0, out_s: secs(seconds) }, says: `line ${src.clip.id}'s own clip ${src.clip.clip_uri}, converted to 16-bit${r.outside ? `; the clip is ${OUTSIDE_WARNING}` : ''}` };
        }
      } catch { /* not a WAV akuko can read: fall back to the master */ }
    }
  }
  const master = p.audio?.master;
  if (!src.span || !master) return { why: src.why ?? 'nothing to cut' };
  const path = pathOf(master.uri, ctx.projectDir);
  if (!path) return { why: `audio.master.uri ${master.uri} is not a local file` };
  return {
    source: { kind: 'master', uri: master.uri, path, ...(master.sha256 ? { sha256: master.sha256 } : {}) },
    span: src.span,
    says: `cut from the master ${master.uri}, ${src.span.in_s}-${src.span.out_s} s`,
  };
}

export interface CutReport {
  project: AkukoProject;
  /** Cut asset ids written this run. */
  cut: string[];
  /** Lines for the person: what was used as it is, what could not be cut and why, the master hash advice. */
  notes: string[];
  /** The master's sha256 when this run read the master. */
  masterSha256?: string;
}

/**
 * Cut every line audio the planned lip-sync units need and do not have yet,
 * reading the master once for all of them. Only units still to be made
 * (pending, draft, sent back) are cut; a finished one is never re-cut, only
 * warned about. Writes files under `lipsync/cuts/` (never over an old cut)
 * and returns the project with the cut assets recorded; the caller writes it.
 */
export async function cutAudio(project: AkukoProject, ctx: AudioContext & { now: string; chunkBytes?: number }): Promise<CutReport> {
  const p = structuredClone(project);
  const notes: string[] = [];
  const cut: string[] = [];
  type Job = { shot: Shot; lines: AudioLine[]; source: { kind: 'master' | 'clip'; uri: string; path: string; sha256?: string }; span: Span; range?: FrameRange; says: string };
  const jobs: Job[] = [];
  // A lip-sync no longer asked for is kept, and nothing is cut for it.
  notes.push(...orphanedUnits(p, scopeOf(ctx)).map(orphanLine));
  for (const a of currentUnits(p, scopeOf(ctx))) {
    const shot = shotOf(p, a);
    const now = await resolveAudio(p, shot, ctx);
    const todo = a.status === 'pending' || a.status === 'draft' || a.status === 'needs-rework';
    if (now.ok) {
      if (now.audio.id !== cutIdFor(shot.id)) notes.push(`${a.id}: uses ${now.audio.says} (${now.audio.uri}) as it is.`);
      continue;
    }
    const want = await wantedCut(p, shot, ctx);
    if (!('source' in want)) { notes.push(`${a.id}: no line audio: ${now.why}.`); continue; }
    const old = cutAsset(p, shot.id);
    if (old?.status === 'needs-rework' && old.file) {
      const tag = old.tags.map(parseSliceTag).find((t) => t !== undefined);
      if (tag && sameSpan(tag, want.span)) { notes.push(`${a.id}: the person sent the line audio ${old.id} back, and the line's times have not changed; fix them (or the clip) first.`); continue; }
    }
    if (!todo) { notes.push(`${a.id} was already made from other line audio; send it back on the board if it should be remade with the new cut.`); continue; }
    jobs.push({ shot, lines: spokenLines(p, shot), source: want.source, span: want.span, says: want.says });
  }

  // One streaming pass per source file (the master once, each clip to convert once).
  const bySource = new Map<string, Job[]>();
  for (const j of jobs) bySource.set(j.source.path, [...(bySource.get(j.source.path) ?? []), j]);
  let masterSha256: string | undefined;
  for (const [path, group] of bySource) {
    const first = group[0]!;
    let layout: WavLayout;
    try {
      layout = await readWavLayout(path);
    } catch (err) {
      notes.push(`Could not read ${first.source.uri}: ${err instanceof Error ? err.message : String(err)}. Nothing was cut from it (${group.map((j) => assetIdFor(j.shot.id)).join(', ')}).`);
      continue;
    }
    const ranges = group.map((j) => framesOf(j.span.in_s, j.span.out_s, layout.sampleRate));
    let res: Awaited<ReturnType<typeof sliceWavTo16>>;
    try {
      res = await sliceWavTo16(path, ranges, ctx.chunkBytes !== undefined ? { chunkBytes: ctx.chunkBytes } : {});
    } catch (err) {
      notes.push(`Could not cut ${first.source.uri}: ${err instanceof Error ? err.message : String(err)}.`);
      continue;
    }
    if (first.source.kind === 'master') {
      masterSha256 = res.sha256;
      const recorded = p.audio?.master?.sha256;
      if (recorded && recorded !== res.sha256) {
        notes.push(`The master ${first.source.uri} is not the file whose hash is recorded (audio.master.sha256 ${recorded.slice(0, 12)}…, the file is ${res.sha256.slice(0, 12)}…). Nothing was cut from it. If the new file is the right one, check the film times still match it, then record its hash: record-master-hash --replace.`);
        continue;
      }
      if (layout.sampleRate !== p.audio?.master?.sample_rate) notes.push(`The master file is ${layout.sampleRate} Hz but audio.master.sample_rate says ${p.audio?.master?.sample_rate}; the cuts follow the file.`);
    } else if (first.source.sha256 && first.source.sha256 !== res.sha256) {
      notes.push(`${first.source.uri} changed while it was being cut; nothing was cut from it.`);
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      const j = group[i]!;
      const s = res.slices[i]!;
      // The tag says exactly which frames the file holds, in seconds on the source.
      const span = { in_s: secs(s.range.startFrame / layout.sampleRate), out_s: secs(s.range.endFrame / layout.sampleRate) };
      cut.push(await record(p, j.shot, j.lines, j.source.kind, res.sha256, span, s.wav, j.says, ctx));
    }
  }
  if (masterSha256 && !p.audio?.master?.sha256) {
    notes.push(`audio.master.sha256 is not recorded. The master read now has sha256 ${masterSha256}. Record it with \`record-master-hash\` (the person's command), and allow slices of it in rules.uploads.allow ({ sha256, label, slices: true }) if the project has rules.`);
  }
  return { project: p, cut, notes, ...(masterSha256 ? { masterSha256 } : {}) };
}

/** Write one cut and record (or update) its asset. Returns the asset id. */
async function record(p: AkukoProject, shot: Shot, lines: AudioLine[], kind: 'master' | 'clip', sourceSha: string, span: Span, wav: Uint8Array, says: string, ctx: AudioContext & { now: string }): Promise<string> {
  const id = cutIdFor(shot.id);
  const dir = join(ctx.projectDir, ...CUT_DIR.split('/'));
  await mkdir(dir, { recursive: true });
  const name = freeName(dir, `${id}.wav`);
  await writeFileAtomic(join(dir, name), wav);
  const file = { uri: `${CUT_DIR}/${name}`, mime: 'audio/wav', hash: sha256Bytes(wav) };
  const tags = [CUT_TAG, sliceTag(sourceSha, span.in_s, span.out_s), `lines:${lineIds(lines)}`];
  const film = kind === 'master' ? { film: span } : {};
  const i = p.assets.findIndex((a) => a.id === id);
  const old = i >= 0 ? p.assets[i]! : undefined;
  const asset: Asset = {
    id,
    kind: 'vo',
    stage: LIPSYNC_STAGE,
    status: 'pending-review',
    comments: [
      ...(old?.comments ?? []),
      ...(old?.file ? [{ ts: ctx.now, stage: LIPSYNC_STAGE, author: 'agent' as const, text: `Revised: the line audio was cut again (${says}); the previous cut stays at ${old.file.uri}` }] : []),
    ],
    owner: shot.id,
    name: `${shot.id} - line audio for lip-sync (${says})`,
    file,
    tags,
    provider: SLICE_PROVIDER,
    ...film,
    by_stage: { [LIPSYNC_STAGE]: { status: 'pending-review', output: file } },
    updated_at: ctx.now,
  };
  if (old) p.assets[i] = asset; else p.assets.push(asset);
  return id;
}

/** sha256 of the master file, streamed. */
export async function masterHash(p: AkukoProject, projectDir: string): Promise<{ uri: string; sha256: string }> {
  const m = p.audio?.master;
  if (!m) throw new Error('the project has no audio.master');
  const path = pathOf(m.uri, projectDir);
  if (!path || !existsSync(path)) throw new Error(`the master ${m.uri} is not there`);
  return { uri: m.uri, sha256: await sha256File(path) };
}

/**
 * sha256 of each current lip-sync's key frame as the file is now, by key-frame
 * asset id, for the job id: a still swapped on disk (even with an old
 * recorded hash) is a new job. A file that can't be read is left out (the job
 * then uses the recorded hash, or is refused without one).
 */
export async function stillHashes(p: AkukoProject, ctx: Pick<AudioContext, 'projectDir' | 'part'>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const a of currentUnits(p, scopeOf(ctx))) {
    const kf = p.assets.find((x) => x.id === `${a.owner}_keyframe`);
    const path = kf?.file ? pathOf(kf.file.uri, ctx.projectDir) : undefined;
    if (!kf || !path || !existsSync(path)) continue;
    try { out.set(kf.id, await sha256File(path)); } catch { /* unreadable: the recorded hash stands in */ }
  }
  return out;
}
