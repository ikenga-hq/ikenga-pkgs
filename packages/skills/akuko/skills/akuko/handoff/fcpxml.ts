/**
 * akuko — FCPXML 1.8 writer for the Resolve handoff (WP-23). Primary timeline format.
 *
 * Why FCPXML and why 1.8 (sources and what could not be verified: `actions/export.md`, the PR
 * description, and `README.md` in an export): Resolve's own scripting README lists FCPXML among
 * the timeline formats it imports, a project exchange format that carries each shot's file
 * location, so Resolve relinks the media with no reel-name setup. Users report that Resolve
 * rejects the newest FCPXML versions (1.12 on Resolve 18.6/19) and accepts 1.11 and older, so the
 * file is written as 1.8, the oldest version whose `asset` carries a plain `src` URL: every newer
 * Resolve reads it, and it needs nothing a later version added.
 *
 * Shape (the same one Final Cut Pro exports; checked against Apple's `FCPXMLv1_8.dtd`):
 *   resources:  one `format` (the project's size and frame rate) and one `asset` per file;
 *   sequence:   `tcStart` 01:00:00:00, a `spine` of one `asset-clip` / `video` (still) / `gap` per
 *               event, back to back, each with its own length in whole frames;
 *   audio:      `asset-clip`s on negative lanes, anchored to the video event they start under,
 *               so voice-over starts exactly at its shot's first frame.
 */

import type { AudioEvent, ExportPlan, MediaFile, VideoEvent } from './plan.ts';
import { START_FRAMES, fcpFrameDuration, fcpTime } from './timecode.ts';

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

export interface FcpxmlOptions {
  /** `file://` URL for a media file's place in the export folder. */
  fileUrl(dest: string): string;
}

export function renderFcpxml(plan: ExportPlan, o: FcpxmlOptions): string {
  const { fps } = plan;
  const t = (frames: number): string => fcpTime(frames, fps);
  const start = START_FRAMES(fps);
  const formatName = `FFVideoFormat${plan.height}p${({ '23.976': '2398', '29.97': '2997', '59.94': '5994' } as Record<string, string>)[fps.label] ?? fps.label}`;
  const lines: string[] = [];
  const push = (indent: number, s: string): void => void lines.push(`${'  '.repeat(indent)}${s}`);

  push(0, '<?xml version="1.0" encoding="UTF-8"?>');
  push(0, '<!DOCTYPE fcpxml>');
  push(0, `<fcpxml version="${FCPXML_VERSION}">`);
  push(1, '<resources>');
  push(2, `<format id="r1" name="${esc(formatName)}" frameDuration="${fcpFrameDuration(fps)}" width="${plan.width}" height="${plan.height}" colorSpace="1-1-1 (Rec. 709)"/>`);

  // One asset per file; its length is the file's own, else the longest event that uses it.
  const used = new Map<string, number>();
  for (const e of plan.video) if (e.media) used.set(e.media.id, Math.max(used.get(e.media.id) ?? 0, e.frames));
  for (const e of plan.audio) used.set(e.media.id, Math.max(used.get(e.media.id) ?? 0, e.frames));
  const assets: MediaFile[] = plan.media.filter((m) => used.has(m.id));
  for (const m of assets) {
    const dur = m.role === 'still' ? '0s' : m.durationS !== undefined ? seconds(m.durationS) : t(used.get(m.id)!);
    const a: string[] = [`id="${m.id}"`, `name="${esc(stem(m.dest))}"`, `src="${esc(o.fileUrl(m.dest))}"`, 'start="0s"', `duration="${dur}"`];
    if (m.role === 'clip' || m.role === 'still') a.push('hasVideo="1"', 'format="r1"');
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
    const open = v.kind === 'gap' ? `<gap ${common}` : v.kind === 'still' ? `<video ref="${v.media!.id}" ${common}` : `<asset-clip ref="${v.media!.id}" ${common} tcFormat="NDF"`;
    const close = v.kind === 'gap' ? '</gap>' : v.kind === 'still' ? '</video>' : '</asset-clip>';
    if (kids.length === 0) push(6, `${open}/>`);
    else {
      push(6, `${open}>`);
      for (const a of kids) {
        // An anchored item's offset is in its parent's own time, which starts at the parent's `start` (0s here).
        push(7, `<asset-clip ref="${a.media.id}" lane="-${a.track}" offset="${t(a.recIn - v.recIn)}" name="${esc(stem(a.media.dest))}" start="0s" duration="${t(a.frames)}"/>`);
      }
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
