// WP-22 — the key-frame stage: one final frame per shot, from the approved
// bible images, through the spend gate.
//
// Runs on WP-04's test story (the converted fixture "The Last Ferry") with the
// manual provider and with the Gemini and fal providers on a mocked network.
// Nothing here makes a live call. "Approved" is only ever the result of folding
// a decision a person wrote through a conformed view; `guardedHost` fails any
// write that would newly set it from code.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkIntegrity } from '../schema/integrity.ts';
import { listUnits, type AkukoProject } from '../schema/akuko-project.ts';
import { loadProviderConfig } from '../providers/config.ts';
import type { Provider, WaveOneHost } from '../providers/contract.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createGeminiImageProvider } from '../providers/gemini-image/index.ts';
import { createFalImageProvider } from '../providers/fal/index.ts';
import { PNG_BYTES, mockFal, mockGemini, type MockNet } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { createFakeHost, type FakeHost } from '../providers/__fixtures__/fake-host.ts';
import { SETUP_POINTER, SpendGateBypassError, createSpendGate, type SpendGate } from '../spend/gate.ts';
import { loadConformedFile } from '../decisions/conformed.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { MAX_REFS, bibleAssets, planBible, syncRefs } from '../bible/plan.ts';
import { breakdownApproved } from '../bible/__fixtures__/project.ts';
import { blockingText, keyframePrompt } from './prompts.ts';
import {
  KeyframeError,
  assertOpen,
  buildKeyframeJob,
  keyframeAssets,
  keyframeStatus,
  neededRefs,
  planKeyframes,
  refreshStageState,
  unitReadiness,
} from './plan.ts';
import { finalizeKeyframes, generateKeyframes, ingestKeyframe, type StepResult } from './run.ts';
import { approve, approveSpend, bibleApproved, decision, fold } from './__fixtures__/project.ts';

const NOW = '2026-11-08T10:00:00Z';
const now = (): string => NOW;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const asset = (p: AkukoProject, id: string) => p.assets.find((a) => a.id === id)!;
const kf = (shot: string): string => `${shot}_keyframe`;
const SCENE1 = ['sc1_sh1', 'sc1_sh2', 'sc1_sh3', 'sc1_sh4'];
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

const planned = (opts: { budget?: { cap: number; currency: string } } = {}): AkukoProject => planKeyframes(bibleApproved(opts), NOW).project;

interface Rig {
  host: FakeHost;
  guarded: WaveOneHost;
  gate: SpendGate;
  providerId: string;
  net?: MockNet;
  manual: ReturnType<typeof createManualProvider>;
  paid: boolean;
}

function rig(kind: 'manual' | 'gemini-image' | 'fal', project: AkukoProject, level: 'A' | 'B' | 'C' = 'B'): Rig {
  const host = createFakeHost(project);
  const guarded = guardedHost(host);
  const manual = createManualProvider(guarded, { now });
  const providers: Provider[] = [manual.provider];
  let net: MockNet | undefined;
  const loadRef = async () => ({ mime: 'image/png', data: PNG_BYTES });
  if (kind === 'gemini-image') {
    net = mockGemini();
    providers.push(createGeminiImageProvider(guarded, { fetch: net.fetch, apiKey: 'test-key', loadRef, now }));
  } else if (kind === 'fal') {
    net = mockFal();
    providers.push(createFalImageProvider(guarded, { fetch: net.fetch, apiKey: 'test-key', loadRef, now }));
  }
  const gate = createSpendGate({ host: guarded, providers, level, now });
  return { host, guarded, gate, providerId: kind, ...(net ? { net } : {}), manual, paid: kind !== 'manual' };
}

const deps = (r: Rig) => ({ host: r.guarded, gate: r.gate, now });
const FILE = { filename: 'from-person.png', mime: 'image/png', data: PNG_BYTES };

/** Everything the person does after a step: bring files back (manual), then approve what is waiting. */
async function personReviews(r: Rig, step: StepResult): Promise<string[]> {
  if (step.status === 'handoff') {
    for (const unit of step.handle.units) await ingestKeyframe(deps(r), r.manual, step.job, unit, FILE);
  }
  const p = r.host.peek();
  const waiting = keyframeAssets(p).filter((a) => a.status === 'pending-review').map((a) => a.id);
  assert.ok(waiting.length > 0, 'something is waiting for review');
  r.host.set(approve(p, waiting, 'keyframes').project);
  await finalizeKeyframes(deps(r));
  return waiting;
}

/** One step, approving the spend when asked. Returns the finished step. */
async function stepOnce(r: Rig, o: { units?: string[]; scene?: string } = {}): Promise<{ step: StepResult; held: boolean }> {
  const opts = { provider: r.providerId, ...o };
  let step = await generateKeyframes(deps(r), opts);
  let held = false;
  if (step.status === 'awaiting-approval') {
    held = true;
    assert.ok(r.paid, 'a free job is never held for approval');
    assert.equal(r.host.peek().stages.keyframes.state, 'waiting-spend');
    r.host.set(approveSpend(r.host.peek(), step.job.id, 'keyframes').project);
    step = await generateKeyframes(deps(r), opts);
  }
  assert.ok(step.status === 'handoff' || step.status === 'done', `step ended ${step.status}`);
  return { step, held };
}

