// WP-27 review fixes: idle clips never cost money, imported shots default to still, keep-and-mark, candidate flags, move parsing.
// Synthetic project only; no network, nothing paid.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { AkukoProjectSchema, type AkukoProject, type Shot } from '../schema/akuko-project.ts';
import { bibleApproved } from '../keyframes/__fixtures__/project.ts';
import { buildKeyframeJob, planKeyframes } from '../keyframes/plan.ts';
import { buildMotionJob, motionStatus, planMotion, refreshStageState } from './plan.ts';
import { parseMotionNote, planMoves } from './moves.ts';
import { treatShots } from './treat.ts';
import { candidateFlags, treatmentOf, wantsClip } from './treatment.ts';
import { run } from './cli.ts';
import { keyframesApproved } from './__fixtures__/project.ts';

const T = () => new Date('2026-11-10T10:00:00Z');
const NOW = '2026-11-10T10:00:00Z';

async function folder(p: AkukoProject) {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-wp27r-'));
  await writeFile(join(dir, 'akuko.json'), serializeProject(p));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

/** Planned before tiers existed (a clip per shot), then a re-import fills every tier with B. */
function idleProject(): AkukoProject {
  const p = planMotion(keyframesApproved(), NOW).project;
  for (const s of p.shots) s.tier = 'B';
  return AkukoProjectSchema.parse(p);
}

describe('idle clips never cost money', () => {
  it('P1: planned before tiers, now all tier B, there is no paid candidate', () => {
    const p = idleProject();
    assert.throws(() => buildMotionJob(p, { provider: 'manual' }), /Nothing is waiting to be made/);
    assert.throws(() => buildMotionJob(p, { provider: 'manual', scene: 'sc1' }), /Nothing is waiting to be made/);
    assert.equal(refreshStageState(p).stages.motion.state, p.stages.motion.state, 'idle clips do not move the stage');
    assert.ok(motionStatus(p).every((r) => r.idle !== undefined));
  });

  it('an explicit --units on a non-video shot is refused before anything is priced', () => {
    assert.throws(() => buildMotionJob(idleProject(), { provider: 'manual', units: ['sc1_sh1_clip'] }), /sc1_sh1: the shot is `still-move`; treat it `video` first/);
  });

  it('P2: a needs-rework, already paid clip whose shot was treated still-move is never picked', () => {
    let p = planMotion(keyframesApproved(), NOW).project;
    p.assets.find((a) => a.id === 'sc1_sh1_clip')!.status = 'needs-rework';
    p.ledger.push({ id: 'l1', ts: NOW, unit: 'sc1_sh1_clip', job: 'j', provider: 'fal-video', status: 'done', estimate: 0.35, actual: 0.35 } as never);
    p = AkukoProjectSchema.parse(p);
    const r = treatShots(p, ['sc1_sh1'], 'still-move');
    assert.match(r.warnings.join(' '), /sc1_sh1_clip/);
    const j = buildMotionJob(r.project, { provider: 'manual' });
    assert.ok(!j.units.includes('sc1_sh1_clip'));
  });

  it('--scene batches only the video shots of the scene, across tiers', () => {
    const p = keyframesApproved();
    const by = (id: string): Shot => p.shots.find((s) => s.id === id)!;
    by('sc1_sh1').tier = 'A';
    by('sc1_sh2').treatment = 'video';
    by('sc1_sh3').tier = 'B';
    by('sc1_sh4').tier = 'C';
    by('sc1_sh4').treatment = 'video';
    const planned = planMotion(AkukoProjectSchema.parse(p), NOW).project;
    assert.deepEqual(buildMotionJob(planned, { provider: 'manual', scene: 'sc1' }).units, ['sc1_sh2_clip', 'sc1_sh4_clip']);
  });
});

describe('keep and mark, never delete', () => {
  it('P3: treat keeps a pending clip with an awaiting-approval spend and a person comment, intact', () => {
    const p = planMotion(keyframesApproved(), NOW).project;
    const c = p.assets.find((a) => a.id === 'sc1_sh1_clip')!;
    c.comments.push({ ts: NOW, stage: 'motion', author: 'you', text: 'make it slower' } as never);
    p.pending_spend.push({ id: 'job_mo_x_r1', stage: 'motion', provider: 'fal-video', units: ['sc1_sh1_clip'], estimate: { amount: 0.35, currency: 'USD' }, status: 'awaiting-approval', created_at: NOW } as never);
    const before = structuredClone(p.pending_spend);
    const r = treatShots(p, ['sc1_sh1'], 'still');
    const kept = r.project.assets.find((a) => a.id === 'sc1_sh1_clip')!;
    assert.ok(kept, 'the clip is not deleted');
    assert.deepEqual(kept.comments, c.comments);
    assert.deepEqual(r.project.pending_spend, before);
    assert.match(r.warnings.join(' '), /kept, idle while the shot is still/);
  });

  it('on disk: every clip is kept and marked idle, and back to video plan reuses it', async () => {
    const p = planMotion(keyframesApproved(), NOW).project;
    const done = p.assets.find((a) => a.id === 'sc1_sh3_clip')!;
    done.status = 'approved';
    done.file = { uri: 'mem://c.mp4', mime: 'video/mp4', hash: 'h' };
    const { dir, host } = await folder(AkukoProjectSchema.parse(p));
    const r = await run(['treat', '--project', dir, '--shot', 'sc1_sh3,sc1_sh4', '--as', 'still-move'], T);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /sc1_sh3: its clip sc1_sh3_clip \(approved, has a file\) is kept/);
    assert.match(r.out, /sc1_sh4: planned clip sc1_sh4_clip kept, idle while the shot is still-move/);
    assert.ok(!/Dropped/.test(r.out));
    const after = await host.readState();
    for (const id of ['sc1_sh3_clip', 'sc1_sh4_clip']) assert.ok(after.assets.some((a) => a.id === id), id);
    assert.match((await run(['status', '--project', dir], T)).out, /sc1_sh4_clip: pending \(kept, not a video shot/);
    await run(['treat', '--project', dir, '--shot', 'sc1_sh4', '--as', 'video'], T);
    assert.match((await run(['plan', '--project', dir], T)).out, /Everything is already planned/);
    assert.equal(buildMotionJob(await host.readState(), { provider: 'manual', units: ['sc1_sh4_clip'] }).units[0], 'sc1_sh4_clip');
  });
});

describe('imported shots with no tier', () => {
  it('are still, never a paid clip; a hand-made shot keeps the old behaviour; an explicit treatment wins', () => {
    const p = keyframesApproved();
    const s = p.shots.find((x) => x.id === 'sc1_sh1')!;
    s.source = { kind: 'sheet', id: 'X01' };
    assert.equal(treatmentOf(s), 'still');
    assert.equal(wantsClip(s), false);
    assert.equal(treatmentOf(p.shots.find((x) => x.id === 'sc1_sh2')!), undefined);
    assert.ok(!planMotion(AkukoProjectSchema.parse(p), NOW).created.includes('sc1_sh1_clip'));
    s.treatment = 'video';
    assert.equal(wantsClip(s), true);
  });

  it('plan warns about them, and says when no shot is a video shot', async () => {
    const p = keyframesApproved();
    for (const s of p.shots) s.source = { kind: 'sheet', id: `X${s.id.replace(/\D/g, '')}` };
    p.shots.find((s) => s.id === 'sc1_sh1')!.tier = 'A';
    const { dir } = await folder(AkukoProjectSchema.parse(p));
    const r = await run(['plan', '--project', dir], T);
    assert.match(r.out, /No shot is a video shot; nothing to plan/);
    assert.match(r.out, /WARNING: 10 imported shots have no tier and are treated as still/);
  });
});

describe('candidate flags', () => {
  it('plan and status print them and decide nothing', async () => {
    const p = keyframesApproved();
    const s = p.shots.find((x) => x.id === 'sc1_sh1')!;
    s.tier = 'A';
    s.lines = [{ id: 'L1', kind: 'spoken' }];
    p.shots.find((x) => x.id === 'sc1_sh2')!.tier = 'A';
    const { dir, host } = await folder(p);
    const plan = await run(['plan', '--project', dir], T);
    assert.match(plan.out, /sc1_sh1: tier A, spoken line, a lip-sync candidate; the person decides/);
    assert.match(plan.out, /sc1_sh2: tier A, a hero candidate; the person decides/);
    assert.match((await run(['status', '--project', dir], T)).out, /sc1_sh1: tier A, spoken line, a lip-sync candidate/);
    assert.equal((await host.readState()).shots.find((x) => x.id === 'sc1_sh1')!.treatment, undefined);
    assert.deepEqual(candidateFlags({ shots: [{ id: 'a', tier: 'A', treatment: 'video' }] } as never), [], 'a chosen shot is not flagged again');
  });
});

describe('keyframes --scene', () => {
  it('leaves out a removed shot', () => {
    const base = bibleApproved();
    base.shots.find((s) => s.id === 'sc1_sh1')!.source = { kind: 'sheet', id: 'X01', removed_at: '2026-11-09T09:00:00Z' };
    const p = planKeyframes(AkukoProjectSchema.parse(base), NOW).project;
    const built = buildKeyframeJob(p, { provider: 'manual', scene: 'sc1' } as never);
    assert.ok(!built.units.includes('sc1_sh1_keyframe'));
    assert.ok(built.units.includes('sc1_sh2_keyframe'));
  });
});

describe('move parsing nits', () => {
  it('focus pulls and push-outs, vertical drifts, blank notes', () => {
    assert.equal(parseMotionNote('Pull focus to the door').move, undefined);
    assert.match(parseMotionNote('Pull focus to the door').warning ?? '', /not a camera move/);
    assert.equal(parseMotionNote('Rack focus').move, undefined);
    assert.equal(parseMotionNote('Slow push out').kind, 'pull-back');
    assert.equal(parseMotionNote('Slow pull in').kind, 'push-in');
    assert.equal(parseMotionNote('Slow push in').kind, 'push-in');
    assert.equal(parseMotionNote('Slow pull-back').kind, 'pull-back');
    assert.equal(parseMotionNote('Drift up').move?.y, -30);
    assert.equal(parseMotionNote('Drift down').move?.y, 30);
    const m = parseMotionNote('Drift up').move!;
    assert.ok(Math.abs(m.y) <= ((m.from_scale - 1) * 1080) / 2, 'a vertical drift never shows the frame edge');
    assert.match(planMoves([{ id: 'S02-030', motion_note: '   ' } as Shot])[0]!.warning ?? '', /no motion note/);
    assert.equal(planMoves([{ id: 'S02-040', motion_note: 'Hold' } as Shot])[0]!.warning, undefined);
  });
});
