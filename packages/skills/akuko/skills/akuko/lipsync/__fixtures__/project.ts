// WP-28b — a synthetic real-project for the lip-sync step, written to a temp
// folder with real files: a 24-bit master WAV, a 16-bit line clip and key
// frames. Every id, time, name, word and byte is invented; nothing comes from
// a real production.

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serializeProject } from '../../hosts/local.ts';
import { AkukoProjectSchema, type AkukoProject, type AkukoProjectInput } from '../../schema/akuko-project.ts';
import { sha256Bytes } from '../../rules/refs.ts';
import { wavBytes } from '../../sound/wav.ts';

export const T0 = '2026-11-10T09:00:00Z';
/** Sample rate of every synthetic WAV (low, so the files stay small). */
export const RATE = 8000;
/** The master's length, seconds. */
export const MASTER_S = 30;

/** A deterministic 24-bit sample for frame `i`, channel `c`: covers the whole signed range, so a bad shift shows. */
export const sample24 = (i: number, c = 0): number => (((i * 2654435761 + c * 40503) >>> 0) % 16777216) - 8388608;

/**
 * A 24-bit PCM WAV with `frames` frames of `sample24`. `extra` puts a LIST
 * chunk (odd length, so it is padded) between fmt and data, as editors do.
 */
export function wav24(frames: number, opts: { rate?: number; channels?: number; extensible?: boolean; extra?: boolean } = {}): Uint8Array {
  const rate = opts.rate ?? RATE;
  const ch = opts.channels ?? 1;
  const fmtLen = opts.extensible ? 40 : 16;
  const list = opts.extra ? new TextEncoder().encode('INFOISFT\u0005\u0000\u0000\u0000akuko') : new Uint8Array(0); // 17 bytes, odd
  const listChunk = opts.extra ? 8 + list.length + (list.length % 2) : 0;
  const data = frames * ch * 3;
  const out = new Uint8Array(12 + 8 + fmtLen + listChunk + 8 + data);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string): void => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, out.length - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, fmtLen, true);
  v.setUint16(20, opts.extensible ? 0xfffe : 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * 3, true); v.setUint16(32, ch * 3, true); v.setUint16(34, 24, true);
  if (opts.extensible) { v.setUint16(36, 22, true); v.setUint16(38, 24, true); v.setUint32(40, ch === 1 ? 4 : 3, true); v.setUint16(44, 1, true); }
  let o = 20 + fmtLen;
  if (opts.extra) { put(o, 'LIST'); v.setUint32(o + 4, list.length, true); out.set(list, o + 8); o += listChunk; }
  put(o, 'data'); v.setUint32(o + 4, data, true);
  o += 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const s = sample24(i, c) & 0xffffff;
      out[o++] = s & 0xff; out[o++] = (s >> 8) & 0xff; out[o++] = (s >> 16) & 0xff;
    }
  }
  return out;
}

/** A 16-bit mono WAV of `seconds` with a recognisable ramp; `mark` tells copies apart. */
export function wav16(seconds: number, mark = 1): Uint8Array {
  const n = Math.round(seconds * RATE);
  const pcm = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { pcm[i * 2] = (i + mark) & 0xff; pcm[i * 2 + 1] = (i >> 8) & 0x7f; }
  return wavBytes(pcm, RATE, 1);
}

const png = (label: string): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`synthetic key frame ${label}`)]);

export const SHOTS = ['S02-010', 'S02-020', 'S02-030', 'S02-040', 'S03-010', 'S03-020'] as const;

/** The files written into the project folder, by role. Paths are relative to it. */
export function files(opts: { clipOutside?: boolean } = {}): Record<string, { path: string; data: Uint8Array }> {
  const out: Record<string, { path: string; data: Uint8Array }> = {
    master: { path: 'audio/master.wav', data: wav24(MASTER_S * RATE, { extra: true }) },
    clip: { path: opts.clipOutside ? '../media/clips/L02.wav' : 'clips/L02.wav', data: wav16(2.45, 7) },
  };
  for (const s of SHOTS) out[`kf_${s}`] = { path: `board/panels/${s}_keyframe.png`, data: png(s) };
  return out;
}

const shot = (id: string, scene: string, part: string, in_s: number, out_s: number, extra: Record<string, unknown>) => ({
  id, stage: 'breakdown', status: 'approved', scene, part, refs: ['ADA'], prompt: `Invented shot ${id}, painterly look.`,
  film: { in_s, out_s }, duration_s: out_s - in_s, source: { kind: 'sheet', id }, tier: 'A', ...extra,
});

/**
 * Six shots on a 30 s master:
 *   S02-010 lipsync, one spoken line (no clip: cut from the master)
 *   S02-020 video,   one spoken line with its own 16-bit clip
 *   S02-030 lipsync, a thought line only (nothing to sync)
 *   S02-040 still,   a spoken line (a still never gets a lip-sync)
 *   S03-010 lipsync, two spoken lines (one master span)
 *   S03-020 lipsync, removed from the sheet
 */
