/**
 * Test data for the Resolve handoff (WP-23): the short-story fixture ("The Last Ferry", 11 shots, 3 scenes)
 * after key frames are approved by a person, then given a mixed set of motion and sound results,
 * written as a real project folder (small real files: a PNG, mp4s with a movie header, WAVs).
 *
 * Every `approved` here arrives the way it does everywhere else: a person's decision folded through
 * the conformed `test-board@1` view. Only non-approved states are set directly.
 *
 *   shot      video on the timeline                       what the fixture exercises
 *   sc1_sh1   clip 7 s, shot 6 s                          clip longer than the shot (cut at 6 s)
 *   sc1_sh2   clip 5 s, shot 5 s                          exact fit
 *   sc1_sh3   clip 4 s, shot 5 s                          clip shorter than the shot (gap follows, warning)
 *   sc1_sh4   clip 8 s, shot 8 s                          exact fit
 *   sc2_sh1   key frame still (its clip is pending-review) an UNAPPROVED clip is left out and listed
 *   sc2_sh2-4 key frame stills                            key frames only
 *   sc3_sh1   key frame still
 *   sc3_sh2   gap (key frame sent back)                   nothing approved
 *   sc3_sh3   key frame still
 *   voice-over: sc1_sh1 (4 s), sc1_sh2 (3 s) approved; sc1_sh3 pending-review (left out)
 *   music: film-wide bed (approved); a second, approved, with no placement (not placed)
 *   sfx: placed on sc1_sh4 (approved); a pending-review one (left out)
 *   captions: audio/vo/captions.srt and .vtt
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalHost } from '../../hosts/local.ts';
import { PNG_BYTES } from '../../providers/gemini-image/__fixtures__/mock-net.ts';
import { AkukoProjectSchema, type AkukoProject, type Asset } from '../../schema/akuko-project.ts';
import { planSound } from '../../sound/plan.ts';
import { wavBytes } from '../../sound/wav.ts';
import { planMotion } from '../../motion/plan.ts';
import { approve, keyframesApproved } from '../../sound/__fixtures__/project.ts';

const NOW = '2026-11-08T10:00:00Z';

/**
 * A small valid ISO-BMFF file: `ftyp` + `moov/mvhd` (version 0, timescale 1000) + a little `mdat`.
 * With `audio`, `moov` also holds a sound `trak` (mono, 48 kHz) so the file reads as having sound.
 */
export function miniMp4(seconds: number, audio = false): Uint8Array {
  const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
  const cc = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));
  const box = (type: string, ...body: number[][]): number[] => {
    const b = body.flat();
    return [...u32(8 + b.length), ...cc(type), ...b];
  };
  const mvhd = box('mvhd', [0, 0, 0, 0], u32(0), u32(0), u32(1000), u32(Math.round(seconds * 1000)), new Array(80).fill(0));
  const entry = box('mp4a', new Array(6).fill(0), u16(1), u16(0), u16(0), u32(0), u16(1), u16(16), u16(0), u16(0), u32(48000 * 65536));
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), entry);
  const hdlr = box('hdlr', [0, 0, 0, 0], u32(0), cc('soun'), new Array(12).fill(0), [0]);
  const trak = box('trak', box('mdia', hdlr, box('minf', box('stbl', stsd))));
  return new Uint8Array([...box('ftyp', cc('isom'), u32(512)), ...box('mdat', [1, 2, 3, 4]), ...box('moov', mvhd, audio ? trak : [])]);
}

/** A silent mono 16-bit WAV `seconds` long at 24 kHz. */
export const silentWav = (seconds: number, rate = 24000): Uint8Array => wavBytes(new Uint8Array(Math.round(seconds * rate) * 2), rate);

/** Captions as an older sync wrote them (n = 1) and as the latest sync did (`captions-2`): the export must take the latest. */
export const srt = (n = 1): string => `1
00:00:00,000 --> 00:00:02,000
${n === 1 ? 'The ferry was late.' : 'The ferry was very late.'}

`;
export const vtt = (n = 1): string => `WEBVTT

00:00:00.000 --> 00:00:02.000
${n === 1 ? 'The ferry was late.' : 'The ferry was very late.'}
`;

/** Makes the fixture's media. The unit tests use tiny placeholders; the manual check uses real, playable files. */
export interface MediaMaker {
  png(shot: string, index: number): Promise<Uint8Array>;
  mp4(shot: string, seconds: number, audio: boolean): Promise<Uint8Array>;
  wav(kind: 'vo' | 'music' | 'sfx', id: string, seconds: number): Promise<Uint8Array>;
}

export const placeholderMedia: MediaMaker = {
  png: async () => PNG_BYTES,
  mp4: async (_shot, seconds, audio) => miniMp4(seconds, audio),
  wav: async (_kind, _id, seconds) => silentWav(seconds),
};

/** Shots whose clip carries its own sound track in the fixture. */
export const CLIP_WITH_AUDIO = ['sc1_sh4'];

export interface FixtureExpectations {
  /** Shot ids in document order. */
  shots: string[];
  /** Frames per shot at 24 fps. */
  frames24: Record<string, number>;
  /** What each shot shows on the video track. */
  uses: Record<string, 'clip' | 'still' | 'gap'>;
}

