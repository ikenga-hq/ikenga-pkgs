/**
 * Test helpers for the bible stage: a project as the bible stage finds it
 * (WP-04's test story, broken down, every shot and checklist entry approved by
 * a person), and a person's decisions.
 *
 * "Approved" only ever comes from `foldDecisions()` over a decision written by
 * a person (`by: 'you'`) through a view on the conformed list (`test-board@1`,
 * the shipped board fixture's id). Nothing here writes the value itself.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyBreakdown } from '../../breakdown/apply.ts';
import { completeIntake, createProject } from '../../breakdown/intake.ts';
import { foldDecisions } from '../../decisions/fold.ts';
import { AkukoProjectSchema, type AkukoProject, type Decision, type StageId } from '../../schema/akuko-project.ts';

export const BOARD = 'test-board@1';
export const CONFORMED = [{ view: BOARD }];

const proposal = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../breakdown/__fixtures__/proposal-adapt.json', import.meta.url)), 'utf8'),
) as unknown;

let counter = 0;
let minute = 0;

/** A person's decision with a deterministic uuid and a strictly increasing time. */
export function decision(action: Decision['action'], unit: string, stage: StageId, extra: Record<string, unknown> = {}): Decision {
  counter++;
  minute++;
  const h = createHash('sha1').update(`bible-test-${counter}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const at = new Date(Date.UTC(2026, 10, 8, 9, 0, 0) + minute * 60_000).toISOString().replace('.000Z', 'Z');
  return { id, action, unit, stage, by: 'you', at, view: BOARD, ...extra } as Decision;
}

export interface Folded { project: AkukoProject; applied: string[]; rejected: { id: string; code: string; reason: string }[] }

/** Fold a person's decisions into the project, the way every action starts. */
export function fold(project: AkukoProject, ds: Decision[]): Folded {
  const r = foldDecisions(project, ds, { conformed: CONFORMED });
  return { project: r.project, applied: r.report.applied, rejected: r.report.rejected.map((x) => ({ id: x.id, code: x.code, reason: x.reason })) };
}

/** The person approves each unit (all at stage `stage`). */
export const approve = (project: AkukoProject, ids: string[], stage: StageId): Folded =>
  fold(project, ids.map((id) => decision('approve', id, stage)));

/** The person approves the amount the gate showed for a job. */
export const approveSpend = (project: AkukoProject, jobId: string, stage: StageId = 'bible'): Folded => {
  const job = project.pending_spend.find((j) => j.id === jobId);
  if (!job) throw new Error(`no pending spend ${jobId}`);
  const cur = project.budget?.currency ?? 'USD';
  return fold(project, [decision('approve-spend', jobId, stage, { text: `approve ${String(Number(job.estimate.toFixed(4)))} ${cur}` })]);
};

const T0 = () => new Date('2026-11-08T08:00:00Z');

/**
 * The test story after breakdown, with a person's approval folded for every
 * shot and every checklist entry, then the sketch stage marked approved (the
 * sketch board, WP-21, is not built yet, so it has no units for folding to
 * approve; the gating rule needs it approved before the bible opens).
 * `budget` is set only when asked for (free runs need none).
 */
export function breakdownApproved(opts: { budget?: { cap: number; currency: string } } = {}): AkukoProject {
  const intake = completeIntake(createProject({ title: 'The Last Ferry', now: T0 }), { route: 'adapt', now: T0 });
  intake.stages.intake = { state: 'approved' };
  intake.stages.breakdown = { state: 'not-started' };
  for (const a of intake.assets) a.status = 'approved';
  const applied = applyBreakdown(AkukoProjectSchema.parse(intake), proposal, { now: T0 });
  if (applied.skipped) throw new Error('fixture breakdown skipped');
  let p = applied.project;
  const ids = [...p.shots, ...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((u) => u.id);
  p = approve(p, ids, 'breakdown').project;
  p = { ...p, stages: { ...p.stages, sketch: { state: 'approved' }, bible: { state: 'not-started' } } };
  if (opts.budget) p = { ...p, budget: { cap: opts.budget.cap, currency: opts.budget.currency, spent: 0 } };
  return AkukoProjectSchema.parse(p);
}
