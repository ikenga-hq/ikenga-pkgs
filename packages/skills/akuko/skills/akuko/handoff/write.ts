/**
 * akuko — write the Resolve export folder (WP-23).
 *
 *   <out>/
 *     media/        approved clips and stills, copied, named in shot order: 001_sc1_sh1.mp4
 *     audio/        approved voice-over, music and SFX, copied
 *     captions/     captions.srt / .vtt when `sound sync` wrote them
 *     timeline.fcpxml          primary timeline (Resolve: File > Import > Timeline)
 *     edl/video.edl, edl/audio-N.edl     fallback (with --format edl|both)
 *     README.md  LEFT-OUT.md  checksums.sha256  export-manifest.json
 *
 * Rules:
 *   - the project's own files are only ever read; media is COPIED;
 *   - nothing here is timestamped, so an export of an unchanged project is byte-identical;
 *   - `export-manifest.json` lists every file this tool wrote (path + sha256). A re-run replaces
 *     those files, removes the ones the new export no longer includes (only if they are still
 *     exactly as written), and never touches anything else in the folder. A file at one of our
 *     paths that the manifest does not list is somebody else's: the export stops before writing.
 *   - the export is a by-product: no stage or unit status is changed.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AkukoProject } from '../schema/akuko-project.ts';
import { audioTracks, renderAudioEdl, renderVideoEdl } from './edl.ts';
import { FCPXML_VERSION, renderFcpxml } from './fcpxml.ts';
import { buildPlan, type ExportPlan, type MediaFile } from './plan.ts';
import { probeFile } from './probe.ts';
import { HandoffError, parseFps, timecode, START_FRAMES } from './timecode.ts';

export const MANIFEST = 'export-manifest.json';
export const MANIFEST_FORMAT = 'akuko-resolve-export';

export type TimelineFormat = 'fcpxml' | 'edl' | 'both';

export interface ExportOptions {
  project: AkukoProject;
  /** The project folder: where `file.uri`s are relative to. */
  projectDir: string;
  /** Where the export goes (created if needed). */
  outDir: string;
  fps?: string;
  format?: TimelineFormat;
  /** Host A and similar: no media to copy. Writes the timeline and a download list only. */
  timelineOnly?: boolean;
}

export interface ExportResult {
  outDir: string;
  plan: ExportPlan;
  written: string[];
  unchanged: string[];
  removed: string[];
  /** Stale files of ours the person changed since: left in place. */
  keptModified: string[];
}

interface ManifestFile { path: string; sha256: string; role: string }
interface Manifest { format: typeof MANIFEST_FORMAT; version: 1; fcpxml_version: string; fps: string; files: ManifestFile[] }

const sha = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

function sha256File(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', fail).on('end', () => ok(h.digest('hex')));
  });
}

/** Where `uri` is on disk, or undefined if it is not a plain path inside the project. */
export function localPath(projectDir: string, uri: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || isAbsolute(uri)) return undefined;
  const p = resolve(projectDir, ...uri.split('/'));
  const rel = relative(resolve(projectDir), p);
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : p;
}

export async function planFromFolder(o: Pick<ExportOptions, 'project' | 'projectDir' | 'fps' | 'timelineOnly'>): Promise<ExportPlan> {
  const fps = parseFps(o.fps);
  return buildPlan({
    project: o.project,
    fps,
    ...(o.timelineOnly ? { timelineOnly: true } : {}),
    exists: (uri) => {
      const p = localPath(o.projectDir, uri);
      return p !== undefined && existsSync(p);
    },
    probe: async (uri) => {
      const p = localPath(o.projectDir, uri);
      return p === undefined ? {} : probeFile(p, (x) => readFile(x));
    },
  });
}

const frames = (n: number): string => `${n} frame${n === 1 ? '' : 's'}`;

