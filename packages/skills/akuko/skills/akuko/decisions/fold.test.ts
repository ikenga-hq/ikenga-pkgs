// Decision folding (G-VIEW): idempotent, order-independent, exact undo,
// R-12 provenance, spend binding, and parity across the three host stores.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema, findUnit, type AkukoProject, type Decision } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { serializeProject } from '../hosts/local.ts';
import { parseArtifactRows } from './artifact-db.ts';
import { CHAT_VIEW, loadConformedFile } from './conformed.ts';
import { compareDecisions, foldDecisions, isAgentAuthor, type FoldOptions } from './fold.ts';
import { readIkengaStore } from './ikenga.ts';
import { parseJsonl } from './jsonl.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FX = here('./__fixtures__/');
const fixture = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(here('../fixtures/the-beating/akuko.json'), 'utf8')));
const CONFORMED = loadConformedFile(join(FX, 'conformed.json'));
const OPTS: FoldOptions = { conformed: CONFORMED };
const BOARD = 'default-board@0.1';
const recorded = (): Decision[] => parseJsonl(readFileSync(join(FX, 'decisions.jsonl'), 'utf8')).decisions;

const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

let n = 0;
/** A decision with a fresh deterministic uuid; `min` is minutes after 12:00Z on 2026-11-07. */
function dec(action: Decision['action'], unit: string, min: number, extra: Record<string, unknown> = {}): Decision {
  n++;
  const h = createHash('sha1').update(`t${n}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const at = new Date(Date.UTC(2026, 10, 7, 12, min, 0)).toISOString().replace('.000Z', 'Z');
  const stage = unit.startsWith('job_') ? 'keyframes' : unit.includes('_sh') ? 'sketch' : 'bible';
  return { id, action, unit, stage, by: 'you', at, view: BOARD, ...extra } as Decision;
}
const fold = (p: AkukoProject, ds: Decision[], o: FoldOptions = OPTS) => foldDecisions(p, ds, o);
const unit = (p: AkukoProject, id: string) => findUnit(p, id)!.unit;
const job = (p: AkukoProject, id = 'job_kf_sc1') => p.pending_spend.find((j) => j.id === id)!;
const bytes = (p: AkukoProject) => serializeProject(p);

/** Deterministic shuffle (mulberry32). */
function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────

describe('store parity (G-VIEW sign-off)', () => {
  const golden = readFileSync(join(FX, 'the-beating.folded.json'), 'utf8');

  it('jsonl, recorded artifact-DB rows and recorded iframe-state events fold to byte-identical akuko.json', async () => {
    const fromJsonl = fold(fixture(), recorded()).project;
    const fromDb = fold(fixture(), parseArtifactRows(readFileSync(join(FX, 'artifact-db-list.json'), 'utf8')).decisions).project;
    const dir = mkdtempSync(join(tmpdir(), 'akuko-c-'));
    tmp.push(dir);
    cpSync(join(FX, 'ikenga-mirror.jsonl'), join(dir, 'decisions.jsonl'));
    const c = await readIkengaStore({ projectDir: dir, iframeState: readFileSync(join(FX, 'iframe-state.txt'), 'utf8') });
    const fromIkenga = fold(fixture(), c.decisions).project;
    assert.equal(bytes(fromDb), bytes(fromJsonl));
    assert.equal(bytes(fromIkenga), bytes(fromJsonl));
    assert.equal(bytes(fromJsonl), golden, 'the committed folded fixture is what folding produces');
  });

  it('the folded fixture is schema-valid and passes the integrity check', () => {
    const p = AkukoProjectSchema.parse(JSON.parse(golden));
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('the recorded set covers every action, an undo, an agent approval and a non-conformed view', () => {
    const ds = recorded();
    assert.deepEqual([...new Set(ds.map((d) => d.action))].sort(), ['approve', 'approve-spend', 'note', 'request-changes', 'undo']);
    assert.ok(ds.some((d) => isAgentAuthor(d.by)));
    assert.ok(ds.some((d) => d.view !== BOARD));
  });
});

describe('idempotent and order-independent', () => {
  it('folding the same decisions again changes nothing', () => {
    const once = fold(fixture(), recorded());
    const twice = fold(once.project, recorded());
    assert.equal(bytes(twice.project), bytes(once.project));
    assert.equal(twice.report.changed, false);
    assert.deepEqual(twice.report.new, []);
    assert.equal(twice.report.duplicates.length, recorded().length);
    assert.deepEqual(twice.report.rejected, [], 'rejections are reported once, when the decision is new');
  });

  it('any arrival order, in any number of batches, gives the same project', () => {
    const want = bytes(fold(fixture(), recorded()).project);
    for (let seed = 1; seed <= 40; seed++) {
      const ds = shuffle(recorded(), seed);
      const cut = 1 + (seed % (ds.length - 1));
      const cut2 = Math.min(ds.length, cut + (seed % 3));
      let p = fixture();
      // An undo whose target hasn't arrived is not recorded, so the reader
      // offers it again (it does not advance its cursor past it: lib/state.md).
      let retry: Decision[] = [];
      for (const batch of [ds.slice(0, cut), ds.slice(cut, cut2), ds.slice(cut2)]) {
        const r = fold(p, [...retry, ...batch]);
        p = r.project;
        const wait = new Set(r.report.rejected.filter((x) => x.code === 'unknown-target').map((x) => x.id));
        retry = [...retry, ...batch].filter((d) => wait.has(d.id));
      }
      assert.equal(bytes(p), want, `seed ${seed}`);
    }
  });

  it('decisions are recorded in one total order: at (as an instant), then id', () => {
    const p = fold(fixture(), shuffle(recorded(), 7)).project;
    const sorted = [...p.decisions].sort(compareDecisions);
    assert.deepEqual(p.decisions.map((d) => d.id), sorted.map((d) => d.id));
  });

  it('a late-arriving older decision does not override a later one', () => {
    const rc = dec('request-changes', 'sc2_sh4', 1, { text: 'Darker.' });
    const ap = dec('approve', 'sc2_sh4', 2);
    const lateFirst = fold(fold(fixture(), [ap]).project, [rc]).project;
    const together = fold(fixture(), [rc, ap]).project;
    assert.equal(unit(lateFirst, 'sc2_sh4').status, 'approved');
    assert.equal(bytes(lateFirst), bytes(together));
  });

  it('the input project is not modified', () => {
    const p = fixture();
    const before = bytes(p);
    fold(p, recorded());
    assert.equal(bytes(p), before);
  });
});

describe('undo', () => {
  it('reverses exactly the decision it names, back to the status before it', () => {
    const p0 = fixture();
    const ap = dec('approve', 'sc2_sh3', 1); // sc2_sh3 is needs-rework in the fixture
    const p1 = fold(p0, [ap]).project;
    assert.equal(unit(p1, 'sc2_sh3').status, 'approved');
    const p2 = fold(p1, [dec('undo', 'sc2_sh3', 2, { undoes: ap.id })]).project;
    assert.equal(unit(p2, 'sc2_sh3').status, 'needs-rework');
    assert.deepEqual(unit(p2, 'sc2_sh3').comments, unit(p0, 'sc2_sh3').comments, 'the trail entry is gone');
    for (const s of p0.shots) if (s.id !== 'sc2_sh3') assert.deepEqual(unit(p2, s.id), s);
  });

  it('restores what the unit was just before, even when an action revised it in between', () => {
    const rc = dec('request-changes', 'sc2_sh4', 1, { text: 'Wider.' });
    let p = fold(fixture(), [rc]).project;
    assert.equal(unit(p, 'sc2_sh4').status, 'needs-rework');
    unit(p, 'sc2_sh4').status = 'pending-review'; // the action revised it
    const ap = dec('approve', 'sc2_sh4', 3);
    p = fold(p, [ap]).project;
    p = fold(p, [dec('undo', 'sc2_sh4', 4, { undoes: ap.id })]).project;
    assert.equal(unit(p, 'sc2_sh4').status, 'pending-review');
  });

  it('undoing a middle decision keeps the latest one and repairs the trail', () => {
    const a = dec('approve', 'sc2_sh4', 1);
    const b = dec('request-changes', 'sc2_sh4', 2, { text: 'Again.' });
    let p = fold(fixture(), [a, b]).project;
    p = fold(p, [dec('undo', 'sc2_sh4', 3, { undoes: a.id })]).project;
    assert.equal(unit(p, 'sc2_sh4').status, 'needs-rework');
    const trail = unit(p, 'sc2_sh4').comments.filter((c) => c.text.startsWith('Status:')).map((c) => c.text);
    assert.deepEqual(trail, ['Status: pending-review → needs-rework']);
  });

  it('undoing a note removes its comment; an undo of an undo puts it back', () => {
    const note = dec('note', 'sc1_sh1', 1, { text: 'Lovely.' });
    const u1 = dec('undo', 'sc1_sh1', 2, { undoes: note.id });
    const u2 = dec('undo', 'sc1_sh1', 3, { undoes: u1.id });
    const p1 = fold(fixture(), [note]).project;
    const p2 = fold(p1, [u1]).project;
    const p3 = fold(p2, [u2]).project;
    assert.equal(unit(p1, 'sc1_sh1').comments.length, 1);
    assert.equal(unit(p2, 'sc1_sh1').comments.length, 0);
    assert.deepEqual(unit(p3, 'sc1_sh1').comments, unit(p1, 'sc1_sh1').comments);
  });

  it('an undo of an undo re-applies an approval', () => {
    const ap = dec('approve', 'sc2_sh4', 1);
    const u1 = dec('undo', 'sc2_sh4', 2, { undoes: ap.id });
    const u2 = dec('undo', 'sc2_sh4', 3, { undoes: u1.id });
    const step = fold(fold(fold(fixture(), [ap]).project, [u1]).project, [u2]).project;
    assert.equal(unit(step, 'sc2_sh4').status, 'approved');
    assert.equal(bytes(step), bytes(fold(fixture(), [u2, ap, u1]).project));
  });

  it('an undo that arrives before its target waits for it, then gives the same result', () => {
    const ap = dec('approve', 'sc2_sh4', 1);
    const un = dec('undo', 'sc2_sh4', 2, { undoes: ap.id });
    const first = fold(fixture(), [un]);
    assert.equal(first.report.rejected[0]?.code, 'unknown-target');
    assert.equal(first.project.decisions.length, 0, 'not stored until its target arrives');
    const then = fold(first.project, [ap, un]).project;
    assert.equal(bytes(then), bytes(fold(fixture(), [ap, un]).project));
    assert.equal(unit(then, 'sc2_sh4').status, 'pending-review');
  });

  it('refuses an undo of a decision made after it, or on another unit', () => {
    const ap = dec('approve', 'sc2_sh4', 5);
    const back = dec('undo', 'sc2_sh4', 1, { undoes: ap.id });
    const other = dec('undo', 'sc4_sh2', 6, { undoes: ap.id });
    const r = fold(fixture(), [ap, back, other]);
    assert.equal(unit(r.project, 'sc2_sh4').status, 'approved');
    assert.deepEqual(r.report.rejected.map((x) => x.code).sort(), ['bad-undo', 'bad-undo']);
  });

  it('refuses to undo a decision on a stage the unit has left', () => {
    const ap = dec('approve', 'sc2_sh4', 1);
    const p = fold(fixture(), [ap]).project;
    Object.assign(unit(p, 'sc2_sh4'), { stage: 'keyframes', status: 'draft' });
    const r = fold(p, [dec('undo', 'sc2_sh4', 2, { undoes: ap.id })]);
    assert.equal(r.report.rejected[0]?.code, 'stale-stage');
    assert.equal(unit(r.project, 'sc2_sh4').status, 'draft');
    assert.equal(bytes(fold(r.project, r.project.decisions).project), bytes(r.project), 'stays refused');
  });
});

describe('provenance (R-12)', () => {
  it('rejects approvals signed by an agent, in any spelling', () => {
    for (const by of ['agent', 'Claude', 'akuko:review', 'assistant', 'claude-code']) {
      const r = fold(fixture(), [dec('approve', 'sc2_sh4', 1, { by })]);
      assert.equal(unit(r.project, 'sc2_sh4').status, 'pending-review', by);
      assert.equal(r.report.rejected[0]?.code, 'not-a-person', by);
    }
    assert.equal(isAgentAuthor('u_MqzQiltgXYt3SkzqDD9F_w'), false);
    assert.equal(isAgentAuthor('you'), false);
    assert.equal(isAgentAuthor('aisha'), false);
  });

  it('rejects approve, approve-spend and undo from a view that has not passed the check', () => {
    const v = { view: 'freehand:cast-sheet@1' };
    const r = fold(fixture(), [dec('approve', 'sc2_sh4', 1, v), dec('approve-spend', 'job_kf_sc1', 2, { ...v, text: 'approve 0.36 USD' })]);
    assert.equal(unit(r.project, 'sc2_sh4').status, 'pending-review');
    assert.equal(job(r.project).status, 'awaiting-approval');
    assert.deepEqual(r.report.rejected.map((x) => x.code), ['view-not-conformed', 'view-not-conformed']);
    const ap = dec('approve', 'sc2_sh4', 3);
    const r2 = fold(fold(fixture(), [ap]).project, [dec('undo', 'sc2_sh4', 4, { ...v, undoes: ap.id })]);
    assert.equal(unit(r2.project, 'sc2_sh4').status, 'approved');
  });

  it('accepts notes, requests for changes and declines from any view (they never approve)', () => {
    const v = { view: 'freehand:cast-sheet@1', by: 'agent' };
    const r = fold(fixture(), [
      dec('note', 'sc2_sh4', 1, { ...v, text: 'n' }),
      dec('request-changes', 'sc4_sh2', 2, { ...v, text: 'rc' }),
      dec('decline-spend', 'job_kf_sc1', 3, v),
    ]);
    assert.deepEqual(r.report.rejected, []);
    assert.equal(unit(r.project, 'sc4_sh2').status, 'needs-rework');
    assert.equal(job(r.project).status, 'declined');
  });

  it('keeps rejected decisions visible: in decisions[], in the report, and as a notice on the unit (once)', () => {
    const bad = dec('approve', 'sc2_sh4', 1, { by: 'agent' });
    const r = fold(fixture(), [bad]);
    assert.ok(r.project.decisions.some((d) => d.id === bad.id));
    const notices = unit(r.project, 'sc2_sh4').comments.filter((c) => c.decision === bad.id);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /^Not applied: /);
    assert.equal(notices[0]!.author, 'agent');
    assert.equal(bytes(fold(r.project, [bad]).project), bytes(r.project));
  });

  it('a view conformed later does not revive an approval rejected earlier', () => {
    const ap = dec('approve', 'sc2_sh4', 1, { view: 'freehand:late@1' });
    const p1 = fold(fixture(), [ap]).project;
    const p2 = fold(p1, [], { conformed: [...CONFORMED.views, { view: 'freehand:late@1' }] }).project;
    assert.equal(unit(p2, 'sc2_sh4').status, 'pending-review');
  });

  it('chat approvals count only when they quote the person ("approve …")', () => {
    const ok = fold(fixture(), [dec('approve-spend', 'job_kf_sc1', 1, { view: CHAT_VIEW, text: 'approve 0.36 USD' })]);
    assert.equal(job(ok.project).status, 'approved');
    const bare = fold(fixture(), [dec('approve', 'sc2_sh4', 1, { view: CHAT_VIEW })]);
    assert.equal(bare.report.rejected[0]?.code, 'chat-without-words');
    assert.equal(fold(fixture(), [dec('approve', 'sc2_sh4', 1, { view: CHAT_VIEW, text: 'approve sc2_sh4' })]).project.shots.find((s) => s.id === 'sc2_sh4')!.status, 'approved');
  });

  it('chat@1 (G-VIEW C1): exact words only, one unit per record, keyword case-insensitive, never an undo', () => {
    const chat = { view: CHAT_VIEW };
    // unit approvals: exactly "approve <that unit>"
    for (const text of ['approve sc2_sh4', 'Approve sc2_sh4', 'APPROVE sc2_sh4']) {
      assert.equal(unit(fold(fixture(), [dec('approve', 'sc2_sh4', 1, { ...chat, text })]).project, 'sc2_sh4').status, 'approved', text);
    }
    for (const text of ['yes', 'go ahead', 'approve', 'approve all', 'approve sc2_sh4 and sc4_sh2', 'approve sc4_sh2', 'approve sc2_sh4 please', 'approve SC2_SH4']) {
      const r = fold(fixture(), [dec('approve', 'sc2_sh4', 1, { ...chat, text })]);
      assert.equal(unit(r.project, 'sc2_sh4').status, 'pending-review', text);
      assert.equal(r.report.rejected[0]?.code, 'chat-without-words', text);
    }
    // spend approvals: exactly the gate's reply words
    for (const text of ['approve 0.36 USD', 'Approve 0.36 USD']) assert.equal(job(fold(fixture(), [dec('approve-spend', 'job_kf_sc1', 1, { ...chat, text })]).project).status, 'approved', text);
    for (const text of ['yes', 'approve', 'approve all', 'approve 0.36 USD and the next one', 'ok approve 0.36 USD']) {
      assert.equal(job(fold(fixture(), [dec('approve-spend', 'job_kf_sc1', 1, { ...chat, text })]).project).status, 'awaiting-approval', text);
    }
    // undo: never from chat (the reviewer's probe: a text-less chat undo flipped needs-rework → approved)
    const ap = dec('approve', 'sc2_sh3', 1);
    const rc = dec('request-changes', 'sc2_sh3', 2, { text: 'no' });
    const p = fold(fixture(), [ap, rc]).project;
    assert.equal(unit(p, 'sc2_sh3').status, 'needs-rework');
    const r = fold(p, [dec('undo', 'sc2_sh3', 3, { ...chat, undoes: rc.id })]);
    assert.equal(unit(r.project, 'sc2_sh3').status, 'needs-rework');
    assert.equal(r.report.rejected[0]?.code, 'chat-undo');
  });

  it('two different new copies of one id resolve the same way in either order', () => {
    const a = dec('note', 'sc2_sh4', 1, { text: 'real' });
    const b = { ...a, text: 'forged' } as Decision;
    assert.equal(bytes(fold(fixture(), [a, b]).project), bytes(fold(fixture(), [b, a]).project));
    assert.equal(fold(fixture(), [a, b]).report.rejected[0]?.code, 'conflict');
  });

  it('no folded project gains an approved unit without a person\'s approval behind it', () => {
    const before = new Set([...fixture().shots, ...fixture().assets].filter((u) => u.status === 'approved').map((u) => u.id));
    for (let seed = 1; seed <= 10; seed++) {
      const p = fold(fixture(), shuffle(recorded(), seed)).project;
      for (const u of [...p.shots, ...p.assets]) {
        if (u.status !== 'approved' || before.has(u.id)) continue;
        const why = p.decisions.find((d) => d.action === 'approve' && d.unit === u.id && !isAgentAuthor(d.by) && d.view === BOARD);
        assert.ok(why, `${u.id} approved without a person's conformed approval`);
      }
    }
  });
});

