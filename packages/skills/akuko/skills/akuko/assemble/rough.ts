/**
 * akuko — `assemble rough`: a free rough cut from what a person approved, with sound.
 *
 * On a real film run the rough cut was made outside akuko with FFmpeg. This makes that recipe a documented, free
 * command. Like `assemble preview`, it is a **by-product, never a review unit**: it writes no unit, no asset, no
 * decision, no ledger entry and nothing in `akuko.json`, and it moves no stage. Picture lock and its review are not
 * built. No provider, no spend gate, no network.
 *
 * Picture, one segment per live shot in film order, each exactly the shot's length:
 *   - the approved clip (`<shot>_clip`) when there is one: a longer clip plays from its start and is cut at the shot's
 *     end; a shorter one holds its last frame for the rest (`tpad=stop_mode=clone`);
 *   - else the approved key frame, held, with a gentle move only where the shot asks for one (`preview.ts#previewMove`,
 *     rendered by the export's own move renderer);
 *   - else black for its length, with the reason.
 *   Scaled and padded to the preview's frame (1280 x 720 for 16:9), 24 fps by default, then joined.
 *
 * Sound:
 *   - each approved voice-over take at its shot's start plus 0.1 s, loudness-normalised to -16 LUFS; with no
 *     approved take, the single `audio.narration` track from the start;
 *   - optional beds the person points at (they are not stage units): music (`--music`, `--music-offset`) ducked
 *     under the voice by a compressor keyed from the voice bus, room tone (`--room-tone`) low under everything (about
 *     -36 LUFS, looped), effects (`--sfx <file>@<shot>`) at -24 LUFS, trimmed to their shot;
 *   - mixed with `amix` and `alimiter`; the integrated loudness is measured afterwards (`ebur128`).
 *
 * A project with `audio.master` (locked audio that sets the film's timing) is cut on that clock instead: each shot sits at
 * its `film` time, gaps between shots are black, the film is as long as the master, and the master is laid whole and
 * untouched from the first frame. Voice-over takes and the narration track are then not laid (the master covers
 * them). Beds can still be added on top.
 *
 * The planning here is pure; the ffmpeg calls are thin.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AkukoProject, Asset, Shot, StillMove } from '../schema/akuko-project.ts';
import { removedAt } from '../schema/akuko-project.ts';
import { started, whyNot } from '../handoff/plan-shared.ts';
import { framesAvailable, framesFor, type Fps } from '../handoff/timecode.ts';
import { isVo } from '../sound/plan.ts';
import { previewMove, previewSize, segmentArgs } from './preview.ts';

/** Every rough cut says this, so nobody mistakes it for a stage output. */
export const ROUGH_NOTICE =
  'Rough cut only: a by-product, not a review unit and not saved to the project. No unit, asset, decision or ledger entry was made, nothing in akuko.json changed and no stage moved. Picture lock and its review are not built yet.';

/** A voice-over take starts this long after its shot does (the recipe's breath). */
export const VO_DELAY_S = 0.1;
export const VO_LUFS = -16;
export const SFX_LUFS = -24;
export const MUSIC_LUFS = -24;
export const ROOM_TONE_LUFS = -36;
/** The music fades out over the film's last seconds; room tone too. */
const MUSIC_FADE_S = 2;
const ROOM_FADE_S = 1.5;
const SFX_FADE_S = 0.15;

export interface RoughClip {
  asset: string;
  uri: string;
  /** The clip's length, when it could be read. */
  seconds?: number;
  /** Frames cut from the end (the clip is longer than the shot). */
  trimFrames: number;
  /** Frames its last frame is held for (the clip is shorter than the shot). */
  holdFrames: number;
}

