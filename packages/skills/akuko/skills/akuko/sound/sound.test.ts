// WP-12 — the sound stage: voice-over with real word timings through the spend gate,
// the film's audio.narration, captions, the manual path, and music/SFX ingest.
//
// Runs on WP-04's test story (the converted fixture "The Last Ferry") after a person
// approved breakdown, sketch, bible and key frames. The TTS network is mocked; nothing
// here makes a live call. "Approved" is only ever the result of folding a decision a
// person wrote through a conformed view; `guardedHost` fails any write that would newly
// set it from code.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkIntegrity } from '../schema/integrity.ts';
import { listUnits, type AkukoProject } from '../schema/akuko-project.ts';
import { loadProviderConfig, priceFor } from '../providers/config.ts';
import type { Provider, WaveOneHost } from '../providers/contract.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createElevenLabsProvider } from '../providers/tts/elevenlabs/index.ts';
import { createFakeHost, type FakeHost } from '../providers/__fixtures__/fake-host.ts';
import { SETUP_POINTER, createSpendGate, type SpendGate } from '../spend/gate.ts';
import { bibleApproved } from '../keyframes/__fixtures__/project.ts';
import { planKeyframes } from '../keyframes/plan.ts';
import { captionsFromNarration, formatSrt, formatVtt } from './captions.ts';
import { rebuildNarration, shotStarts, NarrationError } from './narration.ts';
import {
  SoundError,
  assertOpen,
  buildSoundJob,
  planSound,
  refreshStageState,
  soundStatus,
  voAssets,
} from './plan.ts';
import { collectVoiceover, finalizeSound, generateVoiceover, ingestSoundFile, ingestVoiceover, type StepResult } from './run.ts';
import { parseWav } from './wav.ts';
import { WordsError } from './words.ts';
import { silentWav, mockElevenLabs, type MockEleven } from './__fixtures__/audio.ts';
import { approve, approveSpend, decision, fold, keyframesApproved } from './__fixtures__/project.ts';

const NOW = '2026-11-09T10:00:00Z';
const now = (): string => NOW;
const config = loadProviderConfig();
const VOICE = 'voice_test_1';

const asset = (p: AkukoProject, id: string) => p.assets.find((a) => a.id === id)!;
const vo = (shot: string): string => `${shot}_vo`;
const approvedSet = (p: AkukoProject): Set<string> => new Set(listUnits(p).filter((u) => u.unit.status === 'approved').map((u) => u.unit.id));

/** A host that fails any code-side write that newly marks a unit approved (no action writes `approved`). */
function guardedHost(host: FakeHost): FakeHost {
  return {
    ...host,
    async writeState(p) {
      const before = approvedSet(host.peek());
      for (const id of approvedSet(p)) assert.ok(before.has(id), `code wrote "approved" for ${id}`);
      await host.writeState(p);
    },
  };
}

interface Rig {
  host: FakeHost;
  guarded: WaveOneHost;
  gate: SpendGate;
  providerId: string;
  net?: MockEleven;
  manual: ReturnType<typeof createManualProvider>;
  paid: boolean;
}

function rig(kind: 'manual' | 'elevenlabs', project: AkukoProject, opts: { perCharMs?: number; level?: 'A' | 'B' | 'C'; net?: MockEleven } = {}): Rig {
  const host = createFakeHost(project);
  const guarded = guardedHost(host);
  const manual = createManualProvider(guarded, { now });
  const providers: Provider[] = [manual.provider];
  let net: MockEleven | undefined;
  if (kind === 'elevenlabs') {
    net = opts.net ?? mockElevenLabs({ perCharMs: opts.perCharMs ?? 35 });
    providers.push(createElevenLabsProvider(guarded, { fetch: net.fetch, apiKey: 'test-key', now }));
  }
  const gate = createSpendGate({ host: guarded, providers, level: opts.level ?? 'B', now });
  return { host, guarded, gate, providerId: kind, ...(net ? { net } : {}), manual, paid: kind !== 'manual' };
}

const deps = (r: Rig) => ({ host: r.guarded, gate: r.gate, now });
const readFile = (r: Rig) => async (uri: string): Promise<Uint8Array> => {
  const f = r.host.files.get(uri);
  if (!f) throw new Error(`no stored file ${uri}`);
  return f;
};

