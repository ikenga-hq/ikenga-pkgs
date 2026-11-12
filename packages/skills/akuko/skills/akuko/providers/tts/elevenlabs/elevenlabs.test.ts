// akuko — ElevenLabs TTS provider (WP-12): the provider contract suite (network
// mocked, including the timing response), request shape, sealing, price per character.
// Nothing here makes a live call.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AkukoProject } from '../../../schema/akuko-project.ts';
import { checkIntegrity } from '../../../schema/integrity.ts';
import { findUnit } from '../../../schema/akuko-project.ts';
import type { Job } from '../../contract.ts';
import { HOST_LEVELS, JOB_STATES, PROVIDER_KINDS, costProblems } from '../../contract.ts';
import { loadProviderConfig, priceFor } from '../../config.ts';
import { SpendGateBypassError, createSpendGate, isSealed } from '../../../spend/gate.ts';
import { spentFromLedger } from '../../../spend/ledger.ts';
import { createFakeHost, tinyProject } from '../../__fixtures__/fake-host.ts';
import { readWordsFile } from '../../../sound/words.ts';
import { mockElevenLabs } from '../../../sound/__fixtures__/audio.ts';
import { ELEVENLABS_PROVIDER_ID, ElevenLabsError, createElevenLabsProvider } from './index.ts';

const NOW = '2026-11-09T10:00:00Z';
const config = loadProviderConfig();
const TEXT1 = 'And every night, about midnight.';
const TEXT2 = 'Oh, so gently!';

const voiceJob = (id = 'job_snd_test', model?: string): Job => ({
  id,
  stage: 'sound',
  kind: 'audio',
  provider: ELEVENLABS_PROVIDER_ID,
  ...(model ? { model } : {}),
  label: 'Voice-over',
  items: [
    { unit: 'sc1_sh1', prompt: TEXT1, output: 'vo', count: 1, duration_s: 6, refs: [{ id: 'voice_abc', role: 'voice' }] },
    { unit: 'sc1_sh2', prompt: TEXT2, output: 'vo', count: 1, duration_s: 4, refs: [{ id: 'voice_abc', role: 'voice' }] },
  ],
});

const withBudget = (p: AkukoProject): AkukoProject => ({ ...p, budget: { cap: 10, currency: 'USD', spent: 0 } });
const make = (host: ReturnType<typeof createFakeHost>, net = mockElevenLabs()) => ({ net, provider: createElevenLabsProvider(host, { fetch: net.fetch, apiKey: 'test-key', now: () => NOW }) });

const approveAll = (host: ReturnType<typeof createFakeHost>): void => {
  const p0 = host.peek();
  host.set({ ...p0, pending_spend: p0.pending_spend.map((j) => ({ ...j, status: 'approved' as const })) });
};

