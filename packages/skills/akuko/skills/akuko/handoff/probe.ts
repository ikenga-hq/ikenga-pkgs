/**
 * akuko — read the length of a media file, without a media library (WP-23).
 *
 * The handoff needs each file's length for two reasons: a clip must cover its shot (a clip
 * shorter than the shot is reported, never stretched or hidden), and a placed audio
 * file needs a duration on the timeline. Three container families cover what akuko stores:
 *
 *   mp4 / mov / m4a   `moov` > `mvhd` (timescale + duration); the top-level boxes are walked
 *                     with small reads, so a 500 MB clip is never loaded.
 *   wav               `sound/wav.ts` (16-bit PCM; other WAV flavours report no length).
 *   mp3               the frames are walked (MPEG-1/2/2.5, Layer III), so VBR files are exact.
 *
 * Anything else, or anything unreadable, returns no duration: the caller says so and does not guess.
 */

import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { isWav, parseWav } from '../sound/wav.ts';

export interface Probe {
  /** Seconds; undefined when the length cannot be read here. */
  durationS?: number;
  /** Audio only. */
  channels?: number;
  sampleRate?: number;
}

const u32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** Length of an ISO-BMFF file (mp4, mov, m4a) from its movie header. */
export async function probeMp4(path: string): Promise<Probe> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = new Uint8Array(16);
    let pos = 0;
    while (pos + 8 <= size) {
      await fh.read(head, 0, 16, pos);
      let boxSize = u32(head, 0);
      const type = fourcc(head, 4);
      let header = 8;
      if (boxSize === 1) {
        // 64-bit size
        boxSize = u32(head, 8) * 2 ** 32 + u32(head, 12);
        header = 16;
      } else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < header) return {};
      if (type === 'moov') {
        const body = new Uint8Array(Math.min(boxSize - header, 1 << 20));
        await fh.read(body, 0, body.length, pos + header);
        return mvhdIn(body);
      }
      pos += boxSize;
    }
    return {};
  } finally {
    await fh.close();
  }
}

function mvhdIn(moov: Uint8Array): Probe {
  let o = 0;
  while (o + 8 <= moov.length) {
    const size = u32(moov, o);
    if (size < 8) return {};
    if (fourcc(moov, o + 4) === 'mvhd') {
      const v = moov[o + 8]!;
      const base = o + 12; // after size, type, version + flags
      const timescale = v === 1 ? u32(moov, base + 16) : u32(moov, base + 8);
      const duration = v === 1 ? u32(moov, base + 20) * 2 ** 32 + u32(moov, base + 24) : u32(moov, base + 12);
      return timescale > 0 ? { durationS: duration / timescale } : {};
    }
    o += size;
  }
  return {};
}

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Length of an MP3 by walking its frames (Layer III only). */
export function probeMp3(b: Uint8Array): Probe {
  let o = 0;
  if (b.length > 10 && fourcc(b, 0).startsWith('ID3')) o = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f));
  let samples = 0;
  let rate = 0;
  let channels = 0;
  let frames = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff || (b[o + 1]! & 0xe0) !== 0xe0) {
      o++;
      continue;
    }
    const version = (b[o + 1]! >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b[o + 1]! >> 1) & 3; // 1 = Layer III
    const bi = b[o + 2]! >> 4;
    const si = (b[o + 2]! >> 2) & 3;
    const pad = (b[o + 2]! >> 1) & 1;
    if (version === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) {
      o++;
      continue;
    }
    const kbps = (version === 3 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[bi]!;
    const sr = MP3_RATES[version]![si]!;
    const spf = version === 3 ? 1152 : 576;
    const len = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / sr) + pad;
    if (len < 4) {
      o++;
      continue;
    }
    rate = sr;
    channels = ((b[o + 3]! >> 6) & 3) === 3 ? 1 : 2;
    samples += spf;
    frames++;
    o += len;
  }
  return frames > 0 && rate > 0 ? { durationS: samples / rate, channels, sampleRate: rate } : {};
}

/** Probe a file on disk, by extension; any failure is "no duration". */
export async function probeFile(path: string, read: (p: string) => Promise<Uint8Array>): Promise<Probe> {
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.mp4' || ext === '.mov' || ext === '.m4v' || ext === '.m4a') return await probeMp4(path);
    if (ext === '.wav') {
      const bytes = await read(path);
      if (!isWav(bytes)) return {};
      const w = parseWav(bytes);
      return { durationS: w.frames / w.sampleRate, channels: w.channels, sampleRate: w.sampleRate };
    }
    if (ext === '.mp3') return probeMp3(await read(path));
  } catch {
    return {};
  }
  return {};
}