/** Move every cue of an SRT forward by whole hours (the timeline starts at 01:00:00:00; the SRT starts at 0). */
export function shiftSrt(srt: string, hours = 1): string {
  return srt.replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, (_m, h: string, m: string, sec: string, ms: string) => `${String(Number(h) + hours).padStart(2, '0')}:${m}:${sec},${ms}`);
}

export function renderReadme(plan: ExportPlan, o: { format: TimelineFormat; timelineOnly: boolean; edlFiles: string[] }): string {
  const { fps } = plan;
  const total = timecode(plan.totalFrames, fps);
  const L: string[] = [];
  L.push(`# ${plan.title}: DaVinci Resolve handoff`, '');
  L.push(`${plan.shots.length} shot${plan.shots.length === 1 ? '' : 's'}, ${total} (${frames(plan.totalFrames)}) at ${fps.label} fps, ${plan.width} x ${plan.height}. Written by akuko; only material a person approved is on the timeline.`, '');
  if (o.timelineOnly) {
    L.push('**This is a timeline-only export.** No media was copied. `DOWNLOAD-LIST.md` names every file to download, and the name to save it as, into `media/` and `audio/` next to the timeline, before you import. Clip lengths were not checked against the files.', '');
  }
  L.push('## Import into Resolve (FCPXML, the main file)', '');
  L.push(
    `1. Make a new Resolve project. Before importing anything, set **Timeline frame rate to ${fps.label}** and the timeline resolution to ${plan.width} x ${plan.height} (Project Settings > Master Settings). Resolve's manual says the timeline frame rate is locked once the project has media in the Media Pool, so set it first.`,
    '2. File > Import > Timeline... and choose `timeline.fcpxml`.',
    '3. In the dialog keep **Automatically import source clips into media pool** ticked. Untick *Automatically set project settings* if you set them yourself in step 1 (option names can differ a little between Resolve versions).',
    `4. The timeline starts at 01:00:00:00. Shot ${plan.shots[0]?.shot ?? ''} is first; every shot sits back to back at its own length.`,
    '5. If a clip shows as offline (you moved this folder after exporting): Media Pool > select the clips > right-click > **Relink Selected Clips** and point at this folder. Files are matched by file name, and every name here is unique.',
    '',
  );
  if (o.format !== 'fcpxml') {
    L.push('## Fallback: EDL', '');
    L.push(
      'An EDL has timecodes and reel names but no file locations, and holds one track per file. Use it only if the FCPXML does not import.',
      '',
      `1. Import everything in \`media/\` and \`audio/\` into the Media Pool first (File > Import > Media).`,
      `2. Set the timeline frame rate to ${fps.label} (as above).`,
      `3. File > Import > Timeline... > \`edl/video.edl\`${o.edlFiles.length > 1 ? ', then each `edl/audio-N.edl` into the same timeline or its own' : ''}. Reel names are the shot numbers (\`001\`); the file name is in each event's \`FROM CLIP NAME\` comment. If Resolve cannot match them, use its reel-name options in Project Settings > General Options > Conform Options.`,
      '',
    );
  }
  L.push('## Timeline', '', '| # | Shot | Record in | Length | On the video track |', '|---|---|---|---|---|');
  const what = { clip: 'clip', still: 'still (key frame)', gap: 'gap: nothing approved', 'no-duration': 'left off: no duration' } as const;
  for (const s of plan.shots) {
    L.push(`| ${s.n} | ${s.shot} | ${timecode(START_FRAMES(fps) + s.recIn, fps)} | ${frames(s.frames)} | ${what[s.uses]} |`);
  }
  L.push('');
  L.push('Durations are whole frames: a shot\'s seconds times the frame rate, rounded to the nearest frame (halves up, at least one frame), shot by shot, so the timeline is exactly the sum of its shots. A clip longer than its shot is cut at the shot\'s end; one that is shorter is followed by a gap and named in LEFT-OUT.md. Nothing is stretched.', '');
  if (plan.audio.length > 0) {
    L.push('## Audio', '', '| Track | File | At | Length |', '|---|---|---|---|');
    for (const a of plan.audio) L.push(`| A${a.track} (${a.role}) | ${a.media.dest.split('/').pop()} | ${timecode(START_FRAMES(fps) + a.recIn, fps)} | ${frames(a.frames)}${a.note ? `, ${a.note}` : ''} |`);
    L.push('');
  }
  if (plan.captions.length > 0) {
    L.push(
      '## Captions',
      '',
      'Subtitles are in `captions/`. `captions.srt` and `captions.vtt` start at 0. This timeline starts at 01:00:00:00, and an SRT that starts at 0 does not line up with it, so use `captions_timeline_01h.srt` (the same cues, one hour later). In Resolve: File > Import > Subtitle, then drag it onto a subtitle track on the timeline.',
      '',
    );
  }
  L.push('See `LEFT-OUT.md` for what is not on the timeline and why, and `checksums.sha256` to check the copies. Re-running the export replaces only the files listed in `export-manifest.json`.', '');
  return L.join('\n');
}

