// WP-32: pilot one part (P7) through motion and lip-sync before the whole film's key frames are approved; one
// motion-stage roll-up shared by both steps; idle clips (old WP-31) and an empty motion stage.
// Synthetic project only: every id, time and name is invented.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AkukoProjectSchema, DecisionSchema, type AkukoProject, type Decision } from '../schema/akuko-project.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { assertOpen, buildMotionJob, motionStatus, planMotion, recordClipFilm, refreshMotionStage as fromMotion } from './plan.ts';
import { planLipsync, refreshMotionStage as fromLipsync, lipsyncTargets } from '../lipsync/plan.ts';
import { isIdleMotionUnit, motionRollup, partOpenness, partRefusal, refreshMotionStage } from './stage.ts';
import { treatShots } from './treat.ts';

const NOW = '2026-11-10T12:00:00Z';
const approved = { state: 'approved' } as const;
const file = (id: string, ext = 'png') => ({ uri: `board/${id}.${ext}`, mime: ext === 'png' ? 'image/png' : 'video/mp4', hash: `h-${id}` });

const shot = (id: string, scene: string, part: string, in_s: number, out_s: number, extra: Record<string, unknown> = {}) => ({
  id, stage: 'sketch', status: 'approved', scene, part, refs: ['ADA', 'LOC-DOCK'], prompt: `Invented shot ${id}.`,
  film: { in_s, out_s }, duration_s: out_s - in_s, source: { kind: 'sheet', id }, tier: 'B', ...extra,
});

/**
 * Two parts on a 60 s master. P7 (scene S07) has every key frame approved; P8 (scene S08) is still waiting.
 *   S07-010 video          S07-020 lipsync, a spoken line     S07-030 still-move     S07-040 video
 *   S08-010 video (key frame waiting)                          S08-020 still (key frame waiting)
 */
function pilot(): AkukoProject {
  const kf = (s: string, ok: boolean) => ({ id: `${s}_keyframe`, kind: 'keyframe', stage: 'keyframes', status: ok ? 'approved' : 'pending-review', owner: s, tags: ['keyframe'], comments: [], file: file(`${s}_keyframe`) });
  return AkukoProjectSchema.parse({
    format: 'akuko',
    schema_version: 1,
    project: { slug: 'pilot-demo', title: 'Pilot Demo', profile: 'film', created_at: NOW, aspect_ratio: '16:9' },
    current_stage: 'keyframes',
    stages: {
      intake: approved, breakdown: approved, sketch: approved, bible: approved, keyframes: { state: 'in-review' },
      motion: { state: 'locked' }, sound: { state: 'locked' }, assemble: { state: 'locked' }, export: { state: 'locked' },
    },
    scenes: [{ id: 'S07', part: 'P7' }, { id: 'S08', part: 'P8' }],
    shots: [
      shot('S07-010', 'S07', 'P7', 10, 14, { treatment: 'video' }),
      shot('S07-020', 'S07', 'P7', 14, 20, { treatment: 'lipsync', lines: [{ id: 'L01', kind: 'spoken' }] }),
      shot('S07-030', 'S07', 'P7', 20, 25, { treatment: 'still-move' }),
      shot('S07-040', 'S07', 'P7', 25, 30, { treatment: 'video' }),
      shot('S08-010', 'S08', 'P8', 31, 36, { treatment: 'video' }),
      shot('S08-020', 'S08', 'P8', 36, 40, { treatment: 'still', tier: 'C' }),
    ],
    bible: {
      characters: [{ id: 'ADA', stage: 'breakdown', status: 'approved', name: 'Ada (invented)' }],
      locations: [{ id: 'LOC-DOCK', stage: 'breakdown', status: 'approved', name: 'A dock (invented)' }],
      styles: [],
    },
    assets: [
      { id: 'ADA_portrait', kind: 'portrait', stage: 'bible', status: 'approved', owner: 'ADA', tags: [], comments: [], file: file('ADA_portrait') },
      { id: 'LOC-DOCK_plate', kind: 'plate', stage: 'bible', status: 'approved', owner: 'LOC-DOCK', tags: [], comments: [], file: file('LOC-DOCK_plate') },
      kf('S07-010', true), kf('S07-020', true), kf('S07-030', true), kf('S07-040', true),
      kf('S08-010', false), kf('S08-020', false),
    ],
    audio: {
      master: { uri: 'audio/master.wav', duration_s: 60, sample_rate: 8000, start_tc: '00:00:00:00' },
      lines: [{ id: 'L01', character: 'ADA', kind: 'spoken', film_in_s: 15.5, film_out_s: 17.0, text: 'Not tonight.' }],
    },
    budget: { cap: 5, currency: 'USD', spent: 0 },
  });
}

