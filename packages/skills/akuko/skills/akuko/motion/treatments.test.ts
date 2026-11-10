// WP-27: shot treatments, camera moves, negatives, removed rows. Synthetic project only; no network, nothing paid.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { AkukoProjectSchema, type AkukoProject, type Shot } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { checkJob } from '../rules/check.ts';
import { bibleApproved } from '../keyframes/__fixtures__/project.ts';
import { assertOpen as kfAssertOpen, buildKeyframeJob, keyframeStatus, planKeyframes } from '../keyframes/plan.ts';
import { buildMotionJob, clipAssets, motionStatus, planMotion, refreshStageState } from './plan.ts';
import { applyMoves, parseMotionNote, planMoves } from './moves.ts';
import { DEFAULT_TREATMENT, isHeroCandidate, isLipsyncCandidate, treatmentOf, wantsClip } from './treatment.ts';
import { run } from './cli.ts';
import { keyframesApproved } from './__fixtures__/project.ts';

const T = () => new Date('2026-11-10T10:00:00Z');
const NOW = '2026-11-10T10:00:00Z';

/** A synthetic 3-tier project: every shot's treatment is set by tier, explicitly, or not at all. */
function tiered(): AkukoProject {
  const p = keyframesApproved();
  const by = (id: string): Shot => p.shots.find((s) => s.id === id)!;
  by('sc1_sh1').tier = 'A'; // default still-move
  by('sc1_sh2').tier = 'A';
  by('sc1_sh2').treatment = 'video'; // the person chose video
  by('sc1_sh3').tier = 'B'; // still-move
  by('sc1_sh4').tier = 'C'; // still
  by('sc2_sh1').treatment = 'still-move'; // no tier, explicit
  by('sc2_sh2').tier = 'A';
  by('sc2_sh2').treatment = 'lipsync';
  // sc2_sh3, sc2_sh4: no tier, no treatment: today's behaviour
  by('sc3_sh1').source = { kind: 'sheet', id: 'X03', removed_at: '2026-11-09T09:00:00Z' };
  return AkukoProjectSchema.parse(p);
}

const clipsOf = (p: AkukoProject): string[] => clipAssets(p).map((a) => a.owner!).sort();

describe('treatment table', () => {
  it('pins the default per tier, and no default without a tier', () => {
    assert.deepEqual(DEFAULT_TREATMENT, { A: 'still-move', B: 'still-move', C: 'still' });
    assert.equal(treatmentOf({ tier: 'A' }), 'still-move');
    assert.equal(treatmentOf({ tier: 'B' }), 'still-move');
    assert.equal(treatmentOf({ tier: 'C' }), 'still');
    assert.equal(treatmentOf({}), undefined);
    assert.equal(treatmentOf({ tier: 'C', treatment: 'video' }), 'video');
  });

  it('only video and the no-tier legacy case want a paid clip', () => {
    assert.equal(wantsClip({ tier: 'A' }), false);
    assert.equal(wantsClip({ tier: 'C', treatment: 'video' }), true);
    assert.equal(wantsClip({ treatment: 'lipsync' }), false);
    assert.equal(wantsClip({}), true);
  });

  it('flags hero and lip-sync candidates without choosing for the person', () => {
    assert.equal(isHeroCandidate({ tier: 'A' }), true);
    assert.equal(isHeroCandidate({ tier: 'B' }), false);
    assert.equal(isLipsyncCandidate({ tier: 'A', lines: [{ id: 'L1', kind: 'spoken' }] }), true);
    assert.equal(isLipsyncCandidate({ tier: 'A', lines: [{ id: 'L1', kind: 'thought' }] }), false);
    assert.equal(isLipsyncCandidate({ tier: 'B', lines: [{ id: 'L1', kind: 'spoken' }] }), false);
    assert.equal(treatmentOf({ tier: 'A', lines: [{ id: 'L1', kind: 'spoken' }] } as Shot), 'still-move', 'flagged only: the treatment stays free');
  });
});

