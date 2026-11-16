// AI quality flags (lib/state.md §Quality flags): review/flags.ts add / list / clear, on hosts B/C
// (a project folder) and A (a saved akuko/project doc), with the five E01 findings as fixtures.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema, AkukoProjectSchema as S, FlagSchema, findUnit, type AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { FLAG_EXAMPLES } from '../scripts/check-view/expected.mjs';
import { addFlag, chatReplies, clearFlags, decideFlag, FlagError, listFlags, nextFlag, run } from './flags.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FIXTURE = here('../fixtures/the-beating/akuko.json');
const fixture = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const NOW = '2026-11-14T09:00:00Z';

/** A project folder with the fixture and a real file for the turnaround, so add can hash it. */
function folder(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'akuko-flags-'));
  tmp.push(dir);
  const p = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const uri = 'bible/characters/char_oldman/refs/char_oldman_turnaround.png';
  p.assets.find((a: { id: string }) => a.id === 'char_oldman_turnaround').file = { uri, mime: 'image/png' };
  mkdirSync(join(dir, 'bible/characters/char_oldman/refs'), { recursive: true });
  const bytes = Buffer.from('not really a png');
  writeFileSync(join(dir, uri), bytes);
  writeFileSync(join(dir, 'akuko.json'), JSON.stringify(p, null, 2));
  return { dir, sha: createHash('sha256').update(bytes).digest('hex') };
}
const read = (dir: string): AkukoProject => S.parse(JSON.parse(readFileSync(join(dir, 'akuko.json'), 'utf8')));

