// WP-28b — the lip-sync step: which shots, the job (model, id, refs, retry cap), the rules guard and
// the spend gate, the command line. Synthetic project and WAVs only (`__fixtures__/project.ts`); fal is
// a mocked network and any real fetch throws. "Approved" only ever comes from folding a person's
// decision; nothing here lets code write it.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost } from '../hosts/local.ts';
import { listUnits, type AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import type { Provider } from '../providers/contract.ts';
import { createFalLipsyncProvider } from '../providers/lipsync/fal/index.ts';
import { MP4_BYTES, mockFalLipsync } from '../providers/lipsync/fal/__fixtures__/mock-net.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createSpendGate, type SpendGate } from '../spend/gate.ts';
import { guardGate, RULES_BREACH } from '../rules/guard.ts';
import { sha256Bytes } from '../rules/refs.ts';
import { approveSpend } from '../bible/__fixtures__/project.ts';
import { run } from './cli.ts';
import { resolveAll } from './cut.ts';
import { LipsyncError, assetIdFor, buildLipsyncJob, lipsyncTargets, planLipsync } from './plan.ts';
import { PROVIDER_REFUSED, generateLipsync } from './run.ts';
import { T0, lipsyncFolder, readProject, writeProject } from './__fixtures__/project.ts';

globalThis.fetch = (() => { throw new Error('a real network call was attempted'); }) as typeof fetch;

const T = (): Date => new Date(T0);
const now = (): string => T0;
const ENV = { FAL_KEY: 'test-key' };
const approvedIds = (p: AkukoProject): string[] => listUnits(p).filter((u) => u.unit.status === 'approved').map((u) => u.unit.id).sort();
const asset = (p: AkukoProject, id: string) => p.assets.find((a) => a.id === id)!;

/** A folder with the lip-syncs planned and the line audio cut (the command line's `plan`). */
async function planned(opts: Parameters<typeof lipsyncFolder>[0] = {}) {
  const f = await lipsyncFolder(opts);
  const r = await run(['plan', '--project', f.dir], T);
  assert.equal(r.code, 0, r.out);
  return { ...f, planOut: r.out, project: await readProject(f.dir) };
}

/** The person approves the amount the gate showed (a decision, folded). */
async function approvePending(dir: string): Promise<string> {
  const p = await readProject(dir);
  const job = p.pending_spend.find((j) => j.status === 'awaiting-approval');
  assert.ok(job, 'a spend is waiting');
  await writeProject(dir, approveSpend(p, job.id, 'motion').project);
  return job.id;
}

/** Gate deps for `generateLipsync`, with a counter on the wrapped gate (did the guard let it through?). */
function deps(dir: string, net = mockFalLipsync()) {
  const host = createLocalHost({ projectDir: dir, now: T });
  const providers: Provider[] = [createManualProvider(host, { now }).provider, createFalLipsyncProvider(host, { projectDir: dir, fetch: net.fetch, apiKey: 'test-key', now })];
  const inner = createSpendGate({ host, providers, level: 'B', now });
  const calls = { quote: 0, run: 0 };
  const spy: SpendGate = { quote: (j) => { calls.quote++; return inner.quote(j); }, run: (j) => { calls.run++; return inner.run(j); }, collect: (h) => inner.collect(h) };
  const gate = guardGate(spy, createLocalHost({ projectDir: dir, now: T }), { projectDir: dir, providers });
  return { d: { host, gate, now, audio: { projectDir: dir } }, calls, net };
}

// ─────────────────────────────────────────────────────────────────────────
describe('which shots get a lip-sync', () => {
  it('a lipsync shot, or a video shot with a spoken line; never a thought line, a still or a removed row', async () => {
    const { project } = await lipsyncFolder();
    const { targets, passed } = lipsyncTargets(project);
    assert.deepEqual(targets.map((t) => [t.shot.id, t.lines.map((l) => l.id)]), [['S02-010', ['L01']], ['S02-020', ['L02']], ['S03-010', ['L05', 'L06']]]);
    assert.deepEqual(passed, [{ shot: 'S02-030', why: 'its lines are thoughts (voice-over), so there is no mouth to sync' }]);

    const p = planLipsync(project, T0);
    assert.deepEqual(p.created, ['S02-010_lipsync', 'S02-020_lipsync', 'S03-010_lipsync']);
    const a = asset(p.project, 'S02-010_lipsync');
    assert.deepEqual({ kind: a.kind, stage: a.stage, status: a.status, owner: a.owner, file: a.file }, { kind: 'lipsync', stage: 'motion', status: 'pending', owner: 'S02-010', file: undefined });
    assert.equal(p.project.stages.motion.state, 'in-progress');
    assert.deepEqual(planLipsync(p.project, T0).created, [], 'idempotent');
    assert.deepEqual(checkIntegrity(p.project), []);
  });

  it('refuses while an earlier stage waits (lip-sync is part of the motion stage)', async () => {
    const { project } = await lipsyncFolder({ mutate: (p) => { p.stages.keyframes = { state: 'in-review' }; } });
    assert.throws(() => planLipsync(project, T0), (e: unknown) => e instanceof LipsyncError && /locked: keyframes/.test(e.message));
  });

  it('plan (command line) plans, cuts the line audio and says what it passed over', async () => {
    const { planOut, dir } = await planned();
    assert.match(planOut, /Planned 3 lip-syncs: S02-010_lipsync, S02-020_lipsync, S03-010_lipsync\./);
    assert.match(planOut, /S02-030: no lip-sync, because its lines are thoughts/);
    assert.match(planOut, /Cut the line audio for S02-010_linecut, S03-010_linecut/);
    assert.match(planOut, /S02-020_lipsync: uses line L02's own clip/);
    assert.match(planOut, /audio\.master\.sha256 is not recorded/);
    const status = (await run(['status', '--project', dir], T)).out;
    assert.match(status, /S02-010_lipsync \(line L01\): pending \(ready\)/);
    assert.match(status, /S03-010_lipsync \(lines L05, L06\): pending \(ready\)/);
    assert.deepEqual(checkIntegrity(await readProject(dir)), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the job', () => {
  it('one shot; refs per the provider contract; the model fits the measured line and is hashed into the id', async () => {
    const { project, dir } = await planned();
    const audio = await resolveAll(project, { projectDir: dir });
    const b = buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S02-010', audio });
    assert.equal(b.job.items.length, 1);
    assert.match(b.job.id, /^job_ls_[0-9a-f]{8}_r1$/);
    assert.deepEqual({ stage: b.job.stage, kind: b.job.kind, model: b.job.model }, { stage: 'motion', kind: 'video', model: 'veed/fabric-1.0#480p' }); // a 2 s line: under h3-max's 5 s floor
    const item = b.job.items[0]!;
    assert.deepEqual({ unit: item.unit, output: item.output, duration_s: item.duration_s, count: item.count }, { unit: 'S02-010_lipsync', output: 'lipsync', duration_s: 2, count: 1 });
    assert.deepEqual(item.refs, [
      { id: 'S02-010_keyframe', uri: 'board/panels/S02-010_keyframe.png', role: 'start-frame', note: 'the approved key frame: the face to animate' },
      { id: 'S02-010_linecut', uri: 'lipsync/cuts/S02-010_linecut.wav', role: 'audio', note: 'seconds=2' },
    ]);
    assert.match(b.job.label, /uploads to fal, if you approve, the still board\/panels\/S02-010_keyframe\.png and the audio lipsync\/cuts\/S02-010_linecut\.wav \(cut from the master audio\/master\.wav, 0\.8-2\.8 s\)/);
    assert.match(b.job.label, /2 s x 0\.08 USD\/s = 0\.16/);
    assert.ok(b.notes.some((n) => /starts 0\.8 s into the shot/.test(n)));

    // Another model is another job: an approval never carries over to it.
    const hi = buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S02-010', model: 'veed/fabric-1.0#720p', audio });
    assert.equal(hi.job.model, 'veed/fabric-1.0#720p');
    assert.notEqual(hi.job.id, b.job.id);
    assert.notEqual(buildLipsyncJob(project, { provider: 'manual', shot: 'S02-010', audio }).job.id, b.job.id);
    assert.equal(buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S02-010', audio }).job.id, b.job.id, 'the same job asked twice is the same id');

    // Longer lines get the model whose limits admit them; a model that can't take the line is refused here.
    assert.equal(buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S03-010', audio }).job.model, 'minimax/h3-max/lip-sync/image-to-video'); // 6 s: L05..L06
    assert.throws(() => buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S02-010', model: 'minimax/h3-max/lip-sync/image-to-video', audio }), /takes a line of 5-15 s; this one is 2\.00 s/);
    assert.throws(() => buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S02-010', model: 'fal-ai/kling-video/lipsync/audio-to-video', audio }), /takes a video clip/);
  });

  it('a line\'s own 16-bit clip is sent as it is', async () => {
    const { project, dir } = await planned();
    const b = buildLipsyncJob(project, { provider: 'fal-lipsync', shot: 'S02-020', audio: await resolveAll(project, { projectDir: dir }) });
    assert.deepEqual(b.job.items[0]!.refs![1], { id: 'L02', uri: 'clips/L02.wav', role: 'audio', note: 'seconds=2.45' });
    assert.match(b.job.label, /the audio clips\/L02\.wav \(line L02's own clip\)/);
  });

  it('the retry cap holds at 3 paid attempts per shot, counted from the ledger', async () => {
    const { project, dir } = await planned();
    const audio = await resolveAll(project, { projectDir: dir });
    const p = structuredClone(project);
    const unit = assetIdFor('S02-010');
    for (let i = 1; i <= 3; i++) p.ledger.push({ id: `led-${i}`, ts: T0, provider: 'fal-lipsync', unit, job: `job_ls_0000000${i}_r1`, estimate: 0.16, actual: 0.16, status: 'done' });
    p.ledger.push({ id: 'led-4', ts: T0, provider: 'fal-lipsync', unit, job: 'job_ls_00000004_r1', estimate: 0.16, status: 'failed' }); // never reached fal: not an attempt
    assert.throws(() => buildLipsyncJob(p, { provider: 'fal-lipsync', shot: 'S02-010', audio }), (e: unknown) => e instanceof LipsyncError && /3 paid attempts and 0\.48 USD has gone on it; the limit is 3 per shot/.test(e.message));
    assert.equal(buildLipsyncJob(p, { provider: 'fal-lipsync', shot: 'S02-010', audio, maxAttempts: 4 }).unit, unit);
    assert.equal(buildLipsyncJob(p, { provider: 'fal-lipsync', audio }).unit, 'S02-020_lipsync', 'the default pick passes over a shot at the cap');
  });

  it('a thought line gets nothing to make', async () => {
    const { dir } = await planned();
    const r = await run(['step', '--project', dir, '--provider', 'manual', '--shot', 'S02-030'], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /S02-030 has no planned lip-sync/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the rules guard and the spend gate', () => {
  it('a rules breach is refused before the gate quotes: nothing priced, written or sent', async () => {
    const { dir } = await planned({ rules: true, mutate: (p) => { p.audio!.lines![0]!.text = 'Bring the Zorbex lamp closer.'; } });
    const { d, calls, net } = deps(dir);
    const r = await generateLipsync(d, { provider: 'fal-lipsync', shot: 'S02-010' });
    assert.equal(r.status, 'refused');
    assert.equal(r.status === 'refused' && r.code, RULES_BREACH);
    assert.match(r.status === 'refused' ? r.message : '', /banned term "zorbex"/);
    assert.deepEqual(calls, { quote: 0, run: 0 });
    assert.equal(net.calls.length, 0);
    const p = await readProject(dir);
    assert.deepEqual(p.pending_spend, []);
    assert.equal(asset(p, 'S02-010_lipsync').status, 'pending');
  });

  it('an audio file the rules don\'t allow is refused the same way', async () => {
    const { dir } = await planned({ rules: true, mutate: (p) => { p.rules!.uploads.allow = p.rules!.uploads.allow.filter((a) => !a.slices); } });
    const { d, calls } = deps(dir);
    const r = await generateLipsync(d, { provider: 'fal-lipsync', shot: 'S02-010' });
    assert.equal(r.status === 'refused' && r.code, RULES_BREACH);
    assert.match(r.status === 'refused' ? r.message : '', /S02-010_linecut .* is a slice of sha256/);
    assert.equal(calls.quote, 0);
  });

  it('a provider exception while pricing becomes a refusal; nothing is priced and the unit is untouched', async () => {
    const { dir } = await planned();
    await rm(join(dir, 'board', 'panels', 'S02-010_keyframe.png'));
    const { d, net } = deps(dir);
    const r = await generateLipsync(d, { provider: 'fal-lipsync', shot: 'S02-010' });
    assert.equal(r.status, 'refused');
    assert.equal(r.status === 'refused' && r.code, PROVIDER_REFUSED);
    assert.match(r.status === 'refused' ? r.message : '', /file not found: board\/panels\/S02-010_keyframe\.png.*Nothing was priced, sent or spent/);
    const p = await readProject(dir);
    assert.deepEqual(p.pending_spend, []);
    assert.equal(asset(p, 'S02-010_lipsync').status, 'pending');
    assert.equal(net.calls.length, 0);
  });

  it('after approval, an exception when it runs puts the unit back and reserves nothing', async () => {
    const { dir } = await planned();
    const { d, net } = deps(dir);
    assert.equal((await generateLipsync(d, { provider: 'fal-lipsync', shot: 'S02-010' })).status, 'awaiting-approval');
    await approvePending(dir);
    await rm(join(dir, 'board', 'panels', 'S02-010_keyframe.png'));
    const again = deps(dir, net).d;
    const r = await generateLipsync(again, { provider: 'fal-lipsync', shot: 'S02-010' });
    assert.equal(r.status === 'refused' && r.code, PROVIDER_REFUSED);
    const p = await readProject(dir);
    assert.equal(asset(p, 'S02-010_lipsync').status, 'pending');
    assert.deepEqual(p.ledger, []);
    assert.equal(net.calls.length, 0);
  });

  it('paid, end to end on the command line: spend line with the uploads, the person approves, one request, a lip-sync to review', async () => {
    const { dir } = await planned({ rules: true });
    const before = approvedIds(await readProject(dir));
    const net = mockFalLipsync();
    const io = { fetch: net.fetch, env: ENV };

    const first = await run(['step', '--project', dir, '--provider', 'fal-lipsync', '--shot', 'S02-010'], T, io);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Spend check — Lip-sync S02-010 \(line L01\): uploads to fal, if you approve, the still board\/panels\/S02-010_keyframe\.png and the audio lipsync\/cuts\/S02-010_linecut\.wav/);
    assert.match(first.out, /estimate 0\.16 USD/);
    assert.match(first.out, /Nothing has been sent/);
    assert.equal(net.calls.length, 0);
    assert.equal((await readProject(dir)).stages.motion.state, 'waiting-spend');

    const jobId = await approvePending(dir);
    const done = await run(['step', '--project', dir, '--provider', 'fal-lipsync', '--shot', 'S02-010'], T, io);
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /Done: S02-010_lipsync recorded, cost 0\.16.*Its own audio is not used/);
    assert.match(done.out, /belongs at 0\.8 s on the master/);

    const posts = net.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1, 'one shot, one request');
    assert.equal(posts[0]!.url, 'https://queue.fal.run/veed/fabric-1.0');
    const body = posts[0]!.body as Record<string, string>;
    assert.match(body.image_url!, /^data:image\/png;base64,/);
    assert.match(body.audio_url!, /^data:audio\/wav;base64,/);
    assert.equal(body.resolution, '480p');
    const sent = Buffer.from(body.audio_url!.split(',')[1]!, 'base64');
    assert.deepEqual(new Uint8Array(sent), new Uint8Array(await readFile(join(dir, 'lipsync', 'cuts', 'S02-010_linecut.wav'))), 'the cut is what was sent');

    const p = await readProject(dir);
    const ls = asset(p, 'S02-010_lipsync');
    assert.equal(ls.status, 'pending-review');
    assert.equal(ls.provider, 'fal-lipsync');
    assert.equal(ls.model, 'veed/fabric-1.0#480p');
    assert.deepEqual(ls.film, { in_s: 0.8, out_s: 2.8 }, 'where the video belongs on the master: the span of the audio it was made from');
    assert.ok(ls.tags.includes(`job:${jobId}`));
    assert.ok(ls.file && existsSync(join(dir, ...ls.file.uri.split('/'))));
    assert.deepEqual(new Uint8Array(await readFile(join(dir, ...ls.file.uri.split('/')))), MP4_BYTES);
    assert.equal(p.stages.motion.state, 'in-progress', 'other units still wait');
    assert.deepEqual(approvedIds(p), before, 'no code wrote approved');
    assert.deepEqual(checkIntegrity(p), []);
    assert.ok(existsSync(join(dir, 'lipsync', 'jobs', `${jobId}.json`)));
  });

  it('a missing key is a setup problem, said before anything is touched', async () => {
    const { dir } = await planned();
    const r = await run(['step', '--project', dir, '--provider', 'fal-lipsync'], T, { env: {}, fetch: mockFalLipsync().fetch });
    assert.equal(r.code, 1);
    assert.match(r.out, /Setup needed: FAL_KEY is not set/);
    assert.deepEqual((await readProject(dir)).pending_spend, []);
  });

  it('manual: a prompt package, then the video the person brings back goes to review', async () => {
    const { dir } = await planned();
    const r = await run(['step', '--project', dir, '--provider', 'manual'], T);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Lip-sync shot S02-010/);
    assert.match(r.out, /Nothing is uploaded by akuko/);
    assert.match(r.out, /lipsync\/cuts\/S02-010_linecut\.wav/);
    const jobId = /Job (job_ls_\S+?)\./.exec(r.out)![1]!;
    const mp4 = join(dir, 'made.mp4');
    await writeFile(mp4, MP4_BYTES);
    const ing = await run(['ingest', '--project', dir, '--job', jobId, '--unit', 'S02-010_lipsync', '--file', mp4], T);
    assert.equal(ing.code, 0, ing.out);
    const p = await readProject(dir);
    assert.equal(asset(p, 'S02-010_lipsync').status, 'pending-review');
    assert.deepEqual(checkIntegrity(p), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the master hash', () => {
  it('is written only by the person\'s command, and a changed master is not silently re-recorded', async () => {
    const { dir, files } = await planned();
    assert.equal((await readProject(dir)).audio?.master?.sha256, undefined, 'plan never writes it');
    const r = await run(['record-master-hash', '--project', dir], T);
    assert.equal(r.code, 0, r.out);
    assert.equal((await readProject(dir)).audio?.master?.sha256, sha256Bytes(files.master!.data));
    assert.match((await run(['record-master-hash', '--project', dir], T)).out, /already/);

    const changed = new Uint8Array(files.master!.data);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await writeFile(join(dir, 'audio', 'master.wav'), changed);
    const refused = await run(['record-master-hash', '--project', dir], T);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /the master has changed\. Nothing was written/);
    assert.equal((await readProject(dir)).audio?.master?.sha256, sha256Bytes(files.master!.data));
    assert.equal((await run(['record-master-hash', '--project', dir, '--replace'], T)).code, 0);
    assert.equal((await readProject(dir)).audio?.master?.sha256, sha256Bytes(changed));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('files outside the project', () => {
  it('a clip outside the project is read only through --allow-root, never remembered; without it the master is cut', async () => {
    const { dir, base, planOut } = await planned({ clipOutside: true });
    assert.match(planOut, /Cut the line audio for S02-010_linecut, S02-020_linecut, S03-010_linecut/);
    const io = { fetch: mockFalLipsync().fetch, env: ENV };

    const without = await run(['step', '--project', dir, '--provider', 'fal-lipsync', '--shot', 'S02-020'], T, io);
    assert.match(without.out, /the audio lipsync\/cuts\/S02-020_linecut\.wav \(cut from the master/);

    const root = join(base, 'media');
    const withRoot = await run(['step', '--project', dir, '--provider', 'fal-lipsync', '--shot', 'S02-020', '--allow-root', root], T, io);
    assert.equal(withRoot.code, 0, withRoot.out);
    assert.match(withRoot.out, /the audio \.\.\/media\/clips\/L02\.wav \(line L02's own clip\)/);
    assert.ok(!(await readFile(join(dir, 'akuko.json'), 'utf8')).includes(JSON.stringify(root).slice(1, -1)), 'the allowed folder is not stored');
    // The next run without the flag is back to the master cut.
    assert.match((await run(['step', '--project', dir, '--provider', 'fal-lipsync', '--shot', 'S02-020'], T, io)).out, /S02-020_linecut\.wav \(cut from the master/);
    assert.equal((await run(['status', '--project', dir, '--allow-root', join(base, 'nope')], T)).code, 2);
  });
});
