// WP-29: sign-off gates. The gate status helper, the sign-off command (refusals and a valid sign-off),
// and the fold's side of it: nothing a board writes can sign a gate. Synthetic data only.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema, DecisionSchema, type AkukoProject, type Decision } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { bigProject, writeBigProject } from '../views/__fixtures__/big-project.ts';
import { loadConformedFile } from './conformed.ts';
import { foldDecisions } from './fold.ts';
import { cardPart, GateError, gateStatus, gateStatuses, signGate, unitsInGate } from './gates.ts';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED = loadConformedFile(join(SKILL, 'views', 'conformed.json'));
const NOW = () => new Date('2026-11-10T09:30:00Z');
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const refusal = (fn: () => unknown, code: string, msg?: RegExp) => {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GateError, `not a GateError: ${String(e)}`);
    assert.equal(e.code, code);
    if (msg) assert.match(e.message, msg);
    return true;
  });
};

describe('gate status (decisions/gates.ts)', () => {
  const p = bigProject();

  it('G-LOOK covers the bible images; G-PILOT the P7 key frames; neither is signed', () => {
    const look = gateStatus(p, 'G-LOOK');
    assert.deepEqual(look.units.map((u) => u.type), Array(look.total).fill('asset'));
    assert.ok(look.units.every((u) => u.stage === 'bible'));
    assert.equal(look.total, p.assets.filter((a) => a.stage === 'bible').length);
    assert.equal(look.approved, p.assets.filter((a) => a.stage === 'bible' && a.status === 'approved').length);
    assert.equal(look.state, 'open');
    const pilot = gateStatus(p, 'G-PILOT');
    assert.deepEqual(pilot.units.map((u) => u.id), p.shots.filter((s) => s.part === 'P7').map((s) => `${s.id}_keyframe`));
    assert.deepEqual([pilot.total, pilot.approved, pilot.pending_review, pilot.not_ready], [11, 4, 3, 4]);
    assert.equal(pilot.signed, undefined);
    assert.deepEqual(gateStatuses(p).map((s) => s.id), ['G-LOOK', 'G-PILOT']);
  });

  it('a scope by part without a stage takes the shots, what they own, the entries they name and the part card', () => {
    const { units } = unitsInGate(p, { scope: { parts: ['P7'] } });
    const ids = new Set(units.map((u) => u.id));
    for (const s of p.shots.filter((x) => x.part === 'P7')) { assert.ok(ids.has(s.id)); assert.ok(ids.has(`${s.id}_keyframe`)); }
    assert.ok(ids.has('card_P7-CARD'), 'the part card');
    assert.ok(!ids.has('card_P6-CARD'));
    assert.ok(ids.has('L-DUSK') && ids.has('house-style'), 'the styles the shots name');
    assert.ok(ids.has('house-style_lookbook'), 'and the images those entries own');
    assert.ok(!units.some((u) => u.type === 'shot' && u.part !== 'P7'));
  });

  it('a card belongs to the part that starts after it; the end credits to the last part', () => {
    const card = (id: string) => p.assets.find((a) => a.id === id)!;
    assert.equal(cardPart(p, card('card_P7-CARD')), 'P7');
    assert.equal(cardPart(p, card('card_S01-007')), 'COLD-OPEN');
    assert.equal(cardPart(p, card('card_CREDITS-010')), 'P10');
  });

  it('everything approved is ready; nothing at the stage is empty; rows removed from the sheet are left out', () => {
    const q = structuredClone(p);
    for (const a of q.assets) if (a.stage === 'keyframes') { a.status = 'approved'; a.file ??= { uri: `keyframes/${a.owner}.png` }; }
    assert.equal(gateStatus(q, 'G-PILOT').state, 'ready');
    q.gates!.push({ id: 'G-SOUND', scope: { stage: 'sound' }, needs: 'signoff' });
    const empty = gateStatus(q, 'G-SOUND');
    assert.equal(empty.state, 'empty');
    assert.match(empty.notes.join(), /nothing is in scope yet \(no units at stage sound\)/);
    const s = q.shots.find((x) => x.id === 'S19-030')!;
    s.source = { kind: 'sheet', id: s.id, removed_at: '2026-11-09T15:00:00Z' };
    const r = gateStatus(q, 'G-PILOT');
    assert.deepEqual(r.removed, ['S19-030']);
    assert.equal(r.total, 10);
    assert.match(r.notes.join(), /1 removed from the sheet/);
  });

  it('an unknown gate is a clear error naming the gates there are', () => {
    refusal(() => gateStatus(p, 'G-NOPE'), 'unknown-gate', /no gate "G-NOPE".*G-LOOK, G-PILOT/);
  });
});

