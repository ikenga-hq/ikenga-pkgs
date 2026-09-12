// com.ikenga.studio · node-canvas CONTROL contracts (G-102 / G-103 / G-104)
//
//   bun run src/studio/lib/canvas-controls.test.ts   (from packages/apps/studio/)
//
// Plain assert-based script (no bun:test / node:test import) so it typechecks
// under `tsc -p tsconfig.web.json` alongside the rest of `src/`, same rationale
// as `canvas-links.test.ts`, which owns the derivation half of this module.
//
// This file owns the three things the WP-32 live round found wrong about the
// node canvas's create/delete AFFORDANCES, as opposed to their seams (the seams
// themselves round-tripped to disk correctly — `g61/5-verdict.md`):
//
//   • G-102 — five destructive controls with the IDENTICAL accessible name,
//     because `beatNameOf`'s uniqueness assumption ("`beat_id` carries a random
//     suffix") holds only for cells this FE created. All five cells on the live
//     fixture read `beat_id = beat-hello`. BOTH surfaces are in scope: the Rail
//     is the default view (`canvasMode` starts at 'rail') and the one whose ✕
//     the live round drove with a real OS mouse, so a fix that reached only the
//     node canvas would have left the defect where a human meets it.
//   • G-103 — two create controls that disagreed about a new shot's `index`,
//     in TWO ways: different arithmetic (the Rail's `displayCells.length` vs
//     the canvas's `max + 1`, which diverge on a gapped board) and different
//     BOARDS (`displayCells` silently falls back to the 10-entry presentation
//     fixture whenever `hasRealCells` is false — including a real project with
//     zero cells). Both halves have to be pinned or the surfaces re-diverge.
//   • G-104 — the canvas's own status line and toolbar are in the a11y tree
//     with working handlers and are not painted anywhere in the window.
//
//     The CAUSE IS NOT KNOWN. The first pass recorded it as "they were
//     `<Canvas>` children, so they sat inside `.ikenga-canvas`, a scroll
//     container the un-positioned node roots (G-86) had inflated" — and
//     `reload-b3/verdict.md` falsifies that as the explanation: the bars were
//     still unpainted after the node roots were positioned, with every node
//     on screen, which a scroll of that box cannot produce. So the tests below
//     pin only what the change actually CLAIMS — the bars are siblings of
//     `<Canvas>`, and no box between them and the pane can scroll — and
//     deliberately assert nothing about the symptom being fixed. G-104 stays
//     open; see the chrome-layer comment in NodeCanvas.tsx for the one read
//     that would settle it.
//
// Most of these are structural facts about the view, so they are asserted
// against the view's SOURCE TEXT — same technique and same reason as the node
// root / auto-fit tests in `canvas-links.test.ts`: the defect is "which element
// is this a child of", which a headless runner cannot see any other way, and a
// runtime check would need a DOM plus the pan/zoom primitive.

import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  beatNameOf,
  buildNewLaneCell,
  deleteCellControlName,
  deleteConfirmDialogName,
  nextLaneIndex,
} from './canvas-model';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const nodeCanvasSrc = (): string =>
  readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
const railSrc = (): string =>
  readFileSync(new URL('../views/Canvas.tsx', import.meta.url), 'utf8');

/** The WP-32 live fixture, reduced to the fields the names read: five cells
 *  sharing one `beat_id`, which is the whole point.
 *  (`g61/5-graphmode-dom.txt`, refs e62/e71/e81/e91/e101.) */
const FIXTURE = [
  { uid: 'hello-lofi', beat_id: 'beat-hello', label: 'Hello (lofi)' },
  { uid: 'hello-hifi-1', beat_id: 'beat-hello', label: 'Hello (hifi 1)' },
  { uid: 'hello-hifi-2', beat_id: 'beat-hello', label: 'Hello (hifi 2)' },
  { uid: 'hello-hifi-3', beat_id: 'beat-hello', label: 'Hello (hifi 3)' },
  { uid: 'hello-hifi-4', beat_id: 'beat-hello', label: 'Hello (hifi 4)' },
];

// ── G-102 · destructive-control names ───────────────────────────────────

test('beatNameOf is the Rail`s DisplayCell.beat, in the same order', () => {
  assert.equal(beatNameOf({ uid: 'u1', beat_id: 'b1', label: 'L' }), 'b1');
  assert.equal(beatNameOf({ uid: 'u1', beat_id: '', label: 'L' }), 'L');
  assert.equal(beatNameOf({ uid: 'u1', beat_id: '', label: '' }), 'u1');
  // Nulls behave like absent — `beat_id` is `z.string()` on disk but a
  // hand-edited storyboard.json can still hand us an empty one.
  assert.equal(beatNameOf({ uid: 'u1', beat_id: null, label: null }), 'u1');
  assert.equal(beatNameOf({ uid: 'u1' }), 'u1');
});

