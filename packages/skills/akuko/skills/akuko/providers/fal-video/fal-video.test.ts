// akuko — fal video provider tests (contract-suite checks plus video specifics). Network is mocked; nothing here calls fal.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { checkIntegrity } from '../../schema/integrity.ts';
import type { AkukoProject } from '../../schema/akuko-project.ts';
import { CONFIG_URL, loadProviderConfig, staleModels } from '../config.ts';
import { costProblems, type Job } from '../contract.ts';
import { SpendGateBypassError, createSpendGate, isSealed } from '../../spend/gate.ts';
import { spentFromLedger } from '../../spend/ledger.ts';
import { createFakeHost, tinyProject } from '../__fixtures__/fake-host.ts';
import { REF_URI } from '../gemini-image/__fixtures__/mock-net.ts';
import { MP4_BYTES, mockFalVideo } from './__fixtures__/mock-net.ts';
import { AUDIO_SUFFIX, FAL_VIDEO_PROVIDER_ID, createFalVideoProvider, falVideoLimits, fitSeconds, snapSeconds, splitModel } from './index.ts';

const NOW = '2026-11-09T10:00:00Z';
const config = loadProviderConfig();
const entry = config.providers[FAL_VIDEO_PROVIDER_ID]!;
const models = Object.keys(entry.models);
const audioModel = models.find((m) => m.endsWith(AUDIO_SUFFIX))!;
const silentTwin = audioModel.slice(0, -AUDIO_SUFFIX.length);
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 20, currency: 'USD', spent: 0 } });

const job = (over: Partial<Job> = {}, seconds: [number, number] = [5, 10]): Job => ({
  id: 'job_mo_test_r1',
  stage: 'motion',
  kind: 'video',
  provider: FAL_VIDEO_PROVIDER_ID,
  label: 'Clips',
  items: [
    { unit: 'sc1_sh1', prompt: 'Mara walks along the pier', output: 'clip', duration_s: seconds[0], aspect_ratio: '16:9', refs: [{ id: 'kf1', uri: REF_URI, role: 'start-frame' }] },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'clip', duration_s: seconds[1], refs: [{ id: 'kf2', uri: REF_URI, role: 'start-frame' }] },
  ],
  ...over,
});

function setup(net = mockFalVideo()) {
  const host = createFakeHost(withBudget(tinyProject()));
  const provider = createFalVideoProvider(host, { fetch: net.fetch, apiKey: 'test-key', now: () => NOW });
  const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
  return { host, provider, gate, net };
}

async function approveAndRun(s: ReturnType<typeof setup>, j: Job) {
  assert.equal((await s.gate.run(j)).status, 'awaiting-approval');
  const p = s.host.peek();
  s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => (x.id === j.id ? { ...x, status: 'approved' as const } : x)) });
  return s.gate.run(j);
}

