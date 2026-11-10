/**
 * akuko — FCPXML 1.8 writer for the Resolve handoff (WP-23). Primary timeline format.
 *
 * Why FCPXML and why 1.8 (sources and what could not be verified: `actions/export.md`, the PR
 * description, and `README.md` in an export): Resolve's own scripting README lists FCPXML among
 * the timeline formats it imports, a project exchange format that carries each shot's file
 * location, so Resolve relinks the media with no reel-name setup. Users report that Resolve
 * rejects the newest FCPXML versions (1.12 on Resolve 18.6/19) and accepts 1.11 and older, so the
 * file is written as 1.8, the newest version whose `asset` carries a plain `src` URL (1.9 moved it into
 * `media-rep`): a newer Resolve is expected to read it, and it needs nothing a later version added.
 *
 * Shape (the same one Final Cut Pro exports; checked against Apple's `FCPXMLv1_8.dtd`):
 *   resources:  one `format` (the project's size and frame rate) and one `asset` per file;
 *   sequence:   `tcStart` 01:00:00:00 (a master-clock project: its `audio.master.start_tc`), a `spine` of one `asset-clip` / `video` (still) / `gap` per
 *               event, back to back, each with its own length in whole frames;
 *   audio:      `asset-clip`s on negative lanes, anchored to the video event they start under,
 *               so voice-over starts exactly at its shot's first frame.
 */

import type { StillMove } from '../schema/akuko-project.ts';
import type { AudioEvent, ExportPlan, MediaFile, VideoEvent } from './plan.ts';
import type { Fps } from './timecode.ts';
import { fcpFrameDuration, fcpTime } from './timecode.ts';
import { startOf } from './plan.ts';
import { moveLabel } from './master.ts';

export const FCPXML_VERSION = '1.8';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** A file's own length as a rational of seconds (millisecond precision). */
function seconds(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const g = gcd(ms, 1000) || 1;
  const num = ms / g;
  const den = 1000 / g;
  return den === 1 ? `${num}s` : `${num}/${den}s`;
}

const stem = (dest: string): string => {
  const base = dest.split('/').pop() ?? dest;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
};

/**
 * Apple's name for a standard format (`FFVideoFormat1080p24`), or undefined: the name is optional, and a
 * made-up one (a 1:1 or 9:16 picture is not `1080p`) would describe the wrong picture.
 */
export function appleFormatName(w: number, h: number, rate: string): string | undefined {
  const r = ({ '23.976': '2398', '29.97': '2997', '59.94': '5994' } as Record<string, string>)[rate] ?? rate;
  if (w === 1280 && h === 720) return `FFVideoFormat720p${r}`;
  if (w === 1920 && h === 1080) return `FFVideoFormat1080p${r}`;
  if (w === 3840 && h === 2160) return `FFVideoFormat3840x2160p${r}`;
  return undefined;
}

export interface FcpxmlOptions {
  /** `file://` URL for a media file's place in the export folder. */
  fileUrl(dest: string): string;
}

/** FCPXML `interp` for the first and last keyframe of a move, from the move's `ease` (unverified in Resolve, see README). */
export function easeInterps(ease: StillMove['ease']): [string, string] {
  switch (ease) {
    // NOTE: this deviates from the literal wording in the schema docs ("ease-in -> ease in"). Here `ease-in` means the
    // MOVE starts slowly and speeds up (GSAP `sine.in`), which in FCPXML is easing AWAY from the first keyframe, i.e.
    // `easeOut` on keyframe 1 (FCP names an ease by the side of the keyframe it softens). Likewise `ease-out`, a slow
    // finish, is `easeIn` on the last keyframe. Unverified in Resolve (README says so).
    case 'ease-in': return ['easeOut', 'linear']; // slow start: eases away from the first keyframe
    case 'ease-out': return ['linear', 'easeIn']; // slow finish: eases into the last keyframe
    case 'ease-in-out': return ['ease', 'ease'];
    default: return ['linear', 'linear'];
  }
}

const n4 = (n: number): string => String(Number(n.toFixed(4)));

/** How far through a move it is at fraction `t` (0..1) of its time, by its ease: GSAP's sine eases, as KenBurns and the README name them. */
export function moveProgress(ease: StillMove['ease'], t: number): number {
  const u = Math.min(1, Math.max(0, t));
  switch (ease) {
    case 'ease-in': return 1 - Math.cos((u * Math.PI) / 2);
    case 'ease-out': return Math.sin((u * Math.PI) / 2);
    case 'ease-in-out': return -(Math.cos(Math.PI * u) - 1) / 2;
    default: return u;
  }
}

