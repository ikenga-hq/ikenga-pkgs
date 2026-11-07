// akuko — provider contract suite (G-ADAPTER). Every provider must pass it.
//
//   pnpm --filter @ikenga/skill-akuko test
//
// To add a provider: append a ProviderSpec to PROVIDERS below. The spec says
// how to build it against a host, a job it should be able to run, and — for
// providers that need a person or a remote service to finish — how to finish
// a submitted job in a test.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { findUnit } from '../schema/akuko-project.ts';
import type { HostLevel, Job, JobHandle, Provider, WaveOneHost } from './contract.ts';
import { HOST_LEVELS, JOB_STATES, PROVIDER_KINDS, costProblems, isPaid } from './contract.ts';
import type { AkukoProviderConfig } from './config.ts';
import {
  CONFIG_URL,
  estimateFromConfig,
  loadProviderConfig,
  parseProviderConfig,
  priceFor,
  staleModels,
} from './config.ts';
import { createManualProvider } from './manual/index.ts';
import { SpendGateBypassError, createSpendGate, isSealed } from '../spend/gate.ts';
import { spentFromLedger } from '../spend/ledger.ts';
import { PNG, createFakeHost, tinyProject } from './__fixtures__/fake-host.ts';
import { createFakePaid, testConfig } from '../spend/__fixtures__/fake-paid.ts';

interface ProviderSpec {
  name: string;
  config: AkukoProviderConfig;
  /** Example config entries are allowed only for test fixtures. */
  fixture?: boolean;
  make(host: WaveOneHost): { provider: Provider; finish?(handle: JobHandle, job: Job): Promise<void> };
  job(p: AkukoProject): Job;
}

const keyframeJob = (provider: string, id = 'job_kf_test'): Job => ({
  id,
  stage: 'keyframes',
  kind: 'image',
  provider,
  label: 'Key frames for scene 1',
  items: [
    { unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe', aspect_ratio: '16:9' },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'keyframe', refs: [{ id: 'char_n', role: 'character' }] },
  ],
});

const PROVIDERS: ProviderSpec[] = [
  {
    name: 'manual',
    config: loadProviderConfig(),
    make(host) {
      const m = createManualProvider(host, { now: () => '2026-11-07T10:00:00Z' });
      return {
        provider: m.provider,
        async finish(handle, job) {
          for (const unit of handle.units) {
            await m.ingest({ job, unit, file: { filename: 'take.png', mime: 'image/png', data: PNG } });
          }
        },
      };
    },
    job: () => keyframeJob('manual'),
  },
  {
    // Not a real provider: proves the suite's paid branch works before WP-06 adds real ones.
    name: 'fixture: fake paid direct API',
    config: testConfig('direct-api'),
    fixture: true,
    make: (host) => ({ provider: createFakePaid(host).provider }),
    job: () => keyframeJob('fake-paid'),
  },
];

const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 10, currency: 'USD', spent: 0 } });

/** A host level the provider may run on: B when it can, else its first. */
const levelFor = (p: Provider): HostLevel => (p.hosts.includes('B') ? 'B' : (p.hosts[0] as HostLevel));

