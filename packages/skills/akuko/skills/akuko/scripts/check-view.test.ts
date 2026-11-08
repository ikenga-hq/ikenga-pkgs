// scripts/check-view.mjs (G-VIEW sign-off): passes the instrumented copy of
// the locked board and the minimal board, fails every bad fixture for its
// specific reason (including the G-VIEW reviewer's variants and the WP-07a2
// hardening probes), and reports a truly read-only page SKIP.
// Fixtures are checked in small groups, one process per group, at most POOL at a time.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema } from '../schema/akuko-project.ts';
import { isConformedHtml, parseConformedFile } from '../decisions/conformed.ts';
import { ledgerSummary } from '../spend/ledger.ts';
import { approveSpendText, expectedMoney, expectedYourMove, mutateProject } from './check-view/expected.mjs';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const FX = join(SKILL, 'views', '__fixtures__');
const CLI = join(SKILL, 'scripts', 'check-view.mjs');
const TIMEOUT = 900_000;
const tmp: string[] = [];
const tmpDir = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

interface Failure { rule: string; code: string; message: string }
interface Result { file: string; ok: boolean; skipped?: boolean; view: string | null; sha256: string; failures: Failure[]; decisions_checked: number }

// A small pool: each check-view process runs jsdom many times.
const POOL = Math.max(2, Math.min(4, availableParallelism()));
let running = 0;
const queue: (() => void)[] = [];
async function pooled<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= POOL) await new Promise<void>((r) => queue.push(r));
  running++;
  try { return await fn(); } finally { running--; queue.shift()?.(); }
}

function exec(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return pooled(() => new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { cwd: SKILL, timeout: 480_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      resolve({ code: err ? Number((err as { code: number }).code) : 0, stdout, stderr });
    });
  }));
}

async function run(args: string[]): Promise<{ code: number; results: Result[] }> {
  const { code, stdout } = await exec([...args, '--json']);
  try {
    return { code, results: JSON.parse(stdout) as Result[] };
  } catch (e) {
    throw new Error(`check-view printed no JSON: ${String(e)}\n${stdout.slice(0, 500)}`);
  }
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
  // the G-VIEW reviewer's variants (C5, C6)
  'bad-transparent-estimate.html': ['hidden-estimate'],
  'bad-offscreen-estimate.html': ['hidden-estimate'],
  'bad-zero-font-estimate.html': ['hidden-estimate', 'text-below-floor'],
  'bad-scaled-estimate.html': ['hidden-estimate'],
  'bad-clipped-spend-gate.html': ['hidden-spend-gate'],
  'bad-collapsed-spend-gate.html': ['hidden-spend-gate'],
  'bad-tiny-text.html': ['text-below-floor'],
  'bad-timer-auto-approve.html': ['auto-approve'],
  'bad-mousemove-auto-approve.html': ['auto-approve'],
  'bad-unmarked-approve-all.html': ['unmarked-control-writes'],
  'bad-select-approves.html': ['unmarked-control-writes'],
  'bad-microtask-auto-approve.html': ['auto-approve'],
  'bad-keyboard-approve-all.html': ['auto-approve'],
  'bad-decline-approves-spend.html': ['wrong-action'],
  'bad-ua-sniff-auto-approve.html': ['auto-approve'],
  'bad-approves-other-unit.html': ['writes-other-unit'],
  // WP-07a2 hardening: the reviewer's later probes (F1–F6) and a page lying about being read-only
  'bad-select-change-approves.html': ['unmarked-control-writes'],
  'bad-pointerdown-approve-all.html': ['batch-approve', 'unmarked-control-writes'],
  'bad-unload-approve-all.html': ['auto-approve'],
  'bad-var-zero-font-estimate.html': ['hidden-estimate', 'text-below-floor'],
  'bad-raf-auto-approve.html': ['auto-approve'],
  'bad-dblclick-approves.html': ['unmarked-control-writes'],
  'bad-readonly-writes-decision.html': ['read-only-writes'],
  // the WP-07a2 review (C1–C6, B7)
  'bad-hostc-auto-approve.html': ['auto-approve'],
  'bad-delayed-other-unit.html': ['writes-other-unit'],
  'bad-observer-auto-approve.html': ['auto-approve'],
  'bad-card-click-approves.html': ['unmarked-control-writes'],
  'bad-early-close-project-block.html': ['auto-approve'],
  'bad-project-block-decoy.html': ['bad-project-block'],
  'bad-empties-ikenga-store.html': ['empties-ikenga-store'],
  'bad-iframe-in-view.html': ['iframe-in-view'],
  'bad-readonly-hostc-delayed-post.html': ['read-only-writes'],
  // the Wave 3 second-opinion review (finding 4): idle gestures with the fields a handler tests
  'bad-keycode-approve-all.html': ['auto-approve'],
  'bad-wheel-approve-all.html': ['auto-approve'],
  'bad-contextmenu-approve-all.html': ['auto-approve'],
};
const GOOD = ['board-b-instrumented.html', 'tiny-board.html'];
const SKIP = ['readonly-cast-sheet.html'];

