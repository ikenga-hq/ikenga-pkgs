/**
 * akuko — lip-sync step (stage 5, motion): planning, readiness, jobs, the retry cap (WP-28b).
 *
 * Review unit: one planned **asset** per shot (`<shot>_lipsync`, kind
 * `lipsync`, stage `motion`, owner = the shot), the same shape as a clip
 * (`motion/plan.ts`). A shot gets one when its `treatment` is `lipsync`, or
 * `video` with a spoken line. Thought lines need nothing.
 *
 * Image mode only (this wave): the picture is the shot's approved key frame
 * and the audio is the shot's spoken line(s), a 16-bit PCM WAV:
 *   1. the line's own clip (`audio.lines[].clip_uri`), when it can be read;
 *   2. else a slice of `audio.master` cut by the line's film times, with a
 *      small pad (`cut.ts`). A shot with several spoken lines gets ONE master
 *      slice covering all of them (clips can't be joined without the gaps
 *      between them, which only the master holds).
 * Video mode (an approved clip + audio) waits for fal CDN upload: clips are
 * too big to send inline (lib/providers.md §"For WP-28b").
 *
 *   lipsyncTargets() / planLipsync()   which shots, and the planned assets (idempotent)
 *   wantedSpan()                       the master slice a shot's lines need
 *   unitReadiness()                    ready / blocked / in flight / in review / approved
 *   buildLipsyncJob()                  one gate-ready Job for one shot, refusing at the retry cap
 *   repairFileless()                   the stage roll-up is motion's `refreshMotionStage()` (motion/stage.ts, WP-32)
 *
 * Part scope (WP-32): `{ part: 'P7' }` plans, cuts, prices and makes only that part's live shots, once the part is
 * open (motion's `assertOpen`).
 *
 * Nothing here reads files, calls a provider, writes `approved`, or writes the
 * project. Audio is looked up by `cut.ts` (`resolveAudio`) and passed in.
 */

import { createHash } from 'node:crypto';
import type { AkukoProject, Asset, AudioLine, Shot } from '../schema/akuko-project.ts';
import { shotUnitId } from '../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../providers/config.ts';
import { loadProviderConfig, priceFor, providerConfig } from '../providers/config.ts';
import type { Job, JobItem, JobRef } from '../providers/contract.ts';
import { FAL_LIPSYNC_PROVIDER_ID, LENGTH_TOLERANCE_S, billedSeconds, chooseLipsyncModel, falLipsyncLimits, secondsNote } from '../providers/lipsync/fal/index.ts';
import { requestedChanges } from '../bible/plan.ts';
import { jobRan } from '../keyframes/plan.ts';
import { assertOpen as assertMotionOpen, inScope, paidAttempts, type Scope } from '../motion/plan.ts';
import { CUT_TAG, LIPSYNC_TAG, refreshMotionStage, spokenLines } from '../motion/stage.ts';
import { removedAt } from '../decisions/fold.ts';
import { MANUAL_PROVIDER_ID } from '../spend/gate.ts';

export { CUT_TAG, LIPSYNC_TAG, refreshMotionStage, spokenLines, type Scope };
export const LIPSYNC_STAGE = 'motion' as const;
/** Paid attempts allowed per shot unless the person asks for more. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Pad around the spoken line(s) when cutting from the master: a little lead-in and tail, so no word is clipped. */
export const PAD_BEFORE_S = 0.2;
export const PAD_AFTER_S = 0.3;

export class LipsyncError extends Error {
  override name = 'LipsyncError';
}

export const assetIdFor = (shotId: string): string => shotUnitId(shotId, 'lipsync');
export const cutIdFor = (shotId: string): string => `${shotId}_linecut`;
const keyframeIdFor = (shotId: string): string => shotUnitId(shotId, 'keyframe');
export const isLipsync = (a: Asset): boolean => a.kind === 'lipsync' && a.stage === LIPSYNC_STAGE && a.tags.includes(LIPSYNC_TAG);
export const lipsyncAssets = (p: AkukoProject): Asset[] => p.assets.filter(isLipsync);
export const isCut = (a: Asset): boolean => a.stage === LIPSYNC_STAGE && a.tags.includes(CUT_TAG);

