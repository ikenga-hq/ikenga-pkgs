// WP-29: units that left the imported shot list (WP-25 sets source.removed_at and never deletes them).
// They don't hold their stage back, they take no decisions, and gates don't count them. Synthetic data only.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DecisionSchema, type AkukoProject, type Decision } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { bigProject } from '../views/__fixtures__/big-project.ts';
import { loadConformedFile } from './conformed.ts';
import { foldDecisions, removedFromSheet } from './fold.ts';
import { gateStatus } from './gates.ts';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const CONFORMED = loadConformedFile(join(SKILL, 'views', 'conformed.json'));
const REMOVED_AT = '2026-11-10T07:00:00Z';
let n = 0;
const decide = (unit: string, stage: string, action: 'approve' | 'request-changes' | 'note' = 'approve'): Decision => DecisionSchema.parse({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, action, unit, stage, by: 'you', at: `2026-11-10T10:${String(n % 60).padStart(2, '0')}:00Z`, view: 'default-board@0.2',
  ...(action === 'approve' ? {} : { text: 'closer' }),
});

/** The sketch stage with every shot approved except S11-030 and S11-090 (both waiting for review). */
function almostDone(): AkukoProject {
  const p = bigProject();
  for (const s of p.shots) if (s.id !== 'S11-030' && s.id !== 'S11-090') s.status = 'approved';
  p.shots.find((s) => s.id === 'S11-030')!.status = 'pending-review';
  p.shots.find((s) => s.id === 'S11-090')!.status = 'pending-review';
  return p;
}
const remove = (p: AkukoProject, id: string) => {
  const s = p.shots.find((x) => x.id === id)!;
  s.source = { kind: 'sheet', id, removed_at: REMOVED_AT };
};

describe('units removed from the sheet', () => {
  it('removedFromSheet reads source.removed_at on any unit', () => {
    const p = almostDone();
    remove(p, 'S11-030');
    assert.equal(removedFromSheet(p.shots.find((s) => s.id === 'S11-030')!), REMOVED_AT);
    assert.equal(removedFromSheet(p.shots.find((s) => s.id === 'S11-090')!), undefined);
    assert.equal(removedFromSheet(p.assets[0]!), undefined);
  });

  it('a removed shot still waiting for review does not hold the stage back', () => {
    const control = foldDecisions(almostDone(), [decide('S11-090', 'sketch')], { conformed: CONFORMED }).project;
    assert.equal(control.stages.sketch.state, 'in-review', 'without the removal, S11-030 still waits');
    const p = almostDone();
    remove(p, 'S11-030');
    const r = foldDecisions(p, [decide('S11-090', 'sketch')], { conformed: CONFORMED });
    assert.deepEqual(r.report.rejected, []);
    assert.equal(r.project.stages.sketch.state, 'approved');
    assert.equal(r.project.stages.bible.state, 'in-review', 'the next stage keeps its own state');
    assert.equal(r.project.shots.find((s) => s.id === 'S11-030')!.status, 'pending-review', 'the removed shot is left as it was');
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('a decision aimed at a removed unit is refused with a clear reason, stored, and changes nothing', () => {
    const p = almostDone();
    remove(p, 'S11-030');
    const ds = [decide('S11-030', 'sketch'), decide('S11-030', 'sketch', 'request-changes'), decide('S11-030', 'sketch', 'note')];
    const r = foldDecisions(p, ds, { conformed: CONFORMED });
    assert.deepEqual(r.report.applied, []);
    assert.deepEqual(r.report.rejected.map((x) => x.code), ['removed-from-sheet', 'removed-from-sheet', 'removed-from-sheet']);
    assert.match(r.report.rejected[0]!.reason, /"S11-030" was removed from the shot list \(2026-11-10T07:00:00Z\); it is kept for the record but takes no decisions\. Nothing was applied\./);
    const shot = r.project.shots.find((s) => s.id === 'S11-030')!;
    assert.equal(shot.status, 'pending-review');
    assert.equal(shot.comments.filter((c) => c.author === 'agent' && /^Not applied: /.test(c.text)).length, 3, 'one notice each');
    assert.ok(!shot.comments.some((c) => c.author === 'you'), 'no person comment is added');
    assert.equal(r.project.decisions.length, 3, 'stored, so the refusal stays visible and is not reported again');
    const again = foldDecisions(r.project, ds, { conformed: CONFORMED });
    assert.equal(again.report.changed, false);
    assert.deepEqual(again.report.rejected, []);
  });

  it('a decision made before the row was removed stays as it was', () => {
    const p = almostDone();
    const first = foldDecisions(p, [decide('S11-030', 'sketch')], { conformed: CONFORMED }).project;
    assert.equal(first.shots.find((s) => s.id === 'S11-030')!.status, 'approved');
    remove(first, 'S11-030');
    const later = foldDecisions(first, [decide('S11-090', 'sketch')], { conformed: CONFORMED }).project;
    assert.equal(later.shots.find((s) => s.id === 'S11-030')!.status, 'approved');
    assert.equal(later.stages.sketch.state, 'approved');
  });

  it('gates leave removed units out of their counts and list them', () => {
    const p = bigProject();
    const kf = p.assets.find((a) => a.id === 'S11-100_keyframe')!;
    kf.source = { kind: 'sheet', id: 'S11-100', removed_at: REMOVED_AT };
    remove(p, 'S11-100');
    const g = gateStatus(p, 'G-PILOT');
    assert.equal(g.total, 10);
    assert.ok(!g.units.some((u) => u.id === 'S11-100_keyframe'));
    assert.deepEqual(g.removed, ['S11-100']);
    const look = gateStatus(p, 'G-LOOK');
    const portrait = p.assets.find((a) => a.id === 'BEN_portrait')!;
    portrait.source = { kind: 'sheet', id: 'BEN', removed_at: REMOVED_AT };
    assert.equal(gateStatus(p, 'G-LOOK').total, look.total - 1, 'a removed asset is not counted either');
  });
});