describe('provider contract: elevenlabs (network mocked, with timings)', () => {
  it('declares an id, kinds, hosts and capabilities of the right shape; paid direct API on A, B and C (R-11 is enforced by the gate)', () => {
    const { provider } = make(createFakeHost(tinyProject()));
    assert.match(provider.id, /^[a-z0-9][a-z0-9-]*$/);
    for (const k of provider.kinds) assert.ok(PROVIDER_KINDS.includes(k));
    for (const h of provider.hosts) assert.ok(HOST_LEVELS.includes(h));
    assert.deepEqual(provider.hosts, ['A', 'B', 'C']);
    assert.deepEqual(provider.kinds, ['audio']);
  });

  it('is sealed, and its billing, models and prices come from config with a last_verified date and a source', () => {
    const { provider } = make(createFakeHost(tinyProject()));
    assert.ok(isSealed(provider));
    const entry = config.providers[ELEVENLABS_PROVIDER_ID]!;
    assert.equal(provider.billing, entry.billing);
    assert.equal(entry.billing, 'direct-api');
    assert.equal(entry.example, false);
    assert.equal(entry.key_env, 'ELEVENLABS_API_KEY');
    for (const m of Object.values(entry.models)) {
      assert.match(m.last_verified, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(m.price.per, 'character');
      assert.match(m.source, /elevenlabs\.io/);
    }
  });

  it('estimate() is characters x the configured price, deterministic, and touches no host write', async () => {
    const host = createFakeHost(tinyProject());
    const { provider, net } = make(host);
    const job = voiceJob();
    const cost = await provider.estimate(job);
    assert.deepEqual(costProblems(job, cost), []);
    const price = priceFor(config, ELEVENLABS_PROVIDER_ID).amount;
    const chars = TEXT1.length + TEXT2.length;
    assert.ok(Math.abs(cost.amount - chars * price) < 1e-12);
    assert.ok(Math.abs(cost.per_unit['sc1_sh1']! - TEXT1.length * price) < 1e-12);
    assert.ok(cost.basis.startsWith(`${chars} characters`), cost.basis);
    assert.ok(cost.basis.includes(`${price} USD/character`), cost.basis);
    assert.deepEqual(await provider.estimate(job), cost);
    assert.equal(net.calls.length, 0, 'estimate never calls the network');
    assert.ok(!host.calls.includes('writeState') && !host.calls.includes('storeAsset'));
  });

  it('a pricier model costs more, from config', async () => {
    const { provider } = make(createFakeHost(tinyProject()));
    const a = await provider.estimate(voiceJob());
    const b = await provider.estimate(voiceJob('job_snd_test', 'eleven_multilingual_v2'));
    assert.ok(b.amount > a.amount);
  });

  it('submit() called directly throws SpendGateBypassError, sends nothing and changes nothing', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const { provider, net } = make(host);
    await assert.rejects(provider.submit(voiceJob()), SpendGateBypassError);
    assert.equal(host.writes(), 0);
    assert.equal(net.calls.length, 0);
  });

  it('without a recorded budget cap the gate refuses with a pointer to setup, and nothing is sent', async () => {
    const host = createFakeHost(tinyProject());
    const { provider, net } = make(host);
    const gate = createSpendGate({ host, providers: [provider], level: 'B' });
    const r = await gate.run(voiceJob());
    assert.ok(r.status === 'refused' && r.refusal.code === 'no-budget' && /setup/.test(r.refusal.message));
    assert.equal(net.calls.length, 0);
  });

  it('refuses on host A (a paid direct API never runs in claude.ai in v0.x)', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const { provider, net } = make(host);
    const gate = createSpendGate({ host, providers: [provider], level: 'A' });
    const r = await gate.run(voiceJob());
    assert.equal(r.status, 'refused');
    assert.equal(net.calls.length, 0);
  });

  it('runs end to end through the gate: audio lands as pending-review with a words file, ledger settles at characters x price', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const { provider, net } = make(host);
    const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
    const job = voiceJob();

    let r = await gate.run(job);
    assert.equal(r.status, 'awaiting-approval');
    assert.equal(net.calls.length, 0, 'nothing sent before approval');
    approveAll(host);
    r = await gate.run(job);
    assert.equal(r.status, 'submitted', JSON.stringify(r));
    if (r.status !== 'submitted') return;
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.handle)));
    assert.ok(JOB_STATES.includes((await provider.poll(r.handle)).state));

    const c = await gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    const p = host.peek();
    assert.deepEqual(checkIntegrity(p), []);
    for (const item of job.items) {
      const u = findUnit(p, item.unit)!;
      assert.equal(u.unit.status, 'pending-review');
      assert.ok(u.unit.by_stage?.['sound']?.output?.uri?.endsWith('.wav'), 'the unit shows the audio, not the words file');
    }
    assert.ok(p.assets.every((a) => a.status !== 'approved'));
    const audio = c.assets.find((a) => a.owner === 'sc1_sh1')!;
    assert.equal(audio.kind, 'vo');
    assert.ok(audio.tags.includes('voice:voice_abc') && audio.tags.includes(`job:${job.id}`));
    const wordsTag = audio.tags.find((t) => t.startsWith('words:'))!;
    const words = readWordsFile(host.files.get(wordsTag.slice('words:'.length))!);
    assert.equal(words.text, TEXT1);
    assert.equal(words.voice_id, 'voice_abc');
    assert.deepEqual(words.words.map((w) => w.word), ['And', 'every', 'night,', 'about', 'midnight.']);
    assert.deepEqual(words.words[0], { word: 'And', start_ms: 0, end_ms: 150 });
    assert.equal(words.duration_ms, TEXT1.length * 50);

    assert.ok(p.ledger.length === 2 && p.ledger.every((e) => e.status === 'done'));
    const price = priceFor(config, ELEVENLABS_PROVIDER_ID).amount;
    assert.ok(Math.abs((p.budget?.spent ?? 0) - (TEXT1.length + TEXT2.length) * price) < 1e-9);
    assert.equal(p.budget?.spent, spentFromLedger(p));
    const again = await gate.run(job);
    assert.ok(again.status === 'refused' && again.refusal.code === 'already-submitted');
  });
});