const ready = (opts: { budget?: { cap: number; currency: string }; scriptLines?: 'all' | string[] } = {}): AkukoProject =>
  planSound(keyframesApproved(opts.budget ? { budget: opts.budget } : {}), NOW, opts.scriptLines ? { scriptLines: opts.scriptLines } : {}).project;

/** One step, approving the spend when asked. */
async function stepOnce(r: Rig, o: { units?: string[]; scene?: string; voice?: string } = {}): Promise<{ step: StepResult; held?: Extract<StepResult, { status: 'awaiting-approval' }> }> {
  const opts = { provider: r.providerId, voice: r.paid ? VOICE : 'warm, unhurried', ...o };
  let step = await generateVoiceover(deps(r), opts);
  let held: Extract<StepResult, { status: 'awaiting-approval' }> | undefined;
  if (step.status === 'awaiting-approval') {
    held = step;
    assert.ok(r.paid, 'a free job is never held for approval');
    assert.equal(r.host.peek().stages.sound.state, 'waiting-spend');
    r.host.set(approveSpend(r.host.peek(), step.job.id, 'sound').project);
    step = await generateVoiceover(deps(r), opts);
  }
  assert.ok(step.status === 'handoff' || step.status === 'done', `step ended ${step.status}: ${JSON.stringify(step)}`);
  return { step, ...(held ? { held } : {}) };
}

/** The person approves every take waiting for review (a decision through a conformed view, folded). */
function personApproves(r: Rig, ids?: string[]): string[] {
  const p = r.host.peek();
  const waiting = ids ?? voAssets(p).filter((a) => a.status === 'pending-review').map((a) => a.id);
  r.host.set(approve(p, waiting, 'sound').project);
  return waiting;
}

const SHOTS = keyframesApproved().shots.map((s) => s.id);
/** Shots of the fixture that already carry narration of their own (planned without any confirmation). */
const OWN = keyframesApproved().shots.filter((s) => (s.narration ?? '').trim() !== '').map((s) => vo(s.id));

// ─────────────────────────────────────────────────────────────────────────
describe('opening rule: sound opens once key frames are approved, motion is not needed', () => {
  it('refuses while key frames are not approved, naming the stage', () => {
    const p = planKeyframes(bibleApproved(), NOW).project;
    assert.throws(() => assertOpen(p), (e: unknown) => e instanceof SoundError && /locked: keyframes is "(in-progress|not-started)"/.test(e.message));
    assert.throws(() => planSound(p, NOW), SoundError);
  });

  it('is open with key frames approved and motion untouched; plan unlocks the stage and says nothing is chosen for the person', () => {
    const p = keyframesApproved();
    assert.equal(p.stages.keyframes.state, 'approved');
    assert.notEqual(p.stages.motion.state, 'approved');
    assert.equal(p.stages.sound.state, 'locked');
    assert.doesNotThrow(() => assertOpen(p));
    const r = planSound(p, NOW);
    assert.notEqual(r.project.stages.sound.state, 'locked');
    assert.deepEqual(r.created, OWN, 'only shots with narration of their own are planned; no confirmation, nothing else');
    assert.equal(r.proposals.length, SHOTS.length - OWN.length, 'every other script line is only proposed');
  });

  it('refuses when a shot is not approved', () => {
    const p = keyframesApproved();
    p.shots[0]!.status = 'needs-rework';
    assert.throws(() => assertOpen(p), /not approved yet: sc1_sh1/);
  });
});

