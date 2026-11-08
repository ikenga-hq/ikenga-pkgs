/**
 * akuko — builds the three example freehand views (WP-07c) from the converted
 * "The Beating" fixture. Each view is a self-contained HTML page.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning evals/views/build.ts
 *
 *   cast-sheet          read-only   (evals/views/cast-sheet/view.src.html)
 *   scene-comparison    read-only   (evals/views/scene-comparison/view.src.html)
 *   spend-breakdown     writes decisions: views/__fixtures__/tiny-board.html
 *                       restyled (light and dark) with a breakdown section added,
 *                       a fresh freehand id and the current decision writer
 *
 * The committed view.html files must equal this output (evals/views/views.test.ts).
 * This is the worked example for actions/view.md: the agent does the same by hand,
 * for the question it was asked.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AKUKO = resolve(HERE, '..', '..');

/** The project as the page holds it: `<` is written as < so it can never close the script tag. */
export function projectBlock(): string {
  const p = JSON.parse(readFileSync(resolve(AKUKO, 'fixtures/the-beating/akuko.json'), 'utf8'));
  return JSON.stringify(p).replace(/</g, '\\u003c');
}

/** The canonical decision writer (scripts/check-view/decision-writer.js), exactly as it is on disk (v2). */
export function decisionWriterV2(): string {
  const w = readFileSync(resolve(AKUKO, 'scripts/check-view/decision-writer.js'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!w.startsWith('/* akuko-decision-writer v2 ')) throw new Error('build: decision-writer.js is not v2; rebuild the example views against the current writer');
  return w;
}

function replaceOnce(src: string, from: string | RegExp, to: string, what: string): string {
  const hit = typeof from === 'string' ? src.includes(from) : from.test(src);
  if (!hit) throw new Error(`build: could not find ${what} in the source page`);
  return src.replace(from, () => to);
}

const LIGHT =
  '--bg: #faf6f1; --surface: #ffffff; --fg: #1d1a17; --muted: #5b4f44; --line: #b9a999; --ember: #a8420c; --on-ember: #ffffff; --ok: #1f6b34; --warn: #7a5200; --seg1: #a8420c; --seg2: #2b5f8a; --seg3: #1f6b34; --seg4: #5b4f44;';
const DARK =
  '--bg: #17120e; --surface: #221a14; --fg: #f4ede5; --muted: #cfc2b4; --line: #5a4a3c; --ember: #f08a4b; --on-ember: #1a120c; --ok: #8fd19e; --warn: #f2c46d; --seg1: #f08a4b; --seg2: #7fb6e6; --seg3: #8fd19e; --seg4: #cfc2b4;';

const BREAKDOWN_CSS = `
#spend { order: -1; }
#breakdown .mix { display: flex; height: 18px; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; margin: 8px 0 4px; }
#breakdown .mix span { display: block; height: 100%; }
#breakdown .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 14px; margin: 0 0 8px; padding: 0; list-style: none; }
#breakdown .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
#breakdown td.num, #breakdown th.num { text-align: right; }`;

const BREAKDOWN_HTML = `<section id="breakdown" aria-labelledby="h-break"></section>
`;

const BREAKDOWN_JS = `    // Spend breakdown (read-only, derived from the project; the controls stay in the spend gate below).
    var GROUP = { char: 'Characters', loc: 'Locations', sc: 'Shots' };
    var byProv = {}, byKind = {};
    V.ledger.forEach(function (e) {
      if (e.status !== 'done') return;
      var a = e.actual || 0, k = GROUP[String(e.unit).split('_')[0]] || 'Other';
      byProv[e.provider] = byProv[e.provider] || { n: 0, sum: 0 };
      byProv[e.provider].n++; byProv[e.provider].sum += a;
      byKind[k] = (byKind[k] || 0) + a;
    });
    var cap = b ? b.cap : 0;
    var left = b ? b.cap - b.spent - sunk - flight - committed - awaiting : 0;
    var pct = function (n) { return cap > 0 ? Math.max(0, Math.min(100, 100 * n / cap)) : 0; };
    $('#breakdown').innerHTML = '<h2 id="h-break">Where the money goes</h2>' + (b ?
      '<div class="mix" role="img" aria-label="Cap split into spent, waiting for your approval, and left"><span style="width:' + pct(b.spent) + '%;background:var(--seg1)"></span><span style="width:' + pct(awaiting + committed) + '%;background:var(--seg2)"></span><span style="width:' + pct(left) + '%;background:var(--seg3)"></span></div>' +
      '<ul class="legend"><li><span class="sw" style="background:var(--seg1)"></span>Spent ' + money(b.spent) + '</li><li><span class="sw" style="background:var(--seg2)"></span>Waiting or approved ' + money(awaiting + committed) + '</li><li><span class="sw" style="background:var(--seg3)"></span>Left if you approve ' + money(left) + '</li></ul>' +
      '<p class="muted">Cap ' + money(cap) + '. The approve and decline buttons are in the spend gate.</p>' : '<p>No budget cap is set.</p>') +
      '<h3>Spent so far, by provider</h3><table><thead><tr><th scope="col">Provider</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Charged</th></tr></thead><tbody>' +
      Object.keys(byProv).map(function (p) { return '<tr><td>' + esc(p) + '</td><td class="num">' + byProv[p].n + '</td><td class="num money">' + money(byProv[p].sum) + '</td></tr>'; }).join('') +
      '</tbody></table><h3>Spent so far, by kind</h3><table><tbody>' +
      Object.keys(byKind).map(function (k) { return '<tr><th scope="row">' + esc(k) + '</th><td class="num money">' + money(byKind[k]) + '</td></tr>'; }).join('') +
      '</tbody></table>';
`;

export function buildSpendBreakdown(): string {
  let h = readFileSync(resolve(AKUKO, 'views/__fixtures__/tiny-board.html'), 'utf8').replace(/\r\n/g, '\n');
  h = replaceOnce(h, /<!--[\s\S]*?-->/, `<!--
  akuko freehand view: spend breakdown with per-job approve / decline. Designed
  for the ask "where is the money going, and what is waiting on me?". It writes
  decisions, so it starts from the conforming page (views/__fixtures__/tiny-board.html),
  keeps every required view, mark and the decision writer, and adds a read-only
  breakdown above the spend gate. Its id is its own: freehand:spend-breakdown@1.
  Check it with scripts/check-view.mjs before publishing (actions/view.md).
-->`, 'the header comment');
  h = replaceOnce(h, /<title>[^<]*<\/title>/, '<title>Spend breakdown</title>', 'the title');
  h = replaceOnce(h, /^:root \{[^\n]*\}$/m, `:root { color-scheme: light dark; ${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
:root[data-theme="dark"] { color-scheme: dark; ${DARK} }`, 'the :root tokens');
  h = replaceOnce(h, 'color: #1a120c; font-weight: 600; }', 'color: var(--on-ember); font-weight: 600; }', 'the primary button colour');
  h = replaceOnce(h, '@media (prefers-reduced-motion', `${BREAKDOWN_CSS.trim()}\n@media (prefers-reduced-motion`, 'the reduced-motion rule');
  h = replaceOnce(h, '"id":"test-board","version":"1","title":"akuko minimal review board"', '"id":"freehand:spend-breakdown","version":"1","title":"Spend breakdown"', 'the manifest id');
  h = replaceOnce(
    h,
    /\/\* akuko-decision-writer v\d[\s\S]*?\/\* end akuko-decision-writer \*\//,
    decisionWriterV2(),
    'the inlined decision writer',
  );
  h = replaceOnce(h, '<div class="grid">', `${BREAKDOWN_HTML}<div class="grid">`, 'the grid');
  h = replaceOnce(h, '    var n = W.all().length;', `${BREAKDOWN_JS}\n    var n = W.all().length;`, 'the footer render');
  // The project block: the same fixture, written the same way.
  const tag = '<script type="application/json" id="akuko-project">';
  const at = h.indexOf(tag);
  if (at < 0) throw new Error('build: could not find the project block in the source page');
  const end = h.indexOf('</script>', at);
  h = h.slice(0, at + tag.length) + projectBlock() + h.slice(end);
  return h;
}

function buildFromSource(dir: string): string {
  const src = readFileSync(resolve(HERE, dir, 'view.src.html'), 'utf8').replace(/\r\n/g, '\n');
  return replaceOnce(src, '{{PROJECT}}', projectBlock(), 'the {{PROJECT}} placeholder');
}

/** Every example view, keyed by its folder name. */
export function buildAll(): Record<string, string> {
  return {
    'cast-sheet': buildFromSource('cast-sheet'),
    'scene-comparison': buildFromSource('scene-comparison'),
    'spend-breakdown': buildSpendBreakdown(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const [name, html] of Object.entries(buildAll())) {
    writeFileSync(resolve(HERE, name, 'view.html'), html);
    console.log(`wrote evals/views/${name}/view.html (${html.length} bytes)`);
  }
}