for (const spec of PROVIDERS) {
  describe(`provider contract: ${spec.name}`, () => {
    it('declares an id, kinds, hosts and capabilities of the right shape', () => {
      const { provider } = spec.make(createFakeHost(tinyProject()));
      assert.match(provider.id, /^[a-z0-9][a-z0-9-]*$/);
      assert.ok(provider.kinds.length > 0, 'at least one kind');
      for (const k of provider.kinds) assert.ok(PROVIDER_KINDS.includes(k), `kind ${k}`);
      assert.ok(provider.hosts.length > 0, 'at least one host level');
      for (const h of provider.hosts) assert.ok(HOST_LEVELS.includes(h), `host ${h}`);
      const c = provider.capabilities;
      for (const key of Object.keys(c)) assert.ok(['refImages', 'maxSeconds', 'nativeAudio', 'i2v'].includes(key), `capability ${key}`);
      if (c.refImages !== undefined) assert.ok(Number.isInteger(c.refImages) && c.refImages >= 0);
      if (c.maxSeconds !== undefined) assert.ok(c.maxSeconds > 0);
    });

    it('is sealed, and its billing, models and prices come from config with a last_verified date', () => {
      const { provider } = spec.make(createFakeHost(tinyProject()));
      assert.ok(isSealed(provider), 'built with sealProvider()');
      const entry = spec.config.providers[provider.id];
      assert.ok(entry, `config.json has an entry for ${provider.id}`);
      assert.equal(provider.billing, entry.billing);
      if (!spec.fixture) assert.equal(entry.example, false, 'a real provider is not an example entry');
      for (const [model, m] of Object.entries(entry.models)) {
        assert.match(m.last_verified, /^\d{4}-\d{2}-\d{2}$/, `${model} last_verified`);
      }
      if (provider.hosts.includes('A')) {
        assert.notEqual(entry.billing, 'direct-api', 'R-11: a paid direct API may not declare host A in v0.x');
      }
    });

    it('estimate() returns a usable Cost and touches no host write', async () => {
      const host = createFakeHost(tinyProject());
      const { provider } = spec.make(host);
      const job = spec.job(host.peek());
      const cost = await provider.estimate(job);
      assert.deepEqual(costProblems(job, cost), []);
      assert.equal(cost.currency, spec.config.currency);
      if (!isPaid(provider.billing)) assert.equal(cost.amount, 0);
      assert.deepEqual(await provider.estimate(job), cost, 'deterministic for the same job');
      assert.ok(!host.calls.includes('writeState') && !host.calls.includes('storeAsset'), host.calls.join(','));
    });

    it('submit() called directly throws SpendGateBypassError and changes nothing', async () => {
      const host = createFakeHost(withBudget(tinyProject()));
      const { provider } = spec.make(host);
      const job = spec.job(host.peek());
      await assert.rejects(provider.submit(job), SpendGateBypassError);
      await assert.rejects(provider.submit(structuredClone(job)), SpendGateBypassError);
      assert.equal(host.writes(), 0);
    });

    it('without a recorded budget cap: free providers run, paid ones are refused with a pointer to setup', async () => {
      const host = createFakeHost(tinyProject());
      const { provider } = spec.make(host);
      const gate = createSpendGate({ host, providers: [provider], level: levelFor(provider) });
      const r = await gate.run(spec.job(host.peek()));
      if (isPaid(provider.billing)) {
        assert.equal(r.status, 'refused');
        assert.ok(r.status === 'refused' && r.refusal.code === 'no-budget');
        assert.ok(r.status === 'refused' && /setup/.test(r.refusal.message));
        assert.deepEqual(host.peek().ledger, []);
      } else {
        assert.equal(r.status, 'submitted');
      }
    });

    it('runs end to end through the gate: outputs land as pending-review, ledger settles', async () => {
      const host = createFakeHost(withBudget(tinyProject()));
      const made = spec.make(host);
      const { provider } = made;
      const gate = createSpendGate({ host, providers: [provider], level: levelFor(provider), now: () => '2026-11-07T10:00:00Z' });
      const job = spec.job(host.peek());

      let r = await gate.run(job);
      if (isPaid(provider.billing)) {
        assert.equal(r.status, 'awaiting-approval');
        const p = host.peek();
        host.set({ ...p, pending_spend: p.pending_spend.map((j) => (j.id === job.id ? { ...j, status: 'approved' as const } : j)) });
        r = await gate.run(job);
      }
      assert.equal(r.status, 'submitted', JSON.stringify(r));
      if (r.status !== 'submitted') return;
      const h = r.handle;
      assert.equal(h.job, job.id);
      assert.equal(h.provider, provider.id);
      assert.equal(h.stage, job.stage);
      assert.deepEqual(h.units, job.items.map((i) => i.unit));
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(h)), 'handle is JSON-serialisable');

      const first = await provider.poll(h);
      assert.ok(JOB_STATES.includes(first.state));
      await made.finish?.(h, job);

      const c = await gate.collect(h);
      assert.equal(c.status.state, 'done');
      const p = host.peek();
      assert.deepEqual(checkIntegrity(p), []);
      for (const item of job.items) {
        const unit = findUnit(p, item.unit);
        assert.ok(unit, item.unit);
        assert.equal(unit.unit.status, 'pending-review', `${item.unit} waits for a person`);
        assert.equal(unit.unit.stage, job.stage);
        assert.ok(unit.unit.by_stage?.[job.stage]?.output?.uri, `${item.unit} shows its new output`);
      }
      assert.ok(c.assets.length >= job.items.length);
      for (const a of c.assets) {
        assert.ok(a.file?.uri, `${a.id} has a file`);
        assert.notEqual(a.status, 'approved');
        assert.ok(a.tags.includes(`job:${job.id}`));
      }
      assert.ok(p.assets.every((a) => a.status !== 'approved'), 'nothing the provider made is approved');
      if (isPaid(provider.billing)) {
        assert.ok(p.ledger.length === job.items.length && p.ledger.every((e) => e.status === 'done'));
        assert.equal(p.budget?.spent, spentFromLedger(p));
        assert.ok((p.budget?.spent ?? 0) > 0);
        const again = await gate.run(job);
        assert.ok(again.status === 'refused' && again.refusal.code === 'already-submitted');
      } else {
        assert.deepEqual(p.ledger, []);
      }

      const recollect = await gate.collect(h);
      assert.equal(recollect.status.state, 'done');
      assert.deepEqual(host.peek().shots, p.shots, 'collecting twice changes nothing');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Config: the only home of model ids and prices
// ─────────────────────────────────────────────────────────────────────────

const AKUKO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__fixtures__') continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('providers/config.json', () => {
  const raw = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
  const config = parseProviderConfig(raw);

  it('parses, and every model has a price, a source and a last_verified date', () => {
    for (const [id, p] of Object.entries(config.providers)) {
      assert.ok(p.default_model in p.models, `${id} default model is configured`);
      for (const m of Object.values(p.models)) {
        assert.ok(m.price.amount >= 0);
        assert.ok(m.source.length > 0);
        assert.ok(!Number.isNaN(Date.parse(m.last_verified)));
      }
    }
  });

  it('carries the manual provider as free, and marks every other entry an example until WP-06', () => {
    assert.equal(config.providers.manual?.billing, 'free');
    assert.equal(config.providers.manual?.example, false);
    for (const [id, p] of Object.entries(config.providers)) {
      if (id !== 'manual') assert.equal(p.example, true, `${id} is a placeholder`);
    }
  });

  it('example prices cannot be used for real estimates', () => {
    assert.throws(() => priceFor(config, 'example-direct-image'), /example entry/);
    assert.equal(priceFor(config, 'example-direct-image', undefined, { allowExamples: true }).per, 'image');
  });

  it('no model id from config.json is written in any non-test source file', () => {
    const modelIds = Object.values(config.providers).flatMap((p) => Object.keys(p.models));
    for (const file of sourceFiles(AKUKO_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const m of modelIds) {
        assert.ok(!text.includes(`'${m}'`) && !text.includes(`"${m}"`) && !text.includes(`\`${m}\``), `${relative(AKUKO_ROOT, file).split(sep).join('/')} hard-codes model id ${m}`);
      }
    }
  });

  it('estimates follow the configured price, not code', () => {
    const doubled = parseProviderConfig({
      ...raw,
      providers: { ...raw.providers, manual: { ...raw.providers.manual, models: { 'manual-handoff': { ...raw.providers.manual.models['manual-handoff'], price: { amount: 3, per: 'job' } } } } },
    });
    const cost = estimateFromConfig(doubled, keyframeJob('manual'));
    assert.equal(cost.amount, 3);
    assert.deepEqual(cost.per_unit, { sc1_sh1: 1.5, sc1_sh2: 1.5 });
    assert.match(cost.basis, /verified/);
  });

  it('prices per image, per second and per character', () => {
    const cfg = (per: string) => parseProviderConfig({
      format: 'akuko-provider-config', version: 1, currency: 'USD', stale_after_days: 30,
      providers: { x: { label: 'x', billing: 'direct-api', default_model: 'm', models: { m: { price: { amount: 0.5, per }, last_verified: '2026-11-07', source: 't' } } } },
    });
    const job: Job = { ...keyframeJob('x'), items: [{ unit: 'a', prompt: 'abcd', output: 'clip', count: 2, duration_s: 3 }] };
    assert.equal(estimateFromConfig(cfg('image'), job).amount, 1);
    assert.equal(estimateFromConfig(cfg('second'), job).amount, 3);
    assert.equal(estimateFromConfig(cfg('character'), job).amount, 4);
    assert.throws(() => estimateFromConfig(cfg('second'), { ...job, items: [{ unit: 'a', prompt: 'p', output: 'clip' }] }), /duration_s/);
  });

  it('flags stale prices for doctor', () => {
    assert.deepEqual(staleModels(config, '2026-11-07'), []);
    const stale = staleModels(config, '2027-01-01');
    assert.ok(stale.length > 0 && stale.every((s) => s.age_days > config.stale_after_days));
  });
});