/** A move's scale and drift (pixels of a 1920x1080 frame) at fraction `t` of its time. */
export function moveAt(mv: StillMove, t: number): { scale: number; x: number; y: number } {
  const k = moveProgress(mv.ease, t);
  return { scale: mv.from_scale + (mv.to_scale - mv.from_scale) * k, x: mv.x * k, y: mv.y * k };
}

/**
 * The keyframes for one piece of a still's slot (WP-32: the key frame held before or after a lip-sync). The move
 * runs across the WHOLE slot of `of` frames and is never restarted: a piece from frame `at` to `at + frames` starts
 * where the move is at `at / of` and ends where it is at `(at + frames) / of`, so the two pieces either side of a
 * lip-sync join up with the move as it would have been under it. Values at a piece's ends are exact for every
 * ease. Between them a piece interpolates on its own: the move's ease is kept on the ends that are the move's own
 * start or end, and the cut ends are linear, so an eased move is followed closely but not exactly inside a piece.
 * A whole-slot still (`at` 0, `frames` = `of`) gives the move's own two keyframes.
 */
export function movePiece(mv: StillMove, at: number, frames: number, of: number): { start: ReturnType<typeof moveAt>; end: ReturnType<typeof moveAt>; interps: [string, string] } {
  const [i0, i1] = easeInterps(mv.ease);
  const a = of > 0 ? at / of : 0;
  const b = of > 0 ? (at + frames) / of : 1;
  return { start: moveAt(mv, a), end: moveAt(mv, b), interps: [at === 0 ? i0 : 'linear', at + frames >= of ? i1 : 'linear'] };
}

/**
 * `adjust-transform` keyframes for a still's move. Apple's FCPXML reference: `position` is in percent of the
 * project's HEIGHT, +y up; `scale` is a factor. The schema's `x`/`y` are pixels of a 1920x1080 frame, +y down, so
 * x% = x / 1080 x 100 and y% = -y / 1080 x 100. The animation runs across the whole slot; a still that is one
 * piece of the slot (`span`) carries its share of it (`movePiece`).
 */
function transformXml(push: (indent: number, s: string) => void, ind: number, mv: StillMove, frames: number, fps: Fps, t: (n: number) => string, span?: { at: number; of: number }): void {
  const { start, end, interps: [i0, i1] } = movePiece(mv, span?.at ?? 0, frames, span?.of ?? frames);
  const px = (v: number): number => (v / 1080) * 100;
  const pos = (m: { x: number; y: number }): string => (m.x === 0 && m.y === 0 ? '0 0' : `${n4(px(m.x))} ${n4(-px(m.y))}`);
  push(ind, '<adjust-transform>');
  push(ind + 1, '<param name="position">');
  push(ind + 2, '<keyframeAnimation>');
  push(ind + 3, `<keyframe time="0s" value="${pos(start)}" interp="${i0}"/>`);
  push(ind + 3, `<keyframe time="${t(frames)}" value="${pos(end)}" interp="${i1}"/>`);
  push(ind + 2, '</keyframeAnimation>');
  push(ind + 1, '</param>');
  push(ind + 1, '<param name="scale">');
  push(ind + 2, '<keyframeAnimation>');
  push(ind + 3, `<keyframe time="0s" value="${n4(start.scale)} ${n4(start.scale)}" interp="${i0}"/>`);
  push(ind + 3, `<keyframe time="${t(frames)}" value="${n4(end.scale)} ${n4(end.scale)}" interp="${i1}"/>`);
  push(ind + 2, '</keyframeAnimation>');
  push(ind + 1, '</param>');
  push(ind, '</adjust-transform>');
}

/** Words for a still that is one piece of its slot: which frames of the whole move it carries. Empty for a whole-slot still. */
export function pieceLabel(span: { at: number; of: number } | undefined, frames: number): string {
  if (!span || (span.at === 0 && frames >= span.of)) return '';
  return `; this piece is frames ${span.at} to ${span.at + frames} of the shot's ${span.of}, held around its lip-sync; the move runs on across the lip-sync`;
}

