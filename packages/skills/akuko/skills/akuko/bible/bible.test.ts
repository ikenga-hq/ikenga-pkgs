// WP-05 — the bible stage: characters (portrait → labelled turnaround), location plates, lookbook.
//
// The whole stage runs on WP-04's test story with the manual provider and with
// the Gemini and fal providers on a mocked network. Nothing here makes a live
// call. "Approved" is only ever the result of folding a decision a person
// wrote through a conformed view (`test-board@1`); `guardedHost` fails any
// write that would newly set it from code.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkIntegrity } from '../schema/integrity.ts';
import { listUnits, type AkukoProject } from '../schema/akuko-project.ts';
import { loadProviderConfig } from '../providers/config.ts';
import type { Job, Provider, WaveOneHost } from '../providers/contract.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createGeminiImageProvider } from '../providers/gemini-image/index.ts';
import { createFalImageProvider } from '../providers/fal/index.ts';
import { PNG_BYTES, mockFal, mockGemini, type MockNet } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { createFakeHost, type FakeHost } from '../providers/__fixtures__/fake-host.ts';
import { SETUP_POINTER, SpendGateBypassError, createSpendGate, type SpendGate } from '../spend/gate.ts';
import { BIBLE_ROLES, PLACEHOLDERS, PromptError, renderPrompt, templateFor } from './prompts.ts';
import {
  BibleError,
  MAX_REFS,
  bibleAssets,
  bibleStatus,
  buildBibleJob,
  planBible,
  refreshStageState,
  syncRefs,
} from './plan.ts';
import { finalizeBible, generateBible, ingestBible, type StepResult } from './run.ts';
import { approve, approveSpend, breakdownApproved, decision, fold } from './__fixtures__/project.ts';

const NOW = '2026-11-08T10:00:00Z';
const now = (): string => NOW;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const ids = (p: AkukoProject): string[] => bibleAssets(p).map((a) => a.id);
const asset = (p: AkukoProject, id: string) => p.assets.find((a) => a.id === id)!;
const entry = (p: AkukoProject, id: string) => [...p.bible.characters, ...p.bible.locations, ...p.bible.styles].find((e) => e.id === id)!;
const approvedSet = (p: AkukoProject): Set<string> => new Set(listUnits(p).filter((u) => u.unit.status === 'approved').map((u) => u.unit.id));

/** A host that fails any code-side write that newly marks a unit approved (R: no action writes `approved`). */
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

