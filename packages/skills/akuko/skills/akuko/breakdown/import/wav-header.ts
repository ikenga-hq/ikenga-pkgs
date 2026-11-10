/**
 * akuko — read a WAV's header only (WP-25).
 *
 * The master can be hundreds of megabytes, so this reads chunk headers with
 * small positioned reads and never loads the samples. Handles any PCM / float
 * bit depth (24-bit, 32-bit float) and WAVE_FORMAT_EXTENSIBLE; a data chunk
 * whose size is unset or runs past the end of the file takes the rest of it.
 * (`sound/wav.ts` reads a whole 16-bit file into memory, which is the wrong
 * tool here.)
 */

import { open } from 'node:fs/promises';

export interface WavHeader {
  sampleRate: number;
  channels: number;
  bits: number;
  /** Sample frames in the data chunk. */
  frames: number;
  /** `frames / sampleRate`, exact (not rounded). */
  durationS: number;
}

export class WavHeaderError extends Error {
  override name = 'WavHeaderError';
}

export async function readWavHeader(path: string): Promise<WavHeader> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (at: number, n: number): Promise<Buffer> => {
      const b = Buffer.alloc(n);
      const { bytesRead } = await fh.read(b, 0, n, at);
      return b.subarray(0, bytesRead);
    };
    const head = await read(0, 12);
    if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      throw new WavHeaderError(`${path} is not a WAV file`);
    }
    let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
    let at = 12;
    while (at + 8 <= size) {
      const h = await read(at, 8);
      if (h.length < 8) break;
      const id = h.toString('latin1', 0, 4);
      let len = h.readUInt32LE(4);
      const body = at + 8;
      if (id === 'fmt ') {
        const f = await read(body, Math.min(len, 40));
        const tag = f.readUInt16LE(0);
        if (tag !== 1 && tag !== 3 && tag !== 0xfffe) throw new WavHeaderError(`${path}: WAV format ${tag} is not PCM or float`);
        fmt = { channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), bits: f.readUInt16LE(14) };
      } else if (id === 'data') {
        if (!fmt) throw new WavHeaderError(`${path}: the data chunk comes before the format chunk`);
        if (len === 0xffffffff || body + len > size) len = size - body;
        const frameBytes = fmt.channels * (fmt.bits / 8);
        if (!(frameBytes > 0)) throw new WavHeaderError(`${path}: the format chunk is not usable`);
        const frames = Math.floor(len / frameBytes);
        return { ...fmt, frames, durationS: frames / fmt.sampleRate };
      }
      at = body + len + (len % 2);
    }
    throw new WavHeaderError(`${path}: no data chunk found`);
  } finally {
    await fh.close();
  }
}