let n = 0;
const decide = (unit: string, stage: string): Decision => DecisionSchema.parse({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, action: 'approve', unit, stage, by: 'you', at: `2026-11-10T13:${String(n % 60).padStart(2, '0')}:00Z`, view: 'default-board@0.3',
});
const CONFORMED = ['default-board@0.3'];
/** A unit made and waiting for review (what the provider leaves behind). */
const made = (p: AkukoProject, id: string): void => {
  const a = p.assets.find((x) => x.id === id)!;
  a.status = 'pending-review';
  a.file = file(id, 'mp4');
};

describe('part-scoped opening (--part P7)', () => {
  it('P7 is open while another part\'s key frames are still waiting; the whole stage is not', () => {
    const p = pilot();
    const o = partOpenness(p, 'P7');
    assert.equal(o.open, true);
    assert.deepEqual(o.shots.map((s) => s.id), ['S07-010', 'S07-020', 'S07-030', 'S07-040']);
    assert.doesNotThrow(() => assertOpen(p, { part: 'P7' }));
    assert.throws(() => assertOpen(p), /motion stage is locked: keyframes is "in-review"/);
    assert.equal(partOpenness(p, 'P8').open, false);
  });

  it('a part that is not open is refused, naming what is missing as counts plus the first ids', () => {
    const p = pilot();
    for (const id of ['S07-020', 'S07-030', 'S07-040']) p.assets.find((a) => a.id === `${id}_keyframe`)!.status = 'pending-review';
    p.assets.find((a) => a.id === 'LOC-DOCK_plate')!.status = 'needs-rework';
    assert.throws(() => assertOpen(p, { part: 'P7' }), (e: Error) => {
      assert.equal(e.message.split('. ')[0], 'P7 is not open for motion: 3 key frames not approved (S07-020, S07-030, S07-040), 1 bible entry not approved (LOC-DOCK)');
      return true;
    });
    p.assets.find((a) => a.id === 'S07-010_keyframe')!.status = 'pending-review';
    assert.match(partRefusal(partOpenness(p, 'P7')), /4 key frames not approved \(S07-010, S07-020, S07-030, …\)/);
    p.stages.sketch = { state: 'in-review' };
    assert.match(partRefusal(partOpenness(p, 'P7')), /^P7 is not open for motion: sketch is "in-review", 4 key frames/);
    assert.throws(() => planMotion(p, NOW, { part: 'P7' }), /P7 is not open for motion/);
    assert.throws(() => planLipsync(p, NOW, { part: 'P7' }), /P7 is not open for motion/);
    assert.throws(() => assertOpen(pilot(), { part: 'P9' }), /No live shot is in part "P9". Parts in this project: P7, P8/);
  });

  it('a key frame without its file does not count as approved', () => {
    const p = pilot();
    delete p.assets.find((a) => a.id === 'S07-040_keyframe')!.file;
    assert.match(partRefusal(partOpenness(p, 'P7')), /1 key frame not approved \(S07-040\)/);
  });

  it('a scoped plan touches only P7, stores no flag and leaves the stage locked', () => {
    const before = pilot();
    const r = planMotion(before, NOW, { part: 'P7' });
    assert.deepEqual(r.created, ['S07-010_clip', 'S07-040_clip']);
    assert.ok(!r.project.assets.some((a) => a.owner?.startsWith('S08')  && a.stage === 'motion'));
    assert.equal(r.project.stages.motion.state, 'locked', 'a part never unlocks the stage');
    // Nothing but the two planned clips changed: no flag, no stage, no approval.
    const strip = (p: AkukoProject) => ({ ...p, assets: p.assets.filter((a) => a.stage !== 'motion') });
    assert.deepEqual(strip(r.project), strip(before));
    const ls = planLipsync(r.project, NOW, { part: 'P7' });
    assert.deepEqual(ls.created, ['S07-020_lipsync']);
    assert.deepEqual(lipsyncTargets(ls.project, { part: 'P7' }).targets.map((t) => t.shot.id), ['S07-020']);
    assert.deepEqual(motionStatus(ls.project, { part: 'P7' }).map((x) => x.asset), ['S07-010_clip', 'S07-040_clip']);
  });

  it('a scoped job prices and makes only P7: the default pick, a scene batch, and a named unit outside it', () => {
    let p = planMotion(pilot(), NOW, { part: 'P7' }).project;
    // A clip of P8 planned somehow (an older whole-film plan) must still never be made by a P7 run.
    p.assets.push({ id: 'S08-010_clip', kind: 'clip', stage: 'motion', status: 'pending', owner: 'S08-010', tags: ['clip'], comments: [], updated_at: NOW } as never);
    p = AkukoProjectSchema.parse(p);
    const j = buildMotionJob(p, { provider: 'manual', part: 'P7' });
    assert.deepEqual(j.units, ['S07-010_clip']);
    const batch = buildMotionJob(p, { provider: 'manual', part: 'P7', scene: 'S07' });
    assert.deepEqual(batch.units, ['S07-010_clip', 'S07-040_clip']);
    assert.throws(() => buildMotionJob(p, { provider: 'manual', part: 'P7', units: ['S08-010_clip'] }), /S08-010_clip is not in part P7/);
    assert.throws(() => buildMotionJob(p, { provider: 'manual' }), /motion stage is locked/, 'without --part, the whole-project rule holds');
  });

  it('without --part nothing changes once the whole film is open', () => {
    const p = pilot();
    for (const a of p.assets) if (a.kind === 'keyframe') a.status = 'approved';
    p.stages.keyframes = approved;
    p.stages.motion = { state: 'not-started' };
    const r = planMotion(AkukoProjectSchema.parse(p), NOW);
    assert.deepEqual(r.created, ['S07-010_clip', 'S07-040_clip', 'S08-010_clip']);
    assert.equal(r.project.stages.motion.state, 'in-progress');
  });
});