const hasFile = (a: Asset | undefined): boolean => a?.file !== undefined;
const approvedWithFile = (a: Asset | undefined): boolean => a !== undefined && a.status === 'approved' && hasFile(a);
const money = (n: number): string => String(Number(n.toFixed(4)));
/** Seconds as written in notes, tags and labels: at most 6 decimals, never an exponent. */
export const secs = (n: number): number => Number(n.toFixed(6));
const hash8 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);

// ─────────────────────────────────────────────────────────────────────────
// Which shots
// ─────────────────────────────────────────────────────────────────────────

export interface Target { shot: Shot; lines: AudioLine[] }
export interface Passed { shot: string; why: string }

/**
 * The shots that get a lip-sync unit: treatment `lipsync`, or `video` with a
 * spoken line, not removed from the sheet, with at least one spoken line.
 * `passed` names shots that asked for lip-sync but have nothing to sync.
 */
export function lipsyncTargets(p: AkukoProject, scope: Scope = {}): { targets: Target[]; passed: Passed[] } {
  const targets: Target[] = [];
  const passed: Passed[] = [];
  const only = inScope(p, scope);
  for (const shot of p.shots) {
    if (shot.treatment !== 'lipsync' && shot.treatment !== 'video') continue;
    if (!only(shot.id)) continue;
    if (removedAt(p, shot) !== undefined) continue;
    const lines = spokenLines(p, shot);
    if (lines.length > 0) { targets.push({ shot, lines }); continue; }
    if (shot.treatment === 'lipsync') {
      const thought = (shot.lines ?? []).some((l) => l.kind === 'thought');
      passed.push({ shot: shot.id, why: thought ? 'its lines are thoughts (voice-over), so there is no mouth to sync' : 'it carries no spoken line (shot.lines)' });
    }
  }
  return { targets, passed };
}

export interface PlanResult { project: AkukoProject; created: string[]; passed: Passed[] }

/** Create the planned lip-sync asset for every target shot that has none. Safe to run again. */
export function planLipsync(project: AkukoProject, now: string, scope: Scope = {}): PlanResult {
  assertOpen(project, scope);
  const p = structuredClone(project);
  const created: string[] = [];
  const { targets, passed } = lipsyncTargets(p, scope);
  for (const { shot } of targets) {
    const id = assetIdFor(shot.id);
    if (p.assets.some((a) => a.id === id)) continue;
    p.assets.push({
      id,
      stage: LIPSYNC_STAGE,
      status: 'pending',
      comments: [],
      kind: 'lipsync',
      owner: shot.id,
      name: `${shot.id} - lip-sync`,
      tags: [LIPSYNC_TAG],
      updated_at: now,
    });
    created.push(id);
  }
  return { project: refreshMotionStage(p), created, passed };
}

/**
 * The planned lip-syncs that are still asked for: their shot is a current
 * target (`lipsyncTargets`). Only these are cut, priced, made or listed as
 * work. Removed rows are left out.
 */
export function currentUnits(p: AkukoProject, scope: Scope = {}): Asset[] {
  const wanted = new Set(lipsyncTargets(p, scope).targets.map((t) => t.shot.id));
  return lipsyncAssets(p).filter((a) => removedAt(p, a) === undefined && a.owner !== undefined && wanted.has(a.owner));
}

export interface Orphan { asset: string; shot: string; why: string }

/**
 * Planned lip-syncs whose shot no longer asks for one (the person changed its
 * treatment, or its spoken line went away). They are **kept**, never deleted
 * (a made one keeps its file and its review), but nothing is cut, priced or
 * made for them. Removed rows are reported by the sheet, not here.
 */
