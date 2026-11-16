// Review in chat (actions/review.md §1b): review/chat.ts next / decide / batch, on hosts B/C
// (a project folder) and A (a saved akuko/project doc). Only the exact reply counts (R-12).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema as S, findUnit, type AkukoProject, type Decision } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { batchDecisions, batchPreview, decideUnit, nextUnit, run, unitReplies, waitingUnits } from './chat.ts';
import { addFlag, FlagError, listFlags } from './flags.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/the-beating/akuko.json', import.meta.url));
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const AT = '2026-11-15T10:00:00Z';
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof FlagError ? e.code : String(e); } };
const status = (p: AkukoProject, id: string) => findUnit(p, id)!.unit.status;

/** The fixture, with files on the two bible images so a bible batch has something to take. */
function project(): AkukoProject {
  const p = S.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  for (const a of p.assets) if (a.id === 'char_oldman_turnaround' || a.id === 'loc_bedroom_plate') a.file = { uri: `bible/${a.id}.png`, mime: 'image/png' };
  return p;
}

describe('chat review: next', () => {
  it('walks what is waiting, oldest first, with what to show and the exact replies; filters by stage and kind; skips', () => {
    const p = project();
    const all = waitingUnits(p).map((x) => x.unit.id);
    assert.deepEqual(all, ['char_oldman', 'char_oldman_turnaround', 'loc_bedroom', 'loc_bedroom_plate', 'sc2_sh4', 'sc4_sh2']);
    const n = nextUnit(p)!;
    assert.deepEqual([n.unit, n.kind, n.name, n.remaining], ['char_oldman', 'character', 'The Old Man', 5]);
    assert.deepEqual(n.replies, { approve: 'approve char_oldman', 'send-back': 'send back char_oldman' });
    assert.equal(nextUnit(p, { kind: 'plate' })!.unit, 'loc_bedroom_plate');
    assert.equal(nextUnit(p, { kind: 'plate' })!.file, 'bible/loc_bedroom_plate.png');
    assert.equal(nextUnit(p, { stage: 'sketch' })!.unit, 'sc2_sh4');
    assert.equal(nextUnit(p, { stage: 'sketch', skip: ['sc2_sh4'] })!.unit, 'sc4_sh2');
    assert.equal(nextUnit(p, { stage: 'sketch', skip: ['sc2_sh4', 'sc4_sh2'] }), undefined);
    const flagged = addFlag(p, { unit: 'sc2_sh4', kind: 'anatomy', text: 'Long slender neck', evidence: { uri: 'a.png' } }, { id: 'flag_aaaaaaaa', now: AT }).project;
    assert.deepEqual(nextUnit(flagged, { stage: 'sketch' })!.open_flags.map((f) => f.id), ['flag_aaaaaaaa']);
  });
});

