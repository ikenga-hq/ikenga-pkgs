/**
 * Test helpers for the continuity audit (WP-14): the short-story fixture
 * ("The Beating", 12 shots) after every earlier stage is approved and every
 * key frame has been made and approved by a person.
 *
 * The frames are stamped with the real key-frame code (`buildKeyframeJob` then
 * `stampRefs`), so their `from:<id>@<fingerprint>` tags are exactly what a
 * real run leaves. "Approved" only ever comes from folding a person's decision.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyBreakdown } from '../../breakdown/apply.ts';
import { completeIntake, createProject } from '../../breakdown/intake.ts';
import { AkukoProjectSchema, type AkukoProject } from '../../schema/akuko-project.ts';
import { bibleAssets, planBible, syncRefs } from '../../bible/plan.ts';
import { approve } from '../../bible/__fixtures__/project.ts';
import { buildKeyframeJob, keyframeAssets, planKeyframes, stampRefs } from '../../keyframes/plan.ts';

export { approve, decision, fold } from '../../bible/__fixtures__/project.ts';

const NOW = '2026-11-08T10:00:00Z';
const T0 = () => new Date(NOW);
const proposal = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/short-story/proposal.json', import.meta.url)), 'utf8')) as unknown;

/** The short story after breakdown, the sketch stage and the bible are approved; key frames are open. */
export function shortStoryBibleApproved(): AkukoProject {
  const intake = completeIntake(createProject({ title: 'The Beating', now: T0 }), { route: 'adapt', now: T0 });
  intake.stages.intake = { state: 'approved' };
  intake.stages.breakdown = { state: 'not-started' };
  for (const a of intake.assets) a.status = 'approved';
  const applied = applyBreakdown(AkukoProjectSchema.parse(intake), proposal, { now: T0 });
  if (applied.skipped) throw new Error('short-story breakdown skipped');
  let p = applied.project;
  const ids = [...p.shots, ...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((u) => u.id);
  p = approve(p, ids, 'breakdown').project;
  p = { ...p, stages: { ...p.stages, sketch: { state: 'approved' }, bible: { state: 'not-started' } } };
  p = planBible(AkukoProjectSchema.parse(p), NOW).project;
  for (const a of bibleAssets(p)) {
    a.status = 'pending-review';
    a.file = { uri: `mem://assets/${a.id}.png`, mime: 'image/png', hash: `h-${a.id}` };
  }
  p = approve(p, bibleAssets(p).map((a) => a.id), 'bible').project;
  p = syncRefs(p, NOW).project;
  return AkukoProjectSchema.parse(p);
}

/** All 12 key frames made (one provider and model) from the approved references, and approved by a person. */
export function shortStoryKeyframesApproved(provider = 'gemini-image', model = 'model-a'): AkukoProject {
  let p = planKeyframes(shortStoryBibleApproved(), NOW).project;
  for (const a of keyframeAssets(p)) {
    const { job } = buildKeyframeJob(p, { provider, model, units: [a.id] });
    p = stampRefs(p, job);
    const x = p.assets.find((y) => y.id === a.id)!;
    x.status = 'pending-review';
    x.file = { uri: `mem://assets/${a.id}.png`, mime: 'image/png', hash: `h-${a.id}` };
    x.provider = provider;
    x.model = model;
  }
  p = approve(p, keyframeAssets(p).map((a) => a.id), 'keyframes').project;
  return AkukoProjectSchema.parse(p);
}
