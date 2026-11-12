// The allowance gate (B-10): connected-service generations that use the person's plan allowance, not money.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { tinyProject } from '../providers/__fixtures__/fake-host.ts';
import { allowanceLine, allowanceRefusal, allowanceReply, allowanceUsed, isAllowanceApproval, recordAllowance, type AllowanceWave } from './allowance.ts';
import { ledgerSummary, spentFromLedger } from './ledger.ts';

const TS = '2026-11-12T10:00:00Z';
const wave = (n = 2): AllowanceWave => ({
  label: 'Key frames for scene 1',
  service: 'canva',
  serviceLabel: 'Canva',
  tool: 'generate-image',
  units: Array.from({ length: n }, (_, i) => ({ unit: i === 0 ? 'sc1_sh1' : 'sc1_sh2' })).slice(0, n),
});

describe('allowance gate (B-10)', () => {
  it('the line names the count, the service and that akuko cannot see the balance, and asks for an explicit OK', () => {
    const line = allowanceLine(tinyProject(), wave());
    assert.equal(
      line,
      'Allowance check — Key frames for scene 1: 2 generations with Canva (generate-image). They use your Canva plan\'s AI allowance, not money; akuko can\'t see how much of it is left. Used through akuko in this project: 0. Reply "approve 2 canva generations" to run it; anything else stops it.',
    );
    assert.equal(allowanceReply({ ...wave(), units: [{ unit: 'sc1_sh1' }] }), 'approve 1 canva generation');
  });

  it('only the exact reply approves the wave (first word any case); "go on" or another count does not', () => {
    assert.ok(isAllowanceApproval('approve 2 canva generations', wave()));
    assert.ok(isAllowanceApproval('  Approve 2 canva generations ', wave()));
    assert.equal(isAllowanceApproval('go on', wave()), false);
    assert.equal(isAllowanceApproval('approve 3 canva generations', wave()), false);
    assert.equal(isAllowanceApproval('approve 2 USD', wave()), false);
  });

  it('needs no money budget: entries cost 0, carry the units, and keep the project valid', () => {
    const p = recordAllowance(tinyProject(), { service: 'canva', tool: 'generate-image', ts: TS, units: [{ unit: 'sc1_sh1' }, { unit: 'sc1_sh2', count: 3 }] });
    assert.equal(p.budget, null);
    assert.deepEqual(p.ledger.map((e) => [e.id, e.provider, e.estimate, e.actual, e.status, e.allowance]), [
      ['allow_canva.sc1_sh1.1', 'canva', 0, 0, 'done', { service: 'canva', units: 1 }],
      ['allow_canva.sc1_sh2.1', 'canva', 0, 0, 'done', { service: 'canva', units: 3 }],
    ]);
    assert.deepEqual(checkIntegrity(AkukoProjectSchema.parse(p)), []);
    assert.equal(allowanceUsed(p, 'canva'), 4);
    assert.equal(allowanceUsed(p, 'other'), 0);
    const again = recordAllowance(p, { service: 'canva', ts: TS, units: [{ unit: 'sc1_sh1' }] });
    assert.equal(again.ledger.at(-1)!.id, 'allow_canva.sc1_sh1.2', 'a second take gets the next attempt number');
    assert.match(allowanceLine(again, wave()), /Used through akuko in this project: 5\./);
  });

  it('leaves the money untouched: spent stays 0 and the cap is not used up', () => {
    const funded = tinyProject({ budget: { cap: 10, currency: 'USD', spent: 0 } });
    const p = recordAllowance(funded, { service: 'canva', ts: TS, units: [{ unit: 'sc1_sh1' }] });
    assert.equal(spentFromLedger(p), 0);
    assert.equal(ledgerSummary(p).remaining, 10);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('a per-service cap in the budget stops a wave that would pass it, and says how many are used', () => {
    const capped: AkukoProject = tinyProject({ budget: { cap: 0, currency: 'USD', spent: 0, allowance_caps: { canva: 3 } } });
    const used = recordAllowance(capped, { service: 'canva', ts: TS, units: [{ unit: 'sc1_sh1', count: 2 }] });
    assert.equal(allowanceRefusal(used, wave(1)), null);
    assert.match(allowanceLine(used, wave(1)), /\(cap 3, 0 left after this\)\. Reply "approve 1 canva generation"/);
    const over = allowanceRefusal(used, wave(2));
    assert.match(over ?? '', /would take Canva use in this project to 4, over your cap of 3 \(2 used\)/);
    assert.match(allowanceLine(used, wave(2)), /Not run: /);
    assert.doesNotMatch(allowanceLine(used, wave(2)), /Reply "approve/);
  });

  it('integrity refuses an allowance entry that carries money, and money entries still need a budget', () => {
    const p = recordAllowance(tinyProject(), { service: 'canva', ts: TS, units: [{ unit: 'sc1_sh1' }] });
    const priced = { ...p, ledger: p.ledger.map((e) => ({ ...e, actual: 0.5 })) };
    assert.ok(checkIntegrity(priced).some((i) => /allowance entry costs no money/.test(i.message)));
    const paid = { ...p, ledger: [...p.ledger, { ts: TS, provider: 'fal', unit: 'sc1_sh2', actual: 0.08, status: 'done' as const }] };
    assert.ok(checkIntegrity(paid).some((i) => /no budget is set/.test(i.message)));
    assert.throws(() => AkukoProjectSchema.parse({ ...p, ledger: [{ ...p.ledger[0]!, allowance: { service: 'Canva', units: 1 } }] }), /lower-case/);
  });
});
