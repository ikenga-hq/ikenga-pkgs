// akuko — fal lip-sync provider tests (contract-suite checks live in providers/contract.test.ts). Network is mocked; nothing here calls fal.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { checkIntegrity } from '../../../schema/integrity.ts';
import type { AkukoProject } from '../../../schema/akuko-project.ts';
import { CONFIG_URL, loadProviderConfig, staleModels } from '../../config.ts';
import { costProblems, type Job } from '../../contract.ts';
import { SpendGateBypassError, createSpendGate, isSealed } from '../../../spend/gate.ts';
import { createFakeHost, tinyProject } from '../../__fixtures__/fake-host.ts';
import { REF_URI } from '../../gemini-image/__fixtures__/mock-net.ts';
import { MP4_BYTES, mockFalLipsync } from './__fixtures__/mock-net.ts';
import { FAL_LIPSYNC_PROVIDER_ID, billedSeconds, createFalLipsyncProvider, defaultLipsyncModel, falLipsyncLimits, mediaRefLoader, splitModel } from './index.ts';
import { readFileSync } from 'node:fs';

const NOW = '2026-11-10T10:00:00Z';
const config = loadProviderConfig();
const entry = config.providers[FAL_LIPSYNC_PROVIDER_ID]!;
const models = Object.keys(entry.models);
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 20, currency: 'USD', spent: 0 } });

const AUDIO_URI = 'data:audio/wav;base64,UklGRg==';
const CLIP_URI = 'data:video/mp4;base64,AAAAGGZ0eXA=';

