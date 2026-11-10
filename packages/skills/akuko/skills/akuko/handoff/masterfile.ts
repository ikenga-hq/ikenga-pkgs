/**
 * akuko — read the header of the master WAV without loading it (WP-23b). The master can be hundreds of MB,
 * 24-bit or float (`sound/wav.ts` reads 16-bit PCM only), so this walks the RIFF chunk headers with small
 * reads and works out the length from the `data` chunk's size. Returns undefined for anything that is not a
 * plain RIFF/WAVE (the caller then trusts `audio.master.duration_s` and says nothing about the file).
 */

import { open } from 'node:fs/promises';

export interface WavHeader {
  durationS: number;
  sampleRate: number;
  channels: number;
  bits: number;
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const tag = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

export async function readWavHeader(path: string): Promise<WavHeader | undefined> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = new Uint8Array(12);
    await fh.read(head, 0, 12, 0);
    if (tag(head, 0) !== 'RIFF' || tag(head, 8) !== 'WAVE') return undefined;
    let fmt: { channels: number; sampleRate: number; bits: number; align: number } | undefined;
    let pos = 12;
    const ch = new Uint8Array(40);
    for (let guard = 0; guard < 200 && pos + 8 <= size; guard++) {
      await fh.read(ch, 0, 40, pos);
      const id = tag(ch, 0);
      let len = u32(ch, 4);
      if (id === 'fmt ') fmt = { channels: u16(ch, 10), sampleRate: u32(ch, 12), align: u16(ch, 20), bits: u16(ch, 22) };
      else if (id === 'data') {
        if (!fmt || fmt.align === 0 || fmt.sampleRate === 0) return undefined;
        const room = size - (pos + 8);
        if (len === 0 || len > room) len = room; // a streamed file has no size, or a too large one
        return { durationS: len / fmt.align / fmt.sampleRate, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits };
      }
      pos += 8 + len + (len % 2);
    }
    return undefined;
  } finally {
    await fh.close();
  }
}
