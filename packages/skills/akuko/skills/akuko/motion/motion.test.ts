// WP-10 — the motion stage (clips): one clip per shot from the approved key frame, through the spend gate.
//
// Runs on WP-04's test story ("The Last Ferry") with every stage through the key frames approved by a
// person, with the manual provider and with the fal video provider on a mocked network. Nothing here
// makes a live call. "Approved" is only ever the result of folding a decision a person wrote through a
// conformed view; `guardedHost` fails any write that would newly set it from code.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkIntegrity } from '../schema/integrity.ts';
import { listUnits, type AkukoProject } from '../schema/akuko-project.ts';
import { loadProviderConfig } from '../providers/config.ts';
import type { Provider, WaveOneHost } from '../providers/contract.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createFalVideoProvider } from '../providers/fal-video/index.ts';
import { MP4_BYTES, mockFalVideo } from '../providers/fal-video/__fixtures__/mock-net.ts';
import { PNG_BYTES, type MockNet } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { createFakeHost, type FakeHost } from '../providers/__fixtures__/fake-host.ts';
import { keyPresence } from '../setup/setup.ts';
import { run as doctor } from '../scripts/doctor/cli.ts';
import { createSpendGate, type SpendGate } from '../spend/gate.ts';
import { motionPrompt } from './prompts.ts';
import {
  DEFAULT_MAX_ATTEMPTS,
  MotionError,
  assertOpen,
  buildMotionJob,
  clipAssets,
  motionStatus,
  paidAttempts,
  planMotion,
  refreshStageState,
  unitReadiness,
} from './plan.ts';
import { collectClips, finalizeMotion, generateClips, ingestClip, type StepResult } from './run.ts';
import { approve, approveSpend, decision, fold, keyframesApproved } from './__fixtures__/project.ts';

const NOW = '2026-11-09T10:00:00Z';
const now = (): string => NOW;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIP1 = 'sc1_sh1_clip';
const CFG = loadProviderConfig();

const asset = (p: AkukoProject, id: string) => p.assets.find((a) => a.id === id)!;
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

const planned = (opts: { budget?: { cap: number; currency: string } } = {}): AkukoProject => planMotion(keyframesApproved(opts), NOW).project;
const funded = (): AkukoProject => planned({ budget: { cap: 10, currency: 'USD' } });

interface Rig {
  host: FakeHost;
  guarded: WaveOneHost;
  gate: SpendGate;
  providerId: string;
  net?: MockNet;
  manual: ReturnType<typeof createManualProvider>;
  paid: boolean;
}

function rig(kind: 'manual' | 'fal-video', project: AkukoProject, level: 'A' | 'B' | 'C' = 'B', mock?: MockNet): Rig {
  const host = createFakeHost(project);
  const guarded = guardedHost(host);
  const manual = createManualProvider(guarded, { now });
  const providers: Provider[] = [manual.provider];
  let net: MockNet | undefined;
  if (kind === 'fal-video') {
    net = mock ?? mockFalVideo();
    providers.push(createFalVideoProvider(guarded, { fetch: net.fetch, apiKey: 'test-key', loadRef: async () => ({ mime: 'image/png', data: PNG_BYTES }), now }));
  }
  const gate = createSpendGate({ host: guarded, providers, level, now });
  return { host, guarded, gate, providerId: kind, ...(net ? { net } : {}), manual, paid: kind !== 'manual' };
}

const deps = (r: Rig) => ({ host: r.guarded, gate: r.gate, now });
const FILE = { filename: 'from-person.mp4', mime: 'video/mp4', data: MP4_BYTES };

/** One paid attempt on one clip, approving the spend when asked. Returns the finished step. */
async function paidTake(r: Rig, unit = CLIP1, extra: { maxAttempts?: number; audio?: boolean } = {}): Promise<StepResult> {
  const opts = { provider: r.providerId, units: [unit], ...extra };
  let step = await generateClips(deps(r), opts);
  assert.equal(step.status, 'awaiting-approval');
  assert.equal(r.host.peek().stages.motion.state, 'waiting-spend');
  r.host.set(approveSpend(r.host.peek(), step.job.id, 'motion').project);
  step = await generateClips(deps(r), opts);
  assert.equal(step.status, 'done', JSON.stringify(step));
  return step;
}

