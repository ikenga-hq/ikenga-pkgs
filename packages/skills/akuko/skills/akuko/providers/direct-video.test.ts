// akuko — direct video providers (gemini-video, kling-video, byteplus-video): shared behaviour plus each API's
// request shape. Network is mocked (providers/__fixtures__/direct-net.ts); nothing here calls a provider.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { checkIntegrity } from '../schema/integrity.ts';
import type { AkukoProject } from '../schema/akuko-project.ts';
import { loadProviderConfig, priceFor } from './config.ts';
import { costProblems, type Job, type Provider, type WaveOneHost } from './contract.ts';
import { SpendGateBypassError, createSpendGate, isSealed } from '../spend/gate.ts';
import { spentFromLedger } from '../spend/ledger.ts';
import { createFakeHost, tinyProject } from './__fixtures__/fake-host.ts';
import { REF_URI, type MockNet } from './gemini-image/__fixtures__/mock-net.ts';
import { MP4_BYTES, mockArk, mockGeminiVideo, mockKling, type DirectMockOptions } from './__fixtures__/direct-net.ts';
import { GEMINI_VIDEO_PROVIDER_ID, createGeminiVideoProvider, geminiVideoLimits } from './gemini-video/index.ts';
import { KLING_VIDEO_PROVIDER_ID, createKlingVideoProvider, klingToken, klingVideoLimits } from './kling-video/index.ts';
import { BYTEPLUS_VIDEO_PROVIDER_ID, byteplusVideoLimits, createByteplusVideoProvider } from './byteplus-video/index.ts';
import { videoLimitsFor } from './video-limits.ts';

const NOW = '2026-11-12T10:00:00Z';
const config = loadProviderConfig();
const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 50, currency: 'USD', spent: 0 } });

interface Spec {
  id: string;
  keyEnvs: string[];
  mock(o?: DirectMockOptions): MockNet;
  make(host: WaveOneHost, net: MockNet, keyless?: boolean): Provider;
  /** Two lengths the default model makes. */
  seconds: [number, number];
  /** A length it does not make, and the words of the refusal. */
  bad: [number, RegExp];
  apiHost: string;
}

const SPECS: Spec[] = [
  {
    id: GEMINI_VIDEO_PROVIDER_ID,
    keyEnvs: ['GEMINI_API_KEY'],
    mock: mockGeminiVideo,
    make: (host, net, keyless) => createGeminiVideoProvider(host, { fetch: net.fetch, apiKey: keyless ? () => undefined : 'test-key', now: () => NOW }),
    seconds: [5, 8],
    bad: [16, /3 to 15 seconds, not 16/],
    apiHost: 'generativelanguage.googleapis.com',
  },
  {
    id: KLING_VIDEO_PROVIDER_ID,
    keyEnvs: ['KLING_ACCESS_KEY', 'KLING_SECRET_KEY'],
    mock: mockKling,
    make: (host, net, keyless) => createKlingVideoProvider(host, { fetch: net.fetch, accessKey: keyless ? () => undefined : 'ak-test', secretKey: 'sk-test', now: () => NOW, nowS: () => 1_800_000_000 }),
    seconds: [5, 10],
    bad: [6, /5 or 10 seconds, not 6/],
    apiHost: 'api-singapore.klingai.com',
  },
  {
    id: BYTEPLUS_VIDEO_PROVIDER_ID,
    keyEnvs: ['ARK_API_KEY'],
    mock: mockArk,
    make: (host, net, keyless) => createByteplusVideoProvider(host, { fetch: net.fetch, apiKey: keyless ? () => undefined : 'ark-test', now: () => NOW }),
    seconds: [5, 12],
    bad: [3, /4 to 15 seconds, not 3/],
    apiHost: 'ark.ap-southeast.bytepluses.com',
  },
];

const job = (provider: string, seconds: [number, number], over: Partial<Job> = {}): Job => ({
  id: 'job_mo_direct_r1',
  stage: 'motion',
  kind: 'video',
  provider,
  label: 'Clips',
  items: [
    { unit: 'sc1_sh1', prompt: 'Mara walks along the pier', output: 'clip', duration_s: seconds[0], aspect_ratio: '16:9', refs: [{ id: 'kf1', uri: REF_URI, role: 'start-frame' }] },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'clip', duration_s: seconds[1], refs: [{ id: 'kf2', uri: REF_URI, role: 'start-frame' }] },
  ],
  ...over,
});