export function orphanedUnits(p: AkukoProject, scope: Scope = {}): Orphan[] {
  const wanted = new Set(lipsyncTargets(p).targets.map((t) => t.shot.id));
  const only = inScope(p, scope);
  return lipsyncAssets(p)
    .filter((a) => removedAt(p, a) === undefined && only(a.owner) && !(a.owner !== undefined && wanted.has(a.owner)))
    .map((a) => {
      const shot = p.shots.find((s) => s.id === a.owner);
      const why = !shot ? 'its shot is gone'
        : shot.treatment !== 'lipsync' && shot.treatment !== 'video' ? `treatment ${shot.treatment ?? 'not set'}`
        : 'no spoken line';
      return { asset: a.id, shot: a.owner ?? '', why };
    });
}

export const orphanLine = (o: Orphan): string => `${o.asset}: no longer asked for (${o.why}); kept. Nothing is cut, priced or made for it.`;

/**
 * The motion stage must be open (every earlier stage, through the key frames, approved): lip-sync is part of it.
 * With `{ part }`, that part must be open (its own key frames and bible entries approved; motion's rule).
 */
export function assertOpen(p: AkukoProject, scope: Scope = {}): void {
  try {
    assertMotionOpen(p, scope);
  } catch (err) {
    throw new LipsyncError(err instanceof Error ? err.message : String(err));
  }
}

export const shotOf = (p: AkukoProject, a: Asset): Shot => {
  const s = p.shots.find((x) => x.id === a.owner);
  if (!s) throw new LipsyncError(`lip-sync "${a.id}" has no shot; plan again.`);
  return s;
};

// ─────────────────────────────────────────────────────────────────────────
// The master slice a shot needs
// ─────────────────────────────────────────────────────────────────────────

export interface Span { in_s: number; out_s: number }

/**
 * The span rule, on its own (WP-32: shared with the whole-film estimate, `setup/estimate.ts`): from the first
 * line's start minus `PAD_BEFORE_S` to the last one's end plus `PAD_AFTER_S`, clamped to the shot's film time when
 * it has one (what is outside it is not on screen in this shot), to 0, and, with a master, to the master's length
 * and rounded to whole master frames. Undefined when there are no lines or the span is empty.
 */
export function lineSpan(lines: ReadonlyArray<Pick<AudioLine, 'film_in_s' | 'film_out_s'>>, shotFilm?: Span, master?: { duration_s: number; sample_rate: number }): Span | undefined {
  if (lines.length === 0) return undefined;
  let a = Math.min(...lines.map((l) => l.film_in_s)) - PAD_BEFORE_S;
  let b = Math.max(...lines.map((l) => l.film_out_s)) + PAD_AFTER_S;
  if (shotFilm) { a = Math.max(a, shotFilm.in_s); b = Math.min(b, shotFilm.out_s); }
  a = Math.max(0, a);
  let span: Span;
  if (master) {
    b = Math.min(master.duration_s, b);
    // Whole frames of the master, so the tag says exactly what the file holds.
    const rate = master.sample_rate;
    span = { in_s: secs(Math.round(a * rate) / rate), out_s: secs(Math.round(b * rate) / rate) };
  } else {
    span = { in_s: secs(a), out_s: secs(b) };
  }
  return span.out_s > span.in_s ? span : undefined;
}

/**
 * The part of the master to cut for a shot: `lineSpan` over its spoken lines, clamped to the shot and the
 * master. Undefined when there is nothing to cut (no master, or no spoken line).
 */
export function wantedSpan(p: AkukoProject, shot: Shot, lines = spokenLines(p, shot)): Span | undefined {
  const master = p.audio?.master;
  if (!master) return undefined;
  return lineSpan(lines, shot.film, master);
}

/**
 * The seconds of line audio a shot's lip-sync is expected to send when cut
 * from the master: `wantedSpan`'s length (the lines, the pads, clamped to the
 * shot and the master). The billing basis in image mode. A line's own clip
 * has its own length (its own lead-in and tail), which the job measures.
 * Undefined when the shot has no spoken line or no master. For estimates
 * (WP-30) as well as this step.
 */
