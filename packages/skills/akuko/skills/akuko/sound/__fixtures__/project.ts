/**
 * Test helpers for the sound stage: the short-story fixture ("The Last Ferry")
 * after breakdown, sketch, bible AND key frames are approved by a person, so
 * sound opens (motion is still not-started: sound does not wait for it).
 *
 * "Approved" only ever comes from folding a decision a person wrote through a
 * conformed view (`test-board@1`); nothing here writes the value itself.
 */

import type { AkukoProject } from '../../schema/akuko-project.ts';
import { AkukoProjectSchema } from '../../schema/akuko-project.ts';
import { planKeyframes, keyframeAssets } from '../../keyframes/plan.ts';
import { approve, bibleApproved } from '../../keyframes/__fixtures__/project.ts';

export { approve, approveSpend, decision, fold } from '../../keyframes/__fixtures__/project.ts';

const NOW = '2026-11-08T10:00:00Z';

export function keyframesApproved(opts: { budget?: { cap: number; currency: string } } = {}): AkukoProject {
  let p = planKeyframes(bibleApproved(opts), NOW).project;
  for (const a of keyframeAssets(p)) {
    a.status = 'pending-review';
    a.file = { uri: `mem://assets/${a.id}.png`, mime: 'image/png', hash: `h-${a.id}` };
  }
  p = approve(p, keyframeAssets(p).map((a) => a.id), 'keyframes').project;
  return AkukoProjectSchema.parse(p);
}
