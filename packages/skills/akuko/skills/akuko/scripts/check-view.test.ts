// scripts/check-view.mjs (G-VIEW sign-off): passes the instrumented copy of
// the locked board and the minimal board, fails every bad fixture for its
// specific reason. Each fixture runs in its own process, in parallel.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema } from '../schema/akuko-project.ts';
import { isConformedHtml, parseConformedFile } from '../decisions/conformed.ts';
import { ledgerSummary } from '../spend/ledger.ts';
import { approveSpendText, expectedMoney, expectedYourMove, mutateProject } from './check-view/expected.mjs';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const FX = join(SKILL, 'views', '__fixtures__');
const CLI = join(SKILL, 'scripts', 'check-view.mjs');
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

interface Failure { rule: string; code: string; message: string }
interface Result { file: string; ok: boolean; view: string | null; sha256: string; failures: Failure[]; decisions_checked: number }

function run(args: string[]): Promise<{ code: number; results: Result[] }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args, '--json'], { cwd: SKILL, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      try {
        resolve({ code: err ? Number((err as { code: number }).code) : 0, results: JSON.parse(stdout) as Result[] });
      } catch (e) {
        reject(new Error(`check-view printed no JSON: ${String(e)}\n${stdout.slice(0, 500)}`));
      }
    });
  });
}

/** Each bad fixture and the failure code(s) it must produce. */
const BAD: Record<string, string[]> = {
  'bad-hidden-estimate.html': ['hidden-estimate'],
  'bad-auto-approve.html': ['auto-approve'],
  'bad-no-your-move.html': ['no-your-move'],
  'bad-writes-project.html': ['writes-project'],
  'bad-pre-ticked.html': ['pre-ticked'],
  'bad-batch-approve.html': ['batch-approve'],
  'bad-rounded-money.html': ['rounded-money'],
  'bad-typed-summary.html': ['your-move-not-derived'],
  'bad-signed-by-agent.html': ['signed-by-agent'],
};
const GOOD = ['board-b-instrumented.html', 'tiny-board.html'];

// Start every check at once; the tests below await their own.
const pending = new Map<string, Promise<{ code: number; results: Result[] }>>();
for (const f of [...GOOD, ...Object.keys(BAD)]) pending.set(f, run([join(FX, f)]));
const broken = (() => {
  const html = readFileSync(join(FX, 'board-b-instrumented.html'), 'utf8').replace(' data-akuko-field="left-if-approved"', '');
  const dir = mkdtempSync(join(tmpdir(), 'akuko-cv-'));
  tmp.push(dir);
  writeFileSync(join(dir, 'board-b-broken.html'), html);
  return run([join(dir, 'board-b-broken.html')]);
})();

