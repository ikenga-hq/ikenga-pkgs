// A shot's layout: a 3D-blockout render from the shot's camera that fixes where
// everything is in its key frame (actions/keyframes.md §Layout from a 3D blockout).
// Synthetic projects and bytes only; nothing makes a live call.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { AkukoProject } from '../schema/akuko-project.ts';
import { AkukoProjectSchema } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { PNG_BYTES } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { auditProject } from '../audit/audit.ts';
import { checkJob, checkProjectRules } from '../rules/check.ts';
import { externalRefs } from '../rules/allowance.ts';
import { sha256Bytes } from '../rules/refs.ts';
import { job, rulesFolder } from '../rules/__fixtures__/project.ts';
import { bibleApproved } from './__fixtures__/project.ts';
import { LAYOUT_ATTACH_NOTE, LAYOUT_NOTE, buildKeyframeJob, layoutGenerations, keyframeStatus, layoutRefId, layoutState, layoutStepPlan, neededRefs, planKeyframes, stampRefs, unitReadiness } from './plan.ts';
import { clearLayout, imageMime, setLayout } from './layout.ts';
import { run } from './cli.ts';
import { generateKeyframes } from './run.ts';
import { approveSpend } from './__fixtures__/project.ts';
import { createFakeHost } from '../providers/__fixtures__/fake-host.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createGeminiImageProvider } from '../providers/gemini-image/index.ts';
import { mockGemini } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { createSpendGate } from '../spend/gate.ts';

const NOW = '2026-11-16T10:00:00Z';
const SHOT = 'sc1_sh1';
const KF = `${SHOT}_keyframe`;
/** A PNG whose bytes differ by `mark` (only the signature is checked). */
const png = (mark: number): Uint8Array => new Uint8Array([...PNG_BYTES, mark]);
const asset = (p: AkukoProject, id: string) => p.assets.find((a) => a.id === id)!;
const planned = (): AkukoProject => planKeyframes(bibleApproved(), NOW).project;

async function folder(p: AkukoProject): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-layout-'));
  await writeFile(join(dir, 'akuko.json'), serializeProject(AkukoProjectSchema.parse(p)));
  return dir;
}

/** A take of the shot's key frame, made from the job just built (stamped like the run does). */
function madeTake(p: AkukoProject): AkukoProject {
  const built = buildKeyframeJob(p, { provider: 'manual', units: [KF] });
  const out = stampRefs(p, built.job);
  const a = asset(out, KF);
  a.status = 'approved';
  a.file = { uri: 'board/panels/sc1_sh1-take.png', mime: 'image/png' };
  return out;
}