describe('flags: add', () => {
  it('records each E01 finding as an open flag on the unit\'s current stage, and changes nothing else', () => {
    // where each finding lands in the fixture (the stages differ: a sketch shot, bible images, a bible entry)
    const at = ['char_oldman_turnaround', 'loc_bedroom_plate', 'char_oldman_turnaround', 'sc4_sh2', 'char_oldman_turnaround'];
    let p = fixture();
    const before = structuredClone(p);
    FLAG_EXAMPLES.forEach((ex, i) => {
      p = addFlag(p, { unit: at[i]!, kind: ex.kind as never, severity: ex.severity as never, text: ex.text, suggested_change: ex.suggested_change, source: 'agent:claude-opus-5-5', evidence: { uri: `look/${i}.png`, view: i === 4 ? 'front' : undefined } }, { now: NOW, id: `flag_e01e01${String(i).padStart(2, '0')}` }).project;
    });
    assert.deepEqual(checkIntegrity(p), []);
    const listed = listFlags(p);
    assert.deepEqual(listed.map((x) => [x.unit, x.flag.kind, x.flag.text]), [
      ['sc4_sh2', 'anatomy', 'Tom looks short; should be ~6\'5"'],
      ['char_oldman_turnaround', 'anatomy', 'Long slender neck'],
      ['char_oldman_turnaround', 'wardrobe-logo', 'Patch on cap; bible says plain cap'],
      ['char_oldman_turnaround', 'text-in-image', 'Name label dropped from turnaround'],
      ['loc_bedroom_plate', 'style-drift', 'Near-photographic, not clay style'],
    ]);
    for (const x of listed) {
      assert.ok(FlagSchema.safeParse(x.flag).success);
      assert.equal(x.flag.status, 'open');
      assert.equal(x.flag.stage, findUnit(p, x.unit)!.unit.stage);
      assert.equal(x.flag.source, 'agent:claude-opus-5-5');
    }
    // statuses, comments, stages, spend and decisions are exactly as before
    for (const { unit } of [...p.shots.map((u) => ({ unit: u })), ...p.assets.map((u) => ({ unit: u }))]) {
      const b = findUnit(before, unit.id)!.unit;
      assert.equal(unit.status, b.status, unit.id);
      assert.deepEqual(unit.comments, b.comments, unit.id);
    }
    assert.deepEqual([p.stages, p.pending_spend, p.decisions], [before.stages, before.pending_spend, before.decisions]);
  });

  it('refuses what cannot be flagged: unknown unit, nothing produced, an older stage, no file, the same finding twice', () => {
    const p = fixture();
    const nf = { kind: 'anatomy' as const, text: 'Long slender neck', evidence: { uri: 'x.png' } };
    const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof FlagError ? e.code : String(e); } };
    assert.equal(code(() => addFlag(p, { ...nf, unit: 'nope' })), 'unknown-unit');
    assert.equal(code(() => addFlag(p, { ...nf, unit: 'char_officers' })), 'nothing-produced');
    assert.equal(code(() => addFlag(p, { ...nf, unit: 'sc2_sh4', stage: 'breakdown' })), 'stale-stage');
    assert.equal(code(() => addFlag(p, { kind: 'anatomy', text: 'x', unit: 'char_oldman' })), 'no-evidence');
    const once = addFlag(p, { ...nf, unit: 'sc2_sh4' }).project;
    assert.equal(code(() => addFlag(once, { ...nf, unit: 'sc2_sh4' })), 'duplicate');
    assert.equal(code(() => addFlag(once, { ...nf, unit: 'sc2_sh4', evidence: { uri: 'y.png' } })), 'ok', 'about another file it is a new flag');
  });

  it('CLI on a folder (B/C): evidence from the unit\'s file, hashed from disk; the status stays; list and clear', async () => {
    const { dir, sha } = folder();
    const before = read(dir);
    let r = await run(['add', '--project', dir, '--unit', 'char_oldman_turnaround', '--kind', 'wardrobe-logo', '--severity', 'warn', '--text', 'Patch on cap; bible says plain cap', '--suggest', 'Plain cap with no patch.', '--source', 'agent:claude-opus-5-5', '--view', 'front', '--region', '0.4,0.05,0.2,0.15']);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    const flag = (r.out as { flag: { id: string; evidence: Record<string, unknown> } }).flag;
    assert.deepEqual(flag.evidence, { uri: 'bible/characters/char_oldman/refs/char_oldman_turnaround.png', sha256: sha, asset: 'char_oldman_turnaround', view: 'front', region: { x: 0.4, y: 0.05, w: 0.2, h: 0.15 } });
    const p = read(dir);
    const a = p.assets.find((x) => x.id === 'char_oldman_turnaround')!;
    assert.equal(a.status, before.assets.find((x) => x.id === 'char_oldman_turnaround')!.status);
    assert.equal(a.by_stage!.bible!.flags!.length, 1);
    r = await run(['list', '--project', dir]);
    assert.equal((r.out as { count: number }).count, 1);
    r = await run(['add', '--project', dir, '--unit', 'char_oldman_turnaround', '--kind', 'wardrobe-logo', '--text', 'Patch on cap; bible says plain cap', '--view', 'front']);
    assert.deepEqual([r.code, (r.out as { code: string }).code], [1, 'duplicate']);
    r = await run(['add', '--project', dir, '--unit', 'char_oldman_turnaround', '--kind', 'nope', '--text', 'x']);
    assert.deepEqual([r.code, (r.out as { code: string }).code], [1, 'invalid']);
    r = await run(['clear', '--project', dir, '--flag', flag.id]);
    assert.deepEqual((r.out as { cleared: string[] }).cleared, [flag.id]);
    assert.equal(read(dir).assets.find((x) => x.id === 'char_oldman_turnaround')!.by_stage!.bible!.flags, undefined);
  });

  it('CLI on a saved doc (A): --project-file … --out, nothing else touched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-flags-a-'));
    tmp.push(dir);
    const src = join(dir, 'project.json'), out = join(dir, 'flagged.json');
    cpSync(FIXTURE, src);
    const r = await run(['add', '--project-file', src, '--out', out, '--unit', 'sc2_sh4', '--kind', 'anatomy', '--text', 'Long slender neck', '--uri', 'board/panels/sc2_sh4-sketch.svg']);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(readFileSync(src, 'utf8'), readFileSync(FIXTURE, 'utf8'), 'the input doc is never written');
    const p = S.parse(JSON.parse(readFileSync(out, 'utf8')));
    assert.equal(p.shots.find((s) => s.id === 'sc2_sh4')!.by_stage!.sketch!.flags![0]!.text, 'Long slender neck');
    const noOut = await run(['add', '--project-file', src, '--unit', 'sc4_sh2', '--kind', 'anatomy', '--text', 'x', '--uri', 'y.png']);
    assert.equal(noOut.code, 1);
  });
});

