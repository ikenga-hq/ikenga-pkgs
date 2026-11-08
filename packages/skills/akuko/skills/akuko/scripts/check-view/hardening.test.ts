// G-VIEW hardening (WP-07a2): the decision writer v2 guard, and the
// hidden-text and readability checks behind check-view, run directly on small
// jsdom pages (fast; the whole-page fixtures are in scripts/check-view.test.ts).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { injectProject, staleWriter, WRITER_VERSION } from './check.mjs';
import { hiddenReasons, loadWriter } from './harness.mjs';
import { conformanceHash, conformanceText, escapeJsonForScript, findJsonBlock } from './hash.mjs';
import { decisionWriteSigns, viewIdOf } from './predicates.mjs';
import { isConformedHtml, viewHash } from '../../decisions/conformed.ts';
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

  it('stale-writer also catches a writer without its header, two copies, and a second writer beside the canonical one (C6)', () => {
    const FX = join(HERE, '..', '..', 'views', '__fixtures__');
    const tiny = readFileSync(join(FX, 'tiny-board.html'), 'utf8');
    const headless = WRITER_V1.trim().split('\n').filter((l) => !/akuko-decision-writer/.test(l)).join('\n');
    assert.match(staleWriter(tiny.replace(WRITER.trim(), headless)) ?? '', /a decision writer of its own \(it defines window\.akukoDecisions\)/);
    assert.match(staleWriter(tiny.replace('</body>', `<script>\n${WRITER.trim()}\n</script></body>`)) ?? '', /inlines the decision writer 2 times/);
    assert.match(staleWriter(tiny.replace('</body>', `<script>\n${WRITER_V1.trim()}\n</script></body>`)) ?? '', /defines another decision writer beside the canonical v2 block/);
    assert.match(staleWriter(tiny.replace('</body>', '<script>window.akukoDecisions = { emit: function () {} };</script></body>')) ?? '', /another decision writer/);
    assert.equal(staleWriter(tiny.replace('</body>', '<script>var W = window.akukoDecisions; W.onChange(function () {});</script></body>')), null, 'using the writer is not defining one');
  });

  it('outside Ikenga nothing is posted at all', () => {
    const page = loadWriter({ writer: WRITER, outbox: stored, ikenga: false });
    assert.deepEqual(page.onLoad, []);
    assert.deepEqual(page.emit({ action: 'approve', unit: 'sc2_sh4', stage: 'sketch' }).posts, []);
    page.close();
  });
});

