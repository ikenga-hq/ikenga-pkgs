// akuko — collect's cost line reads what the ledger recorded (A-7).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tinyProject } from '../providers/__fixtures__/fake-host.ts';
import { ledgerCostLine } from './cost-line.ts';

const p = tinyProject({
  budget: { cap: 1, currency: 'USD', spent: 0.08 },
  ledger: [
    { id: 'job_a.u1.1', ts: '2026-11-09T10:00:00Z', provider: 'fal', unit: 'u1', job: 'job_a', estimate: 0.08, actual: 0.08, status: 'done' },
    { id: 'job_b.u1.1', ts: '2026-11-09T10:00:00Z', provider: 'gemini-image', unit: 'u1', job: 'job_b', estimate: 0.0336, status: 'failed' },
  ],
});

describe('ledgerCostLine', () => {
  it('prints the settled amount, and says so when the provider reported no cost', () => {
    assert.equal(ledgerCostLine(p, 'job_a', 0), 'cost 0.08 USD (estimate; provider reported no cost)');
  });
  it('prints plainly when the provider reported a cost', () => {
    assert.equal(ledgerCostLine(p, 'job_a', 0.08), 'cost 0.08 USD');
  });
  it('counts only done entries of that job', () => {
    assert.match(ledgerCostLine(p, 'job_b', 0), /^cost 0 USD/);
  });
});
