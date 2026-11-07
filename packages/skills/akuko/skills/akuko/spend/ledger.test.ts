// akuko — cost ledger rules.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { AkukoProjectSchema } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { tinyProject } from '../providers/__fixtures__/fake-host.ts';
import {
  LedgerError,
  committedFromLedger,
  ledgerSummary,
  nextLedgerId,
  openEntries,
  recordDone,
  remainingBudget,
  settleEntry,
  spentFromLedger,
} from './ledger.ts';

const TS = '2026-11-07T10:00:00Z';
const base = () => ({
  ...tinyProject(),
  budget: { cap: 1, currency: 'USD', spent: 0 },
  pending_spend: [{ id: 'job1', stage: 'keyframes' as const, label: 'kf', units: ['sc1_sh1', 'sc1_sh2'], provider: 'p', estimate: 0.2, status: 'approved' as const }],
});

describe('ledger', () => {
  it('opens one submitted entry per unit, then settles each in place by id', () => {
    const { project, ids } = openEntries(base(), {
      job: 'job1', provider: 'p', model: 'm', ts: TS,
      units: [{ unit: 'sc1_sh1', estimate: 0.1 }, { unit: 'sc1_sh2', estimate: 0.1 }],
    });
    assert.deepEqual(ids, ['job1.sc1_sh1.1', 'job1.sc1_sh2.1']);
    assert.equal(ledgerSummary(project).reserved, 0.2);
    assert.equal(remainingBudget(project), 0.8);

    let p = settleEntry(project, 'job1.sc1_sh1.1', { status: 'done', actual: 0.12 });
    p = settleEntry(p, 'job1.sc1_sh2.1', { status: 'done' });
    assert.equal(p.ledger.length, 2, 'updated in place, not appended');
    assert.deepEqual(p.ledger.map((e) => e.actual), [0.12, 0.1], 'no reported actual → settles at the estimate');
    assert.ok(Math.abs((p.budget?.spent ?? 0) - 0.22) < 1e-9);
    assert.equal(ledgerSummary(p).reserved, 0);
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal(AkukoProjectSchema.safeParse(p).success, true);
  });

  it('refuses to settle twice or settle an unknown entry', () => {
    const { project } = openEntries(base(), { job: 'job1', provider: 'p', ts: TS, units: [{ unit: 'sc1_sh1', estimate: 0.1 }] });
    const p = settleEntry(project, 'job1.sc1_sh1.1', { status: 'failed' });
    assert.throws(() => settleEntry(p, 'job1.sc1_sh1.1', { status: 'done' }), LedgerError);
    assert.throws(() => settleEntry(p, 'nope', { status: 'done' }), LedgerError);
    assert.equal(p.budget?.spent, 0, 'failed entries cost nothing');
  });

  it('never reuses an id: a retry gets the next attempt number', () => {
    const { project } = openEntries(base(), { job: 'job1', provider: 'p', ts: TS, units: [{ unit: 'sc1_sh1', estimate: 0.1 }] });
    assert.equal(nextLedgerId(project, 'job1.sc1_sh1'), 'job1.sc1_sh1.2');
  });

  it('records outside spend only when a budget exists', () => {
    const p = recordDone(base(), { provider: 'manual', unit: 'sc1_sh1', actual: 0.3, ts: TS, prefix: 'j.sc1_sh1.manual' });
    assert.equal(p.budget?.spent, 0.3);
    assert.deepEqual(checkIntegrity(p), []);
    assert.throws(() => recordDone(tinyProject(), { provider: 'manual', unit: 'sc1_sh1', actual: 0.3, ts: TS, prefix: 'x' }), /setup/);
  });

  it('P5: counts the actual cost of failed and cancelled calls against the cap, outside budget.spent', () => {
    let { project: p } = openEntries(base(), { job: 'job1', provider: 'p', ts: TS, units: [{ unit: 'sc1_sh1', estimate: 0.1 }, { unit: 'sc1_sh2', estimate: 0.1 }] });
    p = settleEntry(p, 'job1.sc1_sh1.1', { status: 'failed', actual: 0.08 });
    p = settleEntry(p, 'job1.sc1_sh2.1', { status: 'cancelled', actual: 0.02 });
    const s = ledgerSummary(p);
    assert.equal(s.spent, 0);
    assert.ok(Math.abs(s.sunk - 0.1) < 1e-9);
    assert.ok(Math.abs((s.remaining ?? 0) - 0.9) < 1e-9);
    assert.ok(Math.abs(committedFromLedger(p) - 0.1) < 1e-9);
    assert.equal(p.budget?.spent, 0, 'budget.spent keeps the schema meaning (done only)');
    assert.deepEqual(checkIntegrity(p), [], 'and the WP-01 integrity check still passes');
  });

  it('agrees with the reference fixture: spent = sum of done actuals', () => {
    const fixture = AkukoProjectSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/the-beating/akuko.json', import.meta.url), 'utf8')));
    assert.ok(Math.abs(spentFromLedger(fixture) - (fixture.budget?.spent ?? -1)) < 1e-9);
    const s = ledgerSummary(fixture);
    assert.equal(s.cap, 15);
    assert.ok(Math.abs((s.remaining ?? 0) - (15 - 0.84)) < 1e-9);
  });
});
