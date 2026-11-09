/**
 * akuko — frame rates, whole-frame durations and timecode for the Resolve handoff (WP-23).
 *
 * The project records no frame rate, so the timeline's rate is a choice made at export
 * (`--fps`, default 24). Everything is counted in WHOLE FRAMES of the timeline's nominal
 * timebase (24 for 23.976, 30 for 29.97, 60 for 59.94). A shot's seconds are nominal film
 * seconds, so a 6 s shot is 144 frames at both 24 and 23.976.
 *
 * Rounding rule (documented in the export README):
 *   frames = round(duration_s * nominal_fps), halves round up, and a shot that has any
 *   duration at all is at least 1 frame. Each shot is rounded on its own, so the timeline's
 *   total is exactly the sum of the shots' frames.
 *
 * Timecode is non-drop-frame everywhere (EDL `FCM: NON-DROP FRAME`, FCPXML `tcFormat="NDF"`).
 * The first frame sits at 01:00:00:00, which is Resolve's default start timecode.
 */

export interface Fps {
  /** The label the person typed: `24`, `23.976`, `29.97` ... */
  label: string;
  /** Frames counted per timecode second. */
  nominal: number;
  /** Frame duration as a fraction of a second: `num/den`. */
  num: number;
  den: number;
  /** Frame rate as Resolve's FCPXML format name expects it, e.g. `24p`. */
  name: string;
}

const RATES: Fps[] = [
  { label: '23.976', nominal: 24, num: 1001, den: 24000, name: '23.976p' },
  { label: '24', nominal: 24, num: 1, den: 24, name: '24p' },
  { label: '25', nominal: 25, num: 1, den: 25, name: '25p' },
  { label: '29.97', nominal: 30, num: 1001, den: 30000, name: '29.97p' },
  { label: '30', nominal: 30, num: 1, den: 30, name: '30p' },
  { label: '50', nominal: 50, num: 1, den: 50, name: '50p' },
  { label: '59.94', nominal: 60, num: 1001, den: 60000, name: '59.94p' },
  { label: '60', nominal: 60, num: 1, den: 60, name: '60p' },
];

export const SUPPORTED_FPS = RATES.map((r) => r.label);
export const DEFAULT_FPS = '24';

export class HandoffError extends Error {
  override name = 'HandoffError';
}

export function parseFps(label: string = DEFAULT_FPS): Fps {
  const norm = label.trim().replace(/p$/i, '').replace(/^23\.98$/, '23.976').replace(/^29\.97[0-9]*$/, '29.97').replace(/^59\.94[0-9]*$/, '59.94');
  const r = RATES.find((x) => x.label === norm);
  if (!r) throw new HandoffError(`Frame rate "${label}" is not supported. Use one of: ${SUPPORTED_FPS.join(', ')}.`);
  return r;
}

/** Frames in `seconds` of film time (rule above). Zero stays zero. */
export function framesFor(seconds: number, fps: Fps): number {
  if (!(seconds > 0)) return 0;
  return Math.max(1, Math.floor(seconds * fps.nominal + 0.5 + 1e-9));
}

/** Whole frames that fit in `seconds` of media (never rounds up: a clip cannot supply frames it does not have). */
export function framesAvailable(seconds: number, fps: Fps): number {
  return Math.max(0, Math.floor(seconds * fps.nominal + 1e-6));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** `frames` as an FCPXML rational time, e.g. `144/24s` reduced to `6s`, `1001/24000s`. */
export function fcpTime(frames: number, fps: Fps): string {
  if (frames === 0) return '0s';
  const n = frames * fps.num;
  const g = gcd(n, fps.den);
  const num = n / g;
  const den = fps.den / g;
  return den === 1 ? `${num}s` : `${num}/${den}s`;
}

/** Frame duration (`frameDuration` of an FCPXML `format`). */
export const fcpFrameDuration = (fps: Fps): string => fcpTime(1, fps);

/** The first frame of every timeline: 01:00:00:00. */
export const START_FRAMES = (fps: Fps): number => 3600 * fps.nominal;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `HH:MM:SS:FF` for a frame count (non-drop). */
export function timecode(frames: number, fps: Fps): string {
  const n = fps.nominal;
  const ff = frames % n;
  const total = Math.floor(frames / n);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`;
}

/** Back from `HH:MM:SS:FF`. */
export function parseTimecode(tc: string, fps: Fps): number {
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc);
  if (!m) throw new HandoffError(`"${tc}" is not a timecode`);
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * fps.nominal + Number(m[4]);
}

/** Parse an FCPXML time string back to frames (for tests and the self-check). */
export function parseFcpTime(t: string, fps: Fps): number {
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(t);
  if (!m) throw new HandoffError(`"${t}" is not an FCPXML time`);
  const seconds = Number(m[1]) / Number(m[2] ?? 1);
  const frames = seconds / (fps.num / fps.den);
  if (Math.abs(frames - Math.round(frames)) > 1e-6) throw new HandoffError(`${t} is not a whole number of ${fps.label} frames`);
  return Math.round(frames);
}