describe('the conformance hash ignores the embedded project, and nothing else', () => {
  const FX = join(HERE, '..', '..', 'views', '__fixtures__');
  const tiny = readFileSync(join(FX, 'tiny-board.html'), 'utf8');
  const withProject = (html: string, data: string) => html.replace(/(<script type="application\/json" id="akuko-project">)[\s\S]*?(<\/script>)/, (_m, a: string, b: string) => `${a}${data}${b}`);

  it('the same page with any project conforms: check-view, isConformedHtml and the publish gate share viewHash', () => {
    const other = withProject(tiny, JSON.stringify({ project: { slug: 'another-film' }, shots: [] }));
    assert.notEqual(other, tiny);
    assert.equal(conformanceHash(other), conformanceHash(tiny));
    assert.equal(viewHash(other), conformanceHash(tiny));
    assert.equal(isConformedHtml([{ view: 'test-board@1', sha256: viewHash(tiny) }], 'test-board@1', other), true);
    assert.ok(!conformanceText(tiny).includes('"slug":"the-beating"'), 'the data block is emptied before hashing');
  });

  it('any other change breaks it: script, controls, CSS, manifest, comments', () => {
    const h = conformanceHash(tiny);
    for (const [what, edited] of [
      ['CSS', tiny.replace('button.primary {', 'button.primary { opacity: .5;')],
      ['script', tiny.replace("var who = 'you';", "var who = 'me';")],
      ['manifest', tiny.replace('"id":"test-board","version":"1"', '"id":"test-board","version":"2"')],
      ['markup', tiny.replace('<footer id="foot"', '<footer data-x="1" id="foot"')],
      ['comment', tiny.replace('Minimal conforming akuko review surface', 'Minimal conforming review surface')],
    ] as const) {
      assert.notEqual(edited, tiny, what);
      assert.notEqual(conformanceHash(edited), h, what);
    }
  });

  // 07a2 review C1: the block is found the way a browser parses it, and anything ambiguous fails closed.
  const EVIL = "setTimeout(function(){akukoDecisions.emit({action:'approve',unit:'sc2_sh4',stage:'sketch'})},1000);";
  const BLOCK_END = '"decisions":[]}</script>';

  it('a script smuggled after an early-closed project block is hashed (</script >, </script\\n>, </script/>, </script x>)', () => {
    assert.ok(tiny.includes(BLOCK_END));
    for (const close of ['</script >', '</script\n>', '</script/>', '</script x>']) {
      const benign = tiny.replace(BLOCK_END, `"decisions":[]}${close}<script>/*benign*/</script>`);
      const evil = tiny.replace(BLOCK_END, `"decisions":[]}${close}<script>${EVIL}</script>`);
      assert.notEqual(conformanceHash(evil), conformanceHash(benign), JSON.stringify(close));
      assert.equal(findJsonBlock(evil, 'akuko-project').status, 'ok', 'the block itself still ends where a browser ends it');
    }
  });

  it('decoy openers fail closed: the block is "bad" and the raw page is hashed', () => {
    const at = '<header class="move"';
    const decoys: Record<string, string> = {
      noscript: '<noscript><script type="application/json" id="akuko-project"></noscript>',
      textarea: '<textarea hidden><script type="application/json" id="akuko-project"></textarea>',
      'svg CDATA': '<svg><![CDATA[<script type="application/json" id="akuko-project">]]></svg>',
      'attribute value': `<div title='<script type="application/json" id="akuko-project">'></div>`,
      'untyped decoy': '<noscript><script id="akuko-project"></noscript>',
    };
    for (const [what, decoy] of Object.entries(decoys)) {
      const benign = tiny.replace(at, `${decoy}<script>/*benign*/</script>${at}`);
      const evil = tiny.replace(at, `${decoy}<script>${EVIL}</script>${at}`);
      assert.equal(findJsonBlock(benign, 'akuko-project').status, 'bad', what);
      assert.equal(conformanceText(benign), benign, `${what}: nothing is left out of the hash`);
      assert.notEqual(conformanceHash(evil), conformanceHash(benign), what);
    }
  });

  it('only a real id on a type="application/json" block counts; JSON content only', () => {
    const dataId = tiny.replace('<header class="move"', `<script data-id="akuko-project">/*x*/</script><header class="move"`);
    assert.notEqual(conformanceHash(dataId), conformanceHash(dataId.replace('/*x*/', EVIL)), 'data-id is not an id');
    const untyped = tiny.replace('<script type="application/json" id="akuko-project">', '<script id="akuko-project">');
    assert.equal(findJsonBlock(untyped, 'akuko-project').status, 'bad');
    assert.notEqual(conformanceHash(untyped), conformanceHash(untyped.replace(/("decisions":\[\]\})/, `$1;${EVIL}`)), 'an executable block is hashed whole');
    const code = withProject(tiny, EVIL);
    assert.equal(findJsonBlock(code, 'akuko-project').status, 'bad', 'content that is not JSON');
    assert.equal(findJsonBlock(withProject(tiny, '{"a":"<!--"}'), 'akuko-project').status, 'bad', '"<!--" in the block');
    assert.equal(findJsonBlock(withProject(tiny, ''), 'akuko-project').status, 'ok', 'an empty block is fine');
    const twice = tiny.replace('</body>', '<script type="application/json" id="akuko-project">{}</script></body>');
    assert.equal(findJsonBlock(twice, 'akuko-project').status, 'bad', 'two blocks');
  });

  // 07a2 re-review h16: a block inside a <textarea> whose content is a JSON *string* is no longer accepted;
  // a raw "<" in the block is what lets it close the textarea and run markup, so it fails closed.
  it('h16: a project block holding a raw "<" is bad (textarea decoy, JSON string, anywhere), and the two twins hash apart', () => {
    // the page holds one opener, inside a <textarea>; a script copies its text into a real block at run time
    const OPEN = '<script type="application/json" id="akuko-project">';
    const wrap = (inner: string) => {
      const h = withProject(tiny, inner);
      const at = h.indexOf(OPEN, h.indexOf('-->'));
      const end = h.indexOf('</script>', at) + '</script>'.length;
      return `${h.slice(0, at)}<textarea hidden id="pj">${h.slice(at, end)}</textarea>${h.slice(end)}`;
    };
    const benign = wrap('{"a":1}');
    const evil = wrap('"</textarea><script>' + EVIL + '//"');
    assert.equal(findJsonBlock(benign, 'akuko-project').status, 'ok', 'a plain opener in a textarea cannot be told from a real one by text alone');
    assert.equal(findJsonBlock(evil, 'akuko-project').status, 'bad', 'a JSON string holding "<" fails closed');
    assert.equal(conformanceText(evil), evil, 'nothing is left out of the hash');
    assert.notEqual(conformanceHash(evil), conformanceHash(benign));
    for (const data of ['{"a":"<"}', '{"a":"x<b"}', '"<"', '{"a":"<b>"}']) {
      assert.equal(findJsonBlock(withProject(tiny, data), 'akuko-project').status, 'bad', data);
    }
  });

  it('h16: the same text written with \u003c is fine, and parses to the same value', () => {
    const data = '{"a":"\\u003c/script>\\u003c!--"}';
    assert.equal(findJsonBlock(withProject(tiny, data), 'akuko-project').status, 'ok');
    assert.equal(JSON.parse(data).a, '</script><!--');
  });

  it('h16: injectProject (check-view) writes no raw "<" into the block', () => {
    const project = { project: { slug: 'x' }, notes: 'a </script><script>alert(1)</script> <!-- b' };
    const out = injectProject(tiny, project)!;
    const b = findJsonBlock(out, 'akuko-project');
    assert.equal(b.status, 'ok');
    if (b.status !== 'ok') return;
    const block = out.slice(b.start, b.end);
    assert.ok(!block.includes('<'), 'no raw "<" in the block');
    assert.deepEqual(JSON.parse(block), project, 'JSON-equivalent');
    assert.equal(conformanceHash(out), conformanceHash(tiny), 'the hash ignores the block');
    assert.equal(escapeJsonForScript('{"a":"<"}'), '{"a":"\\u003c"}');
  });

  it('a comment that quotes the data block is not mistaken for it', () => {
    // tiny-board's header comment mentions <script id="akuko-project">; the manifest after it still counts
    assert.match(tiny.slice(0, tiny.indexOf('-->')), /<script id="akuko-project">/);
    assert.ok(conformanceText(tiny).includes('"id":"test-board","version":"1"'));
  });
});