// Start the checks now, a few files per process; the tests below await their own.
const all = [...GOOD, ...SKIP, ...Object.keys(BAD)];
const GROUP = 4;
const groups = Array.from({ length: Math.ceil(all.length / GROUP) }, (_, i) => all.slice(i * GROUP, (i + 1) * GROUP));
const byFile = new Map<string, Promise<{ code: number; result: Result }>>();
for (const g of groups) {
  const p = run(g.map((f) => join(FX, f)));
  for (const f of g) byFile.set(f, p.then(({ results }) => {
    const result = results.find((r) => basename(r.file) === f)!;
    return { code: result.ok ? 0 : 1, result };
  }));
}
const broken = (() => {
  const dir = tmpDir('akuko-cv-');
  writeFileSync(join(dir, 'board-b-broken.html'), readFileSync(join(FX, 'board-b-instrumented.html'), 'utf8').replace(' data-akuko-field="left-if-approved"', ''));
  return run([join(dir, 'board-b-broken.html')]);
})();

describe('check-view passes conforming views', { timeout: TIMEOUT }, () => {
  for (const f of GOOD) {
    it(`PASS ${f}`, async () => {
      const { code, result: r } = await byFile.get(f)!;
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
    assert.equal((await byFile.get('board-b-instrumented.html')!).result.view, 'board-b-instrumented@0.1');
    assert.doesNotMatch(html, /new CustomEvent\('akuko:board-change'/, 'the design\'s custom event is replaced by the decision format');
  });

  it('a mark removed from the instrumented board makes it fail (the check is not vacuous)', async () => {
    const { code, results } = await broken;
    assert.equal(code, 1);
    assert.ok(results[0]!.failures.some((f) => f.code === 'missing-money' && /left if you approve/.test(f.message)));
  });
});

describe('check-view skips a truly read-only view', { timeout: TIMEOUT }, () => {
  for (const f of SKIP) {
    it(`SKIP ${f} (read-only, not applicable), exit 0`, async () => {
      const { result: r } = await byFile.get(f)!;
      assert.equal(r.ok, true);
      assert.equal(r.skipped, true);
      assert.deepEqual(r.failures, []);
    });
  }

  it('the CLI prints SKIP, exits 0 and never records a read-only page', async () => {
    const dir = tmpDir('akuko-ro-');
    const out = join(dir, 'conformed.json');
    const { code, stdout } = await exec([join(FX, 'readonly-cast-sheet.html'), '--record', out]);
    assert.equal(code, 0);
    assert.match(stdout, /^SKIP .*readonly-cast-sheet\.html \(freehand:cast-sheet@1\) · read-only \(not applicable\)/m);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).views, []);
  });
});

