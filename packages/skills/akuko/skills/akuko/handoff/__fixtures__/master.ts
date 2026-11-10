/**
 * Test data for the master-clock handoff (WP-23b). Synthetic: every id and time is invented.
 *
 * A 10 s master WAV (mono, 24 kHz, silent) at 24 fps = 240 frames, two scenes, two cards:
 *
 *   film time     what                                   expected on the timeline
 *   0 - 1.0       card_S01-007 (title, approved PNG)     V1 frame 0, 24 frames
 *   1.0 - 1.5     (scene S01 starts late)                a GAP of 12 frames
 *   1.5 - 4.0     S01-010: approved lip-sync clip AND    the lip-sync clip (preferred), frame 36, 60 frames
 *                 approved clip
 *   4.0 - 6.25    S01-020: key frame approved, clip      the key frame as a still with a move, frame 96, 54 frames
 *                 waiting for review
 *   6.25 - 7.0    card_P2-CARD (pending-review)          left out: a gap of 18 frames (no shot there)
 *   7.0 - 9.0     S02-010: approved clip, 3 s, with      the clip cut to its slot, frame 168, 48 frames; its own sound is muted
 *                 its own sound track
 *   9.0 - 10.0    S02-020: nothing approved              a gap of 24 frames, listed as left out
 *   voice-over, music: approved, with files               covered by the master, not laid
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG_BYTES } from '../../providers/gemini-image/__fixtures__/mock-net.ts';
import { AkukoProjectSchema, type AkukoProject } from '../../schema/akuko-project.ts';
import { miniMp4, silentWav } from './project.ts';

const NOW = '2026-11-10T00:00:00Z';

export interface MasterFixtureOptions {
  /** `audio.master.start_tc` (default `00:00:00:00`). */
  startTc?: string;
  /** `project.fps` (default `24`). */
  fps?: string;
  /** Put the master next to the project folder (`../audio/master.wav`), the way a real project does. Default: inside it. */
  masterOutside?: boolean;
}

export interface MasterFixture {
  project: AkukoProject;
  /** The project folder. */
  dir: string;
  /** Where the master WAV is. */
  masterPath: string;
}

export async function buildMasterProject(root: string, o: MasterFixtureOptions = {}): Promise<MasterFixture> {
  const dir = join(root, 'proj');
  const put = async (path: string, data: Uint8Array): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, data);
  };
  const inProject = (uri: string): string => join(dir, ...uri.split('/'));
  const masterUri = o.masterOutside ? '../audio/master.wav' : 'audio/master.wav';
  const masterPath = o.masterOutside ? join(root, 'audio', 'master.wav') : inProject(masterUri);
  await put(masterPath, silentWav(10, 24000));

  const approved = (id: string, kind: string, stage: string, tags: string[], uri: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, kind, stage, status: 'approved', tags, comments: [], updated_at: NOW, file: { uri, mime: uri.endsWith('.png') ? 'image/png' : uri.endsWith('.wav') ? 'audio/wav' : 'video/mp4', hash: 'x' }, ...extra,
  });
  const files: Array<[string, Uint8Array]> = [
    ['cut/cards/card_S01-007.png', PNG_BYTES],
    ['motion/S01-010/S01-010_lipsync.mp4', miniMp4(2.5)],
    ['motion/S01-010/S01-010_clip.mp4', miniMp4(2.5)],
    ['board/keyframes/S01-020.png', PNG_BYTES],
    ['motion/S02-010/S02-010_clip.mp4', miniMp4(3, true)],
    ['audio/vo/S01-010_vo.wav', silentWav(1)],
    ['audio/music/bed.wav', silentWav(2)],
  ];
  for (const [uri, data] of files) await put(inProject(uri), data);

  const raw = {
    format: 'akuko',
    schema_version: 1,
    project: { slug: 'master-demo', title: 'Master Demo', profile: 'film', fps: o.fps ?? '24', created_at: '2026-11-10T00:00:00Z' },
    scenes: [
      { id: 'S01', part: 'P1', source: { kind: 'sheet', id: 'S01' } },
      { id: 'S02', part: 'P2', source: { kind: 'sheet', id: 'S02' } },
    ],
    shots: [
      { id: 'S01-010', stage: 'breakdown', status: 'pending-review', scene: 'S01', part: 'P1', source: { kind: 'sheet', id: 'S01-010', row: 3 }, film: { in_s: 1.5, out_s: 4 }, treatment: 'lipsync' },
      { id: 'S01-020', stage: 'breakdown', status: 'pending-review', scene: 'S01', part: 'P1', source: { kind: 'sheet', id: 'S01-020', row: 4 }, film: { in_s: 4, out_s: 6.25 }, treatment: 'still-move', move: { from_scale: 1, to_scale: 1.15, x: -40, y: -20, ease: 'ease-in-out' } },
      { id: 'S02-010', stage: 'breakdown', status: 'pending-review', scene: 'S02', part: 'P2', source: { kind: 'sheet', id: 'S02-010', row: 6 }, film: { in_s: 7, out_s: 9 }, treatment: 'video' },
      { id: 'S02-020', stage: 'breakdown', status: 'pending-review', scene: 'S02', part: 'P2', source: { kind: 'sheet', id: 'S02-020', row: 7 }, film: { in_s: 9, out_s: 10 }, treatment: 'still' },
    ],
    bible: {},
    assets: [
      approved('card_S01-007', 'card', 'export', [], 'cut/cards/card_S01-007.png', { name: 'Title', film: { in_s: 0, out_s: 1 }, source: { kind: 'sheet', id: 'S01-007', row: 2 } }),
      { id: 'card_P2-CARD', kind: 'card', stage: 'export', status: 'pending-review', tags: [], comments: [], name: 'Part 2 card', film: { in_s: 6.25, out_s: 7 }, source: { kind: 'sheet', id: 'P2-CARD', row: 5 }, file: { uri: 'cut/cards/card_P2-CARD.png', mime: 'image/png', hash: 'x' } },
      approved('S01-010_lipsync', 'lipsync', 'motion', ['lipsync'], 'motion/S01-010/S01-010_lipsync.mp4', { owner: 'S01-010' }),
      approved('S01-010_clip', 'clip', 'motion', ['clip'], 'motion/S01-010/S01-010_clip.mp4', { owner: 'S01-010' }),
      approved('S01-020_keyframe', 'keyframe', 'keyframes', ['keyframe'], 'board/keyframes/S01-020.png', { owner: 'S01-020' }),
      { id: 'S01-020_clip', kind: 'clip', stage: 'motion', status: 'pending-review', owner: 'S01-020', tags: ['clip'], comments: [], file: { uri: 'motion/S01-020/S01-020_clip.mp4', mime: 'video/mp4', hash: 'x' } },
      approved('S02-010_clip', 'clip', 'motion', ['clip'], 'motion/S02-010/S02-010_clip.mp4', { owner: 'S02-010' }),
      { id: 'S02-020_keyframe', kind: 'keyframe', stage: 'keyframes', status: 'pending-review', owner: 'S02-020', tags: ['keyframe'], comments: [] },
      approved('S01-010_vo', 'vo', 'sound', ['vo'], 'audio/vo/S01-010_vo.wav', { owner: 'S01-010' }),
      approved('bed', 'music', 'sound', ['placement:film'], 'audio/music/bed.wav'),
    ],
    audio: { master: { uri: masterUri, duration_s: 10, sample_rate: 24000, start_tc: o.startTc ?? '00:00:00:00' } },
  };
  const project = AkukoProjectSchema.parse(raw);
  return { project, dir, masterPath };
}
