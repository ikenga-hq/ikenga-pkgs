// akuko — Gemini image provider tests. Network is mocked; nothing here calls Google.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkIntegrity } from '../../schema/integrity.ts';
import type { AkukoProject } from '../../schema/akuko-project.ts';
import { loadProviderConfig } from '../config.ts';
import type { Job, Provider } from '../contract.ts';
import { createSpendGate, isSealed } from '../../spend/gate.ts';
import { createFakeHost, tinyProject } from '../__fixtures__/fake-host.ts';
import { GEMINI_MAX_REFS, GEMINI_PROVIDER_ID, createGeminiImageProvider, parseInteraction } from './index.ts';
import { REF_URI, mockGemini } from './__fixtures__/mock-net.ts';

const NOW = '2026-11-07T10:00:00Z';
const config = loadProviderConfig();
const entry = config.providers[GEMINI_PROVIDER_ID]!;
const defaultPrice = entry.models[entry.default_model]!.price.amount;
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 10, currency: 'USD', spent: 0 } });

const job = (over: Partial<Job> = {}, refs = 1): Job => ({
  id: 'job_g',
  stage: 'keyframes',
  kind: 'image',
  provider: GEMINI_PROVIDER_ID,
  label: 'Key frames',
  items: [
    { unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe', aspect_ratio: '16:9', negative: 'text', camera: 'low angle' },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'keyframe', refs: Array.from({ length: refs }, (_, i) => ({ id: `r${i}`, uri: REF_URI, role: 'character', note: `ref ${i}` })) },
  ],
  ...over,
});

function setup(net = mockGemini(), host = createFakeHost(withBudget(tinyProject()))) {
  const provider = createGeminiImageProvider(host, { fetch: net.fetch, apiKey: 'test-key', now: () => NOW });
  const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
  return { host, provider, gate, net };
}

async function approveAndRun(s: ReturnType<typeof setup>, j: Job) {
  const first = await s.gate.run(j);
  assert.equal(first.status, 'awaiting-approval');
  const p = s.host.peek();
  s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => (x.id === j.id ? { ...x, status: 'approved' as const } : x)) });
  return s.gate.run(j);
}

