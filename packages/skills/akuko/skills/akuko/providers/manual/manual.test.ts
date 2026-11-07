// akuko — manual provider: emits a prompt package, ingests the returned file.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AkukoProjectSchema } from '../../schema/akuko-project.ts';
import { checkIntegrity } from '../../schema/integrity.ts';
import type { Job } from '../contract.ts';
import { createSpendGate } from '../../spend/gate.ts';
import { PNG, createFakeHost, tinyProject } from '../__fixtures__/fake-host.ts';
import { ManualIngestError, createManualProvider } from './index.ts';
import type { PromptPackage } from './package.ts';
import { buildPromptPackage, renderPromptPackage } from './package.ts';

const NOW = '2026-11-07T10:00:00Z';

const kfJob: Job = {
  id: 'job_kf_manual',
  stage: 'keyframes',
  kind: 'image',
  provider: 'manual',
  label: 'Key frames for scene 1',
  items: [
    { unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe', aspect_ratio: '16:9', camera: 'Static, low angle', refs: [{ id: 'char_n', uri: 'board/char_n.png', role: 'character' }] },
    { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'keyframe', negative: 'text, watermark' },
  ],
};

function setup(opts: { registerOnStore?: boolean; budget?: boolean; platform?: 'generic' | 'flow' | 'higgsfield' | 'veo' } = {}) {
  const p = tinyProject(opts.budget ? { budget: { cap: 5, currency: 'USD', spent: 0 } } : {});
  const host = createFakeHost(p, { registerOnStore: opts.registerOnStore ?? false });
  const manual = createManualProvider(host, { now: () => NOW, ...(opts.platform ? { platform: opts.platform } : {}) });
  const gate = createSpendGate({ host, providers: [manual.provider], level: 'A', now: () => NOW });
  return { host, manual, gate };
}

describe('manual provider: prompt package', () => {
  it('submit (through the gate) returns a prompt package: what to paste, what to attach, what to name the file', async () => {
    const { gate, host } = setup();
    const r = await gate.run(kfJob);
    assert.equal(r.status, 'submitted');
    if (r.status !== 'submitted') return;
    const pkg = r.handle.handoff?.body as PromptPackage;
    assert.equal(pkg.format, 'akuko-prompt-package');
    assert.equal(pkg.job, kfJob.id);
    assert.deepEqual(pkg.items.map((i) => i.expected_file), ['sc1_sh1-keyframes.png', 'sc1_sh2-keyframes.png']);
    assert.deepEqual(pkg.items[0]?.accept, ['image/png', 'image/jpeg', 'image/webp']);
    assert.match(pkg.items[0]?.refs[0]?.attach ?? '', /Upload the file board\/char_n\.png as a character image/);
    assert.ok(pkg.steps.some((s) => /Nothing is marked approved until you approve it/.test(s)));
    const text = r.handle.handoff?.text ?? '';
    assert.match(text, /## sc1_sh1 → save as `sc1_sh1-keyframes\.png`/);
    assert.match(text, /Avoid: text, watermark/);
    assert.equal(host.writes(), 0, 'emitting a package writes nothing to akuko.json');
  });

  it('shapes the prompt per platform, as Studio does', () => {
    const item = (platform: 'generic' | 'flow' | 'higgsfield' | 'veo') => buildPromptPackage(kfJob, platform).items[0]?.prompt ?? '';
    assert.equal(item('generic'), 'A long dark hallway. Static, low angle. Aspect 16:9.');
    assert.match(item('flow'), /^Ingredients: char_n/);
    assert.match(item('higgsfield'), /^Camera: Static, low angle\./);
    assert.match(item('veo'), /Audio: /);
    assert.match(renderPromptPackage(buildPromptPackage(kfJob)), /^# Key frames for scene 1/);
  });
});

describe('manual provider: ingest', () => {
  for (const registerOnStore of [false, true]) {
    it(`files a returned image against its shot as pending-review (host ${registerOnStore ? 'registers' : 'does not register'} assets on store)`, async () => {
      const { manual, host, gate } = setup({ registerOnStore });
      const r = await gate.run(kfJob);
      if (r.status !== 'submitted') return assert.fail(JSON.stringify(r));

      assert.equal((await manual.provider.poll(r.handle)).state, 'waiting-for-input');
      const { asset, warnings } = await manual.ingest({ job: kfJob, unit: 'sc1_sh1', file: { filename: 'Higgsfield_4471.png', mime: 'image/png', data: PNG } });
      assert.deepEqual(warnings, []);
      assert.equal(asset.id, 'sc1_sh1-keyframes');
      assert.equal(asset.kind, 'keyframe');
      assert.equal(asset.owner, 'sc1_sh1');
      assert.equal(asset.provider, 'manual');
      assert.equal(asset.status, 'pending-review');
      assert.equal(asset.file?.uri, 'mem://assets/sc1_sh1-keyframes.png');
      assert.ok(asset.tags.includes('job:job_kf_manual'));
      assert.ok(host.files.has('mem://assets/sc1_sh1-keyframes.png'), 'bytes went through storeAsset, not into JSON');

      const p = host.peek();
      assert.equal(p.assets.filter((a) => a.id === asset.id).length, 1, 'added exactly once');
      const shot = p.shots.find((s) => s.id === 'sc1_sh1');
      assert.equal(shot?.stage, 'keyframes');
      assert.equal(shot?.status, 'pending-review');
      assert.equal(shot?.by_stage?.sketch?.status, 'approved', 'the approved sketch is kept');
      assert.equal(shot?.by_stage?.keyframes?.output?.uri, asset.file?.uri);
      assert.deepEqual(checkIntegrity(p), []);
      assert.equal(AkukoProjectSchema.safeParse(p).success, true);
      assert.ok(!JSON.stringify(p).includes('"data"'), 'no bytes in akuko.json');

      const progress = await manual.provider.poll(r.handle);
      assert.equal(progress.state, 'waiting-for-input');
      assert.equal(progress.progress, 0.5);

      await manual.ingest({ job: kfJob, unit: 'sc1_sh2', file: { filename: 'b.jpg', mime: 'image/jpeg', data: PNG } });
      assert.equal((await manual.provider.poll(r.handle)).state, 'done');
      const c = await gate.collect(r.handle);
      assert.deepEqual(c.assets.map((a) => a.id), ['sc1_sh1-keyframes', 'sc1_sh2-keyframes']);
      assert.equal(host.peek().assets.find((a) => a.id === 'sc1_sh2-keyframes')?.file?.uri, 'mem://assets/sc1_sh2-keyframes.jpg');
      assert.deepEqual(host.peek().ledger, [], 'a free job writes no ledger entry');
    });
  }

  it('never marks anything approved, and a later collect does not undo a person\'s approval', async () => {
    const { manual, host, gate } = setup();
    const r = await gate.run(kfJob);
    if (r.status !== 'submitted') return assert.fail();
    for (const unit of ['sc1_sh1', 'sc1_sh2']) await manual.ingest({ job: kfJob, unit, file: { filename: 'x.png', mime: 'image/png', data: PNG } });
    assert.ok(host.peek().shots.every((s) => s.status === 'pending-review'));
    // A person approves sc1_sh1 (decision folding is WP-07a; set it directly).
    const p = host.peek();
    host.set({ ...p, shots: p.shots.map((s) => (s.id === 'sc1_sh1' ? { ...s, status: 'approved' as const } : s)) });
    await gate.collect(r.handle);
    assert.equal(host.peek().shots[0]?.status, 'approved');
  });

  it('fills a planned asset unit in place (a portrait with no file yet)', async () => {
    const { manual, host } = setup();
    const job: Job = { id: 'job_portrait', stage: 'bible', kind: 'image', provider: 'manual', label: 'Portrait', items: [{ unit: 'char_n_portrait', prompt: 'Portrait of the narrator', output: 'portrait' }] };
    const { asset } = await manual.ingest({ job, unit: 'char_n_portrait', file: { filename: 'p.png', mime: 'image/png', data: PNG } });
    assert.equal(asset.id, 'char_n_portrait');
    assert.equal(asset.owner, 'char_n', 'keeps its owner');
    assert.equal(asset.status, 'pending-review');
    assert.equal(host.peek().assets.length, 1, 'no new asset');
    assert.deepEqual(checkIntegrity(host.peek()), []);
  });

  it('a second take gets its own asset and sends the unit back for review', async () => {
    const { manual, host } = setup();
    await manual.ingest({ job: kfJob, unit: 'sc1_sh1', file: { filename: 'a.png', mime: 'image/png', data: PNG } });
    const { asset } = await manual.ingest({ job: kfJob, unit: 'sc1_sh1', file: { filename: 'b.png', mime: 'image/png', data: PNG } });
    assert.equal(asset.id, 'sc1_sh1-keyframes-2');
    assert.equal(host.peek().assets.filter((a) => a.owner === 'sc1_sh1').length, 2);
  });

  it('records spend the person reports when there is a budget, and warns (pointing to setup) when there is not', async () => {
    const withBudget = setup({ budget: true });
    await withBudget.manual.ingest({ job: kfJob, unit: 'sc1_sh1', file: { filename: 'a.png', mime: 'image/png', data: PNG }, actual: 0.4 });
    const p = withBudget.host.peek();
    assert.deepEqual(p.ledger.map((e) => [e.provider, e.unit, e.status, e.actual]), [['manual', 'sc1_sh1', 'done', 0.4]]);
    assert.equal(p.budget?.spent, 0.4);
    assert.deepEqual(checkIntegrity(p), []);

    const noBudget = setup();
    const r = await noBudget.manual.ingest({ job: kfJob, unit: 'sc1_sh1', file: { filename: 'a.png', mime: 'image/png', data: PNG }, actual: 0.4 });
    assert.match(r.warnings[0] ?? '', /\/akuko setup/);
    assert.deepEqual(noBudget.host.peek().ledger, []);
    assert.deepEqual(checkIntegrity(noBudget.host.peek()), []);
  });

  it('refuses the wrong file type, an empty file, a unit outside the job, and another provider\'s job — before storing anything', async () => {
    const { manual, host } = setup();
    const file = { filename: 'a.png', mime: 'image/png', data: PNG };
    await assert.rejects(manual.ingest({ job: kfJob, unit: 'sc1_sh1', file: { ...file, mime: 'video/mp4' } }), ManualIngestError);
    await assert.rejects(manual.ingest({ job: kfJob, unit: 'sc1_sh1', file: { ...file, data: new Uint8Array() } }), ManualIngestError);
    await assert.rejects(manual.ingest({ job: kfJob, unit: 'char_n', file }), /not part of job/);
    await assert.rejects(manual.ingest({ job: { ...kfJob, provider: 'fal' }, unit: 'sc1_sh1', file }), /not the manual provider/);
    await assert.rejects(manual.ingest({ job: { ...kfJob, items: [{ unit: 'ghost', prompt: 'x', output: 'keyframe' }] }, unit: 'ghost', file }), /unknown unit/);
    assert.ok(!host.calls.includes('storeAsset') && host.writes() === 0);
  });

  it('a job can be picked up from its handle in a later session', async () => {
    const { manual, host, gate } = setup();
    const r = await gate.run(kfJob);
    if (r.status !== 'submitted') return assert.fail();
    const saved = JSON.parse(JSON.stringify(r.handle));
    for (const unit of ['sc1_sh1', 'sc1_sh2']) await manual.ingest({ job: kfJob, unit, file: { filename: 'x.png', mime: 'image/png', data: PNG } });
    const later = createManualProvider(host, { now: () => NOW });
    assert.equal((await later.provider.poll(saved)).state, 'done');
    assert.equal((await later.provider.fetch(saved)).length, 2);
  });
});
