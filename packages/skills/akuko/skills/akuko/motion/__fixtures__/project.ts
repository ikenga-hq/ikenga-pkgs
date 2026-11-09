/**
 * Test helpers for the motion stage: WP-04's test story with every stage
 * through the key frames approved by a person, so motion opens.
 *
 * Each key frame is given a file and then approved by folding a person's
 * decision through the conformed `test-board@1` view (as the key-frame stage's
 * own tests do); nothing here writes the value itself.
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
