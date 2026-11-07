// canApprove(): an approve-spend is bound to the amount the person was shown
// (WP-07a; spend/gate.ts). Kept out of spend/gate.test.ts on purpose.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { canApprove, confirmationLine } from '../spend/gate.ts';

const fixture = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/the-beating/akuko.json', import.meta.url), 'utf8')));
const JOB = 'job_kf_sc1';

describe('canApprove() amount binding', () => {
  it('the canonical text for the amount shown passes', () => {
    assert.equal(canApprove(fixture(), JOB, { text: 'approve 0.36 USD' }), null);
    assert.equal(canApprove(fixture(), JOB, { text: '  approve 0.36 USD — go ahead' }), null);
  });

  it('approving more than the current bound is fine; less is a stale approval', () => {
    assert.equal(canApprove(fixture(), JOB, { text: 'approve 0.5 USD' }), null);
    const p = fixture();
    p.pending_spend[0]!.estimate = 0.4125;
    const r = canApprove(p, JOB, { text: 'approve 0.36 USD' });
    assert.equal(r?.code, 'approval-mismatch');
    assert.match(r!.message, /0\.36 USD.*0\.4125 USD/);
  });

  it('approved_max is the bound when set', () => {
    const p = fixture();
    p.pending_spend[0]!.approved_max = 0.5;
    assert.equal(canApprove(p, JOB, { text: 'approve 0.36 USD' })?.code, 'approval-mismatch');
    assert.equal(canApprove(p, JOB, { text: 'approve 0.5 USD' }), null);
  });

  it('no amount, a malformed amount, or another currency is refused', () => {
    for (const text of [undefined, '', 'approve', 'yes', 'approve $0.36', 'approve 0.36', 'approve 0.36 usd', 'approve 0.36 EUR', 'approve 0.36 USDT']) {
      assert.equal(canApprove(fixture(), JOB, { text })?.code, 'approval-mismatch', String(text));
    }
  });

  it('the words match what the spend gate asks the person to reply', () => {
    const p = fixture();
    const job = { id: JOB, stage: 'keyframes' as const, kind: 'image' as const, provider: 'x', label: 'kf', items: [{ unit: 'sc1_sh1', prompt: 'p' }] };
    const line = confirmationLine(p, job as never, { amount: 0.36, currency: 'USD', per_unit: {} } as never);
    const quoted = /Reply "([^"]+)"/.exec(line)![1]!;
    assert.equal(quoted, 'approve 0.36 USD');
    assert.equal(canApprove(p, JOB, { text: quoted }), null);
  });

  it('without an approval it checks the budget only (unchanged behaviour)', () => {
    assert.equal(canApprove(fixture(), JOB), null);
    const p = fixture();
    p.budget = null;
    assert.equal(canApprove(p, JOB, { text: 'approve 0.36 USD' })?.code, 'no-budget');
    assert.equal(canApprove(fixture(), 'nope', { text: 'approve 0.36 USD' })?.code, 'unknown-job');
  });

  it('the cap still applies after the amount check', () => {
    const p = fixture();
    p.budget!.cap = 1;
    assert.equal(canApprove(p, JOB, { text: 'approve 0.36 USD' })?.code, 'over-cap');
  });
});