describe('a shot layout: set from a file', () => {
  it('stores the render through the host, records uri and sha256, and is idempotent', async () => {
    const dir = await folder(planned());
    const host = createLocalHost({ projectDir: dir, now: () => new Date(NOW) });
    const r = await setLayout(host, SHOT, { filename: 'S02-010_doorway.png', data: png(1) }, { now: NOW, from: 'blockout/build_room.py' });
    assert.equal(r.changed, true);
    assert.equal(r.layout!.sha256, sha256Bytes(png(1)));
    assert.equal(r.layout!.uri, `refs/${SHOT}_layout.png`);
    assert.equal(r.layout!.from, 'blockout/build_room.py');
    assert.deepEqual(new Uint8Array(await readFile(join(dir, r.layout!.uri))), png(1));
    const saved = AkukoProjectSchema.parse(JSON.parse(await readFile(join(dir, 'akuko.json'), 'utf8')));
    assert.deepEqual(saved.shots.find((s) => s.id === SHOT)!.layout, r.layout);
    assert.ok(!saved.assets.some((a) => a.tags.includes('layout')), 'a layout is not an asset');
    assert.deepEqual(checkIntegrity(saved), []);
    // the same bytes again: nothing stored, nothing written
    const again = await setLayout(createLocalHost({ projectDir: dir }), SHOT, { filename: 'x.png', data: png(1) }, { now: NOW });
    assert.equal(again.changed, false);
    // a new render replaces it; the old file stays
    const next = await setLayout(createLocalHost({ projectDir: dir }), SHOT, { filename: 'x.png', data: png(2) }, { now: NOW });
    assert.equal(next.previous!.uri, r.layout!.uri);
    assert.notEqual(next.layout!.uri, r.layout!.uri);
    assert.ok(existsSync(join(dir, r.layout!.uri)));
    const cleared = await clearLayout(createLocalHost({ projectDir: dir }), SHOT);
    assert.equal(cleared.changed, true);
    assert.equal(cleared.project.shots.find((s) => s.id === SHOT)!.layout, undefined);
  });

  it('refuses a file that is not a PNG, JPEG or WebP by content, and an unknown or removed shot', async () => {
    const p = planned();
    p.shots[2]!.source = { kind: 'sheet', id: 'row-3', removed_at: NOW };
    const dir = await folder(p);
    const host = createLocalHost({ projectDir: dir });
    assert.equal(imageMime(new TextEncoder().encode('<svg/>')), undefined);
    await assert.rejects(setLayout(host, SHOT, { filename: 'plan.png', data: new TextEncoder().encode('<svg/>') }, { now: NOW }), /not a PNG, JPEG or WebP/);
    await assert.rejects(setLayout(host, 'nope', { filename: 'a.png', data: png(1) }, { now: NOW }), /not a shot id/);
    await assert.rejects(setLayout(host, p.shots[2]!.id, { filename: 'a.png', data: png(1) }, { now: NOW }), /left the shot list/);
  });

  it('the CLI command sets it and status shows it', async () => {
    const dir = await folder(planned());
    const file = join(dir, 'render.png');
    await writeFile(file, png(3));
    const r = await run(['layout', '--project', dir, '--shot', SHOT, '--file', file, '--from', 'blockout.py'], () => new Date(NOW));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /sc1_sh1's layout is refs\/sc1_sh1_layout\.png \(sha256 [0-9a-f]{12}…\)\. Its key frame uses it in mode attach: attached first with the other references, 1 generation/);
    const st = await run(['status', '--project', dir]);
    assert.match(st.out, /sc1_sh1_keyframe: pending \([a-z-]+; layout set; the next take is made from it; mode attach, 1 generation\)/);
    assert.match((await run(['layout', '--project', dir, '--shot', SHOT, '--mode', 'two-step'])).out, /now uses its layout in mode two-step by default/);
    assert.match((await run(['status', '--project', dir])).out, /mode two-step, 2 generations \(restyle, identity Mara\)/);
    assert.equal((await run(['layout', '--project', dir, '--shot', SHOT, '--mode', 'sideways'])).code, 2);
    assert.equal((await run(['layout', '--project', dir, '--shot', SHOT])).code, 2);
    assert.match((await run(['layout', '--project', dir, '--shot', SHOT, '--clear'])).out, /Removed sc1_sh1's layout/);
  });
});

const withLayout = (p: AkukoProject, mark = 1, shot = SHOT): AkukoProject => {
  p.shots.find((s) => s.id === shot)!.layout = { uri: `refs/${shot}_layout.png`, sha256: sha256Bytes(png(mark)), mime: 'image/png' };
  return p;
};
/** A layout the shot uses in mode two-step. */
const twoStep = (p: AkukoProject, mark = 1, shot = SHOT): AkukoProject => {
  withLayout(p, mark, shot).shots.find((s) => s.id === shot)!.layout!.mode = 'two-step';
  return p;
};
const now = (): string => NOW;
const BUDGET = { budget: { cap: 10, currency: 'USD' } };

/** A fake host, the manual provider and a mocked paid image provider behind one spend gate. */
function paidRig(p: AkukoProject, fail?: (n: number) => Response | undefined) {
  const host = createFakeHost(p);
  const net = mockGemini(fail ? { fail } : {});
  const manual = createManualProvider(host, { now });
  const gemini = createGeminiImageProvider(host, { fetch: net.fetch, apiKey: 'test-key', loadRef: async () => ({ mime: 'image/png', data: PNG_BYTES }), now });
  const gate = createSpendGate({ host, providers: [manual.provider, gemini], level: 'B', now });
  return { host, net, deps: { host, gate, now } };
}
const opts = { provider: 'gemini-image', units: [KF] };

describe('a key frame from its layout: the steps', () => {
  it('step 1 restyles the layout alone; then one identity step per character; no plate, lookbook or source frame', () => {
    const p = twoStep(planned());
    const shot = p.shots.find((s) => s.id === SHOT)!;
    assert.deepEqual(layoutStepPlan(p, shot).map((s) => s.name), ['restyle', 'identity Mara']);
    assert.deepEqual(neededRefs(p, shot).map((n) => n.kind), ['character'], 'a layout shot needs only its characters\' images');
    const built = buildKeyframeJob(p, opts);
    const c = built.chain!;
    assert.equal(c.total, 2);
    assert.equal(c.done, 0);
    assert.equal(built.job.id, `${c.base}_s1`);
    assert.equal(c.steps[1]!.job.id, c.base, 'the last step is the take\'s job');
    const s1 = built.job.items[0]!;
    assert.deepEqual(s1.refs, [{ id: layoutRefId(SHOT), uri: `refs/${SHOT}_layout.png`, role: 'layout', note: LAYOUT_NOTE }]);
    assert.match(s1.prompt, /^Restyle this plain 3D blockout render into the finished key frame/);
    assert.match(s1.prompt, /Keep the camera, the composition and the position and size of every wall, object and figure exactly as they are; change only materials, light and style; add nothing and move nothing\./);
    assert.match(s1.prompt, /The grey or blue box figures are: Mara - /);
    assert.match(s1.prompt, /The place: River Pier/);
    assert.match(s1.prompt, /Look \(from this text only\): Fog and Lamplight/);
    assert.doesNotMatch(s1.prompt, /attached (plate|lookbook|reference)/);
    const s2 = c.steps[1]!.job.items[0]!;
    assert.deepEqual(s2.refs!.map((r) => r.id), ['char_mara_turnaround'], 'priced before step 1 exists: the turnaround only');
    assert.match(s2.prompt, /Keep everything in it exactly.*Change only the figure that is Mara so they are the character on the attached sheet.*use the sheet for identity only, not its layout, background, labels or multiple views\. Mara appears once\./s);
    // two characters: three generations
    const two = twoStep(planned(), 1, 'sc1_sh4');
    assert.deepEqual(layoutStepPlan(two, two.shots.find((s) => s.id === 'sc1_sh4')!).map((s) => s.name), ['restyle', 'identity Mara', 'identity Oren']);
    // the shot no longer waits for its plate or lookbook
    const noPlate = twoStep(planned());
    for (const a of noPlate.assets) if (a.id === 'loc_river-pier_plate') a.status = 'needs-rework';
    assert.equal(unitReadiness(noPlate, asset(noPlate, KF)).state, 'ready');
    // without a layout nothing changes
    const plain = buildKeyframeJob(planned(), opts);
    assert.equal(plain.chain, undefined);
    assert.ok(!plain.job.items[0]!.refs!.some((r) => r.role === 'layout'));
    assert.match(plain.job.items[0]!.prompt, /^Composition, from the approved sketch board/m);
  });

  it('runs on its own: never batched with other shots', () => {
    const p = twoStep(planned(), 1, 'sc1_sh2');
    const scene = buildKeyframeJob(p, { provider: 'gemini-image', scene: 'sc1' });
    assert.ok(!scene.job.items.some((i) => i.unit === 'sc1_sh2_keyframe'));
    assert.ok(scene.skipped.some((x) => x.unit === 'sc1_sh2_keyframe' && /runs as a job of its own/.test(x.reason)));
    assert.throws(() => buildKeyframeJob(p, { provider: 'gemini-image', units: [KF, 'sc1_sh2_keyframe'] }), /made from a layout in steps, one job each/);
  });

  it('a paid provider: every generation is priced and approved first, then they run in order; step 1 is kept on the take', async () => {
    const r = paidRig(twoStep(planKeyframes(bibleApproved(BUDGET), NOW).project));
    const first = await generateKeyframes(r.deps, opts);
    assert.equal(first.status, 'awaiting-approval');
    assert.equal(first.generations, 2);
    const pend = r.host.peek().pending_spend.filter((j) => j.units.includes(KF));
    assert.equal(pend.length, 2, 'one pending spend per generation');
    if (first.status !== 'awaiting-approval') return;
    assert.equal(first.estimate, pend[0]!.estimate + pend[1]!.estimate);
    assert.match(first.confirmation, /^Spend check — sc1_sh1_keyframe from its layout: 2 generations in all \(restyle, identity Mara\); 2 to run with gemini-image/);
    assert.match(first.confirmation, /step 1 restyle \(job_kf_\w+_r1_s1\): reply "approve [\d.]+ USD"; step 2 identity Mara \(job_kf_\w+_r1\): reply "approve [\d.]+ USD"/);
    assert.equal(r.net.calls.length, 0, 'nothing is sent before every step is approved');
    r.host.set(approveSpend(r.host.peek(), pend[0]!.id, 'keyframes').project);
    const half = await generateKeyframes(r.deps, opts);
    assert.equal(half.status, 'awaiting-approval');
    if (half.status === 'awaiting-approval') assert.match(half.confirmation, /step 1 restyle \([^)]+\): approved; step 2/);
    assert.equal(r.net.calls.length, 0);
    r.host.set(approveSpend(r.host.peek(), pend[1]!.id, 'keyframes').project);
    const done = await generateKeyframes(r.deps, opts);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(r.net.calls.length, 2);
    assert.deepEqual(done.steps!.map((s) => s.name), ['restyle', 'identity Mara']);
    const p = r.host.peek();
    const a = asset(p, KF);
    assert.equal(a.status, 'pending-review');
    assert.equal(a.layout_steps?.length, 1);
    assert.equal(a.layout_steps![0]!.step, 'restyle');
    assert.equal(a.layout_steps![0]!.job, pend[0]!.id);
    if (done.status === 'done') {
      assert.deepEqual(done.job.items[0]!.refs!.map((x) => [x.id, x.uri]), [[`${KF}_step1`, a.layout_steps![0]!.uri], ['char_mara_turnaround', 'mem://assets/char_mara_turnaround.png']]);
    }
    assert.ok(a.tags.some((t) => /^layout:[0-9a-f]{16}$/.test(t)) && a.tags.some((t) => t.startsWith('from:char_mara_turnaround@')));
    assert.equal(layoutState(p, a), 'used');
    assert.deepEqual(p.ledger.filter((e) => e.unit === KF && e.status === 'done').map((e) => e.job).sort(), [pend[0]!.id, pend[1]!.id].sort(), 'one ledger entry per generation');
    assert.deepEqual(checkIntegrity(p), []);
    const audit = auditProject(p, { now: NOW }).frames.find((f) => f.unit === KF)!;
    assert.ok(!audit.structural.some((f) => f.check === 'missing-reference' || f.check === 'layout'), JSON.stringify(audit.structural));
  });

  it('a failure after step 1 keeps step 1 and its cost; step again runs the next step alone', async () => {
    let failing = true;
    const r = paidRig(twoStep(planKeyframes(bibleApproved(BUDGET), NOW).project), (n) => (failing && n === 2 ? new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }) : undefined));
    await generateKeyframes(r.deps, opts);
    for (const j of r.host.peek().pending_spend.filter((x) => x.units.includes(KF))) r.host.set(approveSpend(r.host.peek(), j.id, 'keyframes').project);
    const failed = await generateKeyframes(r.deps, opts);
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.deepEqual(failed.steps!.map((s) => s.name), ['restyle']);
    let p = r.host.peek();
    assert.equal(p.ledger.filter((e) => e.unit === KF && e.status === 'done').length, 1, 'step 1 stays in the ledger');
    assert.equal(asset(p, KF).status, 'draft');
    assert.equal(asset(p, KF).file, undefined);
    assert.equal(asset(p, KF).layout_steps?.length, 1);
    assert.equal(buildKeyframeJob(p, opts).chain!.done, 1, 'the next build starts at step 2');
    failing = false;
    const calls = r.net.calls.length;
    const retry = await generateKeyframes(r.deps, opts);
    assert.equal(retry.status, 'done', JSON.stringify(retry));
    assert.equal(r.net.calls.length, calls + 1, 'only step 2 ran again');
    assert.deepEqual(retry.steps!.map((s) => s.name), ['identity Mara']);
    assert.equal(retry.generations, 2);
    p = r.host.peek();
    assert.equal(asset(p, KF).status, 'pending-review');
    assert.equal(p.ledger.filter((e) => e.unit === KF && e.status === 'done').length, 2);
  });

  it('manual: one package with both steps in order, the allowance line counts both, ingest takes the last file and the step files', async () => {
    const dir = await folder(twoStep(planned()));
    const out = await run(['step', '--project', dir, '--provider', 'manual', '--units', KF, '--allowance', 'canva'], () => new Date(NOW));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /## sc1_sh1_keyframe in 2 steps \(2 generations\)/);
    assert.match(out.out, /### Step 1 of 2: restyle\n/);
    assert.match(out.out, /### Step 2 of 2: identity Mara \(needs step 1's result\)/);
    assert.match(out.out, /Attach the result of step 1 \(restyle\) as the first image\./);
    assert.match(out.out, /Allowance check — [^\n]*: 2 generations with Canva/);
    assert.match(out.out, /Reply "approve 2 canva generations"/);
    assert.match(out.out, /--units sc1_sh1_keyframe:2/);
    const jobId = /Job (job_kf_\w+)\. When the files are back/.exec(out.out)![1]!;
    const s1 = join(dir, 'step1.png');
    const last = join(dir, 'last.png');
    await writeFile(s1, png(11));
    await writeFile(last, png(12));
    const wrong = await run(['ingest', '--project', dir, '--job', jobId, '--unit', KF, '--file', last, '--step-files', `${s1},${s1}`], () => new Date(NOW));
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /made in 2 steps/);
    const ok = await run(['ingest', '--project', dir, '--job', jobId, '--unit', KF, '--file', last, '--step-files', s1], () => new Date(NOW));
    assert.equal(ok.code, 0, ok.out);
    const saved = AkukoProjectSchema.parse(JSON.parse(await readFile(join(dir, 'akuko.json'), 'utf8')));
    const a = asset(saved, KF);
    assert.equal(a.status, 'pending-review');
    assert.equal(a.layout_steps?.length, 1);
    assert.equal(a.layout_steps![0]!.job, jobId);
    assert.equal(a.layout_steps![0]!.hash, sha256Bytes(png(11)));
    assert.deepEqual(new Uint8Array(await readFile(join(dir, a.layout_steps![0]!.uri))), png(11));
    assert.equal(layoutState(saved, a), 'used');
    assert.deepEqual(checkIntegrity(saved), []);
  });

  it('status: a take is stamped with its layout, and a changed layout flags it as superseded without moving a status', () => {
    const made = madeTake(withLayout(planned()));
    assert.ok(asset(made, KF).tags.some((t) => /^layout:[0-9a-f]{16}$/.test(t)));
    let row = keyframeStatus(made).find((r) => r.asset === KF)!;
    assert.equal(row.layout, 'used');
    assert.deepEqual(row.superseded, []);
    const changed = withLayout(structuredClone(made), 2);
    row = keyframeStatus(changed).find((r) => r.asset === KF)!;
    assert.equal(row.layout, 'changed');
    assert.deepEqual(row.superseded, [layoutRefId(SHOT)]);
    assert.equal(row.status, 'approved', 'a changed layout never sends a frame back by itself');
    const audit = auditProject(changed, { now: NOW }).frames.find((f) => f.unit === KF)!;
    assert.ok(audit.structural.some((f) => f.check === 'layout' && f.severity === 'medium' && /earlier layout/.test(f.text)));
    assert.ok(!audit.structural.some((f) => f.check === 'superseded-reference'), 'the layout is reported once, as a layout');
    // removing it is a change too
    delete changed.shots.find((s) => s.id === SHOT)!.layout;
    assert.equal(layoutState(changed, asset(changed, KF)), 'changed');
    // a take made without a layout, when the shot has one now
    const before = madeTake(planned());
    const later = withLayout(structuredClone(before));
    assert.equal(layoutState(later, asset(later, KF)), 'not-used');
    assert.ok(auditProject(later, { now: NOW }).frames.find((f) => f.unit === KF)!.structural.some((f) => f.check === 'layout' && /Made without the layout/.test(f.text)));
    assert.equal(layoutState(before, asset(before, KF)), 'none');
  });
});

