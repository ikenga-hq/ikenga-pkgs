/**
 * akuko — CMX 3600 EDL writer for the Resolve handoff (WP-23). The fallback timeline format.
 *
 * An EDL carries timecodes and reel names, not file locations and not a frame rate, and one EDL
 * is one video track or one audio track, so this writes:
 *   edl/video.edl       video track 1 (clips, stills, black for gaps)
 *   edl/audio-N.edl     one file per audio track
 * Resolve conforms an EDL against media already in the Media Pool (by reel name or clip name and
 * timecode, not by file location), so the person imports `media/` + `audio/` first. See the README
 * an export writes. Each file has its own reel name (`reelName`); the file name is in
 * `* FROM CLIP NAME:` and every event carries the shot id.
 *
 * Source timecode runs from 00:00:00:00 (generated media has no embedded timecode). Record
 * timecode starts at 01:00:00:00 (a master-clock project: at `audio.master.start_tc`). Non-drop frame.
 * A master-clock export has `MASTER` for the locked audio and `C001`... for cards. An EDL cannot carry a camera
 * move, so each move is a `* MOVE` comment and is listed in the README.
 */

import type { AudioEvent, ExportPlan, VideoEvent } from './plan.ts';
import { timecode } from './timecode.ts';
import { startOf } from './plan.ts';
import { moveLabel } from './master.ts';
import { pieceLabel } from './fcpxml.ts';

/**
 * One reel name per file, never shared across kinds, at most 8 characters (the CMX 3600 reel field):
 * `V001` video of shot 1, `A001` its voice-over, `NAR01` the single narration track, `MUS01`, `SFX01`.
 */
export function reelName(plan: ExportPlan, ev: VideoEvent | AudioEvent): string {
  const shotNo = (shot: string | undefined): string => String(plan.shots.find((s) => s.shot === shot)?.n ?? 0).padStart(3, '0');
  if ('kind' in ev) {
    if (ev.kind === 'gap') return 'BL';
    if (ev.card !== undefined) return `C${String(plan.video.filter((v) => v.card !== undefined).indexOf(ev) + 1).padStart(3, '0')}`;
    // The key frame held around a lip-sync (WP-32) is another file than the lip-sync on the same shot: its own reel.
    const held = ev.from === 'keyframe' && plan.shots.find((s) => s.shot === ev.shot)?.uses === 'lipsync';
    return `V${shotNo(ev.shot)}${held ? 'K' : ''}`;
  }
  if (ev.role === 'master') return 'MASTER';
  if (ev.role === 'vo') return `A${shotNo(ev.shot)}`;
  const same = plan.audio.filter((a) => a.role === ev.role);
  const nn = String(same.indexOf(ev) + 1).padStart(2, '0');
  return ev.role === 'narration' ? `NAR${nn}` : ev.role === 'music' ? `MUS${nn}` : `SFX${nn}`;
}

const fileName = (dest: string): string => dest.split('/').pop() ?? dest;

function eventLine(n: number, reel: string, track: string, srcIn: string, srcOut: string, recIn: string, recOut: string): string {
  return `${String(n).padStart(3, '0')}  ${reel.padEnd(8)} ${track.padEnd(5)} ${'C'.padEnd(8)} ${srcIn} ${srcOut} ${recIn} ${recOut}`;
}

export function renderVideoEdl(plan: ExportPlan): string {
  const { fps } = plan;
  const start = startOf(plan);
  const out = [`TITLE: ${plan.title} (video)`, 'FCM: NON-DROP FRAME', ''];
  for (const v of plan.video) {
    const rec = [timecode(start + v.recIn, fps), timecode(start + v.recIn + v.frames, fps)] as const;
    if (v.kind === 'gap') {
      out.push(eventLine(v.n, 'BL', 'V', timecode(0, fps), timecode(v.frames, fps), rec[0], rec[1]));
      out.push(`* SHOT ${v.shot}: no media here, ${v.note ?? 'gap'}`);
    } else {
      out.push(eventLine(v.n, reelName(plan, v), 'V', timecode(v.srcIn, fps), timecode(v.srcIn + v.frames, fps), rec[0], rec[1]));
      out.push(`* FROM CLIP NAME: ${fileName(v.media!.dest)}`);
      out.push(v.card !== undefined ? `* CARD ${v.card}` : `* SHOT ${v.shot}${v.kind === 'still' ? ' (still: a key frame held for the shot)' : ''}`);
      if (v.move) out.push(`* ${moveLabel(v.shot, v.move)}${pieceLabel(v.moveSpan, v.frames)}`);
    }
    out.push('');
  }
  return `${out.join('\n')}`;
}

/** Audio events grouped per track, in record order. */
export function audioTracks(plan: ExportPlan): AudioEvent[][] {
  const tracks: AudioEvent[][] = [];
  for (const a of [...plan.audio].sort((x, y) => x.recIn - y.recIn)) {
    (tracks[a.track - 1] ??= []).push(a);
  }
  return tracks.filter((t): t is AudioEvent[] => t !== undefined);
}

export function renderAudioEdl(plan: ExportPlan, events: AudioEvent[], label: string): string {
  const { fps } = plan;
  const start = startOf(plan);
  const out = [`TITLE: ${plan.title} (${label})`, 'FCM: NON-DROP FRAME', ''];
  events.forEach((a, i) => {
    const track = (a.media.channels ?? 2) === 1 ? 'A' : 'AA';
    out.push(eventLine(i + 1, reelName(plan, a), track, timecode(a.srcIn, fps), timecode(a.srcIn + a.frames, fps), timecode(start + a.recIn, fps), timecode(start + a.recIn + a.frames, fps)));
    out.push(`* FROM CLIP NAME: ${fileName(a.media.dest)}`);
    out.push(`* ${a.role.toUpperCase()}${a.shot ? ` ${a.shot}` : ''}${a.note ? ` (${a.note})` : ''}`);
    out.push('');
  });
  return out.join('\n');
}

export interface ParsedEdlEvent {
  event: number;
  reel: string;
  track: string;
  srcIn: string;
  srcOut: string;
  recIn: string;
  recOut: string;
  clipName?: string;
  comments: string[];
}

/** Read back what `render*Edl` wrote (and any plain CMX 3600 cut events): the round-trip check. */
export function parseEdl(text: string): { title: string; fcm: string; events: ParsedEdlEvent[] } {
  const events: ParsedEdlEvent[] = [];
  let title = '';
  let fcm = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('TITLE:')) title = line.slice(6).trim();
    else if (line.startsWith('FCM:')) fcm = line.slice(4).trim();
    else if (line.startsWith('*')) {
      const last = events[events.length - 1];
      if (!last) continue;
      const body = line.slice(1).trim();
      last.comments.push(body);
      const m = /^FROM CLIP NAME:\s*(.+)$/.exec(body);
      if (m) last.clipName = m[1]!.trim();
    } else {
      const m = /^(\d{3,})\s+(\S+)\s+(\S+)\s+C\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s*$/.exec(line);
      if (m) events.push({ event: Number(m[1]), reel: m[2]!, track: m[3]!, srcIn: m[4]!, srcOut: m[5]!, recIn: m[6]!, recOut: m[7]!, comments: [] });
    }
  }
  return { title, fcm, events };
}
