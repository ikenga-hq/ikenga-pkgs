/**
 * akuko — what goes on the Resolve timeline (WP-23). Pure: no files are read or written here.
 *
 * Order and timing: the shots in document order (the order `sound/narration.ts` uses for the
 * film's timeline); a shot's slot is its `duration_s` in whole frames (`timecode.ts`). A shot
 * without a duration cannot be given an exact length, so it is left off and listed.
 *
 * Video track 1, per shot:
 *   - the approved clip (`<shot>_clip`) with a file, cut to the shot's length (the clip may be
 *     longer; its out-point is the shot's end). A clip SHORTER than the shot is followed by a gap
 *     for the rest and named in the warnings: akuko never stretches or freezes a clip;
 *   - else the approved key frame (`<shot>_keyframe`) as a still held for the slot (flagged);
 *   - else a gap of the right length, listed as missing.
 * Only `approved` material is used. Everything else is left out and listed with its status.
 *
 * Audio: approved voice-over takes, each at its shot's start; if there are none, the single
 * `audio.narration.audio` track from the start; approved music and SFX where their placement
 * tag says (`placement:film|scene:<id>|shot:<id>`), otherwise listed as "not placed" (their
 * files are still copied).
 */

import type { AkukoProject, Asset, Shot } from '../schema/akuko-project.ts';
import { isKeyframe } from '../keyframes/plan.ts';
import { isClip } from '../motion/plan.ts';
import { isVo } from '../sound/plan.ts';
import type { Probe } from './probe.ts';
import { HandoffError, framesAvailable, framesFor, type Fps } from './timecode.ts';

export type MediaRole = 'clip' | 'still' | 'vo' | 'narration' | 'music' | 'sfx' | 'captions';

export interface MediaFile {
  /** Stable id inside the timeline files: `m1`, `m2` ... */
  id: string;
  role: MediaRole;
  /** Asset id in akuko.json (absent for the captions). */
  asset?: string;
  /** Shot it belongs to (absent for film/scene-level audio). */
  shot?: string;
  /** Where it is read from: the asset's `file.uri` (relative to the project). */
  uri: string;
  /** Path inside the export folder, `/`-separated: `media/001_sc1_sh1.mp4`. */
  dest: string;
  mime?: string;
  durationS?: number;
  channels?: number;
  sampleRate?: number;
}

export interface VideoEvent {
  /** 1-based event number. */
  n: number;
  shot: string;
  kind: 'clip' | 'still' | 'gap';
  media?: MediaFile;
  /** Record in, in frames from the timeline's first frame (0-based). */
  recIn: number;
  frames: number;
  /** Source in-point in frames (always 0: media starts at its first frame). */
  srcIn: number;
  note?: string;
}

export interface AudioEvent {
  n: number;
  role: 'vo' | 'narration' | 'music' | 'sfx';
  media: MediaFile;
  /** The shot the sound belongs to or sits under, if any. */
  shot?: string;
  recIn: number;
  frames: number;
  srcIn: number;
  /** 1-based audio track, packed so events on one track never overlap. */
  track: number;
  note?: string;
}

export interface LeftOut {
  unit: string;
  what: string;
  why: string;
}

export interface ShotRow {
  n: number;
  shot: string;
  frames: number;
  recIn: number;
  /** What is on the video track. */
  uses: 'clip' | 'still' | 'gap' | 'no-duration';
}

export interface ExportPlan {
  title: string;
  fps: Fps;
  width: number;
  height: number;
  totalFrames: number;
  shots: ShotRow[];
  video: VideoEvent[];
  audio: AudioEvent[];
  media: MediaFile[];
  captions: MediaFile[];
  /** Approved audio with no known placement: copied to the folder, not on the timeline. */
  notPlaced: MediaFile[];
  leftOut: LeftOut[];
  warnings: string[];
  /** True when media lengths could not be checked (no files to read, host A). */
  unchecked: boolean;
}

export interface PlanInput {
  project: AkukoProject;
  fps: Fps;
  /** Does the file exist where the asset says? `timelineOnly` runs answer yes for everything. */
  exists(uri: string): boolean;
  probe(uri: string): Promise<Probe>;
  /** Host A and similar: no files to read, the timeline is built from the project alone. */
  timelineOnly?: boolean;
}

const ASPECT_SIZE: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');
const ext = (uri: string): string => {
  const base = uri.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
};

const usable = (a: Asset | undefined): a is Asset & { file: NonNullable<Asset['file']> } => a !== undefined && a.status === 'approved' && a.file !== undefined;