describe('elevenlabs request shape', () => {
  async function runOnce(net = mockElevenLabs()) {
    const host = createFakeHost(withBudget(tinyProject()));
    const { provider } = make(host, net);
    const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
    const job = voiceJob();
    await gate.run(job);
    approveAll(host);
    const r = await gate.run(job);
    return { host, gate, r, net, job };
  }

  it('posts the exact narration text to the with-timestamps endpoint with the xi-api-key header, once per unit', async () => {
    const { net } = await runOnce();
    assert.equal(net.calls.length, 2);
    const c = net.calls[0]!;
    assert.equal(c.method, 'POST');
    assert.equal(c.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice_abc/with-timestamps?output_format=wav_24000');
    assert.equal(c.headers['xi-api-key'], 'test-key');
    assert.deepEqual(c.body, { text: TEXT1, model_id: 'eleven_flash_v2_5' });
    assert.equal(net.calls[1]!.body.text, TEXT2);
  });

  it('a response without alignment still records the audio (it was paid for), tagged no-words, with a note; no timings are invented', async () => {
    const { host, gate, r } = await runOnce(mockElevenLabs({ noAlignment: true }));
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    const c = await gate.collect(r.handle);
    assert.equal(c.status.state, 'done');
    assert.match(c.status.message ?? '', /no word timings/);
    const a = host.peek().assets.find((x) => x.owner === 'sc1_sh1')!;
    assert.ok(a.tags.includes('no-words'));
    assert.ok(!a.tags.some((t) => t.startsWith('words:')));
  });

  it('an HTTP error on the first unit stops after one call and records nothing', async () => {
    const net = mockElevenLabs({ fail: () => new Response(JSON.stringify({ detail: { message: 'invalid voice' } }), { status: 422 }) });
    const { r, host } = await runOnce(net);
    assert.equal(r.status, 'failed');
    assert.match(r.status === 'failed' ? r.error : '', /invalid voice/);
    assert.equal(net.calls.length, 1);
    assert.ok(host.peek().assets.every((a) => a.file === undefined || a.id === 'x'));
  });

  it('a job without a voice is refused before any call', async () => {
    const host = createFakeHost(withBudget(tinyProject()));
    const { provider, net } = make(host);
    const job = voiceJob();
    delete job.items[0]!.refs;
    await assert.rejects(provider.estimate(job), ElevenLabsError);
    assert.equal(net.calls.length, 0);
  });

  it('no key set: fails with the variable name, nothing sent', async () => {
    const saved = process.env['ELEVENLABS_API_KEY'];
    delete process.env['ELEVENLABS_API_KEY'];
    try {
      const host = createFakeHost(withBudget(tinyProject()));
      const net = mockElevenLabs();
      const provider = createElevenLabsProvider(host, { fetch: net.fetch });
      const gate = createSpendGate({ host, providers: [provider], level: 'B', now: () => NOW });
      const job = voiceJob();
      await gate.run(job);
      approveAll(host);
      const r = await gate.run(job);
      assert.equal(r.status, 'failed');
      assert.match(r.status === 'failed' ? r.error : '', /ELEVENLABS_API_KEY/);
      assert.equal(net.calls.length, 0);
    } finally {
      if (saved !== undefined) process.env['ELEVENLABS_API_KEY'] = saved;
    }
  });
});