function approve(host: ReturnType<typeof createFakeHost>, id: string): void {
  const p = host.peek();
  host.set({ ...p, pending_spend: p.pending_spend.map((x) => (x.id === id ? { ...x, status: 'approved' as const } : x)) });
}

for (const spec of SPECS) {
  const entry = config.providers[spec.id]!;
  const setup = (o?: DirectMockOptions) => {
    const net = spec.mock(o);
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = spec.make(host, net);
    const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
    return { net, host, provider, gate };
  };
  const runIt = async (s: ReturnType<typeof setup>, j: Job) => {
    assert.equal((await s.gate.run(j)).status, 'awaiting-approval');
    approve(s.host, j.id);
    return s.gate.run(j);
  };

  describe(`${spec.id}: contract`, () => {
    it('is sealed, a paid direct API on hosts A, B and C, video only, keys named in config', () => {
      const { provider } = setup();
      assert.ok(isSealed(provider));
      assert.equal(provider.billing, 'direct-api');
      assert.deepEqual([...provider.hosts], ['A', 'B', 'C']);
      assert.deepEqual([...provider.kinds], ['video']);
      assert.equal(provider.capabilities.i2v, true);
      assert.equal(entry.example, false);
      assert.deepEqual([entry.key_env, entry.secret_env].filter(Boolean), spec.keyEnvs);
      assert.ok(entry.network?.domains.includes(spec.apiHost));
      for (const [model, m] of Object.entries(entry.models)) {
        assert.ok(videoLimitsFor(spec.id, model), `${model} has request rules`);
        assert.equal(m.price.per, 'second');
        assert.match(m.source, /read 2026-11-12/);
        assert.match(m.source, /https:\/\//);
      }
    });

    it('direct submit() throws SpendGateBypassError and sends nothing', async () => {
      const { provider, net, host } = setup();
      await assert.rejects(provider.submit(job(spec.id, spec.seconds)), SpendGateBypassError);
      assert.equal(net.calls.length, 0);
      assert.equal(host.writes(), 0);
    });

    it('estimate() is price per second x seconds from config, with no network and no write', async () => {
      const { provider, net, host } = setup();
      const j = job(spec.id, spec.seconds);
      const c = await provider.estimate(j);
      const price = priceFor(config, spec.id).amount;
      assert.deepEqual(costProblems(j, c), []);
      assert.ok(Math.abs(c.amount - price * (spec.seconds[0] + spec.seconds[1])) < 1e-9);
      assert.ok(Math.abs((c.per_unit.sc1_sh1 ?? 0) - price * spec.seconds[0]) < 1e-9);
      assert.deepEqual(await provider.estimate(j), c);
      assert.equal(net.calls.length, 0);
      assert.equal(host.writes(), 0);
    });

    it('refuses a length the model cannot make, a missing start frame, two clips per unit, another kind or model', async () => {
      const { provider } = setup();
      await assert.rejects(provider.estimate(job(spec.id, [spec.bad[0], spec.seconds[1]])), spec.bad[1]);
      const noFrame = job(spec.id, spec.seconds);
      delete noFrame.items[0]!.refs;
      await assert.rejects(provider.estimate(noFrame), /exactly one start frame/);
      const two = job(spec.id, spec.seconds);
      two.items[0]!.count = 2;
      await assert.rejects(provider.estimate(two), /one clip per unit/);
      await assert.rejects(provider.estimate({ ...job(spec.id, spec.seconds), kind: 'image' }), /makes video/);
      await assert.rejects(provider.estimate({ ...job(spec.id, spec.seconds), model: 'nope' }), /not configured/);
    });

    it('runs end to end through the gate: clips land pending-review, ledger settles, the key goes only to the API host', async () => {
      const s = setup();
      const j = job(spec.id, spec.seconds);
      const r = await runIt(s, j);
      assert.equal(r.status, 'submitted', JSON.stringify(r));
      if (r.status !== 'submitted') return;
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.handle)));
      const c = await s.gate.collect(r.handle);
      assert.equal(c.status.state, 'done', c.status.message);
      const p = s.host.peek();
      assert.deepEqual(checkIntegrity(p), []);
      assert.equal(c.assets.length, 2);
      for (const a of c.assets) {
        assert.equal(a.kind, 'clip');
        assert.equal(a.provider, spec.id);
        assert.notEqual(a.status, 'approved');
        assert.deepEqual([...(s.host.files.get(a.file!.uri) ?? [])], [...MP4_BYTES]);
      }
      assert.ok(p.ledger.length === 2 && p.ledger.every((e) => e.status === 'done'));
      assert.equal(p.budget?.spent, spentFromLedger(p));
      for (const call of s.net.calls) {
        const authed = Object.keys(call.headers).some((h) => /^(authorization|x-goog-api-key)$/i.test(h));
        if (authed) assert.equal(new URL(call.url).host, spec.apiHost, `credentials sent to ${call.url}`);
      }
      const again = await s.gate.run(j);
      assert.ok(again.status === 'refused' && again.refusal.code === 'already-submitted');
    });

    it('a status read that fails with a 5xx leaves the clip running; a later collect finishes it', async () => {
      let flaky = true;
      const s = setup({ statusFail: () => flaky });
      const r = await runIt(s, job(spec.id, spec.seconds));
      assert.equal(r.status, 'submitted');
      if (r.status !== 'submitted') return;
      assert.equal((await s.gate.collect(r.handle)).status.state, 'running');
      assert.ok(s.host.peek().ledger.every((e) => e.status === 'submitted'), 'still reserved, not written off');
      flaky = false;
      assert.equal((await s.gate.collect(r.handle)).status.state, 'done');
    });

    it('a batch where one clip fails: the made clip is recorded and billed, the other settles at 0', async () => {
      const failed = spec.id === GEMINI_VIDEO_PROVIDER_ID ? 'FAILED' : 'failed';
      const s = setup({ statusFor: (n) => (n === 2 ? failed : undefined) });
      const r = await runIt(s, job(spec.id, spec.seconds));
      if (r.status !== 'submitted') return assert.fail(JSON.stringify(r));
      const c = await s.gate.collect(r.handle);
      assert.equal(c.status.state, 'done');
      assert.match(c.status.message ?? '', /1 of 2 clips failed/);
      assert.equal(c.assets.length, 1);
      const p = s.host.peek();
      const e2 = p.ledger.find((e) => e.unit === 'sc1_sh2')!;
      assert.equal(e2.actual, 0);
      assert.deepEqual(checkIntegrity(p), []);
    });

    it('a refused first request fails the run, sends nothing more and settles the reservation as failed', async () => {
      const s = setup({ failCreate: () => new Response(JSON.stringify({ error: { message: 'bad' }, code: 1201, message: 'bad' }), { status: 400 }) });
      const r = await runIt(s, job(spec.id, spec.seconds));
      assert.equal(r.status, 'failed');
      assert.equal(s.net.calls.filter((c) => c.method === 'POST').length, 1);
      assert.ok(s.host.peek().ledger.every((e) => e.status === 'failed'));
    });

    it('with no key it sends nothing and says which variable to set', async () => {
      const net = spec.mock();
      const host = createFakeHost(withBudget(tinyProject()));
      const provider = spec.make(host, net, true);
      const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
      const j = job(spec.id, spec.seconds);
      await gate.run(j);
      approve(host, j.id);
      const r = await gate.run(j);
      assert.ok(r.status === 'failed' && new RegExp(spec.keyEnvs[0]!).test(r.error), JSON.stringify(r));
      assert.equal(net.calls.length, 0);
    });

    it('is refused on host A without the pasted-key acknowledgement', async () => {
      const net = spec.mock();
      const host = createFakeHost(withBudget(tinyProject()));
      const provider = spec.make(host, net);
      const r = await createSpendGate({ host, providers: [provider], level: 'A', now: () => NOW }).run(job(spec.id, spec.seconds));
      assert.ok(r.status === 'refused' && r.refusal.code === 'paid-direct-on-host-a' && /pasted/.test(r.refusal.message));
      assert.equal(net.calls.length, 0);
    });
  });
}

