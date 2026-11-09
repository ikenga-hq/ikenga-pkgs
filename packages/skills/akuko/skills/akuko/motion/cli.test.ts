// WP-10 — the motion command line over a real project folder (manual provider: free, no network).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { MP4_BYTES } from '../providers/fal-video/__fixtures__/mock-net.ts';
import { run } from './cli.ts';
import { approve, keyframesApproved } from './__fixtures__/project.ts';

const T = () => new Date('2026-11-09T10:00:00Z');

async function folder(mutate: (p: ReturnType<typeof keyframesApproved>) => void = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-mo-'));
  const p = keyframesApproved();
  mutate(p);
  await writeFile(join(dir, 'akuko.json'), serializeProject(p));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

describe('motion cli', () => {
  it('refuses a project whose key frames are not approved, naming the stage', async () => {
    const { dir } = await folder((p) => { p.stages.keyframes = { state: 'in-review' }; });
    const r = await run(['plan', '--project', dir], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /locked: keyframes/);
  });

  it('plan, step (manual), ingest, fold: one clip end to end on disk', async () => {
    const { dir, host } = await folder();
    assert.match((await run(['plan', '--project', dir], T)).out, /Planned \d+ clips/);
    assert.match((await run(['plan', '--project', dir], T)).out, /already planned/);
    assert.match((await run(['status', '--project', dir], T)).out, /sc1_sh1_clip: pending \(ready\)/);

    const step = await run(['step', '--project', dir, '--provider', 'manual'], T);
    assert.equal(step.code, 0, step.out);
    assert.match(step.out, /sc1_sh1_clip/);
    const jobId = /Job (job_mo_\S+?)\./.exec(step.out)![1]!;
    assert.ok(existsSync(join(dir, 'motion', 'jobs', `${jobId}.json`)));

    const mp4 = join(dir, 'made.mp4');
    await writeFile(mp4, MP4_BYTES);
    assert.equal((await run(['ingest', '--project', dir, '--job', jobId, '--unit', 'sc1_sh1_clip', '--file', join(dir, 'nope.png')], T)).code, 1);
    const ing = await run(['ingest', '--project', dir, '--job', jobId, '--unit', 'sc1_sh1_clip', '--file', mp4], T);
    assert.equal(ing.code, 0, ing.out);
    const p = await host.readState();
    const a = p.assets.find((x) => x.id === 'sc1_sh1_clip')!;
    assert.equal(a.status, 'pending-review');
    assert.ok(a.file && existsSync(join(dir, ...a.file.uri.split('/'))));
    assert.deepEqual(checkIntegrity(p), []);

    await host.writeState(approve(p, [a.id], 'motion').project);
    assert.match((await run(['sync', '--project', dir], T)).out, /Nothing to repair/);
    assert.match((await run(['step', '--project', dir, '--provider', 'manual'], T)).out, /sc1_sh2_clip/);
  });

  it('a paid provider with no key is a setup error before the gate (nothing sent or counted); with a key but no budget it is refused with the setup pointer', async () => {
    const { dir, host } = await folder();
    await run(['plan', '--project', dir], T);
    const keep = process.env.FAL_KEY;
    try {
      delete process.env.FAL_KEY;
      const noKey = await run(['step', '--project', dir, '--provider', 'fal-video'], T);
      assert.equal(noKey.code, 1);
      assert.match(noKey.out, /Setup needed: FAL_KEY is not set/);
      assert.equal((await host.readState()).ledger.length, 0);
      assert.equal((await host.readState()).pending_spend.length, 0);
      process.env.FAL_KEY = 'dummy-not-a-secret';
      const r = await run(['step', '--project', dir, '--provider', 'fal-video'], T);
      assert.equal(r.code, 1);
      assert.match(r.out, /Run `\/akuko setup`/);
    } finally {
      if (keep === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = keep;
    }
  });

  it('--fit must be cover or nearest', async () => {
    const { dir } = await folder();
    assert.equal((await run(['step', '--project', dir, '--provider', 'manual', '--fit', 'longest'], T)).code, 2);
  });

  it('plan reports a shot at the retry limit; step refuses it; --max-attempts must be a whole number', async () => {
    const { dir, host } = await folder((p) => {
      p.budget = { cap: 10, currency: 'USD', spent: 0 };
    });
    await run(['plan', '--project', dir], T);
    const p = await host.readState();
    p.ledger = [1, 2, 3].map((n) => ({ id: `l${n}`, ts: '2026-11-09T09:00:00Z', provider: 'fal-video', unit: 'sc1_sh1_clip', estimate: 0.35, actual: 0.35, status: 'failed' as const, job: `j${n}` }));
    await host.writeState(p);
    assert.match((await run(['plan', '--project', dir], T)).out, /sc1_sh1_clip is at the retry limit \(3 paid attempts, 1\.05 spent\)/);
    assert.match((await run(['status', '--project', dir], T)).out, /3 paid attempts, 1\.05 spent/);
    const keep = process.env.FAL_KEY;
    process.env.FAL_KEY = 'dummy-not-a-secret';
    try {
      const r = await run(['step', '--project', dir, '--provider', 'fal-video', '--units', 'sc1_sh1_clip'], T);
      assert.equal(r.code, 1);
      assert.match(r.out, /3 paid attempts.*--max-attempts 4/);
      assert.equal((await run(['step', '--project', dir, '--provider', 'fal-video', '--max-attempts', 'abc'], T)).code, 2);
    } finally {
      if (keep === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = keep;
    }
  });

  it('needs --project and a known command', async () => {
    assert.equal((await run(['plan'], T)).code, 2);
    const { dir } = await folder();
    assert.equal((await run(['frobnicate', '--project', dir], T)).code, 2);
  });
});
