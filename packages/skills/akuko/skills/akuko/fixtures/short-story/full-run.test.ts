// WP-09 — Phase 1 verification, the automatable half (items 2, 4b-local and 5).
//
// The short-story fixture ("The Beating", from Poe's The Tell-Tale Heart) is run
// intake -> breakdown -> sketch board -> bibles -> key frames through the real
// command line of each stage on a scratch project folder:
//   - once with the manual provider (free: prompt package out, a small PNG back in);
//   - once with a paid provider (gemini-image) on a MOCKED network and a dummy key.
// Nothing here makes a live call: `globalThis.fetch` is replaced for the paid run
// and the test fails if a request goes anywhere but the mocked Gemini endpoint.
//
// What it proves:
//   - every paid call is preceded by the spend gate's line with an estimate, and
//     nothing is sent until the person's approve-spend is folded (item 2);
//   - the ledger matches what was sent, and stays under the cap;
//   - every unit and every stage reaches `approved` only by folding a decision a
//     person wrote through a conformed view (`default-board@0.1`);
//   - a decision from the artifact database (host A) and one from decisions.jsonl
//     (host B) are both folded by the next action, and an undo reverses the earlier
//     one (item 4b, local half);
//   - a second breakdown run on the finished project creates nothing (item 5).
//
// The committed EVIDENCE.md is generated from these runs; regenerate it with
// AKUKO_UPDATE_EVIDENCE=1.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { alreadyBrokenDown, applyBreakdown } from '../../breakdown/apply.ts';
import { run as boardCli } from '../../board/cli.ts';
import { run as breakdownCli } from '../../breakdown/cli.ts';
import { main as decisionsCli } from '../../decisions/cli.ts';
import { appendDecisions } from '../../decisions/jsonl.ts';
import { loadProviderConfig } from '../../providers/config.ts';
import { AkukoProjectSchema, findUnit, listUnits, type AkukoProject, type Decision } from '../../schema/akuko-project.ts';
import { checkIntegrity } from '../../schema/integrity.ts';
import { SETUP_POINTER } from '../../spend/gate.ts';
import { ledgerSummary } from '../../spend/ledger.ts';
import { createLocalHost } from '../../hosts/local.ts';
import {
  DUMMY_KEY,
  FIXTURE_DIR,
  Person,
  VIEW,
  runIntakeAndBreakdown,
  runShortStory,
  startRun,
  type RunEvidence,
} from './harness.ts';

const tmps: string[] = [];
const scratch = async (name: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), `akuko-${name}-`));
  tmps.push(d);
  return d;
};
after(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
});

const money = (n: number): string => n.toFixed(4);
const proposal = JSON.parse(readFileSync(join(FIXTURE_DIR, 'proposal.json'), 'utf8')) as unknown;