describe('gemini-video: request shape', () => {
  it('sends the start frame and the length, resolution, aspect and uri delivery; follows the download redirect without the key', async () => {
    const net = mockGeminiVideo();
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = createGeminiVideoProvider(host, { fetch: net.fetch, apiKey: 'test-key', now: () => NOW });
    const gate = createSpendGate({ host, providers: [provider], level: 'C', now: () => NOW });
    const j = job(GEMINI_VIDEO_PROVIDER_ID, [5, 8]);
    await gate.run(j);
    approve(host, j.id);
    const r = await gate.run(j);
    if (r.status !== 'submitted') return assert.fail(JSON.stringify(r));
    const body = net.calls.find((c) => c.method === 'POST')!.body as Record<string, any>;
    assert.ok(!String(body.model).includes('#'), 'the variant suffix is stripped');
    assert.equal(body.input[0].type, 'image');
    assert.equal(body.input[1].type, 'text');
    assert.deepEqual(body.response_format, { type: 'video', duration: '5s', resolution: geminiVideoLimits(entryDefault(GEMINI_VIDEO_PROVIDER_ID))!.resolution, aspect_ratio: '16:9', delivery: 'uri' });
    assert.equal(body.generation_config.video_config.task, 'image_to_video');
    assert.equal(body.store, false);
    await gate.collect(r.handle);
    const dl = net.calls.find((c) => c.url.startsWith('https://cdn.example-video.test/'));
    assert.ok(dl, 'the redirect was followed');
    assert.equal(Object.keys(dl.headers).length, 0, 'no key on the redirect');
  });

  it('refuses an aspect ratio the model does not make, and a model without a resolution variant', async () => {
    const provider = createGeminiVideoProvider(createFakeHost(tinyProject()), { fetch: mockGeminiVideo().fetch, apiKey: 'k' });
    const j = job(GEMINI_VIDEO_PROVIDER_ID, [5, 8]);
    j.items[0]!.aspect_ratio = '1:1';
    await assert.rejects(provider.estimate(j), /16:9 or 9:16/);
    assert.equal(geminiVideoLimits('gemini-omni-9-flash'), undefined);
  });

  it('every configured model carries #audio: the model makes sound and has no switch', () => {
    for (const m of Object.keys(config.providers[GEMINI_VIDEO_PROVIDER_ID]!.models)) assert.ok(m.endsWith('#audio'), m);
  });
});