describe('chat review: decide', () => {
  it('approve counts only on the exact reply; send-back needs their words; agents are refused', () => {
    const p = project();
    const ap = decideUnit(p, { unit: 'sc4_sh2', action: 'approve', said: 'Approve sc4_sh2', at: AT });
    assert.deepEqual(ap.map((d) => [d.action, d.unit, d.stage, d.view, d.by, d.text]), [['approve', 'sc4_sh2', 'sketch', 'chat@1', 'you', 'Approve sc4_sh2']]);
    assert.equal(status(foldDecisions(p, ap).project, 'sc4_sh2'), 'approved');
    for (const said of [undefined, 'yes', 'looks good', 'approve', 'approve sc2_sh4', 'approve all']) {
      assert.equal(code(() => decideUnit(p, { unit: 'sc4_sh2', action: 'approve', said })), 'not-exact', String(said));
    }
    assert.equal(code(() => decideUnit(p, { unit: 'sc4_sh2', action: 'approve', said: 'approve sc4_sh2', by: 'claude' })), 'not-a-person');
    assert.equal(code(() => decideUnit(p, { unit: 'sc4_sh2', action: 'send-back' })), 'invalid');
    assert.equal(code(() => decideUnit(p, { unit: 'nope', action: 'send-back', text: 'x' })), 'unknown-unit');
    const sb = decideUnit(p, { unit: 'sc4_sh2', action: 'send-back', text: 'He should be much taller.', at: AT });
    assert.deepEqual(sb.map((d) => [d.action, d.view, d.text]), [['request-changes', 'chat@1', 'He should be much taller.']]);
    assert.equal(status(foldDecisions(p, sb).project, 'sc4_sh2'), 'needs-rework');
  });

  it('on a unit with open flags, approve as is dismisses every open flag on it (the same path as flags.ts decide)', () => {
    let p = project();
    p = addFlag(p, { unit: 'sc2_sh4', kind: 'anatomy', text: 'Long slender neck', evidence: { uri: 'a.png' } }, { id: 'flag_aaaaaaaa', now: AT }).project;
    p = addFlag(p, { unit: 'sc2_sh4', kind: 'continuity', text: 'Lantern on the wrong side', evidence: { uri: 'a.png' } }, { id: 'flag_bbbbbbbb', now: AT }).project;
    const ds = decideUnit(p, { unit: 'sc2_sh4', action: 'approve', said: 'approve sc2_sh4', at: AT });
    assert.deepEqual(ds.map((d) => [d.action, 'flag' in d ? d.flag : undefined]), [['approve', undefined], ['dismiss-flag', 'flag_aaaaaaaa'], ['dismiss-flag', 'flag_bbbbbbbb']]);
    const r = foldDecisions(p, ds);
    assert.deepEqual(r.report.rejected, []);
    assert.equal(status(r.project, 'sc2_sh4'), 'approved');
    assert.deepEqual(listFlags(r.project, { all: true }).map((x) => x.flag.status), ['dismissed', 'dismissed']);
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('CLI on a folder (B/C): appends and folds; a refusal writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-chat-'));
    tmp.push(dir);
    writeFileSync(join(dir, 'akuko.json'), JSON.stringify(project(), null, 2));
    const before = readFileSync(join(dir, 'akuko.json'), 'utf8');
    let r = await run(['decide', '--project', dir, '--unit', 'sc4_sh2', '--action', 'approve', '--said', 'ok']);
    assert.deepEqual([r.code, (r.out as { code: string }).code], [1, 'not-exact']);
    assert.equal(readFileSync(join(dir, 'akuko.json'), 'utf8'), before);
    r = await run(['next', '--project', dir, '--stage', 'sketch']);
    assert.equal((r.out as { unit: string }).unit, 'sc2_sh4');
    r = await run(['decide', '--project', dir, '--unit', 'sc4_sh2', '--action', 'approve', '--said', 'approve sc4_sh2', '--by', 'you', '--via', 'chat']);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    const lines = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Decision);
    assert.deepEqual(lines.map((d) => [d.action, d.unit, d.view]), [['approve', 'sc4_sh2', 'chat@1']]);
    assert.equal(status(S.parse(JSON.parse(readFileSync(join(dir, 'akuko.json'), 'utf8'))), 'sc4_sh2'), 'approved');
  });
});