test('beatNameOf takes the Rail`s DisplayCell shape and agrees with the raw cell', () => {
  // The Rail renders `DisplayCell`s: `beat` is pre-computed and there is no
  // `beat_id` / `label` on the object at all. Without the `beat` branch this
  // "shared" helper falls through to `uid`, i.e. the two surfaces would have
  // gone on naming the same shot differently while sharing a function.
  const raw = { uid: 'hello-lofi', beat_id: 'beat-hello', label: 'Hello (lofi)' };
  // `toDisplayCell`'s own expression, inlined rather than imported (the store
  // pulls in zustand + the MCP client, which this plain script must not boot).
  const display = { uid: raw.uid, beat: raw.beat_id || raw.label || raw.uid };
  assert.equal(beatNameOf(display), beatNameOf(raw));
  assert.equal(deleteCellControlName(display), deleteCellControlName(raw));
  assert.equal(deleteCellControlName(display), 'Delete cell beat-hello (hello-lofi)');
  // A demo-board MockCell (no beat_id/label either) still names its beat.
  assert.equal(deleteCellControlName({ uid: 'c01', beat: 'hook' }), 'Delete cell hook (c01)');
});

test('G-102: the live fixture yields five DISTINCT delete-control names', () => {
  // The defect, stated as a test: `beatNameOf` alone collapses to one string.
  const beats = new Set(FIXTURE.map(beatNameOf));
  assert.equal(beats.size, 1, 'fixture premise: all five cells share beat_id');
  // The fix: the control name is unique per cell.
  const names = FIXTURE.map(deleteCellControlName);
  assert.equal(new Set(names).size, FIXTURE.length);
  // …and it is unique because it carries the uid, not because it happens to.
  for (const cell of FIXTURE) {
    const name = deleteCellControlName(cell);
    assert.ok(name.includes(cell.uid), `${name} must name the cell it deletes`);
    assert.ok(name.startsWith('Delete cell beat-hello '), `unexpected shape: ${name}`);
  }
  assert.equal(deleteCellControlName(FIXTURE[0]), 'Delete cell beat-hello (hello-lofi)');
});

test('G-102: names stay distinct for cells this surface created', () => {
  // The other collision the old comment worried about and did not prevent:
  // the canvas create path has no label input, so every shot it makes is
  // labelled NEW_CELL_LABEL. Three creates, three names.
  let n = 0;
  const suffix = () => `s${(n += 1)}`;
  const made = [0, 1, 2].map((index) =>
    buildNewLaneCell({ index, suffix, now: () => '2026-09-12T00:00:00.000Z' }),
  );
  assert.equal(new Set(made.map((c) => c.label)).size, 1, 'premise: one label');
  assert.equal(new Set(made.map(deleteCellControlName)).size, 3);
});

test('G-102: the confirm dialog names its target and does not collide', () => {
  const cell = FIXTURE[2];
  const dialog = deleteConfirmDialogName({ uid: cell.uid, beat: beatNameOf(cell) });
  assert.equal(dialog, 'Confirm deleting cell beat-hello (hello-hifi-2)');
  assert.ok(dialog.includes(cell.uid));
  // The button that opened it is still in the tree behind the modal, so the
  // two names must not be the same string — a name-resolving driver would
  // otherwise have two candidates for one destructive click.
  assert.notEqual(dialog, deleteCellControlName(cell));
  // Distinct per cell too, so a screenshot/DOM dump of an armed dialog says
  // which shot is at stake without reading the body copy.
  const all = FIXTURE.map((c) => deleteConfirmDialogName({ uid: c.uid, beat: beatNameOf(c) }));
  assert.equal(new Set(all).size, FIXTURE.length);
});

