// G-VIEW hardening (WP-07a2): the decision writer v2 guard, and the
// hidden-text and readability checks behind check-view, run directly on small
// jsdom pages (fast; the whole-page fixtures are in scripts/check-view.test.ts).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { staleWriter, WRITER_VERSION } from './check.mjs';
import { hiddenReasons, loadWriter } from './harness.mjs';
import { smallText, substituteVars } from './hidden.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WRITER = readFileSync(join(HERE, 'decision-writer.js'), 'utf8');
const V2_GUARD = '  if (outbox.length) toIkenga(); // never post an empty list over a stored one (host C remount)';
/** The v1 writer, rebuilt from v2 by undoing exactly its two edits (to show what v2 fixes). */
const WRITER_V1 = WRITER
  .replace('/* akuko-decision-writer v2 —', '/* akuko-decision-writer v1 —')
  .replace(V2_GUARD, '  toIkenga();');

const stored = [
  { id: '0b7d3c38-6f6a-4c5e-9d0e-1f2a3b4c5d6e', action: 'approve', unit: 'sc2_sh4', stage: 'sketch', by: 'you', at: '2026-11-08T10:00:00.000Z', view: 'test-board@1' },
  { id: '1c8e4d49-7a7b-4d6f-8e1f-2a3b4c5d6e7f', action: 'note', unit: 'sc4_sh2', stage: 'sketch', text: 'warmer', by: 'you', at: '2026-11-08T10:01:00.000Z', view: 'test-board@1' },
];
const stateValue = (p: { payload?: { key?: string; value?: unknown } }) => (p.payload?.key === 'akuko.decisions' ? p.payload.value : undefined);

describe('decision writer v2 (host C remount guard)', () => {
  it('is the canonical block: v2 header and the guarded load-site post', () => {
    assert.match(WRITER, /^\/\* akuko-decision-writer v2 — views\/contract\.md §Decision writer\. Inline this block verbatim\. \*\/\n/);
    assert.ok(WRITER.includes(`  // Host C: re-publish the outbox after a pane reload.\n${V2_GUARD}\n`));
  });

  it('on load with an empty outbox it posts nothing to the parent', () => {
    for (const outbox of [[], null]) {
      const page = loadWriter({ writer: WRITER, outbox });
      assert.deepEqual(page.onLoad, [], `outbox ${JSON.stringify(outbox)}`);
      page.close();
    }
  });

  it('v1 did post an empty list on load: what overwrote the shell\'s stored decisions on a remount', () => {
    const page = loadWriter({ writer: WRITER_V1, outbox: [] });
    assert.equal(page.onLoad.length, 1);
    assert.deepEqual(stateValue(page.onLoad[0]!), []);
    page.close();
  });

  it('on load with a non-empty outbox it posts the full list, once', () => {
    const page = loadWriter({ writer: WRITER, outbox: stored });
    assert.equal(page.onLoad.length, 1);
    assert.equal(page.onLoad[0]!.__iyke, true);
    assert.equal(page.onLoad[0]!.kind, 'state');
    assert.deepEqual(stateValue(page.onLoad[0]!), stored);
    page.close();
  });

  it('after a remount an emit posts the whole outbox, the new decision included', () => {
    const page = loadWriter({ writer: WRITER, outbox: [] });
    const { decision, posts } = page.emit({ action: 'approve', unit: 'sc2_sh4', stage: 'sketch' });
    assert.equal(posts.length, 1);
    assert.deepEqual((stateValue(posts[0]!) as { id: string }[]).map((d) => d.id), [decision.id]);
    page.close();
    const again = loadWriter({ writer: WRITER, outbox: stored });
    const next = again.emit({ action: 'approve', unit: 'sc4_sh2', stage: 'sketch' });
    assert.deepEqual((stateValue(next.posts[0]!) as { id: string }[]).map((d) => d.id), [...stored.map((d) => d.id), next.decision.id]);
    again.close();
  });

  it('stale-writer: a page must inline the current canonical block byte for byte', () => {
    const FX = join(HERE, '..', '..', 'views', '__fixtures__');
    const tiny = readFileSync(join(FX, 'tiny-board.html'), 'utf8');
    assert.equal(WRITER_VERSION, 'v2');
    assert.equal(staleWriter(tiny), null);
    assert.equal(staleWriter(readFileSync(join(FX, 'board-b-instrumented.html'), 'utf8')), null);
    assert.equal(staleWriter(tiny.replace(/\n/g, '\r\n')), null, 'line endings aside');
    assert.equal(staleWriter('<script>var x = 1;</script>'), null, 'a page that writes the stores itself is not judged here');
    const v1 = tiny.replace(WRITER.trim(), WRITER_V1.trim());
    assert.notEqual(v1, tiny);
    assert.match(staleWriter(v1) ?? '', /inlines akuko-decision-writer v1; inline the current canonical v2 block/);
    const edited = tiny.replace("var who = 'you';", "var who = 'claude';");
    assert.match(staleWriter(edited) ?? '', /a changed copy of akuko-decision-writer v2/);
    assert.match(staleWriter(tiny.replace(/akuko-decision-writer v2 —/, 'akuko-decision-writer —')) ?? '', /an unversioned copy/);
  });

  it('outside Ikenga nothing is posted at all', () => {
    const page = loadWriter({ writer: WRITER, outbox: stored, ikenga: false });
    assert.deepEqual(page.onLoad, []);
    assert.deepEqual(page.emit({ action: 'approve', unit: 'sc2_sh4', stage: 'sketch' }).posts, []);
    page.close();
  });
});