describe('fal video provider: contract', () => {
  it('is sealed, paid direct API, hosts B and C only (R-11), video only, i2v with a stated length limit', () => {
    const { provider } = setup();
    assert.ok(isSealed(provider));
    assert.equal(provider.billing, 'direct-api');
    assert.deepEqual([...provider.hosts], ['B', 'C']);
    assert.deepEqual([...provider.kinds], ['video']);
    assert.equal(provider.capabilities.i2v, true);
    assert.equal(provider.capabilities.maxSeconds, 10);
    assert.equal(entry.example, false);
    assert.equal(entry.key_env, 'FAL_KEY');
  });

  it('direct submit() throws SpendGateBypassError and changes nothing', async () => {
    const { provider, host, net } = setup();
    await assert.rejects(provider.submit(job()), SpendGateBypassError);
    await assert.rejects(provider.submit(structuredClone(job())), SpendGateBypassError);
    assert.equal(host.writes(), 0);
    assert.equal(net.calls.length, 0);
  });

  it('estimate() is price per second x seconds from config, deterministic, with no network and no write', async () => {
    const { provider, net, host } = setup();
    const price = entry.models[entry.default_model]!.price.amount;
    const j = job();
    const c = await provider.estimate(j);
    assert.deepEqual(costProblems(j, c), []);
    assert.ok(Math.abs(c.amount - price * 15) < 1e-9);
    assert.ok(Math.abs((c.per_unit.sc1_sh1 ?? 0) - price * 5) < 1e-9);
    assert.match(c.basis, /sc1_sh1 5 s/);
    assert.deepEqual(await provider.estimate(j), c);
    assert.equal(net.calls.length, 0);
    assert.equal(host.writes(), 0);
  });

  it('refuses a length the model cannot make, a missing start frame, and more than one clip per unit', async () => {
    const { provider } = setup();
    await assert.rejects(provider.estimate(job({}, [6, 10])), /5 or 10 seconds, not 6/);
    const noFrame = job();
    delete noFrame.items[0]!.refs;
    await assert.rejects(provider.estimate(noFrame), /exactly one start frame/);
    const two = job();
    two.items[0]!.count = 2;
    await assert.rejects(provider.estimate(two), /one clip per unit/);
    await assert.rejects(provider.estimate({ ...job(), kind: 'image' }), /makes video/);
    await assert.rejects(provider.estimate({ ...job(), model: 'nope' }), /not configured/);
  });

  it('without a budget the gate refuses with the setup pointer', async () => {
    const host = createFakeHost(tinyProject());
    const provider = createFalVideoProvider(host, { fetch: mockFalVideo().fetch, apiKey: 'k' });
    const r = await createSpendGate({ host, providers: [provider], level: 'B' }).run(job());
    assert.ok(r.status === 'refused' && r.refusal.code === 'no-budget' && /setup/.test(r.refusal.message));
  });

  it('is refused on host A', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = createFalVideoProvider(host, { fetch: mockFalVideo().fetch, apiKey: 'k' });
    const r = await createSpendGate({ host, providers: [provider], level: 'A' }).run(job());
    assert.ok(r.status === 'refused');
  });

  it('runs end to end through the gate: clips land as pending-review, ledger settles, nothing approved', async () => {
    const s = setup();
    const j = job();
    const r = await approveAndRun(s, j);
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.handle)));
    assert.equal((await s.provider.poll(r.handle)).state, 'done');
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    const p = s.host.peek();
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal(c.assets.length, 2);
    for (const a of c.assets) {
      assert.equal(a.kind, 'clip');
      assert.equal(a.file?.mime, 'video/mp4');
      assert.ok(a.tags.includes(`job:${j.id}`));
      assert.notEqual(a.status, 'approved');
    }
    assert.deepEqual([...(s.host.files.get(c.assets[0]!.file!.uri) ?? [])], [...MP4_BYTES]);
    assert.ok(p.ledger.length === 2 && p.ledger.every((e) => e.status === 'done'));
    assert.equal(p.budget?.spent, spentFromLedger(p));
    const again = await s.gate.run(j);
    assert.ok(again.status === 'refused' && again.refusal.code === 'already-submitted');
  });
});

