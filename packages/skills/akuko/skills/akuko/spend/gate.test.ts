// akuko — spend gate (G-ADAPTER): no code path reaches a provider's submit()
// without estimate() + an approved pending spend + a recorded budget cap.
//
//   pnpm --filter @ikenga/skill-akuko test

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { AkukoProject, Budget, PendingSpend } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import type { Job, JobHandle, ProviderImpl } from '../providers/contract.ts';
import { parseProviderConfig } from '../providers/config.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createFakeHost, tinyProject } from '../providers/__fixtures__/fake-host.ts';
import {
  SETUP_POINTER,
  SpendGateBypassError,
  MANUAL_SEAL,
  SpendGateError,
  canApprove,
  confirmationLine,
  createSpendGate,
  sealProvider,
} from './gate.ts';
import { FAKE_PAID_ID, FAKE_PRICE, createFakePaid, testConfig } from './__fixtures__/fake-paid.ts';

const NOW = '2026-11-07T10:00:00Z';
const JOB_ID = 'job_kf_sc1';

const job = (over: Partial<Job> = {}): Job => ({
  id: JOB_ID,
  stage: 'keyframes',
  kind: 'image',
  provider: FAKE_PAID_ID,
  label: 'Key frames for scene 1',
  items: [
    { unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe' },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'keyframe' },
  ],
  ...over,
});
const ESTIMATE = 2 * FAKE_PRICE;

const budget = (cap = 10, spent = 0): Budget => ({ cap, currency: 'USD', spent });

const pending = (status: PendingSpend['status'], over: Partial<PendingSpend> = {}): PendingSpend => ({
  id: JOB_ID,
  stage: 'keyframes',
  label: 'Key frames for scene 1',
  units: ['sc1_sh1', 'sc1_sh2'],
  provider: FAKE_PAID_ID,
  estimate: ESTIMATE,
  status,
  ...over,
});

function setup(p: AkukoProject, opts: Parameters<typeof createFakePaid>[1] & { level?: 'A' | 'B' | 'C' } = {}) {
  const host = createFakeHost(p);
  const fake = createFakePaid(host, opts);
  const gate = createSpendGate({ host, providers: [fake.provider], level: opts.level ?? 'B', now: () => NOW });
  return { host, fake, gate };
}

const submits = (log: string[]) => log.filter((l) => l.startsWith('submit:')).length;

// ─────────────────────────────────────────────────────────────────────────
// 1. Static: gate.ts is the only caller of submit()
// ─────────────────────────────────────────────────────────────────────────

const AKUKO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every non-test .ts file under the skill, fixtures included (P7). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (code: string): string =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '');

/**
 * Lines that touch the word `submit` in any way other than declaring a
 * method named submit (an object-literal method or an interface member).
 * Catches `.submit(`, `.submit.call/.apply/.bind`, `const { submit } = …`,
 * `x['submit']`, `Reflect.get(x, 'submit')`, `const s = x.submit` …
 */
function submitTouches(code: string): string[] {
  return stripComments(code)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\bsubmit\b/.test(l))
    .filter((l) => {
      // A bare declaration is exempt only if nothing after the name touches `submit` again,
      // so a one-line wrapper like `async submit(job) { return impl.submit(job); }` is caught.
      const decl = /^(async\s+)?submit\s*\(/.exec(l);
      return !decl || /\bsubmit\b/.test(l.slice(decl[0].length));
    });
}

/** The only lines allowed to touch `submit`, per file. */
const ALLOWED_SUBMIT_LINES: Record<string, string[]> = {
  'spend/gate.ts': [
    'submit: async (job: Job): Promise<JobHandle> => {',   // the sealed wrapper itself
    'return impl.submit(job);',                             // the wrapper, after the ticket check
    'handle = await provider.submit(mintTicket(job));',     // run(), after prepare()
  ],
  'spend/__fixtures__/fake-paid.ts': ['log.push(`submit:${job.id}`);'], // a log label, not a call
};