describe('planMotion by treatment', () => {
  it('plans a clip only for video shots and shots with no tier and no treatment, skipping removed shots', () => {
    const r = planMotion(tiered(), NOW);
    assert.deepEqual(clipsOf(r.project), ['sc1_sh2', 'sc2_sh3', 'sc2_sh4', 'sc3_sh2', 'sc3_sh3']);
    assert.deepEqual(checkIntegrity(r.project), []);
    assert.equal(planMotion(r.project, NOW).created.length, 0, 'idempotent');
  });

  it("a project with no tiers keeps today's behaviour: a clip per shot", () => {
    const r = planMotion(keyframesApproved(), NOW);
    assert.equal(r.created.length, 11);
  });

  it('stage readiness ignores shots that have no clip unit', () => {
    let p = planMotion(tiered(), NOW).project;
    for (const a of clipAssets(p)) {
      a.status = 'approved';
      a.file = { uri: `mem://${a.id}.mp4`, mime: 'video/mp4', hash: `h-${a.id}` };
    }
    p = refreshStageState(p);
    assert.equal(p.stages.motion.state, 'in-review', 'every clip that can exist is approved: the still shots have no unit to wait on');
    assert.equal(motionStatus(p).length, 5);
  });

  it('a clip of a removed shot is left out of status and jobs but kept in the project', () => {
    let p = planMotion(keyframesApproved(), NOW).project;
    p.shots.find((s) => s.id === 'sc1_sh1')!.source = { kind: 'sheet', id: 'X01', removed_at: '2026-11-09T09:00:00Z' };
    p = AkukoProjectSchema.parse(p);
    assert.ok(p.assets.some((a) => a.id === 'sc1_sh1_clip'));
    assert.ok(!motionStatus(p).some((r) => r.asset === 'sc1_sh1_clip'));
    const job = buildMotionJob(p, { provider: 'manual' });
    assert.equal(job.units[0], 'sc1_sh2_clip', 'the next ready clip is the next live shot');
  });
});

describe('negatives', () => {
  it('motion items carry shot.negative when set, and omit it when not', () => {
    const p0 = planMotion(keyframesApproved(), NOW).project;
    p0.shots.find((s) => s.id === 'sc1_sh1')!.negative = 'text, logos';
    const a = buildMotionJob(p0, { provider: 'manual', units: ['sc1_sh1_clip'] });
    assert.equal(a.job.items[0]!.negative, 'text, logos');
    const b = buildMotionJob(p0, { provider: 'manual', units: ['sc1_sh2_clip'] });
    assert.equal('negative' in b.job.items[0]!, false);
  });

  it('keyframe items carry shot.negative, so a require rule on the negative prompt passes', async () => {
    let p = planKeyframes(bibleApproved(), NOW).project;
    p.shots.find((s) => s.id === 'sc1_sh1')!.negative = 'text, logos, no masks';
    p.rules = { require: [{ text: 'no masks', applies_to: 'negative' }] } as AkukoProject['rules'];
    p = AkukoProjectSchema.parse(p);
    const built = buildKeyframeJob(p, { provider: 'manual', units: ['sc1_sh1_keyframe'] } as never);
    assert.equal(built.job.items[0]!.negative, 'text, logos, no masks');
    assert.deepEqual((await checkJob(p, built.job)).breaches, []);
    // a shot whose negative lacks the text is refused for it: the rule working, not a missing field
    p.shots.find((s) => s.id === 'sc1_sh2')!.negative = 'text';
    const bad = buildKeyframeJob(p, { provider: 'manual', units: ['sc1_sh2_keyframe'] } as never);
    assert.deepEqual((await checkJob(p, bad.job)).breaches.map((b) => b.rule), ['require']);
  });
});

describe('keyframes skip removed rows', () => {
  it('does not plan, list or wait for a removed shot, and a pending removed shot does not lock the stage', () => {
    const base = bibleApproved();
    const gone = base.shots.find((s) => s.id === 'sc1_sh1')!;
    gone.source = { kind: 'sheet', id: 'X01', removed_at: '2026-11-09T09:00:00Z' };
    gone.status = 'pending-review';
    const p = AkukoProjectSchema.parse(base);
    assert.doesNotThrow(() => kfAssertOpen(p));
    const r = planKeyframes(p, NOW);
    assert.ok(!r.created.includes('sc1_sh1_keyframe'));
    assert.equal(r.created.length, 10);
    assert.ok(!keyframeStatus(r.project).some((x) => x.shot === 'sc1_sh1'));
  });
});