export interface RoughSegment {
  n: number;
  /** The shot; empty for a gap between shots on the master clock. */
  shot: string;
  /** First frame of the segment in the film. */
  at: number;
  frames: number;
  seconds: number;
  source: 'clip' | 'keyframe' | 'black';
  clip?: RoughClip;
  keyframe?: { asset: string; uri: string };
  move?: StillMove;
  moveFrom?: string;
  /** Why the segment is black. */
  black?: string;
  /** Anything else worth saying about the shot (a missing clip file, an unused lip-sync). */
  notes: string[];
}

export type RoughAudioRole = 'vo' | 'narration' | 'master' | 'music' | 'room-tone' | 'sfx';

export interface RoughAudio {
  role: RoughAudioRole;
  /** A project file's uri (vo, narration, master) or the path the person gave (music, room tone, effect). */
  src: string;
  asset?: string;
  shot?: string;
  /** Where it starts in the film, in seconds. */
  atS: number;
  /** Seconds skipped at the start of the file (the music offset). */
  skipS?: number;
  /** Longest it may run, in seconds (an effect: its shot's length; room tone and the master: the film's). */
  maxS?: number;
  /** Repeat the file to fill (room tone). */
  loop?: boolean;
  /** Loudness target (LUFS); absent = as it is (the master). */
  lufs?: number;
  /** Ducked under the voice bus (music). */
  ducked?: boolean;
  note?: string;
}

export interface RoughPlan {
  /** `shots`: end to end by duration_s. `master`: at film time on audio.master. */
  mode: 'shots' | 'master';
  fps: Fps;
  width: number;
  height: number;
  totalFrames: number;
  seconds: number;
  segments: RoughSegment[];
  audio: RoughAudio[];
  /** Shots and sound that are not in the cut, and why. */
  leftOut: { what: string; why: string }[];
  /** Worth knowing; the cut is still made. */
  warnings: string[];
  /** Stop a render (the dry run still prints them): a missing master, an effect on a shot that does not exist. */
  problems: string[];
}

export interface RoughOptions {
  fps: Fps;
  /** Does a project file exist? Default: yes. */
  exists?: (uri: string) => boolean;
  /** A project file's length in seconds (clips, voice-over), when it could be read. */
  lengthOf?: (uri: string) => number | undefined;
  /** Is the master audio on disk? Default: yes. */
  masterExists?: boolean;
  music?: { file: string; offsetS?: number };
  roomTone?: { file: string };
  sfx?: { file: string; shot: string }[];
}

const fmt = (n: number): string => String(Number(n.toFixed(3)));
const secs = (frames: number, fps: Fps): number => (frames * fps.num) / fps.den;
const live = (p: AkukoProject, a: Asset): boolean => removedAt(p, a) === undefined;
const approvedUnit = (p: AkukoProject, id: string, kind: Asset['kind']): Asset | undefined =>
  p.assets.find((a) => a.id === id && a.kind === kind && a.status === 'approved' && a.file !== undefined && live(p, a));

/** The picture for one shot slot. Pure. */
function picture(p: AkukoProject, shot: Shot, frames: number, o: RoughOptions): Omit<RoughSegment, 'n' | 'shot' | 'at' | 'frames' | 'seconds'> {
  const exists = o.exists ?? (() => true);
  const notes: string[] = [];
  const lip = approvedUnit(p, `${shot.id}_lipsync`, 'lipsync');
  if (lip) notes.push(`its approved lip-sync clip (${lip.id}) is not cut in here; the export places it`);
  const clip = approvedUnit(p, `${shot.id}_clip`, 'clip');
  if (clip && !exists(clip.file!.uri)) notes.push(`its approved clip's file (${clip.file!.uri}) was not found`);
  else if (clip) {
    const seconds = o.lengthOf?.(clip.file!.uri);
    const c: RoughClip = { asset: clip.id, uri: clip.file!.uri, trimFrames: 0, holdFrames: 0 };
    if (seconds === undefined) notes.push('the clip\'s length could not be read; its last frame is held if it runs short');
    else {
      c.seconds = seconds;
      const avail = framesAvailable(seconds, o.fps);
      c.trimFrames = Math.max(0, avail - frames);
      c.holdFrames = Math.max(0, frames - avail);
    }
    return { source: 'clip', clip: c, notes };
  }
  const kf = approvedUnit(p, `${shot.id}_keyframe`, 'keyframe');
  if (kf && exists(kf.file!.uri)) {
    const m = previewMove(shot);
    return { source: 'keyframe', keyframe: { asset: kf.id, uri: kf.file!.uri }, ...(m.move ? { move: m.move, moveFrom: m.from! } : {}), notes };
  }
  const black = kf ? `its key frame file (${kf.file!.uri}) was not found` : clip ? 'its clip file is missing and no key frame is approved' : 'no approved clip or key frame yet';
  return { source: 'black', black, notes };
}