describe('fal video provider: requests', () => {
  it('sends the start frame, the string duration and the model-specific field names, key only to the queue', async () => {
    const s = setup();
    const r = await approveAndRun(s, job());
    assert.equal(r.status, 'submitted');
    const posts = s.net.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 2);
    const body = posts[0]!.body as Record<string, unknown>;
    assert.match(posts[0]!.url, /^https:\/\/queue\.fal\.run\/fal-ai\/kling-video\//);
    assert.equal(body.duration, '5');
    assert.equal(body.image_url, REF_URI, 'the default family takes image_url');
    assert.equal('generate_audio' in body, false, 'a silent endpoint has no audio field');
    for (const c of s.net.calls) if (c.url.startsWith('https://queue.fal.run/')) assert.equal(c.headers.Authorization, 'Key test-key');
  });

  it('sound is off unless the #audio variant is chosen; the suffix never reaches fal', async () => {
    const s = setup();
    await approveAndRun(s, job({ model: silentTwin }));
    let body = s.net.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    assert.equal(body.generate_audio, false);
    assert.ok(body.start_image_url);

    const s2 = setup();
    const r = await approveAndRun(s2, job({ model: audioModel, id: 'job_mo_audio_r1' }));
    assert.equal(r.status, 'submitted');
    const post = s2.net.calls.find((c) => c.method === 'POST')!;
    body = post.body as Record<string, unknown>;
    assert.equal(body.generate_audio, true);
    assert.ok(!post.url.includes('#'), post.url);
  });

  it('the audio variant costs more, from config', async () => {
    const { provider } = setup();
    const silent = await provider.estimate(job({ model: silentTwin }));
    const loud = await provider.estimate(job({ model: audioModel }));
    assert.ok(loud.amount > silent.amount);
    assert.match(loud.basis, /sound on/);
    assert.match(silent.basis, /sound off/);
  });

  it('a failed submit of the first unit sends nothing more and fails; a later failure is recorded on the handle', async () => {
    const s = setup(mockFalVideo({ failSubmit: (n) => (n === 2 ? new Response('boom', { status: 500 }) : undefined) }));
    const r = await approveAndRun(s, job());
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'done', 'one clip was made and billed, so it is kept');
    assert.deepEqual(st.actual, { sc1_sh2: 0 });
    assert.match(st.message ?? '', /sc1_sh2: fal HTTP 500/);
    const s2 = setup(mockFalVideo({ failSubmit: () => new Response('no', { status: 401 }) }));
    const r2 = await approveAndRun(s2, job());
    assert.equal(r2.status, 'failed');
    assert.equal(s2.net.calls.filter((c) => c.method === 'POST').length, 1);
  });

  it('polls while the queue works', async () => {
    const s = setup(mockFalVideo({ status: () => 'IN_PROGRESS' }));
    const r = await approveAndRun(s, job());
    if (r.status !== 'submitted') throw new Error('not submitted');
    assert.equal((await s.provider.poll(r.handle)).state, 'running');
  });

  it('refuses a missing key before sending anything', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const net = mockFalVideo();
    const provider = createFalVideoProvider(host, { fetch: net.fetch, apiKey: () => undefined });
    const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
    const j = job();
    await gate.run(j);
    const p = host.peek();
    host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
    const r = await gate.run(j);
    assert.equal(r.status, 'failed');
    assert.equal(net.calls.length, 0);
  });
});

describe('fal video: result problems release the reservation', () => {
  it('a COMPLETED request with no video fails the poll, so collect settles the ledger instead of leaving it submitted', async () => {
    const s = setup(mockFalVideo({ noVideo: () => true }));
    const j = { ...job(), items: [job().items[0]!] };
    const r = await approveAndRun(s, j);
    if (r.status !== 'submitted') throw new Error('not submitted');
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'failed');
    assert.match(st.message ?? '', /no video/);
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'failed');
    const p = s.host.peek();
    assert.ok(p.ledger.length === 1 && p.ledger.every((e) => e.status === 'failed'), JSON.stringify(p.ledger));
    assert.equal(p.budget?.spent, 0);
    assert.equal(c.assets.length, 0);
  });

  it('when some clips are made and one is not, poll is done with that unit at 0 and fetch returns only the good clip', async () => {
    const s = setup(mockFalVideo({ error: (n) => (n === 2 ? 'content policy' : undefined) }));
    const r = await approveAndRun(s, job());
    if (r.status !== 'submitted') throw new Error('not submitted');
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'done');
    assert.deepEqual(st.actual, { sc1_sh2: 0 });
    assert.match(st.message ?? '', /1 of 2 clips failed: sc1_sh2: content policy/);
    const c = await s.gate.collect(r.handle);
    assert.deepEqual(c.assets.map((a) => a.id), ['sc1_sh1-motion']);
    const p = s.host.peek();
    assert.equal(p.ledger.find((e) => e.unit === 'sc1_sh2')?.actual, 0);
    assert.ok((p.ledger.find((e) => e.unit === 'sc1_sh1')?.actual ?? 0) > 0);
  });
});