// ─────────────────────────────────────────────────────────────────────────
describe('the prompt: the shot as written, nothing invented', () => {
  it('carries the shot action, camera and move, and says the key frame is the first frame', () => {
    const p = planned();
    const item = buildMotionJob(p, { provider: 'manual', units: [CLIP1] }).job.items[0]!;
    assert.match(item.prompt, /first frame is the attached approved key frame/);
    assert.match(item.prompt, /Action: Mara hurries along the wooden pier/);
    assert.match(item.prompt, /Camera: Static, low angle\. Camera move: /);
    assert.match(item.prompt, /Sound: none/);
    assert.equal(item.output, 'clip');
    assert.equal(item.aspect_ratio, '16:9');
  });

  it('a shot with no written action gets only small natural movement, and the person\'s words are added', () => {
    const p = planned();
    const shot = { ...p.shots[0]!, action: undefined };
    assert.match(motionPrompt({ shot, seconds: 5, audio: false }), /not written; only small natural movement/);
    assert.match(motionPrompt({ shot: p.shots[0]!, seconds: 5, audio: false }, 'Slower.'), /Changes the person asked for: Slower\./);
  });

  it('is brand-neutral', () => {
    const text = readFileSync(join(ROOT, 'motion/prompts.ts'), 'utf8').toLowerCase();
    for (const w of [['roy', 'alti'], ['dix', 'trit'], ['ike', 'nga']].map((x) => x.join(''))) assert.ok(!text.includes(w), w);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('gating and planning', () => {
  it('opens only when every earlier stage is approved, naming the one that waits', () => {
    for (const stage of ['breakdown', 'sketch', 'bible', 'keyframes'] as const) {
      const p = keyframesApproved();
      assert.equal(p.stages.keyframes.state, 'approved');
      p.stages[stage] = { state: 'in-review' };
      assert.throws(() => planMotion(p, NOW), (e: Error) => e instanceof MotionError && new RegExp(`locked: ${stage} is "in-review"`).test(e.message), stage);
    }
    assert.doesNotThrow(() => assertOpen(keyframesApproved()));
  });

  it('plans one clip per shot, owned by the shot; shots and key frames are untouched; safe to repeat', () => {
    const before = keyframesApproved();
    const r = planMotion(before, NOW);
    assert.equal(r.created.length, before.shots.length);
    assert.deepEqual(r.created.slice(0, 2), ['sc1_sh1_clip', 'sc1_sh2_clip']);
    for (const a of clipAssets(r.project)) {
      assert.equal(a.stage, 'motion');
      assert.equal(a.kind, 'clip');
      assert.equal(a.status, 'pending');
      assert.equal(a.file, undefined);
    }
    assert.equal(asset(r.project, CLIP1).owner, 'sc1_sh1');
    assert.deepEqual(r.project.shots, before.shots);
    assert.deepEqual(r.project.assets.filter((a) => a.kind === 'keyframe'), before.assets.filter((a) => a.kind === 'keyframe'));
    assert.equal(r.project.stages.motion.state, 'in-progress');
    assert.deepEqual(checkIntegrity(r.project), []);
    assert.equal(planMotion(r.project, NOW).created.length, 0);
  });

  it('a shot whose key frame is not approved with a file is blocked, and step refuses it by name', () => {
    const p = planned();
    asset(p, 'sc1_sh1_keyframe').status = 'needs-rework';
    assert.deepEqual(unitReadiness(p, asset(p, CLIP1)), { state: 'blocked', waiting: ['sc1_sh1_keyframe'] });
    assert.throws(() => buildMotionJob(p, { provider: 'manual', units: [CLIP1] }), /sc1_sh1_clip cannot be made now \(blocked; its key frame is not approved: sc1_sh1_keyframe\)/);
    // by default the blocked shot is skipped and the next ready one is made
    const built = buildMotionJob(p, { provider: 'manual' });
    assert.deepEqual(built.units, ['sc1_sh2_clip']);
    assert.equal(motionStatus(p)[0]!.state, 'blocked');
  });

  it('a shot with no duration is refused: motion does not guess a length', () => {
    const p = planned();
    delete p.shots[0]!.duration_s;
    assert.throws(() => buildMotionJob(p, { provider: 'manual', units: [CLIP1] }), /has no duration/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('jobs: one shot, the start frame, the length the model can make', () => {
  it('builds one clip job for the next shot: start-frame ref, clamped length, the arithmetic in the label', () => {
    const p = funded();
    const b = buildMotionJob(p, { provider: 'fal-video' });
    assert.deepEqual(b.units, [CLIP1]);
    assert.match(b.job.id, /^job_mo_[0-9a-f]{8}_r1$/);
    assert.equal(b.job.stage, 'motion');
    assert.equal(b.job.kind, 'video');
    assert.equal(b.job.model, CFG.providers['fal-video']!.default_model);
    const item = b.job.items[0]!;
    assert.equal(item.duration_s, 10, 'the 6 s shot is covered by the shortest length that is at least as long');
    assert.deepEqual(item.refs, [{ id: 'sc1_sh1_keyframe', uri: 'mem://assets/sc1_sh1_keyframe.png', role: 'start-frame', note: 'the approved key frame: the first frame of the clip' }]);
    assert.match(b.job.label, /sc1_sh1 10 s x 0\.07 USD\/s = 0\.7 \(10 s billed for a 6 s shot\)/);
    assert.ok(b.notes.some((n) => /shot runs 6 s but fal-video makes 5 or 10 s clips, so this clip is 10 s \(4 s longer than the shot, billed.*--fit nearest/.test(n)), b.notes.join('|'));
    const near = buildMotionJob(p, { provider: 'fal-video', fit: 'nearest' });
    assert.equal(near.job.items[0]!.duration_s, 5);
    assert.match(near.job.label, /sc1_sh1 5 s x 0\.07 USD\/s = 0\.35$/);
    assert.ok(near.notes.some((n) => /1 s SHORTER than the shot/.test(n)), near.notes.join('|'));
    assert.notEqual(near.job.id, b.job.id, 'a different length is a different job');
    // a shot longer than anything the model makes gets the longest, and says so
    const long = funded();
    long.shots[0]!.duration_s = 14;
    assert.ok(buildMotionJob(long, { provider: 'fal-video' }).notes.some((n) => /4 s SHORTER/.test(n) && /the longest it makes/.test(n)));
    assert.ok(b.notes.some((n) => /Sound is off/.test(n)));
  });

  it('--units / --scene put several clips in one job', () => {
    const p = funded();
    const two = buildMotionJob(p, { provider: 'fal-video', units: [CLIP1, 'sc1_sh4_clip'] });
    assert.deepEqual(two.units, [CLIP1, 'sc1_sh4_clip']);
    assert.deepEqual(two.job.items.map((i) => i.duration_s), [10, 10]);
    const scene = buildMotionJob(p, { provider: 'fal-video', scene: 'sc1' });
    assert.deepEqual(scene.units, ['sc1_sh1_clip', 'sc1_sh2_clip', 'sc1_sh3_clip', 'sc1_sh4_clip']);
  });

  it('the job id changes with provider, model, length and sound (an approval binds to the amount)', () => {
    const p = funded();
    const ids = new Set([
      buildMotionJob(p, { provider: 'fal-video' }).job.id,
      buildMotionJob(p, { provider: 'manual' }).job.id,
      buildMotionJob(p, { provider: 'fal-video', model: 'fal-ai/kling-video/v2.6/pro/image-to-video', audio: true }).job.id,
      buildMotionJob(p, { provider: 'fal-video', units: ['sc1_sh4_clip'] }).job.id,
    ]);
    assert.equal(ids.size, 4);
    const q = funded();
    q.shots[0]!.duration_s = 3;
    assert.notEqual(buildMotionJob(q, { provider: 'fal-video' }).job.id, buildMotionJob(p, { provider: 'fal-video' }).job.id);
    assert.equal(buildMotionJob(p, { provider: 'fal-video' }).job.id, buildMotionJob(p, { provider: 'fal-video' }).job.id, 'deterministic');
  });

  it('sound is off by default and is its own, dearer model when asked for', async () => {
    const p = funded();
    const silent = buildMotionJob(p, { provider: 'fal-video' });
    const loud = buildMotionJob(p, { provider: 'fal-video', model: 'fal-ai/kling-video/v2.6/pro/image-to-video', audio: true });
    assert.match(silent.job.items[0]!.prompt, /Sound: none/);
    assert.match(loud.job.items[0]!.prompt, /natural ambient sound/);
    assert.match(loud.job.model!, /#audio$/);
    assert.ok(!loud.notes.some((n) => /Sound is off/.test(n)));
    const r = rig('fal-video', p);
    const a = await r.gate.quote(silent.job);
    const b = await r.gate.quote(loud.job);
    assert.ok(b.cost.amount > a.cost.amount);
    assert.match(loud.job.label, /0\.14 USD\/s/);
    // a model with no sound variant says so instead of silently staying silent
    assert.throws(() => buildMotionJob(p, { provider: 'fal-video', audio: true }), /has no sound option/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the spend gate: one clip, shown per second, approved for that amount', () => {
  it('without a budget the paid provider is refused with the setup pointer', async () => {
    const r = rig('fal-video', planned());
    const step = await generateClips(deps(r), { provider: 'fal-video' });
    assert.equal(step.status, 'refused');
    assert.match(step.status === 'refused' ? step.message : '', /Run `\/akuko setup`/);
    assert.equal(r.net!.calls.length, 0);
  });

  it('is refused on host A (a paid direct API)', async () => {
    const r = rig('fal-video', funded(), 'A');
    const step = await generateClips(deps(r), { provider: 'fal-video' });
    assert.ok(step.status === 'refused' && /host-not-supported|paid-direct-on-host-a/.test(step.code), JSON.stringify(step));
  });

  it('shows the per-second spend line, sends nothing until approved, then runs and records the clip for review', async () => {
    const r = rig('fal-video', funded());
    const step = await generateClips(deps(r), { provider: 'fal-video' });
    assert.equal(step.status, 'awaiting-approval');
    if (step.status !== 'awaiting-approval') return;
    assert.ok(Math.abs(step.estimate - 0.7) < 1e-9);
    assert.match(step.confirmation, /sc1_sh1 10 s x 0\.07 USD\/s = 0\.7 \(10 s billed for a 6 s shot\)/);
    assert.match(step.confirmation, /estimate 0\.7 USD/);
    assert.match(step.confirmation, /Reply "approve 0\.7 USD"/);
    assert.equal(r.net!.calls.length, 0, 'nothing sent');
    assert.equal(r.host.peek().stages.motion.state, 'waiting-spend');
    assert.equal(asset(r.host.peek(), CLIP1).status, 'pending');
    assert.ok(step.notes?.some((n) => /so this clip is 10 s/.test(n)));

    r.host.set(approveSpend(r.host.peek(), step.job.id, 'motion').project);
    const done = await generateClips(deps(r), { provider: 'fal-video' });
    assert.equal(done.status, 'done', JSON.stringify(done));
    const posts = r.net!.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal((posts[0]!.body as Record<string, unknown>).duration, '10');
    const p = r.host.peek();
    const clip = asset(p, CLIP1);
    assert.equal(clip.status, 'pending-review');
    assert.equal(clip.file?.mime, 'video/mp4');
    assert.deepEqual([...(r.host.files.get(clip.file!.uri) ?? [])], [...MP4_BYTES]);
    assert.equal(p.stages.motion.state, 'in-progress', 'other clips still wait, so the stage is in progress');
    assert.equal(p.shots[0]!.status, 'approved', 'the shot is never touched');
    assert.equal(asset(p, 'sc1_sh1_keyframe').status, 'approved', 'nor is its key frame');
    assert.equal(p.ledger.length, 1);
    assert.ok(Math.abs((p.budget?.spent ?? 0) - 0.7) < 1e-9);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('approval binds to the amount: more seconds or sound under the same id needs approving again; a new model is a new job', async () => {
    const r = rig('fal-video', funded());
    const first = await generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] });
    assert.equal(first.status, 'awaiting-approval');
    r.host.set(approveSpend(r.host.peek(), first.job.id, 'motion').project);
    // the shot gets shorter, so the clip length (and price) changes: the id changes (length is in the hash) and the new job is held for its own approval
    const p = r.host.peek();
    p.shots[0]!.duration_s = 3;
    r.host.set(p);
    const longer = await generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] });
    assert.equal(longer.status, 'awaiting-approval');
    assert.notEqual(longer.job.id, first.job.id);
    if (longer.status === 'awaiting-approval') assert.ok(Math.abs(longer.estimate - 0.35) < 1e-9);
    assert.equal(r.net!.calls.length, 0);
  });

  it('a stage is in-review only when everything made waits for a person', async () => {
    const p = funded();
    // pretend every other clip is already made and waiting
    for (const a of clipAssets(p)) if (a.id !== CLIP1) { a.status = 'pending-review'; a.file = { uri: `mem://assets/${a.id}.mp4`, mime: 'video/mp4' }; }
    const r = rig('fal-video', p);
    await paidTake(r);
    assert.equal(r.host.peek().stages.motion.state, 'in-review');
    // and nothing in that run wrote "approved"
    assert.equal(r.host.peek().stages.motion.state === 'approved', false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('retry cap: paid attempts per shot', () => {
  it('counts done and failed paid entries for one clip and what they cost; manual takes do not count', () => {
    const p = funded();
    p.budget = { cap: 10, currency: 'USD', spent: 0.35 };
    p.ledger = [
      { id: 'a', ts: NOW, provider: 'fal-video', unit: CLIP1, estimate: 0.35, actual: 0.35, status: 'done', job: 'j1' },
      { id: 'b', ts: NOW, provider: 'fal-video', unit: CLIP1, estimate: 0.35, actual: 0.2, status: 'failed', job: 'j2' },
      { id: 'c', ts: NOW, provider: 'fal-video', unit: CLIP1, estimate: 0.35, status: 'submitted', job: 'j3' },
      { id: 'd', ts: NOW, provider: 'manual', unit: CLIP1, actual: 5, status: 'done' },
      { id: 'e', ts: NOW, provider: 'fal-video', unit: 'sc1_sh2_clip', estimate: 0.35, actual: 0.35, status: 'done', job: 'j4' },
      // nothing was sent or billed: a failed entry with no actual, and a batch clip that fell over (done at 0)
      { id: 'f', ts: NOW, provider: 'fal-video', unit: CLIP1, estimate: 0.35, status: 'failed', job: 'j5' },
      { id: 'g', ts: NOW, provider: 'fal-video', unit: CLIP1, estimate: 0.35, actual: 0, status: 'done', job: 'j6' },
    ];
    const t = paidAttempts(p, CLIP1);
    assert.equal(t.count, 2);
    assert.ok(Math.abs(t.spent - 0.55) < 1e-9);
    assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  });

  it('the 4th paid attempt on one shot is refused with the count and the spend; --max-attempts 4 allows it', async () => {
    const r = rig('fal-video', funded());
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const step = await paidTake(r);
      ids.push(step.job.id);
      // the person sends it back, in their own words
      const words = `take ${i}: slower, colder`;
      const sent = fold(r.host.peek(), [decision('request-changes', CLIP1, 'motion', { text: words })]);
      assert.deepEqual(sent.rejected, []);
      r.host.set(sent.project);
      assert.equal(asset(r.host.peek(), CLIP1).status, 'needs-rework');
    }
    assert.deepEqual(ids.map((x) => /_r(\d+)$/.exec(x)![1]), ['1', '2', '3'], 'each regeneration is the next _r<n>');
    assert.equal(new Set(ids.map((x) => x.replace(/_r\d+$/, ''))).size, 1);
    assert.equal(paidAttempts(r.host.peek(), CLIP1).count, 3);

    const posts = r.net!.calls.length;
    await assert.rejects(
      generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] }),
      (e: Error) => e instanceof MotionError && /3 paid attempts/.test(e.message) && /2\.1 USD has gone on it/.test(e.message) && /--max-attempts 4/.test(e.message) && /own words/.test(e.message),
    );
    // by default (no --units) the capped shot is skipped, and the next shot is the one made
    const next = await generateClips(deps(r), { provider: 'fal-video' });
    assert.equal(next.status, 'awaiting-approval');
    assert.deepEqual(next.job.items.map((i) => i.unit), ['sc1_sh2_clip']);
    assert.ok(next.skipped?.some((s) => s.unit === CLIP1 && /3 paid attempts/.test(s.reason)));
    assert.equal(r.net!.calls.length, posts, 'nothing was sent');

    const fourth = await generateClips(deps(r), { provider: 'fal-video', units: [CLIP1], maxAttempts: 4 });
    assert.equal(fourth.status, 'awaiting-approval');
    assert.match(fourth.job.id, /_r4$/);
    // and the old take's words are in the new prompt
    assert.match(fourth.job.items[0]!.prompt, /take 3: slower, colder/);
    assert.equal(r.net!.calls.length, posts);
  });

  it('a failed paid call counts against the cap like any other attempt', async () => {
    const r = rig('fal-video', funded());
    const p = r.host.peek();
    p.budget = { cap: 10, currency: 'USD', spent: 0 };
    p.ledger = [1, 2, 3].map((n) => ({ id: `f${n}`, ts: NOW, provider: 'fal-video', unit: CLIP1, estimate: 0.35, actual: 0.35, status: 'failed' as const, job: `jf${n}` }));
    r.host.set({ ...p, budget: { cap: 10, currency: 'USD', spent: 0 } });
    await assert.rejects(generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] }), /3 paid attempts/);
  });

  it('attempts where nothing was sent (no key, a refused frame: failed with no actual) are not counted and cost nothing', () => {
    const p = funded();
    p.ledger = [1, 2, 3, 4].map((n) => ({ id: `n${n}`, ts: NOW, provider: 'fal-video', unit: CLIP1, estimate: 0.7, status: 'failed' as const, job: `jn${n}` }));
    assert.deepEqual(paidAttempts(p, CLIP1), { count: 0, spent: 0 });
    assert.doesNotThrow(() => buildMotionJob(p, { provider: 'fal-video', units: [CLIP1] }));
  });

  it('--max-attempts must be a sensible number', () => {
    assert.throws(() => buildMotionJob(funded(), { provider: 'fal-video', maxAttempts: 0 }), /whole number/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('rework and review: only a person approves', () => {
  it('needs-rework: the old take is cleared and kept, the person\'s words go in the prompt, a fresh approval is needed, state moves back', async () => {
    const r = rig('fal-video', funded());
    const first = await paidTake(r);
    const oldUri = asset(r.host.peek(), CLIP1).file!.uri;
    r.host.set(fold(r.host.peek(), [decision('request-changes', CLIP1, 'motion', { text: 'Pan more slowly and keep the lantern lit.' })]).project);
    assert.equal(asset(r.host.peek(), CLIP1).status, 'needs-rework');

    const again = await generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] });
    assert.equal(again.status, 'awaiting-approval', 'a regeneration is held for its own approval');
    assert.match(again.job.id, /_r2$/);
    assert.notEqual(again.job.id, first.job.id);
    assert.match(again.job.items[0]!.prompt, /Changes the person asked for: Pan more slowly and keep the lantern lit\./);
    assert.equal(r.host.peek().stages.motion.state, 'waiting-spend');

    r.host.set(approveSpend(r.host.peek(), again.job.id, 'motion').project);
    const done = await generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] });
    assert.equal(done.status, 'done');
    const clip = asset(r.host.peek(), CLIP1);
    assert.equal(clip.status, 'pending-review');
    assert.ok(clip.comments.some((c) => /Revised: regenerating/.test(c.text) && c.text.includes(oldUri)));
    assert.equal(clip.id, CLIP1, 'the new take fills the same asset');
  });

  it('a refused run puts the clip back exactly as it was', async () => {
    const r = rig('fal-video', funded());
    await paidTake(r);
    r.host.set(fold(r.host.peek(), [decision('request-changes', CLIP1, 'motion', { text: 'Again.' })]).project);
    const before = asset(r.host.peek(), CLIP1);
    const step = await generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] });
    assert.equal(step.status, 'awaiting-approval');
    assert.deepEqual(asset(r.host.peek(), CLIP1), before, 'no change until the run is accepted');
  });

  it('with the manual provider every clip is made and approved by a person; the stage is approved only by folding', async () => {
    const r = rig('manual', planned());
    const seen: string[] = [];
    let guard = 0;
    while (r.host.peek().stages.motion.state !== 'approved' && guard++ < 40) {
      const step = await generateClips(deps(r), { provider: 'manual' });
      assert.equal(step.status, 'handoff', `step ended ${step.status}`);
      seen.push(r.host.peek().stages.motion.state);
      for (const unit of step.status === 'handoff' ? step.handle.units : []) await ingestClip(deps(r), r.manual, step.job, unit, FILE);
      const p = r.host.peek();
      const waiting = clipAssets(p).filter((a) => a.status === 'pending-review').map((a) => a.id);
      assert.ok(waiting.length > 0);
      assert.notEqual(p.stages.motion.state, 'approved', 'nothing is approved by code');
      r.host.set(approve(p, waiting, 'motion').project);
      await finalizeMotion(deps(r));
    }
    const p = r.host.peek();
    assert.equal(p.stages.motion.state, 'approved');
    assert.ok(clipAssets(p).every((a) => a.status === 'approved' && a.file?.mime === 'video/mp4'));
    assert.ok(seen.every((s) => s === 'in-progress' || s === 'in-review'));
    assert.deepEqual(p.ledger, [], 'the manual path costs nothing and needs no key or budget');
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('the manual hand-off names the start frame, the length and the camera', async () => {
    const r = rig('manual', planned());
    const step = await generateClips(deps(r), { provider: 'manual' });
    assert.equal(step.status, 'handoff');
    const text = step.status === 'handoff' ? step.text : '';
    assert.match(text, /mem:\/\/assets\/sc1_sh1_keyframe\.png/);
    assert.match(text, /start-frame/);
    assert.match(text, /Camera: Static, low angle/);
    assert.match(text, /6\.0s|6s|6 second/);
    assert.match(text, /sc1_sh1_clip-motion\.mp4/);
    // one manual take back, recorded for review without any key
    const ing = await ingestClip(deps(r), r.manual, step.job, CLIP1, FILE, { actual: 0 });
    assert.equal(ing.asset, CLIP1);
    assert.equal(asset(r.host.peek(), CLIP1).status, 'pending-review');
  });

  it('refreshStageState never sets approved and never touches locked', () => {
    const p = planned();
    p.stages.motion = { state: 'locked' };
    assert.equal(refreshStageState(p).stages.motion.state, 'locked');
    const q = planned();
    for (const a of clipAssets(q)) { a.status = 'pending-review'; a.file = { uri: 'x.mp4', mime: 'video/mp4' }; }
    assert.equal(refreshStageState(q).stages.motion.state, 'in-review');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('doctor and config', () => {
  it('doctor lists the new provider key by name only', () => {
    const keep = process.env.FAL_KEY;
    try {
      delete process.env.FAL_KEY;
      const read = (): string => { const l: string[] = []; doctor([process.cwd()], (x) => l.push(x)); return l.join('\n'); };
      assert.match(read(), /fal-video\s+FAL_KEY: not set/);
      process.env.FAL_KEY = 'super-secret-value-123';
      const out = read();
      assert.match(out, /fal-video\s+FAL_KEY: set/);
      assert.ok(!out.includes('super-secret-value-123'));
      assert.deepEqual(keyPresence(CFG, { FAL_KEY: 'x' })['fal-video'], { env: 'FAL_KEY', present: true });
    } finally {
      if (keep === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = keep;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('a batch that partly fails', () => {
  it('keeps the clips that were made and billed; the failed one stays draft and is remade by a new job with its own approval', async () => {
    const r = rig('fal-video', funded(), 'B', mockFalVideo({ error: (n) => (n === 3 ? 'content policy' : undefined) }));
    const first = await generateClips(deps(r), { provider: 'fal-video', scene: 'sc1' });
    assert.equal(first.status, 'awaiting-approval');
    r.host.set(approveSpend(r.host.peek(), first.job.id, 'motion').project);
    const done = await generateClips(deps(r), { provider: 'fal-video', scene: 'sc1' });
    assert.equal(done.status, 'done', JSON.stringify(done));
    if (done.status !== 'done') return;
    assert.deepEqual(done.missing, ['sc1_sh3_clip']);
    assert.match(done.message ?? '', /content policy/);
    assert.deepEqual([...done.assets].sort(), ['sc1_sh1_clip', 'sc1_sh2_clip', 'sc1_sh4_clip']);

    const p = r.host.peek();
    for (const id of ['sc1_sh1_clip', 'sc1_sh2_clip', 'sc1_sh4_clip']) assert.equal(asset(p, id).status, 'pending-review', id);
    assert.equal(asset(p, 'sc1_sh3_clip').status, 'draft');
    assert.equal(asset(p, 'sc1_sh3_clip').file, undefined);
    assert.equal(p.ledger.length, 4);
    assert.equal(p.ledger.find((e) => e.unit === 'sc1_sh3_clip')?.actual, 0, 'the failed clip is not billed');
    assert.ok(p.ledger.every((e) => e.status === 'done'), 'nothing is left submitted');
    assert.ok(Math.abs((p.budget?.spent ?? 0) - 1.75) < 1e-9, 'only the three made clips are paid for');
    assert.ok(Math.abs(done.cost - 1.75) < 1e-9);
    assert.deepEqual(paidAttempts(p, 'sc1_sh3_clip'), { count: 0, spent: 0 });

    const posts = r.net!.calls.filter((c) => c.method === 'POST').length;
    const retry = await generateClips(deps(r), { provider: 'fal-video', scene: 'sc1' });
    assert.equal(retry.status, 'awaiting-approval', 'the remake needs its own approval');
    assert.deepEqual(retry.job.items.map((i) => i.unit), ['sc1_sh3_clip']);
    assert.notEqual(retry.job.id, first.job.id);
    assert.ok(retry.status === 'awaiting-approval' && Math.abs(retry.estimate - 0.35) < 1e-9);
    assert.equal(r.net!.calls.filter((c) => c.method === 'POST').length, posts, 'nothing was sent');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('collecting can fail without losing the job', () => {
  it('the job is handed over as soon as it is submitted; a failing collect comes back as running, and collect later records the clip', async () => {
    let broken = true;
    const r = rig('fal-video', funded(), 'B', mockFalVideo({ resultFail: () => (broken ? '5xx' : undefined) }));
    const saved: Array<{ id: string; ref: string }> = [];
    const d = { ...deps(r), onSubmitted: async (job: { id: string }, handle: { ref: string }) => { saved.push({ id: job.id, ref: handle.ref }); } };
    const first = await generateClips(d, { provider: 'fal-video', units: [CLIP1] });
    assert.equal(first.status, 'awaiting-approval');
    r.host.set(approveSpend(r.host.peek(), first.job.id, 'motion').project);

    const step = await generateClips(d, { provider: 'fal-video', units: [CLIP1] });
    assert.equal(step.status, 'running', JSON.stringify(step));
    assert.equal(saved.length, 1, 'saved before collecting');
    assert.equal(saved[0]!.id, first.job.id);
    assert.ok(r.host.peek().ledger.every((e) => e.status === 'submitted'), 'the reservation is held, and the saved job can release it');
    assert.equal(asset(r.host.peek(), CLIP1).status, 'draft');

    broken = false;
    if (step.status !== 'running') return;
    const done = await collectClips(d, step.job, step.handle);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(asset(r.host.peek(), CLIP1).status, 'pending-review');
    assert.ok(Math.abs((r.host.peek().budget?.spent ?? 0) - 0.7) < 1e-9);
  });

  it('a collect that throws is reported as running, never thrown', async () => {
    const r = rig('fal-video', funded());
    const first = await generateClips(deps(r), { provider: 'fal-video', units: [CLIP1] });
    r.host.set(approveSpend(r.host.peek(), first.job.id, 'motion').project);
    const gate = { quote: r.gate.quote, run: r.gate.run, collect: async () => { throw new Error('offline'); } };
    const step = await generateClips({ ...deps(r), gate }, { provider: 'fal-video', units: [CLIP1] });
    assert.equal(step.status, 'running');
    assert.match(step.status === 'running' ? step.message : '', /could not finish collecting yet \(offline\)/);
  });
});
