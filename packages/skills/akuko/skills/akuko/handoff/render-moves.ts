/**
 * akuko — bake camera moves on stills into short clips at export (master-clock plans).
 *
 * Why: DaVinci Resolve 19 imports an FCPXML still with its `adjust-transform` keyframes AND its clip marker
 * dropped (checked 2026-11-11, Resolve Studio 19.1.0.12, handoff/MANUAL-CHECK.md §5 M7): every move arrived static,
 * with nothing in Resolve to say there was meant to be one. So when `ffmpeg` is available, each still that carries a
 * move is rendered to an mp4 of exactly its slot's frames, with the move in the picture, and the timeline places
 * that clip instead. Resolve then only has to play it.
 *
 * - The move is the one `fcpxml.ts#moveAt` describes: scale about the centre from `from_scale` to `to_scale`, and a
 *   drift of `x`, `y` pixels of a 1920 x 1080 frame (negative = left / up), eased by `ease` (GSAP sine curves).
 *   It runs from the slot's first frame to its last frame.
 * - A still that is one piece of its slot (held before or after a lip-sync) renders only its frames of the whole
 *   move, so the two pieces join up as if the move had run on under the lip-sync.
 * - The key frame is first fitted inside the timeline frame (letterboxed if its shape differs), as Resolve's default
 *   "scale to fit" would. Anything the move uncovers is black.
 * - The key frame is upscaled 2x and padded onto a black canvas before `zoompan`, so a slow drift steps by half a pixel,
 *   and a move may zoom out (down to the schema's 0.5) or drift past an edge.
 * - Renders are cached by a hash of the key frame's bytes and every number that shapes the picture, under the OS temp
 *   folder, so a re-export of an unchanged project renders nothing and stays byte-identical. The project's own
 *   files are only read.
 * - No ffmpeg (or `--moves keyframes`): the plan is left as it was (keyframes plus a marker) and a note says the moves
 *   will arrive static in Resolve 19.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StillMove } from '../schema/akuko-project.ts';
import type { ExportPlan, MediaFile, VideoEvent } from './plan.ts';
import type { Fps } from './timecode.ts';

/** Bump when the rendered picture would change for the same inputs (it is part of the cache key). */
export const RENDER_VERSION = 1;
/** The key frame is upscaled by this much before the move, so a slow drift steps by half a pixel, not a whole one. */
const UP = 2;
/** It sits on a black canvas this many times its size, so the move can zoom out to 0.5 or drift past an edge. */
const PAD = 2;

export interface MoveRenderJob {
  /** The key frame image on disk. */
  image: string;
  move: StillMove;
  /** Frames this clip lasts. */
  frames: number;
  /** Where in the slot the clip starts, and the slot's length, in frames (a piece held around a lip-sync). */
  at: number;
  of: number;
  width: number;
  height: number;
  fps: Fps;
}

const num = (n: number): string => String(Number(n.toFixed(6)));

/** An ffmpeg expression for how far through the move output frame `on` of this clip is (0..1, eased). */
export function progressExpr(job: Pick<MoveRenderJob, 'move' | 'at' | 'of'>): string {
  // The move reaches its end on the slot's LAST frame, so a slot of `of` frames spans `of - 1` frame steps.
  const span = Math.max(1, job.of - 1);
  const p = `clip((${job.at}+on)/${span},0,1)`;
  switch (job.move.ease) {
    case 'ease-in': return `(1-cos(${p}*PI/2))`;
    case 'ease-out': return `sin(${p}*PI/2)`;
    case 'ease-in-out': return `((1-cos(PI*${p}))/2)`;
    default: return p;
  }
}

/**
 * The ffmpeg arguments that render one moving still to `out`. Pure, so it can be tested without ffmpeg.
 *
 * The key frame is fitted into the W x H frame, upscaled by UP and centred on a black canvas PAD times that size.
 * `zoompan` then crops a window from the canvas for each output frame and scales it to W x H. A window of
 * `canvas / (scale * PAD)` shows the image at `scale`; moving the window left by `dx * UP / scale` canvas pixels
 * moves the picture right by `dx` output pixels.
 */
export function moveArgs(job: MoveRenderJob, out: string): string[] {
  const { width: W, height: H, move: mv } = job;
  const k = progressExpr(job);
  const scale = `(${num(mv.from_scale)}+${num(mv.to_scale - mv.from_scale)}*${k})`;
  // Drift is in pixels of a 1920 x 1080 frame; scale it to this frame.
  const dx = `(${num((mv.x * W) / 1920)}*${k})`;
  const dy = `(${num((mv.y * H) / 1080)}*${k})`;
  const rate = `${job.fps.den}/${job.fps.num}`;
  const graph = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
    `scale=${W * UP}:${H * UP}:flags=lanczos`,
    `pad=${W * UP * PAD}:${H * UP * PAD}:(ow-iw)/2:(oh-ih)/2:black`,
    `zoompan=z='${scale}*${PAD}':x='iw/2-iw/zoom/2-${dx}*${UP}/${scale}':y='ih/2-ih/zoom/2-${dy}*${UP}/${scale}':d=${job.frames}:s=${W}x${H}:fps=${rate}`,
    'setsar=1',
    'format=yuv420p[v]',
  ].join(',');
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', job.image,
    '-filter_complex', graph, '-map', '[v]',
    '-frames:v', String(job.frames), '-r', rate,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-an', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-movflags', '+faststart',
    out,
  ];
}

export type Runner = (cmd: string, args: string[]) => Promise<void>;