/** The rough cut: picture segments and audio placements. Pure; reads the project only. */
export function planRough(p: AkukoProject, o: RoughOptions): RoughPlan {
  const { fps } = o;
  const { width, height } = previewSize(p);
  const exists = o.exists ?? (() => true);
  const segments: RoughSegment[] = [];
  const leftOut: RoughPlan['leftOut'] = [];
  const warnings: string[] = [];
  const problems: string[] = [];
  const master = p.audio.master;
  const mode: RoughPlan['mode'] = master ? 'master' : 'shots';
  let totalFrames = 0;

  if (!master) {
    let at = 0;
    for (const s of p.shots) {
      if (removedAt(p, s) !== undefined) continue;
      if (!(s.duration_s !== undefined && s.duration_s > 0)) {
        leftOut.push({ what: `shot ${s.id}`, why: 'it has no duration, so it cannot be timed' });
        continue;
      }
      const frames = framesFor(s.duration_s, fps);
      segments.push({ n: segments.length + 1, shot: s.id, at, frames, seconds: secs(frames, fps), ...picture(p, s, frames, o) });
      at += frames;
    }
    totalFrames = at;
  } else {
    // Film times are real seconds on the master: count frames at the real rate (as handoff/master.ts does).
    const rate = fps.den / fps.num;
    const frameAt = (t: number): number => Math.floor(t * rate + 0.5 + 1e-9);
    totalFrames = Math.max(1, Math.ceil(master.duration_s * rate - 1e-6));
    const items: Array<{ shot: Shot; inF: number; outF: number }> = [];
    for (const s of p.shots) {
      if (removedAt(p, s) !== undefined) continue;
      if (!s.film) { leftOut.push({ what: `shot ${s.id}`, why: 'it has no film time on the master, so it has no place in a master-clock cut' }); continue; }
      const inF = Math.min(frameAt(s.film.in_s), totalFrames);
      const outF = Math.min(frameAt(s.film.out_s), totalFrames);
      if (outF - inF < 1) { leftOut.push({ what: `shot ${s.id}`, why: 'its film time is shorter than one frame (or past the end of the master)' }); continue; }
      items.push({ shot: s, inF, outF });
    }
    items.sort((a, b) => a.inF - b.inF);
    const kept: typeof items = [];
    for (const it of items) {
      const prev = kept[kept.length - 1];
      if (prev && it.inF < prev.outF) {
        warnings.push(`${prev.shot.id} and ${it.shot.id} overlap on the master; ${prev.shot.id} is shortened to end where ${it.shot.id} starts.`);
        prev.outF = it.inF;
        if (prev.outF <= prev.inF) { kept.pop(); leftOut.push({ what: `shot ${prev.shot.id}`, why: `it is covered by ${it.shot.id} at the same film time` }); }
      }
      kept.push(it);
    }
    let cursor = 0;
    const gap = (to: number, why: string): void => {
      const frames = to - cursor;
      segments.push({ n: segments.length + 1, shot: '', at: cursor, frames, seconds: secs(frames, fps), source: 'black', black: why, notes: [] });
    };
    for (const it of kept) {
      if (it.inF > cursor) gap(it.inF, 'no shot at this film time');
      const frames = it.outF - it.inF;
      segments.push({ n: segments.length + 1, shot: it.shot.id, at: it.inF, frames, seconds: secs(frames, fps), ...picture(p, it.shot, frames, o) });
      cursor = it.outF;
    }
    if (cursor < totalFrames) gap(totalFrames, cursor === 0 ? 'no picture yet' : 'end of the master: no picture');
  }

  const filmS = secs(totalFrames, fps);
  const byShot = new Map(segments.filter((s) => s.shot).map((s) => [s.shot, s]));
  const audio: RoughAudio[] = [];

  // ── voice ─────────────────────────────────────────────────────────────
  const takes = p.assets.filter((a) => isVo(a) && a.owner !== undefined && live(p, a));
  if (master) {
    if (o.masterExists === false) problems.push(`The master audio is missing: ${master.uri}. A project with audio.master is cut on its clock and needs the file.`);
    audio.push({ role: 'master', src: master.uri, atS: 0, maxS: filmS, note: 'the locked master, laid whole and untouched from the first frame' });
    const covered = takes.filter((a) => started(a)).length + (p.audio.narration?.audio?.uri ? 1 : 0);
    if (covered > 0) warnings.push(`${covered} voice-over file(s) are covered by the master and not laid.`);
  } else {
    for (const a of takes) {
      const seg = byShot.get(a.owner!);
      if (a.status !== 'approved' || !a.file || !exists(a.file.uri)) {
        if (started(a)) leftOut.push({ what: `voice-over ${a.id}`, why: whyNot(a, exists) });
        continue;
      }
      if (!seg) { leftOut.push({ what: `voice-over ${a.id}`, why: `its shot ${a.owner} is not in the cut (no duration, or removed)` }); continue; }
      const atS = secs(seg.at, fps) + VO_DELAY_S;
      const len = o.lengthOf?.(a.file.uri);
      const over = len !== undefined ? atS + len - secs(seg.at + seg.frames, fps) : 0;
      if (over > 1e-3) warnings.push(`${a.id}: the take (${fmt(len!)} s) starting ${VO_DELAY_S} s into its shot runs ${fmt(over)} s past the end of ${seg.shot}; it is kept whole.`);
      audio.push({ role: 'vo', src: a.file.uri, asset: a.id, shot: seg.shot, atS, lufs: VO_LUFS });
    }
    const narr = p.audio.narration?.audio?.uri;
    if (!audio.some((x) => x.role === 'vo') && narr) {
      if (exists(narr)) audio.push({ role: 'narration', src: narr, atS: 0, maxS: filmS, lufs: VO_LUFS, note: 'the single narration track sound sync built (no approved take was found on its own)' });
      else leftOut.push({ what: 'narration track', why: `its file is missing (${narr})` });
    }
  }
  const voiced = audio.length > 0;

  // ── beds the person pointed at ────────────────────────────────────────
  if (o.music) {
    const skip = o.music.offsetS ?? 0;
    audio.push({ role: 'music', src: o.music.file, atS: 0, ...(skip > 0 ? { skipS: skip } : {}), maxS: filmS, lufs: MUSIC_LUFS, ducked: voiced });
  }
  if (o.roomTone) audio.push({ role: 'room-tone', src: o.roomTone.file, atS: 0, maxS: filmS, loop: true, lufs: ROOM_TONE_LUFS });
  for (const fx of o.sfx ?? []) {
    const seg = byShot.get(fx.shot);
    if (seg) { audio.push({ role: 'sfx', src: fx.file, shot: fx.shot, atS: secs(seg.at, fps), maxS: seg.seconds, lufs: SFX_LUFS }); continue; }
    const s = p.shots.find((x) => x.id === fx.shot);
    if (s) leftOut.push({ what: `effect ${fx.file}`, why: `its shot ${fx.shot} is not in the cut (no duration or film time, or removed)` });
    else problems.push(`--sfx ${fx.file}@${fx.shot}: there is no shot ${fx.shot} in this project.`);
  }
  const beds = p.assets.filter((a) => a.stage === 'sound' && (a.kind === 'music' || a.kind === 'sfx') && a.status === 'approved' && live(p, a));
  if (beds.length > 0) warnings.push(`Approved music or effects in the project are not laid automatically (${beds.map((a) => a.id).join(', ')}): point at their files with --music or --sfx <file>@<shot>.`);

  return { mode, fps, width, height, totalFrames, seconds: filmS, segments, audio, leftOut, warnings, problems };
}

