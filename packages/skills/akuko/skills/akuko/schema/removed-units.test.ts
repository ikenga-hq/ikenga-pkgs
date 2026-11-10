// WP-24c — rows removed from the shot list, downstream of the schema.
//
// A re-import flags a row that left the sheet with `source.removed_at`. This
// file pins what the rest of the skill does with such a unit: the unit lists,
// integrity, bible and sound readiness, the sketch board, the audit and the
// check-view expectations. Synthetic data only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AkukoProjectSchema, findUnit, listUnits, removedAt, type AkukoProject } from './akuko-project.ts';
import { checkIntegrity } from './integrity.ts';
import { assertOpen as bibleOpen, bibleEntries, BibleError, planBible } from '../bible/plan.ts';
import { assertOpen as soundOpen, SoundError, planSound } from '../sound/plan.ts';
import { breakdownApproved } from '../bible/__fixtures__/project.ts';
import { keyframesApproved } from '../sound/__fixtures__/project.ts';
import { shortStoryKeyframesApproved } from '../audit/__fixtures__/project.ts';
import { auditProject } from '../audit/audit.ts';
import { buildBeatBoards } from '../board/beatboard.ts';
import { lintBoard } from '../board/panels.ts';
import { expectedYourMove, removedAt as expectedRemovedAt } from '../scripts/check-view/expected.mjs';

const GONE = '2026-11-10T07:00:00Z';
const strip = (p: AkukoProject, shotId: string): AkukoProject => {
  const q = structuredClone(p);
  const s = q.shots.find((x) => x.id === shotId)!;
  s.source = { kind: 'sheet', id: 'S02-030', removed_at: GONE };
  return q;
};

describe('listUnits / findUnit and removed rows', () => {
  const base = keyframesApproved();
  const id = base.shots[0]!.id;

  it('keeps every unit by default (the decision folder needs to see removed ones)', () => {
    const p = strip(base, id);
    assert.equal(listUnits(p).length, listUnits(base).length);
    assert.ok(findUnit(p, id));
  });

  it('drops a removed unit, and the units it owns, with includeRemoved: false', () => {
    const p = strip(base, id);
    const owned = p.assets.filter((a) => a.owner === id).map((a) => a.id);
    assert.ok(owned.length > 0, 'the fixture has an asset owned by the first shot');
    const live = listUnits(p, { includeRemoved: false }).map((u) => u.unit.id);
    assert.ok(!live.includes(id));
    for (const o of owned) assert.ok(!live.includes(o), o);
    assert.equal(live.length, listUnits(p).length - 1 - owned.length);
    assert.equal(findUnit(p, id, { includeRemoved: false }), undefined);
    assert.ok(findUnit(p, owned[0]!, { includeRemoved: true }));
  });

  it('removedAt: own stamp, else the owner\'s, else undefined', () => {
    const p = strip(base, id);
    assert.equal(removedAt(p, p.shots[0]!), GONE);
    assert.equal(removedAt(p, p.assets.find((a) => a.owner === id)!), GONE);
    assert.equal(removedAt(p, p.shots[1]!), undefined);
    assert.equal(removedAt(p, p.assets.find((a) => a.owner === p.shots[1]!.id)!), undefined);
  });
});

describe('integrity ignores a removed row\'s film time', () => {
  it('a removed shot overlapping a live one is no overlap', () => {
    const p = AkukoProjectSchema.parse(structuredClone(shortStoryKeyframesApproved()));
    const [a, b] = p.shots.filter((s) => s.scene === p.shots[0]!.scene);
    assert.ok(a && b, 'two shots share a scene');
    a.film = { in_s: 0, out_s: 5 };
    b.film = { in_s: 3, out_s: 8 };
    assert.ok(checkIntegrity(p).some((e) => /overlaps/.test(e.message)), 'control: live overlap is reported');
    b.source = { kind: 'sheet', id: 'S02-040', removed_at: GONE };
    assert.deepEqual(checkIntegrity(p).filter((e) => /overlaps/.test(e.message)), []);
  });
});