const spawnRunner: Runner = (cmd, args) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += String(c); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}: ${err.trim().slice(-800)}`))));
  });

export const ffmpegOnPath = (cmd = 'ffmpeg'): boolean => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;

export interface RenderMovesOptions {
  /** Where a still's file is on disk (the writer's own resolver). */
  pathOf: (m: MediaFile) => string | undefined;
  /** ffmpeg command (default `ffmpeg`). */
  ffmpeg?: string;
  /** Default: `ffmpegOnPath()`. */
  available?: boolean;
  /** Cache folder (default `<os temp>/akuko-move-render`). */
  cacheDir?: string;
  run?: Runner;
}

export interface RenderMovesResult {
  plan: ExportPlan;
  /** Clips rendered now (not found in the cache). */
  rendered: number;
  /** Clips reused from the cache. */
  cached: number;
}

const isMovingStill = (v: VideoEvent): boolean => v.kind === 'still' && v.move !== undefined && v.media !== undefined;

/**
 * Replace every moving still in a master-clock plan with a rendered clip. Returns a new plan; the input is not changed.
 * A plan with no moves (or no master) comes back as it is.
 */
export async function renderMoves(plan: ExportPlan, o: RenderMovesOptions): Promise<RenderMovesResult> {
  const targets = plan.video.filter(isMovingStill);
  if (targets.length === 0) return { plan, rendered: 0, cached: 0 };
  const available = o.available ?? ffmpegOnPath(o.ffmpeg);
  if (!available) {
    return {
      plan: { ...plan, warnings: [...plan.warnings, `ffmpeg was not found, so the ${targets.length} camera move(s) on stills are written as FCPXML keyframes and a marker only. DaVinci Resolve 19 imports neither: those stills will arrive static. Install ffmpeg and export again to have the moves rendered into clips.`] },
      rendered: 0,
      cached: 0,
    };
  }
  const run = o.run ?? spawnRunner;
  const cacheDir = o.cacheDir ?? join(tmpdir(), 'akuko-move-render');
  await mkdir(cacheDir, { recursive: true });

  let rendered = 0;
  let cached = 0;
  const imageHash = new Map<string, string>();
  const newMedia: MediaFile[] = [];
  const video: VideoEvent[] = [];
  const warnings: string[] = [];
  for (const v of plan.video) {
    if (!isMovingStill(v)) {
      video.push(v);
      continue;
    }
    const still = v.media!;
    const image = o.pathOf(still);
    if (image === undefined || !existsSync(image)) throw new Error(`The key frame for ${v.shot} (${still.uri}) is not on disk, so its camera move cannot be rendered.`);
    if (!imageHash.has(image)) imageHash.set(image, createHash('sha256').update(await readFile(image)).digest('hex'));
    const at = v.moveSpan?.at ?? 0;
    const of = v.moveSpan?.of ?? v.frames;
    const job: MoveRenderJob = { image, move: v.move!, frames: v.frames, at, of, width: plan.width, height: plan.height, fps: plan.fps };
    const key = createHash('sha256')
      .update(JSON.stringify({ v: RENDER_VERSION, img: imageHash.get(image), move: job.move, frames: job.frames, at, of, w: job.width, h: job.height, fps: [job.fps.num, job.fps.den] }))
      .digest('hex');
    const file = join(cacheDir, `${key}.mp4`);
    if (existsSync(file)) cached++;
    else {
      const tmp = join(cacheDir, `${key}.${process.pid}.tmp.mp4`);
      try {
        await run(o.ffmpeg ?? 'ffmpeg', moveArgs(job, tmp));
        await rename(tmp, file);
      } catch (err) {
        // One bad key frame must not stop the export: this still keeps its keyframes and marker, and a note says so.
        await rm(tmp, { force: true });
        const why = err instanceof Error ? err.message.split(/\r?\n/).filter(Boolean).at(-1) ?? err.message : String(err);
        warnings.push(`${v.shot}: its camera move could not be rendered (${why.slice(0, 200)}), so it is written as keyframes and a marker only, and DaVinci Resolve 19 will show the still static. Check the key frame ${still.uri}.`);
        video.push(v);
        continue;
      }
      rendered++;
    }
    const whole = at === 0 && v.frames >= of;
    const base = still.dest.replace(/\.[^./]+$/, '').replace(/_still$/, '');
    const m: MediaFile = {
      id: `${still.id}v${v.n}`,
      role: 'clip',
      ...(still.asset !== undefined ? { asset: still.asset } : {}),
      ...(still.shot !== undefined ? { shot: still.shot } : {}),
      uri: still.uri,
      dest: `${base}_move${whole ? '' : `_${at}`}.mp4`,
      mime: 'video/mp4',
      durationS: (v.frames * plan.fps.num) / plan.fps.den,
      hasAudio: false,
      src: file,
    };
    newMedia.push(m);
    video.push({ ...v, kind: 'clip', media: m, rendered: true, note: `${v.note ?? 'still (key frame)'}, camera move rendered into the clip` });
  }

  // A still whose every use became a rendered clip is no longer needed in the folder.
  const stillUsed = new Set(video.filter((e) => e.media).map((e) => e.media!.id));
  const media = [...plan.media.filter((m) => m.role !== 'still' || stillUsed.has(m.id)), ...newMedia];
  const renderedShots = new Set(video.filter((e) => e.rendered).map((e) => e.shot));
  const moves = plan.moves?.map((r) => (renderedShots.has(r.shot) ? { ...r, rendered: true } : r));
  return { plan: { ...plan, video, media, warnings: [...plan.warnings, ...warnings], ...(moves ? { moves } : {}) }, rendered, cached };
}