describe('narration text is never invented', () => {
  it('uses shot.narration when set; a script line only when the person confirmed that shot', () => {
    const p = keyframesApproved();
    p.shots[0]!.narration = 'A line the person wrote.';
    const a = planSound(p, NOW, { scriptLines: ['sc1_sh2'] });
    assert.deepEqual(a.created, [vo('sc1_sh1'), vo('sc1_sh2'), ...OWN.filter((x) => x !== vo('sc1_sh1') && x !== vo('sc1_sh2'))]);
    assert.ok(a.proposals.every((x) => x.shot !== 'sc1_sh1' && x.shot !== 'sc1_sh2'));
    const built = buildSoundJob(a.project, { provider: 'elevenlabs', voice: VOICE, units: [vo('sc1_sh1'), vo('sc1_sh2')] });
    assert.equal(built.job.items[0]!.prompt, 'A line the person wrote.');
    assert.equal(built.job.items[1]!.prompt, p.shots[1]!.script_line!.trim());
  });

  it('narration wins over a script line, and a shot with no text at all has no unit', () => {
    const p = keyframesApproved();
    p.shots[0]!.narration = 'Written narration.';
    p.shots[1]!.script_line = '';
    delete p.shots[2]!.script_line;
    const a = planSound(p, NOW, { scriptLines: 'all' });
    assert.equal(buildSoundJob(a.project, { provider: 'manual', units: [vo('sc1_sh1')] }).job.items[0]!.prompt, 'Written narration.');
    assert.ok(a.noText.includes('sc1_sh2'));
    assert.ok(a.noText.includes('sc1_sh3'));
    assert.ok(!a.project.assets.some((x) => x.id === vo('sc1_sh2')));
  });

  it('plan is idempotent; an unknown shot id is an error', () => {
    const a = planSound(keyframesApproved(), NOW, { scriptLines: 'all' });
    assert.equal(planSound(a.project, NOW, { scriptLines: 'all' }).created.length, 0);
    assert.throws(() => planSound(keyframesApproved(), NOW, { scriptLines: ['nope'] }), /unknown shot/);
  });

  it('a unit that cannot be given text is blocked, and the job builder says so', () => {
    const a = planSound(keyframesApproved(), NOW, { scriptLines: ['sc1_sh1'] }).project;
    a.shots[0]!.script_line = '';
    assert.equal(soundStatus(a)[0]!.state, 'blocked');
    assert.throws(() => buildSoundJob(a, { provider: 'manual', units: [vo('sc1_sh1')] }), /blocked; waiting for text/);
  });
});

