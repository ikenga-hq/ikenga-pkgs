/**
 * Test helpers for the key-frame stage: WP-04's test story after breakdown,
 * sketch and bible are all approved by a person, so key frames open.
 *
 * The bible images are given files and then approved by folding a person's
 * decisions through the conformed `test-board@1` view (the same route the
 * bible stage's own tests use); nothing here writes the value itself.
 */

import type { AkukoProject } from '../../schema/akuko-project.ts';
import { AkukoProjectSchema } from '../../schema/akuko-project.ts';
import { bibleAssets, planBible, syncRefs } from '../../bible/plan.ts';
import { approve, breakdownApproved } from '../../bible/__fixtures__/project.ts';

export { approve, approveSpend, decision, fold } from '../../bible/__fixtures__/project.ts';

const NOW = '2026-11-08T10:00:00Z';

export function bibleApproved(opts: { budget?: { cap: number; currency: string } } = {}): AkukoProject {
  let p = planBible(breakdownApproved(opts), NOW).project;
  // The images "exist" (made earlier, by the bible stage's own flow); a person approves them.
  for (const a of bibleAssets(p)) {
    a.status = 'pending-review';
    a.file = { uri: `mem://assets/${a.id}.png`, mime: 'image/png', hash: `h-${a.id}` };
  }
  p = approve(p, bibleAssets(p).map((a) => a.id), 'bible').project;
  p = syncRefs(p, NOW).project;
  return AkukoProjectSchema.parse(p);
}
