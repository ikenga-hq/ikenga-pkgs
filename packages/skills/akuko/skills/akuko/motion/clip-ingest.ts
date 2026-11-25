/**
 * akuko — two checks made when a person brings a clip back for a manual job (`ingest`).
 *
 * 1. Length. A clip made by hand need not match its shot (a tool may make 3 s at the least). The clip's length is
 *    read from its movie header (`handoff/probe.ts`, nothing decoded) and compared with the shot's `duration_s`.
 *    A clip shorter than the shot, or more than half a second longer, gets one agent comment on the clip
 *    ("Clip runs 3 s; the shot is 3.5 s: ...") and a line in the command output, so the person sees it at review.
 *    It never refuses: the person decides. Only this module's own comments (that prefix) are replaced, never a
 *    person's. The paid path already makes clips at least as long as the shot (`--fit cover`).
 *
 * 2. Sound. A clip that carries a sound track is stored as it is (the bytes are not touched). When ffmpeg is
 *    available its sound is also copied out to `<project>/sound-incoming/clip-audio/<shot>_clip-audio.wav` for the
 *    sound stage to use as effects or room tone. That WAV is a by-product file: it records no asset, moves no
 *    status, and is never written over (a later take gets `-2`, `-3`...). No ffmpeg: one line says so.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AkukoProject, Asset } from '../schema/akuko-project.ts';
import { probeMp4Bytes, type Probe } from '../handoff/probe.ts';
import { ffmpegOnPath, spawnRunner, type Runner } from '../handoff/render-moves.ts';
import { MOTION_STAGE } from './stage.ts';

export const CLIP_LENGTH_PREFIX = 'Clip runs ';
/** A clip longer than its shot by more than this is mentioned (it is cut at the shot's end). */
export const LONGER_NOTE_S = 0.5;
/** Shorter by less than this (about half a frame) counts as the same length. */
const SAME_S = 0.02;
/** Where a clip's own sound is kept, relative to the project folder. */
export const CLIP_AUDIO_DIR = 'sound-incoming/clip-audio';

const secs = (s: number): string => String(Number(s.toFixed(2)));

/** What can be read from a clip's bytes: mp4 and mov only (webm is not read here). */
export function probeClip(mime: string, data: Uint8Array): Probe {
  return mime === 'video/mp4' || mime === 'video/quicktime' ? probeMp4Bytes(data) : {};
}

/** The comment for a clip of `clipS` seconds on a shot of `shotS`, or undefined when the lengths agree well enough. */
export function clipLengthText(clipS: number, shotS: number): string | undefined {
  const head = `${CLIP_LENGTH_PREFIX}${secs(clipS)} s; the shot is ${secs(shotS)} s`;
  if (shotS - clipS > SAME_S) {
    const gap = secs(shotS - clipS);
    return `${head}: the last frame needs holding for ${gap} s at assembly (the Resolve export leaves that ${gap} s empty; akuko never stretches or freezes a clip).`;
  }
  if (clipS - shotS > LONGER_NOTE_S) return `${head}: the export uses its first ${secs(shotS)} s and cuts the last ${secs(clipS - shotS)} s.`;
  return undefined;
}

/**
 * Bring the clip's length comment in line with its current file: one agent comment while the length differs, none
 * otherwise. Returns the project (unchanged when nothing changed) and the note to print, if any.
 */
export function annotateClipLength(project: AkukoProject, clipId: string, clipS: number | undefined, ts: string): { project: AkukoProject; note?: string } {
  const a = project.assets.find((x) => x.id === clipId);
  if (!a) return { project };
  const shot = project.shots.find((s) => s.id === a.owner);
  const want = shot?.duration_s;
  const text = clipS !== undefined && want !== undefined && want > 0 ? clipLengthText(clipS, want) : undefined;
  const mine = (c: Asset['comments'][number]): boolean => c.author === 'agent' && c.text.startsWith(CLIP_LENGTH_PREFIX);
  const has = a.comments.filter(mine);
  const note = text ? `${clipId}: ${text} Make a clip that covers the shot, or change the shot's length in breakdown, if that is not what the person wants; akuko changes neither.` : undefined;
  if (has.length === (text ? 1 : 0) && (!text || has[0]!.text === text)) return { project, ...(note ? { note } : {}) };
  const next: Asset = {
    ...a,
    comments: [...a.comments.filter((c) => !mine(c)), ...(text ? [{ ts, stage: MOTION_STAGE, author: 'agent', text }] : [])],
    updated_at: ts,
  };
  return { project: { ...project, assets: project.assets.map((x) => (x.id === clipId ? next : x)) }, ...(note ? { note } : {}) };
}

export interface KeepAudioOptions {
  /** The project folder: the WAV goes under `sound-incoming/clip-audio/` in it. */
  projectDir: string;
  /** The clip file on disk (what the person brought back; it is stored unchanged). */
  source: string;
  /** ffmpeg command (default `ffmpeg`). */
  ffmpeg?: string;
  /** Default: `ffmpegOnPath()`. */
  available?: boolean;
  run?: Runner;
}

/**
 * Copy a clip's sound out to a WAV beside the project's incoming sound. Never throws: a failure is a note.
 * `path` is project-relative and `/`-separated.
 */
export async function keepClipAudio(shot: string, probe: Probe, o: KeepAudioOptions): Promise<{ path?: string; note?: string }> {
  if (!probe.hasAudio) return {};
  const cmd = o.ffmpeg ?? 'ffmpeg';
  if (!(o.available ?? ffmpegOnPath(cmd))) {
    return { note: `The clip has sound, but ffmpeg was not found, so its sound was not copied to ${CLIP_AUDIO_DIR}/ (the clip itself is stored with its sound).` };
  }
  const dir = join(o.projectDir, ...CLIP_AUDIO_DIR.split('/'));
  let name = `${shot}_clip-audio.wav`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${shot}_clip-audio-${n}.wav`;
  try {
    await mkdir(dir, { recursive: true });
    await (o.run ?? spawnRunner)(cmd, ['-hide_banner', '-loglevel', 'error', '-n', '-i', o.source, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', join(dir, name)]);
  } catch (err) {
    const why = err instanceof Error ? err.message.split(/\r?\n/).filter(Boolean).at(-1) ?? err.message : String(err);
    return { note: `The clip's sound could not be copied out (${why}); the clip itself is stored with its sound.` };
  }
  const path = `${CLIP_AUDIO_DIR}/${name}`;
  return { path, note: `Kept the clip's sound as ${path} (not an asset; for the sound stage to use as effects or room tone).` };
}
