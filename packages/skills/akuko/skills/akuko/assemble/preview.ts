/**
 * akuko — `assemble preview` (B-11): a free animatic preview from the approved key frames.
 *
 * On the live claude.ai run (2026-11-12) the person asked for something to watch before paying for motion, and
 * akuko improvised a 70 s animatic outside the skill. This makes that a documented, free action:
 *
 *   - every live shot in film order holds its **approved** key frame for exactly the shot's `duration_s`;
 *   - a gentle move is added only where the shot asks for one: its recorded `move` (still-move), else its motion
 *     note, else its camera move (`push-in`, `pull-out`, `pan` ...), else its camera note, read with
 *     `motion/moves.ts#parseMotionNote` (slow push-in, pull-back, lateral drift; fast moves are never made);
 *   - a shot with no approved key frame (or whose file is missing) stays in as black for its length, so the timing
 *     is still the film's, and the plan says which;
 *   - the picture is rendered with the export's own move renderer (`handoff/render-moves.ts#moveArgs`) and joined
 *     with ffmpeg; silent.
 *
 * It is a **preview, never a review unit**: it writes no unit, no asset, no decision, and nothing in `akuko.json`;
 * it never marks a stage done (assemble stays a stub: rough cut and picture lock are not built). No provider, no
 * spend gate, no network.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AkukoProject, Asset, Shot, StillMove } from '../schema/akuko-project.ts';
import { removedAt } from '../schema/akuko-project.ts';
import { ASPECT_SIZE } from '../handoff/plan-shared.ts';
import { moveArgs } from '../handoff/render-moves.ts';
import { framesFor, type Fps } from '../handoff/timecode.ts';
import { DRIFT_PX, DRIFT_PY, DRIFT_SCALE, PULL, PUSH, parseMotionNote } from '../motion/moves.ts';

/** Every preview says this, so nobody mistakes it for a stage output. */
export const PREVIEW_NOTICE =
  'Preview only: not a review unit and not saved to the project. Nothing in akuko.json changed and no stage moved; the assemble stage (rough cut, picture lock) is not built yet.';

export interface PreviewSegment {
  n: number;
  shot: string;
  frames: number;
  /** Seconds the shot lasts (its `duration_s`). */
  seconds: number;
  /** The approved key frame, when there is one with a file. */
  keyframe?: { asset: string; uri: string };
  /** The gentle move, and what in the shot asked for it. */
  move?: StillMove;
  moveFrom?: string;
  /** Why the shot is black in the preview. */
  black?: string;
}

export interface PreviewPlan {
  fps: Fps;
  width: number;
  height: number;
  totalFrames: number;
  seconds: number;
  segments: PreviewSegment[];
  /** Shots that cannot be timed (no duration): left out. */
  leftOut: { shot: string; why: string }[];
}

const DRIFT_RIGHT: StillMove = { from_scale: DRIFT_SCALE, to_scale: DRIFT_SCALE, x: DRIFT_PX, y: 0, ease: 'ease-in-out' };
const DRIFT_UP: StillMove = { from_scale: DRIFT_SCALE, to_scale: DRIFT_SCALE, x: 0, y: -DRIFT_PY, ease: 'ease-in-out' };
/** The shot's camera move as a gentle move on the still. Fast or orbiting moves get none (slow moves only). */
const CAMERA_MOVE: Partial<Record<Shot['camera_move'], StillMove>> = {
  'push-in': PUSH, 'zoom-in': PUSH, dolly: PUSH, 'pull-out': PULL, 'zoom-out': PULL, pan: DRIFT_RIGHT, truck: DRIFT_RIGHT, tilt: DRIFT_UP, crane: DRIFT_UP,
};

/** The gentle move a shot asks for, if any, and where it came from. Pure. */
export function previewMove(shot: Shot): { move?: StillMove; from?: string } {
  if (shot.move) return { move: shot.move, from: 'its still move' };
  const note = parseMotionNote(shot.motion_note);
  if (note.move) return { move: note.move, from: `its motion note "${shot.motion_note}"` };
  const cam = CAMERA_MOVE[shot.camera_move];
  if (cam) return { move: { ...cam }, from: `its camera move (${shot.camera_move})` };
  const text = parseMotionNote(shot.camera);
  if (text.move) return { move: text.move, from: `its camera note "${shot.camera}"` };
  return {};
}

const approvedFrame = (p: AkukoProject, shot: string): Asset | undefined =>
  p.assets.find((a) => a.id === `${shot}_keyframe` && a.status === 'approved' && a.file !== undefined && removedAt(p, a) === undefined);

