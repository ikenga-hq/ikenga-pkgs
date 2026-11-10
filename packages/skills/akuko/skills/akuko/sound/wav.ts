/**
 * akuko — minimal WAV reading and joining (WP-12). No dependencies.
 *
 * Used to (1) wrap raw PCM, (2) read a take's exact length, and (3) lay each
 * shot's voice-over on one silent narration track at the shot's start. Only
 * uncompressed 16-bit PCM is handled; anything else (mp3, m4a) is left alone,
 * and the caller says the join needs the assemble stage's tools instead.
 *
 * (4) The slicer (WP-28b, end of file): cut time ranges out of a WAV file of
 * any PCM depth or float, streamed, as 16-bit PCM.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

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

// ─────────────────────────────────────────────────────────────────────────
// Slicer (WP-28b): read a time range of a WAV file, streamed, and write it
// as 16-bit PCM. A master can be hundreds of MB and 24-bit; the lip-sync
// provider takes 16-bit PCM only. The file is never held in memory: it is
// read once, in chunks, hashing every byte and keeping only the bytes of the
// requested ranges.
// ─────────────────────────────────────────────────────────────────────────

/** Where a WAV file's samples lie and how they are stored. */
export interface WavLayout {
  /** The fmt chunk's format tag: 1 PCM, 3 IEEE float, 0xFFFE extensible. */
  tag: number;
  /** What the samples are: integer PCM or float (an extensible file resolved through its sub-format). */
  encoding: 'pcm' | 'float';
  channels: number;
  sampleRate: number;
  /** Bits per sample as stored (the container size). */
  bits: number;
  /** Bytes per sample frame (all channels). */
  blockAlign: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  /** Bytes of sample data (a data size that is unset or too large takes the rest of the file). */
  dataBytes: number;
  /** Whole sample frames in the data. */
  frames: number;
  fileSize: number;
}

/** True when the lip-sync provider takes the file as it is: a plain PCM (tag 1) 16-bit WAV (`parseWav`'s rule). */
export const isPcm16 = (l: Pick<WavLayout, 'tag' | 'bits'>): boolean => l.tag === 1 && l.bits === 16;

const SUB_PCM = 1;
const SUB_FLOAT = 3;

/** Read a WAV file's layout from its chunk headers only. Any PCM depth (8/16/24/32) and 32/64-bit float, plain or extensible. */
export async function readWavLayout(path: string): Promise<WavLayout> {
  const fh = await open(path, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    const at = async (pos: number, n: number): Promise<Uint8Array> => {
      const buf = new Uint8Array(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      return buf.subarray(0, bytesRead);
    };
    if (!isWav(await at(0, 12))) throw new WavError('not a WAV file');
    let fmt: Omit<WavLayout, 'dataOffset' | 'dataBytes' | 'frames' | 'fileSize'> | undefined;
    let o = 12;
    while (o + 8 <= fileSize) {
      const h = await at(o, 8);
      if (h.length < 8) break;
      const id = tag(h, 0);
      const size = u32(h, 4);
      const body = o + 8;
      if (id === 'fmt ') {
        const b = await at(body, Math.min(size, 64));
        if (b.length < 16) throw new WavError('WAV format chunk is too short');
        const t = u16(b, 0);
        const sub = t === 0xfffe && b.length >= 26 ? u16(b, 24) : t;
        const encoding = sub === SUB_PCM ? 'pcm' : sub === SUB_FLOAT ? 'float' : undefined;
        if (!encoding) throw new WavError(`WAV format ${t === 0xfffe ? `extensible/${sub}` : t} is not PCM or float; convert it first`);
        fmt = { tag: t, encoding, channels: u16(b, 2), sampleRate: u32(b, 4), blockAlign: u16(b, 12), bits: u16(b, 14) };
        if (!(fmt.channels > 0 && fmt.sampleRate > 0)) throw new WavError('WAV format chunk has no channels or no sample rate');
        const ok = encoding === 'pcm' ? [8, 16, 24, 32].includes(fmt.bits) : [32, 64].includes(fmt.bits);
        if (!ok) throw new WavError(`${fmt.bits}-bit ${encoding === 'pcm' ? 'PCM' : 'float'} WAV is not supported`);
        if (fmt.blockAlign !== fmt.channels * (fmt.bits / 8)) throw new WavError('WAV block size does not match its channels and bit depth');
      } else if (id === 'data') {
        if (!fmt) throw new WavError('WAV data chunk comes before its format chunk');
        const dataBytes = size === 0 || size === 0xffffffff || body + size > fileSize ? fileSize - body : size;
        return { ...fmt, dataOffset: body, dataBytes, frames: Math.floor(dataBytes / fmt.blockAlign), fileSize };
      }
      o = body + size + (size % 2);
    }
    throw new WavError('WAV has no data chunk');
  } finally {
    await fh.close();
  }
}

/** A range of sample frames, `[startFrame, endFrame)`. */
export interface FrameRange { startFrame: number; endFrame: number }

/** The frames `[in_s, out_s)` covers at `sampleRate`, each end rounded to the nearest frame. */
export const framesOf = (in_s: number, out_s: number, sampleRate: number): FrameRange =>
  ({ startFrame: Math.round(in_s * sampleRate), endFrame: Math.round(out_s * sampleRate) });

/**
 * Raw samples (in `l`'s layout) to 16-bit PCM, channel for channel. Integer
 * PCM keeps its top 16 bits (a 24-bit sample `s` becomes `s >> 8`: exact and
 * repeatable, no dither); 8-bit is unsigned and is centred first; float is
 * clamped to [-1, 1] and scaled by 32767.
 */
export function to16(raw: Uint8Array, l: Pick<WavLayout, 'encoding' | 'bits'>): Uint8Array {
  const bytes = l.bits / 8;
  const n = Math.floor(raw.length / bytes);
  const out = new Uint8Array(n * 2);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < n; i++) {
    const o = i * bytes;
    if (l.encoding === 'float') {
      const v = l.bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      const s = Math.round(Math.max(-1, Math.min(1, Number.isNaN(v) ? 0 : v)) * 32767);
      out[i * 2] = s & 0xff;
      out[i * 2 + 1] = (s >> 8) & 0xff;
    } else if (bytes === 1) {
      const s = (raw[o]! - 128) << 8;
      out[i * 2] = s & 0xff;
      out[i * 2 + 1] = (s >> 8) & 0xff;
    } else {
      // Little-endian: the last two bytes of a sample are its top 16 bits.
      out[i * 2] = raw[o + bytes - 2]!;
      out[i * 2 + 1] = raw[o + bytes - 1]!;
    }
  }
  return out;
}

