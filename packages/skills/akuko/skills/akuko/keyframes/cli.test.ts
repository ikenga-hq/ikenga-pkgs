// WP-22 — the key-frame command line over a real project folder (manual provider: free, no network).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { PNG_BYTES } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { run } from './cli.ts';
import { approve, bibleApproved } from './__fixtures__/project.ts';

const T = () => new Date('2026-11-08T10:00:00Z');

async function folder(mutate: (p: ReturnType<typeof bibleApproved>) => void = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-kf-'));
  const p = bibleApproved();
  mutate(p);
  await writeFile(join(dir, 'akuko.json'), serializeProject(p));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

describe('keyframes cli', () => {
  it('refuses a project whose bible is not approved', async () => {
    const { dir } = await folder((p) => { p.stages.bible = { state: 'in-review' }; });
    const r = await run(['plan', '--project', dir], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /locked: bible/);
  });

  it('plan, step (manual), ingest, fold: one key frame end to end on disk', async () => {
    const { dir, host } = await folder();
    assert.match((await run(['plan', '--project', dir], T)).out, /Planned \d+ key frames/);
    assert.match((await run(['plan', '--project', dir], T)).out, /already planned/);
    assert.match((await run(['status', '--project', dir], T)).out, /sc1_sh1_keyframe: pending \(ready\)/);

    const step = await run(['step', '--project', dir, '--provider', 'manual'], T);
    assert.equal(step.code, 0);
    assert.match(step.out, /sc1_sh1_keyframe/);
    const jobId = /Job (job_kf_\S+?)\./.exec(step.out)![1]!;
    assert.ok(existsSync(join(dir, 'keyframes', 'jobs', `${jobId}.json`)));

    const png = join(dir, 'made.png');
    await writeFile(png, PNG_BYTES);
    const ing = await run(['ingest', '--project', dir, '--job', jobId, '--unit', 'sc1_sh1_keyframe', '--file', png], T);
    assert.equal(ing.code, 0, ing.out);
    const p = await host.readState();
    const a = p.assets.find((x) => x.id === 'sc1_sh1_keyframe')!;
    assert.equal(a.status, 'pending-review');
    assert.ok(a.file && existsSync(join(dir, ...a.file.uri.split('/'))));
    assert.deepEqual(checkIntegrity(p), []);

    await host.writeState(approve(p, [a.id], 'keyframes').project);
    assert.match((await run(['sync', '--project', dir], T)).out, /Nothing to repair/);
    // the next shot is now the next job
    assert.match((await run(['step', '--project', dir, '--provider', 'manual'], T)).out, /sc1_sh2_keyframe/);
  });

  it('a paid provider with no budget is refused with the setup pointer', async () => {
    const { dir } = await folder();
    await run(['plan', '--project', dir], T);
    const r = await run(['step', '--project', dir, '--provider', 'gemini-image'], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /Run `\/akuko setup`/);
  });

  it('needs --project and a known command', async () => {
    assert.equal((await run(['plan'], T)).code, 2);
    const { dir } = await folder();
    assert.equal((await run(['frobnicate', '--project', dir], T)).code, 2);
  });
});