describe('custom properties (F4)', () => {
  it('substituteVars resolves nested references and fallbacks, and leaves unknowns as written', () => {
    const vars: Record<string, string> = { '--a': 'var(--b)', '--b': '6px', '--f': 'Inter, sans-serif' };
    const look = (n: string) => vars[n] ?? null;
    assert.equal(substituteVars('var(--a)', look), '6px');
    assert.equal(substituteVars('600 var(--a)/1 var(--f)', look), '600 6px/1 Inter, sans-serif');
    assert.equal(substituteVars('var(--missing, 9px)', look), '9px');
    assert.equal(substituteVars('var(--missing, var(--b))', look), '6px');
    assert.equal(substituteVars('var(--missing)', look), 'var(--missing)');
  });

  it('the readability floor sees through tokens: a tiny token used for text fails, a normal one passes', () => {
    assert.deepEqual(smallText(':root{--z:0px} .estimate{font-size:var(--z)}', '', ''), ['var(--z)']);
    assert.deepEqual(smallText(':root{--fs:6pt} .x{font: 600 var(--fs)/1 sans-serif}', '', ''), ['font: 600 var(--fs)/1 sans-serif']);
    assert.deepEqual(smallText(':root{--fs:16px} @media (max-width:400px){:root{--fs:10px}} .x{font-size:var(--fs)}', '', ''), ['var(--fs)'], 'judged by the smallest value it is ever given');
    assert.deepEqual(smallText('.x{font-size:var(--nope, 8px)}', '', ''), ['var(--nope, 8px)']);
    assert.deepEqual(smallText(':root{--fs:14px; --tiny:2px} .x{font-size:var(--fs)} .rule{height:var(--tiny)}', '', ''), [], 'a small token not used for text is fine');
    assert.deepEqual(smallText(':root{--font-sans: Inter, sans-serif} .x{font: 600 14px/1 var(--font-sans)}', '', ''), []);
    assert.deepEqual(smallText(':root{--s:8px} svg text{font-size:var(--s)}', '', ''), [], 'SVG text stays exempt');
  });
});

describe('hidden text (F4 and the cheap extras F5, W01–W09)', () => {
  const page = `<!doctype html><html><head><style>
:root { --z: 0px; --bg: #221a14; --none: none; }
body { background: #17120e; color: #f4ede5; font-size: 16px; }
.card { background: var(--bg); }
#var-font { font-size: var(--z); }
#var-display { display: var(--none); }
#cv { content-visibility: hidden; }
#op1, #op1 > span { opacity: .2; }
#filter { filter: opacity(0); }
#same { color: #221a14; }
#translate { display: inline-block; transform: translateX(-10000px); }
#margin { display: inline-block; margin-left: -9999px; }
#tall { height: 1px; overflow: hidden; }
#ok { font-size: 14px; }
#dim { color: #cfc2b4; }
</style></head><body>
<p class="card"><span id="var-font">0.36</span></p>
<p><span id="var-display">0.36</span></p>
<div id="cv"><span id="cv-in">0.36</span></div>
<div id="op1"><span><b id="op1-in">0.36</b></span></div>
<span id="filter">0.36</span>
<p class="card"><span id="same">0.36</span></p>
<span id="translate">0.36</span>
<span id="margin">0.36</span>
<div id="tall"><span id="tall-in">0.36</span></div>
<p class="card"><span id="ok">0.36</span> <span id="dim">0.36</span></p>
</body></html>`;
  const r = hiddenReasons(page, ['var-font', 'var-display', 'cv-in', 'op1-in', 'filter', 'same', 'translate', 'margin', 'tall-in', 'ok', 'dim']);

  it('font-size and display through var() (F4)', () => {
    assert.equal(r['var-font'], 'font-size: 0px');
    assert.equal(r['var-display'], 'display: none');
  });
  it('content-visibility: hidden on an ancestor (F5)', () => assert.equal(r['cv-in'], 'content-visibility: hidden'));
  it('opacity that compounds below 5% down the tree (W01), and filter: opacity(0) (W09)', () => {
    assert.match(r['op1-in'] ?? '', /opacity compounds to 0\.040/);
    assert.match(r.filter ?? '', /^filter: opacity\(0\)/);
  });
  it('text the colour of its background (W04)', () => assert.match(r.same ?? '', /^text the colour of its background \(contrast 1\.00:1\)/));
  it('translated or margined off-screen (W06, W07)', () => {
    assert.match(r.translate ?? '', /^off-screen \(transform: translateX\(-10000px\)\)/);
    assert.equal(r.margin, 'off-screen (margin-left: -9999px)');
  });
  it('a box too short for a line of text with overflow hidden (W08)', () => assert.equal(r['tall-in'], 'height: 1px with overflow hidden'));
  it('ordinary text is shown, including muted text on a dark card', () => {
    assert.equal(r.ok, null);
    assert.equal(r.dim, null);
  });
});