describe('one motion-stage roll-up', () => {
  /** The whole film open; P7 clips and lip-sync planned and in various states; one idle clip. */
  function open(): AkukoProject {
    const p = pilot();
    for (const a of p.assets) if (a.kind === 'keyframe') a.status = 'approved';
    p.stages.keyframes = approved;
    p.stages.motion = { state: 'not-started' };
    let q = planMotion(AkukoProjectSchema.parse(p), NOW).project;
    q = planLipsync(q, NOW).project;
    // S07-040 was planned as video, then the person made it still-move: its clip is idle, kept, never made.
    q = treatShots(q, ['S07-040'], 'still-move').project;
    q.assets.push({ id: 'S07-020_linecut', kind: 'vo', stage: 'motion', status: 'pending-review', owner: 'S07-020', tags: ['lipsync-audio'], comments: [], provider: 'akuko-cut', file: { uri: 'lipsync/cuts/S07-020_linecut.wav', mime: 'audio/wav', hash: 'h-cut' } } as never);
    return AkukoProjectSchema.parse(q);
  }

  it('motion and lip-sync share the one function', () => {
    assert.equal(fromMotion, refreshMotionStage);
    assert.equal(fromLipsync, refreshMotionStage);
  });

  it('counts active clips, lip-syncs and their cuts, never idle clips; the same whichever step ran last', () => {
    const p = open();
    const r = motionRollup(p);
    assert.deepEqual(r.active.map((a) => a.id).sort(), ['S07-010_clip', 'S07-020_linecut', 'S07-020_lipsync', 'S08-010_clip']);
    assert.deepEqual(r.idle.map((a) => a.id), ['S07-040_clip']);
    assert.ok(isIdleMotionUnit(p, p.assets.find((a) => a.id === 'S07-040_clip')!));
    for (const id of ['S07-010_clip', 'S07-020_lipsync', 'S08-010_clip']) made(p, id);
    // Everything active is made and waiting for a person; the idle clip, still pending, is not work.
    assert.equal(refreshMotionStage(p).stages.motion.state, 'in-review');
    // Run them in either order: motion's step then lip-sync's, or the other way, gives the same state.
    assert.equal(fromLipsync(fromMotion(p)).stages.motion.state, fromMotion(fromLipsync(p)).stages.motion.state);
    // A lip-sync still to make holds it in progress, whichever step refreshes.
    const q = structuredClone(p);
    q.assets.find((a) => a.id === 'S07-020_lipsync')!.status = 'needs-rework';
    assert.equal(fromMotion(q).stages.motion.state, 'in-progress');
    assert.equal(fromLipsync(q).stages.motion.state, 'in-progress');
  });

  it('an orphaned lip-sync and a removed row are not counted; a wanted unit not yet planned is', () => {
    const p = open();
    for (const id of ['S07-010_clip', 'S07-020_lipsync', 'S08-010_clip']) made(p, id);
    const orphan = treatShots(p, ['S07-020'], 'still').project;
    assert.ok(motionRollup(orphan).idle.some((a) => a.id === 'S07-020_lipsync'), 'the lip-sync of a shot made still is idle');
    assert.ok(motionRollup(orphan).idle.some((a) => a.id === 'S07-020_linecut'), 'and so is its line cut');
    const removed = structuredClone(p);
    removed.shots.find((s) => s.id === 'S08-010')!.source = { kind: 'sheet', id: 'S08-010', removed_at: NOW };
    assert.ok(!motionRollup(removed).active.some((a) => a.id === 'S08-010_clip'));
    const unplanned = structuredClone(p);
    unplanned.shots.find((s) => s.id === 'S08-020')!.treatment = 'video';
    assert.deepEqual(motionRollup(unplanned).unplanned, ['S08-020_clip']);
    assert.equal(refreshMotionStage(unplanned).stages.motion.state, 'in-progress', 'a video shot with no clip planned is work outstanding');
  });

  it('never touches locked and never sets approved', () => {
    const p = open();
    p.stages.motion = { state: 'locked' };
    assert.equal(refreshMotionStage(p).stages.motion.state, 'locked');
    const q = open();
    for (const a of motionRollup(q).active) { a.status = 'approved'; a.file = file(a.id, 'mp4'); }
    assert.equal(refreshMotionStage(q).stages.motion.state, 'in-review');
  });

  it('folding approves the stage over the active units only: an idle clip, still pending, does not hold it', () => {
    const p = open();
    for (const id of ['S07-010_clip', 'S07-020_lipsync', 'S08-010_clip']) made(p, id);
    const q = refreshMotionStage(p);
    const ids = ['S07-010_clip', 'S07-020_lipsync', 'S07-020_linecut', 'S08-010_clip'];
    const r = foldDecisions(q, ids.map((u) => decide(u, 'motion')), { conformed: CONFORMED });
    assert.deepEqual(r.report.rejected, []);
    assert.equal(r.project.stages.motion.state, 'approved');
    assert.equal(r.project.assets.find((a) => a.id === 'S07-040_clip')!.status, 'pending', 'the idle clip is kept as it was');
  });
});

