/**
 * Real, playable media for the manual Resolve check (`../MANUAL-CHECK.md`), so a problem the person sees is a
 * problem with the export and not with a placeholder file.
 *
 *   key frames   PNG stills made here with zlib, a different solid colour per shot
 *   clips        mp4s from `ffmpeg -f lavfi -i testsrc` with the shot id and a running timecode burned in
 *                (so a wrong cut point or a late start is visible on screen); one has a sound track
 *   audio        WAV tones: voice-over 220 Hz, music 110 Hz, effects 880 Hz, so a misplaced clip is audible
 *
 * Needs `ffmpeg` on PATH for the clips; without it `realMedia()` says so and the manual check cannot use this
 * fixture (use a real project instead). Unit tests never use this file.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { wavBytes } from '../../sound/wav.ts';
import type { MediaMaker } from './project.ts';

export const ffmpegAvailable = (): boolean => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const crcTable = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A solid-colour RGB PNG. */
export function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: Uint8Array): number[] => {
    const td = new Uint8Array([...type].map((c) => c.charCodeAt(0)).concat([...data]));
    return [...u32(data.length), ...td, ...u32(crc32(td))];
  };
  const row = new Uint8Array(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * h);
  for (let y = 0; y < h; y++) raw.set(row, y * row.length);
  const ihdr = new Uint8Array([...u32(w), ...u32(h), 8, 2, 0, 0, 0]);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', ihdr), ...chunk('IDAT', deflateSync(raw)), ...chunk('IEND', new Uint8Array())]);
}

/** A colour for shot number `i`: distinct neighbours. */
function colour(i: number): [number, number, number] {
  const h = ((i * 47) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  return [Math.round(60 + r * 150), Math.round(60 + g * 150), Math.round(60 + b * 150)];
}

function tone(hz: number, seconds: number, rate = 24000, decay = false): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 9000 * (decay ? 1 - i / n : 1)), true);
  return wavBytes(pcm, rate);
}

function fontFile(): string | undefined {
  return ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'].find((f) => existsSync(f));
}

export function realMedia(): MediaMaker {
  if (!ffmpegAvailable()) {
    throw new Error('The manual check needs real clips and ffmpeg was not found on PATH. Install ffmpeg (https://ffmpeg.org/download.html) and run this again, or run the check with a real project instead.');
  }
  const font = fontFile();
  const esc = (s: string): string => s.replace(/\\/g, '/').replace(/:/g, '\\:');
  const ff = font ? `fontfile='${esc(font)}':` : '';
  const box = 'fontcolor=white:fontsize=40:box=1:boxcolor=black@0.65:boxborderw=8';
  return {
    png: async (_shot, i) => solidPng(640, 360, colour(i)),
    mp4: async (shot, seconds, audio) => {
      const dir = await mkdtemp(join(tmpdir(), 'akuko-ffmpeg-'));
      const out = join(dir, 'clip.mp4');
      try {
        const vf = `drawtext=${ff}text='${shot}':x=24:y=24:${box},drawtext=${ff}timecode='00\\:00\\:00\\:00':rate=24:x=24:y=96:${box}`;
        const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=24:duration=${seconds}`];
        if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${seconds}`);
        args.push('-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(seconds));
        if (audio) args.push('-c:a', 'aac', '-ac', '1', '-t', String(seconds));
        args.push(out);
        const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`ffmpeg failed for ${shot}: ${r.stderr}`);
        return new Uint8Array(await readFile(out));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    wav: async (kind, _id, seconds) => tone(kind === 'vo' ? 220 : kind === 'music' ? 110 : 880, seconds, 24000, kind === 'sfx'),
  };
}
