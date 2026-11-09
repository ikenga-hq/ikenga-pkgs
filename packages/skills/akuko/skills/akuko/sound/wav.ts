/**
 * akuko — minimal WAV reading and joining (WP-12). No dependencies.
 *
 * Used to (1) wrap raw PCM, (2) read a take's exact length, and (3) lay each
 * shot's voice-over on one silent narration track at the shot's start. Only
 * uncompressed 16-bit PCM is handled; anything else (mp3, m4a) is left alone,
 * and the caller says the join needs the assemble stage's tools instead.
 */

export class WavError extends Error {
  override name = 'WavError';
}

export interface Wav {
  sampleRate: number;
  channels: number;
  bits: number;
  /** Raw sample bytes. */
  pcm: Uint8Array;
  /** Rounded to the nearest ms. Compare lengths in `frames`, not this. */
  durationMs: number;
  /** Sample frames in the data. */
  frames: number;
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const tag = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

export const isWav = (b: Uint8Array): boolean => b.length >= 12 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WAVE';

/** Parse a 16-bit PCM WAV. A data chunk whose size is unset or too large (streamed files) takes the rest of the file. */
export function parseWav(b: Uint8Array): Wav {
  if (!isWav(b)) throw new WavError('not a WAV file');
  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = tag(b, o);
    let size = u32(b, o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      if (u16(b, body) !== 1) throw new WavError('only uncompressed PCM WAV is supported');
      fmt = { channels: u16(b, body + 2), sampleRate: u32(b, body + 4), bits: u16(b, body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new WavError('WAV data chunk comes before its format chunk');
      if (fmt.bits !== 16) throw new WavError(`only 16-bit WAV is supported, got ${fmt.bits}-bit`);
      if (body + size > b.length) size = b.length - body;
      const pcm = b.subarray(body, body + size);
      const frame = fmt.channels * 2;
      const frames = Math.floor(pcm.length / frame);
      return { ...fmt, pcm: pcm.subarray(0, frames * frame), durationMs: Math.round((frames / fmt.sampleRate) * 1000), frames };
    }
    o = body + size + (size % 2);
  }
  throw new WavError('WAV has no data chunk');
}

/** Write a 16-bit PCM WAV. */
export function wavBytes(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string): void => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Frames from `startMs` to `startMs + slotMs`, counted the way `mixWav` places clips (so a clip that fits here cannot overlap the next one). */
export const slotFrames = (startMs: number, slotMs: number, sampleRate: number): number =>
  Math.round(((startMs + slotMs) * sampleRate) / 1000) - Math.round((startMs * sampleRate) / 1000);

export interface Placed { startMs: number; wav: Wav }

/** True when every clip has the same sample rate and channel count, so they can share one track. */
export const sameFormat = (clips: Wav[]): boolean =>
  clips.every((c) => c.sampleRate === clips[0]!.sampleRate && c.channels === clips[0]!.channels && c.bits === clips[0]!.bits);

/**
 * One WAV, `totalMs` long at least, silent except where a clip is placed at its
 * start time. Clips must share a format and must not overlap (a clip that runs
 * into the next one is an error, never trimmed).
 */
export function mixWav(clips: Placed[], totalMs: number): Uint8Array {
  if (clips.length === 0) throw new WavError('nothing to place');
  if (!sameFormat(clips.map((c) => c.wav))) throw new WavError('the clips differ in sample rate or channels');
  const { sampleRate, channels } = clips[0]!.wav;
  const frame = channels * 2;
  const at = (msv: number): number => Math.round((msv * sampleRate) / 1000) * frame;
  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs);
  let end = at(totalMs);
  let prevEnd = 0;
  for (const c of sorted) {
    const start = at(c.startMs);
    if (start < prevEnd) throw new WavError('two clips overlap on the track');
    prevEnd = start + c.wav.pcm.length;
    end = Math.max(end, prevEnd);
  }
  const pcm = new Uint8Array(end);
  for (const c of sorted) pcm.set(c.wav.pcm, at(c.startMs));
  return wavBytes(pcm, sampleRate, channels);
}