describe('structural guarantee: submit() is reachable only through gate.run()', () => {
  it('the scanner catches every way of reaching submit (P7)', () => {
    const sneaky = [
      'impl.submit(job);',
      'impl.submit.call(impl, job);',
      'p.submit.apply(p, [job]);',
      'const go = impl.submit.bind(impl);',
      'const { submit } = impl;',
      'const { estimate, submit: s } = provider;',
      "impl['submit'](job);",
      'impl[`submit`](job);',
      "Reflect.get(impl, 'submit')(job);",
      "Reflect.apply(impl.submit, impl, [job]);",
      'const s = provider.submit;',
      'await provider.submit (job);',
      'async submit(job) { return impl.submit(job); }',
      'submit(job) { return other.submit(job); }',
    ];
    for (const line of sneaky) assert.deepEqual(submitTouches(line), [line.trim()], line);
    for (const ok of ['async submit(job) {', 'submit(job: Job): Promise<JobHandle>;', "status: 'submitted'", '// provider.submit(job)', '/* impl.submit(x) */']) {
      assert.deepEqual(submitTouches(ok), [], ok);
    }
  });

  it('no non-test source file, fixtures included, touches submit outside the allow-listed lines', () => {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles(AKUKO_ROOT)) {
      const rel = relative(AKUKO_ROOT, file).split(sep).join('/');
      const touches = submitTouches(readFileSync(file, 'utf8'));
      if (touches.length) found[rel] = touches;
    }
    assert.ok(Object.keys(found).some((f) => f.startsWith('spend/__fixtures__/')), 'fixtures are scanned');
    assert.deepEqual(found, ALLOWED_SUBMIT_LINES);
  });

  it('only providers/manual/index.ts uses the manual seal key (P8)', () => {
    const users = sourceFiles(AKUKO_ROOT)
      .filter((f) => /\bMANUAL_SEAL\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(AKUKO_ROOT, f).split(sep).join('/'))
      .sort();
    assert.deepEqual(users, ['providers/manual/index.ts', 'spend/gate.ts']);
  });

  it('in gate.ts, submit() runs only after prepare() has estimated, checked and reserved — on the snapshot', () => {
    const code = readFileSync(new URL('./gate.ts', import.meta.url), 'utf8');
    const calls = [...code.matchAll(/(\w+)\.submit\s*\(/g)].map((m) => m[1]);
    assert.deepEqual(calls, ['impl', 'provider']);
    const slice = (from: string, to: string) => {
      const a = code.indexOf(from);
      const b = code.indexOf(to, a);
      assert.ok(a >= 0 && b > a, `${from} … ${to}`);
      return code.slice(a, b);
    };
    const prepare = slice('async function prepare(', 'async function run(');
    const at = (s: string, i = prepare.indexOf(s)) => (assert.ok(i >= 0, `prepare() contains ${s}`), i);
    const estimateAt = at('await estimate(provider, job)');
    assert.ok(estimateAt < at("refuse('no-budget'"), 'estimate before the budget check');
    // checkPaid may take the phase flag (host A send, lib/spend.md R-11) after `entry`.
    assert.ok(at("refuse('no-budget'") < at('checkPaid(p, job, cost, p.budget, entry'), 'budget before approval + cap');
    assert.ok(at('checkPaid(p, job, cost, p.budget, entry') < at('openEntries('), 'approval + cap before the reservation');
    assert.ok(at('openEntries(') < at('await host.writeState(p)'), 'the reservation is written');

    const run = slice('async function run(', 'async function collect(');
    const r = (s: string) => {
      const i = run.indexOf(s);
      assert.ok(i >= 0, `run() contains ${s}`);
      return i;
    };
    assert.ok(r('const job = snapshot(input)') < r('locked(() => prepare(job))'), 'snapshot first (P3)');
    assert.ok(r('locked(() => prepare(job))') < r('if (!prep.go) return prep.result'));
    assert.ok(r('if (!prep.go) return prep.result') < r('provider.submit(mintTicket(job))'), 'submit only when prepare() said go');
  });

  it('a sealed provider refuses a direct submit(), a copy of a ticket, and a reused ticket', async () => {
    const { fake, gate, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    await assert.rejects(fake.provider.submit(job()), SpendGateBypassError);
    const r = await gate.run(job());
    assert.equal(r.status, 'submitted');
    assert.equal(submits(fake.log), 1, 'only the gated call reached the provider');
    // A frozen job that looks exactly like a ticket is still not one.
    await assert.rejects(fake.provider.submit(Object.freeze(structuredClone(job()))), SpendGateBypassError);
    assert.equal(submits(fake.log), 1);
    assert.ok(host.peek().ledger.every((e) => e.status === 'submitted'));
  });

  it('the gate refuses an unsealed provider', () => {
    const host = createFakeHost(tinyProject());
    const raw = { id: 'raw', kinds: ['image'], hosts: ['B'], capabilities: {}, billing: 'free' } as unknown as ProviderImpl & { billing: 'free' };
    assert.throws(() => createSpendGate({ host, providers: [raw as never] }), SpendGateBypassError);
  });

  it('sealing reads billing from config, so a provider cannot declare itself free', () => {
    const impl = { id: FAKE_PAID_ID, kinds: ['image'], hosts: ['B'], capabilities: {}, billing: 'free' } as unknown as ProviderImpl;
    const p = sealProvider({ ...impl, estimate: async () => { throw new Error(); }, submit: async () => { throw new Error(); }, poll: async () => ({ state: 'done' }), fetch: async () => [] }, { config: testConfig('direct-api') });
    assert.equal(p.billing, 'direct-api');
    assert.throws(() => sealProvider({ ...impl, id: 'not-in-config' } as ProviderImpl, { config: testConfig() }), /no entry/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Behaviour: submit iff estimate + approved + cap, for every combination
// ─────────────────────────────────────────────────────────────────────────

describe('submit() runs if and only if there is a cap, an approval and room under the cap', () => {
  const budgets = { none: null, roomy: budget(10), tight: budget(ESTIMATE / 2) } as const;
  const approvals = { none: undefined, awaiting: 'awaiting-approval', approved: 'approved', declined: 'declined' } as const;

  for (const [bName, b] of Object.entries(budgets)) {
    for (const [aName, a] of Object.entries(approvals)) {
      const should = bName === 'roomy' && aName === 'approved';
      it(`budget ${bName}, approval ${aName} → ${should ? 'submits' : 'refuses'}`, async () => {
        const p: AkukoProject = { ...tinyProject(), budget: b, pending_spend: a ? [pending(a)] : [] };
        const { fake, gate, host } = setup(p);
        const r = await gate.run(job());
        assert.equal(fake.log[0], `estimate:${JOB_ID}`, 'estimate() is always called first');
        assert.equal(submits(fake.log), should ? 1 : 0);
        assert.equal(r.status === 'submitted', should, JSON.stringify(r));
        if (should) assert.deepEqual(fake.log, [`estimate:${JOB_ID}`, `submit:${JOB_ID}`]);
        if (bName === 'none') {
          assert.ok(r.status === 'refused' && r.refusal.code === 'no-budget' && r.refusal.message === SETUP_POINTER);
          assert.match(SETUP_POINTER, /\/akuko setup/);
        }
        if (!should) assert.deepEqual(host.peek().ledger, [], 'nothing reserved on a refused path');
        assert.deepEqual(checkIntegrity(host.peek()), []);
      });
    }
  }
});

describe('spend gate rules', () => {
  it('first run of a paid job writes a pending spend awaiting approval and returns the confirmation line', async () => {
    const { gate, host, fake } = setup({ ...tinyProject(), budget: budget() });
    const r = await gate.run(job());
    assert.equal(r.status, 'awaiting-approval');
    if (r.status !== 'awaiting-approval') return;
    assert.equal(submits(fake.log), 0);
    const [entry] = host.peek().pending_spend;
    assert.equal(entry?.status, 'awaiting-approval');
    assert.equal(entry?.estimate, ESTIMATE);
    assert.equal(entry?.provider, FAKE_PAID_ID);
    assert.equal(entry?.created_at, NOW);
    assert.match(r.confirmation, /estimate 0\.1 USD/);
    assert.match(r.confirmation, /Reply "approve 0\.1 USD"/);
    assert.deepEqual(checkIntegrity(host.peek()), []);
  });

  it('an approval no longer covers a job whose estimate rose above it', async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    fake.setMultiplier(1.5);
    const r = await gate.run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'over-approved');
    assert.equal(submits(fake.log), 0);
    const q = await gate.quote(job());
    assert.equal(q.pending?.status, 'awaiting-approval', 'quote re-opens the approval at the new estimate');
    assert.equal(host.peek().pending_spend[0]?.estimate, ESTIMATE * 1.5);
  });

  it('approved_max lets the estimate rise up to the bound the person set', async () => {
    const { gate, fake } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved', { approved_max: ESTIMATE * 2 })] });
    fake.setMultiplier(1.5);
    assert.equal((await gate.run(job())).status, 'submitted');
  });

  it('counts money in flight against the cap', async () => {
    const p: AkukoProject = {
      ...tinyProject(),
      budget: budget(0.15),
      pending_spend: [pending('approved'), pending('approved', { id: 'job_other', units: ['sc1_sh1'], estimate: 0.1 })],
      ledger: [{ id: 'job_other.sc1_sh1.1', ts: NOW, provider: FAKE_PAID_ID, unit: 'sc1_sh1', job: 'job_other', estimate: 0.1, status: 'submitted' }],
    };
    const { gate, fake } = setup(p);
    const r = await gate.run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'over-cap', JSON.stringify(r));
    assert.equal(submits(fake.log), 0);
  });

  it('refuses an approval made for different units or another provider', async () => {
    const { gate, fake } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved', { units: ['sc1_sh1'] })] });
    const r = await gate.run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'approval-mismatch');
    assert.equal(submits(fake.log), 0);
  });

  it('refuses a currency the budget is not in', async () => {
    const { gate, fake } = setup({ ...tinyProject(), budget: { cap: 10, currency: 'EUR', spent: 0 }, pending_spend: [pending('approved')] });
    const r = await gate.run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'currency-mismatch');
    assert.equal(submits(fake.log), 0);
  });

  it('runs an approved job once: a second run is refused while the first is in flight or done', async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    const r = await gate.run(job());
    assert.equal(r.status, 'submitted');
    const again = await gate.run(job());
    assert.ok(again.status === 'refused' && again.refusal.code === 'already-submitted');
    assert.equal(submits(fake.log), 1);
    if (r.status === 'submitted') await gate.collect(r.handle);
    const third = await gate.run(job());
    assert.ok(third.status === 'refused' && third.refusal.code === 'already-submitted');
    assert.deepEqual(checkIntegrity(host.peek()), []);
  });

  it('reserves before submitting, and marks the reservation failed when submit throws', async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    fake.failNextSubmit();
    const r = await gate.run(job());
    assert.equal(r.status, 'failed');
    const p = host.peek();
    assert.deepEqual(p.ledger.map((e) => [e.id, e.status]), [[`${JOB_ID}.sc1_sh1.1`, 'failed'], [`${JOB_ID}.sc1_sh2.1`, 'failed']]);
    assert.equal(p.budget?.spent, 0);
    // A failed attempt does not block a retry; the retry opens new entries.
    const retry = await gate.run(job());
    assert.equal(retry.status, 'submitted');
    assert.deepEqual(host.peek().ledger.filter((e) => e.status === 'submitted').map((e) => e.id), [`${JOB_ID}.sc1_sh1.2`, `${JOB_ID}.sc1_sh2.2`]);
    assert.deepEqual(checkIntegrity(host.peek()), []);
  });

  it('collect() settles the ledger at the reported actual, else at the estimate, and recomputes spent', async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    fake.setActual({ sc1_sh1: 0.07 });
    const r = await gate.run(job());
    assert.ok(r.status === 'submitted');
    if (r.status !== 'submitted') return;
    const c = await gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    const p = host.peek();
    assert.deepEqual(p.ledger.map((e) => [e.unit, e.status, e.actual]), [['sc1_sh1', 'done', 0.07], ['sc1_sh2', 'done', FAKE_PRICE]]);
    assert.ok(Math.abs((p.budget?.spent ?? 0) - (0.07 + FAKE_PRICE)) < 1e-9);
    assert.equal(p.shots[0]?.status, 'pending-review');
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('collect() of a failed job settles failed and records no output', async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    fake.setOutcome('failed');
    const r = await gate.run(job());
    if (r.status !== 'submitted') return assert.fail(JSON.stringify(r));
    const c = await gate.collect(r.handle);
    assert.equal(c.assets.length, 0);
    const p = host.peek();
    assert.ok(p.ledger.every((e) => e.status === 'failed'));
    assert.equal(p.budget?.spent, 0);
    assert.equal(p.shots[0]?.status, 'approved', 'the unit is left as it was');
  });

  it('refuses unknown units, unknown providers and kinds the provider does not make', async () => {
    const { gate, fake } = setup({ ...tinyProject(), budget: budget() });
    const a = await gate.run(job({ items: [{ unit: 'nope', prompt: 'x', output: 'keyframe' }] }));
    assert.ok(a.status === 'refused' && a.refusal.code === 'invalid-job');
    const b = await gate.run(job({ provider: 'nobody' }));
    assert.ok(b.status === 'refused' && b.refusal.code === 'unknown-provider');
    const c = await gate.run(job({ kind: 'video' }));
    assert.ok(c.status === 'refused' && c.refusal.code === 'kind-not-supported');
    const d = await gate.run(job({ id: 'sc1_sh1' }));
    assert.ok(d.status === 'refused' && d.refusal.code === 'invalid-job', 'a job id may not shadow a unit id');
    await assert.rejects(gate.quote(job({ provider: 'nobody' })), SpendGateError);
    assert.equal(submits(fake.log), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. R-11: host A
// ─────────────────────────────────────────────────────────────────────────

describe('R-11: host A runs no paid direct APIs', () => {
  it('refuses a paid direct API on host A even when approved and within the cap', async () => {
    const p: AkukoProject = { ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] };
    const { gate, fake } = setup(p, { billing: 'direct-api', hosts: ['A', 'B', 'C'], level: 'A' });
    const r = await gate.run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'paid-direct-on-host-a', JSON.stringify(r));
    assert.equal(submits(fake.log), 0);
  });

  it('takes the host level from akuko.json when none is passed, and treats an unknown host as A', async () => {
    const approved: AkukoProject = { ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] };
    for (const p of [{ ...approved, host: { level: 'A' as const, capabilities: {} } }, approved]) {
      const host = createFakeHost(p);
      const fake = createFakePaid(host, { hosts: ['A', 'B', 'C'] });
      const gate = createSpendGate({ host, providers: [fake.provider], now: () => NOW });
      const r = await gate.run(job());
      assert.ok(r.status === 'refused' && r.refusal.code === 'paid-direct-on-host-a');
    }
  });

  it('a paid direct API that does not declare host A is refused there before anything else', async () => {
    const { gate, fake } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] }, { level: 'A' });
    const r = await gate.run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'host-not-supported');
    assert.equal(fake.log.length, 0);
  });

  it('a connected-MCP generation on host A still needs the cap and an approval, and carries the confirmation line', async () => {
    const opts = { billing: 'connected-mcp' as const, level: 'A' as const };
    const noCap = setup(tinyProject(), opts);
    const r0 = await noCap.gate.run(job());
    assert.ok(r0.status === 'refused' && r0.refusal.code === 'no-budget');

    const { gate, fake } = setup({ ...tinyProject(), budget: budget() }, opts);
    const r1 = await gate.run(job());
    assert.equal(r1.status, 'awaiting-approval');
    const q = await gate.quote(job());
    assert.match(q.confirmation ?? '', /^Spend check — Key frames for scene 1: fake-paid \(fake-model\), 2 units, estimate 0\.1 USD\./);
    assert.match(q.confirmation ?? '', /left after this 9\.9/);
    assert.equal(submits(fake.log), 0);
  });

  it('the manual provider runs on host A with no budget at all', async () => {
    const host = createFakeHost(tinyProject());
    const manual = createManualProvider(host, { now: () => NOW });
    const gate = createSpendGate({ host, providers: [manual.provider], level: 'A', now: () => NOW });
    const r = await gate.run(job({ provider: 'manual' }));
    assert.equal(r.status, 'submitted');
    if (r.status === 'submitted') {
      assert.equal(r.cost.amount, 0);
      assert.equal(r.handle.handoff?.kind, 'prompt-package');
      assert.deepEqual(r.handle.ledger, []);
    }
    assert.deepEqual(host.peek().pending_spend, [], 'a free job needs no pending spend');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. canApprove (for decision folding, WP-07a) + confirmation line
// ─────────────────────────────────────────────────────────────────────────

describe('canApprove()', () => {
  it('needs a budget', () => {
    assert.equal(canApprove({ ...tinyProject(), pending_spend: [pending('awaiting-approval')] }, JOB_ID)?.code, 'no-budget');
  });
  it('checks the estimate, or approved_max when set, against cap − spent − reserved', () => {
    const base: AkukoProject = { ...tinyProject(), budget: budget(0.1) };
    assert.equal(canApprove({ ...base, pending_spend: [pending('awaiting-approval')] }, JOB_ID), null);
    assert.equal(canApprove({ ...base, pending_spend: [pending('awaiting-approval', { approved_max: 0.2 })] }, JOB_ID)?.code, 'over-cap');
    assert.equal(canApprove({ ...base, budget: budget(0.1, 0.05), ledger: [{ ts: NOW, provider: 'x', unit: 'sc1_sh1', actual: 0.05, status: 'done' }], pending_spend: [pending('awaiting-approval')] }, JOB_ID)?.code, 'over-cap');
  });
  it('names an unknown job', () => {
    assert.equal(canApprove({ ...tinyProject(), budget: budget() }, 'nope')?.code, 'unknown-job');
  });
});

describe('confirmationLine()', () => {
  it('points to setup when there is no cap', () => {
    const line = confirmationLine(tinyProject(), job(), { amount: 0.1, currency: 'USD', per_unit: { sc1_sh1: 0.05, sc1_sh2: 0.05 }, basis: '' });
    assert.ok(line.endsWith(SETUP_POINTER));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. G-ADAPTER review regressions (P1–P10)
// ─────────────────────────────────────────────────────────────────────────

describe('G-ADAPTER review regressions', () => {
  it('P1: concurrent runs of one approved job submit once', async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    const results = await Promise.all([gate.run(job()), gate.run(job()), gate.run(job())]);
    assert.equal(results.filter((r) => r.status === 'submitted').length, 1);
    assert.ok(results.filter((r) => r.status !== 'submitted').every((r) => r.status === 'refused' && r.refusal.code === 'already-submitted'));
    assert.equal(submits(fake.log), 1);
    assert.deepEqual(host.peek().ledger.map((e) => e.id), [`${JOB_ID}.sc1_sh1.1`, `${JOB_ID}.sc1_sh2.1`]);
    assert.deepEqual(checkIntegrity(host.peek()), []);
  });

  it('P2: two approved jobs run concurrently cannot overrun the cap together, and no reservation is lost', async () => {
    const p: AkukoProject = {
      ...tinyProject(),
      budget: budget(0.15),
      pending_spend: [pending('approved', { id: 'job_a' }), pending('approved', { id: 'job_b' })],
    };
    const { gate, fake, host } = setup(p);
    const [a, b] = await Promise.all([gate.run(job({ id: 'job_a' })), gate.run(job({ id: 'job_b' }))]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ['refused', 'submitted']);
    const loser = a.status === 'refused' ? a : b;
    assert.ok(loser.status === 'refused' && loser.refusal.code === 'over-cap');
    assert.equal(submits(fake.log), 1);
    const winner = a.status === 'submitted' ? a : b.status === 'submitted' ? b : undefined;
    assert.ok(winner && winner.status === 'submitted');
    assert.equal(host.peek().ledger.length, 2, "the winner's entries are all there");
    assert.ok(host.peek().ledger.every((e) => e.job === winner.handle.job && e.status === 'submitted'));
    await gate.collect(winner.handle);
    const done = host.peek();
    assert.ok(done.ledger.every((e) => e.status === 'done'));
    assert.ok(Math.abs((done.budget?.spent ?? 0) - ESTIMATE) < 1e-9, 'the spend is counted');
    assert.deepEqual(checkIntegrity(done), []);
  });

  it("P3: mutating the caller's job while run() is in flight does not change what is submitted", async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    const live = job();
    const write = host.writeState.bind(host);
    host.writeState = async (p) => {
      const first = live.items[0];
      if (first) first.count = 50;
      live.items.push({ unit: 'char_n', prompt: 'extra', output: 'portrait' });
      return write(p);
    };
    const r = await gate.run(live);
    assert.equal(r.status, 'submitted');
    const sent = fake.submitted[0];
    assert.equal(sent?.items.length, 2);
    assert.equal(sent?.items[0]?.count, undefined, 'the provider got the job as estimated and approved');
    assert.deepEqual(host.peek().ledger.map((e) => e.estimate), [FAKE_PRICE, FAKE_PRICE]);
  });

  it('P3: the snapshot handed to estimate() is frozen, so a provider cannot change the job either', async () => {
    const host = createFakeHost({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    const cfg = testConfig('direct-api');
    const sneaky = sealProvider({
      id: FAKE_PAID_ID, kinds: ['image'], hosts: ['B'], capabilities: {},
      async estimate(j) { (j.items[0] as { count?: number }).count = 50; return { amount: 0, currency: 'USD', per_unit: {}, basis: '' }; },
      async submit() { throw new Error('unreachable'); },
      async poll() { return { state: 'done' }; },
      async fetch() { return []; },
    }, { config: cfg });
    const gate = createSpendGate({ host, providers: [sneaky], level: 'B', now: () => NOW });
    await assert.rejects(gate.run(job()), TypeError);
    assert.deepEqual(host.peek().ledger, []);
  });

  it("P6: collect() with a stale or forged handle cannot release another job's reservation", async () => {
    const { gate, fake, host } = setup({ ...tinyProject(), budget: budget(), pending_spend: [pending('approved')] });
    const r = await gate.run(job());
    if (r.status !== 'submitted') return assert.fail(JSON.stringify(r));
    fake.setOutcome('failed');
    const forged: JobHandle = { ...r.handle, job: 'job_other' };
    await gate.collect(forged);
    assert.ok(host.peek().ledger.every((e) => e.status === 'submitted'), "job_kf_sc1's reservation still holds");
    fake.setOutcome('done');
    await gate.collect(r.handle);
    assert.ok(host.peek().ledger.every((e) => e.status === 'done'));
  });

  it('P10: createSpendGate refuses two providers with the same id', () => {
    const host = createFakeHost(tinyProject());
    const a = createFakePaid(host).provider;
    const b = createFakePaid(host).provider;
    assert.throws(() => createSpendGate({ host, providers: [a, b] }), /share the id "fake-paid"/);
  });

  it('P5: the actual cost of a failed or cancelled call counts against the cap', async () => {
    const p: AkukoProject = {
      ...tinyProject(),
      budget: budget(0.15),
      pending_spend: [pending('approved'), pending('approved', { id: 'job_old', units: ['sc1_sh1'], estimate: 0.1 })],
      ledger: [{ id: 'job_old.sc1_sh1.1', ts: NOW, provider: FAKE_PAID_ID, unit: 'sc1_sh1', job: 'job_old', estimate: 0.1, actual: 0.1, status: 'failed' }],
    };
    const { gate, fake } = setup(p);
    const r = await gate.run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'over-cap', JSON.stringify(r));
    assert.equal(submits(fake.log), 0);
    assert.equal(canApprove(p, JOB_ID)?.code, 'over-cap');
  });

  it('P8: only providers/manual can seal the free manual id', () => {
    const paid = {
      id: 'manual', kinds: ['image'], hosts: ['A', 'B', 'C'], capabilities: {},
      async estimate() { return { amount: 0, currency: 'USD', per_unit: {}, basis: '' }; },
      async submit() { throw new Error('would spend'); },
      async poll() { return { state: 'done' }; },
      async fetch() { return []; },
    } as ProviderImpl;
    assert.throws(() => sealProvider(paid), /only providers\/manual may be sealed/);
    const raw = JSON.parse(readFileSync(new URL('../providers/config.json', import.meta.url), 'utf8'));
    const paidManual = parseProviderConfig({ ...raw, providers: { ...raw.providers, manual: { ...raw.providers.manual, billing: 'direct-api' } } });
    assert.throws(() => sealProvider(paid, { config: paidManual, manual: MANUAL_SEAL }), /must mark "manual" free/);
    const freeOther = parseProviderConfig({ ...raw, providers: { ...raw.providers, other: { ...raw.providers.manual } } });
    assert.throws(() => sealProvider({ ...paid, id: 'other' }, { config: freeOther }), /only the manual provider may be free/);
    assert.equal(createManualProvider(createFakeHost(tinyProject())).provider.billing, 'free');
  });
});