export function renderLeftOut(plan: ExportPlan): string {
  const L = ['# Left out of the export', ''];
  if (plan.leftOut.length === 0) L.push('Nothing: every shot has approved material.', '');
  else {
    L.push('| Unit | What | Why |', '|---|---|---|');
    for (const x of plan.leftOut) L.push(`| ${x.unit} | ${x.what} | ${x.why} |`);
    L.push('');
  }
  if (plan.notPlaced.length > 0) {
    L.push('## Approved audio with no place on the timeline', '', 'These are copied into `audio/` but not placed (they have no film, scene or shot placement). Drop them in by hand.', '');
    for (const m of plan.notPlaced) L.push(`- ${m.dest} (${m.asset})`);
    L.push('');
  }
  if (plan.warnings.length > 0) {
    L.push('## Notes', '');
    for (const w of plan.warnings) L.push(`- ${w}`);
    L.push('');
  }
  return L.join('\n');
}

export function renderDownloadList(plan: ExportPlan): string {
  const L = ['# Files to download', '', 'Save each file under the name shown, in the folder shown, next to `timeline.fcpxml`.', '', '| Save as | Source | Unit |', '|---|---|---|'];
  for (const m of plan.media) L.push(`| ${m.dest} | ${m.uri} | ${m.asset ?? ''} |`);
  L.push('');
  return L.join('\n');
}

/** Everything the export writes as text, by path. */
export function renderTexts(plan: ExportPlan, outDir: string, o: { format: TimelineFormat; timelineOnly: boolean; srt?: string }): Map<string, string> {
  const t = new Map<string, string>();
  const fileUrl = (dest: string): string => pathToFileURL(join(outDir, ...dest.split('/'))).href;
  if (o.format !== 'edl') t.set('timeline.fcpxml', renderFcpxml(plan, { fileUrl }));
  const edlFiles: string[] = [];
  if (o.format !== 'fcpxml') {
    t.set('edl/video.edl', renderVideoEdl(plan));
    edlFiles.push('edl/video.edl');
    audioTracks(plan).forEach((evs, i) => {
      const f = `edl/audio-${i + 1}.edl`;
      t.set(f, renderAudioEdl(plan, evs, `audio ${i + 1}`));
      edlFiles.push(f);
    });
  }
  if (o.srt !== undefined) t.set('captions/captions_timeline_01h.srt', shiftSrt(o.srt));
  t.set('README.md', renderReadme(plan, { ...o, edlFiles }));
  t.set('LEFT-OUT.md', renderLeftOut(plan));
  if (o.timelineOnly) t.set('DOWNLOAD-LIST.md', renderDownloadList(plan));
  return t;
}

async function readManifest(outDir: string): Promise<Manifest | undefined> {
  const p = join(outDir, MANIFEST);
  if (!existsSync(p)) return undefined;
  try {
    const m = JSON.parse(await readFile(p, 'utf8')) as Manifest;
    return m.format === MANIFEST_FORMAT && Array.isArray(m.files) ? m : undefined;
  } catch {
    return undefined;
  }
}