describe('sign-off (signGate)', () => {
  const p = bigProject();
  const ok = { gate: 'G-LOOK', by: 'p-sign', via: 'email', now: NOW };

  it('records {by, role: signoff, at, via, note}, on a copy, and the project still validates', () => {
    const r = signGate(p, { ...ok, note: 'Said yes in a reply.' });
    assert.deepEqual(r.record, { by: 'p-sign', role: 'signoff', at: '2026-11-10T09:30:00Z', via: 'email', note: 'Said yes in a reply.' });
    assert.deepEqual(r.project.gates![0]!.signed, r.record);
    assert.equal(p.gates![0]!.signed, undefined, 'the input is not changed');
    assert.equal(r.status.state, 'signed');
    assert.equal(r.status.signer?.name, 'Sign-off Person (invented)');
    assert.match(r.warnings.join(), /signed with 5 of 13 items not approved yet/);
    assert.deepEqual(checkIntegrity(r.project), []);
    assert.equal(r.project.project.updated_at, '2026-11-10T09:30:00Z');
    assert.deepEqual(AkukoProjectSchema.parse(r.project), r.project);
  });

  it('refuses a person without the signoff role: an approver never passes a gate', () => {
    refusal(() => signGate(p, { ...ok, by: 'p-day' }), 'wrong-role', /Day Approver \(invented\) \(p-day\) is an approver; G-LOOK needs a person with the "signoff" role/);
  });

  it('refuses an unknown gate and an unknown person', () => {
    refusal(() => signGate(p, { ...ok, gate: 'G-LOOKS' }), 'unknown-gate', /no gate "G-LOOKS"/);
    refusal(() => signGate(p, { ...ok, by: 'p-host' }), 'unknown-person', /no person "p-host".*p-day \(approver\), p-sign \(signoff\)/);
    const nobody = structuredClone(p);
    delete nobody.people;
    refusal(() => signGate(nobody, ok), 'unknown-person', /lists nobody/);
  });

  it('refuses a gate that is already signed; --replace re-signs and keeps the old record in the note', () => {
    const first = signGate(p, { ...ok, at: '2026-11-09T18:00:00Z', note: 'first' }).project;
    refusal(() => signGate(first, { ...ok, via: 'in person' }), 'already-signed', /already signed by p-sign \(signoff\) at 2026-11-09T18:00:00Z via email; note: first.*--replace/);
    const r = signGate(first, { ...ok, via: 'in person', replace: true });
    assert.equal(r.record.via, 'in person');
    assert.equal(r.record.note, 'Replaces: signed by p-sign (signoff) at 2026-11-09T18:00:00Z via email; note: first');
    assert.deepEqual(r.replaced, first.gates![0]!.signed);
    const third = signGate(r.project, { ...ok, via: 'shared page', note: 'final', replace: true });
    assert.match(third.record.note!, /^final · Replaces: signed by p-sign \(signoff\) at 2026-11-10T09:30:00Z via in person; note: Replaces: signed by .* via email; note: first$/, 'the whole chain stays');
  });

  it('refuses an empty via and a timestamp without a zone', () => {
    refusal(() => signGate(p, { ...ok, via: '  ' }), 'bad-input', /--via/);
    refusal(() => signGate(p, { ...ok, at: '2026-11-10T09:30:00' }), 'bad-input', /--at/);
  });

  it('a unit changed after the sign-off is noted, not hidden', () => {
    const q = signGate(p, { ...ok, at: '2026-11-10T09:00:00Z' }).project;
    const a = q.assets.find((x) => x.id === 'BEN_portrait')!;
    a.status = 'approved';
    a.updated_at = '2026-11-10T10:00:00Z';
    const s = gateStatus(q, 'G-LOOK');
    assert.deepEqual(s.changed_since_signed, ['BEN_portrait']);
    assert.match(s.notes.join(' | '), /1 changed after it was signed: BEN_portrait/);
  });
});