describe('an empty motion stage', () => {
  it('reaches in-review when no shot asks for a clip or a lip-sync, instead of sitting in progress', () => {
    const p = pilot();
    for (const a of p.assets) if (a.kind === 'keyframe') a.status = 'approved';
    for (const s of p.shots) { s.treatment = 'still-move'; delete s.lines; }
    p.stages.keyframes = approved;
    p.stages.motion = { state: 'not-started' };
    const r = planMotion(AkukoProjectSchema.parse(p), NOW);
    assert.deepEqual(r.created, []);
    assert.equal(r.project.stages.motion.state, 'in-review');
  });

  it('a stage whose clips all went idle leaves in-progress', () => {
    const p = pilot();
    for (const a of p.assets) if (a.kind === 'keyframe') a.status = 'approved';
    p.stages.keyframes = approved;
    p.stages.motion = { state: 'not-started' };
    let q = planMotion(AkukoProjectSchema.parse(p), NOW).project;
    assert.equal(q.stages.motion.state, 'in-progress');
    q = treatShots(q, ['S07-010', 'S07-040', 'S08-010'], 'still').project;
    q = treatShots(q, ['S07-020'], 'still').project;
    assert.equal(refreshMotionStage(q).stages.motion.state, 'in-review');
  });
});

describe('folding while a part is piloted', () => {
  it('approving every P7 unit never approves the locked stage; the stage opens with the film and waits for P8', () => {
    let p = planMotion(pilot(), NOW, { part: 'P7' }).project;
    p = planLipsync(p, NOW, { part: 'P7' }).project;
    for (const id of ['S07-010_clip', 'S07-040_clip', 'S07-020_lipsync']) made(p, id);
    let r = foldDecisions(p, ['S07-010_clip', 'S07-040_clip', 'S07-020_lipsync'].map((u) => decide(u, 'motion')), { conformed: CONFORMED });
    assert.deepEqual(r.report.rejected, []);
    assert.equal(r.project.stages.motion.state, 'locked', 'P7 done does not approve, or unlock, the stage');
    // The person approves P8's key frames: the key-frame stage is approved, motion unlocks, and P8's video shot
    // has no clip planned yet, so the stage is in progress, not approved.
    r = foldDecisions(r.project, ['S08-010_keyframe', 'S08-020_keyframe'].map((u) => decide(u, 'keyframes')), { conformed: CONFORMED });
    assert.equal(r.project.stages.keyframes.state, 'approved');
    assert.equal(r.project.stages.motion.state, 'in-progress');
    assert.notEqual(r.project.current_stage, 'sound');
  });
});

describe('clip offsets', () => {
  it('a clip records where it sits in film time as its job starts: the shot\'s slot, or less for a shorter clip', () => {
    const p = planMotion(pilot(), NOW, { part: 'P7' }).project;
    const q = recordClipFilm(p, { 'S07-010_clip': 10, 'S07-040_clip': 3 });
    assert.deepEqual(q.assets.find((a) => a.id === 'S07-010_clip')!.film, { in_s: 10, out_s: 14 });
    assert.deepEqual(q.assets.find((a) => a.id === 'S07-040_clip')!.film, { in_s: 25, out_s: 28 });
  });
});