describe('readiness skips removed rows', () => {
  it('bible: a removed pending entry no longer blocks the stage', () => {
    const p = breakdownApproved();
    const e = bibleEntries(p)[0]!.entry;
    e.status = 'pending-review';
    assert.throws(() => bibleOpen(p), BibleError);
    e.source = { kind: 'sheet', id: 'ADA', removed_at: GONE };
    assert.doesNotThrow(() => bibleOpen(p));
  });

  it('sound: a removed pending shot no longer blocks the stage', () => {
    const p = keyframesApproved();
    p.shots[0]!.status = 'pending-review';
    assert.throws(() => soundOpen(p), SoundError);
    p.shots[0]!.source = { kind: 'sheet', id: 'S02-030', removed_at: GONE };
    assert.doesNotThrow(() => soundOpen(p));
  });
});

describe('planners skip removed rows', () => {
  it('planBible plans nothing for a removed entry', () => {
    const p = breakdownApproved();
    const withImages = bibleEntries(p).find((e) => e.kind !== 'style' && planBible(p, '2026-11-10T08:00:00Z').created.some((id) => id.startsWith(e.entry.id)))!;
    assert.ok(withImages, 'control: a live entry gets planned assets');
    const q = structuredClone(p);
    const e = [...q.bible.characters, ...q.bible.locations, ...q.bible.styles].find((x) => x.id === withImages.entry.id)!;
    e.source = { kind: 'sheet', id: 'ADA', removed_at: GONE };
    const made = planBible(q, '2026-11-10T08:00:00Z').created;
    assert.ok(!made.some((id) => id.startsWith(e.id)), 'nothing is planned for the removed entry');
    assert.ok(made.length > 0, 'the others still are');
  });

  it('planSound plans no voice-over for a removed shot', () => {
    const p = keyframesApproved();
    const live = planSound(p, '2026-11-10T08:00:00Z').created;
    assert.ok(live.length > 0);
    const victim = live[0]!.replace(/_vo$/, '');
    const q = structuredClone(p);
    q.shots.find((s) => s.id === victim)!.source = { kind: 'sheet', id: 'S02-030', removed_at: GONE };
    const made = planSound(q, '2026-11-10T08:00:00Z').created;
    assert.ok(!made.includes(live[0]!));
    assert.equal(made.length, live.length - 1);
  });
});

describe('board and audit skip removed rows', () => {
  it('the beat boards have no cell for a removed shot', () => {
    const p = shortStoryKeyframesApproved();
    const id = p.shots[0]!.id;
    const cells = (q: AkukoProject): string => buildBeatBoards(q).map((b) => b.html).join('');
    assert.ok(cells(p).includes(`data-shot="${id}"`));
    assert.ok(!cells(strip(p, id)).includes(`data-shot="${id}"`));
  });

  it('the sketch lint does not warn about a removed shot', () => {
    const p = shortStoryKeyframesApproved();
    const id = p.shots[0]!.id;
    const q = structuredClone(p);
    q.shots[0]!.blocking = [];
    assert.ok(lintBoard(q).some((i) => i.shot === id));
    assert.ok(!lintBoard(strip(q, id)).some((i) => i.shot === id));
  });

  it('the audit leaves out the key frame of a removed shot', () => {
    const p = shortStoryKeyframesApproved();
    const id = p.shots[0]!.id;
    const r = auditProject(strip(p, id), { now: '2026-11-10T09:00:00Z' });
    assert.ok(!r.frames.some((f) => f.shot === id));
    assert.equal(r.summary.audited, auditProject(p, { now: '2026-11-10T09:00:00Z' }).summary.audited - 1);
  });
});

describe('check-view expectations', () => {
  it('"your move" counts leave out removed units', () => {
    const p = keyframesApproved();
    p.shots[0]!.status = 'pending-review';
    p.shots[1]!.status = 'pending-review';
    const before = expectedYourMove(p)['waiting-shots'];
    assert.equal(before, 2);
    const q = strip(p, p.shots[0]!.id);
    assert.equal(expectedYourMove(q)['waiting-shots'], 1);
    assert.equal(expectedRemovedAt(q, q.shots[0]!), GONE);
    assert.equal(expectedRemovedAt(q, q.shots[1]!), undefined);
  });
});