test('G-102: both shot roots and the dialog go through the name helpers', () => {
  const src = nodeCanvasSrc();
  // Two per-shot delete controls (expanded card + collapsed strip), both named
  // by the helper. The collapsed strip is a state the shot can still be deleted
  // from, so leaving it on the old string would have left the ambiguity behind
  // one toggle.
  const labelled = src.match(/aria-label=\{deleteCellControlName\(cell\)\}/g) ?? [];
  assert.equal(labelled.length, 2, `expected 2 uid-qualified delete controls, found ${labelled.length}`);
  // No inline template may reintroduce a beat-only name.
  assert.equal(
    /aria-label=\{`Delete cell \$\{/.test(src),
    false,
    'destructive names must come from canvas-model, not an inline template',
  );
  // The dialog takes the dialog-specific name.
  assert.ok(/title=\{deleteConfirmDialogName\(confirmDelete\)\}/.test(src));
  // The two singleton buttons stay unqualified on purpose (documented in the
  // view header), so the runbook's existing EV lines still resolve.
  assert.ok(/aria-label="Confirm delete cell"/.test(src));
  assert.ok(/aria-label="Cancel delete cell"/.test(src));
});

test('G-102: the RAIL`s per-shot delete is named the same way', () => {
  const rail = railSrc();
  // The default view. `aria-label={`Delete cell ${item.beat}`}` rendered five
  // buttons with the identical name on the live fixture — the reported defect,
  // on the only surface a human could use.
  assert.ok(
    /aria-label=\{deleteCellControlName\(item\)\}/.test(rail),
    'the Rail delete control must take its name from canvas-model',
  );
  assert.equal(
    /aria-label=\{`Delete cell \$\{/.test(rail),
    false,
    'the Rail must not name a destructive control with an inline beat-only template',
  );
  assert.ok(/from '\.\.\/lib\/canvas-model'/.test(rail));
});

test('G-102: no per-shot delete keeps a shot-blind `Delete cell` tooltip', () => {
  // The a11y name is not the affordance a mouse user gets. All three ✕ controls
  // (two on the canvas, one on the Rail) must put the same identifying string
  // in `title`, or five `beat-hello` cells still hover-tip identically — the
  // Rail's is the worst case, since its ✕ is revealed by that very hover.
  // Line-anchored so this targets the BUTTON attribute and not the Rail's
  // singleton confirm `<Modal title="Delete cell">`, whose name is unambiguous
  // (one dialog at a time) and whose body prints the beat and the uid.
  for (const [file, src] of [['NodeCanvas.tsx', nodeCanvasSrc()], ['Canvas.tsx', railSrc()]] as const) {
    assert.equal(
      /^\s*title="Delete cell"\s*$/m.test(src),
      false,
      `${file}: a per-shot delete must not carry a shot-blind tooltip`,
    );
  }
  const titled = (nodeCanvasSrc().match(/title=\{deleteCellControlName\(cell\)\}/g) ?? []).length;
  assert.equal(titled, 2, `expected 2 identifying delete tooltips on the canvas, found ${titled}`);
  assert.ok(/title=\{deleteCellControlName\(item\)\}/.test(railSrc()), 'the Rail ✕ needs one too');
});

// ── G-103 · one piece of end-of-lane arithmetic ─────────────────────────

test('G-103: nextLaneIndex is end-of-lane on a gapped board AND on a scaffold', () => {
  // A gapped board is what the sidecar's delete leaves behind (it does not
  // reindex). `length` = 4 would collide with the surviving index-5 cell.
  const gapped = [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 5 }];
  assert.equal(nextLaneIndex(gapped), 6);
  assert.notEqual(nextLaneIndex(gapped), gapped.length);
  // The live board: 5 cells at 0..4 → 5, which is both max+1 and length.
  assert.equal(nextLaneIndex([0, 1, 2, 3, 4].map((index) => ({ index }))), 5);
  // A fresh scaffold has every index at 0, where max+1 alone (1) would collide.
  assert.equal(nextLaneIndex([{ index: 0 }, { index: 0 }, { index: 0 }]), 3);
  // An index-less board (hand-edited json, or a presentation projection) is
  // tolerated rather than throwing — it collapses back to `length`. Nothing in
  // the app passes one any more; see the next test.
  assert.equal(nextLaneIndex([{}, {}, {}, {}]), 4);
  assert.equal(nextLaneIndex([]), 0);
  // Never a duplicate of an existing ordinal, whatever the shape.
  for (const board of [gapped, [{ index: 0 }, { index: 0 }], [{ index: 9 }], [{}, { index: 2 }]]) {
    const next = nextLaneIndex(board);
    assert.equal(
      board.some((c) => (c as { index?: number }).index === next),
      false,
      `nextLaneIndex collided on ${JSON.stringify(board)}`,
    );
  }
});

test('G-103: both create surfaces ask nextLaneIndex, and agree', () => {
  const rail = railSrc();
  const canvas = nodeCanvasSrc();
  // The Rail's inline cell literal now routes through the shared function…
  assert.ok(
    /index: nextLaneIndex\(hydratedCells\)/.test(rail),
    'the Rail create call must take its index from nextLaneIndex',
  );
  // …and the arithmetic it used to carry is gone.
  assert.equal(
    /index: displayCells\.length/.test(rail),
    false,
    'displayCells.length must not be a Cell.index any more',
  );
  assert.ok(/from '\.\.\/lib\/canvas-model'/.test(rail), 'the Rail must import the shared module');
  // The canvas path is unchanged and still the same function.
  assert.ok(/nextLaneIndex\(cellsRef\.current\)/.test(canvas));
  // One function, so the two cannot disagree — asserted on the value, not just
  // on the call site, for the board where they used to diverge.
  const board = [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }, { index: 5 }];
  assert.equal(nextLaneIndex(board), nextLaneIndex([...board].reverse()));
  assert.equal(nextLaneIndex(board), 6);
});

test('G-103: and both ask it about the SAME board', () => {
  const rail = railSrc();
  const canvas = nodeCanvasSrc();
  // One function over two different arrays is still two different answers, and
  // that was the surviving half of G-103. `displayCells` is
  // `hasRealCells ? hydratedCells.map(toDisplayCell) : MOCK_CELLS`, and
  // `selectHasRealCells` is `source === 'real' && cells.length > 0` — so it is
  // the 10-entry presentation fixture on a REAL project with zero cells, and on
  // the demo board (where create_cell appends to the mock MCP's 6-cell array,
  // not to that fixture).
  assert.ok(
    /const displayCells = useMemo<MockCell\[\]>\(\s*\n\s*\(\) => \(hasRealCells \? hydratedCells\.map\(toDisplayCell\) : MOCK_CELLS\)/.test(rail),
    'premise: displayCells still falls back to the presentation fixture',
  );
  // Neither create path may read a presentation list.
  assert.equal(
    /nextLaneIndex\(displayCells/.test(rail),
    false,
    'the index must not come from the presentation list',
  );
  // Both read the storyboard store's schema cells — the array the create RPC
  // appends to, on whichever board is live.
  assert.ok(/const hydratedCells = useStoryboardStore\(selectHydratedCells\)/.test(rail));
  assert.ok(/cellsRef\.current = cells/.test(canvas));
  assert.ok(/const cells = useStoryboardStore\(selectHydratedCells\)/.test(canvas));

  // The divergence, as a value. A real project with zero cells: the store's
  // array is empty, the presentation fallback is 10 entries with no `index`.
  const realEmptyBoard: Array<{ index?: number }> = [];
  const presentationFallback = Array.from({ length: 10 }, () => ({}));
  assert.equal(nextLaneIndex(realEmptyBoard), 0);
  assert.equal(nextLaneIndex(presentationFallback), 10);
  assert.notEqual(nextLaneIndex(realEmptyBoard), nextLaneIndex(presentationFallback));
  // The demo board: the mock MCP ships 6 cells, all at index 0 → 6, not 10.
  assert.equal(nextLaneIndex(Array.from({ length: 6 }, () => ({ index: 0 }))), 6);
});

// ── G-104 · the chrome layer is pinned to the pane, not to the canvas ───

test('G-104: the bars are siblings of <Canvas>, not its children', () => {
  const src = nodeCanvasSrc();
  // `<Canvas>` takes no children at all now — `props.children` render inside
  // `.ikenga-canvas`, which is `position:absolute; inset:0; overflow:hidden`
  // (a scroll container) and whose `.ikenga-canvas-stage` child has visible
  // overflow. Anything that scrolls that container translates every one of its
  // absolutely-positioned children, the bars included, out of the window — with
  // no scrollbar to reveal it or drag it back. That hazard is real and is what
  // this placement removes; it is NOT a claim that it caused G-104, which
  // outlived the G-86 fix (see the header note).
  assert.equal(/<\/Canvas>/.test(src), false, '<Canvas> must take no children');
  assert.ok(/className="h-full w-full"\s*\/>/.test(src), '<Canvas> must be self-closing');

  const canvasAt = src.indexOf('<Canvas<CanvasNodeItem>');
  const layerAt = src.indexOf('pointer-events-none absolute inset-0 z-20 overflow-clip');
  assert.notEqual(canvasAt, -1, '<Canvas> element not found');
  assert.notEqual(layerAt, -1, 'chrome layer not found');
  assert.ok(layerAt > canvasAt, 'the chrome layer must be a LATER sibling of <Canvas>');

  // Nothing pinned to a pane edge may live before the layer — i.e. inside the
  // primitive. Asserted over every occurrence rather than the ones we know
  // about, so a new bar cannot be added back into `<Canvas>`. `-1` is the
  // sentinel for "the whole string": `absolute` inside a node root is fine (a
  // node root IS positioned against the stage, deliberately), so only the
  // pane-edge offsets are policed.
  for (const m of src.matchAll(/\babsolute (?:bottom-3|left-3 top-3)\b/g)) {
    assert.ok(
      (m.index ?? -1) > layerAt,
      `pane-edge chrome outside the chrome layer at index ${m.index}: ${m[0]}`,
    );
  }
  // The two bars the live round could not see, now inside the layer.
  const layer = src.slice(layerAt, src.indexOf('{confirmDelete && ('));
  assert.ok(layer.includes('absolute bottom-3 left-3'), 'status line must be in the chrome layer');
  assert.ok(layer.includes('absolute bottom-3 right-3'), 'toolbar must be in the chrome layer');
  assert.ok(layer.includes('layout → .studio/canvas.json'));
  assert.ok(layer.includes('aria-label="New cell"'));
});

test('G-104: the layer cannot scroll and cannot eat a board gesture', () => {
  const src = nodeCanvasSrc();
  const layerAt = src.indexOf('pointer-events-none absolute inset-0 z-20 overflow-clip');
  assert.notEqual(layerAt, -1);
  const layer = src.slice(layerAt, src.indexOf('{confirmDelete && ('));
  // Click-through by default; each interactive bar opts back in. Without this
  // the layer would cover the whole pane and kill every drag on the board.
  assert.ok(layer.includes('pointer-events-auto absolute bottom-3 right-3'), 'toolbar must be clickable');
  // …and the toolbar still refuses to let a mousedown reach the primitive, the
  // guard that keeps `+ Group` / `Ungroup` mounted long enough to be clicked.
  assert.ok(
    /onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}\s*\n\s*className="pointer-events-auto absolute bottom-3 right-3/.test(src),
    'the toolbar must keep its mousedown guard',
  );
  // `overflow-clip`, NOT `overflow-hidden`, on the wrapper the layer is pinned
  // to AND on the layer. `hidden` clips but still makes the box a scroll
  // container — programmatically scrollable, with no scrollbar to admit it or
  // drag back — which is the whole hazard the bars were moved out of
  // `.ikenga-canvas` to escape. `clip` cannot scroll at all.
  assert.ok(
    /className="relative h-full w-full overflow-clip bg-base"/.test(src),
    'the pane wrapper must clip, not hide',
  );
  // Everything from the wrapper's own tag down to `<Canvas>` — the wrapper and
  // the edge layer, i.e. every box that could become an ancestor scroll
  // container for the bars. (`overflow-hidden` deeper inside a node card is
  // fine: a card is not an ancestor of the chrome.)
  const wrapperAt = src.indexOf('ref={surfaceRef}');
  assert.notEqual(wrapperAt, -1, 'pane wrapper not found');
  assert.equal(
    /overflow-hidden/.test(src.slice(wrapperAt, src.indexOf('<Canvas<CanvasNodeItem>'))),
    false,
    'no scroll container may sit between the bars and the pane',
  );
});

test('G-104: the edge SVG contributes no overflow to the wrapper', () => {
  const src = nodeCanvasSrc();
  // "Its children are all absolutely positioned" does NOT make a box
  // unscrollable — absolute positioning does not prevent overflow. As a CSS
  // transform on the <svg> element, the pan translate moved that element's own
  // full-pane box by `viewport.y` (548 px on the live fixture's persisted
  // viewport), hanging it out of the wrapper's bottom edge and giving the
  // wrapper a real scrollTop range — the exact hazard, one level up. On an
  // inner <g> the transform is clipped to the outermost <svg>'s viewport, so
  // the element's box stays the pane.
  assert.ok(
    /<svg className="pointer-events-none absolute inset-0 z-0 h-full w-full">/.test(src),
    'the edge <svg> must carry no transform of its own',
  );
  assert.ok(
    /<g transform=\{`translate\(\$\{viewport\.x\} \$\{viewport\.y\}\) scale\(\$\{viewport\.scale\}\)`\}>/.test(src),
    'the pan/zoom transform must ride an inner <g>',
  );
  // No CSS transform may come back onto an element inside the wrapper — a
  // `translate(...px)` in a style object is how this regressed.
  assert.equal(
    /transform: `translate\(\$\{viewport/.test(src),
    false,
    'the pan transform must not be a CSS transform on a positioned element',
  );
});

console.log(`\n${passed} passed`);