/** Even pixel size, two thirds of the export frame (1280 x 720 for 16:9): quick to render, plenty to judge timing. */
function previewSize(p: AkukoProject): { width: number; height: number } {
  const [dw, dh] = ASPECT_SIZE[p.project.aspect_ratio] ?? [1920, 1080];
  const w = p.project.resolution?.w ?? dw;
  const h = p.project.resolution?.h ?? dh;
  const even = (n: number) => Math.max(2, Math.round((n * 2) / 3 / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** The preview's timing: one segment per live, timed shot, in film order. Pure; reads the project only. */
export function planPreview(p: AkukoProject, o: { fps: Fps; exists?: (uri: string) => boolean }): PreviewPlan {
  const { width, height } = previewSize(p);
  const segments: PreviewSegment[] = [];
  const leftOut: PreviewPlan['leftOut'] = [];
  for (const s of p.shots) {
    if (removedAt(p, s) !== undefined) continue;
    if (!(s.duration_s !== undefined && s.duration_s > 0)) {
      leftOut.push({ shot: s.id, why: 'it has no duration, so it cannot be timed' });
      continue;
    }
    const frames = framesFor(s.duration_s, o.fps);
    const seg: PreviewSegment = { n: segments.length + 1, shot: s.id, frames, seconds: s.duration_s };
    const kf = approvedFrame(p, s.id);
    if (!kf) {
      seg.black = 'no approved key frame yet';
    } else if (o.exists && !o.exists(kf.file!.uri)) {
      seg.black = `its key frame file (${kf.file!.uri}) was not found`;
    } else {
      seg.keyframe = { asset: kf.id, uri: kf.file!.uri };
      const m = previewMove(s);
      if (m.move) { seg.move = m.move; seg.moveFrom = m.from!; }
    }
    segments.push(seg);
  }
  const totalFrames = segments.reduce((n, x) => n + x.frames, 0);
  return { fps: o.fps, width, height, totalFrames, seconds: (totalFrames * o.fps.num) / o.fps.den, segments, leftOut };
}

/** One line per segment plus the notice: what the person is told, with or without ffmpeg. */
export function describePreview(plan: PreviewPlan): string {
  const fmt = (n: number) => String(Number(n.toFixed(3)));
  const lines = [`Animatic preview: ${plan.segments.length} shot(s), ${fmt(plan.seconds)} s at ${plan.fps.label} fps, ${plan.width} x ${plan.height}, silent.`];
  for (const s of plan.segments) {
    const what = s.black ? `black (${s.black})` : `${s.keyframe!.asset}${s.move ? `, gentle move from ${s.moveFrom}` : ', held still'}`;
    lines.push(`  ${String(s.n).padStart(3, ' ')}  ${s.shot}  ${fmt(s.seconds)} s  ${what}`);
  }
  for (const l of plan.leftOut) lines.push(`  left out ${l.shot}: ${l.why}`);
  lines.push(PREVIEW_NOTICE);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Rendering (ffmpeg)
// ─────────────────────────────────────────────────────────────────────────

export type Runner = (cmd: string, args: string[]) => Promise<void>;

const spawnRunner: Runner = (cmd, args) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += String(c); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}: ${err.trim().slice(-800)}`))));
  });

const ffmpegOn = (cmd: string): boolean => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
/** The same encoder settings as `moveArgs`, so every part has the same stream parameters and the join can copy them. */
const ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', '-map_metadata', '-1'];
const rate = (fps: Fps): string => `${fps.den}/${fps.num}`;

/** ffmpeg arguments for one segment. Pure, so it can be tested without ffmpeg. */
export function segmentArgs(plan: PreviewPlan, seg: PreviewSegment, image: string | undefined, out: string): string[] {
  const { width: W, height: H, fps } = plan;
  if (image === undefined) {
    return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${rate(fps)}`, '-frames:v', String(seg.frames), '-r', rate(fps), ...ENCODE, out];
  }
  if (seg.move) {
    // The export's renderer, with its encoder (crf 16, bit-exact): the same picture the Resolve handoff would place.
    return moveArgs({ image, move: seg.move, frames: seg.frames, at: 0, of: seg.frames, width: W, height: H, fps }, out);
  }
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;
  return ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', image, '-vf', vf, '-frames:v', String(seg.frames), '-r', rate(fps), ...ENCODE, out];
}

export interface RenderPreviewOptions {
  /** Where the MP4 goes. */
  out: string;
  /** The key frame's file on disk, from its `file.uri`. */
  pathOf: (uri: string) => string | undefined;
  ffmpeg?: string;
  /** Default: ffmpeg answers `-version`. */
  available?: boolean;
  run?: Runner;
}

export type RenderPreviewResult =
  | { status: 'written'; out: string; segments: number; seconds: number }
  | { status: 'no-ffmpeg'; message: string };

/** Render the plan to one silent MP4. Writes only `out` (and a temp folder it removes). */
export async function renderPreview(plan: PreviewPlan, o: RenderPreviewOptions): Promise<RenderPreviewResult> {
  const cmd = o.ffmpeg ?? 'ffmpeg';
  if (!(o.available ?? ffmpegOn(cmd))) {
    return { status: 'no-ffmpeg', message: 'ffmpeg was not found, so no preview MP4 was made. Install ffmpeg (or run where it is available) and run assemble preview again; the timing above is what it would show.' };
  }
  if (plan.segments.length === 0) throw new Error('There is nothing to preview: no shot has a duration.');
  const run = o.run ?? spawnRunner;
  const work = await mkdtemp(join(tmpdir(), 'akuko-preview-'));
  try {
    const parts: string[] = [];
    for (const seg of plan.segments) {
      const image = seg.keyframe ? o.pathOf(seg.keyframe.uri) : undefined;
      if (seg.keyframe && (image === undefined || !existsSync(image))) throw new Error(`The key frame for ${seg.shot} (${seg.keyframe.uri}) is not on disk.`);
      const part = join(work, `${String(seg.n).padStart(4, '0')}.mp4`);
      await run(cmd, segmentArgs(plan, seg, image, part));
      parts.push(part);
    }
    const list = join(work, 'list.txt');
    await writeFile(list, parts.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    await mkdir(dirname(o.out), { recursive: true });
    const tmp = `${o.out}.${process.pid}.tmp.mp4`;
    await run(cmd, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', tmp]);
    await rename(tmp, o.out);
    return { status: 'written', out: o.out, segments: plan.segments.length, seconds: plan.seconds };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