// ─────────────────────────────────────────────────────────────────────────
describe('the prompt: composition as text, nothing invented', () => {
  it('describes blocking as thirds and size, in the order given', () => {
    const t = blockingText([
      { who: 'Mara', shape: 'rect', x: 0.05, y: 0.55, w: 0.3, h: 0.4 },
      { who: 'Oren', shape: 'ellipse', x: 0.8, y: 0.3, w: 0.1, h: 0.2 },
    ]);
    assert.equal(t, 'Mara: left third, lower third, medium; Oren: right third, upper third, small');
    assert.match(blockingText([]), /No blocking was set/);
  });

  it('carries the shot fields, the scene, the look and the person\'s requested changes', () => {
    const p = planned();
    const built = buildKeyframeJob(p, { provider: 'manual', units: [kf('sc1_sh4')] });
    const prompt = built.job.items[0]!.prompt;
    assert.match(prompt, /Shot sc1_sh4: ots/);
    assert.match(prompt, /Camera: Over Mara's shoulder/);
    assert.match(prompt, /Scene: EXT\. RIVER PIER - DUSK/);
    assert.match(prompt, /Mara - Thirties/);
    assert.match(prompt, /Oren - Sixties/);
    assert.match(prompt, /Look \(match the attached lookbook\): Fog and Lamplight/);
    assert.match(prompt, /No blocking was set/);
    assert.equal(built.job.items[0]!.aspect_ratio, '16:9');
    assert.match(keyframePrompt({ shot: p.shots[0]!, aspect: '16:9', scene: '', look: '', characters: [], location: undefined }, 'Colder.'), /Changes the person asked for: Colder\./);
  });

  it('puts the composition in the prompt and attaches no sketch file (the panel is an SVG and no provider takes SVG)', () => {
    const p = planned();
    p.shots[0]!.blocking = [{ who: 'Mara', shape: 'rect', x: 0.1, y: 0.4, w: 0.2, h: 0.3 }];
    p.shots[0]!.by_stage = { ...p.shots[0]!.by_stage, sketch: { status: 'approved', output: { uri: 'board/panels/sc1_sh1-sketch.svg', mime: 'image/svg+xml' } } };
    const item = buildKeyframeJob(p, { provider: 'manual', units: [kf('sc1_sh1')] }).job.items[0]!;
    assert.match(item.prompt, /Mara: left third, middle third, medium/);
    assert.ok(item.refs!.every((r) => !/\.svg$/.test(r.uri ?? '')), 'no svg reference');
  });

  it('is brand-neutral', () => {
    const text = readFileSync(join(ROOT, 'keyframes/prompts.ts'), 'utf8').toLowerCase();
    for (const w of [['roy', 'alti'], ['dix', 'trit'], ['ike', 'nga']].map((x) => x.join(''))) assert.ok(!text.includes(w), w);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('gating and planning', () => {
  it('opens only when every earlier stage is approved, naming the one that waits', () => {
    for (const stage of ['breakdown', 'sketch', 'bible'] as const) {
      const p = bibleApproved();
      p.stages[stage] = { state: 'in-review' };
      assert.throws(() => planKeyframes(p, NOW), (e: Error) => e instanceof KeyframeError && new RegExp(`locked: ${stage} is "in-review"`).test(e.message), stage);
    }
  });

  it('refuses while a shot is not approved', () => {
    const p = bibleApproved();
    p.shots[0]!.status = 'needs-rework';
    assert.throws(() => assertOpen(p), /shots are not approved yet: sc1_sh1/);
  });

  it('folding the last bible approval unlocks it', () => {
    const p = bibleApproved();
    assert.equal(p.stages.bible.state, 'approved');
    assert.notEqual(p.stages.keyframes.state, 'locked');
    assert.doesNotThrow(() => assertOpen(p));
  });

  it('plans one key frame per shot, owned by the shot; the shots keep their sketch approval', () => {
    const before = bibleApproved();
    const r = planKeyframes(before, NOW);
    assert.equal(r.created.length, before.shots.length);
    assert.deepEqual(r.created.slice(0, 2), ['sc1_sh1_keyframe', 'sc1_sh2_keyframe']);
    for (const a of keyframeAssets(r.project)) {
      assert.equal(a.stage, 'keyframes');
      assert.equal(a.kind, 'keyframe');
      assert.equal(a.status, 'pending');
      assert.equal(a.file, undefined);
      assert.ok(r.project.shots.some((s) => s.id === a.owner));
    }
    assert.deepEqual(r.project.shots, before.shots, 'no shot is touched');
    assert.equal(r.project.stages.keyframes.state, 'in-progress');
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('is idempotent', () => {
    const once = planned();
    const twice = planKeyframes(once, NOW);
    assert.deepEqual(twice.created, []);
    assert.deepEqual(twice.project, once);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('references: the approved turnarounds, plates and lookbook', () => {
  it('scene 1 shots get the principals\' turnarounds, then the plate, then the lookbook', () => {
    const p = planned();
    const refs = (id: string) => buildKeyframeJob(p, { provider: 'manual', units: [kf(id)] }).job.items[0]!.refs!.map((r) => [r.id, r.role]);
    assert.deepEqual(refs('sc1_sh1'), [['char_mara_turnaround', 'character'], ['loc_river-pier_plate', 'location'], ['style_fog-and-lamplight_lookbook', 'style']]);
    assert.deepEqual(refs('sc1_sh2'), [['char_oren_turnaround', 'character'], ['loc_river-pier_plate', 'location'], ['style_fog-and-lamplight_lookbook', 'style']]);
    assert.deepEqual(refs('sc1_sh4').map((x) => x[0]), ['char_mara_turnaround', 'char_oren_turnaround', 'loc_river-pier_plate', 'style_fog-and-lamplight_lookbook']);
  });

  it('every reference carries the approved file\'s uri', () => {
    const p = planned();
    for (const r of buildKeyframeJob(p, { provider: 'manual', units: [kf('sc1_sh4')] }).job.items[0]!.refs!) {
      assert.equal(r.uri, asset(p, r.id).file!.uri);
    }
  });

  it('a supporting character with no turnaround is represented by the portrait', () => {
    const p = planned();
    const shot = p.shots.find((s) => s.refs.includes('char_the-woman'))!;
    assert.ok(shot, 'the story has a shot with the supporting character');
    const ids = neededRefs(p, shot).map((n) => n.asset.id);
    assert.ok(ids.includes('char_the-woman_portrait'));
    assert.ok(!ids.includes('char_the-woman_turnaround'));
  });

  it('a Background character gets no reference image and is named in the prompt text only', () => {
    const p = planned();
    p.bible.characters.push({ id: 'char_crowd', name: 'Dock crowd', role: 'Background', description: 'A few figures far back.', notes: [], refs: [], status: 'approved', stage: 'breakdown', comments: [] });
    p.shots[0]!.refs.push('char_crowd');
    const item = buildKeyframeJob(p, { provider: 'manual', units: [kf('sc1_sh1')] }).job.items[0]!;
    assert.ok(item.refs!.every((r) => !r.id.includes('crowd')));
    assert.match(item.prompt, /with no reference image .*Dock crowd - A few figures far back./);
  });

  it('a shot that names no style still gets the film\'s lookbook', () => {
    const p = planned();
    p.shots[0]!.refs = p.shots[0]!.refs.filter((r) => !r.startsWith('style_'));
    const refs = buildKeyframeJob(p, { provider: 'manual', units: [kf('sc1_sh1')] }).job.items[0]!.refs!.map((r) => r.id);
    assert.ok(refs.includes('style_fog-and-lamplight_lookbook'));
  });

  it('is blocked, and refused, while a referenced image is not approved with its file', () => {
    const p = planned();
    asset(p, 'char_mara_turnaround').status = 'pending-review';
    const u = asset(p, kf('sc1_sh1'));
    assert.deepEqual(unitReadiness(p, u), { state: 'blocked', waiting: ['char_mara_turnaround'] });
    assert.throws(() => buildKeyframeJob(p, { provider: 'manual', units: [u.id] }), /cannot be generated now \(blocked; its bible references are not approved: char_mara_turnaround\)/);
    // a shot that does not use it is unaffected
    assert.equal(unitReadiness(p, asset(p, kf('sc1_sh2'))).state, 'ready');
  });

  it('an approved image whose file is missing does not count', () => {
    const p = planned();
    delete asset(p, 'loc_river-pier_plate').file;
    assert.equal(unitReadiness(p, asset(p, kf('sc1_sh1'))).state, 'blocked');
  });

  it('an approved image the entry does not list in refs[] is not used until syncRefs has run', () => {
    const p = planned();
    p.bible.locations.find((l) => l.id === 'loc_river-pier')!.refs = [];
    assert.deepEqual(unitReadiness(p, asset(p, kf('sc1_sh1'))).waiting, ['loc_river-pier_plate']);
    assert.equal(unitReadiness(syncRefs(p, NOW).project, asset(p, kf('sc1_sh1'))).state, 'ready');
  });

  it('refuses a shot with more than 14 reference images, naming the unit', () => {
    const p = planned();
    for (let i = 0; i < MAX_REFS; i++) {
      p.assets.push({ id: `ref${i}`, stage: 'keyframes', status: 'approved', comments: [], kind: 'reference', owner: 'sc1_sh1', tags: [], file: { uri: `r${i}.png`, mime: 'image/png' } });
    }
    assert.throws(() => buildKeyframeJob(p, { provider: 'manual', units: [kf('sc1_sh1')] }), /sc1_sh1_keyframe would send 17 reference images/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
for (const kind of ['manual', 'gemini-image', 'fal'] as const) {
  describe(`full flow with the ${kind} provider`, () => {
    const paid = kind !== 'manual';
    const project = () => planned(paid ? { budget: { cap: 20, currency: 'USD' } } : {});

    it('scene 1, one shot at a time: quote → approval → gate → pending-review → approval; then the rest, and the stage is approved by folding', async () => {
      const r = rig(kind, project());
      const order: string[] = [];
      let guard = 0;
      while (r.host.peek().stages.keyframes.state !== 'approved' && guard++ < 20) {
        const { step, held } = await stepOnce(r);
        assert.equal(step.job.items.length, 1, 'one shot per job');
        assert.equal(held, paid, paid ? 'every paid job waited for the person' : 'a free job is never held');
        const unit = step.job.items[0]!.unit;
        // the job's refs were approved with files when it was built
        for (const ref of step.job.items[0]!.refs!) {
          assert.equal(asset(r.host.peek(), ref.id).status, 'approved');
          assert.ok(ref.uri);
        }
        const waiting = await personReviews(r, step);
        assert.deepEqual(waiting, [unit]);
        order.push(unit);
        if (order.length === SCENE1.length) {
          // scene 1 done: its four frames are approved, the stage is not
          for (const s of SCENE1) assert.equal(asset(r.host.peek(), kf(s)).status, 'approved');
          assert.notEqual(r.host.peek().stages.keyframes.state, 'approved');
        }
      }
      const p = r.host.peek();
      assert.deepEqual(order.slice(0, 4), SCENE1.map(kf));
      assert.equal(order.length, p.shots.length);
      assert.equal(p.stages.keyframes.state, 'approved');
      assert.notEqual(p.stages.motion.state, 'locked', 'motion unlocked by folding');
      for (const a of keyframeAssets(p)) {
        assert.equal(a.status, 'approved');
        assert.ok(a.file, `${a.id} has a file`);
        assert.ok(a.tags.some((t) => t.startsWith('job:job_kf_')), 'carries its job tag');
      }
      assert.equal(p.assets.filter((a) => a.kind === 'keyframe').length, p.shots.length, 'filled in place: no second asset');
      assert.deepEqual(checkIntegrity(p), []);

      if (!paid) {
        assert.equal(p.budget, null);
        assert.equal(p.ledger.length, 0);
        assert.equal(p.pending_spend.length, 0);
      } else {
        const n = p.shots.length;
        assert.equal(p.pending_spend.filter((j) => j.stage === 'keyframes' && j.status === 'approved').length, n);
        assert.equal(p.ledger.filter((e) => e.status === 'done' && e.unit.endsWith('_keyframe')).length, n);
        const cfg = loadProviderConfig().providers[kind]!;
        const price = cfg.models[cfg.default_model]!.price.amount;
        assert.ok(Math.abs((p.budget?.spent ?? 0) - n * price) < 1e-6, `spent ${p.budget?.spent}`);
        assert.equal(r.net!.calls.filter((c) => c.method === 'POST').length, n);
      }
    });

    it('the first scene-1 key frame is generated with the principal\'s turnaround, the plate and the lookbook attached', async () => {
      const r = rig(kind, project());
      const { step } = await stepOnce(r, { units: [kf('sc1_sh4')] });
      assert.deepEqual(step.job.items[0]!.refs!.map((x) => x.id), ['char_mara_turnaround', 'char_oren_turnaround', 'loc_river-pier_plate', 'style_fog-and-lamplight_lookbook']);
      if (paid) {
        const text = JSON.stringify(r.net!.calls.filter((c) => c.method === 'POST')[0]!.body);
        assert.match(text, /Reference image 1 \(character\)/);
        assert.match(text, /Reference image 2 \(character\)/);
        assert.match(text, /Reference image 3 \(location\)/);
        assert.match(text, /Reference image 4 \(style\)/);
        assert.match(text, /Over Mara's shoulder/);
      } else if (step.status === 'handoff') {
        assert.match(step.text, /sc1_sh4_keyframe/);
      }
      // the unit is pending-review only after output, and stamped with what it was made from
      await personReviews(r, step);
      const stamps = asset(r.host.peek(), kf('sc1_sh4')).tags.filter((t) => t.startsWith('from:'));
      assert.equal(stamps.length, 4);
    });

    it('a batch job for a whole scene is one approval for the shown total', async () => {
      const r = rig(kind, project());
      const { step } = await stepOnce(r, { scene: 'sc1' });
      assert.deepEqual(step.job.items.map((i) => i.unit), SCENE1.map(kf));
      if (paid) {
        const p = r.host.peek();
        assert.equal(p.pending_spend.filter((j) => j.stage === 'keyframes').length, 1);
        assert.equal(r.net!.calls.filter((c) => c.method === 'POST').length, 4);
        assert.equal(p.ledger.filter((e) => e.status === 'done').length, 4);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
describe('the spend gate is the only way in', () => {
  const paidProject = () => planned({ budget: { cap: 20, currency: 'USD' } });

  it('nothing in keyframes/ can reach a provider except through gate.run()', () => {
    const strip = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const f = join(dir, n);
        return statSync(f).isDirectory() ? walk(f) : n.endsWith('.ts') && !n.endsWith('.test.ts') ? [f] : [];
      });
    const files = walk(join(ROOT, 'keyframes'));
    assert.ok(files.length >= 4);
    for (const f of files) {
      const code = strip(readFileSync(f, 'utf8'));
      assert.deepEqual(code.split('\n').filter((l) => /\bsubmit\b/.test(l)), [], f);
      assert.doesNotMatch(code, /\bfetch\(/, f);
      // only cli.ts builds providers, and only to hand them to the gate
      if (!f.endsWith('cli.ts')) assert.doesNotMatch(code, /providers\/(gemini-image|fal)\/index/, f);
    }
  });

  it('a paid generation with no budget is refused with the setup pointer and sends nothing', async () => {
    const r = rig('gemini-image', planned());
    const s = await generateKeyframes(deps(r), { provider: 'gemini-image' });
    assert.equal(s.status, 'refused');
    if (s.status === 'refused') assert.equal(s.message, SETUP_POINTER);
    assert.equal(r.net!.calls.length, 0);
    assert.equal(asset(r.host.peek(), kf('sc1_sh1')).status, 'pending', 'the unit was not started');
  });

  it('nothing is sent while the spend awaits approval, after a decline, or on an under-stated approval', async () => {
    const r = rig('fal', paidProject());
    const first = await generateKeyframes(deps(r), { provider: 'fal' });
    assert.equal(first.status, 'awaiting-approval');
    if (first.status === 'awaiting-approval') assert.match(first.confirmation, /Reply "approve \d+\.\d\d USD"/);
    assert.equal((await generateKeyframes(deps(r), { provider: 'fal' })).status, 'awaiting-approval');
    assert.equal(r.host.peek().pending_spend.length, 1, 'asking twice makes one pending entry');
    // less than the amount shown: refused by the gate's bound
    const p = r.host.peek();
    const low = fold(p, [decision('approve-spend', first.job.id, 'keyframes', { text: 'approve 0.0001 USD' })]);
    assert.equal(low.rejected.length, 1);
    assert.equal(low.rejected[0]!.code, 'spend-refused');
    assert.match(low.rejected[0]!.reason, /you approved 0.0001 USD.*approve the new amount/);
    r.host.set(low.project);
    assert.equal((await generateKeyframes(deps(r), { provider: 'fal' })).status, 'awaiting-approval');
    r.host.set(fold(r.host.peek(), [decision('decline-spend', first.job.id, 'keyframes')]).project);
    assert.equal((await generateKeyframes(deps(r), { provider: 'fal' })).status, 'refused');
    assert.equal(r.net!.calls.length, 0);
    assert.equal(asset(r.host.peek(), kf('sc1_sh1')).status, 'pending');
  });

  it('a spend approval from a view that is not conformed does not release the job', async () => {
    const r = rig('gemini-image', paidProject());
    const first = await generateKeyframes(deps(r), { provider: 'gemini-image' });
    const p = r.host.peek();
    const bad = decision('approve-spend', first.job.id, 'keyframes', { text: `approve ${p.pending_spend[0]!.estimate.toFixed(2)} USD`, view: 'unchecked-page@1' });
    const f = fold(p, [bad]);
    assert.equal(f.rejected.length, 1);
    r.host.set(f.project);
    assert.equal((await generateKeyframes(deps(r), { provider: 'gemini-image' })).status, 'awaiting-approval');
    assert.equal(r.net!.calls.length, 0);
  });

  it('host A refuses a paid direct API (R-11) and sends nothing; the manual provider still works there', async () => {
    const a = rig('gemini-image', paidProject(), 'A');
    // R-11: on host A a direct API quotes for free (the spend line) but never sends without the pasted key and the phases (spend/host-a.test.ts).
    assert.ok(['refused', 'awaiting-approval'].includes((await generateKeyframes(deps(a), { provider: 'gemini-image' })).status));
    assert.equal(a.net!.calls.length, 0);
    const m = rig('manual', planned(), 'A');
    const s = await generateKeyframes(deps(m), { provider: 'manual' });
    assert.equal(s.status, 'handoff');
    if (s.status === 'handoff') assert.match(s.text, /sc1_sh1_keyframe/);
  });

  it('calling a sealed provider directly throws, whatever the key-frame code does', async () => {
    const r = rig('gemini-image', paidProject());
    const direct = createGeminiImageProvider(r.guarded, { apiKey: 'k', fetch: r.net!.fetch });
    const { job } = buildKeyframeJob(r.host.peek(), { provider: 'gemini-image' });
    await assert.rejects(direct.submit(job), SpendGateBypassError);
    assert.equal(r.net!.calls.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('approval is a person\'s, through a conformed view', () => {
  const U = kf('sc1_sh1');

  async function produced() {
    const r = rig('manual', planned());
    const s = await generateKeyframes(deps(r), { provider: 'manual' });
    if (s.status !== 'handoff') throw new Error(s.status);
    await ingestKeyframe(deps(r), r.manual, s.job, U, FILE);
    return { r, s };
  }

  it('a produced key frame waits as pending-review and the stage is in-review once nothing else is pending', async () => {
    const { r } = await produced();
    const a = asset(r.host.peek(), U);
    assert.equal(a.status, 'pending-review');
    assert.ok(a.file);
    assert.deepEqual(a.by_stage?.keyframes?.status, 'pending-review');
  });

  it('an agent-authored approval is rejected; the person\'s through test-board@1 and through the shipped default-board@0.1 counts', async () => {
    const { r } = await produced();
    const forged = fold(r.host.peek(), [decision('approve', U, 'keyframes', { by: 'agent' })]);
    assert.equal(forged.rejected.length, 1);
    assert.equal(asset(forged.project, U).status, 'pending-review');

    assert.equal(asset(approve(r.host.peek(), [U], 'keyframes').project, U).status, 'approved');

    const shipped = loadConformedFile(join(ROOT, 'views/conformed.json'));
    const viaDefault = foldDecisions(r.host.peek(), [decision('approve', U, 'keyframes', { view: 'default-board@0.1' })], { conformed: shipped });
    assert.equal(viaDefault.report.rejected.length, 0, JSON.stringify(viaDefault.report.rejected));
    assert.equal(asset(viaDefault.project, U).status, 'approved');
  });

  it('a decision on a key frame with nothing produced yet is refused', () => {
    const p = planned();
    const f = fold(p, [decision('approve', U, 'keyframes')]);
    assert.equal(f.rejected.length, 1);
    assert.equal(asset(f.project, U).status, 'pending');
  });

  it('the stage is approved only when every key frame is', () => {
    const p = planned();
    for (const a of keyframeAssets(p)) { a.status = 'pending-review'; a.file = { uri: `${a.id}.png`, mime: 'image/png' }; }
    const some = approve(p, keyframeAssets(p).slice(0, 3).map((a) => a.id), 'keyframes').project;
    assert.notEqual(some.stages.keyframes.state, 'approved');
    const all = approve(p, keyframeAssets(p).map((a) => a.id), 'keyframes').project;
    assert.equal(all.stages.keyframes.state, 'approved');
    assert.equal(refreshStageState(all), all, 'approved stays approved while every frame is approved with its file');
  });

  it('sent back: the new take fills the same asset, with the person\'s words and a Revised comment', async () => {
    const { r } = await produced();
    const oldUri = asset(r.host.peek(), U).file!.uri;
    r.host.set(fold(r.host.peek(), [decision('request-changes', U, 'keyframes', { text: 'Wider, and colder light.' })]).project);
    assert.equal(asset(r.host.peek(), U).status, 'needs-rework');

    const s = await generateKeyframes(deps(r), { provider: 'manual', units: [U] });
    assert.equal(s.status, 'handoff');
    if (s.status !== 'handoff') return;
    assert.match(s.job.items[0]!.prompt, /Changes the person asked for: Wider, and colder light\./);
    assert.match(s.job.id, /_r2$/, 'a regeneration is a new job');
    let p = r.host.peek();
    assert.equal(asset(p, U).status, 'draft');
    assert.equal(asset(p, U).file, undefined);
    assert.ok(asset(p, U).comments.some((c) => c.author === 'agent' && c.text.startsWith('Revised:') && c.text.includes(oldUri)));

    await ingestKeyframe(deps(r), r.manual, s.job, U, FILE);
    p = r.host.peek();
    assert.equal(asset(p, U).status, 'pending-review');
    assert.ok(asset(p, U).file);
    assert.equal(p.assets.filter((a) => a.id === U).length, 1);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('asking again before the file is back reuses the same job', async () => {
    const r = rig('manual', planned());
    const a = await generateKeyframes(deps(r), { provider: 'manual' });
    const b = await generateKeyframes(deps(r), { provider: 'manual' });
    assert.equal(a.job.id, b.job.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('review fixes carried forward: undo across a revision, refused re-runs, superseded references', () => {
  const U = kf('sc1_sh1');

  async function withFrame(approved: boolean) {
    const r = rig('manual', planned());
    const s = await generateKeyframes(deps(r), { provider: 'manual' });
    if (s.status !== 'handoff') throw new Error(s.status);
    await ingestKeyframe(deps(r), r.manual, s.job, U, FILE);
    if (approved) {
      r.host.set(approve(r.host.peek(), [U], 'keyframes').project);
      await finalizeKeyframes(deps(r));
    }
    return r;
  }

  async function undoAcrossRevision(r: Rig) {
    const req = decision('request-changes', U, 'keyframes', { text: 'Colder.' });
    r.host.set(fold(r.host.peek(), [req]).project);
    const s = await generateKeyframes(deps(r), { provider: 'manual', units: [U] });
    assert.equal(s.status, 'handoff');
    assert.equal(asset(r.host.peek(), U).file, undefined, 'the old take was cleared for the revision');
    const undone = fold(r.host.peek(), [decision('undo', U, 'keyframes', { undoes: req.id })]);
    assert.equal(undone.rejected.length, 0, JSON.stringify(undone.rejected));
    r.host.set(undone.project);
    return undone.project;
  }

  it('an undo that restores "approved" onto a file-less key frame is repaired to pending, and the stage leaves approved', async () => {
    const r = await withFrame(true);
    const restored = await undoAcrossRevision(r);
    assert.equal(asset(restored, U).status, 'approved');
    assert.equal(asset(restored, U).file, undefined);
    assert.notEqual(unitReadiness(restored, asset(restored, U)).state, 'approved', 'no file, so not approved');
    r.host.set({ ...restored, stages: { ...restored.stages, keyframes: { state: 'approved' } } });
    await finalizeKeyframes(deps(r));
    const p = r.host.peek();
    assert.equal(asset(p, U).status, 'pending');
    assert.ok(asset(p, U).comments.some((c) => c.author === 'agent' && c.text === 'Revised: restored without an image; needs generating'));
    assert.notEqual(p.stages.keyframes.state, 'approved');
    assert.equal(keyframeStatus(p).find((x) => x.asset === U)!.state, 'ready');
    assert.equal((await generateKeyframes(deps(r), { provider: 'manual', units: [U] })).status, 'handoff');
  });

  it('the same for a key frame that was only pending-review', async () => {
    const r = await withFrame(false);
    const restored = await undoAcrossRevision(r);
    assert.equal(asset(restored, U).status, 'pending-review');
    await finalizeKeyframes(deps(r));
    const a = asset(r.host.peek(), U);
    assert.equal(a.status, 'pending');
    assert.ok(a.comments.some((c) => c.text.includes('restored without an image')));
  });

  it('a run the gate does not accept leaves a sent-back key frame exactly as it was', async () => {
    const r = await withFrame(false);
    r.host.set(fold(r.host.peek(), [decision('request-changes', U, 'keyframes', { text: 'Colder.' })]).project);
    const before = asset(r.host.peek(), U);
    const refusing = { ...r.gate, run: async () => ({ status: 'refused' as const, refusal: { code: 'over-approved', message: 'the estimate rose above what you approved' } }) } as unknown as SpendGate;
    const s = await generateKeyframes({ host: r.guarded, gate: refusing, now }, { provider: 'manual', units: [U] });
    assert.equal(s.status, 'refused');
    const after = asset(r.host.peek(), U);
    assert.equal(after.status, 'needs-rework');
    assert.deepEqual(after.file, before.file);
    assert.equal(after.comments.filter((c) => c.text.startsWith('Revised:')).length, 0);
    assert.equal(r.host.peek().stages.keyframes.state, 'in-progress');
  });

  it('a first run the gate does not accept puts a pending key frame back to pending', async () => {
    const r = rig('manual', planned());
    const refusing = { ...r.gate, run: async () => ({ status: 'refused' as const, refusal: { code: 'x', message: 'no' } }) } as unknown as SpendGate;
    const s = await generateKeyframes({ host: r.guarded, gate: refusing, now }, { provider: 'manual' });
    assert.equal(s.status, 'refused');
    assert.equal(asset(r.host.peek(), U).status, 'pending');
  });

  async function frameOnApprovedRefs() {
    const r = rig('manual', planned());
    const s = await generateKeyframes(deps(r), { provider: 'manual' });
    if (s.status !== 'handoff') throw new Error(s.status);
    await ingestKeyframe(deps(r), r.manual, s.job, U, FILE);
    return r;
  }

  it('a key frame made against approved references is not flagged, and carries from: stamps', async () => {
    const r = await frameOnApprovedRefs();
    const p = r.host.peek();
    assert.ok(asset(p, U).tags.some((t) => /^from:char_mara_turnaround@[0-9a-f]{8}$/.test(t)));
    assert.deepEqual(keyframeStatus(p).find((x) => x.asset === U)!.superseded, []);
  });

  it('sending the turnaround back flags the key frame and changes nothing on it', async () => {
    const r = await frameOnApprovedRefs();
    const before = asset(r.host.peek(), U);
    r.host.set(fold(r.host.peek(), [decision('request-changes', 'char_mara_turnaround', 'bible', { text: 'Older.' })]).project);
    await finalizeKeyframes(deps(r));
    const p = r.host.peek();
    assert.deepEqual(keyframeStatus(p).find((x) => x.asset === U)!.superseded, ['char_mara_turnaround']);
    assert.deepEqual(asset(p, U), before, 'no code-side change to the dependent');
    // the frame can no longer be built against it either: its key frames wait for the turnaround
    assert.equal(unitReadiness(p, asset(p, kf('sc1_sh4'))).state, 'blocked');
  });

  it('replacing the lookbook file flags every key frame made from it', async () => {
    const r = await frameOnApprovedRefs();
    const p = r.host.peek();
    asset(p, 'style_fog-and-lamplight_lookbook').file = { uri: 'bible/style/other-take.png', mime: 'image/png' };
    assert.deepEqual(keyframeStatus(p).find((x) => x.asset === U)!.superseded, ['style_fog-and-lamplight_lookbook']);
  });

  it('the stamps agree with the bible stage\'s own superseded check', async () => {
    const { supersededRefs } = await import('../bible/plan.ts');
    const r = await frameOnApprovedRefs();
    const p = r.host.peek();
    assert.deepEqual(supersededRefs(p, asset(p, U)), []);
    asset(p, 'loc_river-pier_plate').file = { uri: 'elsewhere.png', mime: 'image/png' };
    assert.deepEqual(supersededRefs(p, asset(p, U)), ['loc_river-pier_plate']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('an approval binds to the provider and the model', () => {
  const paidProject = () => planned({ budget: { cap: 20, currency: 'USD' } });
  const U = kf('sc1_sh1');

  it('the job id changes with the provider or the model, and not otherwise', () => {
    const p = paidProject();
    const id = (provider: string, model?: string) => buildKeyframeJob(p, { provider, ...(model ? { model } : {}), units: [U] }).job.id;
    assert.equal(id('gemini-image', 'gemini-3.1-flash-image'), id('gemini-image', 'gemini-3.1-flash-image'), 'same provider and model: same id');
    assert.notEqual(id('gemini-image', 'gemini-3.1-flash-image'), id('gemini-image', 'gemini-nano-banana-2.1'));
    assert.notEqual(id('gemini-image'), id('gemini-image', 'gemini-3.1-flash-image'));
    assert.notEqual(id('gemini-image'), id('fal'));
    assert.match(id('fal'), /^job_kf_[0-9a-f]{8}_r1$/);
  });

  it('an approval for one model does not run the same frame on a cheaper model; asking for it needs a fresh approval', async () => {
    const r = rig('gemini-image', paidProject());
    const pricey = { provider: 'gemini-image', model: 'gemini-3.1-flash-image', units: [U] };
    const first = await generateKeyframes(deps(r), pricey);
    assert.equal(first.status, 'awaiting-approval');
    r.host.set(approveSpend(r.host.peek(), first.job.id, 'keyframes').project);

    // same units, a cheaper model of the same provider: not covered by that approval
    const cheaper = await generateKeyframes(deps(r), { provider: 'gemini-image', model: 'gemini-nano-banana-2.1', units: [U] });
    assert.equal(cheaper.status, 'awaiting-approval');
    assert.notEqual(cheaper.job.id, first.job.id);
    assert.equal(r.net!.calls.length, 0, 'nothing was sent');
    assert.equal(r.host.peek().pending_spend.length, 2, 'a second pending entry, awaiting its own approval');

    // the original model still runs on its own approval
    const ran = await generateKeyframes(deps(r), pricey);
    assert.equal(ran.status, 'done');
    assert.equal(ran.job.id, first.job.id);
  });

  it('the gate also refuses a different provider under an approved job id', async () => {
    const r = rig('gemini-image', paidProject());
    const first = await generateKeyframes(deps(r), { provider: 'gemini-image', units: [U] });
    r.host.set(approveSpend(r.host.peek(), first.job.id, 'keyframes').project);
    const swapped = { ...first.job, provider: 'fal' };
    const out = await r.gate.run(swapped);
    assert.notEqual(out.status, 'submitted');
    assert.equal(r.net!.calls.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('a frame that cannot be built is skipped and reported', () => {
  /** sc1_sh1 gets 15 supplied references, so it can never be built. */
  function withBadFirstFrame(): AkukoProject {
    const p = planned();
    for (let i = 0; i < 15; i++) {
      p.assets.push({ id: `pic${i}`, stage: 'keyframes', status: 'approved', comments: [], kind: 'reference', owner: 'sc1_sh1', tags: [], file: { uri: `pic${i}.png`, mime: 'image/png' } });
    }
    return p;
  }

  it('the default step moves on to the next ready frame and says what it skipped', () => {
    const b = buildKeyframeJob(withBadFirstFrame(), { provider: 'manual' });
    assert.deepEqual(b.units, [kf('sc1_sh2')]);
    assert.equal(b.skipped.length, 1);
    assert.equal(b.skipped[0]!.unit, kf('sc1_sh1'));
    assert.match(b.skipped[0]!.reason, /would send 18 reference images/);
  });

  it('keeps working every time (it does not throw forever on the first frame)', async () => {
    const r = rig('manual', withBadFirstFrame());
    const s = await generateKeyframes(deps(r), { provider: 'manual' });
    assert.equal(s.status, 'handoff');
    assert.equal(s.job.items[0]!.unit, kf('sc1_sh2'));
    assert.deepEqual(s.skipped?.map((x) => x.unit), [kf('sc1_sh1')]);
    assert.equal(asset(r.host.peek(), kf('sc1_sh1')).status, 'pending', 'the skipped frame was not started');
  });

  it('a scene batch builds the frames it can and reports the rest', async () => {
    const r = rig('manual', withBadFirstFrame());
    const s = await generateKeyframes(deps(r), { provider: 'manual', scene: 'sc1' });
    assert.deepEqual(s.job.items.map((i) => i.unit), ['sc1_sh2', 'sc1_sh3', 'sc1_sh4'].map(kf));
    assert.deepEqual(s.skipped?.map((x) => x.unit), [kf('sc1_sh1')]);
    assert.match(s.skipped![0]!.reason, /reference images/);
  });

  it('when nothing can be built it says why, per frame', () => {
    const p = withBadFirstFrame();
    for (const sh of ['sc1_sh2', 'sc1_sh3', 'sc1_sh4']) {
      for (let i = 0; i < 15; i++) p.assets.push({ id: `pic${sh}${i}`, stage: 'keyframes', status: 'approved', comments: [], kind: 'reference', owner: sh, tags: [], file: { uri: `p${i}.png`, mime: 'image/png' } });
    }
    assert.throws(() => buildKeyframeJob(p, { provider: 'manual', scene: 'sc1' }), (e: Error) => /No ready key frame could be built: sc1_sh1_keyframe: .*reference images/.test(e.message) && e.message.includes('sc1_sh4_keyframe'));
  });

  it('a frame the person names is still an error, not a skip', () => {
    assert.throws(() => buildKeyframeJob(withBadFirstFrame(), { provider: 'manual', units: [kf('sc1_sh1')] }), /would send 18 reference images/);
  });
});

describe('the bible stage is untouched by this one', () => {
  it('generating key frames never changes a bible image or an entry', async () => {
    const start = planned();
    const r = rig('manual', start);
    await stepOnce(r);
    const after = r.host.peek();
    assert.deepEqual(bibleAssets(after), bibleAssets(start));
    assert.deepEqual(after.bible, start.bible);
    assert.deepEqual(after.shots, start.shots);
    assert.deepEqual(planBible(bibleApproved(), NOW).created, [], 'the bible is fully planned already');
  });
});