describe('folding never signs a gate', () => {
  const p = bigProject();
  const base = { by: 'you', at: '2026-11-10T10:00:00Z' };

  it('a board decision aimed at a gate id is rejected as unknown-unit, from every board version, and signs nothing', () => {
    for (const view of ['default-board@0.1', 'default-board@0.2', 'default-board@0.3']) {
      for (const action of ['approve', 'note', 'request-changes'] as const) {
        const d = DecisionSchema.parse({ id: randomUUID(), action, unit: 'G-PILOT', stage: 'keyframes', view, ...base, ...(action === 'approve' ? {} : { text: 'looks right' }) });
        const r = foldDecisions(p, [d], { conformed: SHIPPED });
        assert.deepEqual(r.report.rejected.map((x) => [x.unit, x.code]), [['G-PILOT', 'unknown-unit']], `${view} ${action}`);
        assert.deepEqual(r.project.gates, p.gates);
        assert.deepEqual(r.project.decisions, []);
      }
    }
  });

  it('folding approvals of every unit in a gate leaves gates[] exactly as it was', () => {
    const units = gateStatus(p, 'G-PILOT').units.filter((u) => u.status === 'pending-review');
    const ds: Decision[] = units.map((u, i) => DecisionSchema.parse({ id: randomUUID(), action: 'approve', unit: u.id, stage: u.stage, view: 'default-board@0.2', ...base, at: `2026-11-10T10:0${i}:00Z` }));
    const r = foldDecisions(p, ds, { conformed: SHIPPED });
    assert.equal(r.report.applied.length, units.length);
    assert.deepEqual(r.project.gates, p.gates, 'no gate gains a signature');
    assert.equal(gateStatus(r.project, 'G-PILOT').approved, 4 + units.length);
    assert.equal(gateStatus(r.project, 'G-PILOT').signed, undefined);
  });

  it('a signed gate survives a fold untouched', () => {
    const signed = signGate(p, { gate: 'G-LOOK', by: 'p-sign', via: 'email', now: NOW }).project;
    const d = DecisionSchema.parse({ id: randomUUID(), action: 'approve', unit: 'BEN_portrait', stage: 'bible', view: 'default-board@0.1', ...base });
    const r = foldDecisions(signed, [d], { conformed: SHIPPED });
    assert.equal(r.report.applied.length, 1);
    assert.deepEqual(r.project.gates, signed.gates);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The command line
// ─────────────────────────────────────────────────────────────────────────

const run = (args: string[]) => new Promise<{ code: number; out: any; err: string }>((resolve) => {
  execFile(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(SKILL, 'decisions', 'cli.ts'), ...args], { timeout: 60_000 }, (e, out, err) => {
    let json: unknown = null;
    try { json = JSON.parse(out); } catch { json = out; }
    resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out: json, err });
  });
});
const project = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'akuko-signoff-'));
  tmp.push(dir);
  writeBigProject(dir);
  return dir;
};
const readProject = (dir: string): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(join(dir, 'akuko.json'), 'utf8')));

describe('decisions/cli.ts signoff and gates', { timeout: 120_000 }, () => {
  it('signs a gate in akuko.json and says it is attested; a second run is refused; --replace re-signs', async () => {
    const dir = project();
    const r = await run(['signoff', '--project', dir, '--gate', 'G-PILOT', '--by', 'p-sign', '--via', 'shared page', '--note', 'Looked at the sign-off page.', '--at', '2026-11-10T08:00:00Z']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.ok, true);
    assert.deepEqual(r.out.signed, { by: 'p-sign', role: 'signoff', at: '2026-11-10T08:00:00Z', via: 'shared page', note: 'Looked at the sign-off page.' });
    assert.match(r.out.attested, /not proven/);
    assert.equal(r.out.status.units, 11, 'units summarised');
    assert.deepEqual(readProject(dir).gates![1]!.signed, r.out.signed);
    const again = await run(['signoff', '--project', dir, '--gate', 'G-PILOT', '--by', 'p-sign', '--via', 'email']);
    assert.equal(again.code, 1);
    assert.deepEqual([again.out.ok, again.out.code], [false, 'already-signed']);
    const re = await run(['signoff', '--project', dir, '--gate', 'G-PILOT', '--by', 'p-sign', '--via', 'email', '--replace']);
    assert.equal(re.code, 0, re.err);
    assert.match(readProject(dir).gates![1]!.signed!.note!, /Replaces: signed by p-sign \(signoff\) at 2026-11-10T08:00:00Z via shared page/);
  });

  it('refuses the wrong role and an unknown gate, and writes nothing', async () => {
    const dir = project();
    const before = readFileSync(join(dir, 'akuko.json'), 'utf8');
    const role = await run(['signoff', '--project', dir, '--gate', 'G-LOOK', '--by', 'p-day', '--via', 'email']);
    assert.deepEqual([role.code, role.out.code], [1, 'wrong-role']);
    const gate = await run(['signoff', '--project', dir, '--gate', 'G-NOPE', '--by', 'p-sign', '--via', 'email']);
    assert.deepEqual([gate.code, gate.out.code], [1, 'unknown-gate']);
    assert.equal(readFileSync(join(dir, 'akuko.json'), 'utf8'), before);
  });

  it('signoff-file (host A) writes the signed project to --out; gates prints every status', async () => {
    const dir = project();
    const out = join(dir, 'signed.json');
    const r = await run(['signoff-file', '--project-file', join(dir, 'akuko.json'), '--out', out, '--gate', 'G-LOOK', '--by', 'p-sign', '--via', 'email']);
    assert.equal(r.code, 0, r.err);
    const signed = AkukoProjectSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    assert.equal(signed.gates![0]!.signed!.via, 'email');
    writeFileSync(join(dir, 'akuko.json'), readFileSync(out));
    const g = await run(['gates', '--project', dir]);
    assert.equal(g.code, 0, g.err);
    assert.deepEqual(g.out.gates.map((x: any) => [x.id, x.state, x.approved, x.total]), [['G-LOOK', 'signed', 8, 13], ['G-PILOT', 'open', 4, 11]]);
    const one = await run(['gates', '--project', dir, '--gate', 'G-PILOT', '--units']);
    assert.equal(one.out.gates[0].units.length, 11);
    assert.equal((await run(['signoff', '--project', dir, '--gate', 'G-LOOK'])).code, 1, 'usage');
  });
});
