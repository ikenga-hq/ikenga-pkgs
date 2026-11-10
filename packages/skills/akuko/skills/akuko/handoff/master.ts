/**
 * akuko — the master-clock timeline for the Resolve handoff (WP-23b). Pure: no files are read or written here.
 *
 * A project with `audio.master` has locked audio that sets the film's timing: every `film {in_s, out_s}` is
 * seconds on that audio. The timeline is then laid out on that clock instead of end to end:
 *
 *   - the timeline starts at `audio.master.start_tc` and is as long as the master (whole frames, the master's
 *     length rounded UP to a frame, so no sound is cut);
 *   - the master WAV is on audio track A1, whole, from frame 0, never cut or moved;
 *   - each shot sits on V1 at its film time, its slot running from `film.in_s` to `film.out_s`
 *     (`round(seconds x fps)` at both ends, so shots that touch in film time touch on the timeline);
 *   - an approved card sits at its film time the same way;
 *   - the gaps between them (a scene-start pause, an unapproved shot) are gaps, not closed up.
 *
 * Picture for a shot, in order: the approved lip-sync clip (`<shot>_lipsync`), else the approved clip
 * (`<shot>_clip`), else the approved key frame as a still, else a gap listed as left out. A clip longer than the
 * slot is cut at the slot's end; a clip shorter is followed by a GAP (akuko never stretches or freezes a frame),
 * named in the notes. A still is held for the slot; if its shot has a `move`, the move runs across the slot.
 *
 * A lip-sync (WP-32) sits at its own span's film time (`lipsyncSpan`: recorded on the asset, else today's lines),
 * inside the shot's slot, in whole frames. The approved key frame holds the slot before and after it, and the
 * shot's move is NOT restarted per piece: it runs across the whole slot, and each still piece carries its share
 * (`VideoEvent.moveSpan`, written as keyframes by `fcpxml.ts`). With no approved key frame those pieces are gaps,
 * listed as left out.
 *
 * Sound in the files: only the master is laid. Voice-over, music and effects that exist are listed as
 * "covered by the master". Picture files never contribute sound (a clip made with a sound track is muted).
 */

import type { AkukoProject, Asset, Shot } from '../schema/akuko-project.ts';
import { shotUnitId } from '../schema/akuko-project.ts';
import { isKeyframe } from '../keyframes/plan.ts';
import { isClip } from '../motion/plan.ts';
import { wantedSpan } from '../lipsync/plan.ts';
import { isVo } from '../sound/plan.ts';
import { ASPECT_SIZE, ext, pad, safe, started, usable, whyNot } from './plan-shared.ts';
import type { AudioEvent, CardRow, ExportPlan, LeftOut, MasterFile, MediaFile, MoveRow, PlanInput, ShotRow, VideoEvent } from './plan.ts';
import { HandoffError, parseFps, parseTimecode, type Fps } from './timecode.ts';

/** The timeline's frame rate for a project with a master: `project.fps`, else `--fps`; a clash is an error. */
export function fpsForMasterProject(project: AkukoProject, flag: string | undefined): Fps {
  const own = project.project.fps;
  if (own === undefined) return parseFps(flag);
  const fps = parseFps(own);
  if (flag !== undefined && parseFps(flag).label !== fps.label) {
    throw new HandoffError(`The project says it is ${fps.label} fps (project.fps) but --fps ${flag} was given. Leave --fps out, or change project.fps first.`);
  }
  return fps;
}

/** `start_tc` as frames, refusing a frame number the frame rate does not have (`00:00:00:30` at 24 fps). */
export function parseStartTc(tc: string, fps: Fps): number {
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc);
  if (!m) throw new HandoffError(`audio.master.start_tc "${tc}" is not a timecode (HH:MM:SS:FF).`);
  if (Number(m[4]) >= fps.nominal) throw new HandoffError(`audio.master.start_tc "${tc}" has frame ${m[4]}, but ${fps.label} fps has only ${fps.nominal} frames a second (frames 0 to ${fps.nominal - 1}).`);
  if (Number(m[2]) > 59 || Number(m[3]) > 59) throw new HandoffError(`audio.master.start_tc "${tc}" has minutes or seconds over 59.`);
  return parseTimecode(tc, fps);
}

