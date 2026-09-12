// com.ikenga.studio · node-canvas derivation tests (G-76)
//
//   bun run src/studio/lib/canvas-links.test.ts   (from packages/apps/studio/)
//
// Plain assert-based script (no bun:test / node:test import) so it typechecks
// under `tsc -p tsconfig.web.json` alongside the rest of `src/`, same rationale
// as the sidecar's test files. Everything under test is a pure function — no
// React, no pan/zoom primitive, no MCP client.
//
// Three of Plan 25's load-bearing decisions, headless:
//
//   • G-57 — beat → shot edges come from the `[[tags]]` in script.fountain,
//     keyed by uid, through the SAME module the Breakdown rail links on. NOT
//     from `Cell.beat_id`, which is null on every real project (so the old
//     FK-derived edge rendered in mocks and nowhere else).
//   • D-25-5 — an in-lane drop yields a new `Cell.index` order; a shot parked
//     outside the lane keeps its ordinal and never rewrites sequence; a shot
//     resting at its derived slot is never persisted as an authored placement.
//   • D-25-2 — orphan GC is LAZY: a vanished cell's placement is tombstoned and
//     survives the grace window, so an agent mid-rewrite cannot scatter the
//     arrangement.

import assert from 'node:assert/strict';

import { parseFountain } from './fountain';
import { deriveBeatShotLinks, computeLinking, otioSceneOf } from './tag-linking';
import {
  GRID_SNAP,
  NEW_CELL_LABEL,
  NEW_CELL_RUNG,
  buildNewLaneCell,
  inLaneBand,
  laneOrderFrom,
  laneSlot,
  nextLaneIndex,
  orderChanged,
  stripDerived,
} from './canvas-model';
import { emptyCanvasDoc, sweepOrphans, ORPHAN_GRACE_MS } from './canvas-doc';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── G-57 ────────────────────────────────────────────────────────────────

const SCRIPT = `INT. WORKSHOP - NIGHT

Forge glowing, slow push-in, embers. [[sc1_sh1]]

Adaora at the anvil, hammer raised. [[sc1_sh2]]

EXT. COURTYARD - DAWN

She steps into the light. [[sc2_sh1]]

An untagged paragraph nobody claimed.
`;

const BEATS = [
  { id: 'b-open', scene_id: 'sc1' },
  { id: 'b-dawn', scene_id: 'sc2' },
];

const SHOTS = [
  { uid: 'sc1_sh1', shotId: 'Open on the forge' },
  { uid: 'sc1_sh2', shotId: 'Anvil' },
  { uid: 'sc2_sh1', shotId: 'Courtyard' },
  { uid: 'sc9_sh9', shotId: 'Unreferenced' },
];

console.log('\nG-57 · beat→shot edges from [[tags]] keyed by uid');

test('otioSceneOf lifts the scene out of a shot tag, and refuses to guess otherwise', () => {
  assert.equal(otioSceneOf('sc1_sh3'), 'sc1');
  assert.equal(otioSceneOf('sc12_sh2A'), 'sc12');
  assert.equal(otioSceneOf('freeform-label'), null);
});

test('each tagged paragraph yields exactly one beat→shot pair', () => {
  const links = deriveBeatShotLinks(parseFountain(SCRIPT), SHOTS, BEATS);
  assert.deepEqual(links, [
    { beatId: 'b-open', cellUid: 'sc1_sh1' },
    { beatId: 'b-open', cellUid: 'sc1_sh2' },
    { beatId: 'b-dawn', cellUid: 'sc2_sh1' },
  ]);
});

test('a shot no paragraph tags gets NO edge — unlinked is a real answer', () => {
  const links = deriveBeatShotLinks(parseFountain(SCRIPT), SHOTS, BEATS);
  assert.equal(links.some((l) => l.cellUid === 'sc9_sh9'), false);
});

test('a tag naming a shot that is not on the board is dropped, not guessed at', () => {
  const links = deriveBeatShotLinks(parseFountain(SCRIPT), [SHOTS[0]!], BEATS);
  assert.deepEqual(links, [{ beatId: 'b-open', cellUid: 'sc1_sh1' }]);
});

