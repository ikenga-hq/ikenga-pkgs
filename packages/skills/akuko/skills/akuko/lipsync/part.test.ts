// WP-32: a part-scoped lip-sync run (--part) on the synthetic WP-28b project, through the command line: it plans,
// cuts, prices and makes only that part's shots, before the other part's key frames are approved. Invented data.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AkukoProject } from '../schema/akuko-project.ts';
import { run as motionCli } from '../motion/cli.ts';
import { run } from './cli.ts';
import { T0, lipsyncFolder, readProject } from './__fixtures__/project.ts';

const T = (): Date => new Date(T0);

/** P2 (S02-…) has every key frame approved; P3's S03-010 key frame is waiting, so the key-frame stage is in review and motion is locked. */
const pilotAhead = (p: AkukoProject): void => {
  p.stages.keyframes = { state: 'in-review' };
  p.stages.motion = { state: 'locked' };
  p.current_stage = 'keyframes';
  p.assets.find((a) => a.id === 'S03-010_keyframe')!.status = 'pending-review';
};

describe('lip-sync, one part ahead of the film (--part)', () => {
  it('without --part the step is refused as before; P3 is refused naming its key frame', async () => {
    const { dir } = await lipsyncFolder({ mutate: pilotAhead });
    assert.match((await run(['plan', '--project', dir], T)).out, /motion stage is locked: keyframes is "in-review"/);
    const r = await run(['plan', '--project', dir, '--part', 'P3'], T);
    assert.equal(r.code, 1);
    assert.match(r.out, /^P3 is not open for motion: 1 key frame not approved \(S03-010\)\./);
    assert.equal((await run(['plan', '--project', dir, '--part'], T)).code, 2);
  });

  it('plans and cuts only P2, leaves the stage locked, and a P2 step makes only P2, recording its span', async () => {
    const { dir } = await lipsyncFolder({ mutate: pilotAhead });
    const r = await run(['plan', '--project', dir, '--part', 'P2'], T);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^P2: open for motion .*The motion stage itself stays locked until the whole film opens/);
    assert.match(r.out, /Planned 2 lip-syncs: S02-010_lipsync, S02-020_lipsync\./);
    let p = await readProject(dir);
    assert.ok(!p.assets.some((a) => a.id === 'S03-010_lipsync' || a.id === 'S03-010_linecut'), 'nothing planned or cut for P3');
    assert.ok(p.assets.some((a) => a.id === 'S02-010_linecut'));
    assert.ok(!existsSync(join(dir, 'lipsync', 'cuts', 'S03-010_linecut.wav')));
    assert.equal(p.stages.motion.state, 'locked');

    const status = (await run(['status', '--project', dir, '--part', 'P2'], T)).out;
    assert.ok(!/S03-010/.test(status), status);

    assert.match((await run(['step', '--project', dir, '--provider', 'manual', '--part', 'P2', '--shot', 'S03-010'], T)).out, /S03-010/);
    const step = await run(['step', '--project', dir, '--provider', 'manual', '--part', 'P2', '--shot', 'S02-010'], T);
    assert.equal(step.code, 0, step.out);
    p = await readProject(dir);
    const lip = p.assets.find((a) => a.id === 'S02-010_lipsync')!;
    assert.equal(lip.status, 'draft');
    // L01 runs 1.0 to 2.5 s: the cut (and so the video) is 0.8 to 2.8 s on the master, recorded for the handoff.
    assert.deepEqual(lip.film, { in_s: 0.8, out_s: 2.8 });
    assert.equal(p.stages.motion.state, 'locked', 'making P2 work never unlocks the stage');

    const parts = (await motionCli(['parts', '--project', dir], T)).out;
    assert.match(parts, /^The motion stage is locked project-wide/);
    assert.match(parts, /P2: open for motion \(4 live shots; 3 motion units planned, 0 approved\)/);
    assert.match(parts, /P3 is not open for motion: 1 key frame not approved \(S03-010\)/);
  });
});
