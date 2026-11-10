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
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AkukoProject } from '../schema/akuko-project.ts';
import { writeFileAtomic } from '../hosts/local.ts';
import { audioTracks, renderAudioEdl, renderVideoEdl } from './edl.ts';
import { FCPXML_VERSION, renderFcpxml } from './fcpxml.ts';
import { buildPlan, startOf, type ExportPlan, type MediaFile } from './plan.ts';
import { fpsForMasterProject } from './master.ts';
import { renderMasterReadme } from './readme-master.ts';
import { readWavHeader } from './masterfile.ts';
import { probeFile } from './probe.ts';
import { HandoffError, parseFps, timecode } from './timecode.ts';

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
  /** A project with `audio.master`: reference the master in place instead of copying it (it can be hundreds of MB). Default: copy. */
  linkMedia?: boolean;
}

export interface ExportResult {
  outDir: string;
  plan: ExportPlan;
  written: string[];
  unchanged: string[];
  removed: string[];
  /** Files of ours the person has changed since akuko wrote them (a stale file, or one the new export would replace): left exactly as they are. */
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

/** Where `audio.master.uri` is: relative to the project folder (it may go up out of it) or absolute. */
function masterPath(projectDir: string, uri: string): string | undefined {
  if (/^file:/i.test(uri)) {
    try {
      return fileURLToPath(uri);
    } catch {
      return undefined;
    }
  }
  if (isAbsolute(uri)) return uri;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return undefined;
  return resolve(projectDir, ...uri.split('/'));
}

export async function planFromFolder(o: Pick<ExportOptions, 'project' | 'projectDir' | 'fps' | 'timelineOnly' | 'linkMedia'>): Promise<ExportPlan> {
  const fps = o.project.audio.master ? fpsForMasterProject(o.project, o.fps) : parseFps(o.fps);
  return buildPlan({
    project: o.project,
    fps,
    ...(o.linkMedia ? { linkMaster: true } : {}),
    resolveMaster: async (uri) => {
      const p = masterPath(o.projectDir, uri);
      if (p === undefined || !existsSync(p)) return { exists: false };
      const h = await readWavHeader(p).catch(() => undefined);
      return { exists: true, src: p, href: pathToFileURL(p).href, ...(h ? { durationS: h.durationS, sampleRate: h.sampleRate, channels: h.channels } : {}) };
    },
    ...(o.timelineOnly ? { timelineOnly: true } : {}),
    exists: (uri) => {
      const p = localPath(o.projectDir, uri);
      return p !== undefined && existsSync(p);
    },
    probe: async (uri) => {
      const p = localPath(o.projectDir, uri);
      return p === undefined ? {} : probeFile(p, (x) => readFile(x));
    },
    list: (dir) => {
      const p = localPath(o.projectDir, dir);
      return p !== undefined && existsSync(p) ? readdirSync(p) : [];
    },
  });
}

const frames = (n: number): string => `${n} frame${n === 1 ? '' : 's'}`;

/** Move every cue of an SRT forward by whole hours (the timeline starts at 01:00:00:00; the SRT starts at 0). */
export function shiftSrt(srt: string, hours = 1): string {
  return srt.replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, (_m, h: string, m: string, sec: string, ms: string) => `${String(Number(h) + hours).padStart(2, '0')}:${m}:${sec},${ms}`);
}