test('an UNTAGGED script draws no edges at all (the real-project baseline)', () => {
  const untagged = 'INT. WORKSHOP - NIGHT\n\nForge glowing, slow push-in.\n';
  assert.deepEqual(deriveBeatShotLinks(parseFountain(untagged), SHOTS, BEATS), []);
});

test('the FK is irrelevant: beats with no scene_id still link via the tag prefix', () => {
  // `Cell.beat_id` is never consulted; here the beat is named by its own id,
  // which the tag's OTIO scene prefix resolves to.
  const links = deriveBeatShotLinks(parseFountain(SCRIPT), SHOTS, [{ id: 'sc1' }, { id: 'sc2' }]);
  assert.deepEqual(links, [
    { beatId: 'sc1', cellUid: 'sc1_sh1' },
    { beatId: 'sc1', cellUid: 'sc1_sh2' },
    { beatId: 'sc2', cellUid: 'sc2_sh1' },
  ]);
});

test('a tagged paragraph whose beat cannot be named honestly yields no edge', () => {
  const links = deriveBeatShotLinks(parseFountain(SCRIPT), SHOTS, [{ id: 'unrelated-beat' }]);
  assert.deepEqual(links, []);
});

test('the Breakdown rail and the canvas agree — one mechanism, not two', () => {
  const doc = parseFountain(SCRIPT);
  const actionBlocks = doc.scenes.flatMap((s) => s.blocks.filter((b) => b.kind === 'action'));
  const linking = computeLinking(actionBlocks, SHOTS);
  const canvasUids = deriveBeatShotLinks(doc, SHOTS, BEATS).map((l) => l.cellUid);
  assert.deepEqual(linking.railIds, canvasUids);
});

// ── D-25-5 ──────────────────────────────────────────────────────────────

console.log('\nD-25-5 · the sequence lane');

const LANE = [
  { uid: 'a', index: 0 },
  { uid: 'b', index: 1 },
  { uid: 'c', index: 2 },
];

function slots(laneCollapsed = false): Record<string, ReturnType<typeof laneSlot>> {
  const m: Record<string, ReturnType<typeof laneSlot>> = {};
  LANE.forEach((s, i) => { m[s.uid] = laneSlot(i, laneCollapsed); });
  return m;
}

test('untouched, the lane order is exactly Cell.index order', () => {
  const at = slots();
  assert.deepEqual(laneOrderFrom(LANE, (uid) => at[uid]), ['a', 'b', 'c']);
});

test('dropping the last shot before the first rewrites the order', () => {
  const at = slots();
  at.c = { ...at.c!, x: at.a!.x - 40 }; // dragged to the head of the lane
  assert.deepEqual(laneOrderFrom(LANE, (uid) => at[uid]), ['c', 'a', 'b']);
});

test('a drop that lands back in its own slot changes nothing', () => {
  const at = slots();
  assert.equal(orderChanged(['a', 'b', 'c'], laneOrderFrom(LANE, (uid) => at[uid])), false);
});

test('a shot parked OUTSIDE the lane keeps its ordinal — free placement is non-semantic', () => {
  const at = slots();
  at.b = { ...at.b!, x: 1200, y: 1200 };
  assert.equal(inLaneBand(at.b), false);
  assert.deepEqual(laneOrderFrom(LANE, (uid) => at[uid]), ['a', 'b', 'c']);
});

test('the lane band tolerates a sloppy drop but not a park', () => {
  assert.equal(inLaneBand({ x: 0, y: 320, w: 1, h: 1 }), true);
  assert.equal(inLaneBand({ x: 0, y: 380, w: 1, h: 1 }), true);
  assert.equal(inLaneBand({ x: 0, y: 700, w: 1, h: 1 }), false);
  assert.equal(inLaneBand(undefined), false);
});

test('a placement equal to its derived default is NEVER persisted as authored', () => {
  const derived = slots();
  const authored = stripDerived({ ...derived }, derived);
  assert.deepEqual(authored, {});
});

test('only the node the user actually moved is persisted', () => {
  const derived = slots();
  const next = { ...derived, b: { ...derived.b!, x: 900, y: 900 } };
  assert.deepEqual(Object.keys(stripDerived(next, derived)), ['b']);
});

