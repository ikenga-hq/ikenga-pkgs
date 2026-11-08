// WP-07c evals: freehand views (`/akuko view`).
//
// Three example asks, each answered with a generated page from the converted
// "The Beating" fixture: cast sheet (read-only), scene comparison (read-only),
// spend breakdown (writes decisions: per-job approve / decline). The tests pin
// the rules actions/view.md gives the agent:
//   - read-only views publish without the check and carry no decision controls;
//   - a view with decision controls is refused by the publish gate until
//     check-view has recorded exactly that HTML (isConformedHtml, R-12);
//   - freehand views use their own `freehand:<slug>@<n>` id;
//   - generated pages are readable in light and dark and respect the R5 floor.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isConformedHtml, viewHash } from '../../decisions/conformed.ts';
import { AKUKO, buildAll, decisionWriterV2 } from './build.ts';

const SKILL = AKUKO;
const CLI = join(SKILL, 'scripts', 'check-view.mjs');
const TIMEOUT = 300_000;
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const ASKS = ['cast-sheet', 'scene-comparison', 'spend-breakdown'] as const;
const READ_ONLY = ['cast-sheet', 'scene-comparison'] as const;
const REQUIRED_VIEWS = ['pipeline', 'shots', 'shot-detail', 'bible', 'spend-gate', 'ledger', 'script-link', 'your-move'];
const SHIPPED_IDS = ['test-board', 'board-b-instrumented', 'default-board'];

const here = (...p: string[]) => join(fileURLToPath(new URL('.', import.meta.url)), ...p);
const html = (ask: string) => readFileSync(here(ask, 'view.html'), 'utf8');
const manifest = (h: string) => JSON.parse(/<script type="application\/json" id="akuko-view">([\s\S]*?)<\/script>/.exec(h)![1]!);
const project = JSON.parse(readFileSync(join(SKILL, 'fixtures/the-beating/akuko.json'), 'utf8'));

/** Our own page's code, without the inlined decision writer and the JSON blocks. */
function pageCode(h: string): string {
  return h
    .replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '')
    .replace(/\/\* akuko-decision-writer[\s\S]*?\/\* end akuko-decision-writer \*\//, '');
}

/** The rule every host's publishView() applies (WP-07a2, C8), restated on isConformedHtml(). */
function publishGate(h: string, conformed: unknown): { ok: boolean; why?: string } {
  const m = manifest(h);
  if (!/data-akuko-action=/.test(h)) return { ok: true };
  return isConformedHtml(conformed as never, `${m.id}@${m.version}`, h) ? { ok: true } : { ok: false, why: 'view-not-conformed' };
}

function exec(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout });
    });
  });
}

describe('example views are reproducible', () => {
  it('the committed view.html files equal the build output', () => {
    const built = buildAll();
    for (const a of ASKS) assert.equal(html(a), built[a], `${a}/view.html is stale: run evals/views/build.ts`);
  });
  it('every page holds the fixture project as data', () => {
    for (const a of ASKS) {
      const m = /<script type="application\/json" id="akuko-project">([\s\S]*?)<\/script>/.exec(html(a));
      assert.ok(m, a);
      assert.deepEqual(JSON.parse(m![1]!), project);
    }
  });
});

describe('freehand ids', () => {
  it('each view has its own freehand:<slug>@<n> id', () => {
    const seen = new Set<string>();
    for (const a of ASKS) {
      const m = manifest(html(a));
      assert.equal(m.contract, 'akuko-view@1');
      assert.match(`${m.id}@${m.version}`, /^freehand:[a-z0-9][a-z0-9-]*@\d+(\.\d+)*$/, a);
      assert.ok(!SHIPPED_IDS.includes(m.id), `${a} reuses a shipped id`);
      assert.ok(!seen.has(m.id), `${a} repeats an id`);
      seen.add(m.id);
    }
  });
  it('a copy of the starter page keeping its id fails check-view (id-collision)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-07c-'));
    tmp.push(dir);
    const starter = readFileSync(join(SKILL, 'views/__fixtures__/tiny-board.html'), 'utf8');
    const edited = starter.replace('<h1 id="title"></h1>', '<h1 id="title"></h1><p class="muted">My view.</p>');
    assert.notEqual(edited, starter);
    writeFileSync(join(dir, 'kept-id.html'), edited);
    const r = await exec([join(dir, 'kept-id.html'), '--json']);
    assert.equal(r.code, 1);
    const res = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
    assert.ok(res[0].failures.some((f: { code: string }) => f.code === 'id-collision'), JSON.stringify(res[0].failures));
  });
});

