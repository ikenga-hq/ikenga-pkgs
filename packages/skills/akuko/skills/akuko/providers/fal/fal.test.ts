// akuko — fal image provider tests. Network is mocked; nothing here calls fal.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkIntegrity } from '../../schema/integrity.ts';
import type { AkukoProject } from '../../schema/akuko-project.ts';
import { loadProviderConfig } from '../config.ts';
import type { Job } from '../contract.ts';
import { createSpendGate, isSealed } from '../../spend/gate.ts';
import { createFakeHost, tinyProject } from '../__fixtures__/fake-host.ts';
import { REF_URI, mockFal } from '../gemini-image/__fixtures__/mock-net.ts';
import { FAL_MAX_REFS, FAL_PROVIDER_ID, createFalImageProvider } from './index.ts';

const NOW = '2026-11-07T10:00:00Z';
const entry = loadProviderConfig().providers[FAL_PROVIDER_ID]!;
const price = entry.models[entry.default_model]!.price.amount;
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 10, currency: 'USD', spent: 0 } });

const job = (refs = 2, count = 1): Job => ({
  id: 'job_f',
  stage: 'keyframes',
  kind: 'image',
  provider: FAL_PROVIDER_ID,
  label: 'Key frames',
  items: [
    { unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe', aspect_ratio: '16:9', count },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'keyframe', refs: Array.from({ length: refs }, (_, i) => ({ id: `r${i}`, uri: REF_URI, role: 'character' })) },
  ],
});

function setup(net = mockFal()) {
  const host = createFakeHost(withBudget(tinyProject()));
  const provider = createFalImageProvider(host, { fetch: net.fetch, apiKey: 'test-key', now: () => NOW });
  const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
  return { host, provider, gate, net };
}

async function approveAndRun(s: ReturnType<typeof setup>, j: Job) {
  assert.equal((await s.gate.run(j)).status, 'awaiting-approval');
  const p = s.host.peek();
  s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => (x.id === j.id ? { ...x, status: 'approved' as const } : x)) });
  return s.gate.run(j);
}