describe('kling-video: auth and request shape', () => {
  it('mints an HS256 JWT with iss, exp = now + 1800 and nbf = now - 5, signed with the secret key', () => {
    const t = klingToken('ak', 'sk', 1000);
    const [h, b, sig] = t.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'HS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(b!, 'base64url').toString()), { iss: 'ak', exp: 2800, nbf: 995 });
    assert.equal(sig, createHmac('sha256', 'sk').update(`${h}.${b}`).digest('base64url'));
  });

  it('sends model_name, raw base64 (no data: prefix), duration as a string, mode and sound; the secret never leaves', async () => {
    const net = mockKling();
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = createKlingVideoProvider(host, { fetch: net.fetch, accessKey: 'ak-test', secretKey: 'sk-secret-value', now: () => NOW });
    const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
    const model = Object.keys(config.providers[KLING_VIDEO_PROVIDER_ID]!.models).find((m) => m.endsWith('#audio'))!;
    const j = job(KLING_VIDEO_PROVIDER_ID, [5, 10], { model });
    await gate.run(j);
    approve(host, j.id);
    const r = await gate.run(j);
    assert.equal(r.status, 'submitted', JSON.stringify(r));
    const post = net.calls.find((c) => c.method === 'POST')!;
    const body = post.body as Record<string, string>;
    const l = klingVideoLimits(model)!;
    assert.equal(body.model_name, l.modelName);
    assert.ok(!body.image!.startsWith('data:'));
    assert.equal(body.duration, '5');
    assert.equal(body.mode, l.mode);
    assert.equal(body.sound, 'on');
    assert.match(post.headers.Authorization!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(net.calls.every((c) => !JSON.stringify(c).includes('sk-secret-value')));
  });

  it('turns Kling error codes into plain words (1102: package used up)', async () => {
    const net = mockKling({ failCreate: () => new Response(JSON.stringify({ code: 1102, message: 'balance not enough' }), { status: 429 }) });
    const host = createFakeHost(withBudget(tinyProject()));
    const gate = createSpendGate({ host, providers: [createKlingVideoProvider(host, { fetch: net.fetch, accessKey: 'a', secretKey: 's', now: () => NOW })], level: 'B', now: () => NOW });
    const j = job(KLING_VIDEO_PROVIDER_ID, [5, 10]);
    await gate.run(j);
    approve(host, j.id);
    const r = await gate.run(j);
    assert.ok(r.status === 'failed' && /1102/.test(r.error) && /package/.test(r.error), JSON.stringify(r));
  });

  it('refuses a start frame Kling cannot take (only PNG or JPEG), sound on a family without it', async () => {
    const net = mockKling();
    const host = createFakeHost(withBudget(tinyProject()));
    const gate = createSpendGate({ host, providers: [createKlingVideoProvider(host, { fetch: net.fetch, accessKey: 'a', secretKey: 's', now: () => NOW })], level: 'B', now: () => NOW });
    const j = job(KLING_VIDEO_PROVIDER_ID, [5, 10]);
    for (const i of j.items) i.refs = [{ id: 'kf', uri: 'data:image/webp;base64,AAAA', role: 'start-frame' }];
    await gate.run(j);
    approve(host, j.id);
    const r = await gate.run(j);
    assert.ok(r.status === 'failed' && /PNG or JPEG/.test(r.error), JSON.stringify(r));
    assert.equal(net.calls.length, 0);
    assert.equal(klingVideoLimits('kling-v2-6#pro#audio'), undefined, 'Kling 2.6 image-to-video has no native audio in the capability map');
  });
});

describe('byteplus-video: request shape and unverified prices', () => {
  it('sends text + first_frame data URI, resolution, ratio adaptive, whole-second duration, generate_audio and no watermark', async () => {
    const net = mockArk();
    const host = createFakeHost(withBudget(tinyProject()));
    const gate = createSpendGate({ host, providers: [createByteplusVideoProvider(host, { fetch: net.fetch, apiKey: 'k', now: () => NOW })], level: 'B', now: () => NOW });
    const model = Object.keys(config.providers[BYTEPLUS_VIDEO_PROVIDER_ID]!.models).find((m) => m.endsWith('#audio'))!;
    const j = job(BYTEPLUS_VIDEO_PROVIDER_ID, [5, 12], { model });
    await gate.run(j);
    approve(host, j.id);
    assert.equal((await gate.run(j)).status, 'submitted');
    const body = net.calls.find((c) => c.method === 'POST')!.body as Record<string, any>;
    const l = byteplusVideoLimits(model)!;
    assert.equal(body.model, l.modelId);
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[1].type, 'image_url');
    assert.equal(body.content[1].role, 'first_frame');
    assert.match(body.content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(body.resolution, l.resolution);
    assert.equal(body.ratio, 'adaptive');
    assert.equal(body.duration, 5);
    assert.equal(body.generate_audio, true);
    assert.equal(body.watermark, false);
  });

  it('a model listed as price unverified cannot be estimated, so the gate never runs it', async () => {
    const unverified = Object.keys(config.providers[BYTEPLUS_VIDEO_PROVIDER_ID]!.unverified_models ?? {});
    assert.ok(unverified.length > 0);
    const net = mockArk();
    const host = createFakeHost(withBudget(tinyProject()));
    const provider = createByteplusVideoProvider(host, { fetch: net.fetch, apiKey: 'k' });
    await assert.rejects(provider.estimate(job(BYTEPLUS_VIDEO_PROVIDER_ID, [5, 12], { model: unverified[0]! })), /price unverified/);
    const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
    await assert.rejects(gate.run(job(BYTEPLUS_VIDEO_PROVIDER_ID, [5, 12], { model: unverified[0]! })), /price unverified/);
    assert.deepEqual(host.peek().pending_spend, []);
    assert.equal(net.calls.length, 0);
  });

  it('knows each family\'s lengths and resolutions; 1080p is refused on the fast family', () => {
    const fast = Object.keys(config.providers[BYTEPLUS_VIDEO_PROVIDER_ID]!.models).find((m) => /fast/.test(m))!;
    const base = fast.split('#')[0]!;
    assert.equal(byteplusVideoLimits(`${base}#1080p`), undefined);
    assert.deepEqual(byteplusVideoLimits(`${base}#720p`)!.allowedSeconds[0], 4);
  });
});

function entryDefault(id: string): string {
  return config.providers[id]!.default_model;
}