describe('chat review: confirmed batch', () => {
  it('previews the board\'s list (waiting, with a file, no open block flag) and the one exact reply', () => {
    let p = project();
    let pv = batchPreview(p, 'bible');
    assert.deepEqual([pv.count, pv.reply], [pv.units.length, `approve all ${pv.units.length} bible items`]);
    assert.ok(pv.units.some((u) => u.unit === 'loc_bedroom_plate') && pv.units.every((u) => u.status === 'pending-review' && u.stage === 'bible'));
    pv = batchPreview(p, 'bible', { kind: 'plate' });
    assert.deepEqual([pv.count, pv.reply, pv.units.map((u) => u.unit)], [1, 'approve all 1 bible plates', ['loc_bedroom_plate']]);
    p = addFlag(p, { unit: 'loc_bedroom_plate', kind: 'style-drift', severity: 'block', text: 'Near-photographic, not clay style' }, { id: 'flag_cccccccc', now: AT }).project;
    pv = batchPreview(p, 'bible', { kind: 'plate' });
    assert.deepEqual([pv.count, pv.left_out], [0, [{ unit: 'loc_bedroom_plate', why: 'open block flag: decide on it on its own' }]]);
    const noFile = batchPreview(S.parse(JSON.parse(readFileSync(FIXTURE, 'utf8'))), 'bible', { kind: 'plate' });
    assert.deepEqual(noFile.left_out, [{ unit: 'loc_bedroom_plate', why: 'no file yet' }]);
    assert.equal(code(() => batchPreview(p, 'everything')), 'invalid');
  });

  it('records one approve per listed unit only on the exact reply for the list as it is now, and folds them', () => {
    const p = project();
    const pv = batchPreview(p, 'bible');
    for (const said of ['approve all', 'approve all bible items', `approve all ${pv.count + 1} bible items`, 'yes, all of them']) {
      assert.equal(code(() => batchDecisions(p, { scope: 'bible', said })), 'not-exact', said);
    }
    assert.equal(code(() => batchDecisions(p, { scope: 'bible', said: pv.reply, by: 'agent' })), 'not-a-person');
    const ds = batchDecisions(p, { scope: 'bible', said: `Approve all ${pv.count} bible items`, at: AT, batch: '11111111-2222-4333-8444-555555555555' });
    assert.deepEqual(ds.map((d) => d.unit), pv.units.map((u) => u.unit));
    assert.ok(ds.every((d) => d.action === 'approve' && d.view === 'chat@1' && d.text === `Approve all ${pv.count} bible items · batch 11111111-2222-4333-8444-555555555555`));
    const r = foldDecisions(p, ds);
    assert.deepEqual(r.report.rejected, []);
    for (const u of pv.units) assert.equal(status(r.project, u.unit), 'approved', u.unit);
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('folding refuses a chat batch that is not exactly what the reply names: missing records, a changed text, a unit twice', () => {
    const p = project();
    const pv = batchPreview(p, 'bible');
    const ds = batchDecisions(p, { scope: 'bible', said: pv.reply, at: AT });
    const codes = (x: Decision[]) => foldDecisions(p, x).report.rejected.map((r) => r.code);
    assert.deepEqual(codes(ds.slice(1)), Array(ds.length - 1).fill('chat-batch-mismatch'), 'one record missing');
    const r = foldDecisions(p, ds.slice(1));
    for (const u of pv.units) assert.equal(status(r.project, u.unit), 'pending-review', u.unit);
    const changed = ds.map((d, i) => (i === 0 ? { ...d, text: d.text!.replace('approve all', 'approve all ') } : d));
    assert.ok(codes(changed).length > 0 && codes(changed).every((c) => c === 'chat-batch-mismatch' || c === 'chat-without-words'));
    const twice = [...ds.slice(0, -1), { ...ds[0]!, id: '99999999-2222-4333-8444-555555555555' }];
    assert.deepEqual(codes(twice), Array(ds.length).fill('chat-batch-mismatch'));
  });

  it('CLI batch on a saved doc (A): preview writes nothing; the exact reply writes the folded project to --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-chat-a-'));
    tmp.push(dir);
    const src = join(dir, 'project.json'), out = join(dir, 'batched.json');
    writeFileSync(src, JSON.stringify(project(), null, 2));
    const orig = readFileSync(src, 'utf8');
    let r = await run(['batch', '--project-file', src, '--scope', 'bible', '--kind', 'plate']);
    const pv = r.out as { reply: string; count: number };
    assert.deepEqual([r.code, pv.count, pv.reply], [0, 1, 'approve all 1 bible plates']);
    r = await run(['batch', '--project-file', src, '--out', out, '--scope', 'bible', '--kind', 'plate', '--said', 'approve all 2 bible plates']);
    assert.deepEqual([r.code, (r.out as { code: string }).code], [1, 'not-exact']);
    r = await run(['batch', '--project-file', src, '--out', out, '--scope', 'bible', '--kind', 'plate', '--said', pv.reply]);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(readFileSync(src, 'utf8'), orig);
    assert.equal(status(S.parse(JSON.parse(readFileSync(out, 'utf8'))), 'loc_bedroom_plate'), 'approved');
    assert.deepEqual(unitReplies('x'), { approve: 'approve x', 'send-back': 'send back x' });
  });
});
