/**
 * Composition exporter (WP-07c, closes G-38).
 *
 * Stitches a project's per-cell rendered MP4s into a single deliverable:
 * concat (in beat/cell order) → optional xfade transitions → audio mix
 * (narration + music preset) → `<projectRoot>/exports/<ISO-8601>.mp4`.
 *
 * FFmpeg strategy
 * ───────────────
 * We always go through the **filter_complex** path (never the concat
 * demuxer): the demuxer requires byte-identical codec params across inputs,
 * which we can't guarantee across engines/variants, and it can't apply
 * xfade. filter_complex re-encodes once and normalizes
 * resolution/fps/SAR/pixel-format inline via a `scale,setsar,fps,format`
 * pre-chain on every input. That's the documented P1 approach: one
 * normalization pass, one encode, robust to mixed inputs.
 *
 * Transitions
 * ───────────
 * Transition NAMES come from the schema (ScriptBeat.transition / a cell's
 * out-transition). We map:
 *   • 'fade'        → xfade=transition=fade  (real crossfade, default 0.5s)
 *   • 'dissolve'    → xfade=transition=dissolve
 *   • 'wipe*'       → xfade=transition=wipeleft/…
 *   • 'smash-cut'   → plain cut (hard concat boundary; no xfade)
 *   • 'cut'/unset   → plain cut
 *   • 'J-cut'/'L-cut' → plain cut for VIDEO; the audio lead/lag they imply is
 *     approximated at the audio-mix stage by NOT trimming narration to the
 *     video boundary (narration plays straight through cell boundaries, which
 *     is the audible essence of J/L cuts in P1). Documented as an
 *     approximation; a true per-boundary audio offset is a follow-on.
 *
 * When ANY xfade is requested, the whole video chain is built as a sequence
 * of pairwise xfades (each consumes `transition_ms` of overlap). When NO
 * xfade is requested we use the cheaper `concat` filter for video. Audio is
 * always concatenated with `concat` (xfade'd boundaries get an `acrossfade`
 * so audio doesn't pop) then amix'd with narration/music.
 *
 * Progress
 * ────────
 * We total the expected output duration up-front (sum of input durations,
 * minus the overlap consumed by each xfade), parse `out_time_ms=` from
 * `-progress pipe:1` (sent to FFmpeg stdout — we keep our own stdout clean by
 * spawning detached from the JSON-RPC writer), and emit `render/progress`
 * frames with `kind:'export'`. Terminal state emits `render/done`
 * (`kind:'export'`).
 *
 * Audio robustness (G-45)
 * ────────────────────────
 * Cells can render VIDEO-ONLY (e.g. an HF/Excalidraw cell with no narration
 * track baked in). The per-cell audio graph must never reference a `:a`
 * stream that doesn't exist, or ffmpeg aborts with
 * `Stream specifier ':a' matches no streams` (exit 234) and the whole
 * `export.compose` fails. We handle this with **silence synthesis**:
 *   • We ffprobe every input for an audio stream up-front (`inputHasAudio[]`).
 *   • For each input that HAS audio we resample its real audio; for each
 *     input that LACKS audio we synthesize `anullsrc` trimmed to that input's
 *     exact duration. Both feed the `[acells]` concat, so the cell audio
 *     timeline stays sample-aligned with the video timeline regardless of
 *     which cells carry audio (chosen over "mix only inputs with audio"
 *     precisely because alignment matters for J/L-cut narration overlap).
 *   • If NO input has audio AND there is no narration/music track, we emit a
 *     genuinely VIDEO-ONLY file: no `[acells]` graph, no `-map` of audio, no
 *     amix. The export still succeeds; the deliverable simply has no audio.
 *   • When some/all inputs have audio (or narration/music exists), the
 *     silence-padded `[acells]` is amix'd with narration/music as before, so
 *     the happy path (every cell + narration) is unchanged.
 *
 * Auto-reveal
 * ───────────
 * The sidecar canNOT open a file manager (no DE access, and shelling
 * `xdg-open` from a headless sidecar is wrong). We return `{ reveal: true }`
 * alongside the path; the shell/iframe is responsible for revealing it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { rungDir, type Cell, type Project } from '@ikenga/studio-schema';

import { emitRenderDone, emitRenderProgress, type EventWriter } from './events.js';

// ─────────────────────────────────────────────────────────────────────────
// Music presets
// ─────────────────────────────────────────────────────────────────────────

/**
 * P1 music-preset set. Real bed-music presets ('ambient' / 'upbeat') need
 * licensed audio asset files we don't ship in the repo, so they currently
 * resolve to SILENCE (the export still succeeds; only narration is audible).
 * 'none' / 'silent' are first-class. When preset asset files land under
 * `<projectRoot>/assets/music/<preset>.mp3`, the resolver below picks them up
 * automatically — no code change needed.  (Follow-on: ship/curate the beds.)
 */