describe('a shot layout: the three modes', () => {
  it('attach is the default: the layout first with the other references, one generation, as before', () => {
    const p = withLayout(planned());
    const built = buildKeyframeJob(p, { provider: 'gemini-image', units: [KF] });
    assert.equal(built.chain, undefined);
    const it0 = built.job.items[0]!;
    assert.deepEqual(it0.refs![0], { id: layoutRefId(SHOT), uri: `refs/${SHOT}_layout.png`, role: 'layout', note: LAYOUT_ATTACH_NOTE });
    assert.ok(it0.refs!.some((r) => r.role === 'location' && /for the look of the place only/.test(r.note!)));
    assert.match(it0.prompt, /Layout \(attached blockout render\): keep the camera angle/);
    assert.match(it0.prompt, /Who is where, from the approved sketch board \(thirds grid; the layout wins where they differ\)/);
    assert.match(it0.prompt, /Location \(the attached plate is for the look of the place only/);
    assert.match(built.job.label, /; layout attach, 1 generation$/);
    assert.equal(built.job.id, buildKeyframeJob(planned(), { provider: 'gemini-image', units: [KF] }).job.id, 'attach keeps the job id a layout always had');
    assert.equal(layoutGenerations(p, p.shots.find((s) => s.id === SHOT)!), 1);
  });

  it('off ignores the layout for the job; --layout-mode overrides the shot\'s own mode either way', () => {
    const p = twoStep(planned());
    const off = buildKeyframeJob(p, { provider: 'gemini-image', units: [KF], layoutMode: 'off' });
    assert.equal(off.chain, undefined);
    assert.ok(!off.job.items[0]!.refs!.some((r) => r.role === 'layout'));
    assert.match(off.job.items[0]!.prompt, /^Composition, from the approved sketch board/m);
    assert.match(off.job.label, /; layout off, 1 generation$/);
    const attach = buildKeyframeJob(p, { provider: 'gemini-image', units: [KF], layoutMode: 'attach' });
    assert.equal(attach.job.items[0]!.refs![0]!.role, 'layout');
    const two = buildKeyframeJob(withLayout(planned()), { provider: 'gemini-image', units: [KF], layoutMode: 'two-step' });
    assert.equal(two.chain!.total, 2);
    // a take made with the layout off is reported as made without it
    const made = stampRefs(p, off.job);
    const a = asset(made, KF);
    a.status = 'approved';
    a.file = { uri: 'keyframes/x.png', mime: 'image/png' };
    assert.equal(layoutState(made, a), 'not-used');
  });

  it('the manual package in mode attach is one generation; the allowance line counts what the mode costs', async () => {
    const dir = await folder(withLayout(planned()));
    const a = await run(['step', '--project', dir, '--provider', 'manual', '--units', KF, '--allowance', 'canva'], () => new Date(NOW));
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /layout attach, 1 generation/);
    assert.match(a.out, /Reply "approve 1 canva generation"/);
    assert.equal((await run(['step', '--project', dir, '--provider', 'manual', '--layout-mode', 'sideways'])).code, 2);
  });
});