describe('gemini-image provider', () => {
  it('is sealed, paid direct API, hosts B and C only (R-11)', () => {
    const { provider } = setup();
    assert.ok(isSealed(provider));
    assert.equal(provider.billing, 'direct-api');
    assert.deepEqual([...provider.hosts], ['B', 'C']);
    assert.equal(provider.capabilities.refImages, GEMINI_MAX_REFS);
    assert.equal(entry.example, false);
  });

  it('estimates from config per image, for the default and a named model, never calling the network', async () => {
    const { provider, net } = setup();
    const c = await provider.estimate(job());
    assert.equal(c.model, entry.default_model);
    assert.ok(Math.abs(c.amount - 2 * defaultPrice) < 1e-9);
    const pro = await provider.estimate(job({ model: Object.keys(entry.models).at(-1) }));
    assert.ok(pro.amount > c.amount);
    const three = await provider.estimate({ ...job(), items: [{ unit: 'sc1_sh1', prompt: 'x', output: 'keyframe', count: 3 }] });
    assert.ok(Math.abs(three.amount - 3 * defaultPrice) < 1e-9);
    assert.equal(net.calls.length, 0);
  });

  it('refuses an unconfigured model, a non-image job and a bad aspect ratio, in estimate()', async () => {
    const { provider } = setup();
    await assert.rejects(provider.estimate(job({ model: 'not-a-model' })), /not configured/);
    await assert.rejects(provider.estimate(job({ kind: 'video' })), /makes images/);
    const bad = job();
    bad.items[0]!.aspect_ratio = 'wide';
    await assert.rejects(provider.estimate(bad), /aspect ratio/);
  });

  it('sends the bible references, labelled, with the prompt, in the documented request shape', async () => {
    const s = setup();
    const r = await approveAndRun(s, job({}, 3));
    assert.equal(r.status, 'submitted');
    assert.equal(s.net.calls.length, 2);
    const withRefs = s.net.calls[1]!;
    assert.equal(withRefs.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(withRefs.method, 'POST');
    assert.equal(withRefs.headers['x-goog-api-key'], 'test-key');
    const body = withRefs.body as { model: string; input: Array<{ type: string; mime_type?: string; data?: string; text?: string }>; response_format: Record<string, string>; store: boolean };
    assert.equal(body.model, entry.default_model);
    assert.equal(body.store, false);
    assert.equal(body.response_format.type, 'image');
    assert.equal(body.response_format.image_size, '1K');
    const imgs = body.input.filter((p) => p.type === 'image');
    assert.equal(imgs.length, 3);
    assert.ok(imgs.every((p) => p.mime_type === 'image/png' && p.data && p.data.length > 0));
    assert.match(body.input[0]!.text ?? '', /Reference image 1 \(character\): ref 0/);
    assert.equal(body.input.at(-1)!.text, 'A hand on a latch');
    const first = s.net.calls[0]!.body as { input: Array<{ text?: string }>; response_format: Record<string, string> };
    assert.equal(first.response_format.aspect_ratio, '16:9');
    assert.match(first.input.at(-1)!.text!, /Camera: low angle\.\nAvoid: text\./);
  });

  it('refuses more references than the documented limit with a clear message, before any request', async () => {
    const s = setup();
    const over = job({}, GEMINI_MAX_REFS + 1);
    await assert.rejects(s.provider.estimate(over), /15 reference images; gemini-image .* at most 14/);
    await assert.rejects(s.gate.run(over), /at most 14/);
    assert.equal(s.net.calls.length, 0);
    await s.provider.estimate(job({}, GEMINI_MAX_REFS));
  });

  it('leaves out references that have no file yet', async () => {
    const s = setup();
    const j = job();
    j.items[1]!.refs = [{ id: 'char_n', role: 'character' }];
    assert.equal((await approveAndRun(s, j)).status, 'submitted');
    assert.equal((s.net.calls[1]!.body as { input: unknown[] }).input.length, 1);
  });

  it('stores the images, records them pending-review, settles the ledger, and cannot run twice', async () => {
    const s = setup();
    const j = job();
    const r = await approveAndRun(s, j);
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    const p = s.host.peek();
    assert.deepEqual(checkIntegrity(p), []);
    assert.ok(p.ledger.every((e) => e.status === 'done'));
    assert.ok((p.budget?.spent ?? 0) > 0);
    assert.ok(p.assets.every((a) => a.status !== 'approved'));
    assert.equal(c.assets.length, 2);
    for (const a of c.assets) assert.ok(a.tags.includes('job:job_g') && a.provider === GEMINI_PROVIDER_ID && a.model === entry.default_model);
    const again = await s.gate.run(j);
    assert.ok(again.status === 'refused' && again.refusal.code === 'already-submitted');
    assert.equal(s.net.calls.length, 2, 'no second spend');
  });

  it('count > 1 makes that many images', async () => {
    const s = setup();
    const j = job();
    j.items = [{ unit: 'sc1_sh1', prompt: 'p', output: 'keyframe', count: 3 }];
    const r = await approveAndRun(s, j);
    assert.equal(r.status, 'submitted');
    assert.equal(s.net.calls.length, 3);
    if (r.status !== 'submitted') return;
    assert.equal((await s.gate.collect(r.handle)).assets.length, 3);
  });

  it('a failure on the first call fails the job, charges nothing and stops sending', async () => {
    const net = mockGemini({ fail: () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }) });
    const s = setup(net);
    const r = await approveAndRun(s, job());
    assert.equal(r.status, 'failed');
    assert.ok(r.status === 'failed' && /HTTP 400: API key not valid/.test(r.error));
    assert.equal(net.calls.length, 1, 'stopped after the first failure');
    assert.ok(s.host.peek().ledger.every((e) => e.status === 'failed'));
    assert.ok(!JSON.stringify(r).includes('test-key'));
  });

  it('pins the exact request body for every configured model (A-5: a mock once hid an HTTP 400 on image/png)', async () => {
    for (const model of Object.keys(entry.models)) {
      const s = setup();
      const j: Job = { ...job({ model }), items: [{ unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe', aspect_ratio: '16:9' }] };
      const r = await approveAndRun(s, j);
      assert.equal(r.status, 'submitted');
      assert.deepEqual(s.net.calls[0]!.body, {
        model,
        input: [{ type: 'text', text: 'A long dark hallway' }],
        store: false,
        response_format: { type: 'image', mime_type: 'image/jpeg', image_size: '1K', aspect_ratio: '16:9' },
      }, model);
      assert.equal(s.net.calls[0]!.headers['Api-Revision'], '2026-05-20');
    }
  });

  it('a later failure keeps the paid image and reports the missing unit', async () => {
    const net = mockGemini({ fail: (n) => (n === 2 ? new Response('{"error":{"message":"quota"}}', { status: 429 }) : undefined) });
    const s = setup(net);
    const r = await approveAndRun(s, job());
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'failed');
    assert.match(st.message ?? '', /sc1_sh2.*429.*quota/);
    assert.match(st.message ?? '', /free tier, or billing is not active/);
    assert.deepEqual(Object.keys(st.actual ?? {}), ['sc1_sh1']);
  });

  it('says so when no key is set, and sends nothing', async () => {
    const net = mockGemini();
    const host = createFakeHost(withBudget(tinyProject()));
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const provider = createGeminiImageProvider(host, { fetch: net.fetch });
      const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
      const j = job();
      await gate.run(j);
      const p = host.peek();
      host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
      const r = await gate.run(j);
      assert.ok(r.status === 'failed' && /GEMINI_API_KEY/.test(r.error));
      assert.equal(net.calls.length, 0);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  it('parseInteraction reads the image, and explains a text-only (refused) answer', () => {
    const ok = parseInteraction({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', data: 'AQID' }] }] });
    assert.deepEqual([...ok.data], [1, 2, 3]);
    assert.equal(ok.mime, 'image/png');
    assert.throws(() => parseInteraction({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot draw that' }] }] }), /no image: I cannot draw that/);
    assert.throws(() => parseInteraction({ status: 'failed', steps: [] }), /failed/);
  });

  it('is refused on host A by the gate', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const provider: Provider = createGeminiImageProvider(host, { fetch: mockGemini().fetch, apiKey: 'k' });
    const gate = createSpendGate({ host, providers: [provider], level: 'A' });
    const r = await gate.run(job());
    assert.equal(r.status, 'refused');
    assert.ok(r.status === 'refused' && r.refusal.code === 'host-not-supported');
  });
});