export interface SliceResult {
  /** sha256 (hex) of the whole source file, every byte, taken in the same pass. */
  sha256: string;
  layout: WavLayout;
  /** One 16-bit PCM WAV per range (same rate and channels as the source), in the order asked. Ranges are clamped to the data. */
  slices: Array<{ range: FrameRange; wav: Uint8Array }>;
}

/**
 * Cut `ranges` out of the WAV at `path` as 16-bit PCM WAVs, streaming the
 * file once in chunks of `chunkBytes` (default 1 MiB) and keeping only the
 * bytes of the ranges (`onRead` sees each chunk's size). The whole file is hashed on the way, so the caller
 * knows exactly which file the slices came from. A file whose size changes
 * while it is read is refused.
 */
export async function sliceWavTo16(path: string, ranges: FrameRange[], opts: { chunkBytes?: number; onRead?: (bytes: number) => void } = {}): Promise<SliceResult> {
  const layout = await readWavLayout(path);
  const clamp = (f: number): number => Math.max(0, Math.min(layout.frames, f));
  const want = ranges.map((r) => {
    if (!(Number.isInteger(r.startFrame) && Number.isInteger(r.endFrame))) throw new WavError('a slice range must be whole frames');
    const range = { startFrame: clamp(r.startFrame), endFrame: clamp(r.endFrame) };
    if (range.endFrame <= range.startFrame) throw new WavError(`slice ${r.startFrame}-${r.endFrame} holds no frames of a ${layout.frames}-frame file`);
    const from = layout.dataOffset + range.startFrame * layout.blockAlign;
    const to = layout.dataOffset + range.endFrame * layout.blockAlign;
    return { range, from, to, raw: new Uint8Array(to - from) };
  });
  const h = createHash('sha256');
  let pos = 0;
  await new Promise<void>((ok, fail) => {
    createReadStream(path, { highWaterMark: opts.chunkBytes ?? 1 << 20 })
      .on('data', (c: Buffer | string) => {
        const chunk = typeof c === 'string' ? Buffer.from(c) : c;
        opts.onRead?.(chunk.length);
        h.update(chunk);
        const end = pos + chunk.length;
        for (const w of want) {
          const a = Math.max(pos, w.from);
          const b = Math.min(end, w.to);
          if (b > a) w.raw.set(chunk.subarray(a - pos, b - pos), a - w.from);
        }
        pos = end;
      })
      .on('end', () => ok())
      .on('error', fail);
  });
  if (pos !== layout.fileSize) throw new WavError(`the file changed while it was read (${layout.fileSize} bytes, then ${pos}); nothing was cut`);
  return {
    sha256: h.digest('hex'),
    layout,
    slices: want.map((w) => ({ range: w.range, wav: wavBytes(isPcm16(layout) ? w.raw : to16(w.raw, layout), layout.sampleRate, layout.channels) })),
  };
}