export function expectedAudioSeconds(p: AkukoProject, shot: Shot): number | undefined {
  const s = wantedSpan(p, shot);
  return s ? secs(s.out_s - s.in_s) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Audio, as looked up by cut.ts
// ─────────────────────────────────────────────────────────────────────────

/** The audio a lip-sync unit would send, found on disk by `cut.ts` `resolveAudio()`. */
export interface Audio {
  /** `ref.id`: the cut asset's id, or the line id for a line's own clip. */
  id: string;
  /** `ref.uri`, as the provider reads it (relative to the project folder, or absolute). */
  uri: string;
  /** Measured from the file's header, seconds. */
  seconds: number;
  /** sha256 of the file. */
  sha256: string;
  /** Where it came from, in the person's words (it goes into the spend line). */
  says: string;
  /** The span on the master clock it covers, when known (a master slice). */
  film?: Span;
}

export type AudioLookup = { ok: true; audio: Audio } | { ok: false; why: string };

// ─────────────────────────────────────────────────────────────────────────
// Readiness
// ─────────────────────────────────────────────────────────────────────────

export type ReadinessState = 'approved' | 'in-review' | 'in-flight' | 'ready' | 'blocked';
export interface Readiness { state: ReadinessState; waiting: string[] }

// A host-A reservation not yet sent (`reserved`) is not in flight: the send phase must pick the same unit.
const inFlight = (p: AkukoProject, a: Asset): boolean => p.ledger.some((e) => e.unit === a.id && e.status === 'submitted' && e.reserved !== true);

/** Ready when the shot's key frame is approved with a file and its audio is available (`audio`). */
export function unitReadiness(p: AkukoProject, a: Asset, audio: AudioLookup | undefined): Readiness {
  if (approvedWithFile(a)) return { state: 'approved', waiting: [] };
  if (hasFile(a) && a.status === 'pending-review') return { state: 'in-review', waiting: [] };
  if (inFlight(p, a)) return { state: 'in-flight', waiting: [] };
  const waiting: string[] = [];
  const kf = p.assets.find((x) => x.id === keyframeIdFor(shotOf(p, a).id));
  if (!approvedWithFile(kf)) waiting.push(`the approved key frame ${keyframeIdFor(a.owner ?? '')}`);
  if (!audio?.ok) waiting.push(`the line audio (${audio?.ok === false ? audio.why : 'not looked up'})`);
  return waiting.length ? { state: 'blocked', waiting } : { state: 'ready', waiting: [] };
}

export interface StatusRow {
  shot: string;
  asset: string;
  status: Asset['status'];
  state: ReadinessState;
  waiting: string[];
  attempts: number;
  spent: number;
  lines: string[];
}

/** One row per lip-sync still asked for (`currentUnits`); orphans are listed by `orphanedUnits`. */
export function lipsyncStatus(p: AkukoProject, audio: Map<string, AudioLookup>, scope: Scope = {}): StatusRow[] {
  return currentUnits(p, scope).map((a) => {
    const r = unitReadiness(p, a, audio.get(a.id));
    const t = paidAttempts(p, a.id);
    const shot = p.shots.find((s) => s.id === a.owner);
    return { shot: a.owner ?? '', asset: a.id, status: a.status, state: r.state, waiting: r.waiting, attempts: t.count, spent: t.spent, lines: shot ? spokenLines(p, shot).map((l) => l.id) : [] };
  });
}

/** Throw when `unit` has used up its paid attempts (the ledger is the count; motion's rule). */
export function assertAttemptsLeft(p: AkukoProject, unit: string, max: number): void {
  const { count, spent } = paidAttempts(p, unit);
  if (count >= max) {
    throw new LipsyncError(
      `${unit} has had ${count} paid attempt${count === 1 ? '' : 's'} and ${money(spent)} ${p.budget?.currency ?? ''} has gone on it; the limit is ${max} per shot. ` +
      `Stop here and tell the person. If they decide to try again they must say so in their own words; then run step again with --max-attempts ${max + 1}.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic id: `job_ls_<hash of unit + provider + model + seconds + the audio and still files>_r<n>`.
 * The gate matches an approval on the job id alone, so anything that changes
 * the price or what is uploaded must change the id: another model (a fallback
 * with the same id would reuse the first model's approval), another length,
 * another audio file or still. A regeneration after a send-back is the next `r<n>`.
 */
export function lipsyncJobId(p: AkukoProject, o: { unit: string; provider: string; model?: string; seconds: number; audio: string; still: string }): string {
  const base = `job_ls_${hash8([o.unit, o.provider, o.model ?? '', String(secs(o.seconds)), o.audio, o.still].join('|'))}`;
  let n = 1;
  while (jobRan(p, `${base}_r${n}`)) n++;
  return `${base}_r${n}`;
}

export interface BuildOptions {
  provider: string;
  model?: string;
  /** The shot to make. Default: the next ready one. One shot per job, always. */
  shot?: string;
  /** Only this part's shots (`--part P7`), once the part is open. */
  part?: string;
  /** Paid attempts allowed per shot. Default 3; raise only when the person asked in their own words. */
  maxAttempts?: number;
  /** Audio per lip-sync unit id, from `cut.ts` `resolveAudio()`. */
  audio: Map<string, AudioLookup>;
  /**
   * sha256 of each key frame's bytes as they are now, by key-frame asset id
   * (`cut.ts` `stillHashes()`), for the job id: a swapped still is a new job.
   * Without an entry the recorded `file.hash` is used; with neither the job is refused.
   */
  stills?: Map<string, string>;
  config?: AkukoProviderConfig;
}

export interface BuiltJob {
  job: Job;
  unit: string;
  audio: Audio;
  /** Things the person should hear. */
  notes: string[];
}

/** The model for a line of `seconds`: the person's, checked, or the first configured image-mode model whose limits admit it. */
function modelFor(config: AkukoProviderConfig, o: BuildOptions, seconds: number): string | undefined {
  if (o.provider === MANUAL_PROVIDER_ID) return o.model;
  if (o.provider !== FAL_LIPSYNC_PROVIDER_ID) throw new LipsyncError(`akuko has no lip-sync rules for provider "${o.provider}"; use fal-lipsync or manual.`);
  if (o.model === undefined) {
    const m = chooseLipsyncModel(config, 'image', seconds);
    if (!m) throw new LipsyncError(`no configured still + audio model takes a ${seconds.toFixed(2)} s line.`);
    return m;
  }
  if (!(o.model in providerConfig(config, o.provider).models)) throw new LipsyncError(`model "${o.model}" is not configured for ${o.provider}.`);
  const l = falLipsyncLimits(o.model);
  if (!l) throw new LipsyncError(`akuko has no request rules for model "${o.model}".`);
  if (l.mode !== 'image') throw new LipsyncError(`${o.model} takes a video clip; this step sends a still (the approved key frame). Clip mode waits for fal CDN upload.`);
  if ((l.audioMinS !== undefined && seconds < l.audioMinS - LENGTH_TOLERANCE_S) || (l.audioMaxS !== undefined && seconds > l.audioMaxS)) {
    throw new LipsyncError(`${o.model} takes a line of ${l.audioMinS ?? 0}-${l.audioMaxS ?? 'any'} s; this one is ${seconds.toFixed(2)} s. Leave --model out to let akuko pick one that fits.`);
  }
  return o.model;
}

/** What the person is asked to do with the still and the audio. Providers send no prompt; it is for the manual path and the rules check. */
export function lipsyncPrompt(shot: Shot, lines: AudioLine[], asked = ''): string {
  const said = lines.map((l) => `${l.id}${l.character ? ` (${l.character})` : ''}${l.text ? `: "${l.text}"` : ''}`).join('; ');
  return [
    `Lip-sync shot ${shot.id}: animate the speaker in the attached still so the mouth follows the attached audio exactly, from its first sample.`,
    'Keep the face, framing, lighting and look of the still; only natural mouth, jaw, head and eye movement.',
    `Spoken line${lines.length === 1 ? '' : 's'}: ${said}.`,
    ...(asked ? [`Changes the person asked for: ${asked}`] : []),
  ].join(' ');
}

/**
 * Build one job, for one shot. It never submits anything: hand it to
 * `gate.run()`. By default the next ready shot. A shot at the retry cap is
 * refused (named) or skipped (default pick).
 */
export function buildLipsyncJob(p: AkukoProject, o: BuildOptions): BuiltJob {
  const scope: Scope = o.part !== undefined ? { part: o.part } : {};
  assertOpen(p, scope);
  const config = o.config ?? loadProviderConfig();
  const max = o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(max) || max < 1) throw new LipsyncError('--max-attempts must be a whole number of 1 or more.');
  const units = currentUnits(p, scope);

  let a: Asset | undefined;
  const skipped: string[] = [];
  if (o.shot !== undefined) {
    a = units.find((x) => x.owner === o.shot);
    const orphan = orphanedUnits(p).find((x) => x.shot === o.shot);
    if (!a && orphan) throw new LipsyncError(orphanLine(orphan));
    if (!a && o.part !== undefined && currentUnits(p).some((x) => x.owner === o.shot)) throw new LipsyncError(`shot ${o.shot} is not in part ${o.part}; a run scoped to ${o.part} makes only that part's lip-syncs. Nothing was priced.`);
    if (!a) throw new LipsyncError(`shot ${o.shot} has no planned lip-sync; run plan first (a shot gets one when its treatment is lipsync, or video with a spoken line).`);
    const r = unitReadiness(p, a, o.audio.get(a.id));
    if (r.state !== 'ready') throw new LipsyncError(`${a.id} cannot be made now (${r.state}${r.waiting.length ? `; waiting for ${r.waiting.join(' and ')}` : ''}).`);
    assertAttemptsLeft(p, a.id, max);
  } else {
    for (const x of units) {
      if (unitReadiness(p, x, o.audio.get(x.id)).state !== 'ready') continue;
      try { assertAttemptsLeft(p, x.id, max); } catch (err) { skipped.push(err instanceof Error ? err.message : String(err)); continue; }
      a = x;
      break;
    }
    if (!a) {
      const stuck = lipsyncStatus(p, o.audio, scope).filter((r) => r.state === 'blocked').map((r) => `${r.asset} (waiting for ${r.waiting.join(' and ')})`);
      throw new LipsyncError([...skipped, stuck.length ? `Nothing can be made yet: ${stuck.join('; ')}.` : skipped.length ? '' : 'Nothing is waiting to be made.'].filter(Boolean).join(' '));
    }
  }

  const shot = shotOf(p, a);
  const lines = spokenLines(p, shot);
  const lookup = o.audio.get(a.id);
  if (!lookup?.ok) throw new LipsyncError(`${a.id}: no audio (${lookup?.ok === false ? lookup.why : 'not looked up'}).`);
  const audio = lookup.audio;
  const seconds = secs(audio.seconds);
  if (!(seconds > 0)) throw new LipsyncError(`${a.id}: the line audio ${audio.uri} holds no sound.`);
  const model = modelFor(config, o, seconds);
  const kf = p.assets.find((x) => x.id === keyframeIdFor(shot.id)) as Asset;
  const stillSha = o.stills?.get(kf.id) ?? kf.file!.hash;
  if (!stillSha) throw new LipsyncError(`${a.id}: the key frame ${kf.file!.uri} can't be read and has no recorded hash, so the job can't be tied to the still it would send.`);
  const asked =a.status === 'needs-rework' || a.status === 'draft' ? requestedChanges(a) : '';

  const refs: JobRef[] = [
    { id: kf.id, uri: kf.file!.uri, role: 'start-frame', note: 'the approved key frame: the face to animate' },
    { id: audio.id, uri: audio.uri, role: 'audio', note: secondsNote(seconds) },
  ];
  const item: JobItem = {
    unit: a.id,
    prompt: lipsyncPrompt(shot, lines, asked),
    output: 'lipsync',
    aspect_ratio: p.project.aspect_ratio,
    duration_s: seconds,
    count: 1,
    refs,
  };
  const notes: string[] = [];
  if (audio.film && shot.film && Math.abs(audio.film.in_s - shot.film.in_s) > 1e-6) {
    notes.push(`${a.id}: the line audio starts ${money(audio.film.in_s - shot.film.in_s)} s into the shot, so the lip-sync video belongs at ${money(audio.film.in_s)} s on the master, not at the shot's start (${money(shot.film.in_s)} s). akuko records that span on the lip-sync, and the Resolve handoff places it there, holding the key frame before and after it.`);
  }
  const job: Job = {
    id: lipsyncJobId(p, { unit: a.id, provider: o.provider, ...(model !== undefined ? { model } : {}), seconds, audio: `${audio.uri}@${audio.sha256}`, still: `${kf.file!.uri}@${stillSha}` }),
    stage: LIPSYNC_STAGE,
    kind: 'video',
    provider: o.provider,
    ...(model !== undefined ? { model } : {}),
    label: labelFor(config, o.provider, model, shot, lines, seconds, kf, audio),
    items: [item],
  };
  return { job, unit: a.id, audio, notes };
}

/** The job label the spend line shows: the arithmetic, and plainly which files go to the provider. */
function labelFor(config: AkukoProviderConfig, provider: string, model: string | undefined, shot: Shot, lines: AudioLine[], seconds: number, kf: Asset, audio: Audio): string {
  const head = `Lip-sync ${shot.id} (line${lines.length === 1 ? '' : 's'} ${lines.map((l) => l.id).join(', ')})`;
  if (provider === MANUAL_PROVIDER_ID) {
    return `${head}: a ${money(seconds)} s line on the approved key frame. Nothing is uploaded by akuko: you take the still ${kf.file!.uri} and the audio ${audio.uri} (${audio.says}) to the tool you use`;
  }
  const price = priceFor(config, provider, model);
  const l = model ? falLipsyncLimits(model) : undefined;
  const billed = billedSeconds(seconds, l ?? {});
  const extra = billed > seconds + 1e-9 ? ` (a ${money(seconds)} s line billed as ${money(billed)} s)` : '';
  // The gate's spend line is `Spend check — <label>: <provider> (<model>), 1 unit, estimate …`.
  return `${head}: uploads to ${provider === FAL_LIPSYNC_PROVIDER_ID ? 'fal' : provider}, if you approve, the still ${kf.file!.uri} and the audio ${audio.uri} (${audio.says}); ` +
    `${money(billed)} s x ${money(price.amount)} ${price.currency}/s = ${money(billed * price.amount)}${extra}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Status moves an action may make
// ─────────────────────────────────────────────────────────────────────────

/**
 * A lip-sync that is `approved` or `pending-review` must have a file. If one
 * has none (an undo restored a status after a revision cleared the file), set
 * it back to `pending`. Never writes `approved`.
 */
export function repairFileless(project: AkukoProject, ts: string): { project: AkukoProject; repaired: string[] } {
  const p = structuredClone(project);
  const repaired: string[] = [];
  for (const a of lipsyncAssets(p)) {
    if ((a.status === 'approved' || a.status === 'pending-review') && !hasFile(a)) {
      a.status = 'pending';
      a.by_stage = { ...(a.by_stage ?? {}), [LIPSYNC_STAGE]: { status: 'pending' } };
      a.comments.push({ ts, stage: LIPSYNC_STAGE, author: 'agent', text: 'Revised: restored without a video; needs generating' });
      a.updated_at = ts;
      repaired.push(a.id);
    }
  }
  return { project: p, repaired };
}