/** Model ids by role, read from config (never written in code). */
const IMAGE_DEFAULT = defaultLipsyncModel(config, 'image')!;
const VIDEO_DEFAULT = defaultLipsyncModel(config, 'video')!;
const modelFor = (re: RegExp): string => models.find((m) => re.test(m))!;
const H3 = modelFor(/h3-max/);
const FABRIC_480 = modelFor(/fabric.*#480p/);
const FABRIC_720 = modelFor(/fabric.*#720p/);
const KLING = modelFor(/kling/);
const VEED = modelFor(/veed\/lipsync/);

const stillJob = (over: Partial<Job> = {}, seconds: [number, number] = [6, 12]): Job => ({
  id: 'job_ls_test_r1',
  stage: 'motion',
  kind: 'video',
  provider: FAL_LIPSYNC_PROVIDER_ID,
  label: 'Lip-sync from stills',
  items: [
    { unit: 'sc1_sh1', prompt: '', output: 'lipsync', duration_s: seconds[0], refs: [{ id: 'kf1', uri: REF_URI, role: 'start-frame' }, { id: 'line1', uri: AUDIO_URI, role: 'audio' }] },
    { unit: 'sc1_sh2', prompt: '', output: 'lipsync', duration_s: seconds[1], refs: [{ id: 'kf2', uri: REF_URI, role: 'start-frame' }, { id: 'line2', uri: AUDIO_URI, role: 'audio' }] },
  ],
  ...over,
});

const clipJob = (over: Partial<Job> = {}, seconds: [number, number] = [5, 10]): Job => ({
  ...stillJob({}, seconds),
  items: [
    { unit: 'sc1_sh1', prompt: '', output: 'lipsync', duration_s: seconds[0], refs: [{ id: 'c1', uri: CLIP_URI, role: 'source-video' }, { id: 'line1', uri: AUDIO_URI, role: 'audio' }] },
    { unit: 'sc1_sh2', prompt: '', output: 'lipsync', duration_s: seconds[1], refs: [{ id: 'c2', uri: CLIP_URI, role: 'source-video' }, { id: 'line2', uri: AUDIO_URI, role: 'audio' }] },
  ],
  ...over,
});

function setup(net = mockFalLipsync()) {
  const host = createFakeHost(withBudget(tinyProject()));
  const provider = createFalLipsyncProvider(host, { fetch: net.fetch, apiKey: 'test-key', now: () => NOW });
  const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
  return { host, provider, gate, net };
}

async function approveAndRun(s: ReturnType<typeof setup>, j: Job) {
  assert.equal((await s.gate.run(j)).status, 'awaiting-approval');
  const p = s.host.peek();
  s.host.set({ ...p, pending_spend: p.pending_spend.map((x) => (x.id === j.id ? { ...x, status: 'approved' as const } : x)) });
  return s.gate.run(j);
}

/** The JSON body of the first POST of a run, and its url. */
async function firstPost(j: Job) {
  const s = setup();
  const r = await approveAndRun(s, j);
  assert.equal(r.status, 'submitted', JSON.stringify(r));
  const post = s.net.calls.find((c) => c.method === 'POST')!;
  return { post, body: post.body as Record<string, unknown>, s };
}

describe('fal lip-sync provider: contract', () => {
  it('is sealed, paid direct API, hosts B and C only (R-11), video kind', () => {
    const { provider } = setup();
    assert.ok(isSealed(provider));
    assert.equal(provider.billing, 'direct-api');
    assert.deepEqual([...provider.hosts], ['B', 'C']);
    assert.deepEqual([...provider.kinds], ['video']);
    assert.equal(entry.example, false);
    assert.equal(entry.key_env, 'FAL_KEY');
  });

  it('direct submit() throws SpendGateBypassError and sends nothing', async () => {
    const { provider, host, net } = setup();
    await assert.rejects(provider.submit(stillJob()), SpendGateBypassError);
    assert.equal(host.writes(), 0);
    assert.equal(net.calls.length, 0);
  });

  it('is refused on host A', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = createFalLipsyncProvider(host, { fetch: mockFalLipsync().fetch, apiKey: 'k' });
    const r = await createSpendGate({ host, providers: [provider], level: 'A' }).run(stillJob());
    assert.ok(r.status === 'refused');
  });

  it('without a budget the gate refuses with the setup pointer', async () => {
    const host = createFakeHost(tinyProject());
    const provider = createFalLipsyncProvider(host, { fetch: mockFalLipsync().fetch, apiKey: 'k' });
    const r = await createSpendGate({ host, providers: [provider], level: 'B' }).run(stillJob());
    assert.ok(r.status === 'refused' && r.refusal.code === 'no-budget' && /setup/.test(r.refusal.message));
  });

  it('a missing key is refused before anything is sent', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const net = mockFalLipsync();
    const provider = createFalLipsyncProvider(host, { fetch: net.fetch, apiKey: () => undefined });
    const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
    const j = stillJob();
    await gate.run(j);
    const p = host.peek();
    host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
    assert.equal((await gate.run(j)).status, 'failed');
    assert.equal(net.calls.length, 0);
  });
});