/** Every unit and every stage that is `approved` has a person's `approve` behind it, from a conformed view. */
function assertApprovedByPeople(p: AkukoProject, written: Decision[]): void {
  const approves = new Map<string, Decision[]>();
  for (const d of written) if (d.action === 'approve') approves.set(d.unit, [...(approves.get(d.unit) ?? []), d]);
  const folded = new Set(p.decisions.map((d) => d.id));
  for (const { unit } of listUnits(p)) {
    if (unit.status !== 'approved') continue;
    const ds = approves.get(unit.id) ?? [];
    assert.ok(ds.length > 0, `${unit.id} is approved but no person's approve decision names it`);
    for (const d of ds) {
      assert.equal(d.by, 'you', `${unit.id}: approve is signed by ${d.by}`);
      assert.equal(d.view, VIEW, `${unit.id}: approve came from ${d.view}`);
      assert.ok(folded.has(d.id), `${unit.id}: the decision ${d.id} was never folded into akuko.json`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Item 2 + 5: the full run, free and paid
// ─────────────────────────────────────────────────────────────────────────

let manual: RunEvidence;
let paid: RunEvidence;
let manualDir: string;
let paidDir: string;
const people = new Map<string, Decision[]>();
let manualMs = 0;
let paidMs = 0;

before(async () => {
  manualDir = await scratch('story-manual');
  let t = Date.now();
  manual = await runShortStory({ dir: manualDir, provider: 'manual' });
  manualMs = Date.now() - t;
  paidDir = await scratch('story-paid');
  t = Date.now();
  paid = await runShortStory({ dir: paidDir, provider: 'gemini-image', cap: 25 });
  paidMs = Date.now() - t;
});

describe('short-story full run: manual provider (free)', () => {
  it('reaches approved at every stage, with no spend and no budget needed', () => {
    assert.deepEqual(manual.stageStates, { intake: 'approved', breakdown: 'approved', sketch: 'approved', bible: 'approved', keyframes: 'approved' });
    const p = manual.final;
    assert.ok(p.budget == null, 'a free run needs no budget');
    assert.deepEqual(p.pending_spend, []);
    assert.deepEqual(p.ledger, []);
    assert.equal(manual.spendPrompts.length, 0, 'a free job is never held for a spend approval');
    assert.deepEqual(checkIntegrity(p), []);
    AkukoProjectSchema.parse(p);
  });

  it('made the whole film: 4 scenes, 12 shots, 12 key frames and the bible images, all approved', () => {
    const p = manual.final;
    assert.equal(p.scenes.length, 4);
    assert.equal(p.shots.length, 12);
    assert.equal(p.assets.filter((a) => a.kind === 'keyframe').length, 12);
    assert.equal(p.assets.filter((a) => a.stage === 'bible').length, 8);
    for (const { unit } of listUnits(p)) assert.equal(unit.status, 'approved', unit.id);
    assert.equal(manual.filesRecorded, 20, 'one file brought back per image (8 bible + 12 key frames)');
  });

  it('approved only by folding a person\'s decision from a conformed view', async () => {
    const written = await decisionsOf(manualDir);
    assertApprovedByPeople(manual.final, written);
    assert.equal(manual.decisions.byStage.intake, 2);
    assert.equal(manual.decisions.byStage.sketch, 12);
    assert.equal(manual.decisions.byStage.bible, 8);
    assert.equal(manual.decisions.byStage.keyframes, 12);
    assert.equal(manual.decisions.byAction.approve, manual.decisions.total, 'a free run needs only approvals');
  });

  it('item 5: breakdown run again on the finished project creates nothing', async () => {
    const before = await readFile(join(manualDir, 'akuko.json'));
    const screenplayBefore = await readFile(join(manualDir, 'script', 'screenplay.fountain'));
    const taggedBefore = await readFile(join(manualDir, 'script', 'screenplay.tagged.fountain'));
    const apply = await breakdownCli(['apply', '--project', manualDir, '--proposal', join(FIXTURE_DIR, 'proposal.json')]);
    assert.equal(apply.code, 0, apply.out);
    assert.match(apply.out, /^Nothing created: this project already has a breakdown/);
    const tag = await breakdownCli(['tag', '--project', manualDir]);
    assert.match(tag.out, /^Tagged 0, already tagged 12, left untagged 0, conflicts 0\./);
    assert.equal((await breakdownCli(['lint', '--project', manualDir])).code, 0);
    assert.ok(before.equals(await readFile(join(manualDir, 'akuko.json'))), 'akuko.json is byte-identical');
    assert.ok(screenplayBefore.equals(await readFile(join(manualDir, 'script', 'screenplay.fountain'))), 'the screenplay is byte-identical');
    assert.ok(taggedBefore.equals(await readFile(join(manualDir, 'script', 'screenplay.tagged.fountain'))), 'the tagged copy is byte-identical');
    assert.ok(screenplayBefore.equals(await readFile(join(FIXTURE_DIR, 'screenplay.fountain'))), 'the approved screenplay was never tagged in place (B-3)');

    const again = applyBreakdown(manual.final, proposal, { now: () => new Date('2027-01-01T00:00:00Z') });
    assert.equal(again.skipped, true);
    assert.deepEqual(again.created, { scenes: 0, beats: 0, shots: 0, characters: 0, locations: 0, styles: 0 });
    assert.equal(JSON.stringify(again.project), JSON.stringify(manual.final));
    assert.equal(alreadyBrokenDown(manual.final), true);
  });
});

/** The decisions a run's person wrote (read back from the folder, the same file the next action reads). */
async function decisionsOf(dir: string): Promise<Decision[]> {
  const cached = people.get(dir);
  if (cached) return cached;
  const text = await readFile(join(dir, 'decisions.jsonl'), 'utf8');
  const ds = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Decision);
  people.set(dir, ds);
  return ds;
}

describe('short-story full run: paid provider on a mocked network', () => {
  it('is refused while no budget is set, with the pointer to setup, and sends nothing', () => {
    assert.ok(paid.noBudgetRefusal, 'the refusal was recorded');
    assert.match(paid.noBudgetRefusal, /^Refused \(no-budget\):/);
    assert.ok(paid.noBudgetRefusal.includes(SETUP_POINTER), 'the refusal carries the setup pointer');
  });

  it('item 2: every paid call is preceded by a spend line with an estimate, and nothing is sent before approval', () => {
    const p = paid.final;
    assert.deepEqual(paid.stageStates, { intake: 'approved', breakdown: 'approved', sketch: 'approved', bible: 'approved', keyframes: 'approved' });
    assert.equal(paid.spendPrompts.length, p.pending_spend.length, 'one prompt per paid job');
    assert.ok(paid.spendPrompts.length >= 4, `expected several paid jobs, got ${paid.spendPrompts.length}`);
    let sent = 0;
    for (const sp of paid.spendPrompts) {
      assert.match(sp.line, /^Spend check — /);
      assert.match(sp.line, new RegExp(`estimate ${String(Number(sp.estimate.toFixed(4))).replace('.', '\\.')} USD`), 'the line states the estimate');
      assert.match(sp.line, /Budget 25 USD: spent [\d.]+, in flight [\d.]+, left after this [\d.]+\./);
      assert.match(sp.line, /Reply "approve [\d.]+ USD" to run it; anything else stops it\.$/);
      assert.equal(sp.requestsAtPrompt, sent, `${sp.job}: requests had already gone out when the prompt was shown`);
      assert.equal(sp.requestsAfterApproval, sent, `${sp.job}: approving does not send; the next step does`);
      const job = p.pending_spend.find((j) => j.id === sp.job)!;
      assert.equal(job.status, 'approved');
      assert.equal(job.decision, sp.decision, 'approved by the person\'s decision');
      sent += job.units.length;
    }
    assert.equal(paid.requests, sent, 'requests sent equal the units approved, one per image');
    assert.equal(paid.requests, 20);
  });

  it('only the mocked Gemini endpoint was ever called, with the dummy key', () => {
    assert.deepEqual(paid.requestHosts, ['generativelanguage.googleapis.com']);
    assert.deepEqual(paid.requestKeys, [DUMMY_KEY]);
    const p = paid.final;
    assert.equal(p.ledger.length, 20);
    assert.ok(p.ledger.every((l) => l.status === 'done' && l.provider === 'gemini-image'));
  });

  it('the ledger matches the estimates and stays under the cap', () => {
    const p = paid.final;
    const cfg = loadProviderConfig();
    const price = cfg.providers['gemini-image']!.models['gemini-nano-banana-2.1']!.price.amount;
    const totalEstimate = p.pending_spend.reduce((a, j) => a + j.estimate, 0);
    assert.ok(Math.abs(totalEstimate - 20 * price) < 1e-9, `20 images at ${price} -> ${totalEstimate}`);
    const s = ledgerSummary(p);
    assert.ok(Math.abs(s.spent - totalEstimate) < 1e-9, `spent ${s.spent} vs estimates ${totalEstimate}`);
    assert.equal(s.reserved, 0, 'nothing left in flight');
    assert.ok(s.spent <= (p.budget?.cap ?? 0));
    assert.equal(p.budget?.cap, 25);
    assert.ok(Math.abs((p.budget?.spent ?? 0) - s.spent) < 1e-9, 'budget.spent equals the ledger');
    for (const j of p.pending_spend) {
      const entries = p.ledger.filter((l) => l.job === j.id);
      assert.equal(entries.length, j.units.length, `${j.id}: one ledger entry per unit`);
      const sum = entries.reduce((a, l) => a + (l.actual ?? 0), 0);
      assert.ok(Math.abs(sum - j.estimate) < 1e-9, `${j.id}: ledger ${sum} vs estimate ${j.estimate}`);
    }
  });

  it('a ledger entry is never older than the approval it ran under', () => {
    const p = paid.final;
    for (const j of p.pending_spend) {
      const approval = p.decisions.find((d) => d.id === j.decision)!;
      assert.equal(approval.action, 'approve-spend');
      for (const l of p.ledger.filter((x) => x.job === j.id)) {
        assert.ok(Date.parse(l.ts) > Date.parse(approval.at), `${j.id}: ledger ${l.ts} is not after the approval at ${approval.at}`);
      }
    }
  });

  it('approved only by folding a person\'s decision from a conformed view', async () => {
    assertApprovedByPeople(paid.final, await decisionsOf(paidDir));
    assert.equal(paid.decisions.byAction['approve-spend'], paid.spendPrompts.length);
    for (const d of paid.final.decisions.filter((x) => x.action === 'approve-spend')) {
      assert.equal(d.by, 'you');
      assert.equal(d.view, VIEW);
      assert.match(d.text ?? '', /^approve [\d.]+ USD$/);
    }
  });

  it('item 5 on the paid project too: breakdown again creates nothing', async () => {
    const before = await readFile(join(paidDir, 'akuko.json'));
    const r = await breakdownCli(['apply', '--project', paidDir, '--proposal', join(FIXTURE_DIR, 'proposal.json')]);
    assert.match(r.out, /^Nothing created/);
    assert.ok(before.equals(await readFile(join(paidDir, 'akuko.json'))));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 4b, local half: a decision from the artifact database and one from
// decisions.jsonl are both folded by the next action; an undo reverses the earlier one.
// ─────────────────────────────────────────────────────────────────────────

/** An ArtifactData `list` row for one decision, as the live-verified claude.ai board wrote it. */
const row = (d: Decision, rowId: string, updatedAt: string) => ({ id: rowId, data: d, version: 1, updatedAt });

/** Run a decisions CLI command and return the JSON it printed. */
async function decisionsJson(argv: string[]): Promise<{ report: { applied: string[]; rejected: Array<{ id: string; code: string }>; changed: boolean }; invalid: unknown[]; wrote?: boolean }> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    assert.equal(await decisionsCli(argv), 0);
  } finally {
    console.log = log;
  }
  return JSON.parse(lines.join('\n'));
}

describe('item 4b (local half): both decision stores fold, undo reverses', () => {
  let dir: string;
  let person: Person;
  const statusOf = async (id: string): Promise<string> => findUnit(await createLocalHost({ projectDir: dir }).readState(), id)!.unit.status;

  before(async () => {
    dir = await scratch('story-4b');
    const r = startRun({ dir, provider: 'manual' });
    await runIntakeAndBreakdown(r);
    await r.cli('board', boardCli, ['draw', '--project', dir]);
    person = r.person;
    assert.equal(await statusOf('sc1_sh1'), 'pending-review');
  });

  const foldFromArtifactDb = async (rows: unknown[], tag: string): Promise<{ applied: string[]; rejected: Array<{ id: string; code: string }>; changed: boolean }> => {
    const rowsFile = join(dir, `${tag}-rows.json`);
    const out = join(dir, `${tag}-folded.json`);
    await writeFile(rowsFile, JSON.stringify(rows));
    const res = await decisionsJson(['fold-file', '--project', join(dir, 'akuko.json'), '--rows', rowsFile, '--out', out]);
    // On host A the agent `set`s the folded doc back; here that is copying the file over akuko.json.
    await writeFile(join(dir, 'akuko.json'), await readFile(out));
    return res.report;
  };

  it('folds a decisions.jsonl approval (host B)', async () => {
    const d = person.decision('approve', 'sc1_sh1', 'sketch');
    await person.write([d]);
    const res = await decisionsJson(['fold', dir]);
    assert.deepEqual(res.report.applied, [d.id]);
    assert.equal(await statusOf('sc1_sh1'), 'approved');
  });

  const dbApprove = (): { d: Decision; rows: unknown[] } => {
    const d = person.decision('approve', 'sc1_sh2', 'sketch');
    return { d, rows: [row(d, d.id, '2026-11-08T11:00:00.412093Z')] };
  };

  it('folds an artifact-database approval and note (host A, rows as ArtifactData lists them)', async () => {
    const { d, rows } = dbApprove();
    const note = person.decision('note', 'sc1_sh3', 'sketch', { text: 'Keep the lantern in frame when he bolts up.' });
    // one row id is the decision id (set()), one is a generated id (add()), as the live board produced both
    rows.push(row(note, 'dg54snl36ulb16eig8hp', '2026-11-08T11:00:02.100000Z'));
    const rep = await foldFromArtifactDb(rows, 'db1');
    assert.deepEqual(rep.rejected, []);
    assert.deepEqual([...rep.applied].sort(), [d.id, note.id].sort());
    assert.equal(await statusOf('sc1_sh2'), 'approved');
    const sh3 = findUnit(await createLocalHost({ projectDir: dir }).readState(), 'sc1_sh3')!.unit;
    assert.ok(sh3.comments.some((c) => c.text === 'Keep the lantern in frame when he bolts up.'));
    // the first (local) decision is still in force
    assert.equal(await statusOf('sc1_sh1'), 'approved');
    sharedDb = { d, rows };
  });

  let sharedDb: { d: Decision; rows: unknown[] };
  let dbRows: unknown[] = [];

  it('an undo written locally reverses the earlier artifact-database approval', async () => {
    const undo = person.decision('undo', 'sc1_sh2', 'sketch', { undoes: sharedDb.d.id });
    await person.write([undo]);
    const res = await decisionsJson(['fold', dir]);
    assert.deepEqual(res.report.rejected, []);
    assert.deepEqual(res.report.applied, [undo.id]);
    assert.equal(await statusOf('sc1_sh2'), 'pending-review', 'the approval was reversed');
    assert.equal(await statusOf('sc1_sh1'), 'approved', 'the other approval is untouched');
  });

  it('an undo from the artifact database reverses the earlier local approval', async () => {
    const first = (await decisionsOf(dir)).find((d) => d.action === 'approve' && d.unit === 'sc1_sh1' && d.stage === 'sketch')!;
    const undo = person.decision('undo', 'sc1_sh1', 'sketch', { undoes: first.id });
    dbRows = [...sharedDb.rows, row(undo, undo.id, '2026-11-08T11:05:00.000000Z')];
    const rep = await foldFromArtifactDb(dbRows, 'db2');
    assert.deepEqual(rep.rejected, []);
    assert.deepEqual(rep.applied, [undo.id]);
    assert.equal(await statusOf('sc1_sh1'), 'pending-review');
  });

  it('folding the same two stores again changes nothing (jsonl fold, and fold-file over the same database rows)', async () => {
    const before = await readFile(join(dir, 'akuko.json'));
    const local = await decisionsJson(['fold', dir]);
    assert.equal(local.report.changed, false);
    assert.deepEqual(local.report.applied, []);
    assert.ok(before.equals(await readFile(join(dir, 'akuko.json'))));

    // and the artifact-database store: the same rows through fold-file (host A's fold) change nothing either
    const db = await foldFromArtifactDb(dbRows, 'db3');
    assert.equal(db.changed, false);
    assert.deepEqual(db.applied, []);
    assert.deepEqual(db.rejected, []);
    assert.ok(before.equals(await readFile(join(dir, 'akuko.json'))), 'folded project equals the one before');
  });

  it('an approval from a view that is not on the conformed list is refused', async () => {
    const rogue = { ...person.decision('approve', 'sc2_sh1', 'sketch'), view: 'rogue-view@1' } as Decision;
    await appendDecisions(dir, [rogue]);
    const res = await decisionsJson(['fold', dir]);
    assert.deepEqual(res.report.rejected.map((x) => x.code), ['view-not-conformed']);
    assert.equal(await statusOf('sc2_sh1'), 'pending-review');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EVIDENCE.md: generated from the runs above
// ─────────────────────────────────────────────────────────────────────────

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

function render(): string {
  const stages = ['intake', 'breakdown', 'sketch', 'bible', 'keyframes'] as const;
  const p = paid.final;
  const s = ledgerSummary(p);
  const out: string[] = [];
  out.push('# Short-story fixture: Phase 1 run evidence');
  out.push('');
  out.push('Generated by `fixtures/short-story/full-run.test.ts` (regenerate with `AKUKO_UPDATE_EVIDENCE=1`). Do not edit by hand.');
  out.push('');
  out.push('The fixture (The Beating, adapted from Poe\'s The Tell-Tale Heart: 4 scenes, 12 shots) is run intake, breakdown, sketch board, bibles, key frames through the real command line of each stage on a scratch folder. The free run uses the manual provider; the paid run uses `gemini-image` on a **mocked** network with a dummy key: no live call is made. Every approval is a decision a person wrote through the skill\'s default board (`' + VIEW + '`) and folded into `akuko.json`; the harness fails if any command newly approves a unit or stage by itself.');
  out.push('');
  out.push('## Stage states');
  out.push('');
  out.push(table(['Stage', 'Manual run', 'Paid run (mocked)'], stages.map((st) => [st, manual.stageStates[st], paid.stageStates[st]])));
  out.push('');
  out.push('## Decisions folded');
  out.push('');
  const actions = ['approve', 'approve-spend'] as const;
  out.push(table(['Run', 'Decisions', ...actions, 'Folds', 'Files recorded', 'Network requests'], [
    ['manual', ...[manual.decisions.total, ...actions.map((a) => manual.decisions.byAction[a] ?? 0), manual.folds, manual.filesRecorded, manual.requests].map(String)],
    ['paid (mocked)', ...[paid.decisions.total, ...actions.map((a) => paid.decisions.byAction[a] ?? 0), paid.folds, paid.filesRecorded, paid.requests].map(String)],
  ]));
  out.push('');
  out.push('Approvals by stage (manual run): ' + stages.map((st) => `${st} ${manual.decisions.byStage[st] ?? 0}`).join(', ') + '.');
  out.push('');
  out.push('## Spend gate (paid run)');
  out.push('');
  out.push(`With no budget set, the first paid step was refused and sent nothing:`);
  out.push('');
  out.push('> ' + (paid.noBudgetRefusal ?? '').replace(/\n/g, ' '));
  out.push('');
  out.push(`After setup (cap 25 USD) the gate showed ${paid.spendPrompts.length} spend lines, one before each paid job. For each, the number of network requests was the same when the line was shown and after the person approved it; the next step then sent the job.`);
  out.push('');
  out.push(table(['#', 'Stage', 'Spend line as shown', 'Requests at prompt', 'After approval'], paid.spendPrompts.map((sp, i) => [String(i + 1), sp.stage, '`' + sp.line + '`', String(sp.requestsAtPrompt), String(sp.requestsAfterApproval)])));
  out.push('');
  out.push('## Ledger (paid run)');
  out.push('');
  out.push(table(['Quantity', 'Value (USD)'], [
    ['Calls recorded', String(p.ledger.length)],
    ['Spent (ledger)', money(s.spent)],
    ['Sum of the estimates shown', money(p.pending_spend.reduce((a, j) => a + j.estimate, 0))],
    ['In flight', money(s.reserved)],
    ['Cap', money(p.budget?.cap ?? 0)],
  ]));
  out.push('');
  for (const stage of ['bible', 'keyframes'] as const) {
    const jobs = p.pending_spend.filter((j) => j.stage === stage);
    out.push(`- ${stage}: ${jobs.length} job${jobs.length === 1 ? '' : 's'}, ${jobs.reduce((a, j) => a + j.units.length, 0)} images, ${money(jobs.reduce((a, j) => a + j.estimate, 0))} USD`);
  }
  out.push('');
  out.push('## Item 5: breakdown run again');
  out.push('');
  out.push('On the finished manual project, `breakdown/cli.ts apply` printed "Nothing created: this project already has a breakdown", `tag` reported 0 newly tagged and 12 already tagged, and `akuko.json` and `script/screenplay.fountain` were byte-identical before and after.');
  out.push('');
  out.push('## Item 4b (local half)');
  out.push('');
  out.push('On the short-story project at the sketch stage: a `decisions.jsonl` approval (host B) and an artifact-database approval plus note (host A, rows in the `ArtifactData` list shape) were both folded by `decisions/cli.ts`; an undo written locally reversed the artifact-database approval, an undo from the database reversed the local one, re-folding both stores (`fold` over decisions.jsonl and `fold-file` over the same database rows) changed nothing, and an approval from a view not on the conformed list was refused.');
  out.push('');
  return out.join('\n');
}

describe('EVIDENCE.md', () => {
  it('equals what these runs produce (regenerate with AKUKO_UPDATE_EVIDENCE=1)', () => {
    const file = join(FIXTURE_DIR, 'EVIDENCE.md');
    const text = render();
    if (process.env.AKUKO_UPDATE_EVIDENCE === '1') writeFileSync(file, text);
    assert.ok(existsSync(file), 'EVIDENCE.md is missing: run with AKUKO_UPDATE_EVIDENCE=1');
    assert.equal(readFileSync(file, 'utf8').split(String.fromCharCode(13)).join(''), text);
    assert.ok(manualMs >= 0 && paidMs >= 0);
  });
});