describe('the job: one voice-over per shot, text exact, voice chosen by the person', () => {
  it('one shot by default; prompt is the exact text; id has the right shape and covers provider, model, voice and text', () => {
    const p = ready({ scriptLines: 'all' });
    const a = buildSoundJob(p, { provider: 'elevenlabs', voice: VOICE });
    assert.deepEqual(a.units, [vo('sc1_sh1')]);
    assert.match(a.job.id, /^job_snd_[0-9a-f]{8}_r1$/);
    assert.equal(a.job.kind, 'audio');
    assert.equal(a.job.stage, 'sound');
    assert.equal(a.job.items[0]!.prompt, p.shots[0]!.script_line!.trim());
    assert.equal(a.job.items[0]!.output, 'vo');
    assert.deepEqual(a.job.items[0]!.refs, [{ id: VOICE, role: 'voice', note: 'provider voice id' }]);
    assert.equal(a.characters, a.job.items[0]!.prompt.length);
    const id = (o: Parameters<typeof buildSoundJob>[1]) => buildSoundJob(p, o).job.id;
    const base = id({ provider: 'elevenlabs', voice: VOICE });
    assert.equal(id({ provider: 'elevenlabs', voice: VOICE }), base, 'deterministic');
    assert.notEqual(id({ provider: 'elevenlabs', voice: 'other_voice' }), base);
    assert.notEqual(id({ provider: 'elevenlabs', voice: VOICE, model: 'eleven_multilingual_v2' }), base);
    assert.notEqual(id({ provider: 'manual', voice: VOICE }), base);
    const edited = structuredClone(p);
    edited.shots[0]!.script_line = `${edited.shots[0]!.script_line} Really.`;
    assert.notEqual(buildSoundJob(edited, { provider: 'elevenlabs', voice: VOICE }).job.id, base);
  });

  it('a paid provider needs a voice the person chose; akuko picks none', () => {
    assert.throws(() => buildSoundJob(ready({ scriptLines: 'all' }), { provider: 'elevenlabs' }), /Choose a voice/);
    assert.doesNotThrow(() => buildSoundJob(ready({ scriptLines: 'all' }), { provider: 'manual' }));
  });

  it('--scene batches a scene; named units must be ready', () => {
    const p = ready({ scriptLines: 'all' });
    const scene1 = p.shots.filter((s) => s.scene === p.shots[0]!.scene).map((s) => vo(s.id));
    assert.deepEqual(buildSoundJob(p, { provider: 'manual', scene: p.shots[0]!.scene }).units, scene1);
    assert.throws(() => buildSoundJob(p, { provider: 'manual', units: ['nope'] }), /not a planned voice-over/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('paid path on the short-story fixture (TTS mocked): one job per shot through the gate', () => {
  it('quotes characters x price, sends nothing until approved, then records pending-review takes with real timings', async () => {
    const r = rig('elevenlabs', ready({ budget: { cap: 5, currency: 'USD' }, scriptLines: 'all' }));
    const price = priceFor(config, 'elevenlabs').amount;

    const first = await stepOnce(r);
    assert.ok(first.held, 'the first call was held for approval');
    const chars = r.host.peek().shots[0]!.script_line!.trim().length;
    assert.ok(Math.abs(first.held.estimate - chars * price) < 1e-12);
    assert.match(first.held.confirmation, new RegExp(`${chars} characters`), first.held.confirmation);
    assert.equal(first.held.characters, chars);
    assert.equal(first.step.status, 'done');
    assert.equal(r.net!.calls.length, 1);

    let p = r.host.peek();
    const a = asset(p, vo('sc1_sh1'));
    assert.equal(a.status, 'pending-review');
    assert.ok(a.file?.uri.endsWith('.wav'));
    assert.equal(p.stages.sound.state, 'in-progress', 'other planned takes are still to make');
    assert.equal(p.ledger.length, 1);
    assert.ok(Math.abs(p.ledger[0]!.actual! - chars * price) < 1e-12);

    // every remaining shot: one job each, each with its own approval
    for (let i = 1; i < SHOTS.length; i++) await stepOnce(r);
    p = r.host.peek();
    assert.equal(r.net!.calls.length, SHOTS.length);
    assert.equal(p.ledger.length, SHOTS.length);
    assert.equal(new Set(p.ledger.map((e) => e.job)).size, SHOTS.length, 'one job per shot');
    assert.equal(p.stages.sound.state, 'in-review');
    assert.deepEqual(checkIntegrity(p), []);
    await assert.rejects(generateVoiceover(deps(r), { provider: 'elevenlabs', voice: VOICE }), /Nothing is waiting to be generated/);
  });

  it('after a person approves the takes: audio.narration has composition-absolute, monotonic words inside each shot, and captions match', async () => {
    const r = rig('elevenlabs', ready({ budget: { cap: 5, currency: 'USD' }, scriptLines: 'all' }));
    for (let i = 0; i < SHOTS.length; i++) await stepOnce(r);

    // before any approval nothing is built, and only approved takes ever go in
    assert.equal((await rebuildNarration({ host: r.guarded, readFile: readFile(r), now })).status, 'nothing');
    assert.equal(r.host.peek().audio.narration ?? null, null);
    personApproves(r, [vo('sc1_sh1'), vo('sc1_sh2')]);
    const some = await rebuildNarration({ host: r.guarded, readFile: readFile(r), now });
    assert.equal(some.status, 'built');
    assert.ok(r.host.peek().audio.narration!.words.every((w) => w.end_ms <= 11_000), 'only the two approved shots');

    personApproves(r);
    assert.equal(r.host.peek().stages.sound.state, 'approved');
    const res = await rebuildNarration({ host: r.guarded, readFile: readFile(r), now });
    assert.ok(res.status === 'built' && res.words > 0 && res.withoutTimings.length === 0 && !res.trackSkipped, JSON.stringify(res));

    const p = r.host.peek();
    const n = p.audio.narration!;
    assert.equal(n.voice_id, VOICE);
    assert.equal(n.generated_at, NOW);
    const { starts, durations, totalMs } = shotStarts(p.shots);
    assert.equal(n.duration_ms, totalMs);
    assert.ok(n.audio.uri.endsWith('narration.wav'));
    assert.equal(parseWav(r.host.files.get(n.audio.uri)!).durationMs, totalMs);
    assert.equal(n.audio.duration_ms, totalMs);

    // monotonic, whole ms, and every word of a shot inside that shot's range
    for (let i = 1; i < n.words.length; i++) {
      assert.ok(n.words[i]!.start_ms >= n.words[i - 1]!.start_ms && n.words[i]!.end_ms >= n.words[i - 1]!.end_ms, `word ${i} in order`);
    }
    const expected: string[] = [];
    for (const shot of p.shots) {
      const text = shot.script_line!.trim();
      const start = starts.get(shot.id)!;
      const end = start + durations.get(shot.id)!;
      const mine = n.words.filter((w) => w.start_ms >= start && w.end_ms <= end);
      assert.equal(mine.map((w) => w.word).join(' '), text, `${shot.id}: Poe's own words, nothing added`);
      assert.equal(mine[0]!.start_ms, start, 'the take starts where its shot starts');
      assert.ok(Number.isInteger(mine[0]!.start_ms));
      expected.push(...mine.map((w) => w.word));
    }
    assert.equal(n.words.length, expected.length, 'no word outside its shot');
    // the shot-2 word timings are the provider's character times, moved by shot 1's length
    const sh2 = n.words.find((w) => w.start_ms >= starts.get('sc1_sh2')!)!;
    assert.equal(sh2.start_ms, starts.get('sc1_sh2')!);
    assert.equal(sh2.end_ms - sh2.start_ms, Math.round(35 * sh2.word.length));

    // captions: files written, cue times equal word times, VTT and SRT agree
    assert.ok(res.captions && res.captions.cues > 0);
    const cues = captionsFromNarration(n);
    assert.equal(res.captions!.cues, cues.length);
    assert.equal(new TextDecoder().decode(r.host.files.get(res.captions!.vtt)!), formatVtt(cues));
    assert.equal(new TextDecoder().decode(r.host.files.get(res.captions!.srt)!), formatSrt(cues));
    for (const c of cues) {
      const inside = n.words.filter((w) => w.start_ms >= c.start_ms && w.end_ms <= c.end_ms);
      assert.equal(inside[0]!.start_ms, c.start_ms);
      assert.equal(inside.at(-1)!.end_ms, c.end_ms);
      assert.equal(inside.map((w) => w.word).join(' '), c.text);
    }
    assert.equal(cues[0]!.start_ms, n.words[0]!.start_ms);
    assert.equal(cues.at(-1)!.end_ms, n.words.at(-1)!.end_ms);

    // a second rebuild with nothing new changes nothing
    const before = JSON.stringify(r.host.peek().audio);
    const again = await rebuildNarration({ host: r.guarded, readFile: readFile(r), now: () => '2027-01-01T00:00:00Z' });
    assert.equal(again.status, 'unchanged');
    assert.equal(JSON.stringify(r.host.peek().audio), before);
    assert.deepEqual(checkIntegrity(r.host.peek()), []);
    console.log('FIRST 3 CAPTION CUES:', JSON.stringify(cues.slice(0, 3)));
  });

  it('refuses a take that runs past its shot (its words would run into the next one), and a shot with no duration', async () => {
    const r = rig('elevenlabs', ready({ budget: { cap: 5, currency: 'USD' }, scriptLines: ['sc1_sh1'] }), { perCharMs: 200 });
    await stepOnce(r);
    personApproves(r);
    await assert.rejects(rebuildNarration({ host: r.guarded, readFile: readFile(r), now }), (e: unknown) => e instanceof NarrationError && /runs [\d.]+s but sc1_sh1 lasts 6.00s/.test(e.message));
    assert.equal(r.host.peek().audio.narration ?? null, null, 'nothing was written');
    const p = r.host.peek();
    p.shots[3]!.duration_s = undefined;
    assert.throws(() => shotStarts(p.shots), /no duration.*sc1_sh4/);
  });

  it('a paid provider is refused on host A and without a budget; nothing is sent', async () => {
    const a = rig('elevenlabs', ready({ budget: { cap: 5, currency: 'USD' }, scriptLines: 'all' }), { level: 'A' });
    const ra = await generateVoiceover(deps(a), { provider: 'elevenlabs', voice: VOICE });
    assert.equal(ra.status, 'refused');
    const b = rig('elevenlabs', ready({ scriptLines: 'all' }));
    const rb = await generateVoiceover(deps(b), { provider: 'elevenlabs', voice: VOICE });
    assert.ok(rb.status === 'refused' && rb.message.includes(SETUP_POINTER));
    assert.equal(a.net!.calls.length + b.net!.calls.length, 0);
    assert.equal(b.host.peek().stages.sound.state, 'in-progress', 'units were put back as they were');
    assert.equal(asset(b.host.peek(), vo('sc1_sh1')).status, 'pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('sent back: needs-rework makes a new take with a fresh approval; nothing writes approved', () => {
  it('request-changes -> new job id, new approval, old file kept, comment, then pending-review again', async () => {
    const r = rig('elevenlabs', ready({ budget: { cap: 5, currency: 'USD' }, scriptLines: ['sc1_sh1', 'sc1_sh2'] }));
    const first = await stepOnce(r);
    const oldUri = asset(r.host.peek(), vo('sc1_sh1')).file!.uri;
    const oldJob = first.step.job.id;
    r.host.set(fold(r.host.peek(), [decision('request-changes', vo('sc1_sh1'), 'sound', { text: 'Slower, and softer on the last word.' })]).project);
    assert.equal(asset(r.host.peek(), vo('sc1_sh1')).status, 'needs-rework');

    const second = await stepOnce(r, { units: [vo('sc1_sh1')] });
    assert.ok(second.held, 'a new take needs a new approval');
    assert.notEqual(second.step.job.id, oldJob);
    assert.match(second.step.job.id, /_r2$/);
    const a = asset(r.host.peek(), vo('sc1_sh1'));
    assert.equal(a.status, 'pending-review');
    assert.ok(a.file!.uri, 'the new take fills the same asset');
    assert.ok(a.comments.some((c) => c.author === 'agent' && c.text.startsWith('Revised:') && c.text.includes(oldUri)));
    assert.ok(a.comments.some((c) => c.text === 'Slower, and softer on the last word.'), "the person's words are kept");
    assert.equal(r.host.peek().ledger.filter((e) => e.unit === vo('sc1_sh1')).length, 2);
  });

  it('un-approving the last approved take clears audio.narration; only approved takes are ever in it', async () => {
    const r = rig('elevenlabs', ready({ budget: { cap: 5, currency: 'USD' }, scriptLines: ['sc1_sh1'] }));
    await stepOnce(r);
    personApproves(r);
    assert.equal((await rebuildNarration({ host: r.guarded, readFile: readFile(r), now })).status, 'built');
    r.host.set(fold(r.host.peek(), [decision('request-changes', vo('sc1_sh1'), 'sound', { text: 'again' })]).project);
    const res = await rebuildNarration({ host: r.guarded, readFile: readFile(r), now });
    assert.equal(res.status, 'nothing');
    assert.equal(r.host.peek().audio.narration ?? null, null);
  });

  it('a take whose text changed since is flagged, never changed by code', async () => {
    const r = rig('manual', ready({ scriptLines: ['sc1_sh1'] }));
    const { step } = await stepOnce(r);
    assert.equal(step.status, 'handoff');
    const p = r.host.peek();
    assert.equal(soundStatus(p)[0]!.textChanged, false);
    p.shots[0]!.script_line = `${p.shots[0]!.script_line} (edited)`;
    r.host.set(p);
    // the stamp only exists once a take is produced; produce one
    await ingestVoiceover(deps(r), r.manual, step.job, vo('sc1_sh1'), { filename: 't.wav', mime: 'audio/wav', data: silentWav(1000) });
    assert.equal(soundStatus(r.host.peek())[0]!.textChanged, true);
    assert.equal(asset(r.host.peek(), vo('sc1_sh1')).status, 'pending-review');
  });

  it('the stage state follows: waiting-spend, in-progress, in-review; repair of a fileless take', async () => {
    const p = ready({ scriptLines: 'all' });
    assert.equal(refreshStageState(p).stages.sound.state, 'in-progress');
    const q = structuredClone(p);
    for (const a of voAssets(q)) { a.status = 'pending-review'; a.file = { uri: 'x', mime: 'audio/wav' }; }
    assert.equal(refreshStageState(q).stages.sound.state, 'in-review');
    const host = createFakeHost({ ...q, assets: q.assets.map((a) => (a.id === vo('sc1_sh1') ? { ...a, file: undefined } : a)) });
    assert.deepEqual(await finalizeSound({ host, now }), [vo('sc1_sh1')]);
    assert.equal(asset(host.peek(), vo('sc1_sh1')).status, 'pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('manual path: prompt package out, file (and optionally words) back', () => {
  async function manualTake(r: Rig, unit: string, o: { words?: unknown; mime?: string; data?: Uint8Array } = {}) {
    const step = await generateVoiceover(deps(r), { provider: 'manual', voice: 'warm, unhurried' });
    assert.equal(step.status, 'handoff');
    if (step.status !== 'handoff') throw new Error('unreachable');
    const res = await ingestVoiceover(
      deps(r),
      r.manual,
      step.job,
      unit,
      { filename: 'take.wav', mime: o.mime ?? 'audio/wav', data: o.data ?? silentWav(2000) },
      o.words !== undefined ? { words: { filename: 'words.json', data: new TextEncoder().encode(JSON.stringify(o.words)) } } : {},
    );
    return { step, res };
  }

  it('hands over the exact text, free, with no spend and no key', async () => {
    const r = rig('manual', ready({ scriptLines: 'all' }));
    const step = await generateVoiceover(deps(r), { provider: 'manual' });
    assert.ok(step.status === 'handoff');
    if (step.status !== 'handoff') return;
    assert.ok(step.text.includes(r.host.peek().shots[0]!.script_line!.trim()));
    assert.equal(step.job.items[0]!.refs, undefined, 'no voice id attached for the manual provider');
    assert.deepEqual(r.host.peek().ledger, []);
    assert.equal(asset(r.host.peek(), vo('sc1_sh1')).status, 'draft');
  });

  it('with a words file: recorded with real timings that the person supplied; narration and captions follow once approved', async () => {
    const r = rig('manual', ready({ scriptLines: ['sc1_sh1'] }));
    const text = r.host.peek().shots[0]!.script_line!.trim().split(' ');
    const words = text.map((word, i) => ({ word, start_ms: i * 300, end_ms: i * 300 + 250 }));
    const { res } = await manualTake(r, vo('sc1_sh1'), { words, data: silentWav(Math.max(2000, words.length * 300)) });
    assert.equal(res.timings, true);
    const a = asset(r.host.peek(), vo('sc1_sh1'));
    assert.equal(a.status, 'pending-review');
    assert.ok(a.tags.some((t) => t.startsWith('words:')));
    assert.ok(!a.tags.includes('no-words'));
    personApproves(r);
    const out = await rebuildNarration({ host: r.guarded, readFile: readFile(r), now });
    assert.ok(out.status === 'built' && out.words === words.length && out.captions, JSON.stringify(out));
    assert.deepEqual(r.host.peek().audio.narration!.words[1], { word: words[1]!.word, start_ms: 300, end_ms: 550 });
  });

  it('without a words file: recorded WITHOUT timings, says captions need them, and invents none', async () => {
    const r = rig('manual', ready({ scriptLines: ['sc1_sh1'] }));
    const { res } = await manualTake(r, vo('sc1_sh1'));
    assert.equal(res.timings, false);
    assert.ok(res.warnings.some((w) => /without word timings: captions need them/.test(w) && /No timings were guessed/.test(w)));
    const a = asset(r.host.peek(), vo('sc1_sh1'));
    assert.ok(a.tags.includes('no-words'));
    assert.equal(soundStatus(r.host.peek())[0]!.noWords, true);
    personApproves(r);
    const out = await rebuildNarration({ host: r.guarded, readFile: readFile(r), now });
    assert.ok(out.status !== 'nothing');
    if (out.status === 'nothing') return;
    assert.equal(out.words, 0);
    assert.deepEqual(out.withoutTimings, [vo('sc1_sh1')]);
    assert.equal(out.captions, undefined, 'no captions without timings');
    assert.deepEqual(r.host.peek().audio.narration?.words, []);
  });

  it('a words file that is not timings is refused before anything is recorded', async () => {
    const r = rig('manual', ready({ scriptLines: ['sc1_sh1'] }));
    const step = await generateVoiceover(deps(r), { provider: 'manual' });
    if (step.status !== 'handoff') throw new Error('handoff expected');
    const before = r.host.peek();
    await assert.rejects(
      ingestVoiceover(deps(r), r.manual, step.job, vo('sc1_sh1'), { filename: 't.wav', mime: 'audio/wav', data: silentWav(500) }, { words: { filename: 'w.json', data: new TextEncoder().encode('{"words":[{"word":"a","start_ms":"0","end_ms":1}]}') } }),
      WordsError,
    );
    assert.deepEqual(r.host.peek().assets, before.assets);
  });

  it('an mp3 take cannot share one track here: no audio.narration block, but the captions are still written from the timings', async () => {
    const r = rig('manual', ready({ scriptLines: ['sc1_sh1'] }));
    const words = [{ word: 'And', start_ms: 0, end_ms: 200 }, { word: 'every', start_ms: 250, end_ms: 600 }];
    await manualTake(r, vo('sc1_sh1'), { words, mime: 'audio/mpeg', data: new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3]) });
    personApproves(r);
    const out = await rebuildNarration({ host: r.guarded, readFile: readFile(r), now });
    assert.ok(out.status !== 'nothing' && out.trackSkipped && /WAV/.test(out.trackSkipped));
    assert.equal(r.host.peek().audio.narration ?? null, null);
    if (out.status !== 'nothing') assert.equal(out.captions?.cues, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('music and SFX: person-supplied files, licence recorded, nothing generated', () => {
  const MP3 = { filename: 'bed.mp3', mime: 'audio/mpeg', data: new Uint8Array([0xff, 0xfb, 1, 2, 3]) };

  it('records a music bed for the film and an SFX for a shot, with licence, source and placement in the tags, pending-review', async () => {
    const r = rig('manual', ready());
    const m = await ingestSoundFile(deps(r), { kind: 'music', file: MP3, licence: 'CC BY 4.0', source: 'a friend, 2026', name: 'Main bed' });
    const s = await ingestSoundFile(deps(r), { kind: 'sfx', file: { ...MP3, filename: 'latch.wav', mime: 'audio/wav' }, licence: 'own recording', placement: { shot: 'sc1_sh2' } });
    const t = await ingestSoundFile(deps(r), { kind: 'sfx', file: MP3, licence: 'own recording', placement: { scene: r.host.peek().scenes[0]!.id } });
    const p = r.host.peek();
    assert.deepEqual([m.asset, s.asset, t.asset], ['film_music_1', 'sc1_sh2_sfx_1', `${r.host.peek().scenes[0]!.id}_sfx_1`]);
    const ma = asset(p, m.asset);
    assert.equal(ma.kind, 'music');
    assert.equal(ma.stage, 'sound');
    assert.equal(ma.status, 'pending-review');
    assert.deepEqual(ma.tags, ['supplied', 'licence:CC BY 4.0', 'source:a friend, 2026', 'placement:film']);
    assert.equal(ma.name, 'Main bed');
    assert.ok(ma.file?.uri.includes('audio/music') || ma.file?.uri.endsWith('.mp3'));
    const sa = asset(p, s.asset);
    assert.equal(sa.owner, 'sc1_sh2');
    assert.ok(sa.tags.includes('placement:shot:sc1_sh2') && sa.tags.includes('licence:own recording'));
    assert.ok(asset(p, t.asset).tags.some((x) => x.startsWith('placement:scene:')));
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal(p.ledger.length, 0, 'free: nothing is generated or paid');
    assert.notEqual(p.stages.sound.state, 'locked');
    // the person approves them like any unit
    r.host.set(approve(p, [m.asset, s.asset, t.asset], 'sound').project);
    assert.deepEqual([m.asset, s.asset, t.asset].filter((id) => approvedSet(r.host.peek()).has(id)), [m.asset, s.asset, t.asset]);
  });

  it('refuses a missing licence, a non-audio file, an empty file, an unknown shot, and a locked stage', async () => {
    const r = rig('manual', ready());
    await assert.rejects(ingestSoundFile(deps(r), { kind: 'music', file: MP3, licence: '  ' }), /Say what the licence is/);
    await assert.rejects(ingestSoundFile(deps(r), { kind: 'music', file: { ...MP3, mime: 'image/png' }, licence: 'x' }), /audio files only/);
    await assert.rejects(ingestSoundFile(deps(r), { kind: 'music', file: { ...MP3, data: new Uint8Array() }, licence: 'x' }), /is empty/);
    await assert.rejects(ingestSoundFile(deps(r), { kind: 'sfx', file: MP3, licence: 'x', placement: { shot: 'zzz' } }), /unknown shot/);
    const locked = rig('manual', planKeyframes(bibleApproved(), NOW).project);
    await assert.rejects(ingestSoundFile(deps(locked), { kind: 'music', file: MP3, licence: 'x' }), SoundError);
    assert.equal(r.host.peek().assets.filter((a) => a.kind === 'music').length, 0);
  });
});

describe('collect for a job submitted earlier', () => {
  it('a handle from another session reports that plainly and records nothing', async () => {
    const r = rig('elevenlabs', ready({ budget: { cap: 5, currency: 'USD' }, scriptLines: ['sc1_sh1'] }));
    const { step } = await stepOnce(r);
    if (step.status !== 'done') throw new Error('done expected');
    const other = rig('elevenlabs', r.host.peek());
    const res = await collectVoiceover(deps(other), step.job, step.handle);
    assert.equal(res.status, 'failed');
  });
});