test('collapsing the lane to a strip changes the derived height, not the order', () => {
  assert.equal(laneSlot(0, true).h < laneSlot(0, false).h, true);
  assert.equal(laneSlot(2, true).x, laneSlot(2, false).x);
});

// ── D-25-2 ──────────────────────────────────────────────────────────────

console.log('\nD-25-2 · lazy orphan GC');

const isCellKey = (k: string) => !k.startsWith('stage-') && !k.startsWith('group-') && k !== 'node-script';
const P = { x: 0, y: 0, w: 10, h: 10 };
const NOW = 1_800_000_000_000;

test('a cell that vanished is TOMBSTONED, not pruned', () => {
  const doc = { ...emptyCanvasDoc(), layout: { a: P, gone: P } };
  const swept = sweepOrphans(doc, new Set(['a']), isCellKey, NOW);
  assert.deepEqual(Object.keys(swept.layout).sort(), ['a', 'gone']);
  assert.equal(swept.orphans.gone, NOW);
});

test('a cell that comes back clears its tombstone and keeps its placement', () => {
  const doc = { ...emptyCanvasDoc(), layout: { a: P }, orphans: { a: NOW - 1000 } };
  const swept = sweepOrphans(doc, new Set(['a']), isCellKey, NOW);
  assert.deepEqual(swept.layout, { a: P });
  assert.deepEqual(swept.orphans, {});
});

test('a tombstone is only swept once it is past the grace window', () => {
  const doc = { ...emptyCanvasDoc(), layout: { gone: P }, orphans: { gone: NOW - ORPHAN_GRACE_MS + 1 } };
  assert.deepEqual(Object.keys(sweepOrphans(doc, new Set(), isCellKey, NOW).layout), ['gone']);

  const stale = { ...emptyCanvasDoc(), layout: { gone: P }, orphans: { gone: NOW - ORPHAN_GRACE_MS - 1 } };
  assert.deepEqual(Object.keys(sweepOrphans(stale, new Set(), isCellKey, NOW).layout), []);
});

test('non-cell keys are never mistaken for orphans (groups included)', () => {
  const doc = {
    ...emptyCanvasDoc(),
    layout: { 'stage-render': P, 'group-g1': P, 'node-script': P },
  };
  const swept = sweepOrphans(doc, new Set(), isCellKey, NOW);
  assert.deepEqual(Object.keys(swept.layout).sort(), ['group-g1', 'node-script', 'stage-render']);
  assert.deepEqual(swept.orphans, {});
});

// ── G-61 behaviour 5 ────────────────────────────────────────────────────
//
// The node canvas gained the Rail's two write seams (create at the end of the
// lane / delete a shot). Only the parts that carry a decision are headlessly
// testable: WHERE a new shot lands and WHAT a default cell is. The RPC pair
// itself (`storyboard.create_cell` / `storyboard.delete_cell`) is the Rail's,
// called unchanged.

console.log('\nG-61 b5 · create at the end of the lane');

test('an empty board starts at index 0', () => {
  assert.equal(nextLaneIndex([]), 0);
});

test('a fresh scaffold (every index 0) appends at the cell count — same as the Rail', () => {
  assert.equal(nextLaneIndex([{ index: 0 }, { index: 0 }, { index: 0 }]), 3);
});

test('an ordered board appends after the highest index', () => {
  assert.equal(nextLaneIndex([{ index: 0 }, { index: 1 }, { index: 2 }]), 3);
});

test('a board whose indexes run past the cell count still lands at the END', () => {
  // e.g. cells 0 and 7 after a delete — the Rail's `length` would be 2, which
  // sorts BEFORE 7 and so is not the end of the lane.
  assert.equal(nextLaneIndex([{ index: 0 }, { index: 7 }]), 8);
});

test('a missing or non-finite index counts as 0 rather than poisoning the max', () => {
  assert.equal(nextLaneIndex([{ index: 0 }, {}, { index: Number.NaN }]), 3);
});

