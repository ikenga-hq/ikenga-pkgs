// akuko project schema — shape rules.
//
//   pnpm --filter @ikenga/skill-akuko test

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AkukoProjectSchema,
  DecisionSchema,
  STAGES,
  StageIdSchema,
  UnitStatusSchema,
  findUnit,
  isCanonicalShotId,
  listUnits,
} from './akuko-project.ts';
import { checkIntegrity } from './integrity.ts';
import { BeatStatusSchema } from '@ikenga/studio-schema';

const minimal = {
  format: 'akuko',
  schema_version: 1,
  project: { slug: 'tiny', title: 'Tiny', profile: 'film', created_at: '2026-11-01T00:00:00Z' },
};

const decision = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  unit: 'sc1_sh1',
  stage: 'sketch',
  by: 'you',
  at: '2026-11-06T21:12:00Z',
  view: 'default-board@0.1',
  ...over,
});

describe('AkukoProject shape', () => {
  it('a minimal document parses and fills every collection', () => {
    const p = AkukoProjectSchema.parse(minimal);
    assert.equal(p.current_stage, 'intake');
    assert.deepEqual(Object.keys(p.stages), STAGES.map((s) => s.id));
    for (const s of STAGES) assert.equal(p.stages[s.id].state, 'not-started');
    assert.deepEqual(p.shots, []);
    assert.deepEqual(p.bible, { characters: [], locations: [], styles: [] });
    assert.equal(p.budget, null);
    assert.equal(p.project.aspect_ratio, '16:9');
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('format and schema_version are literals', () => {
    assert.equal(AkukoProjectSchema.safeParse({ ...minimal, format: 'studio' }).success, false);
    assert.equal(AkukoProjectSchema.safeParse({ ...minimal, schema_version: 2 }).success, false);
  });

  it('unknown keys are rejected at the top level and inside akuko objects', () => {
    assert.equal(AkukoProjectSchema.safeParse({ ...minimal, extra_field: 1 }).success, false);
    assert.equal(
      AkukoProjectSchema.safeParse({ ...minimal, project: { ...minimal.project, colour: 'red' } }).success,
      false,
    );
    const shot = { id: 'sc1_sh1', stage: 'sketch', status: 'pending', mood: 'grim' };
    assert.equal(AkukoProjectSchema.safeParse({ ...minimal, shots: [shot] }).success, false);
  });

  it('stages must name all nine stages and nothing else', () => {
    const p = AkukoProjectSchema.parse(minimal);
    const { export: _drop, ...eight } = p.stages;
    assert.equal(AkukoProjectSchema.safeParse({ ...minimal, stages: eight }).success, false);
    assert.equal(
      AkukoProjectSchema.safeParse({ ...minimal, stages: { ...p.stages, review: { state: 'approved' } } }).success,
      false,
    );
  });

  it('stage ids are the nine pipeline stages in order 0–8', () => {
    assert.deepEqual(StageIdSchema.options, STAGES.map((s) => s.id));
    assert.deepEqual(STAGES.map((s) => s.n), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('unit status is a superset of the Studio per-rung status', () => {
    for (const s of BeatStatusSchema.options) assert.ok(UnitStatusSchema.options.includes(s), s);
    assert.ok(UnitStatusSchema.options.includes('draft'));
  });

  it('timestamps need seconds and a zone', () => {
    const at = (created_at: string) =>
      AkukoProjectSchema.safeParse({ ...minimal, project: { ...minimal.project, created_at } }).success;
    assert.equal(at('2026-11-06T21:12:00Z'), true);
    assert.equal(at('2026-11-06T21:12:00.123+01:00'), true);
    assert.equal(at('2026-11-06T21:12Z'), false);
    assert.equal(at('2026-11-06T21:12:00'), false);
    assert.equal(at('2026-11-06'), false);
  });

  it('ids must be file-name safe', () => {
    const shot = (id: string) =>
      AkukoProjectSchema.safeParse({ ...minimal, shots: [{ id, stage: 'sketch', status: 'pending' }] }).success;
    assert.equal(shot('sc2_sh3'), true);
    assert.equal(shot('hello-hifi'), true);
    assert.equal(shot('../escape'), false);
    assert.equal(shot('has space'), false);
    assert.equal(shot(''), false);
  });

  it('canonical shot ids are sc<N>_sh<M> with an optional insert letter', () => {
    assert.equal(isCanonicalShotId('sc2_sh3'), true);
    assert.equal(isCanonicalShotId('sc3_sh2A'), true);
    assert.equal(isCanonicalShotId('hello-hifi'), false);
  });

  it('money is never negative and the currency is an ISO code', () => {
    const budget = (b: unknown) => AkukoProjectSchema.safeParse({ ...minimal, budget: b }).success;
    assert.equal(budget({ cap: 15, currency: 'USD', spent: 0 }), true);
    assert.equal(budget({ cap: -1, currency: 'USD', spent: 0 }), false);
    assert.equal(budget({ cap: 15, currency: 'usd', spent: 0 }), false);
    assert.equal(budget({ cap: 15, currency: 'USD' }), false);
  });
});

describe('Decision', () => {
  it('accepts every action with its required fields', () => {
    const first = decision({ action: 'approve' });
    for (const d of [
      first,
      decision({ action: 'request-changes', text: 'Lower angle.' }),
      decision({ action: 'note', text: 'Love the light.' }),
      decision({ action: 'approve-spend', unit: 'job_kf_sc1', stage: 'keyframes' }),
      decision({ action: 'decline-spend', unit: 'job_kf_sc1', stage: 'keyframes' }),
      decision({ action: 'undo', undoes: first.id }),
    ]) {
      const r = DecisionSchema.safeParse(d);
      assert.ok(r.success, `${d.action}: ${r.success ? '' : r.error.message}`);
    }
  });

  it('request-changes and note need text; undo needs undoes', () => {
    assert.equal(DecisionSchema.safeParse(decision({ action: 'request-changes' })).success, false);
    assert.equal(DecisionSchema.safeParse(decision({ action: 'request-changes', text: '' })).success, false);
    assert.equal(DecisionSchema.safeParse(decision({ action: 'note' })).success, false);
    assert.equal(DecisionSchema.safeParse(decision({ action: 'undo' })).success, false);
  });

  it('rejects unknown actions, non-uuid ids and stray fields', () => {
    assert.equal(DecisionSchema.safeParse(decision({ action: 'auto-approve' })).success, false);
    assert.equal(DecisionSchema.safeParse(decision({ action: 'approve', id: 'not-a-uuid' })).success, false);
    assert.equal(DecisionSchema.safeParse(decision({ action: 'approve', undoes: randomUUID() })).success, false);
  });
});

describe('units and integrity', () => {
  const project = AkukoProjectSchema.parse({
    ...minimal,
    scenes: [{ id: 'sc1' }],
    shots: [{ id: 'sc1_sh1', stage: 'sketch', status: 'pending-review', scene: 'sc1', refs: ['char_a'] }],
    bible: { characters: [{ id: 'char_a', stage: 'bible', status: 'approved', name: 'A', refs: ['char_a_portrait'] }] },
    assets: [{ id: 'char_a_portrait', stage: 'bible', status: 'approved', kind: 'portrait', owner: 'char_a' }],
    budget: { cap: 10, currency: 'USD', spent: 0.12 },
    pending_spend: [{ id: 'job_1', stage: 'keyframes', label: 'Frames', units: ['sc1_sh1'], provider: 'p', estimate: 0.1, status: 'awaiting-approval' }],
    ledger: [{ ts: '2026-11-06T19:40:00Z', provider: 'p', unit: 'char_a_portrait', actual: 0.12, status: 'done' }],
  });

  it('listUnits returns shots, bible entries and assets in order', () => {
    assert.deepEqual(listUnits(project).map((u) => `${u.kind}:${u.unit.id}`), [
      'shot:sc1_sh1', 'character:char_a', 'asset:char_a_portrait',
    ]);
    assert.equal(findUnit(project, 'char_a')?.kind, 'character');
    assert.equal(findUnit(project, 'nope'), undefined);
  });

  it('a consistent project has no issues', () => {
    assert.deepEqual(checkIntegrity(project), []);
  });

  it('reports dangling references, duplicate ids and a budget that disagrees with the ledger', () => {
    const broken = structuredClone(project);
    broken.shots[0]!.scene = 'sc9';
    broken.shots[0]!.refs.push('ghost');
    broken.assets.push({ ...broken.assets[0]!, owner: 'char_a' });
    broken.ledger.push({ ts: '2026-11-06T19:41:00Z', provider: 'p', unit: 'nobody', actual: 1, status: 'done' });
    broken.decisions.push(DecisionSchema.parse(decision({ action: 'undo', unit: 'sc1_sh1', undoes: randomUUID() })));
    const paths = checkIntegrity(broken).map((i) => i.path);
    assert.deepEqual(paths, [
      'assets[1]',
      'shots[0].scene',
      'shots[0].refs[1]',
      'ledger[1].unit',
      'decisions[0].undoes',
      'budget.spent',
    ]);
  });
});