describe('fal lip-sync provider: request bodies are pinned per model', () => {
  it('image default: image_url + audio_url + resolution "768P", nothing else', async () => {
    const { post, body } = await firstPost(stillJob({ model: H3 }));
    assert.equal(post.url, `https://queue.fal.run/${H3}`);
    assert.deepEqual(body, { image_url: REF_URI, audio_url: AUDIO_URI, resolution: '768P' });
    assert.equal(post.headers.Authorization, 'Key test-key');
  });

  it('with no model named, a still job runs the image default and a clip job the video default', async () => {
    assert.equal(IMAGE_DEFAULT, H3);
    assert.equal(VIDEO_DEFAULT, KLING);
    const a = await firstPost(stillJob());
    assert.equal(a.post.url, `https://queue.fal.run/${IMAGE_DEFAULT}`);
    const b = await firstPost(clipJob());
    assert.equal(b.post.url, `https://queue.fal.run/${VIDEO_DEFAULT}`);
  });

  it('image fallback (480p): the #resolution suffix becomes the resolution field and never reaches the url', async () => {
    const { post, body } = await firstPost(stillJob({ model: FABRIC_480 }));
    assert.equal(post.url, `https://queue.fal.run/${splitModel(FABRIC_480).endpoint}`);
    assert.ok(!post.url.includes('#'));
    assert.deepEqual(body, { image_url: REF_URI, audio_url: AUDIO_URI, resolution: '480p' });
  });

  it('image fallback (720p): same endpoint, resolution "720p"', async () => {
    const { post, body } = await firstPost(stillJob({ model: FABRIC_720 }));
    assert.equal(post.url, `https://queue.fal.run/${splitModel(FABRIC_720).endpoint}`);
    assert.deepEqual(body, { image_url: REF_URI, audio_url: AUDIO_URI, resolution: '720p' });
  });

  it('video default: video_url + audio_url, nothing else', async () => {
    const { post, body } = await firstPost(clipJob({ model: KLING }));
    assert.equal(post.url, `https://queue.fal.run/${KLING}`);
    assert.deepEqual(body, { video_url: CLIP_URI, audio_url: AUDIO_URI });
  });

  it('video fallback: video_url + audio_url, nothing else', async () => {
    const { post, body } = await firstPost(clipJob({ model: VEED }));
    assert.equal(post.url, `https://queue.fal.run/${VEED}`);
    assert.deepEqual(body, { video_url: CLIP_URI, audio_url: AUDIO_URI });
  });

  it('an https ref is passed through as the url, not downloaded', async () => {
    const j = clipJob();
    j.items[0]!.refs![0]!.uri = 'https://files.example.com/a.mp4';
    j.items[0]!.refs![1]!.uri = 'https://files.example.com/a.wav';
    const { body, s } = await firstPost(j);
    assert.equal(body.video_url, 'https://files.example.com/a.mp4');
    assert.equal(body.audio_url, 'https://files.example.com/a.wav');
    assert.ok(!s.net.calls.some((c) => c.method === 'GET' && c.url.startsWith('https://files.example.com/')));
  });

  it('a file path is read from disk with its audio/video type and sent as a data: uri', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-ls-'));
    try {
      writeFileSync(join(dir, 'line.wav'), Buffer.from([1, 2, 3]));
      writeFileSync(join(dir, 'clip.mp4'), Buffer.from([4, 5]));
      const load = mediaRefLoader(undefined, dir);
      assert.deepEqual(await load('line.wav'), { mime: 'audio/wav', data: new Uint8Array([1, 2, 3]) });
      assert.equal((await load('clip.mp4')).mime, 'video/mp4');
      await assert.rejects(load('../x.wav'), /outside the project folder/);
      await assert.rejects(load('notes.txt'), /unknown/);
      const host = createFakeHost(withBudget(tinyProject()));
      const net = mockFalLipsync();
      const provider = createFalLipsyncProvider(host, { fetch: net.fetch, apiKey: 'k', loadRef: load, now: () => NOW });
      const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
      const j = clipJob({ model: VEED });
      j.items = [{ unit: 'sc1_sh1', prompt: '', output: 'lipsync', duration_s: 5, refs: [{ id: 'c', uri: 'clip.mp4', role: 'source-video' }, { id: 'l', uri: 'line.wav', role: 'audio' }] }];
      await gate.run(j);
      const p = host.peek();
      host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
      await gate.run(j);
      const body = net.calls.find((c) => c.method === 'POST')!.body as Record<string, string>;
      assert.equal(body.video_url, `data:video/mp4;base64,${Buffer.from([4, 5]).toString('base64')}`);
      assert.equal(body.audio_url, `data:audio/wav;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fal lip-sync provider: checks and estimates', () => {
  it('estimate() is price per second from config, rounded up to the model billing step, with no network or write', async () => {
    const { provider, net, host } = setup();
    const price = (m: string) => entry.models[m]!.price.amount;

    const still = stillJob({ model: H3 });
    const c = await provider.estimate(still);
    assert.deepEqual(costProblems(still, c), []);
    assert.ok(Math.abs(c.amount - price(H3) * 18) < 1e-9);
    assert.match(c.basis, /sc1_sh1 6 s/);
    assert.deepEqual(await provider.estimate(still), c);

    // Kling bills each segment up to a 5 s step: 4 s -> 5 s, 7 s -> 10 s.
    const clip = clipJob({ model: KLING }, [4, 7]);
    const k = await provider.estimate(clip);
    assert.ok(Math.abs((k.per_unit.sc1_sh1 ?? 0) - price(KLING) * 5) < 1e-9);
    assert.ok(Math.abs((k.per_unit.sc1_sh2 ?? 0) - price(KLING) * 10) < 1e-9);
    assert.match(k.basis, /sc1_sh1 5 s \(for 4 s\)/);
    assert.match(k.basis, /5 s steps/);
    assert.equal(net.calls.length, 0);
    assert.equal(host.writes(), 0);
  });

  it('billedSeconds rounds up to the step and leaves other models alone', () => {
    assert.equal(billedSeconds(4, 5), 5);
    assert.equal(billedSeconds(5, 5), 5);
    assert.equal(billedSeconds(7, 5), 10);
    assert.equal(billedSeconds(7), 7);
  });

  it('refuses audio under the model minimum or over its maximum', async () => {
    const { provider } = setup();
    await assert.rejects(provider.estimate(stillJob({ model: H3 }, [4, 6])), /needs at least 5 s of audio, not 4 s/);
    await assert.rejects(provider.estimate(stillJob({ model: H3 }, [6, 16])), /takes at most 15 s, not 16 s/);
    await assert.rejects(provider.estimate(clipJob({ model: KLING }, [1, 5])), /needs at least 2 s/);
    await assert.rejects(provider.estimate(clipJob({ model: KLING }, [5, 11])), /takes at most 10 s, not 11 s/);
    // a model with no stated limit accepts a long line
    await provider.estimate(stillJob({ model: FABRIC_480 }, [6, 40]));
  });

  it('refuses a missing audio ref, a missing or doubled picture, a wrong kind of picture for the model, a count above one, a non-video job and an unknown model', async () => {
    const { provider } = setup();
    const noAudio = stillJob({ model: H3 });
    noAudio.items[0]!.refs = noAudio.items[0]!.refs!.filter((r) => r.role !== 'audio');
    await assert.rejects(provider.estimate(noAudio), /exactly one audio segment/);

    const noPic = stillJob({ model: H3 });
    noPic.items[0]!.refs = noPic.items[0]!.refs!.filter((r) => r.role === 'audio');
    await assert.rejects(provider.estimate(noPic), /exactly one picture/);

    const both = stillJob({ model: H3 });
    both.items[0]!.refs!.push({ id: 'c', uri: CLIP_URI, role: 'source-video' });
    await assert.rejects(provider.estimate(both), /exactly one picture/);

    await assert.rejects(provider.estimate(stillJob({ model: KLING })), /gives a still but .* takes a video plus audio/);
    await assert.rejects(provider.estimate(clipJob({ model: H3 })), /gives a video but .* takes a still plus audio/);

    const two = stillJob({ model: H3 });
    two.items[0]!.count = 2;
    await assert.rejects(provider.estimate(two), /one video per unit/);
    await assert.rejects(provider.estimate({ ...stillJob({ model: H3 }), kind: 'image' }), /makes video/);
    await assert.rejects(provider.estimate({ ...stillJob(), model: 'nope' }), /not configured/);

    const mixed = stillJob();
    mixed.items[1] = clipJob().items[1]!;
    await assert.rejects(provider.estimate(mixed), /same kind/);
  });

  it('refuses a file over the model size limit before sending anything', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const host = createFakeHost(withBudget(tinyProject()));
    const net = mockFalLipsync();
    const provider = createFalLipsyncProvider(host, { fetch: net.fetch, apiKey: 'k', loadRef: async () => ({ mime: 'audio/wav', data: big }), now: () => NOW });
    const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
    const j = clipJob({ model: KLING }, [5, 5]);
    j.items = [j.items[0]!];
    await gate.run(j);
    const p = host.peek();
    host.set({ ...p, pending_spend: p.pending_spend.map((x) => ({ ...x, status: 'approved' as const })) });
    const r = await gate.run(j);
    assert.equal(r.status, 'failed');
    assert.equal(net.calls.length, 0);
  });
});

describe('fal lip-sync provider: run through the gate', () => {
  it('runs end to end: lipsync assets land as pending-review, ledger settles, nothing approved', async () => {
    const s = setup();
    const j = stillJob();
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
      assert.equal(a.kind, 'lipsync');
      assert.equal(a.file?.mime, 'video/mp4');
      assert.ok(a.tags.includes(`job:${j.id}`) && a.tags.includes(FAL_LIPSYNC_PROVIDER_ID));
      assert.notEqual(a.status, 'approved');
    }
    assert.deepEqual([...(s.host.files.get(c.assets[0]!.file!.uri) ?? [])], [...MP4_BYTES]);
    assert.ok(p.ledger.length === 2 && p.ledger.every((e) => e.status === 'done' && (e.actual ?? 0) > 0));
  });

  it('one failed unit of two is kept at 0 and the made one is recorded', async () => {
    const s = setup(mockFalLipsync({ error: (n) => (n === 2 ? 'content policy' : undefined) }));
    const r = await approveAndRun(s, stillJob());
    if (r.status !== 'submitted') throw new Error('not submitted');
    const st = await s.provider.poll(r.handle);
    assert.equal(st.state, 'done');
    assert.deepEqual(st.actual, { sc1_sh2: 0 });
    const c = await s.gate.collect(r.handle);
    assert.deepEqual(c.assets.map((a) => a.id), ['sc1_sh1-motion']);
  });

  it('a result with no video fails the unit; a 5xx reading it stays running; a 4xx is final', async () => {
    const one = (): Job => ({ ...stillJob(), items: [stillJob().items[0]!] });
    const s1 = setup(mockFalLipsync({ noVideo: () => true }));
    const r1 = await approveAndRun(s1, one());
    if (r1.status !== 'submitted') throw new Error('not submitted');
    assert.equal((await s1.provider.poll(r1.handle)).state, 'failed');

    let broken = true;
    const s2 = setup(mockFalLipsync({ resultFail: () => (broken ? '5xx' : undefined) }));
    const r2 = await approveAndRun(s2, one());
    if (r2.status !== 'submitted') throw new Error('not submitted');
    assert.equal((await s2.gate.collect(r2.handle)).status.state, 'running');
    broken = false;
    assert.equal((await s2.gate.collect(r2.handle)).status.state, 'done');

    const s3 = setup(mockFalLipsync({ resultFail: () => '4xx' }));
    const r3 = await approveAndRun(s3, one());
    if (r3.status !== 'submitted') throw new Error('not submitted');
    assert.equal((await s3.gate.collect(r3.handle)).status.state, 'failed');
  });
});

describe('fal lip-sync provider: config', () => {
  it('every configured model has request rules, a fal.ai source and a per-second price', () => {
    assert.ok(models.length >= 4);
    for (const m of models) {
      assert.ok(falLipsyncLimits(m), `${m} has rules`);
      assert.match(entry.models[m]!.source, /https:\/\/fal\.ai\//, m);
      assert.equal(entry.models[m]!.price.per, 'second');
    }
    assert.ok(defaultLipsyncModel(config, 'image') && defaultLipsyncModel(config, 'video'));
    assert.equal(falLipsyncLimits(splitModel(FABRIC_480).endpoint), undefined, 'a per-resolution endpoint needs its #resolution');
  });

  it('is not stale, and the block sits right before the example entries', () => {
    assert.deepEqual(staleModels(config, '2026-11-10').filter((s) => s.provider === FAL_LIPSYNC_PROVIDER_ID), []);
    const order = Object.keys(JSON.parse(readFileSync(CONFIG_URL, 'utf8')).providers);
    assert.equal(order.indexOf(FAL_LIPSYNC_PROVIDER_ID), order.indexOf('example-direct-image') - 1);
  });
});
