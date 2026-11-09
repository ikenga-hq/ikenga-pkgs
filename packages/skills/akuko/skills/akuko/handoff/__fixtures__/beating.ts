/**
 * Test data for the handoff on the second fixture, "The Beating" (`fixtures/the-beating/akuko.json`, 12 shots in 4
 * scenes, 70 s): given real files and a mixed set of approved material, written as a project folder.
 *
 *   shots 1-3   approved clips; the third is only 3.5 s long, in a 6 s shot (a gap follows)
 *   shot 4      approved clip
 *   shot 5      clip waiting for review (left out), its approved key frame is used as a still
 *   shots 6-7   key-frame stills
 *   shot 8      key frame sent back, no clip: a gap
 *   shots 9-12  key-frame stills
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG_BYTES } from '../../providers/gemini-image/__fixtures__/mock-net.ts';
import { AkukoProjectSchema, type AkukoProject, type Asset } from '../../schema/akuko-project.ts';
import { miniMp4 } from './project.ts';

const NOW = '2026-11-09T00:00:00Z';
const SOURCE = fileURLToPath(new URL('../../fixtures/the-beating/akuko.json', import.meta.url));

export async function buildBeatingProject(dir: string): Promise<AkukoProject> {
  const p = AkukoProjectSchema.parse(JSON.parse(await readFile(SOURCE, 'utf8')));
  const put = async (uri: string, data: Uint8Array): Promise<void> => {
    const f = join(dir, ...uri.split('/'));
    await mkdir(join(f, '..'), { recursive: true });
    await writeFile(f, data);
  };
  // Statuses are set directly here because this is test data for a reader of the project; nothing under test writes them.
  for (const [i, s] of p.shots.entries()) {
    const kf: Asset = { id: `${s.id}_keyframe`, kind: 'keyframe', stage: 'keyframes', status: i === 7 ? 'needs-rework' : 'approved', owner: s.id, tags: ['keyframe'], comments: [], updated_at: NOW, file: { uri: `board/keyframes/${s.id}.png`, mime: 'image/png', hash: 'x' } };
    await put(kf.file!.uri, PNG_BYTES);
    p.assets.push(kf);
    if (i < 5) {
      const clip: Asset = { id: `${s.id}_clip`, kind: 'clip', stage: 'motion', status: i === 4 ? 'pending-review' : 'approved', owner: s.id, tags: ['clip'], comments: [], updated_at: NOW, file: { uri: `motion/${s.id}/${s.id}_clip.mp4`, mime: 'video/mp4', hash: 'x' } };
      await put(clip.file!.uri, miniMp4(i === 2 ? 3.5 : (s.duration_s ?? 5) + 1));
      p.assets.push(clip);
    }
  }
  const q = AkukoProjectSchema.parse(p);
  await writeFile(join(dir, 'akuko.json'), `${JSON.stringify(q, null, 2)}\n`);
  return q;
}
