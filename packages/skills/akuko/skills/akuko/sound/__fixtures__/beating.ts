/**
 * The REAL short-story fixture for the sound stage: "The Beating", Poe's The
 * Tell-Tale Heart (fixtures/short-story/proposal.json: 4 scenes, 12 shots, 70 s,
 * every script line Poe's own words). Built the way the other stage fixtures are:
 * breakdown, sketch and bible approved by a person (folded decisions), then
 * key frames given files and approved, so sound opens.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyBreakdown } from '../../breakdown/apply.ts';
import { completeIntake, createProject } from '../../breakdown/intake.ts';
import { bibleAssets, planBible, syncRefs } from '../../bible/plan.ts';
import { keyframeAssets, planKeyframes } from '../../keyframes/plan.ts';
import { AkukoProjectSchema, type AkukoProject } from '../../schema/akuko-project.ts';
import { approve } from '../../keyframes/__fixtures__/project.ts';

const NOW = '2026-11-08T10:00:00Z';
const T0 = () => new Date('2026-11-08T08:00:00Z');
const proposal = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/short-story/proposal.json', import.meta.url)), 'utf8')) as unknown;

export function beatingKeyframesApproved(opts: { budget?: { cap: number; currency: string } } = {}): AkukoProject {
  const intake = completeIntake(createProject({ title: 'The Beating', now: T0 }), { route: 'adapt', now: T0 });
  intake.stages.intake = { state: 'approved' };
  intake.stages.breakdown = { state: 'not-started' };
  for (const a of intake.assets) a.status = 'approved';
  const applied = applyBreakdown(AkukoProjectSchema.parse(intake), proposal, { now: T0 });
  if (applied.skipped) throw new Error('fixture breakdown skipped');
  let p = applied.project;
  p = approve(p, [...p.shots, ...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((u) => u.id), 'breakdown').project;
  p = { ...p, stages: { ...p.stages, sketch: { state: 'approved' }, bible: { state: 'not-started' } } };
  if (opts.budget) p = { ...p, budget: { cap: opts.budget.cap, currency: opts.budget.currency, spent: 0 } };
  p = planBible(AkukoProjectSchema.parse(p), NOW).project;
  for (const a of bibleAssets(p)) {
    a.status = 'pending-review';
    a.file = { uri: `mem://assets/${a.id}.png`, mime: 'image/png', hash: `h-${a.id}` };
  }
  p = approve(p, bibleAssets(p).map((a) => a.id), 'bible').project;
  p = syncRefs(p, NOW).project;
  p = planKeyframes(AkukoProjectSchema.parse(p), NOW).project;
  for (const a of keyframeAssets(p)) {
    a.status = 'pending-review';
    a.file = { uri: `mem://assets/${a.id}.png`, mime: 'image/png', hash: `h-${a.id}` };
  }
  p = approve(p, keyframeAssets(p).map((a) => a.id), 'keyframes').project;
  return AkukoProjectSchema.parse(p);
}