/** One line per segment and per sound, plus the notice: what the person is told, with or without ffmpeg. */
export function describeRough(plan: RoughPlan): string {
  const L: string[] = [];
  const clock = plan.mode === 'master' ? ', on the master clock' : '';
  L.push(`Rough cut: ${plan.segments.filter((s) => s.shot).length} shot(s), ${fmt(plan.seconds)} s at ${plan.fps.label} fps, ${plan.width} x ${plan.height}${clock}.`);
  L.push('Picture:');
  const sp = (f: number): string => fmt(secs(f, plan.fps));
  for (const s of plan.segments) {
    let what: string;
    if (s.source === 'clip') {
      const c = s.clip!;
      const len = c.seconds !== undefined ? ` (${fmt(c.seconds)} s)` : ' (length unknown)';
      const fit = c.trimFrames > 0 ? `: plays its first ${fmt(s.seconds)} s, cuts the last ${sp(c.trimFrames)} s (${c.trimFrames} frames)`
        : c.holdFrames > 0 ? `: holds its last frame for ${sp(c.holdFrames)} s (${c.holdFrames} frames)`
        : c.seconds !== undefined ? ': fits' : '';
      what = `clip ${c.asset}${len}${fit}`;
    } else if (s.source === 'keyframe') {
      what = `key frame ${s.keyframe!.asset}${s.move ? `, gentle move from ${s.moveFrom}` : ', held still'}`;
    } else what = `black (${s.black})`;
    const where = plan.mode === 'master' ? `at ${sp(s.at)} s  ` : '';
    L.push(`  ${String(s.n).padStart(3, ' ')}  ${s.shot || '(gap)'}  ${where}${fmt(s.seconds)} s  ${what}`);
    for (const n of s.notes) L.push(`         note: ${n}`);
  }
  L.push('Sound:');
  if (plan.audio.length === 0) L.push('  none: the cut is silent (no approved voice-over, no beds given)');
  for (const a of plan.audio) {
    const lufs = a.lufs !== undefined ? `, ${a.lufs} LUFS` : '';
    switch (a.role) {
      case 'vo': L.push(`  voice-over ${a.asset} at ${fmt(a.atS)} s (start of ${a.shot} + ${VO_DELAY_S} s)${lufs}`); break;
      case 'narration': L.push(`  narration track ${a.src} from 0 s${lufs}: ${a.note}`); break;
      case 'master': L.push(`  master ${a.src} from 0 s: ${a.note}`); break;
      case 'music': L.push(`  music ${a.src} from 0 s${a.skipS ? `, starting ${fmt(a.skipS)} s into the file` : ''}${lufs}${a.ducked ? ', ducked under the voice' : ''}, fades out over the last ${MUSIC_FADE_S} s`); break;
      case 'room-tone': L.push(`  room tone ${a.src} under everything, looped${lufs}`); break;
      case 'sfx': L.push(`  effect ${a.src} on ${a.shot} at ${fmt(a.atS)} s, trimmed to ${fmt(a.maxS!)} s${lufs}`); break;
    }
  }
  if (plan.audio.length > 0) L.push(plan.audio.length === 1 && plan.audio[0]!.role === 'master' ? '  mix: the master alone, untouched' : '  mix: amix, then alimiter; loudness measured after the render');
  for (const l of plan.leftOut) L.push(`  left out ${l.what}: ${l.why}`);
  for (const w of plan.warnings) L.push(`  warning: ${w}`);
  for (const p of plan.problems) L.push(`  cannot render: ${p}`);
  L.push(ROUGH_NOTICE);
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// The mix (a filtergraph), pure
// ─────────────────────────────────────────────────────────────────────────

const VOICE_ROLES = new Set<RoughAudioRole>(['vo', 'narration', 'master']);
const TP: Partial<Record<RoughAudioRole, number>> = { vo: -2, narration: -2, music: -4, sfx: -6, 'room-tone': -6 };

/**
 * The audio filtergraph for the plan, with input `firstInput` as the first sound (input 0 is the picture), ending in
 * `[mix]`. Undefined when the cut is silent. The recipe: each voice-over loudness-normalised and delayed to its
 * place; music trimmed by its offset, normalised and ducked by a compressor keyed from the voice bus; room tone
 * low and looped; effects trimmed to their shot; everything mixed, padded or cut to the film's length, limited.
 */
export function audioGraph(plan: RoughPlan, firstInput = 1): string | undefined {
  if (plan.audio.length === 0) return undefined;
  const film = fmt(plan.seconds);
  const lines: string[] = [];
  const voice: string[] = [];
  const sfx: string[] = [];
  let music: string | undefined;
  let room: string | undefined;
  plan.audio.forEach((a, k) => {
    const f: string[] = [];
    if (a.skipS) f.push(`atrim=start=${fmt(a.skipS)}`, 'asetpts=N/SR/TB');
    if (a.maxS !== undefined && a.role !== 'music') f.push(`atrim=0:${fmt(a.maxS)}`, 'asetpts=N/SR/TB');
    f.push('aformat=channel_layouts=stereo', 'aresample=48000');
    if (a.lufs !== undefined) f.push(`loudnorm=I=${a.lufs}:TP=${TP[a.role] ?? -2}${a.role === 'vo' || a.role === 'narration' ? ':LRA=7' : ''}`);
    if (a.role === 'sfx') f.push(`afade=t=out:st=${fmt(Math.max(0, a.maxS! - SFX_FADE_S))}:d=${SFX_FADE_S}`);
    if (a.role === 'music') f.push(`atrim=0:${film}`, `afade=t=out:st=${fmt(Math.max(0, plan.seconds - MUSIC_FADE_S))}:d=${MUSIC_FADE_S}`);
    if (a.role === 'room-tone') f.push(`afade=t=out:st=${fmt(Math.max(0, plan.seconds - ROOM_FADE_S))}:d=${ROOM_FADE_S}`);
    const ms = Math.round(a.atS * 1000);
    if (ms > 0) f.push(`adelay=delays=${ms}:all=1`);
    const label = `a${k}`;
    lines.push(`[${firstInput + k}]${f.join(',')}[${label}]`);
    if (VOICE_ROLES.has(a.role)) voice.push(label);
    else if (a.role === 'sfx') sfx.push(label);
    else if (a.role === 'music') music = label;
    else room = label;
  });
  const bus = (labels: string[], name: string): string | undefined => {
    if (labels.length === 0) return undefined;
    if (labels.length === 1) return labels[0];
    lines.push(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0[${name}]`);
    return name;
  };
  let vo = bus(voice, 'vobus');
  const fx = bus(sfx, 'sfxbus');
  if (music && plan.audio.find((a) => a.role === 'music')!.ducked && vo) {
    lines.push(`[${vo}]asplit=2[vo1][vosc]`);
    lines.push(`[${music}][vosc]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=400[musd]`);
    vo = 'vo1';
    music = 'musd';
  }
  const all = [vo, music, room, fx].filter((x): x is string => x !== undefined);
  const masterOnly = plan.audio.length === 1 && plan.audio[0]!.role === 'master';
  const tail = `apad,atrim=0:${film}${masterOnly ? '' : ',alimiter=limit=0.89'}[mix]`;
  if (all.length === 1) lines.push(`[${all[0]}]${tail}`);
  else lines.push(`${all.map((l) => `[${l}]`).join('')}amix=inputs=${all.length}:normalize=0:duration=longest,${tail}`);
  return lines.join(';\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────
// ffmpeg: how to pass a filtergraph file
// ─────────────────────────────────────────────────────────────────────────

/** `slash`: `-/filter_complex <file>` (FFmpeg 7 and later). `script`: `-filter_complex_script <file>` (older; deprecated, then gone). */
export type FilterFileStyle = 'slash' | 'script';

export const filterFileArgs = (style: FilterFileStyle, file: string): string[] =>
  style === 'slash' ? ['-/filter_complex', file] : ['-filter_complex_script', file];

/** Which way to try first, from `ffmpeg -version`: a release 7 or later takes `-/filter_complex`, an older one the script option; an unreadable version (a git build) tries the new way first. */
export function filterFileOrder(versionText: string | undefined): [FilterFileStyle, FilterFileStyle] {
  const m = /ffmpeg version n?(\d+)\.(\d+)/i.exec(versionText ?? '');
  if (m && Number(m[1]) < 7) return ['script', 'slash'];
  return ['slash', 'script'];
}

/** Run `build(style)` with the first style; if ffmpeg refuses it, run it again with the other. */
export async function runWithFilterFile<T>(order: [FilterFileStyle, FilterFileStyle], attempt: (style: FilterFileStyle) => Promise<T>): Promise<{ style: FilterFileStyle; result: T }> {
  try {
    return { style: order[0], result: await attempt(order[0]) };
  } catch (first) {
    try {
      return { style: order[1], result: await attempt(order[1]) };
    } catch (second) {
      const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      throw new Error(`ffmpeg refused the mix both ways. With ${order[0]}: ${msg(first)}\nWith ${order[1]}: ${msg(second)}`);
    }
  }
}

/** The integrated loudness from ffmpeg's `ebur128` summary, or undefined. */
export function parseIntegratedLufs(stderr: string): number | undefined {
  const all = [...stderr.matchAll(/Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  const last = all.at(-1);
  return last ? Number(last[1]) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Rendering (thin)
// ─────────────────────────────────────────────────────────────────────────

/** Runs ffmpeg; resolves its stderr, rejects with it on a non-zero exit. */
export type RoughRunner = (cmd: string, args: string[]) => Promise<string>;

const spawnRunner: RoughRunner = (cmd, args) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += String(c); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(err) : fail(new Error(`${cmd} exited ${code}: ${err.trim().slice(-800)}`))));
  });

const ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', '-map_metadata', '-1'];
const rate = (fps: Fps): string => `${fps.den}/${fps.num}`;

/**
 * ffmpeg arguments that conform an approved clip to its slot: converted to the cut's frame rate, fitted into the
 * frame, its last frame held for any shortfall (with two spare frames against rounding), cut at exactly the
 * slot's frames. Its own sound is dropped. Pure.
 */
export function clipArgs(plan: Pick<RoughPlan, 'width' | 'height' | 'fps'>, seg: Pick<RoughSegment, 'frames' | 'clip'>, file: string, out: string): string[] {
  const { width: W, height: H, fps } = plan;
  const c = seg.clip!;
  const hold = c.seconds === undefined ? seg.frames : c.holdFrames + 2;
  const vf = [
    `fps=${rate(fps)}`,
    `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
    `tpad=stop_mode=clone:stop=${hold}`,
    'format=yuv420p',
  ].join(',');
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', vf, '-frames:v', String(seg.frames), '-r', rate(fps), ...ENCODE, out];
}

export interface RenderRoughOptions {
  out: string;
  /** A project file's path on disk, from its uri (clips, key frames, voice-over, narration, the master). */
  pathOf: (uri: string) => string | undefined;
  ffmpeg?: string;
  /** Default: ffmpeg answers `-version`. */
  available?: boolean;
  /** `ffmpeg -version` output, to choose how the filtergraph file is passed. Default: asked. */
  versionText?: string;
  run?: RoughRunner;
}

export type RenderRoughResult =
  | { status: 'written'; out: string; seconds: number; lufs?: number; filterStyle?: FilterFileStyle }
  | { status: 'no-ffmpeg'; message: string };

/** Render the plan to one MP4. Writes only `out` (and a temp folder it removes). */
export async function renderRough(plan: RoughPlan, o: RenderRoughOptions): Promise<RenderRoughResult> {
  const cmd = o.ffmpeg ?? 'ffmpeg';
  const version = o.available === undefined || o.versionText === undefined ? spawnSync(cmd, ['-version'], { encoding: 'utf8' }) : undefined;
  if (!(o.available ?? version?.status === 0)) {
    return { status: 'no-ffmpeg', message: 'ffmpeg was not found, so no rough cut was made and nothing was written. Install ffmpeg (or run where it is available) and run assemble rough again; the plan above is what it would make.' };
  }
  if (plan.problems.length > 0) throw new Error(`The rough cut cannot be rendered: ${plan.problems.join(' ')}`);
  if (plan.segments.length === 0) throw new Error('There is nothing to cut: no shot has a duration.');
  const run = o.run ?? spawnRunner;
  const need = (uri: string, what: string): string => {
    const p = o.pathOf(uri);
    if (p === undefined || !existsSync(p)) throw new Error(`The ${what} (${uri}) is not on disk.`);
    return p;
  };
  const work = await mkdtemp(join(tmpdir(), 'akuko-rough-'));
  try {
    const parts: string[] = [];
    for (const seg of plan.segments) {
      const part = join(work, `${String(seg.n).padStart(4, '0')}.mp4`);
      if (seg.source === 'clip') await run(cmd, clipArgs(plan, seg, need(seg.clip!.uri, `clip for ${seg.shot}`), part));
      else await run(cmd, segmentArgs(plan, seg, seg.keyframe ? need(seg.keyframe.uri, `key frame for ${seg.shot}`) : undefined, part));
      parts.push(part);
    }
    const list = join(work, 'list.txt');
    await writeFile(list, parts.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const pictureFile = join(work, 'picture.mp4');
    await run(cmd, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', pictureFile]);
    await mkdir(dirname(o.out), { recursive: true });
    const tmp = `${o.out}.${process.pid}.tmp.mp4`;
    const graph = audioGraph(plan, 1);
    if (graph === undefined) {
      await rename(pictureFile, tmp);
      await rename(tmp, o.out);
      return { status: 'written', out: o.out, seconds: plan.seconds };
    }
    const graphFile = join(work, 'mix.txt');
    await writeFile(graphFile, graph);
    const inputs: string[] = [];
    for (const a of plan.audio) {
      const file = a.role === 'vo' || a.role === 'narration' || a.role === 'master' ? need(a.src, `${a.role === 'vo' ? `voice-over ${a.asset}` : a.role}`) : a.src;
      if (a.loop) inputs.push('-stream_loop', '-1');
      inputs.push('-i', file);
    }
    const versionText = o.versionText ?? version?.stdout ?? '';
    const { style } = await runWithFilterFile(filterFileOrder(versionText), (s) =>
      run(cmd, ['-hide_banner', '-loglevel', 'error', '-y', '-i', pictureFile, ...inputs, ...filterFileArgs(s, graphFile), '-map', '0:v', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', fmt(plan.seconds), '-movflags', '+faststart', tmp]));
    await rename(tmp, o.out);
    let lufs: number | undefined;
    try {
      lufs = parseIntegratedLufs(await run(cmd, ['-hide_banner', '-nostats', '-i', o.out, '-map', '0:a', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']));
    } catch {
      lufs = undefined;
    }
    return { status: 'written', out: o.out, seconds: plan.seconds, ...(lufs !== undefined ? { lufs } : {}), filterStyle: style };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