test('a new cell carries the Rail defaults and a content_path derived from its uid', () => {
  let n = 0;
  const cell = buildNewLaneCell({
    index: 4,
    suffix: () => (n++ === 0 ? 'aaa111' : 'bbb222'),
    now: () => '2026-09-12T00:00:00.000Z',
  });
  assert.equal(cell.label, NEW_CELL_LABEL);
  assert.equal(cell.rung, NEW_CELL_RUNG);
  assert.equal(cell.index, 4);
  assert.equal(cell.beat_id, 'new-beat-aaa111');
  assert.equal(cell.uid, 'new-beat-aaa111-bbb222');
  // `rungDir` maps the rung id to its on-disk dir ('2_hifi' → 'hifi'), exactly
  // as the Rail's createCell does.
  assert.equal(cell.content_path, `cells/hifi/${cell.uid}/content.html`);
  assert.equal(cell.last_edited, '2026-09-12T00:00:00.000Z');
});

test('a typed label is slugified into beat_id and kept verbatim as the label', () => {
  const cell = buildNewLaneCell({ index: 0, label: '  Cold Open / Hook!  ', suffix: () => 'zz9999' });
  assert.equal(cell.label, 'Cold Open / Hook!');
  assert.equal(cell.beat_id, 'cold-open-hook-zz9999');
});

test('a new cell is not PLACED — it takes its lane slot from the index alone', () => {
  // Create writes NO authored placement. Asserted against an independently
  // built derived map (the shape the view recomputes every render), not against
  // itself — `stripDerived(m, m)` is `{}` for any m, so a self-comparison would
  // pass even if `laneSlot` returned garbage.
  const board = [{ index: 0 }, { index: 1 }];
  const fresh = buildNewLaneCell({ index: nextLaneIndex(board), suffix: () => 'fr3sh1' });
  assert.equal(fresh.index, 2);

  const derived = {
    a: laneSlot(0, false),
    b: laneSlot(1, false),
    [fresh.uid]: laneSlot(2, false),
  };
  assert.equal(inLaneBand(derived[fresh.uid]), true);

  // What `createCellAtLaneEnd` actually leaves in `doc.layout`: nothing for the
  // new uid. A regression that seeded a placement so the node renders before
  // the refetch lands would put the uid in here and fail this.
  const layoutAfterCreate = { a: laneSlot(0, false) };
  assert.equal(fresh.uid in stripDerived(layoutAfterCreate, derived), false);

  // And if something DID write the derived slot, it is still not authored…
  assert.deepEqual(stripDerived({ [fresh.uid]: laneSlot(2, false) }, derived), {});

  // …while a slot the user dragged off survives — the control that proves the
  // two assertions above are load-bearing rather than vacuous.
  const nudged = { ...laneSlot(2, false), x: laneSlot(2, false).x + GRID_SNAP };
  assert.deepEqual(stripDerived({ [fresh.uid]: nudged }, derived), { [fresh.uid]: nudged });
});

test('the built cell key set is LOCKED to the Rail\'s inline literal', () => {
  // The Rail (views/Canvas.tsx `createCell`) builds its own copy of this
  // literal and was not refactored to call `buildNewLaneCell`, so nothing in
  // the type system keeps the two aligned — `Cell` is reached through a cast on
  // both sides precisely because the schema's defaulted fields are absent here.
  // This pins the contract: add a field to one surface and this fails, instead
  // of the sidecar's CellSchema rejecting one surface's cells at runtime.
  const cell = buildNewLaneCell({ index: 0, suffix: () => 'aaa111', now: () => 'T' });
  assert.deepEqual(
    Object.keys(cell as unknown as Record<string, unknown>).sort(),
    [
      'beat_id',
      'content_path',
      'frames',
      'index',
      'label',
      'last_edited',
      'rung',
      'rungs',
      'time',
      'uid',
    ],
  );
  assert.deepEqual(cell.time, { start: 0, end: 0 });
  assert.deepEqual(cell.frames, { start: 0, end: 0 });
  assert.deepEqual(cell.rungs, {
    '0_beat_sheet': { status: 'pending' },
    '1_lofi': { status: 'pending' },
    '2_hifi': { status: 'pending' },
  });
  // Not asserted as equal to the Rail's: `index`. See the section note in
  // canvas-model.ts — the Rail sends `displayCells.length`, this sends
  // max(maxIndex+1, length), and the divergence on a gapped board is deliberate.
});

console.log(`\n${passed} passed`);