describe('units and stages', () => {
  it('a decision for an older stage of a unit is refused, with a notice', () => {
    const r = fold(fixture(), [dec('approve', 'sc2_sh4', 1, { stage: 'breakdown' })]);
    assert.equal(r.report.rejected[0]?.code, 'stale-stage');
    assert.equal(unit(r.project, 'sc2_sh4').status, 'pending-review');
  });

  it('a unit with nothing produced yet cannot be approved', () => {
    const r = fold(fixture(), [dec('approve', 'char_officers', 1)]);
    assert.equal(r.report.rejected[0]?.code, 'not-reviewable');
    assert.equal(unit(r.project, 'char_officers').status, 'pending');
  });

  it('decisions about units the project does not have are reported, not stored', () => {
    const r = fold(fixture(), [dec('approve', 'sc9_sh9', 1), dec('approve-spend', 'job_nope', 2, { text: 'approve 1 USD' })]);
    assert.deepEqual(r.report.rejected.map((x) => x.code), ['unknown-unit', 'unknown-unit']);
    assert.deepEqual(r.project.decisions, []);
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('approving the last units of a stage approves the stage and opens the next; an undo re-opens it', () => {
    const ds = [dec('approve', 'sc2_sh3', 1), dec('approve', 'sc2_sh4', 2), dec('approve', 'sc4_sh2', 3)];
    const p = fold(fixture(), ds).project;
    assert.equal(p.stages.sketch.state, 'approved');
    assert.equal(p.current_stage, 'bible');
    const back = fold(p, [dec('undo', 'sc4_sh2', 4, { undoes: ds[2]!.id })]).project;
    assert.equal(back.stages.sketch.state, 'in-review');
    assert.equal(back.current_stage, 'sketch');
  });

  it('updated_at follows the decisions, not the clock', () => {
    const ap = dec('approve', 'sc2_sh4', 7);
    const p = fold(fixture(), [ap]).project;
    assert.equal(unit(p, 'sc2_sh4').updated_at, ap.at);
    assert.equal(p.project.updated_at, ap.at);
  });
});

describe('spend decisions', () => {
  const approve = (min: number, text = 'approve 0.36 USD') => dec('approve-spend', 'job_kf_sc1', min, { text });

  it('approve-spend with the amount shown approves the job and records the decision', () => {
    const d = approve(1);
    const p = fold(fixture(), [d]).project;
    assert.deepEqual([job(p).status, job(p).decision], ['approved', d.id]);
  });

  it('a stale approval does not fold onto a higher estimate (quote() rewrote it)', () => {
    const p0 = fixture();
    job(p0).estimate = 0.48;
    const d = approve(1);
    const r = fold(p0, [d]);
    assert.equal(job(r.project).status, 'awaiting-approval');
    assert.equal(r.report.rejected[0]?.code, 'spend-refused');
    assert.match(r.report.rejected[0]!.reason, /0\.36 USD.*0\.48 USD/);
    assert.equal(bytes(fold(r.project, [d]).project), bytes(r.project), 'and it stays refused');
    const again = approve(2, 'approve 0.48 USD');
    assert.equal(job(fold(r.project, [again]).project).status, 'approved', 'a fresh approval of the new amount works');
  });

  it('an approval without the amount, or in another currency, is refused', () => {
    for (const text of ['ok', 'approve', 'approve 0.36 EUR', '']) {
      const r = fold(fixture(), [approve(1, text)]);
      assert.equal(job(r.project).status, 'awaiting-approval', text);
    }
  });

  it('decline, then undo, returns the job to awaiting approval', () => {
    const no = dec('decline-spend', 'job_kf_sc1', 1);
    const p1 = fold(fixture(), [no]).project;
    assert.equal(job(p1).status, 'declined');
    const p2 = fold(p1, [dec('undo', 'job_kf_sc1', 2, { undoes: no.id })]).project;
    assert.equal(job(p2).status, 'awaiting-approval');
    assert.equal(job(p2).decision, undefined);
  });

  it('the latest spend decision wins, whatever order they arrive in', () => {
    const a = approve(1);
    const b = dec('decline-spend', 'job_kf_sc1', 2);
    assert.equal(job(fold(fold(fixture(), [b]).project, [a]).project).status, 'declined');
    assert.equal(job(fold(fixture(), [a, b]).project).status, 'declined');
  });

  it('an approval cannot be undone once the job has run', () => {
    const a = approve(1);
    const p = fold(fixture(), [a]).project;
    p.ledger.push({ id: 'job_kf_sc1.sc1_sh1.1', ts: '2026-11-07T12:05:00Z', provider: 'Gemini image', unit: 'sc1_sh1', job: 'job_kf_sc1', estimate: 0.12, status: 'submitted' });
    const r = fold(p, [dec('undo', 'job_kf_sc1', 9, { undoes: a.id })]);
    assert.equal(job(r.project).status, 'approved');
    assert.equal(r.report.rejected[0]?.code, 'already-ran');
  });

  it('an approval refused for the cap is not revived when the cap is raised: the person is told to approve again, and a fresh approval works', () => {
    // Wave 3 review, finding 2. lib/state.md §Decision folding: a refused approve-spend never took
    // effect; the job stays waiting and the person approves again (consent is to an amount, now).
    const p0 = fixture();
    p0.budget = { ...p0.budget!, cap: 1 }; // 0.84 spent: 0.16 left, the job is 0.36
    const d = approve(1);
    const r = fold(p0, [d]);
    assert.equal(job(r.project).status, 'awaiting-approval');
    assert.equal(r.report.rejected[0]?.code, 'spend-refused');
    assert.match(r.report.rejected[0]!.reason, /Raise the cap/);
    assert.match(r.report.rejected[0]!.reason, /approve it again on the board/, 'the refusal says the approval was not kept');
    // setup raises the cap; the store still holds the refused approval and is folded again
    const raised = structuredClone(r.project);
    raised.budget = { ...raised.budget!, cap: 15 };
    const again = fold(raised, [d]);
    assert.equal(job(again.project).status, 'awaiting-approval', 'a refused approval stays refused');
    assert.equal(again.report.changed, false);
    const fresh = approve(2);
    const ok = fold(raised, [d, fresh]);
    assert.deepEqual([job(ok.project).status, job(ok.project).decision], ['approved', fresh.id]);
  });

  it('no budget: the refusal also says to approve again once a cap is set', () => {
    const p0 = fixture();
    p0.budget = null;
    p0.ledger = [];
    const r = fold(p0, [approve(1)]);
    assert.match(r.report.rejected[0]!.reason, /setup.*approve it again on the board/s);
  });

  it('no budget, no approval', () => {
    const p0 = fixture();
    p0.budget = null;
    p0.ledger = [];
    assert.equal(job(fold(p0, [approve(1)]).project).status, 'awaiting-approval');
  });
});