// ─────────────────────────────────────────────────────────────────────────
describe('templates and prompts', () => {
  it('every role has a prompt block that uses only known placeholders', () => {
    for (const role of BIBLE_ROLES) {
      const t = templateFor(role);
      const used = [...t.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
      assert.ok(used.length > 0, role);
      for (const u of used) assert.ok((PLACEHOLDERS as readonly string[]).includes(u as string), `${role}: {{${u}}}`);
    }
  });

  it('fills the placeholders and says "(none given)" for an empty one', () => {
    const out = renderPrompt(templateFor('portrait'), { name: 'Mara', role: 'Principal', description: '', notes: '', look: 'fog' });
    assert.match(out, /Mara \(Principal\)/);
    assert.match(out, /\(none given\)/);
    assert.doesNotMatch(out, /\{\{/);
  });

  it('refuses a template with an unknown placeholder', () => {
    assert.throws(() => renderPrompt('hello {{wardrobe}}', { name: '', role: '', description: '', notes: '', look: '' }), PromptError);
  });

  it('the turnaround asks for a labelled five-view sheet from the approved portrait', () => {
    const t = templateFor('turnaround');
    assert.match(t, /first attached reference image \(the approved portrait\)/);
    for (const label of ['FRONT', 'THREE-QUARTER FRONT', 'SIDE', 'THREE-QUARTER BACK', 'BACK']) assert.ok(t.includes(label), label);
  });

  it('templates are brand-neutral', () => {
    const dir = join(ROOT, 'profiles/film/templates');
    for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /royalti|dixtrit|ikenga/i, f);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('planning: what the stage makes, and when it opens', () => {
  it('refuses to plan while breakdown is not approved', () => {
    const p = breakdownApproved();
    const locked = { ...p, stages: { ...p.stages, breakdown: { state: 'in-review' as const } } };
    assert.throws(() => planBible(locked, NOW), /locked: breakdown is "in-review"/);
  });

  it('refuses to plan while the sketch stage is not approved (the gating rule)', () => {
    const p = breakdownApproved();
    const locked = { ...p, stages: { ...p.stages, sketch: { state: 'in-review' as const } } };
    assert.throws(() => planBible(locked, NOW), /locked: sketch is "in-review"/);
  });

  it('refuses to plan while a checklist entry is not approved', () => {
    const p = breakdownApproved();
    const open = structuredClone(p);
    open.bible.characters[0]!.status = 'pending-review';
    assert.throws(() => planBible(open, NOW), (e: Error) => e instanceof BibleError && /not approved yet: char_mara/.test(e.message));
  });

  it('plans portrait + turnaround for principals, a portrait for supporting, a plate per location, one lookbook', () => {
    const p = breakdownApproved();
    const r = planBible(p, NOW);
    assert.deepEqual(r.created.sort(), [
      'char_mara_portrait', 'char_mara_turnaround', 'char_oren_portrait', 'char_oren_turnaround', 'char_the-woman_portrait',
      'loc_far-pier_plate', 'loc_river-pier_plate', 'loc_the-ferry_plate', 'style_fog-and-lamplight_lookbook',
    ]);
    assert.equal(r.project.stages.bible.state, 'in-progress');
    for (const a of bibleAssets(r.project)) {
      assert.equal(a.stage, 'bible');
      assert.equal(a.status, 'pending');
      assert.equal(a.file, undefined);
      assert.ok(entry(r.project, a.owner!), `owner ${a.owner}`);
    }
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('leaves the checklist entries approved at breakdown: no entry is moved backwards', () => {
    const p = breakdownApproved();
    const r = planBible(p, NOW).project;
    for (const e of [...r.bible.characters, ...r.bible.locations, ...r.bible.styles]) {
      assert.equal(e.status, 'approved');
      assert.equal(e.stage, 'breakdown');
    }
  });

  it('is idempotent', () => {
    const once = planBible(breakdownApproved(), NOW).project;
    const twice = planBible(once, NOW);
    assert.deepEqual(twice.created, []);
    assert.deepEqual(twice.project, once);
  });

  it('a background character gets no images', () => {
    const p = breakdownApproved();
    p.bible.characters[2]!.role = 'Background';
    const r = planBible(p, NOW);
    assert.ok(!r.created.some((i) => i.startsWith('char_the-woman')));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('order: lookbook, then portraits and plates, then turnarounds', () => {
  it('only the lookbook is ready at first; the rest wait for a person to approve what they need', () => {
    const p = planBible(breakdownApproved(), NOW).project;
    const rows = bibleStatus(p);
    assert.deepEqual(rows.filter((r) => r.state === 'ready').map((r) => r.asset), ['style_fog-and-lamplight_lookbook']);
    const turnaround = rows.find((r) => r.asset === 'char_mara_turnaround')!;
    assert.equal(turnaround.state, 'blocked');
    assert.deepEqual(turnaround.waiting.sort(), ['char_mara_portrait', 'style_fog-and-lamplight_lookbook']);
  });

  it('will not build a job for a unit whose references are not approved', () => {
    const p = planBible(breakdownApproved(), NOW).project;
    assert.throws(() => buildBibleJob(p, { provider: 'manual', units: ['char_mara_turnaround'] }), /cannot be generated now \(blocked; waiting for a person to approve/);
  });

  it('a unit that has a file but is only pending-review does not count as approved', () => {
    const p = planBible(breakdownApproved(), NOW).project;
    const a = asset(p, 'style_fog-and-lamplight_lookbook');
    a.status = 'pending-review';
    a.file = { uri: 'x.png', mime: 'image/png' };
    assert.throws(() => buildBibleJob(p, { provider: 'manual' }), /Nothing can be generated yet/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The full flow, once per provider
// ─────────────────────────────────────────────────────────────────────────

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

/** Everything the person does between two steps: bring files back (manual) and approve what is waiting. */
async function personReviews(r: Rig, step: StepResult, log: string[]): Promise<void> {
  if (step.status === 'handoff') {
    for (const unit of step.handle.units) await ingestBible(deps(r), r.manual, step.job, unit, FILE);
  }
  const p = r.host.peek();
  const waiting = bibleAssets(p).filter((a) => a.status === 'pending-review').map((a) => a.id);
  assert.ok(waiting.length > 0, 'something is waiting for review');
  log.push(`review:${waiting.join(',')}`);
  r.host.set(approve(p, waiting, 'bible').project);
  await finalizeBible(deps(r));
}

/** Drive the stage to the end: step, approve spend if asked, bring files, approve units. Returns the steps taken. */
async function runStage(r: Rig): Promise<{ steps: StepResult[]; log: string[] }> {
  const steps: StepResult[] = [];
  const log: string[] = [];
  let seen = 0; // requests made so far
  for (let i = 0; i < 12 && r.host.peek().stages.bible.state !== 'approved'; i++) {
    let step = await generateBible(deps(r), { provider: r.providerId });
    if (step.status === 'awaiting-approval') {
      assert.ok(r.paid, 'a free job is never held for approval');
      assert.equal(r.net?.calls.length ?? 0, seen, 'no request before the person approves the spend');
      assert.equal(r.host.peek().stages.bible.state, 'waiting-spend');
      log.push(`awaiting:${step.job.id}`);
      r.host.set(approveSpend(r.host.peek(), step.job.id).project);
      step = await generateBible(deps(r), { provider: r.providerId });
    }
    steps.push(step);
    seen = r.net?.calls.length ?? 0;
    assert.ok(step.status === 'handoff' || step.status === 'done', `step ended ${step.status}`);
    await personReviews(r, step, log);
  }
  return { steps, log };
}

for (const kind of ['manual', 'gemini-image', 'fal'] as const) {
  describe(`full flow with the ${kind} provider`, () => {
    const paid = kind !== 'manual';
    const project = breakdownApproved(paid ? { budget: { cap: 20, currency: 'USD' } } : {});

    it('portrait → turnaround, plates and lookbook, each through quote → approval → gate → pending-review → approval', async () => {
      const start = planBible(project, NOW).project;
      const r = rig(kind, start);
      r.host.set(start);
      const { steps, log } = await runStage(r);
      const p = r.host.peek();

      // three waves, in dependency order
      assert.equal(steps.length, 3);
      assert.deepEqual(steps.map((s) => s.job.items.map((i) => i.unit).sort()), [
        ['style_fog-and-lamplight_lookbook'],
        ['char_mara_portrait', 'char_oren_portrait', 'char_the-woman_portrait', 'loc_far-pier_plate', 'loc_river-pier_plate', 'loc_the-ferry_plate'],
        ['char_mara_turnaround', 'char_oren_turnaround'],
      ]);

      // every principal has an approved turnaround, every location a plate, the lookbook is approved
      for (const id of ['char_mara_turnaround', 'char_oren_turnaround', 'loc_river-pier_plate', 'loc_the-ferry_plate', 'loc_far-pier_plate', 'style_fog-and-lamplight_lookbook']) {
        assert.equal(asset(p, id).status, 'approved', id);
        assert.ok(asset(p, id).file, `${id} has a file`);
      }
      assert.equal(p.stages.bible.state, 'approved');
      assert.equal(p.stages.keyframes.state === 'locked', false, 'keyframes unlocked by folding');
      assert.deepEqual(checkIntegrity(p), []);

      // refs[] is what the later stages reuse
      assert.deepEqual(entry(p, 'char_mara').refs, ['char_mara_portrait', 'char_mara_turnaround']);
      assert.deepEqual(entry(p, 'char_oren').refs, ['char_oren_portrait', 'char_oren_turnaround']);
      assert.deepEqual(entry(p, 'char_the-woman').refs, ['char_the-woman_portrait']);
      assert.deepEqual(entry(p, 'loc_the-ferry').refs, ['loc_the-ferry_plate']);
      assert.deepEqual(entry(p, 'style_fog-and-lamplight').refs, ['style_fog-and-lamplight_lookbook']);

      // the entries themselves never left "approved at breakdown"
      assert.ok(p.bible.characters.every((e) => e.status === 'approved' && e.stage === 'breakdown'));

      // the turnaround job attaches the approved portrait first, then the approved lookbook
      const t = steps[2]!.job.items.find((i) => i.unit === 'char_mara_turnaround')!;
      assert.deepEqual(t.refs?.map((x) => [x.id, x.role]), [['char_mara_portrait', 'character'], ['style_fog-and-lamplight_lookbook', 'style']]);
      assert.ok(t.refs!.every((x) => x.uri && x.uri.length > 0));
      assert.match(t.prompt, /THREE-QUARTER BACK/);
      assert.equal(t.output, 'turnaround');
      // portraits and plates attach the lookbook; the lookbook attaches nothing
      assert.deepEqual(steps[0]!.job.items[0]!.refs ?? [], []);
      assert.deepEqual(steps[1]!.job.items.find((i) => i.unit === 'char_oren_portrait')!.refs?.map((x) => x.id), ['style_fog-and-lamplight_lookbook']);

      // the review gate: every wave waited for a person
      assert.equal(log.filter((l) => l.startsWith('review:')).length, 3);

      if (!paid) {
        assert.equal(p.budget, null, 'free work needs no budget');
        assert.equal(p.ledger.length, 0);
        assert.equal(p.pending_spend.length, 0);
        assert.ok(steps.every((s) => s.status === 'handoff'));
      } else {
        // every generation went through the gate: 3 approved jobs, a ledger entry per image, nothing outside
        assert.equal(p.pending_spend.filter((j) => j.stage === 'bible' && j.status === 'approved').length, 3);
        assert.equal(p.ledger.filter((e) => e.status === 'done').length, 9);
        const entryCfg = loadProviderConfig().providers[kind]!;
        const price = entryCfg.models[entryCfg.default_model]!.price.amount;
        assert.ok(Math.abs((p.budget?.spent ?? 0) - 9 * price) < 1e-6, `spent ${p.budget?.spent}`);
        assert.equal(r.net!.calls.filter((c) => c.method === 'POST').length, 9);
        assert.ok(steps.every((s) => s.status === 'done'));
        assert.ok(log.filter((l) => l.startsWith('awaiting:')).length === 3);
      }
    });

    if (paid) {
      it('sends the portrait and lookbook as references for the turnaround request', async () => {
        const start = planBible(project, NOW).project;
        const r = rig(kind, start);
        await runStage(r);
        const posts = r.net!.calls.filter((c) => c.method === 'POST');
        const turnaroundCall = posts.at(-1)!.body as Record<string, unknown>;
        const text = JSON.stringify(turnaroundCall);
        assert.match(text, /Reference image 1 \(character\)/);
        assert.match(text, /Reference image 2 \(style\)/);
        assert.match(text, /THREE-QUARTER FRONT/);
        // the lookbook request carried no references at all
        assert.doesNotMatch(JSON.stringify(posts[0]!.body), /Reference image/);
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
describe('the spend gate is the only way in', () => {
  const paidProject = () => planBible(breakdownApproved({ budget: { cap: 20, currency: 'USD' } }), NOW).project;

  it('nothing in bible/ can reach a provider except through gate.run()', () => {
    const strip = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const f = join(dir, n);
        return statSync(f).isDirectory() ? walk(f) : n.endsWith('.ts') && !n.endsWith('.test.ts') ? [f] : [];
      });
    const files = walk(join(ROOT, 'bible'));
    assert.ok(files.length >= 4);
    for (const f of files) {
      const hits = strip(readFileSync(f, 'utf8')).split('\n').filter((l) => /\bsubmit\b/.test(l));
      assert.deepEqual(hits, [], f);
    }
  });

  it('a paid generation with no budget is refused with the setup pointer and sends nothing', async () => {
    const start = planBible(breakdownApproved(), NOW).project;
    const r = rig('gemini-image', start);
    const s = await generateBible(deps(r), { provider: 'gemini-image' });
    assert.equal(s.status, 'refused');
    if (s.status === 'refused') assert.equal(s.message, SETUP_POINTER);
    assert.equal(r.net!.calls.length, 0);
  });

  it('nothing is sent while the spend is awaiting approval, or after the person declines it', async () => {
    const r = rig('fal', paidProject());
    const first = await generateBible(deps(r), { provider: 'fal' });
    assert.equal(first.status, 'awaiting-approval');
    if (first.status === 'awaiting-approval') assert.match(first.confirmation, /Reply "approve \d+\.\d\d USD"/);
    const again = await generateBible(deps(r), { provider: 'fal' });
    assert.equal(again.status, 'awaiting-approval');
    assert.equal(r.host.peek().pending_spend.length, 1, 'asking twice makes one pending entry');
    const jobId = first.job.id;
    r.host.set(fold(r.host.peek(), [decision('decline-spend', jobId, 'bible')]).project);
    const after = await generateBible(deps(r), { provider: 'fal' });
    assert.equal(after.status, 'refused');
    assert.equal(r.net!.calls.length, 0);
    // declining left the unit untouched: nothing was started
    assert.equal(asset(r.host.peek(), 'style_fog-and-lamplight_lookbook').status, 'pending');
  });

  it('a spend approval from a view that is not conformed does not release the job', async () => {
    const r = rig('gemini-image', paidProject());
    const first = await generateBible(deps(r), { provider: 'gemini-image' });
    assert.equal(first.status, 'awaiting-approval');
    const p = r.host.peek();
    const bad = decision('approve-spend', first.job.id, 'bible', { text: `approve ${p.pending_spend[0]!.estimate.toFixed(2)} USD`, view: 'unchecked-page@1' });
    const f = fold(p, [bad]);
    assert.equal(f.rejected.length, 1);
    r.host.set(f.project);
    assert.equal((await generateBible(deps(r), { provider: 'gemini-image' })).status, 'awaiting-approval');
    assert.equal(r.net!.calls.length, 0);
  });

  it('host A refuses a paid direct API (R-11) and sends nothing', async () => {
    const r = rig('gemini-image', paidProject(), 'A');
    const s = await generateBible(deps(r), { provider: 'gemini-image' });
    assert.equal(s.status, 'refused');
    assert.equal(r.net!.calls.length, 0);
  });

  it('host A can still run the bible with the manual provider (free)', async () => {
    const r = rig('manual', planBible(breakdownApproved(), NOW).project, 'A');
    const s = await generateBible(deps(r), { provider: 'manual' });
    assert.equal(s.status, 'handoff');
    if (s.status === 'handoff') {
      assert.match(s.text, /style_fog-and-lamplight_lookbook/);
      assert.match(s.text, /Lookbook key frame for a film/);
    }
  });

  it('calling a sealed provider directly throws, whatever the bible code does', async () => {
    const r = rig('gemini-image', paidProject());
    const direct = createGeminiImageProvider(r.guarded, { apiKey: 'k', fetch: r.net!.fetch });
    const { job } = buildBibleJob(r.host.peek(), { provider: 'gemini-image' });
    await assert.rejects(direct.submit(job), SpendGateBypassError);
    assert.equal(r.net!.calls.length, 0);
  });

  it('refuses a unit with more than 14 reference images, naming the unit', () => {
    const p = planBible(breakdownApproved(), NOW).project;
    for (let i = 0; i < MAX_REFS + 1; i++) {
      p.assets.push({ id: `ref${i}`, stage: 'bible', status: 'approved', comments: [], kind: 'reference', owner: 'char_mara', tags: [], file: { uri: `r${i}.png`, mime: 'image/png' } });
    }
    const a = asset(p, 'style_fog-and-lamplight_lookbook');
    a.status = 'approved';
    a.file = { uri: 'look.png', mime: 'image/png' };
    assert.throws(() => buildBibleJob(p, { provider: 'manual', units: ['char_mara_portrait'] }), /char_mara_portrait would send 16 reference images/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('review and revision', () => {
  /** The manual flow up to a produced, unapproved lookbook. */
  async function lookbookProduced() {
    const r = rig('manual', planBible(breakdownApproved(), NOW).project);
    const s = await generateBible(deps(r), { provider: 'manual' });
    assert.equal(s.status, 'handoff');
    if (s.status !== 'handoff') throw new Error('unreachable');
    await ingestBible(deps(r), r.manual, s.job, 'style_fog-and-lamplight_lookbook', FILE);
    return { r, s };
  }

  it('a produced image waits as pending-review, not in refs, and the stage is in-review', async () => {
    const { r } = await lookbookProduced();
    const p = r.host.peek();
    assert.equal(asset(p, 'style_fog-and-lamplight_lookbook').status, 'pending-review');
    assert.deepEqual(entry(p, 'style_fog-and-lamplight').refs, []);
    assert.equal(asset(p, 'char_mara_portrait').status, 'pending');
    // later waves are still waiting for the person
    assert.equal(bibleStatus(p).find((x) => x.asset === 'char_mara_portrait')!.state, 'blocked');
  });

  it('approval comes only from folding the person\'s decision, then refs follow', async () => {
    const { r } = await lookbookProduced();
    // an agent-authored approval does not count
    const forged = decision('approve', 'style_fog-and-lamplight_lookbook', 'bible', { by: 'agent' });
    const f = fold(r.host.peek(), [forged]);
    assert.equal(f.rejected.length, 1);
    assert.equal(asset(f.project, 'style_fog-and-lamplight_lookbook').status, 'pending-review');
    // the person's does
    r.host.set(approve(r.host.peek(), ['style_fog-and-lamplight_lookbook'], 'bible').project);
    assert.equal(asset(r.host.peek(), 'style_fog-and-lamplight_lookbook').status, 'approved');
    assert.deepEqual(await finalizeBible(deps(r)), ['style_fog-and-lamplight']);
    assert.deepEqual(entry(r.host.peek(), 'style_fog-and-lamplight').refs, ['style_fog-and-lamplight_lookbook']);
  });

  it('un-approving an image takes it out of refs again', async () => {
    const { r } = await lookbookProduced();
    r.host.set(approve(r.host.peek(), ['style_fog-and-lamplight_lookbook'], 'bible').project);
    await finalizeBible(deps(r));
    const sent = fold(r.host.peek(), [decision('request-changes', 'style_fog-and-lamplight_lookbook', 'bible', { text: 'Colder, please.' })]);
    r.host.set(sent.project);
    await finalizeBible(deps(r));
    assert.deepEqual(entry(r.host.peek(), 'style_fog-and-lamplight').refs, []);
  });

  it('sent back: the new take fills the same asset, with the person\'s words in the prompt and a Revised comment', async () => {
    const { r } = await lookbookProduced();
    const id = 'style_fog-and-lamplight_lookbook';
    const oldUri = asset(r.host.peek(), id).file!.uri;
    r.host.set(fold(r.host.peek(), [decision('request-changes', id, 'bible', { text: 'Colder, and less fog.' })]).project);
    assert.equal(asset(r.host.peek(), id).status, 'needs-rework');

    const s = await generateBible(deps(r), { provider: 'manual', units: [id] });
    assert.equal(s.status, 'handoff');
    if (s.status !== 'handoff') return;
    assert.match(s.job.items[0]!.prompt, /Changes the person asked for: Colder, and less fog\./);
    assert.match(s.job.id, /_r2$/, 'a regeneration is a new job');
    let p = r.host.peek();
    assert.equal(asset(p, id).status, 'draft');
    assert.equal(asset(p, id).file, undefined);
    assert.ok(asset(p, id).comments.some((c) => c.author === 'agent' && c.text.startsWith('Revised:') && c.text.includes(oldUri)));
    assert.equal(p.stages.bible.state, 'in-progress');

    await ingestBible(deps(r), r.manual, s.job, id, FILE);
    p = r.host.peek();
    assert.equal(asset(p, id).status, 'pending-review');
    assert.ok(asset(p, id).file);
    assert.equal(p.assets.filter((a) => a.id.startsWith('style_')).length, 1, 'filled in place: no second asset');
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('asking again before the files are back reuses the same job', async () => {
    const r = rig('manual', planBible(breakdownApproved(), NOW).project);
    const a = await generateBible(deps(r), { provider: 'manual' });
    const b = await generateBible(deps(r), { provider: 'manual' });
    assert.equal(a.job.id, b.job.id);
  });

  it('the stage is approved only when every image is approved', async () => {
    const r = rig('manual', planBible(breakdownApproved(), NOW).project);
    let p = r.host.peek();
    p = approve(p, ['style_fog-and-lamplight_lookbook'], 'bible').project; // nothing produced yet: refused
    assert.equal(asset(p, 'style_fog-and-lamplight_lookbook').status, 'pending');
    assert.notEqual(refreshStageState(p).stages.bible.state, 'approved');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('syncRefs and the stage state', () => {
  it('keeps refs that are not bible assets of the entry', () => {
    const p = planBible(breakdownApproved(), NOW).project;
    p.assets.push({ id: 'moodboard', stage: 'intake', status: 'approved', comments: [], kind: 'reference', tags: [] });
    entry(p, 'char_mara').refs = ['moodboard'];
    const a = asset(p, 'char_mara_portrait');
    a.status = 'approved';
    a.file = { uri: 'p.png', mime: 'image/png' };
    const r = syncRefs(p, NOW);
    assert.deepEqual(entry(r.project, 'char_mara').refs, ['char_mara_portrait', 'moodboard']);
    assert.deepEqual(r.changed, ['char_mara']);
    assert.deepEqual(syncRefs(r.project, NOW).changed, [], 'idempotent');
  });

  it('never touches a stage that is approved or locked', () => {
    const p = planBible(breakdownApproved(), NOW).project;
    p.stages.bible = { state: 'approved' };
    assert.equal(refreshStageState(p), p);
  });

  it('is waiting-spend while a bible job awaits approval', () => {
    const p = planBible(breakdownApproved(), NOW).project;
    p.pending_spend.push({ id: 'job_x', stage: 'bible', label: 'Bible', units: ['style_fog-and-lamplight_lookbook'], provider: 'gemini-image', estimate: 0.1, status: 'awaiting-approval' });
    assert.equal(refreshStageState(p).stages.bible.state, 'waiting-spend');
  });
});