describe('read-only views', () => {
  for (const a of READ_ONLY) {
    it(`${a}: declares writes_decisions false and has no way to write`, () => {
      const h = html(a);
      assert.equal(manifest(h).writes_decisions, false);
      assert.ok(!/data-akuko-action/.test(h), 'no decision controls');
      assert.ok(!/akukoDecisions|akuko-decision-writer|data-akuko-submit|data-akuko-export/.test(h), 'no decision writer');
      const code = pageCode(h);
      assert.ok(!/writeState\(|localStorage|fetch\(|XMLHttpRequest|postMessage|\.set\(|\.update\(|\.delete\(/.test(code), 'no writes of any kind');
      assert.ok(!/"akuko\/project"|'akuko\/project'/.test(code), 'never touches the project doc');
    });
    it(`${a}: publishes without a conformance record`, () => {
      assert.deepEqual(publishGate(html(a), undefined), { ok: true });
      assert.deepEqual(publishGate(html(a), { format: 'akuko-conformed-views', version: 1, views: [] }), { ok: true });
    });
  }
  it('check-view SKIPs both (read-only, not applicable) and fails a page that claims read-only but writes', async () => {
    const r = await exec([here('cast-sheet', 'view.html'), here('scene-comparison', 'view.html'), '--json']);
    assert.equal(r.code, 0, r.stdout);
    const res = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
    assert.deepEqual(res.map((x: { skipped?: boolean }) => x.skipped), [true, true]);
    assert.deepEqual(res.map((x: { note?: string }) => x.note), ['read-only (not applicable)', 'read-only (not applicable)']);
    const bad = await exec([join(SKILL, 'views', '__fixtures__', 'bad-readonly-writes-decision.html'), '--json']);
    assert.equal(bad.code, 1);
    assert.ok(JSON.parse(bad.stdout.slice(bad.stdout.indexOf('['))).flatMap((x: { failures: { code: string }[] }) => x.failures).some((f: { code: string }) => f.code === 'read-only-writes'));
  });
  it('cast sheet names every bible entry, derived from the data', () => {
    const h = html('cast-sheet');
    for (const k of ['characters', 'locations', 'styles'] as const) for (const e of project.bible[k]) assert.ok(h.includes(e.id), e.id);
    assert.match(h, /data-akuko-field="bible-entry"/);
  });
  it('scene comparison covers every scene and shot from the data, not typed in', () => {
    const code = pageCode(html('scene-comparison'));
    assert.ok(!/sc2_sh4|sc4_sh2|Officers|Old Man/.test(code), 'no project facts hard-coded in the page code');
    assert.match(code, /P\.scenes/);
    assert.match(code, /P\.shots/);
  });
});

describe('decision-writing view (spend breakdown)', () => {
  const h = () => html('spend-breakdown');
  const m = () => manifest(h());
  it('lists all eight required views and inlines the current decision writer verbatim', () => {
    assert.equal(m().writes_decisions, true);
    for (const v of REQUIRED_VIEWS) assert.ok(m().views.includes(v), v);
    assert.ok(h().includes(decisionWriterV2()), 'the canonical writer block, byte for byte');
    assert.ok(h().includes('/* akuko-decision-writer v2 — views/contract.md §Decision writer. Inline this block verbatim. */'), 'v2 header');
    assert.ok(h().includes('  if (outbox.length) toIkenga(); // never post an empty list over a stored one (host C remount)'), 'v2 load-site guard');
    assert.equal(h().split('/* end akuko-decision-writer */').length - 1, 1, 'the end marker appears once');
  });
  it('shows the breakdown above the controls, without adding a control of its own', () => {
    const doc = h();
    assert.match(doc, /Where the money goes/);
    const section = /<section id="breakdown"[\s\S]*?<\/section>/.exec(doc);
    assert.ok(section);
    assert.ok(doc.indexOf('id="breakdown"') < doc.indexOf('class="grid"'));
  });
  it('avoids the patterns the hardened checker fails', () => {
    const code = pageCode(h());
    assert.ok(!/<select|type="(radio|range|checkbox)"/.test(code), 'no write-on-change controls');
    assert.ok(!/pointerdown|mousedown|touchstart/.test(code), 'no decision from a press-down event');
    assert.ok(!/beforeunload|pagehide|visibilitychange|unload/.test(code), 'nothing written on page exit or hide');
    assert.ok(!/font-size:\s*var\(/.test(h()), 'no variable font size');
    assert.ok(!/writeState\(|"akuko\/project"/.test(code));
  });
  it('the publish gate refuses it until exactly this HTML is recorded', () => {
    const doc = h();
    const id = `${m().id}@${m().version}`;
    const empty = { format: 'akuko-conformed-views', version: 1, views: [] };
    assert.deepEqual(publishGate(doc, undefined), { ok: false, why: 'view-not-conformed' });
    assert.deepEqual(publishGate(doc, empty), { ok: false, why: 'view-not-conformed' });
    const recorded = { ...empty, views: [{ view: id, sha256: viewHash(doc) }] };
    assert.deepEqual(publishGate(doc, recorded), { ok: true });
    // Edited without a version bump: the record no longer covers it.
    assert.equal(publishGate(doc.replace('Where the money goes', 'Where it goes'), recorded).ok, false);
    // The skill's shipped list is not the project's: a record for another id does not help.
    assert.equal(publishGate(doc, { ...empty, views: [{ view: 'default-board@0.1', sha256: viewHash(doc) }] }).ok, false);
  });
  it('passes check-view and records into a project list (not the skill list)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-07c-'));
    tmp.push(dir);
    const list = join(dir, 'conformed.json');
    const r = await exec([here('spend-breakdown', 'view.html'), '--record', list]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^PASS /m);
    const rec = JSON.parse(readFileSync(list, 'utf8'));
    assert.equal(rec.views.length, 1);
    assert.equal(rec.views[0].view, 'freehand:spend-breakdown@1');
    assert.deepEqual(publishGate(h(), rec), { ok: true });
    const shipped = join(SKILL, 'views', 'conformed.json');
    assert.ok(!existsSync(shipped) || !readFileSync(shipped, 'utf8').includes('freehand:'), 'the skill list stays untouched');
  });
});

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
function tokens(block: string): Record<string, string> {
  const t: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) t[m[1]!] = m[2]!;
  return t;
}

describe('readability (views/contract.md rule 5)', () => {
  for (const a of ASKS) {
    const h = html(a);
    const css = /<style>([\s\S]*?)<\/style>/.exec(h)![1]!;
    it(`${a}: has a light and a dark palette`, () => {
      assert.match(css, /color-scheme:\s*light dark/);
      assert.match(css, /@media \(prefers-color-scheme: dark\)/);
      assert.match(css, /:root\[data-theme="dark"\]/);
      assert.match(css, /body \{[^}]*background: var\(--bg\)[^}]*color: var\(--fg\)/);
    });
    it(`${a}: text contrast is at least 4.5:1 in both palettes`, () => {
      const light = tokens(/^:root \{([^\n]*)\}$/m.exec(css)![1]!);
      const dark = tokens(/:root\[data-theme="dark"\] \{([^\n]*)\}/.exec(css)![1]!);
      const onAccent = a === 'spend-breakdown' ? ['on-ember', 'ember'] : a === 'scene-comparison' ? ['on-accent', 'accent'] : null;
      for (const [name, t] of [['light', light], ['dark', dark]] as const) {
        const accent = t.accent ? 'accent' : 'ember';
        const pairs: [string, string][] = [['fg', 'bg'], ['fg', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['ok', 'surface'], ['warn', 'surface'], [accent, 'surface']];
        if (onAccent) pairs.push([onAccent[0]!, onAccent[1]!]);
        for (const [f, b] of pairs) {
          if (!t[f] || !t[b]) continue;
          assert.ok(contrast(t[f], t[b]) >= 4.5, `${a} ${name}: ${f} on ${b} is ${contrast(t[f], t[b]).toFixed(2)}`);
        }
      }
    });
    it(`${a}: body 16px, no text under 12px, focus style, reduced motion`, () => {
      assert.match(css, /font:\s*16px/);
      for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]!) >= 12, `font-size ${m[1]}px`);
      assert.ok(!/font-size:\s*(0|[\d.]+(pt|em|rem|%|vw|vh))\b/.test(css), 'sizes in px so the floor can be read');
      assert.match(css, /:focus-visible/);
      assert.match(css, /prefers-reduced-motion/);
    });
  }
});