export function renderReadme(plan: ExportPlan, o: { format: TimelineFormat; timelineOnly: boolean; edlFiles: string[] }): string {
  if (plan.master) return renderMasterReadme(plan, o);
  const { fps } = plan;
  const total = timecode(plan.totalFrames, fps);
  const L: string[] = [];
  L.push(`# ${plan.title}: DaVinci Resolve handoff`, '');
  L.push(`${plan.shots.length} shot${plan.shots.length === 1 ? '' : 's'}, ${total} (${frames(plan.totalFrames)}) at ${fps.label} fps, ${plan.width} x ${plan.height}. Written by akuko; only material a person approved is on the timeline.`, '');
  if (o.timelineOnly) {
    L.push('**This is a timeline-only export.** No media was copied. `DOWNLOAD-LIST.md` names every file to download, and the name to save it as, into `media/` and `audio/` next to the timeline, before you import. Clip lengths were not checked against the files, and the picture and sound files are not in this folder: the paths inside the timeline point here, so **the clips will open offline in Resolve until you relink them** (Media Pool > select the clips > right-click > Relink Selected Clips) to the folder where you saved the downloads.', '');
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
      '3. Project Settings > General Options > Conform Options: tick **Assist using reel names from the** and pick **Source clip filename**. (Resolve\'s manual lists this checkbox and its choices: Source clip file pathname, Pattern, Mediapool folder name, Embedding in source clip file, Source clip filename.) Set it before importing: changing it afterwards does not re-conform a timeline that is already imported.',
      `4. File > Import > Timeline... > \`edl/video.edl\`. Importing an EDL makes a **new timeline**.${o.edlFiles.length > 1 ? ' Each `edl/audio-N.edl` becomes its own new timeline the same way: open it, select its audio clips, copy them, and paste them onto an audio track of the main timeline at 01:00:00:00 (the record timecodes already match).' : ''}`,
      '5. Reel names are one per file and never shared: `V001` is the video of shot 1, `A001` its voice-over, `MUS01` and `SFX01` the music and effects; the file name is in each event\'s `FROM CLIP NAME` comment. **Unverified:** with "Source clip filename" Resolve takes a clip\'s reel from its file name, so reels like `V001` may not match by themselves. If clips come in offline, use the FCPXML, or place them by hand from the Timeline table below.',
      '',
    );
  }
  L.push('## Timeline', '', '| # | Shot | Record in | Length | On the video track |', '|---|---|---|---|---|');
  const what = { clip: 'clip', lipsync: 'lip-sync clip', still: 'still (key frame)', gap: 'gap: nothing approved', 'no-duration': 'left off: no duration' } as const;
  for (const s of plan.shots) {
    L.push(`| ${s.n} | ${s.shot} | ${timecode(startOf(plan) + s.recIn, fps)} | ${frames(s.frames)} | ${what[s.uses]} |`);
  }
  L.push('');
  L.push('Durations are whole frames: a shot\'s seconds times the frame rate, rounded to the nearest frame (halves up, at least one frame), shot by shot, so the timeline is exactly the sum of its shots. A clip longer than its shot is cut at the shot\'s end; one that is shorter is followed by a gap and named in LEFT-OUT.md. Nothing is stretched.', '');
  if (fps.num === 1001) {
    L.push(`At ${fps.label} fps akuko counts frames in the nominal ${fps.nominal}-frame second, so N frames last 0.1% longer in real time than N/${fps.nominal} s. A clip file that is exactly as long as its shot can end a hair short of the last frame: check the last frame of such shots.`, '');
  }
  if (plan.audio.length > 0) {
    L.push('## Audio', '', '| Track | File | At | Length |', '|---|---|---|---|');
    for (const a of plan.audio) L.push(`| A${a.track} (${a.role}) | ${a.media.dest.split('/').pop()} | ${timecode(startOf(plan) + a.recIn, fps)} | ${frames(a.frames)}${a.note ? `, ${a.note}` : ''} |`);
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
  if (plan.covered && plan.covered.length > 0) {
    L.push('## Covered by the master audio', '', 'These sound units exist in the project, but the master audio is the whole sound of the film and is laid whole, so none of them is on the timeline.', '', '| Unit | What |', '|---|---|');
    for (const x of plan.covered) L.push(`| ${x.unit} | ${x.what} |`);
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
  for (const m of plan.media) L.push(`| ${m.href ? `(referenced in place, not copied) ${m.dest}` : m.dest} | ${m.uri} | ${m.asset ?? ''} |`);
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
      if (m.href !== undefined) continue; // referenced in place (--link-media): nothing to copy
      const src = m.src ?? localPath(o.projectDir, m.uri);
      if (src === undefined) throw new HandoffError(`${m.uri} is not a file inside the project folder.`);
      copies.push({ m, src });
    }
  }

  const old = await readManifest(outDir);
  const ours = new Map((old?.files ?? []).map((f) => [f.path, f]));

  // Plan every path first, and stop before writing if one is somebody else's.
  const abs = (path: string): string => join(outDir, ...path.split('/'));
  const wanted = [...texts.keys(), ...copies.map((c) => c.m.dest)];
  if (!timelineOnly) wanted.push('checksums.sha256');
  const conflicts = wanted.filter((p) => existsSync(abs(p)) && !ours.has(p));
  if (conflicts.length > 0) {
    throw new HandoffError(`These files already exist in ${outDir} and were not written by akuko, so nothing was exported: ${conflicts.join(', ')}. Choose another --out folder or move them.`);
  }

  /**
   * What to do with one of our paths: write it (absent, or exactly as akuko last wrote it), leave it
   * (already the new content), or keep it (the person changed it since: different from what we wrote AND
   * from what we would write now). A kept file stays in the manifest with its old hash, so it is reported
   * on every later run until the person moves it.
   */
  type Dispo = { act: 'write' } | { act: 'same' } | { act: 'kept'; disk: string };
  const decide = async (path: string, hash: string): Promise<Dispo> => {
    if (!existsSync(abs(path))) return { act: 'write' };
    const disk = await sha256File(abs(path));
    if (disk === hash) return { act: 'same' };
    return disk === ours.get(path)?.sha256 ? { act: 'write' } : { act: 'kept', disk };
  };

  const copyHash = new Map<string, string>();
  for (const c of copies) copyHash.set(c.m.dest, await sha256File(c.src));
  const copyDispo = new Map<string, Dispo>();
  for (const c of copies) copyDispo.set(c.m.dest, await decide(c.m.dest, copyHash.get(c.m.dest)!));

  // Our own checksum list: what is in the folder for every media, audio and caption file.
  if (!timelineOnly) {
    const lines = copies.map((c) => {
      const d = copyDispo.get(c.m.dest)!;
      return { path: c.m.dest, hash: d.act === 'kept' ? d.disk : copyHash.get(c.m.dest)! };
    });
    lines.sort((x, y) => x.path.localeCompare(y.path));
    texts.set('checksums.sha256', `${lines.map((l) => `${l.hash}  ${l.path}`).join('\n')}\n`);
  }
  const textHash = new Map([...texts].map(([p, t]) => [p, sha(t)]));
  const textDispo = new Map<string, Dispo>();
  for (const [p] of texts) textDispo.set(p, await decide(p, textHash.get(p)!));

  interface Item { path: string; role: string; hash: string; d: Dispo; src?: string; text?: string }
  const items: Item[] = [
    ...copies.map((c): Item => ({ path: c.m.dest, role: c.m.role, hash: copyHash.get(c.m.dest)!, d: copyDispo.get(c.m.dest)!, src: c.src })),
    ...[...texts].map(([path, text]): Item => ({ path, role: 'text', hash: textHash.get(path)!, d: textDispo.get(path)!, text })),
  ];

  const files = new Map<string, ManifestFile>();
  for (const it of items) files.set(it.path, it.d.act === 'kept' ? ours.get(it.path)! : { path: it.path, sha256: it.hash, role: it.role });

  const manifestPath = join(outDir, MANIFEST);
  const writeManifest = async (entries: Iterable<ManifestFile>): Promise<void> => {
    const manifest: Manifest = {
      format: MANIFEST_FORMAT,
      version: 1,
      fcpxml_version: FCPXML_VERSION,
      fps: plan.fps.label,
      files: [...entries].sort((x, y) => x.path.localeCompare(y.path)),
    };
    const mtext = `${JSON.stringify(manifest, null, 2)}\n`;
    if (!existsSync(manifestPath) || (await readFile(manifestPath, 'utf8')) !== mtext) await writeFileAtomic(manifestPath, mtext);
  };

  // The manifest goes first: every NEW path is listed before it is written, so a run that dies half way
  // leaves files the next run recognises as its own, not as somebody else's. (Files are written through a
  // temp name and renamed, so no half-written file ever sits at a real path.)
  await mkdir(outDir, { recursive: true });
  const prior = new Map(ours);
  for (const it of items) if (!prior.has(it.path) && it.d.act !== 'same') prior.set(it.path, files.get(it.path)!);
  await writeManifest(prior.values());

  const written: string[] = [];
  const unchanged: string[] = [];
  const keptModified: string[] = [];
  for (const it of items) {
    if (it.d.act === 'same') unchanged.push(it.path);
    else if (it.d.act === 'kept') keptModified.push(it.path);
    else {
      const target = abs(it.path);
      await mkdir(dirname(target), { recursive: true });
      if (it.src !== undefined) {
        const tmp = `${target}.akuko-tmp`;
        try {
          await copyFile(it.src, tmp);
          await rename(tmp, target);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
      } else await writeFileAtomic(target, it.text!);
      written.push(it.path);
    }
  }

  const removed: string[] = [];
  for (const [path, f] of ours) {
    if (files.has(path)) continue;
    if (!existsSync(abs(path))) continue;
    if ((await sha256File(abs(path))) === f.sha256) {
      await rm(abs(path));
      removed.push(path);
    } else {
      keptModified.push(path);
      files.set(path, f);
    }
  }

  await writeManifest(files.values());
  return { outDir, plan, written, unchanged, removed, keptModified };
}