export function renderFcpxml(plan: ExportPlan, o: FcpxmlOptions): string {
  const { fps } = plan;
  const t = (frames: number): string => fcpTime(frames, fps);
  const start = startOf(plan);
  const master = plan.master !== undefined;
  const formatName = appleFormatName(plan.width, plan.height, fps.label);
  const lines: string[] = [];
  const push = (indent: number, s: string): void => void lines.push(`${'  '.repeat(indent)}${s}`);

  push(0, '<?xml version="1.0" encoding="UTF-8"?>');
  push(0, '<!DOCTYPE fcpxml>');
  push(0, `<fcpxml version="${FCPXML_VERSION}">`);
  push(1, '<resources>');
  push(2, `<format id="r1"${formatName ? ` name="${esc(formatName)}"` : ''} frameDuration="${fcpFrameDuration(fps)}" width="${plan.width}" height="${plan.height}" colorSpace="1-1-1 (Rec. 709)"/>`);

  // One asset per file; its length is the file's own, else the longest event that uses it.
  const used = new Map<string, number>();
  for (const e of plan.video) if (e.media) used.set(e.media.id, Math.max(used.get(e.media.id) ?? 0, e.frames));
  for (const e of plan.audio) used.set(e.media.id, Math.max(used.get(e.media.id) ?? 0, e.frames));
  const assets: MediaFile[] = plan.media.filter((m) => used.has(m.id));
  for (const m of assets) {
    // The master asset is declared as long as the audio clip on A1 (the master's length rounded up to a frame), so the
    // clip never runs past its asset; the file itself is a few ms shorter at most.
    const dur = m.role === 'still' ? '0s' : m.role === 'master' ? t(used.get(m.id)!) : m.durationS !== undefined ? seconds(m.durationS) : t(used.get(m.id)!);
    const a: string[] = [`id="${m.id}"`, `name="${esc(stem(m.dest))}"`, `src="${esc(m.href ?? o.fileUrl(m.dest))}"`, 'start="0s"', `duration="${dur}"`];
    if (m.role === 'clip' || m.role === 'still') {
      a.push('hasVideo="1"', 'format="r1"');
      // A clip with a sound track of its own (a motion clip made with audio) keeps it.
      // (master-clock project: picture only, never the sound of a picture file; it is muted on the event below)
      if (m.hasAudio && !master) a.push('hasAudio="1"', 'audioSources="1"', `audioChannels="${m.channels ?? 2}"`, `audioRate="${m.sampleRate ?? 48000}"`);
    }
    else a.push('hasAudio="1"', 'audioSources="1"', `audioChannels="${m.channels ?? 2}"`, `audioRate="${m.sampleRate ?? 48000}"`);
    push(2, `<asset ${a.join(' ')}/>`);
  }
  push(1, '</resources>');

  push(1, '<library>');
  push(2, `<event name="${esc(plan.title)}">`);
  push(3, `<project name="${esc(plan.title)}">`);
  push(4, `<sequence format="r1" duration="${t(plan.totalFrames)}" tcStart="${t(start)}" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`);
  push(5, '<spine>');

  const anchored = new Map<VideoEvent, AudioEvent[]>();
  for (const a of plan.audio) {
    const parent = plan.video.find((v) => a.recIn >= v.recIn && a.recIn < v.recIn + v.frames);
    if (!parent) continue; // cannot happen: audio starts inside the film
    anchored.set(parent, [...(anchored.get(parent) ?? []), a]);
  }

  for (const v of plan.video) {
    const name = v.media ? stem(v.media.dest) : `${v.shot} (gap)`;
    const common = `offset="${t(start + v.recIn)}" name="${esc(name)}" start="0s" duration="${t(v.frames)}"`;
    const kids = anchored.get(v) ?? [];
    const open = v.kind === 'gap' ? `<gap ${common}` : v.kind === 'still' ? `<video ref="${v.media!.id}" ${common}` : `<asset-clip ref="${v.media!.id}" ${common} tcFormat="NDF"${master ? ' srcEnable="video"' : ''}`;
    const close = v.kind === 'gap' ? '</gap>' : v.kind === 'still' ? '</video>' : '</asset-clip>';
    // Master clock: picture only. `srcEnable="video"` (on every picture asset-clip, above) is the mute; the -96 dB
    // volume is a backup for a file that is known to carry sound.
    const mute = master && v.kind === 'clip' && v.media?.hasAudio === true;
    const mv = v.kind === 'still' ? v.move : undefined;
    if (kids.length === 0 && !mute && !mv) push(6, `${open}/>`);
    else {
      push(6, `${open}>`);
      if (mv) transformXml(push, 7, mv, v.frames, plan.fps, t, v.moveSpan);
      if (mute) push(7, '<adjust-volume amount="-96dB"/>');
      for (const a of kids) {
        // An anchored item's offset is in its parent's own time, which starts at the parent's `start` (0s here).
        push(7, `<asset-clip ref="${a.media.id}" lane="-${a.track}" offset="${t(a.recIn - v.recIn)}" name="${esc(stem(a.media.dest))}" start="0s" duration="${t(a.frames)}"/>`);
      }
      // A marker per move: the same numbers in words, for a Resolve that does not read the keyframes (README).
      if (mv) push(7, `<marker start="0s" duration="${t(1)}" value="${esc(moveLabel(v.shot, mv) + pieceLabel(v.moveSpan, v.frames))}"/>`);
      push(6, close);
    }
  }

  push(5, '</spine>');
  push(4, '</sequence>');
  push(3, '</project>');
  push(2, '</event>');
  push(1, '</library>');
  push(0, '</fcpxml>');
  return `${lines.join('\n')}\n`;
}