export function lipsyncProject(f = files(), over: Partial<AkukoProjectInput> = {}): AkukoProject {
  const H = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, sha256Bytes(v.data)]));
  const approved = { state: 'approved' };
  return AkukoProjectSchema.parse({
    format: 'akuko',
    schema_version: 1,
    project: { slug: 'lipsync-demo', title: 'Lip-sync Demo', profile: 'film', created_at: T0, aspect_ratio: '16:9' },
    current_stage: 'motion',
    stages: {
      intake: approved, breakdown: approved, sketch: approved, bible: approved, keyframes: approved,
      motion: { state: 'not-started' }, sound: { state: 'locked' }, assemble: { state: 'locked' }, export: { state: 'locked' },
    },
    scenes: [{ id: 'S02', part: 'P2' }, { id: 'S03', part: 'P3' }],
    shots: [
      shot('S02-010', 'S02', 'P2', 0, 4, { treatment: 'lipsync', lines: [{ id: 'L01', kind: 'spoken' }] }),
      shot('S02-020', 'S02', 'P2', 4, 9, { treatment: 'video', lines: [{ id: 'L02', kind: 'spoken' }] }),
      shot('S02-030', 'S02', 'P2', 9, 14, { treatment: 'lipsync', lines: [{ id: 'L03', kind: 'thought' }] }),
      shot('S02-040', 'S02', 'P2', 14, 20, { treatment: 'still', tier: 'C', lines: [{ id: 'L04', kind: 'spoken' }] }),
      shot('S03-010', 'S03', 'P3', 20, 28, { treatment: 'lipsync', lines: [{ id: 'L05', kind: 'spoken' }, { id: 'L06', kind: 'spoken' }] }),
      shot('S03-020', 'S03', 'P3', 28, 30, { treatment: 'lipsync', lines: [{ id: 'L07', kind: 'spoken' }], source: { kind: 'sheet', id: 'S03-020', removed_at: T0 } }),
    ],
    bible: { characters: [{ id: 'ADA', stage: 'bible', status: 'approved', name: 'Ada (invented)' }], locations: [], styles: [] },
    assets: SHOTS.map((s) => ({
      id: `${s}_keyframe`, kind: 'keyframe', stage: 'keyframes', status: 'approved', owner: s, tags: ['keyframe'],
      file: { uri: f[`kf_${s}`]!.path, mime: 'image/png', hash: H[`kf_${s}`] },
    })),
    audio: {
      master: { uri: f.master!.path, duration_s: MASTER_S, sample_rate: RATE, start_tc: '00:00:00:00' },
      lines: [
        { id: 'L01', character: 'ADA', kind: 'spoken', film_in_s: 1.0, film_out_s: 2.5, text: 'Bring the lamp closer.' },
        { id: 'L02', character: 'ADA', kind: 'spoken', film_in_s: 5.0, film_out_s: 7.0, text: 'Not yet.', clip_uri: f.clip!.path },
        { id: 'L03', character: 'ADA', kind: 'thought', film_in_s: 10.0, film_out_s: 12.0, text: 'She never came back.' },
        { id: 'L04', character: 'ADA', kind: 'spoken', film_in_s: 15.0, film_out_s: 16.0, text: 'Here.' },
        { id: 'L05', character: 'ADA', kind: 'spoken', film_in_s: 20.5, film_out_s: 22.0, text: 'Over there.' },
        { id: 'L06', character: 'ADA', kind: 'spoken', film_in_s: 24.0, film_out_s: 26.0, text: 'By the water.' },
        { id: 'L07', character: 'ADA', kind: 'spoken', film_in_s: 28.2, film_out_s: 29.0, text: 'Gone.' },
      ],
    },
    budget: { cap: 5, currency: 'USD', spent: 0 },
    ...over,
  });
}

/** House rules that allow the master's slices, the line clip and the key frames (by content hash). */
export function allowRules(f = files(), extra: Record<string, unknown> = {}): AkukoProjectInput['rules'] {
  const H = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, sha256Bytes(v.data)]));
  return {
    banned: [{ term: 'zorbex', note: 'an invented brand' }],
    uploads: {
      allow: [
        { sha256: H.master!, label: 'Master mix (invented)', slices: true },
        { sha256: H.clip!, label: 'Line clip L02 (invented)' },
        ...SHOTS.map((s) => ({ sha256: H[`kf_${s}`]!, label: `Key frame ${s}` })),
      ],
    },
    ...extra,
  } as AkukoProjectInput['rules'];
}

/** Write the project and its files to a fresh temp folder (`<base>/project`; a clip outside it goes to `<base>/media`). */
export async function lipsyncFolder(opts: { clipOutside?: boolean; mutate?: (p: AkukoProject) => void; rules?: boolean } = {}): Promise<{ base: string; dir: string; project: AkukoProject; files: ReturnType<typeof files> }> {
  const base = await mkdtemp(join(tmpdir(), 'akuko-lipsync-'));
  const dir = join(base, 'project');
  const f = files(opts);
  for (const x of Object.values(f)) {
    await mkdir(dirname(join(dir, x.path)), { recursive: true });
    await writeFile(join(dir, x.path), x.data);
  }
  const project = lipsyncProject(f, opts.rules ? { rules: allowRules(f) } : {});
  opts.mutate?.(project);
  await writeFile(join(dir, 'akuko.json'), serializeProject(AkukoProjectSchema.parse(project)));
  return { base, dir, project: AkukoProjectSchema.parse(project), files: f };
}

export const readProject = async (dir: string): Promise<AkukoProject> => AkukoProjectSchema.parse(JSON.parse(await readFile(join(dir, 'akuko.json'), 'utf8')));
export const writeProject = async (dir: string, p: AkukoProject): Promise<void> => writeFile(join(dir, 'akuko.json'), serializeProject(AkukoProjectSchema.parse(p)));