describe('actions/view.md', () => {
  const doc = readFileSync(join(SKILL, 'actions', 'view.md'), 'utf8');
  it('is built, with its frontmatter and Loaded-when line', () => {
    assert.ok(!/Stub \(WP-02\)/.test(doc));
    assert.match(doc, /^---\nname: view\n/);
    assert.match(doc, /\*\*Loaded when\*\*:/);
  });
  it('routes every publish through the host adapter and never around it', () => {
    assert.match(doc, /publishView\(/);
    assert.match(doc, /never[^.\n]*(raw|direct)[^.\n]*(Artifact|publish|file)/i);
  });
  it('gates decision-writing views on check-view and the project\'s own list', () => {
    assert.match(doc, /scripts\/check-view\.mjs/);
    assert.match(doc, /--record/);
    assert.match(doc, /<project>\/views\/conformed\.json/);
    assert.match(doc, /never[^.\n]*skill's (shipped )?(list|views\/conformed\.json)/i);
    assert.match(doc, /akuko\/conformed/);
  });
  it('says what to do when the gate refuses', () => {
    assert.match(doc, /If (the )?(gate|publish)[^.\n]*refus/i);
    assert.match(doc, /Never (edit|weaken|bypass|patch)/);
  });
  it('requires a fresh freehand id and inlining the current decision writer', () => {
    assert.match(doc, /freehand:<slug>@<n>/);
    assert.match(doc, /id-collision/);
    assert.match(doc, /inline the current block from `scripts\/check-view\/decision-writer\.js` verbatim/i);
  });
  it('carries the readability floor and the no-go patterns', () => {
    assert.match(doc, /12 ?px/);
    assert.match(doc, /14 ?px/);
    assert.match(doc, /4\.5/);
    assert.match(doc, /light and dark/i);
    assert.match(doc, /pointerdown/);
    assert.match(doc, /beforeunload/);
  });
  it('has the manual host-A check', () => {
    assert.match(doc, /^## Manual host-A check/m);
    assert.match(doc, /Observed:/);
  });
  it('describes Canva as optional and read-only', () => {
    assert.match(doc, /Canva[^.\n]*read-only/i);
  });
});