export const EXPECT: FixtureExpectations = {
  shots: ['sc1_sh1', 'sc1_sh2', 'sc1_sh3', 'sc1_sh4', 'sc2_sh1', 'sc2_sh2', 'sc2_sh3', 'sc2_sh4', 'sc3_sh1', 'sc3_sh2', 'sc3_sh3'],
  frames24: { sc1_sh1: 144, sc1_sh2: 120, sc1_sh3: 120, sc1_sh4: 192, sc2_sh1: 168, sc2_sh2: 144, sc2_sh3: 144, sc2_sh4: 120, sc3_sh1: 168, sc3_sh2: 144, sc3_sh3: 192 },
  uses: { sc1_sh1: 'clip', sc1_sh2: 'clip', sc1_sh3: 'clip', sc1_sh4: 'clip', sc2_sh1: 'still', sc2_sh2: 'still', sc2_sh3: 'still', sc2_sh4: 'still', sc3_sh1: 'still', sc3_sh2: 'gap', sc3_sh3: 'still' },
};

async function put(dir: string, uri: string, data: Uint8Array | string): Promise<void> {
  const p = join(dir, ...uri.split('/'));
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, data);
}

const file = (a: Asset, uri: string, mime: string): void => {
  a.file = { uri, mime, hash: `h-${a.id}` };
};

/** Build the project in memory (statuses and file records) and the real files under `dir`. */
export async function buildExportProject(dir: string, media: MediaMaker = placeholderMedia): Promise<AkukoProject> {
  let p = keyframesApproved();

  // Key frames: real PNG files; sc3_sh2's key frame is sent back, so that shot has nothing approved.
  for (const [i, a] of p.assets.filter((x) => x.kind === 'keyframe').entries()) {
    file(a, `board/keyframes/${a.id}.png`, 'image/png');
    await put(dir, a.file!.uri, await media.png(a.owner!, i));
  }
  p.assets.find((a) => a.id === 'sc3_sh2_keyframe')!.status = 'needs-rework';

  // Motion
  p = planMotion(p, NOW).project;
  const clipSeconds: Record<string, number> = { sc1_sh1: 7, sc1_sh2: 5, sc1_sh3: 4, sc1_sh4: 8, sc2_sh1: 5 };
  for (const [shot, secs] of Object.entries(clipSeconds)) {
    const a = p.assets.find((x) => x.id === `${shot}_clip`)!;
    file(a, `motion/${shot}/${shot}_clip.mp4`, 'video/mp4');
    a.status = 'pending-review';
    await put(dir, a.file!.uri, await media.mp4(shot, secs, CLIP_WITH_AUDIO.includes(shot)));
  }
  p = approve(p, ['sc1_sh1_clip', 'sc1_sh2_clip', 'sc1_sh3_clip', 'sc1_sh4_clip'], 'motion').project;

  // Sound
  p = planSound(p, NOW, { scriptLines: 'all' }).project;
  const vo = (shot: string, secs: number): Asset => {
    const a = p.assets.find((x) => x.id === `${shot}_vo`)!;
    file(a, `audio/vo/${shot}.wav`, 'audio/wav');
    a.status = 'pending-review';
    return a;
  };
  await put(dir, vo('sc1_sh1', 4).file!.uri, await media.wav('vo', 'sc1_sh1', 4));
  await put(dir, vo('sc1_sh2', 3).file!.uri, await media.wav('vo', 'sc1_sh2', 3));
  await put(dir, vo('sc1_sh3', 2).file!.uri, await media.wav('vo', 'sc1_sh3', 2));
  const extra = (id: string, kind: 'music' | 'sfx', uri: string, tags: string[], owner?: string): void => {
    p.assets.push({
      id, kind, stage: 'sound', status: 'pending-review', comments: [], updated_at: NOW, name: id,
      tags: ['supplied', 'licence:own recording', ...tags], ...(owner ? { owner } : {}),
      file: { uri, mime: uri.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', hash: `h-${id}` },
    } as Asset);
  };
  extra('film_music_1', 'music', 'audio/music/film_music_1.wav', ['placement:film']);
  extra('scene_music_3', 'music', 'audio/music/scene_music_3.wav', ['placement:scene:sc1']);
  extra('loose_music_2', 'music', 'audio/music/loose_music_2.wav', []);
  extra('sc1_sh4_sfx_1', 'sfx', 'audio/sfx/sc1_sh4_sfx_1.wav', ['placement:shot:sc1_sh4'], 'sc1_sh4');
  extra('sc2_sfx_2', 'sfx', 'audio/sfx/sc2_sfx_2.wav', ['placement:scene:sc2']);
  await put(dir, 'audio/music/film_music_1.wav', await media.wav('music', 'film_music_1', 40));
  await put(dir, 'audio/music/scene_music_3.wav', await media.wav('music', 'scene_music_3', 40));
  await put(dir, 'audio/music/loose_music_2.wav', await media.wav('music', 'loose_music_2', 10));
  await put(dir, 'audio/sfx/sc1_sh4_sfx_1.wav', await media.wav('sfx', 'sc1_sh4_sfx_1', 1.5));
  await put(dir, 'audio/sfx/sc2_sfx_2.wav', await media.wav('sfx', 'sc2_sfx_2', 1));
  p = approve(p, ['sc1_sh1_vo', 'sc1_sh2_vo', 'film_music_1', 'scene_music_3', 'loose_music_2', 'sc1_sh4_sfx_1'], 'sound').project;

  await put(dir, 'audio/vo/captions.srt', srt());
  await put(dir, 'audio/vo/captions.vtt', vtt());
  await put(dir, 'audio/vo/captions-2.srt', srt(2));
  await put(dir, 'audio/vo/captions-2.vtt', vtt(2));

  p = AkukoProjectSchema.parse(p);
  await createLocalHost({ projectDir: dir, now: () => new Date(NOW) }).writeState(p);
  return p;
}
