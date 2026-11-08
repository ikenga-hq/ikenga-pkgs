// WP-05 — the bible command line over a real project folder (manual provider: free, no network).

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
import { approve, breakdownApproved } from './__fixtures__/project.ts';

const T = () => new Date('2026-11-08T10:00:00Z');

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-bible-'));
  await writeFile(join(dir, 'akuko.json'), serializeProject(breakdownApproved()));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

describe('bible cli', () => {
  it('refuses a project that is not open yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-bible-'));
    const p = breakdownApproved();
    p.stages.sketch = { state: 'in-review' };
    await writeFile(join(dir, 'akuko.json'), serializeProject(p));
    const r = await run(['plan', '--project', dir], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /locked: sketch/);
  });

  it('plan, step (manual), ingest, fold, sync: one wave end to end on disk', async () => {
    const { dir, host } = await folder();
    assert.match((await run(['plan', '--project', dir], T)).out, /Planned 9 images/);
    assert.match((await run(['plan', '--project', dir], T)).out, /already planned/);
    const status = (await run(['status', '--project', dir], T)).out;
    assert.match(status, /style_fog-and-lamplight_lookbook: pending \(ready\)/);
    assert.match(status, /char_mara_turnaround: pending \(blocked, waiting for char_mara_portrait/);

    const step = await run(['step', '--project', dir, '--provider', 'manual'], T);
    assert.equal(step.code, 0);
    assert.match(step.out, /style_fog-and-lamplight_lookbook/);
    const jobId = /Job (job_bible_\S+?)\./.exec(step.out)![1]!;
    assert.ok(existsSync(join(dir, 'bible', 'jobs', `${jobId}.json`)));

    const png = join(dir, 'made.png');
    await writeFile(png, PNG_BYTES);
    const ing = await run(['ingest', '--project', dir, '--job', jobId, '--unit', 'style_fog-and-lamplight_lookbook', '--file', png], T);
    assert.equal(ing.code, 0, ing.out);
    let p = await host.readState();
    const lb = p.assets.find((a) => a.id === 'style_fog-and-lamplight_lookbook')!;
    assert.equal(lb.status, 'pending-review');
    assert.ok(lb.file && existsSync(join(dir, ...lb.file.uri.split('/'))));
    assert.deepEqual(checkIntegrity(p), []);

    // the person approves through a conformed view; folding is what writes `approved`
    await host.writeState(approve(p, [lb.id], 'bible').project);
    assert.match((await run(['sync', '--project', dir], T)).out, /style_fog-and-lamplight/);
    p = await host.readState();
    assert.deepEqual(p.bible.styles[0]!.refs, ['style_fog-and-lamplight_lookbook']);

    // the next wave is now open
    const next = await run(['step', '--project', dir, '--provider', 'manual'], T);
    assert.match(next.out, /char_mara_portrait/);
    assert.doesNotMatch(next.out, /char_mara_turnaround/);
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