describe('a shot layout and the rules guard', () => {
  const LAY = { path: 'Visuals/renders/S02-010.png', data: png(7) };
  const ready = (o: { bytes?: Uint8Array } = {}) => rulesFolder((p) => {
    // S02-010 is Kit, a never_from_photo entry
    p.shots.find((s) => s.id === 'S02-010')!.layout = { uri: LAY.path, sha256: sha256Bytes(LAY.data) };
  }).then(async (f) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(f.dir, 'Visuals', 'renders'), { recursive: true });
    await writeFile(join(f.dir, LAY.path), o.bytes ?? LAY.data);
    return f;
  });
  const ref = { id: 'S02-010_layout', uri: LAY.path, role: 'layout' };

  it('is sent without an allow-list entry while its bytes match the recorded sha256, even for a never-from-photo entry', async () => {
    const { dir, project } = await ready();
    const r = await checkJob(project, job({ unit: 'S02-010', prompt: 'Kit reads a letter by the window, painterly 35mm grain, muted teal palette', refs: [ref] }), { projectDir: dir });
    assert.deepEqual(r.breaches, []);
    assert.deepEqual(await externalRefs(project, [ref], { projectDir: dir }), [], 'an allowance take made from it is not marked refs:external');
    assert.deepEqual((await checkProjectRules(project, { projectDir: dir })).breaches.filter((b) => b.ref === 'S02-010_layout'), []);
  });

  it('a changed file is refused (layout-changed), a missing one too, and a layout is only for its own shot', async () => {
    const changed = await ready({ bytes: png(8) });
    const r = await checkJob(changed.project, job({ unit: 'S02-010', prompt: 'x painterly 35mm grain, muted teal palette', refs: [ref] }), { projectDir: changed.dir });
    assert.deepEqual(r.breaches.map((b) => b.rule), ['layout-changed']);
    assert.match(r.breaches[0]!.message, /has changed since it was set/);
    const pre = await checkProjectRules(changed.project, { projectDir: changed.dir });
    assert.ok(pre.breaches.some((b) => b.rule === 'layout-changed'));

    const { dir, project } = await ready();
    const missing = structuredClone(project);
    missing.shots.find((s) => s.id === 'S02-010')!.layout!.uri = 'Visuals/renders/gone.png';
    const m = await checkJob(missing, job({ unit: 'S02-010', prompt: 'x painterly 35mm grain, muted teal palette', refs: [{ ...ref, uri: 'Visuals/renders/gone.png' }] }), { projectDir: dir });
    assert.deepEqual(m.breaches.map((b) => b.rule), ['uploads']);
    const other = await checkJob(project, job({ unit: 'S01-010', prompt: 'Ada painterly 35mm grain, muted teal palette', refs: [ref] }), { projectDir: dir });
    assert.ok(other.breaches.some((b) => b.rule === 'uploads' && /only for its own shot/.test(b.message)));
    // a ref that borrows the layout id but points at another file is just an external file
    const borrowed = await checkJob(project, job({ unit: 'S02-010', prompt: 'x painterly 35mm grain, muted teal palette', refs: [{ ...ref, uri: 'inbox/street-photo.jpg' }] }), { projectDir: dir });
    assert.ok(borrowed.breaches.some((b) => b.rule === 'never-from-photo'));
  });

  it('an earlier step is sent on only for its own key frame, while it is generated and its bytes are unchanged', async () => {
    const STEP = { path: 'keyframes/S02-010_keyframe-step1.png', data: png(9) };
    const { dir, project } = await ready();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'keyframes'), { recursive: true });
    await writeFile(join(dir, STEP.path), STEP.data);
    const p = structuredClone(project);
    const JOB = 'job_kf_0000aaaa_r1_s1';
    p.assets.push({ id: 'S02-010_keyframe', kind: 'keyframe', stage: 'keyframes', status: 'draft', comments: [], owner: 'S02-010', tags: ['keyframe'], layout_steps: [{ step: 'restyle', uri: STEP.path, hash: sha256Bytes(STEP.data), job: JOB, layout: '0'.repeat(16) }] });
    const generated = structuredClone(p);
    generated.ledger.push({ id: 'l_step1', ts: NOW, provider: 'gemini-image', job: JOB, unit: 'S02-010_keyframe', estimate: 0.04, actual: 0.04, status: 'done' });
    const stepRef = { id: 'S02-010_keyframe_step1', uri: STEP.path, role: 'previous-step' };
    const kit = (unit: string, q: AkukoProject, ref = stepRef) => checkJob(q, job({ unit, prompt: 'Kit reads a letter by the window, painterly 35mm grain, muted teal palette', refs: [ref] }), { projectDir: dir });
    // Kit is never_from_photo: a generated step with a matching sha256 is fine, with no allow-list entry
    assert.deepEqual((await kit('S02-010', generated)).breaches, []);
    assert.deepEqual(await externalRefs(generated, [stepRef], { projectDir: dir }), []);
    // no done generation for its job: not generated
    assert.ok((await kit('S02-010', p)).breaches.some((b) => b.rule === 'uploads' && /no done generation/.test(b.message)));
    // another shot
    assert.ok((await kit('S01-010', generated)).breaches.some((b) => b.rule === 'uploads' && /only for its own key frame/.test(b.message)));
    // changed bytes
    await writeFile(join(dir, STEP.path), png(10));
    assert.deepEqual((await kit('S02-010', generated)).breaches.map((b) => b.rule), ['generated-changed']);
  });
});
