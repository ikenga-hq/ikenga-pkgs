// akuko — BytePlus Seedream image provider. Network is mocked; nothing here calls BytePlus.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AkukoProject } from '../../schema/akuko-project.ts';
import { checkIntegrity } from '../../schema/integrity.ts';
import { loadProviderConfig, priceFor } from '../config.ts';
import { costProblems, type Job } from '../contract.ts';
import { SpendGateBypassError, createSpendGate, isSealed } from '../../spend/gate.ts';
import { createFakeHost, tinyProject } from '../__fixtures__/fake-host.ts';
import { PNG_BYTES, REF_URI } from '../gemini-image/__fixtures__/mock-net.ts';
import { mockArk } from '../__fixtures__/direct-net.ts';
import { BYTEPLUS_IMAGE_PROVIDER_ID, SEEDREAM_SIZES, byteplusImageMaxRefs, createByteplusImageProvider } from './index.ts';

const NOW = '2026-11-12T10:00:00Z';
const config = loadProviderConfig();
const entry = config.providers[BYTEPLUS_IMAGE_PROVIDER_ID]!;
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 10, currency: 'USD', spent: 0 } });

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job_kf_ark_r1',
  stage: 'keyframes',
  kind: 'image',
  provider: BYTEPLUS_IMAGE_PROVIDER_ID,
  label: 'Key frames',
  items: [
    { unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe', aspect_ratio: '16:9', refs: [{ id: 'char_n', uri: REF_URI, role: 'character' }, { id: 'loc', uri: REF_URI, role: 'location' }] },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'keyframe' },
  ],
  ...over,
});

function setup(net = mockArk()) {
  const host = createFakeHost(withBudget(tinyProject()));
  const provider = createByteplusImageProvider(host, { fetch: net.fetch, apiKey: 'ark-test', now: () => NOW });
  const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
  return { host, provider, gate, net };
}

async function approveAndRun(s: ReturnType<typeof setup>, j: Job) {
  assert.equal((await s.gate.run(j)).status, 'awaiting-approval');
  const p = s.host.peek();
  s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => (x.id === j.id ? { ...x, status: 'approved' as const } : x)) });
  return s.gate.run(j);
}

describe('byteplus-image', () => {
  it('is sealed, a paid direct API on hosts A, B and C, images only, ARK_API_KEY, every model priced per image with a cited source', () => {
    const { provider } = setup();
    assert.ok(isSealed(provider));
    assert.equal(provider.billing, 'direct-api');
    assert.deepEqual([...provider.hosts], ['A', 'B', 'C']);
    assert.deepEqual([...provider.kinds], ['image']);
    assert.equal(entry.key_env, 'ARK_API_KEY');
    for (const [model, m] of Object.entries(entry.models)) {
      assert.equal(m.price.per, 'image');
      assert.match(m.source, /read 2026-11-12/);
      assert.ok(byteplusImageMaxRefs(model), `${model} has a reference limit`);
    }
  });

  it('direct submit() throws SpendGateBypassError', async () => {
    const { provider, net } = setup();
    await assert.rejects(provider.submit(job()), SpendGateBypassError);
    assert.equal(net.calls.length, 0);
  });

  it('estimate() is a flat price per image from config, no network', async () => {
    const { provider, net } = setup();
    const c = await provider.estimate(job());
    assert.deepEqual(costProblems(job(), c), []);
    assert.ok(Math.abs(c.amount - 2 * priceFor(config, BYTEPLUS_IMAGE_PROVIDER_ID).amount) < 1e-9);
    assert.equal(net.calls.length, 0);
  });

  it('refuses more references than the family takes, and an aspect ratio it has no size for', async () => {
    const { provider } = setup();
    const max = byteplusImageMaxRefs(entry.default_model)!;
    const many = job();
    many.items[0]!.refs = Array.from({ length: max + 1 }, (_, i) => ({ id: `r${i}`, uri: REF_URI, role: 'character' }));
    await assert.rejects(provider.estimate(many), new RegExp(`at most ${max}`));
    const odd = job();
    odd.items[0]!.aspect_ratio = '5:1';
    await assert.rejects(provider.estimate(odd), /not supported/);
  });

  it('runs end to end: references inline as data URIs, a WxH size for the aspect ratio, base64 back, no watermark', async () => {
    const s = setup();
    const r = await approveAndRun(s, job());
    if (r.status !== 'submitted') return assert.fail(JSON.stringify(r));
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    assert.equal(c.assets.length, 2);
    assert.deepEqual([...(s.host.files.get(c.assets[0]!.file!.uri) ?? [])], [...PNG_BYTES]);
    const first = s.net.calls[0]!.body as Record<string, any>;
    assert.equal(first.model, entry.default_model);
    assert.ok(Array.isArray(first.image) && first.image.every((x: string) => x.startsWith('data:image/png;base64,')));
    assert.equal(first.size, SEEDREAM_SIZES['16:9']);
    assert.equal(first.response_format, 'b64_json');
    assert.equal(first.watermark, false);
    assert.equal(first.sequential_image_generation, 'disabled');
    assert.equal((s.net.calls[1]!.body as Record<string, unknown>).size, '2K', 'no aspect ratio: the 2K level');
    assert.ok(s.net.calls.every((x) => new URL(x.url).host === 'ark.ap-southeast.bytepluses.com'));
    assert.deepEqual(checkIntegrity(s.host.peek()), []);
  });

  it('every size is 3.7 to 4.2 million pixels (inside every configured family\'s WxH range)', () => {
    for (const [ratio, size] of Object.entries(SEEDREAM_SIZES)) {
      const [w, h] = size.split('x').map(Number) as [number, number];
      assert.ok(w * h >= 3_686_400 && w * h <= 4_624_220, `${ratio} ${size}`);
    }
  });

  it('a moderation refusal with no image fails the run with BytePlus\'s words', async () => {
    const s = setup(mockArk({ noImage: true }));
    const r = await approveAndRun(s, job());
    assert.ok(r.status === 'failed' && /blocked/.test(r.error), JSON.stringify(r));
  });
});