export async function writeExport(o: ExportOptions): Promise<ExportResult> {
  const format = o.format ?? 'fcpxml';
  const timelineOnly = o.timelineOnly === true;
  const outDir = resolve(o.outDir);
  const plan = await planFromFolder(o);
  const srtPath = plan.captions.find((c) => c.dest.endsWith('.srt'));
  const srt = srtPath && !timelineOnly ? await readFile(localPath(o.projectDir, srtPath.uri)!, 'utf8') : undefined;
  const texts = renderTexts(plan, outDir, { format, timelineOnly, ...(srt !== undefined ? { srt } : {}) });
  const copies: Array<{ m: MediaFile; src: string }> = [];
  if (!timelineOnly) {
    for (const m of [...new Map([...plan.media, ...plan.captions].map((x) => [x.dest, x])).values()]) {
      const src = localPath(o.projectDir, m.uri);
      if (src === undefined) throw new HandoffError(`${m.uri} is not a file inside the project folder.`);
      copies.push({ m, src });
    }
  }

  const old = await readManifest(outDir);
  const ours = new Map((old?.files ?? []).map((f) => [f.path, f]));

  // Plan every path first, and stop before writing if one is somebody else's.
  const wanted = new Map<string, { role: string; text?: string; src?: string }>();
  for (const [path, text] of texts) wanted.set(path, { role: 'text', text });
  for (const c of copies) wanted.set(c.m.dest, { role: c.m.role, src: c.src });
  const conflicts = [...wanted.keys()].filter((p) => existsSync(join(outDir, ...p.split('/'))) && !ours.has(p));
  if (conflicts.length > 0) {
    throw new HandoffError(`These files already exist in ${outDir} and were not written by akuko, so nothing was exported: ${conflicts.join(', ')}. Choose another --out folder or move them.`);
  }

  const written: string[] = [];
  const unchanged: string[] = [];
  const files = new Map<string, ManifestFile>();
  const place = async (path: string, role: string, hash: string, write: (abs: string) => Promise<void>): Promise<void> => {
    const abs = join(outDir, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    if (existsSync(abs) && (await sha256File(abs)) === hash) unchanged.push(path);
    else {
      await write(abs);
      written.push(path);
    }
    files.set(path, { path, sha256: hash, role });
  };

  await mkdir(outDir, { recursive: true });
  for (const c of copies) await place(c.m.dest, c.m.role, await sha256File(c.src), (abs) => copyFile(c.src, abs));
  for (const [path, text] of texts) await place(path, 'text', sha(text), (abs) => writeFile(abs, text, 'utf8'));

  // Our own checksum list: media, audio and captions (the texts are regenerated, not checked).
  const sums = copies.map((c) => `${files.get(c.m.dest)!.sha256}  ${c.m.dest}`).sort((a, b) => a.split('  ')[1]!.localeCompare(b.split('  ')[1]!));
  if (!timelineOnly) {
    const body = `${sums.join('\n')}\n`;
    await place('checksums.sha256', 'text', sha(body), (abs) => writeFile(abs, body, 'utf8'));
  }

  const removed: string[] = [];
  const keptModified: string[] = [];
  for (const [path, f] of ours) {
    if (files.has(path)) continue;
    const abs = join(outDir, ...path.split('/'));
    if (!existsSync(abs)) continue;
    if ((await sha256File(abs)) === f.sha256) {
      await rm(abs);
      removed.push(path);
    } else keptModified.push(path);
  }

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    version: 1,
    fcpxml_version: FCPXML_VERSION,
    fps: plan.fps.label,
    files: [...files.values(), ...keptModified.map((p) => ours.get(p)!)].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const mtext = `${JSON.stringify(manifest, null, 2)}\n`;
  const mpath = join(outDir, MANIFEST);
  if (!existsSync(mpath) || (await readFile(mpath, 'utf8')) !== mtext) await writeFile(mpath, mtext, 'utf8');

  return { outDir, plan, written, unchanged, removed, keptModified };
}