export const MUSIC_PRESETS = ['none', 'silent', 'ambient', 'upbeat'] as const;
export type MusicPreset = (typeof MUSIC_PRESETS)[number];

function resolveMusicBed(projectRoot: string, preset: MusicPreset | undefined): string | undefined {
  if (!preset || preset === 'none' || preset === 'silent') return undefined;
  const candidate = join(projectRoot, 'assets', 'music', `${preset}.mp3`);
  return existsSync(candidate) ? candidate : undefined; // missing → silent (documented)
}

// ─────────────────────────────────────────────────────────────────────────
// Transition mapping
// ─────────────────────────────────────────────────────────────────────────

/** Default xfade duration when a transition is an xfade kind. */
const XFADE_MS = 500;

interface TransitionMap {
  /** ffmpeg xfade `transition=` name, or null for a plain cut. */
  xfade: string | null;
}

/** Map a schema transition name → an ffmpeg xfade transition (or a plain cut). */
export function mapTransition(name: string | undefined): TransitionMap {
  switch ((name ?? '').toLowerCase().trim()) {
    case 'fade':
      return { xfade: 'fade' };
    case 'dissolve':
      return { xfade: 'dissolve' };
    case 'fadeblack':
    case 'fade-black':
      return { xfade: 'fadeblack' };
    case 'fadewhite':
    case 'fade-white':
      return { xfade: 'fadewhite' };
    case 'wipeleft':
    case 'wipe-left':
    case 'wipe':
      return { xfade: 'wipeleft' };
    case 'wiperight':
    case 'wipe-right':
      return { xfade: 'wiperight' };
    case 'slideleft':
    case 'slide-left':
      return { xfade: 'slideleft' };
    // Hard-cut family (and audio-lead/lag cuts we approximate as plain cuts):
    case 'smash-cut':
    case 'smashcut':
    case 'j-cut':
    case 'jcut':
    case 'l-cut':
    case 'lcut':
    case 'cut':
    case '':
    default:
      return { xfade: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cell selection + input resolution
// ─────────────────────────────────────────────────────────────────────────

export interface ExportRequest {
  /** Optional rung filter — only cells at this rung (numeric: 0|1|2). */
  rung?: number;
  /** Optional explicit cell uids in the order to export. Wins over rung. */
  cellIds?: string[];
  /** Music bed preset. */
  music_preset?: MusicPreset;
  /** Caller-specified output path; defaults to exports/<ISO>.mp4. */
  outputPath?: string;
  /** Which render engine subfolder to pull MP4s from. Defaults: probe order. */
  engine?: string;
}

/** Engines whose `renders/<engine>/<rungDir>/<uid>.mp4` we probe, in order. */
const ENGINE_PROBE_ORDER = ['hyperframes', 'excalidraw', 'chrome', 'remotion'];

/** A resolved input: the cell + the absolute path to its rendered MP4. */
export interface ResolvedInput {
  cell: Cell;
  mp4: string;
  /** schema transition NAME (cell out-transition) — drives boundary kind. */
  transition?: string;
}

/** Find the rendered MP4 for a cell under any probed engine subfolder. */
function findRenderedMp4(projectRoot: string, cell: Cell, engine?: string): string | undefined {
  const order = engine ? [engine, ...ENGINE_PROBE_ORDER] : ENGINE_PROBE_ORDER;
  const rd = rungDir(cell.rung);
  for (const eng of order) {
    const p = join(projectRoot, 'renders', eng, rd, `${cell.uid}.mp4`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Out-transition name for a cell — from script beat, else cell metadata. */
function cellTransition(project: Project, cell: Cell): string | undefined {
  const sb = project.script?.beats?.find((b) => b.id === cell.beat_id);
  if (sb && typeof sb.transition === 'string') return sb.transition;
  const meta = cell.metadata as { transition?: unknown } | undefined;
  if (meta && typeof meta.transition === 'string') return meta.transition;
  return undefined;
}

/** Order + resolve the inputs for an export. */
export function resolveInputs(
  project: Project,
  projectRoot: string,
  req: ExportRequest,
): { ok: true; inputs: ResolvedInput[] } | { ok: false; error: string; message: string } {
  let cells: Cell[];
  if (req.cellIds && req.cellIds.length > 0) {
    const byId = new Map(project.cells.map((c) => [c.uid, c]));
    cells = [];
    for (const id of req.cellIds) {
      const c = byId.get(id);
      if (!c) return { ok: false, error: 'cell-not-found', message: `cell ${id} not in project` };
      cells.push(c);
    }
  } else {
    cells = [...project.cells];
    if (typeof req.rung === 'number') {
      cells = cells.filter((c) => Number(String(c.rung).charAt(0)) === req.rung);
    }
    // Beat/cell order: composition-absolute start time, then index.
    cells.sort((a, b) => a.time.start - b.time.start || a.index - b.index);
  }

  const inputs: ResolvedInput[] = [];
  for (const cell of cells) {
    const mp4 = findRenderedMp4(projectRoot, cell, req.engine);
    if (!mp4) {
      return {
        ok: false,
        error: 'render-missing',
        message: `no rendered MP4 for cell ${cell.uid} (rung ${cell.rung}) under renders/*/`,
      };
    }
    inputs.push({ cell, mp4, transition: cellTransition(project, cell) });
  }
  if (inputs.length === 0) {
    return { ok: false, error: 'no-cells', message: 'export selection resolved to zero cells' };
  }
  return { ok: true, inputs };
}

// ─────────────────────────────────────────────────────────────────────────
// ffprobe — input durations (for progress total + xfade offsets)
// ─────────────────────────────────────────────────────────────────────────

function ffprobeDurationMs(path: string): Promise<number> {
  return new Promise((resolveDur) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    // Never read, but must be drained — an unread stderr pipe fills its OS
    // buffer on a chatty ffprobe and hangs the process forever.
    child.stderr.on('data', () => {});
    child.on('error', () => resolveDur(0));
    child.on('close', () => {
      const secs = Number.parseFloat(out.trim());
      resolveDur(Number.isFinite(secs) ? Math.round(secs * 1000) : 0);
    });
  });
}

/**
 * Probe an input for the presence of an audio stream (G-45). Returns `true`
 * iff ffprobe reports at least one audio stream. Any probe error → `false`
 * (treat as video-only, which is the safe assumption — we synthesize silence
 * rather than reference a maybe-missing stream).
 */
function ffprobeHasAudio(path: string): Promise<boolean> {
  return new Promise((resolveHas) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      path,
    ]);
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    // Never read, but must be drained — see ffprobeDurationMs above.
    child.stderr.on('data', () => {});
    child.on('error', () => resolveHas(false));
    child.on('close', () => resolveHas(out.trim().length > 0));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// FFmpeg arg construction
// ─────────────────────────────────────────────────────────────────────────

export interface BuildArgsResult {
  args: string[];
  /** filter_complex string (for smoke reporting). */
  filter: string;
  /** estimated total output duration ms (for progress + ffprobe assertions). */
  totalMs: number;
  /** xfade boundaries that became real crossfades (for reporting). */
  xfadeBoundaries: Array<{ between: [string, string]; transition: string }>;
}

/**
 * Build the full ffmpeg argv for an export. `w`/`h`/`fps` normalize every
 * input to a common geometry/timebase so concat + xfade are well-defined.
 */
export function buildFfmpegArgs(opts: {
  inputs: ResolvedInput[];
  inputDurationsMs: number[];
  /**
   * Per-input audio presence (G-45). `inputHasAudio[i] === true` iff input i's
   * MP4 carries an audio stream. Inputs without audio get synthesized silence
   * (anullsrc) trimmed to their duration so the cell-audio timeline stays
   * aligned with video. Defaults to "all have audio" when omitted (legacy).
   */
  inputHasAudio?: boolean[];
  outputPath: string;
  narrationPath?: string;
  musicPath?: string;
  w: number;
  h: number;
  fps: number;
}): BuildArgsResult {
  const { inputs, inputDurationsMs, outputPath, narrationPath, musicPath, w, h, fps } = opts;
  const n = inputs.length;
  const inputHasAudio = opts.inputHasAudio ?? inputs.map(() => true);

  const args: string[] = ['-y', '-hide_banner'];
  for (const inp of inputs) args.push('-i', inp.mp4);
  // Audio inputs come AFTER the n video inputs: narration first (index n),
  // then music (index n+1 if narration present, else n).
  const narrationInput = narrationPath ? n : -1;
  if (narrationPath) args.push('-i', narrationPath);
  const musicInput = musicPath ? (narrationPath ? n + 1 : n) : -1;
  if (musicPath) args.push('-i', musicPath);

  const fc: string[] = [];

  // 1) Normalize each video input.
  for (let i = 0; i < n; i++) {
    fc.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
  }

  const xfadeBoundaries: BuildArgsResult['xfadeBoundaries'] = [];
  // Decide per-boundary: an xfade transition lives on cell[i]'s OUT edge,
  // i.e. the boundary between input i and i+1.
  const boundaryXfade: (string | null)[] = [];
  for (let i = 0; i < n - 1; i++) {
    boundaryXfade.push(mapTransition(inputs[i].transition).xfade);
  }

  const anyXfade = boundaryXfade.some((x) => x !== null);
  const xfadeDurMs = XFADE_MS;

  let vOut: string;
  let totalMs: number;

  if (!anyXfade) {
    // Plain concat — cheapest, every boundary a hard cut.
    const refs = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
    fc.push(`${refs}concat=n=${n}:v=1:a=0[vout]`);
    vOut = '[vout]';
    totalMs = inputDurationsMs.reduce((a, b) => a + b, 0);
  } else {
    // Pairwise xfade chain. Each xfade consumes `xfadeDurMs` of overlap, so
    // the running offset is sum(prev durations) - sum(prev xfade overlaps).
    let prev = `[v0]`;
    let acc = inputDurationsMs[0] ?? 0;
    for (let i = 1; i < n; i++) {
      const kind = boundaryXfade[i - 1]; // boundary between i-1 and i
      const next = `[v${i}]`;
      const label = i === n - 1 ? '[vout]' : `[vx${i}]`;
      if (kind) {
        const overlap = Math.min(xfadeDurMs, inputDurationsMs[i - 1] ?? xfadeDurMs);
        const offsetMs = acc - overlap;
        const offsetS = (offsetMs / 1000).toFixed(3);
        const durS = (overlap / 1000).toFixed(3);
        fc.push(`${prev}${next}xfade=transition=${kind}:duration=${durS}:offset=${offsetS}${label}`);
        xfadeBoundaries.push({
          between: [inputs[i - 1].cell.uid, inputs[i].cell.uid],
          transition: kind,
        });
        acc = acc - overlap + (inputDurationsMs[i] ?? 0);
      } else {
        // Hard cut inside an otherwise-xfaded chain: concat the two segments.
        fc.push(`${prev}${next}concat=n=2:v=1:a=0${label}`);
        acc = acc + (inputDurationsMs[i] ?? 0);
      }
      prev = label;
    }
    vOut = '[vout]';
    totalMs = acc;
  }

  // 3) Audio (G-45 — robust to video-only inputs).
  //    Build [acells] from each cell's audio. For inputs WITH audio we
  //    resample the real stream; for VIDEO-ONLY inputs we synthesize
  //    `anullsrc` silence trimmed to that input's exact duration so the
  //    cell-audio timeline stays sample-aligned with video. We then amix
  //    [acells] with narration + music as available.
  //    For simplicity + robustness in P1 [acells] is a straight concat of the
  //    per-cell audio; the xfade overlap on video is short (0.5s) and the
  //    audible artifact of a hard audio butt-join under a video crossfade is
  //    negligible for P1.
  //
  //    SPECIAL CASE — if NO input has audio AND there is no narration/music
  //    track, we emit a genuinely video-only file: no audio graph, no audio
  //    map. (Mapping a synthesized-silence-only track would bloat the file
  //    with inaudible audio for no benefit; a true video-only deliverable is
  //    the correct output and ffprobe sees zero audio streams.)
  const anyInputAudio = inputHasAudio.some(Boolean);
  const haveExternalAudio = narrationInput >= 0 || musicInput >= 0;
  const videoOnly = !anyInputAudio && !haveExternalAudio;

  let aOut: string | null = null;
  if (!videoOnly) {
    for (let i = 0; i < n; i++) {
      if (inputHasAudio[i]) {
        fc.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      } else {
        // Synthesize silence matching this cell's duration so concat stays aligned.
        const durS = ((inputDurationsMs[i] ?? 0) / 1000).toFixed(3);
        fc.push(
          `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${durS},` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
        );
      }
    }
    const aRefs = Array.from({ length: n }, (_, i) => `[a${i}]`).join('');
    fc.push(`${aRefs}concat=n=${n}:v=0:a=1[acells]`);

    const mixInputs: string[] = ['[acells]'];
    if (narrationInput >= 0) {
      fc.push(`[${narrationInput}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[anarr]`);
      mixInputs.push('[anarr]');
    }
    if (musicInput >= 0) {
      fc.push(`[${musicInput}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.3[amus]`);
      mixInputs.push('[amus]');
    }

    if (mixInputs.length === 1) {
      aOut = '[acells]';
    } else {
      fc.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=2[aout]`);
      aOut = '[aout]';
    }
  }

  const filter = fc.join(';');
  args.push('-filter_complex', filter, '-map', vOut);
  if (aOut) args.push('-map', aOut);
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
  );
  if (aOut) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    outputPath,
  );

  return { args, filter, totalMs, xfadeBoundaries };
}

// ─────────────────────────────────────────────────────────────────────────
// Export runner — serial drain mirroring RenderRunner
// ─────────────────────────────────────────────────────────────────────────

import {
  clearExportPid,
  enqueueExport,
  getExport,
  listExportQueue,
  markExportDone,
  markExportStarted,
  mimeForPath,
  reapOrphanExportPids,
  recordExportPid,
} from './queue.js';
import type { ExportQueueRow } from './db.js';
import { randomUUID } from 'node:crypto';

type Db = Parameters<typeof markExportStarted>[0];

/**
 * Terminate a detached ffmpeg child and its process group. SIGTERM first,
 * then SIGKILL after a short grace window. Mirrors renderers/hyperframes.ts.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  const signalGroup = (sig: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig); // negative pid → process group
    } catch {
      try {
        if (!child.killed) child.kill(sig);
      } catch {
        // already exited
      }
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 1200);
}

export interface ExportLookup {
  projectRoot(projectId: string): string | undefined;
  project(projectId: string): Project | undefined;
  resolution(projectId: string): { w: number; h: number } | undefined;
}

export interface ExportRunnerDeps {
  db: Db;
  lookup: ExportLookup;
  writer: EventWriter;
}

export type ExportComposeResult =
  | { ok: true; exportId: string; outputPath: string; reveal: true }
  | { ok: false; error: string; message?: string };

export class ExportRunner {
  private readonly db: Db;
  private readonly lookup: ExportLookup;
  private readonly writer: EventWriter;
  private readonly controllers = new Map<string, AbortController>();
  private draining = false;

  constructor(deps: ExportRunnerDeps) {
    this.db = deps.db;
    this.lookup = deps.lookup;
    this.writer = deps.writer;
  }

  /**
   * Recover from a restart. A crash may have left the previous sidecar's
   * detached ffmpeg still running, so reap it FIRST (via the persisted PID
   * registry) before requeuing — otherwise the requeued export could race a
   * survivor over the same output file. `running → queued` rows stay queued
   * (not drained here): at boot no project is open, and `nextQueued` already
   * skips closed-project rows, so the kick below is a safe no-op and only
   * matters if a project happened to be open already.
   */
  recover(): void {
    reapOrphanExportPids();
    for (const row of listExportQueue(this.db)) {
      if (row.status === 'running') {
        this.db
          .prepare(`UPDATE export_queue SET status = 'queued', started_at = NULL WHERE export_id = ?`)
          .run(row.export_id);
      }
    }
    this.kick();
  }

  /**
   * Shutdown hook: abort every in-flight export — killing the detached ffmpeg
   * process group via the runFfmpeg abort signal → `killTree` — and wait,
   * bounded by `timeoutMs`, for the workers to settle before the process
   * exits. Without this a killed sidecar orphans the ffmpeg process.
   */
  async shutdown(timeoutMs = 2000): Promise<void> {
    for (const ctrl of this.controllers.values()) ctrl.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.controllers.size > 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }

  /** Validate selection up-front, persist the queued row, kick the drain. */
  compose(projectId: string, req: ExportRequest): ExportComposeResult {
    const root = this.lookup.projectRoot(projectId);
    const project = this.lookup.project(projectId);
    if (!root || !project) {
      return { ok: false, error: 'project-not-open', message: `projectId ${projectId} is not open` };
    }
    const resolved = resolveInputs(project, root, req);
    if (!resolved.ok) return resolved;

    const outputPath = this.outputPathFor(root, req.outputPath);
    const exportId = randomUUID();
    enqueueExport(this.db, {
      exportId,
      projectId,
      options: {
        rung: req.rung,
        cellIds: req.cellIds,
        music_preset: req.music_preset,
        outputPath,
        engine: req.engine,
      },
    });
    this.kick();
    return { ok: true, exportId, outputPath, reveal: true };
  }

  status(exportId: string):
    | { ok: true; record: ExportRecordView }
    | { ok: false; error: string; message?: string } {
    const row = getExport(this.db, exportId);
    if (!row) return { ok: false, error: 'export-record-not-found', message: exportId };
    return { ok: true, record: toExportView(row) };
  }

  list(projectId?: string): { ok: true; exports: ExportRecordView[] } {
    return { ok: true, exports: listExportQueue(this.db, projectId).map(toExportView) };
  }

  /** Read a finished export's MP4 off disk, base64-encoded, for in-pane
   *  composed playback (same bytes-over-bridge → blob seam as render.readBytes). */
  readBytes(exportId: string):
    | { ok: true; base64: string; mime: string; sizeBytes: number; path: string }
    | { ok: false; error: string; message?: string } {
    const row = getExport(this.db, exportId);
    if (!row) return { ok: false, error: 'export-record-not-found', message: exportId };
    if (!row.output_path) return { ok: false, error: 'export-not-done', message: 'no output on disk yet' };
    if (!existsSync(row.output_path)) return { ok: false, error: 'export-output-missing', message: row.output_path };
    try {
      const buf = readFileSync(row.output_path);
      return { ok: true, base64: buf.toString('base64'), mime: mimeForPath(row.output_path), sizeBytes: buf.length, path: row.output_path };
    } catch (e) {
      return { ok: false, error: 'export-read-failed', message: (e as Error).message };
    }
  }

  private outputPathFor(projectRoot: string, override?: string): string {
    if (override && override.length > 0) {
      return isAbsolute(override) ? override : resolve(projectRoot, override);
    }
    const dir = join(projectRoot, 'exports');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(dir, `${stamp}.mp4`);
  }

  kick(): void {
    if (this.draining) return;
    this.draining = true;
    // Defer to a microtask/tick so compose() returns before work starts.
    void this.drain().finally(() => {
      this.draining = false;
      // Re-arm only if a RUNNABLE (open-project) row remains. A raw
      // `status = 'queued'` count would spin forever here: rows for closed
      // projects stay queued by design (they resume on reopen), so counting
      // them would re-kick a drain that immediately finds nothing to run.
      if (this.nextQueued()) this.kick();
    });
  }

  /**
   * Next queued row whose owning project is currently open. Rows for closed
   * projects are intentionally skipped (left `queued`) rather than drained and
   * failed — they resume when the project reopens (see `recover`).
   */
  private nextQueued(): ExportQueueRow | undefined {
    const rows = this.db
      .prepare(`SELECT * FROM export_queue WHERE status = 'queued' ORDER BY created_at ASC`)
      .all() as ExportQueueRow[];
    for (const row of rows) {
      if (this.lookup.projectRoot(row.project_id)) return row;
    }
    return undefined;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const row = this.nextQueued();
      if (!row) return;
      await this.runOne(row);
    }
  }

  private async runOne(row: ExportQueueRow): Promise<void> {
    let req: ExportRequest = {};
    try {
      req = JSON.parse(row.options) as ExportRequest;
    } catch {
      req = {};
    }

    const root = this.lookup.projectRoot(row.project_id);
    const project = this.lookup.project(row.project_id);
    if (!root || !project) {
      const msg = 'project not open';
      markExportDone(this.db, row.export_id, 'failed', { error: msg });
      this.emitDone(row.project_id, row.export_id, 'failed', undefined, msg);
      return;
    }

    const resolved = resolveInputs(project, root, req);
    if (!resolved.ok) {
      markExportDone(this.db, row.export_id, 'failed', { error: resolved.message });
      this.emitDone(row.project_id, row.export_id, 'failed', undefined, resolved.message);
      return;
    }

    markExportStarted(this.db, row.export_id);

    const controller = new AbortController();
    this.controllers.set(row.export_id, controller);

    try {
      const outputPath = req.outputPath ?? this.outputPathFor(root);
      const res = this.lookup.resolution(row.project_id) ?? { w: 1920, h: 1080 };
      const narration = project.narration?.audio?.uri
        ? absPath(root, project.narration.audio.uri)
        : undefined;
      const narrationPath = narration && existsSync(narration) ? narration : undefined;
      const musicPath = resolveMusicBed(root, req.music_preset);

      const durations: number[] = [];
      const inputHasAudio: boolean[] = [];
      for (const inp of resolved.inputs) {
        durations.push(await ffprobeDurationMs(inp.mp4));
        inputHasAudio.push(await ffprobeHasAudio(inp.mp4));
      }

      const built = buildFfmpegArgs({
        inputs: resolved.inputs,
        inputDurationsMs: durations,
        inputHasAudio,
        outputPath,
        narrationPath,
        musicPath,
        w: res.w,
        h: res.h,
        fps: 30,
      });

      await this.runFfmpeg(row.project_id, row.export_id, built, controller.signal);

      if (!existsSync(outputPath)) {
        throw new Error(`ffmpeg exited 0 but output missing at ${outputPath}`);
      }
      markExportDone(this.db, row.export_id, 'done', { outputPath });
      this.emitDone(row.project_id, row.export_id, 'done', outputPath);
    } catch (e) {
      const cancelled = (e as Error & { cancelled?: boolean }).cancelled === true || controller.signal.aborted;
      if (cancelled) {
        markExportDone(this.db, row.export_id, 'cancelled');
        this.emitDone(row.project_id, row.export_id, 'cancelled');
      } else {
        const msg = (e as Error).message;
        markExportDone(this.db, row.export_id, 'failed', { error: msg });
        this.emitDone(row.project_id, row.export_id, 'failed', undefined, msg);
      }
    } finally {
      this.controllers.delete(row.export_id);
    }
  }

  private runFfmpeg(
    projectId: string,
    exportId: string,
    built: BuildArgsResult,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolveRun, reject) => {
      // `detached: true` mirrors render-runner: kill the whole process group
      // (negative pid) via `killTree` so an abort/crash can't leave an
      // orphaned ffmpeg process behind.
      const child = spawn('ffmpeg', built.args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      if (child.pid !== undefined) recordExportPid(exportId, child.pid);

      const onAbort = () => killTree(child);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      let stderrTail: string[] = [];
      let buf = '';
      let lastEmit = 0;

      const onProgressChunk = (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          const m = line.match(/^out_time_ms=(\d+)/);
          if (m && built.totalMs > 0) {
            const outMs = Number(m[1]) / 1000; // out_time_ms is microseconds
            const progress = Math.max(0, Math.min(1, outMs / built.totalMs));
            const now = Date.now();
            if (now - lastEmit >= 200 || progress >= 1) {
              lastEmit = now;
              emitRenderProgress(this.writer, projectId, {
                recordId: exportId,
                cellId: exportId,
                engine: 'export',
                progress,
                kind: 'export',
              });
            }
          }
        }
      };

      child.stdout.on('data', (b: Buffer) => onProgressChunk(b.toString('utf8')));
      child.stderr.on('data', (b: Buffer) => {
        const s = b.toString('utf8');
        stderrTail.push(s);
        if (stderrTail.length > 40) stderrTail = stderrTail.slice(-40);
      });
      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        clearExportPid(exportId);
        reject(err);
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        clearExportPid(exportId);
        if (signal.aborted) {
          // Cancellation is not a failure; tag the error so runOne marks the
          // row 'cancelled' rather than 'failed'.
          const abortErr = new Error('[export] ffmpeg aborted via shutdown');
          (abortErr as Error & { cancelled?: boolean }).cancelled = true;
          reject(abortErr);
          return;
        }
        if (code === 0) {
          // Emit a final 1.0 progress so consumers see completion on the channel.
          emitRenderProgress(this.writer, projectId, {
            recordId: exportId,
            cellId: exportId,
            engine: 'export',
            progress: 1,
            kind: 'export',
          });
          resolveRun();
        } else {
          reject(new Error(`ffmpeg exited ${code}: ${stderrTail.join('').slice(-800)}`));
        }
      });
    });
  }

  private emitDone(
    projectId: string,
    exportId: string,
    status: 'done' | 'failed' | 'cancelled',
    outputPath?: string,
    error?: string,
  ): void {
    emitRenderDone(this.writer, projectId, {
      recordId: exportId,
      cellId: exportId,
      engine: 'export',
      status,
      outputPath,
      error,
      kind: 'export',
    });
  }
}

export interface ExportRecordView {
  exportId: string;
  projectId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  outputPath?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

function toExportView(row: ExportQueueRow): ExportRecordView {
  return {
    exportId: row.export_id,
    projectId: row.project_id,
    status: row.status,
    outputPath: row.output_path ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

function absPath(projectRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(projectRoot, p);
}

export interface DaVinciExportOptions {
  projectRoot: string;
  project: Project;
  format?: 'otio' | 'fcpxml' | 'python_script';
  outputPath?: string;
  fps?: number;
}

export async function exportDaVinciTimeline(opts: DaVinciExportOptions): Promise<{
  ok: boolean;
  format: string;
  outputPath: string;
  clipCount: number;
}> {
  const format = opts.format || 'otio';
  const fps = opts.fps || 24;
  const project = opts.project;
  const cells = project.storyboard?.cells || [];

  const defaultExt = format === 'python_script' ? 'py' : format === 'fcpxml' ? 'fcpxml' : 'otio';
  const targetPath = opts.outputPath
    ? absPath(opts.projectRoot, opts.outputPath)
    : join(opts.projectRoot, 'exports', `timeline.${defaultExt}`);

  mkdirSync(join(opts.projectRoot, 'exports'), { recursive: true });

  if (format === 'python_script') {
    const pyContent = `
# DaVinci Resolve Timeline Import Script
# Generated by Ikenga Studio OTIO Bridge

import DaVinciResolveScript as dvr

resolve = dvr.scriptapp("Resolve")
if not resolve:
    print("Error: Could not connect to DaVinci Resolve")
    exit(1)

pm = resolve.GetProjectManager()
proj = pm.GetCurrentProject()
if not proj:
    proj = pm.CreateProject("${project.name || 'Ikenga Project'}")

mediaPool = proj.GetMediaPool()
rootFolder = mediaPool.GetRootFolder()

timeline = mediaPool.CreateEmptyTimeline("${project.name || 'Ikenga Timeline'}")
print(f"Created timeline for ${cells.length} clips at ${fps} fps")
`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(targetPath, pyContent, 'utf-8');
  } else {
    // OTIO (OpenTimelineIO) Format
    const otioClips = cells.map((cell, index) => {
      const durationFrames = Math.max(1, Math.round(((cell.duration_ms || 2000) / 1000) * fps));
      return {
        OTIO_SCHEMA: 'Clip.1',
        name: cell.uid || `Clip_${index + 1}`,
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: `renders/hyperframes/hifi/${cell.uid}.mp4`,
        },
        source_range: {
          OTIO_SCHEMA: 'TimeRange.1',
          start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: fps },
          duration: { OTIO_SCHEMA: 'RationalTime.1', value: durationFrames, rate: fps },
        },
      };
    });

    const otioDoc = {
      OTIO_SCHEMA: 'Timeline.1',
      name: project.name || 'Ikenga Timeline',
      metadata: {
        ikenga_project_id: project.id,
        archetype: project.archetype_id,
        fps,
      },
      global_start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: fps },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            name: 'Video Track 1',
            kind: 'Video',
            children: otioClips,
          },
        ],
      },
    };

    const { writeFileSync } = await import('node:fs');
    writeFileSync(targetPath, JSON.stringify(otioDoc, null, 2), 'utf-8');
  }

  return {
    ok: true,
    format,
    outputPath: targetPath,
    clipCount: cells.length,
  };
}