describe('check-view passes conforming views', { timeout: 280_000 }, () => {
  for (const f of GOOD) {
    it(`PASS ${f}`, async () => {
      const { code, results } = await pending.get(f)!;
      const r = results[0]!;
      assert.deepEqual(r.failures, [], `${f}: ${r.failures.map((x) => `${x.rule} ${x.code}: ${x.message}`).join('\n')}`);
      assert.equal(r.ok, true);
      assert.equal(code, 0);
      assert.ok(r.decisions_checked >= 8, `only ${r.decisions_checked} decisions were exercised`);
    });
  }

  it('the instrumented board is the locked design plus marks: it still says so and writes as board-b-instrumented@0.1', async () => {
    const html = readFileSync(join(FX, 'board-b-instrumented.html'), 'utf8');
    assert.match(html, /INSTRUMENTED TEST COPY \(WP-07a, gate G-VIEW\) of the locked D-01 design designs\/board-b-script-desk\.html/);
    assert.match(html, /akuko board · option B "Script desk"/);
    assert.equal((await pending.get('board-b-instrumented.html')!).results[0]!.view, 'board-b-instrumented@0.1');
    assert.doesNotMatch(html, /new CustomEvent\('akuko:board-change'/, 'the design\'s custom event is replaced by the decision format');
  });

  it('a mark removed from the instrumented board makes it fail (the check is not vacuous)', async () => {
    const { code, results } = await broken;
    assert.equal(code, 1);
    assert.ok(results[0]!.failures.some((f) => f.code === 'missing-money' && /left if you approve/.test(f.message)));
  });
});

describe('check-view fails each bad fixture for its reason', { timeout: 280_000 }, () => {
  for (const [f, codes] of Object.entries(BAD)) {
    it(`FAIL ${f} → ${codes.join(', ')}`, async () => {
      const { code, results } = await pending.get(f)!;
      const r = results[0]!;
      assert.equal(r.ok, false);
      assert.equal(code, 1);
      for (const c of codes) assert.ok(r.failures.some((x) => x.code === c), `${f} did not fail with ${c}: ${JSON.stringify(r.failures)}`);
      for (const x of r.failures) assert.ok(x.message.length > 20, 'every failure says what is wrong');
    });
  }
});

describe('fixtures and helpers', () => {
  const writer = readFileSync(join(SKILL, 'scripts', 'check-view', 'decision-writer.js'), 'utf8').trim();

  it('the conforming fixtures inline the decision writer verbatim', () => {
    for (const f of GOOD) assert.ok(readFileSync(join(FX, f), 'utf8').includes(writer), f);
  });

  it('each bad fixture is labelled as one', () => {
    for (const f of Object.keys(BAD)) assert.match(readFileSync(join(FX, f), 'utf8'), /BAD FIXTURE: /, f);
  });

  it('expected money and counts agree with the spend ledger and the data', () => {
    const p = AkukoProjectSchema.parse(JSON.parse(readFileSync(join(SKILL, 'fixtures', 'the-beating', 'akuko.json'), 'utf8')));
    for (const q of [p, AkukoProjectSchema.parse(mutateProject(p))]) {
      const m = expectedMoney(q);
      const s = ledgerSummary(q);
      const awaiting = q.pending_spend.filter((j) => j.status === 'awaiting-approval').reduce((a, j) => a + j.estimate, 0);
      assert.ok(Math.abs(m.leftIfApproved! - ((s.remaining ?? 0) - awaiting)) < 1e-9);
      assert.equal(m.spent, q.budget!.spent);
    }
    assert.deepEqual(expectedYourMove(p), { 'waiting-shots': 2, 'waiting-spend': 1, 'waiting-other': 2 });
    assert.deepEqual(expectedYourMove(mutateProject(p)), { 'waiting-shots': 3, 'waiting-spend': 1, 'waiting-other': 1 });
    assert.equal(approveSpendText(p, p.pending_spend[0]!), 'approve 0.36 USD');
    assert.ok(Math.abs(expectedMoney(mutateProject(p)).leftIfApproved! - 18.7475) < 1e-9);
  });

  it('--record writes a conformed-views entry folding accepts, bound to the exact HTML', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-rec-'));
    tmp.push(dir);
    const out = join(dir, 'conformed.json');
    const file = join(FX, 'tiny-board.html');
    await new Promise<void>((resolve, reject) => execFile(process.execPath, [CLI, file, '--record', out], { timeout: 110_000 }, (e) => (e ? reject(e) : resolve())));
    const list = parseConformedFile(JSON.parse(readFileSync(out, 'utf8')));
    assert.deepEqual(list.views.map((v) => [v.view, v.checker]), [['test-board@1', 'check-view@1']]);
    assert.equal(isConformedHtml(list, 'test-board@1', readFileSync(file, 'utf8')), true);
    // G-VIEW C3: the same id@version for different HTML is refused, and the record is kept.
    const changed = join(dir, 'tiny-changed.html');
    writeFileSync(changed, readFileSync(file, 'utf8').replace('<title>akuko · minimal review board</title>', '<title>akuko · minimal review board (edited)</title>'));
    const second = await new Promise<{ code: number; stderr: string }>((resolve) => execFile(process.execPath, [CLI, changed, '--record', out], { timeout: 110_000 }, (e, _o, stderr) => resolve({ code: e ? Number((e as { code: number }).code) : 0, stderr })));
    assert.equal(second.code, 1);
    assert.match(second.stderr, /NOT RECORDED .*test-board@1 is already recorded for different HTML.*bump "version"/);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(JSON.stringify(list)), 'the existing record is untouched');
  });

  it('money with more than four decimals: exact means "as the spend gate prints it" (G-VIEW C2)', { timeout: 200_000 }, async () => {
    const p = JSON.parse(readFileSync(join(SKILL, 'fixtures', 'the-beating', 'akuko.json'), 'utf8'));
    const dir = mkdtempSync(join(tmpdir(), 'akuko-c2-'));
    tmp.push(dir);
    const runs = [0.41254, 1.23e-5].map((estimate, i) => {
      const f = join(dir, `p${i}.json`);
      writeFileSync(f, JSON.stringify({ ...p, pending_spend: [{ ...p.pending_spend[0], estimate }] }));
      return run([join(FX, 'tiny-board.html'), '--project', f]);
    });
    for (const { code, results } of await Promise.all(runs)) {
      assert.deepEqual(results[0]!.failures, []);
      assert.equal(code, 0);
    }
  });
});