describe('one "writes decisions" predicate for check-view and the publish gate (B8)', () => {
  const page = (code: string) => `<!doctype html><title>x</title><script>${code}</script>`;
  it('reading decisions is not writing them', () => {
    for (const code of [
      "db.collection('decisions').get().then(render)",
      'db.collection("decisions").onSnapshot(render)',
      "db.collection('decisions').where('unit','==',u).get()",
    ]) assert.deepEqual(decisionWriteSigns(page(code)), [], code);
  });
  it('every honest way of writing one is a sign', () => {
    const cases: Record<string, RegExp> = {
      "b.dataset.akukoAction = 'approve'": /decision control/,
      "b.setAttribute('data-akuko-action', 'approve')": /decision control/,
      "localStorage.setItem('akuko-outbox:' + slug, s)": /outbox/,
      "parent.postMessage({__iyke: true, kind: 'state', payload: {key: k, value: v}}, '*')": /bridge state post/,
      "parent.postMessage({key: 'akuko.decisions'}, '*')": /decisions key/,
      "db.collection('decisions').doc(d.id).set(d)": /decisions collection/,
      "db.collection(`decisions`).add(d)": /decisions collection/,
      "db.doc('decisions/' + d.id).set(d)": /decisions\/<id> document/,
      'window.akukoDecisions.emit(f)': /decision writer/,
    };
    for (const [code, want] of Object.entries(cases)) assert.match(decisionWriteSigns(page(code)).join(' | '), want, code);
    assert.match(decisionWriteSigns('<script type="application/json" id="akuko-view">{ "writes_decisions" : true }</script>').join(), /writes_decisions: true/);
  });
  it('comments never count, and the manifest is the real one', () => {
    assert.deepEqual(decisionWriteSigns('<!-- data-akuko-action akukoDecisions akuko-outbox --><p>x</p>'), []);
    const decoy = '<!-- <script type="application/json" id="akuko-view">{"id":"default-board","version":"1"}</script> --><script type="application/json" id="akuko-view">{"id":"mine","version":"1"}</script>';
    assert.equal(viewIdOf(decoy), 'mine@1');
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