describe('moves', () => {
  it('parses the notes with gentle documented defaults', () => {
    assert.deepEqual(parseMotionNote('Slow push-in; falling snow particles').move, { from_scale: 1, to_scale: 1.08, x: 0, y: 0, ease: 'ease-in-out' });
    assert.deepEqual(parseMotionNote('Slow pull-back').move, { from_scale: 1.08, to_scale: 1, x: 0, y: 0, ease: 'ease-in-out' });
    assert.deepEqual(parseMotionNote('Lateral drift').move, { from_scale: 1.06, to_scale: 1.06, x: 40, y: 0, ease: 'ease-in-out' });
    assert.equal(parseMotionNote('Lateral drift left').move?.x, -40);
    assert.equal(parseMotionNote('Hold').move, undefined);
    assert.equal(parseMotionNote('Hold').warning, undefined);
    assert.equal(parseMotionNote('').kind, 'hold');
    const odd = parseMotionNote('Crash zoom through the window');
    assert.equal(odd.move, undefined);
    assert.match(odd.warning ?? '', /no move recorded/);
    assert.match(parseMotionNote('Whip pan to the door').warning ?? '', /slow moves only/);
    assert.match(parseMotionNote('Wobble').warning ?? '', /not a camera move/);
  });

  it('every parsed move is valid for the schema and never shows the frame edge', () => {
    const p = tiered();
    for (const note of ['Slow push-in', 'Slow pull-back', 'Lateral drift', 'Lateral drift left']) {
      const m = parseMotionNote(note).move!;
      p.shots[0]!.move = m;
      AkukoProjectSchema.parse(p);
      assert.ok(Math.min(m.from_scale, m.to_scale) >= 1);
      assert.ok(m.x === 0 || Math.abs(m.x) <= ((Math.min(m.from_scale, m.to_scale) - 1) * 1920) / 2);
    }
  });

  it('planMoves lists, and applyMoves only fills shots with no move yet', () => {
    const p = tiered();
    p.shots.find((s) => s.id === 'sc1_sh1')!.motion_note = 'Slow push-in';
    p.shots.find((s) => s.id === 'sc1_sh3')!.motion_note = 'Lateral drift';
    p.shots.find((s) => s.id === 'sc1_sh3')!.move = { from_scale: 1.2, to_scale: 1.3, x: 0, y: 0 };
    const rows = planMoves(p.shots.filter((s) => ['sc1_sh1', 'sc1_sh3'].includes(s.id)));
    assert.equal(rows[1]!.has_move, true);
    const { applied } = applyMoves(rows, p);
    assert.deepEqual(applied, ['sc1_sh1']);
    assert.equal(p.shots.find((s) => s.id === 'sc1_sh3')!.move!.from_scale, 1.2, 'a recorded move is never replaced');
  });
});

async function folder(p: AkukoProject) {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-wp27-'));
  await writeFile(join(dir, 'akuko.json'), serializeProject(p));
  return { dir, host: createLocalHost({ projectDir: dir, now: T }) };
}

describe('motion cli: treat and moves', () => {
  it('treat records the treatment, free, and validates', async () => {
    const { dir, host } = await folder(tiered());
    assert.equal((await run(['treat', '--project', dir, '--shot', 'sc1_sh4', '--as', 'fast'], T)).code, 2);
    assert.equal((await run(['treat', '--project', dir, '--as', 'video'], T)).code, 2);
    assert.equal((await run(['treat', '--project', dir, '--shot', 'nope', '--as', 'video'], T)).code, 1);
    assert.match((await run(['treat', '--project', dir, '--shot', 'sc3_sh1', '--as', 'video'], T)).out, /removed from the shot list/);
    const r = await run(['treat', '--project', dir, '--shot', 'sc1_sh3,sc1_sh4', '--as', 'video'], T);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Set sc1_sh3, sc1_sh4 to "video"/);
    const p = await host.readState();
    assert.equal(p.shots.find((s) => s.id === 'sc1_sh4')!.treatment, 'video');
    assert.equal(p.ledger.length, 0, 'nothing paid');
    assert.match((await run(['treat', '--project', dir, '--shot', 'sc1_sh4', '--as', 'video'], T)).out, /Already "video"/);
    assert.ok((await run(['plan', '--project', dir], T)).out.includes('sc1_sh4_clip'), 'plan now makes their clips');
  });

  it('lipsync on a shot with no spoken line warns', async () => {
    const { dir } = await folder(tiered());
    assert.match((await run(['treat', '--project', dir, '--shot', 'sc1_sh1', '--as', 'lipsync'], T)).out, /no spoken line/);
  });

  it('moves lists without writing, and --apply writes only onto shots with no move', async () => {
    const p = tiered();
    p.shots.find((s) => s.id === 'sc1_sh1')!.motion_note = 'Slow push-in; falling dust';
    p.shots.find((s) => s.id === 'sc1_sh3')!.motion_note = 'Whip pan';
    p.shots.find((s) => s.id === 'sc1_sh4')!.motion_note = 'Slow push-in'; // tier C = still: not listed
    const { dir, host } = await folder(p);
    const list = await run(['moves', '--project', dir], T);
    assert.match(list.out, /sc1_sh1: "Slow push-in; falling dust" -> push-in: scale 1 -> 1.08/);
    assert.match(list.out, /sc1_sh3: .* WARNING/);
    assert.ok(!list.out.includes('sc1_sh4'));
    assert.ok(!list.out.includes('sc3_sh1'), 'a removed shot is not listed');
    assert.match(list.out, /Nothing written/);
    assert.equal((await host.readState()).shots.find((s) => s.id === 'sc1_sh1')!.move, undefined);
    const applied = await run(['moves', '--project', dir, '--apply'], T);
    assert.match(applied.out, /Recorded moves on 1 shot/);
    const after = await host.readState();
    assert.equal(after.shots.find((s) => s.id === 'sc1_sh1')!.move!.to_scale, 1.08);
    assert.equal(after.shots.find((s) => s.id === 'sc1_sh3')!.move, undefined);
    assert.deepEqual(checkIntegrity(after), []);
    assert.match((await run(['moves', '--project', dir, '--apply'], T)).out, /No move was written/);
  });
});