describe('flags: clear never removes the record', () => {
  it('a flag a person closed stays; clearing it by id is refused; clearing a unit withdraws only its open flags', () => {
    let p = fixture();
    p = addFlag(p, { unit: 'sc2_sh4', kind: 'anatomy', text: 'Long slender neck', evidence: { uri: 'a.png' } }, { id: 'flag_aaaaaaaa', now: NOW }).project;
    p = addFlag(p, { unit: 'sc2_sh4', kind: 'continuity', text: 'Lantern on the wrong side', evidence: { uri: 'a.png' } }, { id: 'flag_bbbbbbbb', now: NOW }).project;
    const d = { id: '00000000-0000-4000-8000-0000000000f1', action: 'dismiss-flag' as const, unit: 'sc2_sh4', stage: 'sketch' as const, flag: 'flag_aaaaaaaa', by: 'you', at: '2026-11-14T10:00:00Z', view: 'chat@1', text: 'dismiss flag_aaaaaaaa' };
    p = foldDecisions(p, [d]).project;
    assert.throws(() => clearFlags(p, { ids: ['flag_aaaaaaaa'] }), (e: unknown) => e instanceof FlagError && e.code === 'closed');
    assert.throws(() => clearFlags(p, { ids: ['flag_cccccccc'] }), (e: unknown) => e instanceof FlagError && e.code === 'unknown-flag');
    const r = clearFlags(p, { unit: 'sc2_sh4' });
    assert.deepEqual(r.cleared.map((f) => f.id), ['flag_bbbbbbbb']);
    assert.deepEqual(listFlags(r.project, { all: true }).map((x) => [x.flag.id, x.flag.status]), [['flag_aaaaaaaa', 'dismissed']]);
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('list marks a flag about an earlier take once the unit\'s file changed', () => {
    let p = fixture();
    const a = p.assets.find((x) => x.id === 'char_oldman_turnaround')!;
    a.file = { uri: 'bible/t.png', hash: 'a'.repeat(64) };
    p = addFlag(p, { unit: a.id, kind: 'anatomy', text: 'Long slender neck' }).project;
    assert.equal(listFlags(p)[0]!.earlier_take, false);
    p.assets.find((x) => x.id === a.id)!.file!.hash = 'b'.repeat(64);
    assert.equal(listFlags(p)[0]!.earlier_take, true);
  });
});

describe('flags in chat: next and decide', () => {
  const two = (): AkukoProject => {
    let p = fixture();
    p = addFlag(p, { unit: 'sc2_sh4', kind: 'anatomy', text: 'Long slender neck', suggested_change: 'Shorter, thicker neck, as in the bible.', evidence: { uri: 'board/panels/sc2_sh4-sketch.svg' } }, { id: 'flag_bbbbbbbb', now: '2026-11-14T09:05:00Z' }).project;
    p = addFlag(p, { unit: 'sc4_sh2', kind: 'anatomy', text: 'Tom looks short; should be ~6\'5"', evidence: { uri: 'board/panels/sc4_sh2-sketch.svg' } }, { id: 'flag_aaaaaaaa', now: '2026-11-14T09:05:00Z' }).project;
    return addFlag(p, { unit: 'sc2_sh4', kind: 'continuity', text: 'Lantern on the wrong side', evidence: { uri: 'board/panels/sc2_sh4-sketch.svg' } }, { id: 'flag_00000000', now: '2026-11-14T09:10:00Z' }).project;
  };
  const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof FlagError ? e.code : String(e); } };

  it('next is the oldest open flag (then by id), with what to show, how many are left, and the exact replies', () => {
    const p = two();
    const n = nextFlag(p)!;
    assert.deepEqual([n.flag.id, n.unit, n.remaining], ['flag_aaaaaaaa', 'sc4_sh2', 2]);
    assert.deepEqual(n.replies, { approve: 'approve sc4_sh2', 'send-back': 'send back flag_aaaaaaaa', dismiss: 'dismiss flag_aaaaaaaa' });
    assert.equal(nextFlag(p, { skip: ['flag_aaaaaaaa'] })!.flag.id, 'flag_bbbbbbbb');
    assert.equal(nextFlag(p, { skip: ['flag_aaaaaaaa', 'flag_bbbbbbbb', 'flag_00000000'] }), undefined);
    assert.deepEqual(chatReplies('u', 'flag_x'), { approve: 'approve u', 'send-back': 'send back flag_x', dismiss: 'dismiss flag_x' });
  });

  it('decide turns only the explicit reply into chat@1 decisions; anything else is refused', () => {
    const p = two();
    const at = '2026-11-14T11:00:00Z';
    const ap = decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'approve', said: 'Approve sc2_sh4', at });
    assert.deepEqual(ap.map((d) => [d.action, d.unit, d.stage, d.view, d.by, d.text]), [
      ['approve', 'sc2_sh4', 'sketch', 'chat@1', 'you', 'Approve sc2_sh4'],
      ['dismiss-flag', 'sc2_sh4', 'sketch', 'chat@1', 'you', 'Approve sc2_sh4'],
      ['dismiss-flag', 'sc2_sh4', 'sketch', 'chat@1', 'you', 'Approve sc2_sh4'],
    ]);
    assert.deepEqual(ap.slice(1).map((d) => ('flag' in d ? d.flag : '')), ['flag_bbbbbbbb', 'flag_00000000'], 'approving as is overrules every open flag on the unit');
    const sb = decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'send-back', at });
    assert.deepEqual(sb.map((d) => [d.action, d.text, 'flag' in d ? d.flag : undefined]), [['request-changes', 'Shorter, thicker neck, as in the bible.', 'flag_bbbbbbbb']]);
    assert.equal(decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'send-back', text: 'Neck a third shorter.' })[0]!.text, 'Neck a third shorter.');
    assert.deepEqual(decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'dismiss', said: 'dismiss flag_bbbbbbbb' }).map((d) => d.action), ['dismiss-flag']);
    assert.equal(code(() => decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'approve', said: 'yes, looks fine' })), 'not-exact');
    assert.equal(code(() => decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'approve' })), 'not-exact');
    assert.equal(code(() => decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'approve', said: 'approve sc4_sh2' })), 'not-exact');
    assert.equal(code(() => decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'dismiss', said: 'dismiss' })), 'not-exact');
    assert.equal(code(() => decideFlag(p, { flag: 'flag_bbbbbbbb', action: 'dismiss', said: 'dismiss flag_bbbbbbbb', by: 'agent' })), 'not-a-person');
    assert.equal(code(() => decideFlag(p, { flag: 'flag_aaaaaaaa', action: 'send-back' })), 'invalid', 'no suggestion and no words of their own');
    assert.equal(code(() => decideFlag(p, { flag: 'flag_nope0000', action: 'send-back', text: 'x' })), 'unknown-flag');
    // folded, the approval approves the unit and closes the flag, as the board would
    const folded = foldDecisions(p, ap).project;
    assert.equal(folded.shots.find((s) => s.id === 'sc2_sh4')!.status, 'approved');
    assert.equal(listFlags(folded, { all: true }).find((x) => x.flag.id === 'flag_bbbbbbbb')!.flag.status, 'dismissed');
    assert.deepEqual(checkIntegrity(folded), []);
    assert.equal(code(() => decideFlag(folded, { flag: 'flag_bbbbbbbb', action: 'dismiss', said: 'dismiss flag_bbbbbbbb' })), 'closed');
  });

  it('CLI decide on a folder (B/C): appends to decisions.jsonl and folds; a refusal writes nothing; next moves on', async () => {
    const { dir } = folder();
    let r = await run(['add', '--project', dir, '--unit', 'char_oldman_turnaround', '--kind', 'wardrobe-logo', '--text', 'Patch on cap; bible says plain cap', '--suggest', 'Plain cap with no patch.']);
    const flag = (r.out as { flag: { id: string } }).flag.id;
    r = await run(['next', '--project', dir]);
    const n = r.out as { flag: { id: string }; path: string; remaining: number };
    assert.deepEqual([n.flag.id, n.remaining], [flag, 0]);
    assert.equal(n.path, join(dir, 'bible/characters/char_oldman/refs/char_oldman_turnaround.png'));
    const before = readFileSync(join(dir, 'akuko.json'), 'utf8');
    r = await run(['decide', '--project', dir, '--flag', flag, '--action', 'approve', '--said', 'sure']);
    assert.deepEqual([r.code, (r.out as { code: string }).code], [1, 'not-exact']);
    r = await run(['decide', '--project', dir, '--flag', flag, '--action', 'dismiss', '--said', `dismiss ${flag}`, '--by', 'claude']);
    assert.deepEqual([r.code, (r.out as { code: string }).code], [1, 'not-a-person']);
    assert.equal(readFileSync(join(dir, 'akuko.json'), 'utf8'), before, 'a refusal writes nothing');
    r = await run(['decide', '--project', dir, '--flag', flag, '--action', 'send-back', '--by', 'you', '--via', 'chat']);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    const lines = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((d) => [d.action, d.view, d.flag, d.text]), [['request-changes', 'chat@1', flag, 'Plain cap with no patch.']]);
    const a = read(dir).assets.find((x) => x.id === 'char_oldman_turnaround')!;
    assert.equal(a.status, 'needs-rework');
    assert.equal(a.by_stage!.bible!.flags![0]!.status, 'accepted');
    assert.deepEqual((await run(['next', '--project', dir])).out, { ok: true, done: true, remaining: 0, message: 'No open flags left.' });
    r = await run(['decide', '--project', dir, '--flag', flag, '--action', 'dismiss', '--said', `dismiss ${flag}`]);
    assert.deepEqual([r.code, (r.out as { code: string }).code], [1, 'closed']);
  });

  it('CLI decide on a saved doc (A): writes the folded project to --out and prints the rows; the input is untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-flags-a-'));
    tmp.push(dir);
    const src = join(dir, 'project.json'), out = join(dir, 'decided.json');
    writeFileSync(src, JSON.stringify(two(), null, 2));
    const orig = readFileSync(src, 'utf8');
    const r = await run(['decide', '--project-file', src, '--out', out, '--flag', 'flag_bbbbbbbb', '--action', 'approve', '--said', 'approve sc2_sh4']);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(readFileSync(src, 'utf8'), orig);
    const o = r.out as { decisions: { id: string; action: string }[]; applied: string[] };
    assert.deepEqual(o.decisions.map((d) => d.action), ['approve', 'dismiss-flag', 'dismiss-flag']);
    assert.deepEqual([...o.applied].sort(), o.decisions.map((d) => d.id).sort());
    const p = S.parse(JSON.parse(readFileSync(out, 'utf8')));
    assert.equal(p.shots.find((s) => s.id === 'sc2_sh4')!.status, 'approved');
    assert.deepEqual(listFlags(p).map((x) => x.flag.id), ['flag_aaaaaaaa']);
  });
});