describe('check-view fails each bad fixture for its reason', { timeout: TIMEOUT }, () => {
  for (const [f, codes] of Object.entries(BAD)) {
    it(`FAIL ${f} → ${codes.join(', ')}`, async () => {
      const { result: r } = await byFile.get(f)!;
      assert.equal(r.ok, false);
      assert.ok(!r.skipped);
      for (const c of codes) assert.ok(r.failures.some((x) => x.code === c), `${f} did not fail with ${c}: ${JSON.stringify(r.failures)}`);
      assert.ok(!r.failures.some((x) => x.code === 'id-collision'), `${f} has its own view id`);
      for (const x of r.failures) assert.ok(x.message.length > 20, 'every failure says what is wrong');
    });
  }
});

describe('fixtures and helpers', { timeout: TIMEOUT }, () => {
  const writer = readFileSync(join(SKILL, 'scripts', 'check-view', 'decision-writer.js'), 'utf8').trim();

  it('the conforming fixtures inline the decision writer verbatim', () => {
    for (const f of GOOD) assert.ok(readFileSync(join(FX, f), 'utf8').includes(writer), f);
  });

  it('every fixture inlining the writer carries the current one (no stale-writer outside the signed-by-agent fixture, which edits it)', async () => {
    for (const [f, codes] of Object.entries(BAD)) {
      const { result: r } = await byFile.get(f)!;
      const stale = r.failures.some((x) => x.code === 'stale-writer');
      assert.equal(stale, f === 'bad-signed-by-agent.html', `${f}: ${JSON.stringify(r.failures.filter((x) => x.code === 'stale-writer'))}`);
      void codes;
    }
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

  const tiny = readFileSync(join(FX, 'tiny-board.html'), 'utf8');
  const asView = (html: string, id: string) => html.replace('"id":"test-board"', `"id":"${id}"`);

  it('--record writes an entry bound to the exact HTML, and refuses the same id@version for different HTML (G-VIEW C3)', async () => {
    const dir = tmpDir('akuko-rec-');
    const out = join(dir, 'conformed.json');
    const file = join(dir, 'rec-board.html');
    writeFileSync(file, asView(tiny, 'rec-board'));
    const first = await exec([file, '--record', out]);
    assert.equal(first.code, 0, first.stdout);
    const list = parseConformedFile(JSON.parse(readFileSync(out, 'utf8')));
    assert.deepEqual(list.views.map((v) => [v.view, v.checker]), [['rec-board@1', 'check-view@2']]);
    assert.equal(isConformedHtml(list, 'rec-board@1', readFileSync(file, 'utf8')), true);
    // the publisher embeds the real project: the record still holds (the data block is not hashed)
    const published = readFileSync(file, 'utf8').replace(/(<script type="application\/json" id="akuko-project">)[\s\S]*?(<\/script>)/, (_m, a: string, b: string) => `${a}{"project":{"slug":"someone-elses-film"}}${b}`);
    assert.notEqual(published, readFileSync(file, 'utf8'));
    assert.equal(isConformedHtml(list, 'rec-board@1', published), true);
    assert.equal(isConformedHtml(list, 'rec-board@1', published.replace('<title>', '<title>x')), false);
    const changed = join(dir, 'rec-board-edited.html');
    writeFileSync(changed, readFileSync(file, 'utf8').replace('<title>akuko · minimal review board</title>', '<title>akuko · minimal review board (edited)</title>'));
    const second = await exec([changed, '--record', out]);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /NOT RECORDED .*rec-board@1 is already recorded for different HTML.*bump "version"/);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(JSON.stringify(list)), 'the existing record is untouched');
  });

  it('a page reusing a shipped or fixture view id for different HTML fails with id-collision (G-VIEW C7)', async () => {
    const dir = tmpDir('akuko-id-');
    writeFileSync(join(dir, 'reuses-test-board.html'), tiny.replace('<title>akuko · minimal review board</title>', '<title>my board</title>'));
    writeFileSync(join(dir, 'claims-default-board.html'), asView(tiny, 'default-board').replace('"version":"1"', '"version":"0.1"'));
    const { results } = await run([join(dir, 'reuses-test-board.html'), join(dir, 'claims-default-board.html')]);
    for (const r of results) {
      assert.equal(r.ok, false, r.file);
      assert.ok(r.failures.some((f) => f.code === 'id-collision'), `${r.file}: ${JSON.stringify(r.failures)}`);
    }
  });

  it('--ship records a new version of a shipped view; keeps C3; never takes a freehand id; replaces an entry an older checker hashed', async () => {
    const dir = tmpDir('akuko-ship-');
    const ship = join(dir, 'conformed.json');
    const board = (version: string, title = 'akuko · minimal review board') => asView(tiny, 'default-board').replace('"version":"1"', `"version":"${version}"`).replace('<title>akuko · minimal review board</title>', `<title>${title}</title>`);
    writeFileSync(join(dir, 'board-02.html'), board('0.2'));
    writeFileSync(join(dir, 'freehand.html'), asView(tiny, 'freehand:sheet'));
    const env = { AKUKO_CHECK_VIEW_SHIPPED_LIST: ship }; // stands in for the skill's views/conformed.json
    const first = await exec([join(dir, 'board-02.html'), join(dir, 'freehand.html'), '--ship', ship, '--json'], env);
    const r1 = JSON.parse(first.stdout) as Result[];
    assert.equal(r1[0]!.ok, true, JSON.stringify(r1[0]!.failures));
    assert.ok(r1[1]!.failures.some((f) => f.code === 'id-collision' && /freehand view; --ship records only/.test(f.message)));
    assert.deepEqual(parseConformedFile(JSON.parse(readFileSync(ship, 'utf8'))).views.map((v) => v.view), ['default-board@0.2']);

    // C3 holds under --ship: the same id@version for different HTML is refused
    writeFileSync(join(dir, 'board-02-edited.html'), board('0.2', 'edited'));
    // an entry recorded by check-view@1 (raw-page hash) is replaced by re-recording the page
    const seeded = JSON.parse(readFileSync(ship, 'utf8'));
    seeded.views.push({ view: 'default-board@0.3', sha256: 'b'.repeat(64), checked_at: '2026-11-07T00:00:00Z', checker: 'check-view@1' });
    writeFileSync(ship, JSON.stringify(seeded));
    writeFileSync(join(dir, 'board-03.html'), board('0.3'));
    const second = await exec([join(dir, 'board-02-edited.html'), join(dir, 'board-03.html'), '--ship', ship, '--json'], env);
    const r2 = JSON.parse(second.stdout) as Result[];
    assert.ok(r2[0]!.failures.some((f) => f.code === 'id-collision' && /default-board@0\.2, a view id the skill already uses for different HTML/.test(f.message)));
    assert.equal(r2[1]!.ok, true, JSON.stringify(r2[1]!.failures));
    const after = parseConformedFile(JSON.parse(readFileSync(ship, 'utf8'))).views;
    assert.deepEqual(after.map((v) => [v.view, v.checker]).sort(), [['default-board@0.2', 'check-view@2'], ['default-board@0.3', 'check-view@2']]);
    assert.equal(after.find((v) => v.view === 'default-board@0.3')!.sha256, r2[1]!.sha256);
    assert.equal(after.find((v) => v.view === 'default-board@0.2')!.sha256, r1[0]!.sha256, 'the 0.2 record is untouched');
  });

  it('--ship refuses any list but the skill\'s own views/conformed.json', async () => {
    const dir = tmpDir('akuko-ship-x-');
    const project = join(dir, 'views', 'conformed.json');
    const r = await exec([join(FX, 'tiny-board.html'), '--ship', project]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--ship records only into the skill's own list .*views[\\/]conformed\.json\); record a project's views with --record/);
    assert.equal(existsSync(project), false);
  });

  it('money with more than four decimals: exact means "as the spend gate prints it" (G-VIEW C2)', async () => {
    const p = JSON.parse(readFileSync(join(SKILL, 'fixtures', 'the-beating', 'akuko.json'), 'utf8'));
    const dir = tmpDir('akuko-c2-');
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