const num = (n: number): string => String(Number(n.toFixed(4)));

/** One line that says what a move is: used for the marker, the EDL comment and the README. */
export function moveLabel(shot: string, mv: NonNullable<Shot['move']>): string {
  return `MOVE ${shot}: scale ${num(mv.from_scale)} to ${num(mv.to_scale)}, drift x ${num(mv.x)} px, y ${num(mv.y)} px (1920x1080 frame), ease ${mv.ease ?? 'none'}`;
}

/**
 * Where a lip-sync clip sits on the master clock (WP-32). The lip-sync step records it on the asset as it starts
 * the job: `film` = the span of the audio it sent (a master slice). That record is what counts: the lines may have
 * moved since. An older lip-sync (made before the record existed), or one whose audio was a line's own clip (its
 * lead-in is not known), has none: then the span is worked out from today's lines (`lipsync/plan.ts#wantedSpan`),
 * else it fills the shot from its start, and a warning says so either way.
 */
export function lipsyncSpan(p: AkukoProject, shot: Shot, lip: Asset, warnings: string[]): { in_s: number; out_s: number } | undefined {
  if (lip.film) return lip.film;
  const today = wantedSpan(p, shot);
  if (today) {
    warnings.push(`${lip.id}: no film span is recorded on it (made before akuko recorded one, or its audio was the line's own clip), so it was placed by today's lines at ${num(today.in_s)} to ${num(today.out_s)} s. Check its lips against the master in Resolve.`);
    return today;
  }
  warnings.push(`${lip.id}: no film span is recorded on it and the shot has no spoken line on the master to place it by, so it starts at the shot's start. Check its lips against the master in Resolve.`);
  return undefined;
}

const STILL_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp']);
const isStillFile = (a: Asset): boolean => (a.file?.mime ? a.file.mime.startsWith('image/') : STILL_EXT.has(ext(a.file?.uri ?? '')));