describe('fal image provider', () => {
  it('is sealed, paid direct API, hosts B and C only (R-11), image only', () => {
    const { provider } = setup();
    assert.ok(isSealed(provider));
    assert.equal(provider.billing, 'direct-api');
    assert.deepEqual([...provider.hosts], ['B', 'C']);
    assert.deepEqual([...provider.kinds], ['image']);
    assert.equal(provider.capabilities.refImages, FAL_MAX_REFS);
    assert.equal(entry.example, false);
  });

  it('estimates the flat per-image price from config, without the network', async () => {
    const { provider, net } = setup();
    const c = await provider.estimate(job(2, 3));
    assert.ok(Math.abs(c.amount - 4 * price) < 1e-9);
    assert.equal(c.model, entry.default_model);
    assert.equal(net.calls.length, 0);
  });

  it('uses the text endpoint without references and the /edit endpoint with them, sending references as data URIs', async () => {
    const s = setup();
    const r = await approveAndRun(s, job());
    assert.equal(r.status, 'submitted');
    const posts = s.net.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.url, `https://queue.fal.run/${entry.default_model}`);
    assert.equal(posts[1]!.url, `https://queue.fal.run/${entry.default_model}/edit`);
    assert.equal(posts[0]!.headers.Authorization, 'Key test-key');
    const t2i = posts[0]!.body as Record<string, unknown>;
    assert.equal(t2i.aspect_ratio, '16:9');
    assert.equal(t2i.resolution, '1K');
    assert.equal(t2i.image_urls, undefined);
    const edit = posts[1]!.body as { image_urls: string[]; prompt: string };
    assert.equal(edit.image_urls.length, 2);
    assert.ok(edit.image_urls.every((u) => u.startsWith('data:image/png;base64,')));
    assert.match(edit.prompt, /Reference image 1 \(character\)\./);
    assert.match(edit.prompt, /A hand on a latch$/);
  });

  it('passes https references through as urls', async () => {
    const s = setup();
    const j = job();
    j.items[1]!.refs = [{ id: 'r', uri: 'https://example.com/a.png' }];
    await approveAndRun(s, j);
    const edit = s.net.calls.filter((c) => c.method === 'POST')[1]!.body as { image_urls: string[] };
    assert.deepEqual(edit.image_urls, ['https://example.com/a.png']);
  });

  it('refuses more references than the documented limit, before any request', async () => {
    const s = setup();
    await assert.rejects(s.provider.estimate(job(FAL_MAX_REFS + 1)), /15 reference images; fal .* at most 14/);
    await assert.rejects(s.gate.run(job(FAL_MAX_REFS + 1)), /at most 14/);
    assert.equal(s.net.calls.length, 0);
    await s.provider.estimate(job(FAL_MAX_REFS));
  });

  it('refuses an aspect ratio fal does not list', async () => {
    const { provider } = setup();
    const j = job();
    j.items[0]!.aspect_ratio = '7:5';
    await assert.rejects(provider.estimate(j), /aspect ratio/);
  });

  it('runs the queue to done, stores the images pending-review, settles the ledger and cannot run twice', async () => {
    const s = setup();
    const j = job();
    const r = await approveAndRun(s, j);
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.handle)));
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    const p = s.host.peek();
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal(c.assets.length, 2);
    assert.ok(p.assets.every((a) => a.status !== 'approved'));
    assert.ok(p.ledger.every((e) => e.status === 'done'));
    assert.equal(p.budget?.spent, p.ledger.reduce((a, e) => a + (e.actual ?? 0), 0));
    const posts = s.net.calls.filter((x) => x.method === 'POST').length;
    const again = await s.gate.run(j);
    assert.ok(again.status === 'refused' && again.refusal.code === 'already-submitted');
    assert.equal(s.net.calls.filter((x) => x.method === 'POST').length, posts);
    assert.equal((await s.gate.collect(r.handle)).status.state, 'done', 'collecting twice is fine');
  });

  it('keeps polling while fal is queued or running, and sends the key only to queue.fal.run', async () => {
    let status = 'IN_PROGRESS';
    const s = setup(mockFal({ status: () => status }));
    const r = await approveAndRun(s, job());
    if (r.status !== 'submitted') return assert.fail('not submitted');
    assert.equal((await s.provider.poll(r.handle)).state, 'running');
    status = 'COMPLETED';
    assert.equal((await s.provider.poll(r.handle)).state, 'done');
    for (const c of s.net.calls) if (c.headers.Authorization) assert.ok(c.url.startsWith('https://queue.fal.run/'));
  });

  it('refuses a status url that is not on the fal queue host', async () => {
    const net = mockFal();
    const evil = async (url: unknown, init?: RequestInit) => {
      const res = await net.fetch(url as string, init);
      if (init?.method === 'POST') return new Response(JSON.stringify({ request_id: 'x', status_url: 'https://evil.example/s', response_url: 'https://evil.example/r' }), { status: 200 });
      return res;
    };
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = createFalImageProvider(host, { fetch: evil as typeof fetch, apiKey: 'test-key' });
    const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
    const j = job();
    await gate.run(j);
    const p = host.peek();
    host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
    const r = await gate.run(j);
    assert.ok(r.status === 'failed' && /refusing to send the key/.test(r.error));
  });

  it('reports a request that completed with an error as failed', async () => {
    const net = mockFal();
    const base = net.fetch;
    const f: typeof fetch = async (url, init) =>
      String(url).endsWith('/status') ? new Response(JSON.stringify({ status: 'COMPLETED', error: 'content policy' }), { status: 200 }) : base(url, init);
    const s = setup({ ...net, fetch: f });
    const r = await approveAndRun(s, job());
    if (r.status !== 'submitted') return assert.fail('not submitted');
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'failed');
    assert.match(st.message ?? '', /content policy/);
  });

  it('a rejected first request fails the job and charges nothing', async () => {
    const f: typeof fetch = async () => new Response('Unauthorized', { status: 401 });
    const s = setup({ fetch: f, calls: [] });
    const r = await approveAndRun(s, job());
    assert.ok(r.status === 'failed' && /HTTP 401/.test(r.error));
    assert.ok(s.host.peek().ledger.every((e) => e.status === 'failed'));
  });

  it('says so when no key is set', async () => {
    const saved = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    try {
      const net = mockFal();
      const host = createFakeHost(withBudget(tinyProject()));
      const provider = createFalImageProvider(host, { fetch: net.fetch });
      const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
      const j = job();
      await gate.run(j);
      const p = host.peek();
      host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
      const r = await gate.run(j);
      assert.ok(r.status === 'failed' && /FAL_KEY/.test(r.error));
      assert.equal(net.calls.length, 0);
    } finally {
      if (saved !== undefined) process.env.FAL_KEY = saved;
    }
  });
});