function whyNot(a: Asset, exists: (uri: string) => boolean): string {
  if (a.status !== 'approved') return `status is ${a.status}, not approved`;
  if (!a.file) return 'approved but has no file';
  if (!exists(a.file.uri)) return `approved, but its file is missing (${a.file.uri})`;
  return 'not usable';
}

/** `placement:film|scene:<id>|shot:<id>` from a music/SFX asset; undefined when it has none. */
export function placementOf(a: Asset): { film: true } | { scene: string } | { shot: string } | undefined {
  const t = a.tags.find((x) => x.startsWith('placement:'));
  if (!t) return undefined;
  const v = t.slice('placement:'.length);
  if (v === 'film') return { film: true };
  if (v.startsWith('scene:')) return { scene: v.slice(6) };
  if (v.startsWith('shot:')) return { shot: v.slice(5) };
  return undefined;
}

export async function buildPlan(input: PlanInput): Promise<ExportPlan> {
  const { project: p, fps } = input;
  const exists = (uri: string): boolean => input.timelineOnly === true || input.exists(uri);
  if (p.shots.length === 0) throw new HandoffError('This project has no shots yet, so there is nothing to put on a timeline.');

  const [dw, dh] = ASPECT_SIZE[p.project.aspect_ratio] ?? [1920, 1080];
  const width = p.project.resolution?.w ?? dw;
  const height = p.project.resolution?.h ?? dh;

  const warnings: string[] = [];
  const leftOut: LeftOut[] = [];
  const media: MediaFile[] = [];
  const numW = Math.max(3, String(p.shots.length).length);
  let mediaN = 0;
  const addMedia = async (m: Omit<MediaFile, 'id'>): Promise<MediaFile> => {
    const pr = input.timelineOnly ? {} : await input.probe(m.uri);
    const f: MediaFile = {
      ...m,
      id: `m${++mediaN}`,
      ...(pr.durationS !== undefined ? { durationS: pr.durationS } : {}),
      ...(pr.channels !== undefined ? { channels: pr.channels } : {}),
      ...(pr.sampleRate !== undefined ? { sampleRate: pr.sampleRate } : {}),
    };
    media.push(f);
    return f;
  };

  const clips = p.assets.filter(isClip);
  const frames = p.assets.filter(isKeyframe);
  const vos = p.assets.filter(isVo);
  const byOwner = (list: Asset[], shot: Shot, fallbackId: string): Asset | undefined =>
    list.find((a) => a.id === fallbackId) ?? list.find((a) => a.owner === shot.id);

  const video: VideoEvent[] = [];
  const shots: ShotRow[] = [];
  const shotStart = new Map<string, number>();
  const shotFrames = new Map<string, number>();
  const shotIndex = new Map<string, number>();
  let t = 0;
  let evn = 0;

  for (let i = 0; i < p.shots.length; i++) {
    const shot = p.shots[i]!;
    const n = i + 1;
    shotIndex.set(shot.id, n);
    const num = pad(n, numW);
    if (shot.duration_s === undefined || !(shot.duration_s > 0)) {
      shots.push({ n, shot: shot.id, frames: 0, recIn: t, uses: 'no-duration' });
      leftOut.push({ unit: shot.id, what: 'shot', why: 'it has no duration, so it cannot be given an exact length on the timeline; set duration_s and export again' });
      continue;
    }
    const slot = framesFor(shot.duration_s, fps);
    shotStart.set(shot.id, t);
    shotFrames.set(shot.id, slot);

    const clip = byOwner(clips, shot, `${shot.id}_clip`);
    const still = byOwner(frames, shot, `${shot.id}_keyframe`);
    let used: ShotRow['uses'] = 'gap';
    const pushV = (v: Omit<VideoEvent, 'n' | 'recIn'>, at: number): void => {
      video.push({ ...v, n: ++evn, recIn: at });
    };

    if (usable(clip) && exists(clip.file.uri)) {
      const m = await addMedia({ role: 'clip', asset: clip.id, shot: shot.id, uri: clip.file.uri, dest: `media/${num}_${safe(shot.id)}${ext(clip.file.uri)}`, ...(clip.file.mime ? { mime: clip.file.mime } : {}) });
      const avail = m.durationS !== undefined ? framesAvailable(m.durationS, fps) : undefined;
      if (avail !== undefined && avail < slot) {
        const short = slot - avail;
        pushV({ shot: shot.id, kind: 'clip', media: m, frames: avail, srcIn: 0, note: `clip is ${short} frame${short === 1 ? '' : 's'} shorter than the shot; gap follows` }, t);
        pushV({ shot: shot.id, kind: 'gap', frames: short, srcIn: 0, note: 'rest of the shot (the clip ends early)' }, t + avail);
        warnings.push(`${shot.id}: the approved clip is ${m.durationS!.toFixed(3)} s but the shot is ${shot.duration_s} s (${slot} frames); the last ${short} frame${short === 1 ? '' : 's'} are a gap. Nothing was stretched.`);
      } else {
        pushV({ shot: shot.id, kind: 'clip', media: m, frames: slot, srcIn: 0, ...(avail !== undefined && avail > slot ? { note: `clip is longer than the shot; cut to the shot's length (out-point at frame ${slot})` } : {}) }, t);
      }
      used = 'clip';
    } else if (usable(still) && exists(still.file.uri)) {
      const m = await addMedia({ role: 'still', asset: still.id, shot: shot.id, uri: still.file.uri, dest: `media/${num}_${safe(shot.id)}_still${ext(still.file.uri)}`, ...(still.file.mime ? { mime: still.file.mime } : {}) });
      pushV({ shot: shot.id, kind: 'still', media: m, frames: slot, srcIn: 0, note: 'still (key frame), held for the shot' }, t);
      used = 'still';
    } else {
      pushV({ shot: shot.id, kind: 'gap', frames: slot, srcIn: 0, note: 'nothing approved for this shot' }, t);
      leftOut.push({ unit: shot.id, what: 'shot', why: 'missing: no approved clip or key frame, so a gap of the shot\'s length stands in' });
    }
    // The ones that could have been used but were not: say so, with their status.
    if (clip && used !== 'clip') leftOut.push({ unit: clip.id, what: 'clip', why: whyNot(clip, exists) });
    if (still && used === 'gap') leftOut.push({ unit: still.id, what: 'key frame', why: whyNot(still, exists) });
    shots.push({ n, shot: shot.id, frames: slot, recIn: t, uses: used });
    t += slot;
  }
  const totalFrames = t;

  // ── audio ─────────────────────────────────────────────────────────────
  const audio: AudioEvent[] = [];
  const notPlaced: MediaFile[] = [];
  const found: Array<Omit<AudioEvent, 'n' | 'track'>> = [];

  const takes = vos.filter((a) => a.owner !== undefined);
  let anyTake = false;
  for (const a of takes) {
    const shot = p.shots.find((s) => s.id === a.owner);
    if (!shot) continue;
    if (!usable(a) || !exists(a.file.uri)) {
      if (a.status !== 'pending' || a.file) leftOut.push({ unit: a.id, what: 'voice-over', why: whyNot(a, exists) });
      continue;
    }
    const start = shotStart.get(shot.id);
    if (start === undefined) {
      leftOut.push({ unit: a.id, what: 'voice-over', why: `its shot ${shot.id} has no duration, so it has no place on the timeline` });
      continue;
    }
    const n = shotIndex.get(shot.id)!;
    const m = await addMedia({ role: 'vo', asset: a.id, shot: shot.id, uri: a.file.uri, dest: `audio/${pad(n, numW)}_${safe(shot.id)}_vo${ext(a.file.uri)}`, ...(a.file.mime ? { mime: a.file.mime } : {}) });
    const slot = shotFrames.get(shot.id)!;
    const want = m.durationS !== undefined ? Math.min(slot, Math.max(1, Math.ceil(m.durationS * fps.nominal - 1e-6))) : slot;
    if (m.durationS !== undefined && Math.ceil(m.durationS * fps.nominal - 1e-6) > slot) warnings.push(`${a.id}: the approved take (${m.durationS.toFixed(2)} s) is longer than its shot (${shot.duration_s} s); it is cut at the end of the shot on the timeline. The file in audio/ is whole.`);
    found.push({ role: 'vo', media: m, shot: shot.id, recIn: start, frames: want, srcIn: 0, ...(m.durationS === undefined ? { note: 'take length unknown here; given the shot\'s length' } : {}) });
    anyTake = true;
  }

  const narr = p.audio.narration;
  if (!anyTake && narr?.audio?.uri) {
    if (exists(narr.audio.uri)) {
      const m = await addMedia({ role: 'narration', uri: narr.audio.uri, dest: `audio/narration${ext(narr.audio.uri)}`, ...(narr.audio.mime ? { mime: narr.audio.mime } : {}) });
      const want = Math.min(totalFrames, m.durationS !== undefined ? Math.ceil(m.durationS * fps.nominal - 1e-6) : totalFrames);
      found.push({ role: 'narration', media: m, recIn: 0, frames: want, srcIn: 0 });
      warnings.push('The voice-over is the single narration track that "sound sync" built from the takes approved at that time. If you approved or sent back a take since, run sync again before exporting.');
    } else leftOut.push({ unit: 'audio.narration', what: 'narration track', why: `its file is missing (${narr.audio.uri})` });
  }

  for (const a of p.assets) {
    if (a.stage !== 'sound' || (a.kind !== 'music' && a.kind !== 'sfx')) continue;
    if (!usable(a) || !exists(a.file.uri)) {
      leftOut.push({ unit: a.id, what: a.kind, why: whyNot(a, exists) });
      continue;
    }
    const role = a.kind as 'music' | 'sfx';
    const m = await addMedia({ role, asset: a.id, ...(a.owner ? { shot: a.owner } : {}), uri: a.file.uri, dest: `audio/${role}_${safe(a.id)}${ext(a.file.uri)}`, ...(a.file.mime ? { mime: a.file.mime } : {}) });
    const where = placementOf(a);
    let start: number | undefined;
    let end = totalFrames;
    let anchor: string | undefined;
    if (where && 'film' in where) start = 0;
    else if (where && 'shot' in where) {
      start = shotStart.get(where.shot);
      end = start === undefined ? 0 : start + shotFrames.get(where.shot)!;
      anchor = where.shot;
    } else if (where && 'scene' in where) {
      const inScene = p.shots.filter((s) => s.scene === where.scene && shotStart.has(s.id));
      if (inScene.length > 0) {
        start = shotStart.get(inScene[0]!.id)!;
        const last = inScene[inScene.length - 1]!;
        end = shotStart.get(last.id)! + shotFrames.get(last.id)!;
        anchor = inScene[0]!.id;
      }
    }
    if (start === undefined) {
      notPlaced.push(m);
      continue;
    }
    const known = m.durationS !== undefined ? Math.max(1, Math.ceil(m.durationS * fps.nominal - 1e-6)) : undefined;
    let len = known ?? Math.max(1, end - start);
    let note: string | undefined = known === undefined ? `length unknown here; set to its placement (${end - start} frames), trim in Resolve` : undefined;
    if (start + len > totalFrames) {
      len = totalFrames - start;
      note = `trimmed to the end of the film`;
    }
    if (len > 0) found.push({ role, media: m, ...(anchor ? { shot: anchor } : {}), recIn: start, frames: len, srcIn: 0, ...(note ? { note } : {}) });
  }

  // Tracks: voice-over first, then music, then SFX; within a kind, the first track where it does not overlap.
  const order = { vo: 0, narration: 0, music: 1, sfx: 2 } as const;
  found.sort((a, b) => order[a.role] - order[b.role] || a.recIn - b.recIn);
  const lanes: number[][] = [[], [], []]; // end frame of each lane, per group
  const placed = found.map((e) => {
    const ends = lanes[order[e.role]]!;
    let lane = ends.findIndex((end) => end <= e.recIn);
    if (lane < 0) lane = ends.push(0) - 1;
    ends[lane] = e.recIn + e.frames;
    return { e, g: order[e.role], lane };
  });
  const base = [0, lanes[0]!.length, lanes[0]!.length + lanes[1]!.length];
  for (const { e, g, lane } of placed) audio.push({ ...e, n: audio.length + 1, track: base[g]! + lane + 1 });

  // Captions: copied when sound sync wrote them (Resolve imports SRT as subtitles).
  const captions: MediaFile[] = [];
  for (const c of [{ uri: 'audio/vo/captions.srt', mime: 'application/x-subrip' }, { uri: 'audio/vo/captions.vtt', mime: 'text/vtt' }]) {
    if (exists(c.uri) && !input.timelineOnly) {
      captions.push({ id: `c${captions.length + 1}`, role: 'captions', uri: c.uri, dest: `captions/${c.uri.split('/').pop()}`, mime: c.mime });
    }
  }

  return {
    title: p.project.title,
    fps,
    width,
    height,
    totalFrames,
    shots,
    video,
    audio,
    media,
    captions,
    notPlaced,
    leftOut,
    warnings,
    unchecked: input.timelineOnly === true,
  };
}