export async function buildMasterPlan(input: PlanInput): Promise<ExportPlan> {
  const { project: p, fps } = input;
  const master = p.audio.master!;
  if (p.project.fps !== undefined && parseFps(p.project.fps).label !== fps.label) {
    throw new HandoffError(`The project says it is ${p.project.fps} fps (project.fps) but the timeline was planned at ${fps.label}.`);
  }
  const startFrames = parseStartTc(master.start_tc, fps);
  // Film times are REAL seconds on the master, so frames are counted at the real rate (24000/1001 at 23.976), not the
  // nominal 24: counting nominal frames would make a 33-minute film about 2 s too long at 23.976 (29.97 likewise).
  const rate = fps.den / fps.num;
  const exists = (uri: string): boolean => input.timelineOnly === true || input.exists(uri);
  const frameAt = (s: number): number => Math.floor(s * rate + 0.5 + 1e-9);
  const total = Math.max(1, Math.ceil(master.duration_s * rate - 1e-6));
  const [dw, dh] = ASPECT_SIZE[p.project.aspect_ratio] ?? [1920, 1080];
  const width = p.project.resolution?.w ?? dw;
  const height = p.project.resolution?.h ?? dh;

  const warnings: string[] = [];
  const leftOut: LeftOut[] = [];
  const covered: LeftOut[] = [];
  const media: MediaFile[] = [];
  let mediaN = 0;
  const addMedia = async (m: Omit<MediaFile, 'id'>, probe = true): Promise<MediaFile> => {
    const pr = input.timelineOnly || !probe ? {} : await input.probe(m.uri);
    const f: MediaFile = {
      ...m,
      id: `m${++mediaN}`,
      ...(pr.durationS !== undefined ? { durationS: pr.durationS } : {}),
      ...(pr.channels !== undefined ? { channels: pr.channels } : {}),
      ...(pr.sampleRate !== undefined ? { sampleRate: pr.sampleRate } : {}),
      ...(pr.hasAudio ? { hasAudio: true } : {}),
    };
    media.push(f);
    return f;
  };

  // ── the master ────────────────────────────────────────────────────────
  let onDisk: MasterFile = { exists: true };
  if (!input.timelineOnly) {
    onDisk = (await input.resolveMaster?.(master.uri)) ?? { exists: false };
    if (!onDisk.exists) throw new HandoffError(`The master audio is missing: ${master.uri}. A master-clock export needs it (audio.master.uri is relative to the project folder, and may go up out of it).`);
    if (onDisk.durationS !== undefined && Math.abs(onDisk.durationS - master.duration_s) * rate > 1) {
      warnings.push(`The master file is ${onDisk.durationS.toFixed(3)} s long but audio.master.duration_s says ${master.duration_s} s. The timeline follows the project's number; if the file was replaced, update the project.`);
    }
    if (onDisk.sampleRate !== undefined && onDisk.sampleRate !== master.sample_rate) {
      warnings.push(`The master file is ${onDisk.sampleRate} Hz but audio.master.sample_rate says ${master.sample_rate}.`);
    }
  }
  const linked = input.linkMaster === true && onDisk.href !== undefined;
  const masterMedia = await addMedia(
    {
      role: 'master',
      uri: master.uri,
      dest: `audio/master${ext(master.uri) || '.wav'}`,
      durationS: master.duration_s,
      sampleRate: onDisk.sampleRate ?? master.sample_rate,
      ...(onDisk.channels !== undefined ? { channels: onDisk.channels } : {}),
      ...(onDisk.src ? { src: onDisk.src } : {}),
      ...(linked ? { href: onDisk.href } : {}),
    },
    false,
  );

  // ── picture ───────────────────────────────────────────────────────────
  const clips = p.assets.filter((a) => isClip(a) && a.kind !== 'lipsync');
  const lipsyncs = p.assets.filter((a) => a.kind === 'lipsync');
  const keyframes = p.assets.filter(isKeyframe);
  const pick = (list: Asset[], shot: Shot, kind: 'clip' | 'keyframe' | 'lipsync'): Asset | undefined => list.find((a) => a.id === shotUnitId(shot.id, kind)) ?? list.find((a) => a.owner === shot.id);

  const ordered = p.shots.map((s, i) => ({ s, i })).sort((a, b) => (a.s.film?.in_s ?? Infinity) - (b.s.film?.in_s ?? Infinity) || a.i - b.i).map((x) => x.s);
  const numW = Math.max(3, String(p.shots.length).length);
  const shots: ShotRow[] = [];
  const moves: MoveRow[] = [];
  const cards: CardRow[] = [];
  const items: VideoEvent[] = [];
  const mk = (e: Omit<VideoEvent, 'n'>): void => void items.push({ ...e, n: 0 });

  /** A picture file in a slot: cut if longer, a gap after it if shorter. Returns the frames the picture covers. */
  const placeMotion = (who: string, m: MediaFile, at: number, slot: number, base: Omit<VideoEvent, 'n' | 'recIn' | 'frames' | 'srcIn' | 'kind' | 'media'>): number => {
    const avail = m.durationS !== undefined ? Math.max(0, Math.floor(m.durationS * rate + 1e-6)) : undefined;
    if (m.durationS === undefined && !input.timelineOnly) warnings.push(`${who}: the length of the file could not be read, so it was not checked against its slot (${slot} frames). If it is shorter, the end of the slot will be empty in Resolve.`);
    if (avail !== undefined && avail < slot) {
      const short = slot - avail;
      mk({ ...base, kind: 'clip', media: m, recIn: at, frames: avail, srcIn: 0, note: `${base.note ?? 'clip'} is ${short} frame${short === 1 ? '' : 's'} shorter than its slot; gap follows` });
      mk({ shot: base.shot, kind: 'gap', recIn: at + avail, frames: short, srcIn: 0, note: 'rest of the slot (the file ends early)' });
      warnings.push(`${who}: the file is ${m.durationS!.toFixed(3)} s but its slot is ${(slot / rate).toFixed(3)} s (${slot} frames); the last ${short} frame${short === 1 ? '' : 's'} are a gap. Nothing was stretched or frozen.`);
      return slot;
    }
    mk({ ...base, kind: 'clip', media: m, recIn: at, frames: slot, srcIn: 0, ...(avail !== undefined && avail > slot ? { note: `${base.note ?? 'clip'}; longer than its slot, cut at the slot's end (frame ${slot})` } : {}) });
    return slot;
  };

  let shotNo = 0;
  for (const shot of ordered) {
    const n = ++shotNo;
    if (shot.source?.removed_at !== undefined) {
      // A re-import flagged this row as gone from the sheet: never placed, even if approved material exists.
      shots.push({ n, shot: shot.id, frames: 0, recIn: 0, uses: 'removed' });
      leftOut.push({ unit: shot.id, what: 'shot', why: `removed from the sheet (${shot.source.removed_at}); not placed` });
      continue;
    }
    const lip = pick(lipsyncs, shot, 'lipsync');
    const clip = pick(clips, shot, 'clip');
    const still = pick(keyframes, shot, 'keyframe');
    if (shot.film === undefined) {
      shots.push({ n, shot: shot.id, frames: 0, recIn: 0, uses: 'no-duration' });
      leftOut.push({ unit: shot.id, what: 'shot', why: 'it has no film time (film in/out on the master), so it has no place on a master-clock timeline' });
      continue;
    }
    const inF = Math.min(frameAt(shot.film.in_s), total);
    const outF = Math.min(frameAt(shot.film.out_s), total);
    const slot = outF - inF;
    if (slot < 1) {
      shots.push({ n, shot: shot.id, frames: 0, recIn: inF, uses: 'no-duration' });
      leftOut.push({ unit: shot.id, what: 'shot', why: `its film time (${shot.film.in_s} to ${shot.film.out_s} s) is shorter than one frame at ${fps.label} fps` });
      continue;
    }
    const num3 = pad(n, numW);
    let uses: ShotRow['uses'] = 'gap';
    if (usable(lip) && exists(lip.file.uri)) {
      const m = await addMedia({ role: 'clip', asset: lip.id, shot: shot.id, uri: lip.file.uri, dest: `media/${num3}_${safe(shot.id)}_lipsync${ext(lip.file.uri)}`, ...(lip.file.mime ? { mime: lip.file.mime } : {}) });
      // WP-32: the lip-sync sits at its span's film time (recorded on the asset when it was made); the key frame
      // holds the rest of the slot, before and after, with the shot's move running on across the whole slot.
      const span = lipsyncSpan(p, shot, lip, warnings);
      let lipIn = inF;
      let lipOut = outF;
      if (span) {
        lipIn = Math.min(Math.max(frameAt(span.in_s), inF), outF);
        lipOut = Math.min(Math.max(frameAt(span.out_s), lipIn), outF);
        if (lipOut - lipIn < 1) {
          warnings.push(`${lip.id}: its span (${num(span.in_s)} to ${num(span.out_s)} s) falls outside the shot's film time (${num(shot.film.in_s)} to ${num(shot.film.out_s)} s), so it was placed at the shot's start. Check it in Resolve.`);
          lipIn = inF;
          lipOut = outF;
        }
      }
      const holds = lipIn > inF || lipOut < outF;
      const hold = holds && usable(still) && exists(still.file.uri)
        ? await addMedia({ role: 'still', asset: still.id, shot: shot.id, uri: still.file.uri, dest: `media/${num3}_${safe(shot.id)}_still${ext(still.file.uri)}`, ...(still.file.mime ? { mime: still.file.mime } : {}) })
        : undefined;
      const gaps: string[] = [];
      const piece = (from: number, to: number, side: 'before' | 'after'): void => {
        if (to <= from) return;
        if (hold) {
          mk({ shot: shot.id, kind: 'still', media: hold, recIn: from, frames: to - from, srcIn: 0, from: 'keyframe', note: `still (key frame), held ${side} the lip-sync`, ...(shot.move ? { move: shot.move, moveSpan: { at: from - inF, of: slot } } : {}) });
        } else {
          mk({ shot: shot.id, kind: 'gap', recIn: from, frames: to - from, srcIn: 0, note: `no approved key frame to hold ${side} the lip-sync` });
          gaps.push(`${side} it (${to - from} frame${to - from === 1 ? '' : 's'})`);
        }
      };
      piece(inF, lipIn, 'before');
      placeMotion(shot.id, m, lipIn, lipOut - lipIn, { shot: shot.id, from: 'lipsync', note: 'lip-sync clip' });
      piece(lipOut, outF, 'after');
      if (hold && shot.move) moves.push({ shot: shot.id, recIn: inF, frames: slot, move: shot.move, around: { recIn: lipIn, frames: lipOut - lipIn } });
      if (gaps.length) leftOut.push({ unit: still?.id ?? shotUnitId(shot.id, 'keyframe'), what: 'key frame', why: `${still ? whyNot(still, exists) : 'there is no key frame'}, so the slot around the lip-sync is a gap ${gaps.join(' and ')}` });
      uses = 'lipsync';
    } else if (usable(clip) && exists(clip.file.uri)) {
      const m = await addMedia({ role: 'clip', asset: clip.id, shot: shot.id, uri: clip.file.uri, dest: `media/${num3}_${safe(shot.id)}${ext(clip.file.uri)}`, ...(clip.file.mime ? { mime: clip.file.mime } : {}) });
      placeMotion(shot.id, m, inF, slot, { shot: shot.id, from: 'clip', note: 'clip' });
      // A clip starts on its shot's first frame. Its recorded film time (WP-32) says where the shot was when it was made.
      if (clip.film && Math.abs(frameAt(clip.film.in_s) - inF) >= 1) {
        warnings.push(`${clip.id}: made when the shot started at ${num(clip.film.in_s)} s; the shot now starts at ${num(shot.film.in_s)} s. It was placed at the shot's start; check that it still fits.`);
      }
      uses = 'clip';
    } else if (usable(still) && exists(still.file.uri)) {
      const m = await addMedia({ role: 'still', asset: still.id, shot: shot.id, uri: still.file.uri, dest: `media/${num3}_${safe(shot.id)}_still${ext(still.file.uri)}`, ...(still.file.mime ? { mime: still.file.mime } : {}) });
      mk({ shot: shot.id, kind: 'still', media: m, recIn: inF, frames: slot, srcIn: 0, from: 'keyframe', note: 'still (key frame), held for the shot', ...(shot.move ? { move: shot.move } : {}) });
      if (shot.move) moves.push({ shot: shot.id, recIn: inF, frames: slot, move: shot.move });
      uses = 'still';
    } else {
      mk({ shot: shot.id, kind: 'gap', recIn: inF, frames: slot, srcIn: 0, note: 'nothing approved for this shot' });
      leftOut.push({ unit: shot.id, what: 'shot', why: "missing: no approved lip-sync clip, clip or key frame, so a gap of the shot's length stands in" });
    }
    if (lip && uses !== 'lipsync' && started(lip)) leftOut.push({ unit: lip.id, what: 'lip-sync clip', why: whyNot(lip, exists) });
    if (clip && uses !== 'clip' && uses !== 'lipsync' && started(clip)) leftOut.push({ unit: clip.id, what: 'clip', why: whyNot(clip, exists) });
    else if (clip && uses === 'lipsync' && started(clip) && clip.status !== 'approved') leftOut.push({ unit: clip.id, what: 'clip', why: whyNot(clip, exists) });
    if (still && uses === 'gap' && started(still)) leftOut.push({ unit: still.id, what: 'key frame', why: whyNot(still, exists) });
    shots.push({ n, shot: shot.id, frames: slot, recIn: inF, uses });
  }

  // ── cards ─────────────────────────────────────────────────────────────
  for (const c of p.assets.filter((a) => a.kind === 'card')) {
    const label = c.source?.id ?? c.id;
    if (c.source?.removed_at !== undefined) {
      // A removed card keeps its film time (the schema needs one); it must not land over the row that replaced it.
      leftOut.push({ unit: c.id, what: 'card', why: `removed from the sheet (${c.source.removed_at}); not placed` });
      continue;
    }
    if (!usable(c) || !exists(c.file.uri)) {
      if (started(c)) leftOut.push({ unit: c.id, what: 'card', why: whyNot(c, exists) });
      continue;
    }
    if (c.film === undefined) {
      leftOut.push({ unit: c.id, what: 'card', why: 'it has no film time' });
      continue;
    }
    const inF = Math.min(frameAt(c.film.in_s), total);
    const outF = Math.min(frameAt(c.film.out_s), total);
    const slot = outF - inF;
    if (slot < 1) {
      leftOut.push({ unit: c.id, what: 'card', why: 'its film time is shorter than one frame' });
      continue;
    }
    // A card is picture like any other: a still card is declared and handled as a still, a video card (credits) as a clip.
    // The event keeps a `card` marker. (`id` already starts with `card_`.)
    const still = isStillFile(c);
    const m = await addMedia({ role: still ? 'still' : 'clip', asset: c.id, uri: c.file.uri, dest: `media/${safe(c.id)}${ext(c.file.uri)}`, ...(c.file.mime ? { mime: c.file.mime } : {}) });
    if (still) {
      mk({ shot: label, kind: 'still', media: m, recIn: inF, frames: slot, srcIn: 0, from: 'card', card: c.id, note: 'card (still), held for its slot' });
    } else {
      placeMotion(c.id, m, inF, slot, { shot: label, from: 'card', card: c.id, note: 'card (video)' });
    }
    cards.push({ asset: c.id, ...(c.source?.id ? { sheetId: c.source.id } : {}), recIn: inF, frames: slot });
  }

  // ── lay V1: sort, resolve any overlap, keep gaps as gaps ──────────────
  items.sort((a, b) => a.recIn - b.recIn || (a.kind === 'gap' ? -1 : 1) - (b.kind === 'gap' ? -1 : 1));
  const kept: VideoEvent[] = [];
  for (const ev of items) {
    if (ev.recIn + ev.frames > total) {
      const cut = Math.max(0, total - ev.recIn);
      warnings.push(`${ev.shot}: runs past the end of the master by ${ev.frames - cut} frame(s); cut at the end.`);
      ev.frames = cut;
      if (cut === 0) continue;
    }
    const prev = kept[kept.length - 1];
    if (prev && ev.recIn < prev.recIn + prev.frames) {
      const over = prev.recIn + prev.frames - ev.recIn;
      warnings.push(`${prev.shot} and ${ev.shot} overlap by ${over} frame${over === 1 ? '' : 's'} after rounding to frames; ${prev.shot} is shortened to end where ${ev.shot} starts.`);
      prev.frames = ev.recIn - prev.recIn;
      if (prev.frames <= 0) {
        kept.pop();
        if (prev.kind !== 'gap') leftOut.push({ unit: prev.card ?? prev.shot, what: prev.card ? 'card' : 'shot', why: `it is covered by ${ev.shot} at the same film time` });
      }
    }
    kept.push(ev);
  }
  const video: VideoEvent[] = [];
  let cursor = 0;
  let evn = 0;
  for (const ev of kept) {
    if (ev.recIn > cursor) video.push({ n: ++evn, shot: '', kind: 'gap', recIn: cursor, frames: ev.recIn - cursor, srcIn: 0, note: 'no shot at this film time' });
    video.push({ ...ev, n: ++evn });
    cursor = ev.recIn + ev.frames;
  }
  if (cursor < total) video.push({ n: ++evn, shot: '', kind: 'gap', recIn: cursor, frames: total - cursor, srcIn: 0, note: cursor === 0 ? 'no picture yet' : 'end of the master: no picture' });

  // ── audio: the master, whole, on A1 ───────────────────────────────────
  const audio: AudioEvent[] = [{ n: 1, role: 'master', media: masterMedia, recIn: 0, frames: total, srcIn: 0, track: 1, note: 'the locked master, uncut from its first sample' }];
  const soundUnits = p.assets.filter((a) => isVo(a) || (a.stage === 'sound' && (a.kind === 'music' || a.kind === 'sfx')));
  for (const a of soundUnits) {
    if (started(a)) covered.push({ unit: a.id, what: a.kind === 'music' ? 'music' : a.kind === 'sfx' ? 'sfx' : 'voice-over', why: 'covered by the master audio, which is laid whole; not placed' });
  }
  if (p.audio.narration?.audio?.uri) covered.push({ unit: 'audio.narration', what: 'narration track', why: 'covered by the master audio; not placed' });

  return {
    title: p.project.title,
    fps,
    width,
    height,
    totalFrames: total,
    startFrames,
    shots,
    video,
    audio,
    media,
    captions: [],
    notPlaced: [],
    leftOut,
    warnings,
    unchecked: input.timelineOnly === true,
    master: { startTc: master.start_tc, durationS: master.duration_s, linked, media: masterMedia },
    cards,
    moves,
    covered,
  };
}