describe('fal video: transient and final result problems', () => {
  it('a 5xx or a network error reading the result is not final: the job stays running and a later collect records the clip', async () => {
    for (const kind of ['5xx', 'throw'] as const) {
      let broken = true;
      const s = setup(mockFalVideo({ resultFail: () => (broken ? kind : undefined) }));
      const j = { ...job(), items: [job().items[0]!] };
      const r = await approveAndRun(s, j);
      if (r.status !== 'submitted') throw new Error('not submitted');
      const c1 = await s.gate.collect(r.handle);
      assert.equal(c1.status.state, 'running', kind);
      assert.ok(s.host.peek().ledger.every((e) => e.status === 'submitted'), 'the reservation is still held, not written off');
      broken = false;
      const c2 = await s.gate.collect(r.handle);
      assert.equal(c2.status.state, 'done', kind);
      assert.equal(c2.assets.length, 1);
      assert.ok(s.host.peek().ledger.every((e) => e.status === 'done' && (e.actual ?? 0) > 0), 'billed once the clip is recorded');
    }
  });

  it('a 4xx reading the result is final: failed, released, unbilled', async () => {
    const s = setup(mockFalVideo({ resultFail: () => '4xx' }));
    const j = { ...job(), items: [job().items[0]!] };
    const r = await approveAndRun(s, j);
    if (r.status !== 'submitted') throw new Error('not submitted');
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'failed');
    assert.match(c.status.message ?? '', /HTTP 404/);
    assert.ok(s.host.peek().ledger.every((e) => e.status === 'failed'));
  });

  it('an unexpected queue status is final for that unit: it is left out of fetch and settles at 0', async () => {
    const s = setup(mockFalVideo({ statusFor: (n) => (n === 2 ? 'CANCELLED' : undefined) }));
    const r = await approveAndRun(s, job());
    if (r.status !== 'submitted') throw new Error('not submitted');
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'done');
    assert.deepEqual(st.actual, { sc1_sh2: 0 });
    const c = await s.gate.collect(r.handle);
    assert.deepEqual(c.assets.map((a) => a.id), ['sc1_sh1-motion']);
  });

  it('when every clip of a batch fails the batch is failed and nothing is billed', async () => {
    const s = setup(mockFalVideo({ error: () => 'content policy' }));
    const r = await approveAndRun(s, job());
    if (r.status !== 'submitted') throw new Error('not submitted');
    const c = await s.gate.collect(r.handle);
    assert.equal(c.status.state, 'failed');
    assert.match(c.status.message ?? '', /sc1_sh1: content policy.*sc1_sh2: content policy/);
    assert.equal(c.assets.length, 0);
    const p = s.host.peek();
    assert.ok(p.ledger.length === 2 && p.ledger.every((e) => e.status === 'failed' && (e.actual ?? 0) === 0));
    assert.equal(p.budget?.spent, 0);
  });
});

describe('fal video: limits and config', () => {
  it('fitSeconds covers the shot by default and can be told to take the nearest', () => {
    assert.deepEqual(fitSeconds(6, [5, 10]), { seconds: 10, changed: true, capped: false });
    assert.deepEqual(fitSeconds(5, [5, 10]), { seconds: 5, changed: false, capped: false });
    assert.deepEqual(fitSeconds(4, [5, 10]), { seconds: 5, changed: true, capped: false });
    assert.deepEqual(fitSeconds(14, [5, 10]), { seconds: 10, changed: true, capped: true });
    assert.deepEqual(fitSeconds(6, [5, 10], 'nearest'), { seconds: 5, changed: true, capped: false });
  });

  it('snapSeconds picks the nearest allowed length, ties to the shorter', () => {
    assert.deepEqual(snapSeconds(5, [5, 10]), { seconds: 5, changed: false });
    assert.deepEqual(snapSeconds(6, [5, 10]), { seconds: 5, changed: true });
    assert.deepEqual(snapSeconds(8, [5, 10]), { seconds: 10, changed: true });
    assert.deepEqual(snapSeconds(7.5, [5, 10]), { seconds: 5, changed: true });
    assert.deepEqual(snapSeconds(30, [5, 10]), { seconds: 10, changed: true });
  });

  it('every configured model has request rules, and only the sound variants turn sound on', () => {
    assert.ok(models.length >= 2);
    for (const m of models) {
      const l = falVideoLimits(m);
      assert.ok(l, `${m} has rules`);
      assert.equal(l.audio, m.endsWith(AUDIO_SUFFIX));
      if (l.audio) assert.ok(l.audioField, 'a sound variant needs an endpoint with an audio field');
      assert.equal(splitModel(m).endpoint.includes('#'), false);
    }
  });

  it('config entries carry a source and are not stale; the block sits right after manual', () => {
    for (const [id, m] of Object.entries(entry.models)) {
      assert.match(m.source, /https:\/\/fal\.ai\//, id);
      assert.equal(m.price.per, 'second');
    }
    assert.deepEqual(staleModels(config, '2026-11-09').filter((s) => s.provider === FAL_VIDEO_PROVIDER_ID), []);
    const order = Object.keys(JSON.parse(readFileSync(CONFIG_URL, 'utf8')).providers);
    assert.equal(order.indexOf('fal-video'), order.indexOf('manual') + 1);
  });
});
