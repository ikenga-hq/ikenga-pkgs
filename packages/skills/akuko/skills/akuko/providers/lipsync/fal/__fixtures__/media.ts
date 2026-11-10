/** Synthetic media for the lip-sync tests: real WAV and mp4 headers, no real content. */

import { wavBytes } from '../../../../sound/wav.ts';

/** A silent 16-bit mono WAV of `seconds` (low sample rate, so it stays small). */
export const silentWav = (seconds: number, rate = 8000): Uint8Array => wavBytes(new Uint8Array(Math.round(seconds * rate) * 2), rate, 1);

export const wavDataUri = (seconds: number): string => `data:audio/wav;base64,${Buffer.from(silentWav(seconds)).toString('base64')}`;

const box = (type: string, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(body, 8);
  return out;
};

/** A minimal mp4 whose movie header says `seconds` (ftyp + moov/mvhd v0, no media data). */
export function mp4Bytes(seconds: number, timescale = 1000): Uint8Array {
  const mvhd = new Uint8Array(100);
  const dv = new DataView(mvhd.buffer);
  dv.setUint32(12, timescale);
  dv.setUint32(16, Math.round(seconds * timescale));
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
  const moov = box('moov', box('mvhd', mvhd));
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}
