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

import { readFileSync } from 'node:fs';

import type { Placement } from '@ikenga/contract/canvas';

import { parseFountain } from './fountain';
import { deriveBeatShotLinks, computeLinking, otioSceneOf } from './tag-linking';
import {
  CANVAS_ITEM_ATTR,
  CANVAS_PAN_ZOOM_KEYS,
  GRID_SNAP,
  KEY_BRIDGE_SKIP_SELECTOR,
  NODE_NODRAG_SELECTOR,
  NODE_POSITION_CLASS,
  isCanvasPanZoomKey,
  layoutsEqual,
  nodeRootProps,
  syncLayoutBox,
  NEW_CELL_LABEL,
  NEW_CELL_RUNG,
  buildNewLaneCell,
  deriveShotStage,
  doneRecordIdByUid,
  doneRecordIdsFor,
  inLaneBand,
  laneOrderFrom,
  laneSlot,
  nextLaneIndex,
  orderChanged,
  rollupStages,
  stripDerived,
  type DoneRenderRecordLike,
} from './canvas-model';
import { emptyCanvasDoc, sweepOrphans, ORPHAN_GRACE_MS } from './canvas-doc';
import { foldRenderStatus } from './composition-model';
import type { RenderStatus } from '../mcp-types';

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


// ── G-61 b2 · done-render derivation from the LIVE render.list records ───
//
// The dead seam this pins: `NodeCanvas` used to derive both its poster batch
// and its stage chip from `Cell.renders`, which no sidecar writer populates —
// live-verified over two full render runs, with the poster PNG sitting on disk
// and the tile still reading "Not rendered"
// (plans/studio/verify/2026-09-12-wp32-live/g61/2-poster-verdict.md). Every
// assertion below feeds cells whose `renders` is `[]` — the shape a real
// project ALWAYS has — so a regression back to that field fails here rather
// than only on a live shell.

console.log('\nG-61 b2 · done render ids come from render.list records, not Cell.renders');

const rec = (
  id: string,
  cellUid: string,
  status: string,
  finishedAt?: string,
): DoneRenderRecordLike => ({
  id,
  cell_uid: cellUid,
  status,
  finished_at: finishedAt,
});

/** A real hydrated cell: `renders` is empty, exactly as storyboard.json keeps
 *  it after a successful render. */
const shotCell = (uid: string, over: Record<string, unknown> = {}) =>
  ({
    ...buildNewLaneCell({ index: 0, label: uid, suffix: () => 'x', now: () => 'T' }),
    uid,
    renders: [],
    approved: false,
    prompt: 'a lit forge, slow push-in',
    ...over,
  }) as unknown as Parameters<typeof deriveShotStage>[0];

test('a done record is keyed by its cell uid and yields its record id', () => {
  const map = doneRecordIdByUid([rec('r1', 'hello-lofi', 'done', '2026-09-12T13:49:30Z')]);
  assert.deepEqual(map, { 'hello-lofi': 'r1' });
});

test('only `done` counts — queued / running / failed / cancelled contribute nothing', () => {
  const map = doneRecordIdByUid([
    rec('r1', 'a', 'queued'),
    rec('r2', 'b', 'running'),
    rec('r3', 'c', 'failed'),
    rec('r4', 'd', 'cancelled'),
    rec('r5', 'e', 'done', '2026-09-12T13:00:00Z'),
  ]);
  assert.deepEqual(map, { e: 'r5' });
});

test('a record missing an id or a cell_uid is skipped, not thrown on', () => {
  const map = doneRecordIdByUid([
    { status: 'done', cell_uid: 'a' },
    { status: 'done', id: 'r2' },
    { status: 'done', id: '', cell_uid: 'b' },
    rec('r4', 'c', 'done'),
  ]);
  assert.deepEqual(map, { c: 'r4' });
});

test('among several done records the most-recently-finished wins', () => {
  // Two successful runs of the same cell — the live fixture's exact shape
  // (hello-lofi.mp4 then hello-lofi.bc9c45c3.mp4). The newer poster must win.
  const map = doneRecordIdByUid([
    rec('run1', 'hello-lofi', 'done', '2026-09-12T13:49:30Z'),
    rec('run2', 'hello-lofi', 'done', '2026-09-12T13:53:35Z'),
  ]);
  assert.equal(map['hello-lofi'], 'run2');
  // ...regardless of list order.
  const reversed = doneRecordIdByUid([
    rec('run2', 'hello-lofi', 'done', '2026-09-12T13:53:35Z'),
    rec('run1', 'hello-lofi', 'done', '2026-09-12T13:49:30Z'),
  ]);
  assert.equal(reversed['hello-lofi'], 'run2');
});

test('untimestamped done records fall back to list position (later wins)', () => {
  const map = doneRecordIdByUid([rec('first', 'a', 'done'), rec('second', 'a', 'done')]);
  assert.equal(map.a, 'second');
});

test('an undefined records list is an empty map, not a throw', () => {
  assert.deepEqual(doneRecordIdByUid(undefined), {});
});

test('doneRecordIdsFor follows the uid order, dedupes, and skips un-rendered shots', () => {
  const map = doneRecordIdByUid([
    rec('r-b', 'b', 'done', '2026-09-12T13:00:00Z'),
    rec('r-a', 'a', 'done', '2026-09-12T13:00:01Z'),
    rec('q-c', 'c', 'queued'),
  ]);
  // `c` is queued and `d` has no record at all — neither has a poster.
  assert.deepEqual(doneRecordIdsFor(['a', 'b', 'c', 'd'], map), ['r-a', 'r-b']);
  assert.deepEqual(doneRecordIdsFor(['b', 'a'], map), ['r-b', 'r-a']);
  // Same uid twice (a shot in the lane and in a group) is ONE poster fetch.
  assert.deepEqual(doneRecordIdsFor(['a', 'a'], map), ['r-a']);
});

test('a board with nothing done yields NO ids — the batch never fires', () => {
  // This is the no-N+1 property at the input end: the caller keys its effect
  // off the joined id string, so an empty list is zero round trips.
  const map = doneRecordIdByUid([rec('r1', 'a', 'failed'), rec('r2', 'b', 'queued')]);
  assert.deepEqual(doneRecordIdsFor(['a', 'b'], map), []);
  assert.equal(doneRecordIdsFor(['a', 'b'], map).join(','), '');
});

test('doneRecordIdsFor caps the batch at `limit`, keeping a stable prefix', () => {
  // The cap is load-bearing, not cosmetic: CellPoster's blob cache is a
  // 50-entry LRU that evicts DURING the resolving batch, and the sidecar
  // silently truncates render.list_posters at 100 ids. A board-wide, uncapped
  // list therefore produces revoked posters + an N+1 re-request burst past 50
  // and permanent misses past 100. NodeCanvas passes POSTER_BATCH_MAX.
  const uids = Array.from({ length: 60 }, (_, i) => `u${i}`);
  const map = doneRecordIdByUid(uids.map((u, i) => rec(`r${i}`, u, 'done')));
  const capped = doneRecordIdsFor(uids, map, 48);
  assert.equal(capped.length, 48, 'never more ids than the poster cache can hold');
  assert.equal(capped[0], 'r0');
  assert.equal(capped[47], 'r47');
  // Same input, same prefix — the joined key stays a stable done-set identity,
  // so the effect still fires exactly once per change rather than per render.
  assert.equal(doneRecordIdsFor(uids, map, 48).join(','), capped.join(','));
  // The cap counts KEPT ids, so un-rendered shots in the middle don't eat it.
  const sparse = doneRecordIdByUid([rec('r-a', 'a', 'done'), rec('r-c', 'c', 'done')]);
  assert.deepEqual(doneRecordIdsFor(['a', 'b', 'c'], sparse, 2), ['r-a', 'r-c']);
  // Degenerate caps don't throw or leak a partial fetch.
  assert.deepEqual(doneRecordIdsFor(uids, map, 0), []);
  assert.deepEqual(doneRecordIdsFor(uids, map, -5), []);
  // Omitted limit keeps the old un-capped behaviour for small fixed sets.
  assert.equal(doneRecordIdsFor(uids, map).length, 60);
});

test('the poster id resolves for a cell whose own `renders` is empty', () => {
  // The regression pin. Cell.renders is `[]` on every real project; the id
  // must come from the records anyway.
  const cell = shotCell('hello-lofi');
  assert.deepEqual((cell as unknown as { renders: unknown[] }).renders, []);
  const map = doneRecordIdByUid([rec('r1', 'hello-lofi', 'done', '2026-09-12T13:49:30Z')]);
  assert.deepEqual(doneRecordIdsFor([cell.uid], map), ['r1']);
});

console.log('\nD-25-1 · stage derivation reads the live done flag');

test('a folded `done` status puts the shot at render, or export once approved', () => {
  assert.equal(deriveShotStage(shotCell('a'), 'done', true), 'render');
  assert.equal(deriveShotStage(shotCell('a', { approved: true }), 'done', true), 'export');
});

test('an earlier done render outranks a re-render in flight', () => {
  // Unreachable before this fix (the flag came from the dead field, so a
  // re-queued shot that HAD rendered reported `generate`). Branch order is
  // deliberate: the chip says what the shot has, the beacon says what it is
  // doing.
  assert.equal(deriveShotStage(shotCell('a'), 'queued', true), 'render');
  assert.equal(deriveShotStage(shotCell('a'), 'running', true), 'render');
  assert.equal(deriveShotStage(shotCell('a', { approved: true }), 'running', true), 'export');
});

test('with no done render, queued/running is generation in flight', () => {
  assert.equal(deriveShotStage(shotCell('a'), 'queued', false), 'generate');
  assert.equal(deriveShotStage(shotCell('a'), 'running', false), 'generate');
});

test('a failed render with no earlier take reports where the work stalled', () => {
  assert.equal(deriveShotStage(shotCell('a'), 'failed', false), 'generate');
  assert.equal(deriveShotStage(shotCell('a'), 'cancelled', false), 'generate');
});

test('a failed render ON TOP of an earlier take reports what the shot HAS', () => {
  // Newly reachable once `hasDoneRender` comes from the live records: a shot
  // whose LATEST attempt failed after an earlier success folds to status
  // `failed` (post-G-109 the fold is recency-based, so this is now the honest
  // done(t1) → failed(t2) history rather than the mis-ordered fold that used
  // to reach it) while `doneRecordIdByUid` still reports its done id.
  // `hasDoneRender` wins, so
  // the chip reads what the shot HAS, not where its last attempt died.
  assert.equal(deriveShotStage(shotCell('a'), 'failed', true), 'render');
  assert.equal(deriveShotStage(shotCell('a'), 'cancelled', true), 'render');
  assert.equal(deriveShotStage(shotCell('a', { approved: true }), 'failed', true), 'export');
});

test('rollupStages puts a failed-over-done warning on the stage the shot is IN', () => {
  // The companion half of the branch above, and the reason the docblock no
  // longer claims failures always land on `generate`: the warning must follow
  // the chip or the stage node and the tile disagree about the same shot.
  const cells = [shotCell('a')] as unknown as Parameters<typeof rollupStages>[0];
  const roll = rollupStages(cells, () => 'failed', () => true);
  assert.equal(roll.counts.render, 1, 'the shot sits at render — it has a take');
  assert.equal(roll.failed.render, 1, 'and the warning is on render, not generate');
  assert.equal(roll.counts.generate, 0);
  assert.equal(roll.failed.generate, 0);
});

test('an unauthored shot is still being broken down', () => {
  const bare = shotCell('a', { prompt: '', action: '', intent: '' });
  assert.equal(deriveShotStage(bare, undefined, false), 'breakdown');
});

test('rollupStages counts through the same live done flag', () => {
  const cells = [shotCell('a'), shotCell('b'), shotCell('c')] as unknown as Parameters<
    typeof rollupStages
  >[0];
  const status: Record<string, 'done' | 'failed' | 'queued'> = {
    a: 'done',
    b: 'queued',
    c: 'failed',
  };
  const done = new Set(['a', 'b']); // `b` rendered once and is re-rendering
  const roll = rollupStages(
    cells,
    (uid) => status[uid],
    (uid) => done.has(uid),
  );
  assert.equal(roll.counts.render, 2, 'a (done) + b (has a take, re-queued)');
  assert.equal(roll.counts.generate, 1, 'c failed with nothing to show');
  assert.equal(roll.failed.generate, 1, 'a failed member warns without moving a count');
  assert.equal(roll.counts.export, 0);
});

// ── WP-32 · the node canvas is physically usable ─────────────────────────
//
// Three defects the live round found on the real surface, each of which a
// DOM-free assertion can hold shut from here:
//
//   (a) every node root must carry the primitive's DOM contract — `absolute`
//       (Canvas injects left/top and nothing else), its own height (height is
//       NOT injected, and `h-full` resolved against the stage, so all nodes
//       stacked one pane-height each), and `data-canvas-item`, without which
//       `ITEM_SELECTOR` never matches and nothing is selectable or draggable;
//   (c) the layout object handed to `<Canvas>` must not be re-identified when
//       its content is unchanged, or `use-pan-zoom`'s auto-fit effect re-fires
//       and snaps the viewport back.
//
// Evidence: plans/studio/verify/2026-09-12-wp32-live/g61/gap-canvas-unpositioned/,
// wp28/verdict.md, wp29/verdict.md (+ zoom-snapback-samples.txt).

const CHIP: Placement = { x: 48, y: 320, w: 200, h: 220 };

test('nodeRootProps carries positioning, the node height, and the hit-test attr', () => {
  const props = nodeRootProps(CHIP, 'rounded border bg-surface p-2');
  assert.ok(props.className.split(/\s+/).includes(NODE_POSITION_CLASS));
  assert.ok(props.className.includes('rounded border bg-surface p-2'));
  // Height comes from the placement: Canvas injects left/top/width only.
  assert.deepEqual(props.style, { height: CHIP.h });
  // The attribute Canvas' ITEM_SELECTOR hit-tests. Present, even if empty.
  assert.ok(CANVAS_ITEM_ATTR in props);
  assert.equal(props[CANVAS_ITEM_ATTR], '');
  // …and never the flow-positioned shape that broke the surface.
  assert.equal(/\bh-full\b/.test(props.className), false);
});

test('nodeRootProps keeps the positioning class when the consumer passes none', () => {
  assert.equal(nodeRootProps(CHIP, '').className, NODE_POSITION_CLASS);
});

test('every renderItem root in NodeCanvas goes through nodeRootProps', () => {
  // Source-level, because the assertion IS "no kind was left behind": the
  // defect was per-root, and a runtime check would need a DOM. Reading the view
  // as text keeps this in the same headless runner as everything else.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  // 9 roots: LOD chip, stage, script, beat, group, anchor, shot-collapsed,
  // shot-expanded, fallback.
  const roots = src.match(/\{\.\.\.nodeRootProps\(/g) ?? [];
  assert.ok(roots.length >= 9, `expected >= 9 node roots via nodeRootProps, found ${roots.length}`);
  // Each root also stops in-card controls from starting a canvas gesture.
  const guards = src.match(/onMouseDown=\{onNodeRootMouseDown\}/g) ?? [];
  assert.equal(guards.length, roots.length);
  // No root may regress to the unpositioned, stage-height shape. Asserted
  // PER ROOT against the class list each one actually passes, not as one
  // substring over the whole file: `/h-full w-full rounded/` (what this used to
  // be) forbade exactly three tokens in exactly that order, so `h-full w-full
  // border`, `w-full h-full rounded` or a double space all passed while
  // reproducing the defect — and a file-wide ban is wrong in the other
  // direction, because inner elements (the draft iframe, the poster img) are
  // legitimately `h-full w-full`.
  for (const args of callArgsOf(src, 'nodeRootProps(')) {
    assert.equal(/\bh-full\b/.test(args), false, `node root takes stage height: ${args.slice(0, 80)}`);
    assert.equal(/\bw-full\b/.test(args), false, `node root takes stage width: ${args.slice(0, 80)}`);
  }
  // The pinned-identity layout box is what the primitive gets.
  assert.ok(/layout=\{effectiveLayout\}/.test(src));
  assert.ok(/syncLayoutBox\(layoutBoxRef\.current, computedLayout\)/.test(src));
  // WCAG 2.5.7 — the surface takes focus on a real click, and the keyboard
  // bridge is wired for the clicks that leave focus on a node.
  assert.ok(/onMouseDownCapture=\{focusCanvasSurface\}/.test(src));
  assert.ok(/onKeyDown=\{bridgeCanvasKey\}/.test(src));
});

// ── the four in-component mechanisms, source-level ──────────────────────────
//
// These all live inside `NodeCanvas()` — a dep list, an effect gate, a
// capture-phase guard, a focus round-trip and a keydown bridge — so a headless
// runner can only read them as text. That is a weaker assertion than a
// behavioural one and is recorded as such: it holds the SHAPE (the mechanism is
// present and keyed on the right thing) and would catch the regressions the
// live round's review found, not every way each one could be broken.

/** Paren-balanced argument text of every `needle` call in `src`. */
function callArgsOf(src: string, needle: string): string[] {
  const out: string[] = [];
  let i = src.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + needle.length - 1; // sits on the '('
    for (; j < src.length; j += 1) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i + needle.length, j));
    i = src.indexOf(needle, j);
  }
  return out;
}

/** The text from `start` through the first `end` after it, both included. */
function regionOf(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `region start not found: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `region end not found: ${end}`);
  return src.slice(a, b + end.length);
}

test('the edges memo watches layoutRev, not the pinned layout identity', () => {
  // The D-25-5 tether branch reads `effectiveLayout[uid]`, whose identity is
  // pinned for the life of the mount — so listing it was listing a constant and
  // the tether never re-derived on a free-place drop (nor stopped drawing on a
  // drop back into the band). `layoutRev` is the change signal `syncLayoutBox`
  // actually bumps.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  const deps = /\}, \[showEdges,([^\]]*)\]\);/.exec(src);
  assert.ok(deps, 'edges memo dep list not found');
  assert.ok(deps[1].includes('layoutRev'), `edges deps must carry layoutRev: ${deps[1]}`);
  assert.equal(
    deps[1].includes('effectiveLayout'),
    false,
    'the pinned box must not stand in for a change signal',
  );
});

test('the once-per-project fit is gated on the layout, not on persistence', () => {
  // `hydratedFor` stays null when `canvas.read` throws, and the primitive's own
  // mount fit already returned early against an empty layout — so gating the
  // fit on hydration left a degraded board permanently unfitted at model
  // coordinates, recoverable only by the Reset button.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  const fit = regionOf(src, 'const fittedForRef', '}, [project?.project_id, storyboardLoading, layoutRev]);');
  assert.equal(fit.includes('hydratedFor'), false, 'the fit must not be gated on hydration');
  assert.ok(fit.includes('Object.keys(layoutBoxRef.current).length === 0'), 'fit needs content');
  // …and content means CELLS, not the pipeline-stage scaffold the derived
  // layout always carries: a fit taken mid-fetch would pin the viewport to a
  // 64-unit-tall stage row.
  assert.ok(fit.includes('if (storyboardLoading) return;'), 'fit must wait for the fetch');
  assert.ok(fit.includes('fittedForRef.current === pid'), 'fit stays once per project');
  assert.ok(fit.includes('autoFit(false)'));
});

test('focusCanvasSurface cannot reach the portalled confirm dialog', () => {
  // React dispatches capture handlers along the FIBER path, so this ran for a
  // mousedown inside the <body>-portalled ConfirmDialog and stole focus out of
  // its trap — leaving Escape to `use-pan-zoom`'s window handler (which clears
  // the canvas selection) under an ARMED delete confirm. The DOM containment
  // check is the portal test; the dialog's own bubble-phase stopPropagation
  // cannot undo an already-executed capture handler.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  const fn = regionOf(src, 'function focusCanvasSurface', '\n}');
  assert.ok(fn.includes('e.currentTarget.contains(t)'), 'missing the portal guard');
  assert.ok(
    fn.indexOf('contains(t)') < fn.indexOf('.focus('),
    'the guard must precede the focus call',
  );
});

test('nudgeZoom borrows focus and gives it back', () => {
  // The primitive gates Equal/Minus on the canvas root holding focus, so the
  // toolbar button has to move focus to dispatch — and has to move it back, or
  // a second Enter on the same button does nothing and the keyboard user loses
  // their place in the tab order.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  const fn = regionOf(src, 'const nudgeZoom = useCallback', '}, []);');
  const captured = fn.indexOf('const prevFocus = document.activeElement');
  const dispatched = fn.indexOf('window.dispatchEvent');
  const restored = fn.lastIndexOf('prevFocus.focus?.(');
  assert.ok(captured !== -1, 'nothing captured before the dispatch');
  assert.ok(dispatched !== -1 && restored !== -1, 'missing a step');
  assert.ok(captured < dispatched, 'focus must be captured before the dispatch');
  assert.ok(dispatched < restored, 'focus must be restored after the dispatch');
});

test('bridgeCanvasKey covers both halves of the keyboard gate', () => {
  // Arrow/zoom keys arriving at a NODE (where Canvas's roving selection leaves
  // focus after every item click) get the surface focused so the same native
  // event satisfies the primitive's window-handler gate; Space is bridged the
  // other way, to <body>, because that is where the primitive arms its pan-grab.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  const fn = regionOf(src, 'const bridgeCanvasKey = useCallback', '}, []);');
  assert.ok(fn.includes('e.currentTarget.contains(t)'), 'portalled dialog keys are not ours');
  assert.ok(fn.includes('KEY_BRIDGE_SKIP_SELECTOR'), 'real controls keep their own keys');
  assert.ok(fn.includes('isCanvasPanZoomKey(e.code, e.key)'));
  assert.ok(fn.includes('document.activeElement === root'), 'no work when the gate is already met');
  assert.ok(fn.includes("e.code === 'Space'"), 'space+drag pan stays reachable');
  assert.ok(fn.includes('blur?.()'), 'the primitive arms space only while <body> is focused');
  assert.ok(fn.includes("window.addEventListener('keyup', restore)"), 'focus must come back');
  // No re-dispatch: the ORIGINAL event still has to reach the window listener,
  // and dispatching a copy would double every pan/zoom step.
  assert.equal(fn.includes('window.dispatchEvent'), false);
});

test('CANVAS_PAN_ZOOM_KEYS is exactly what the focused surface acts on', () => {
  // The set the primitive implements in its focused-root branch: four arrows on
  // `event.key`, four zoom codes on `event.code`.
  assert.deepEqual([...CANVAS_PAN_ZOOM_KEYS].sort(), [
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'Equal',
    'Minus',
    'NumpadAdd',
    'NumpadSubtract',
  ]);
  // Arrows arrive as key === code; zoom only ever matches on code ('=' / '-').
  assert.equal(isCanvasPanZoomKey('ArrowLeft', 'ArrowLeft'), true);
  assert.equal(isCanvasPanZoomKey('Equal', '='), true);
  assert.equal(isCanvasPanZoomKey('Minus', '-'), true);
  assert.equal(isCanvasPanZoomKey('NumpadSubtract', '-'), true);
  // Everything else belongs to whatever has focus.
  assert.equal(isCanvasPanZoomKey('Space', ' '), false);
  assert.equal(isCanvasPanZoomKey('Escape', 'Escape'), false);
  assert.equal(isCanvasPanZoomKey('KeyE', 'e'), false);
  assert.equal(isCanvasPanZoomKey('Tab', 'Tab'), false);
});

test('KEY_BRIDGE_SKIP_SELECTOR leaves every keyed control alone', () => {
  const parts = KEY_BRIDGE_SKIP_SELECTOR.split(',');
  // An input owns its arrows, a button owns Space — both must be excluded, so
  // the bridge covers the nodrag set plus contenteditable.
  for (const sel of NODE_NODRAG_SELECTOR.split(',')) {
    assert.ok(parts.includes(sel), `${sel} missing from the key bridge skip set`);
  }
  assert.ok(parts.includes('[contenteditable="true"]'));
});

test('NodeCanvas opts out of the resize auto-fit the primitive defaults on', () => {
  // The third snap-back trigger. `use-pan-zoom` defaults `autoFitOnResize` to
  // true and registers `window.resize → autoFit(true)`, so pinning the layout
  // identity was not enough on its own: maximising the shell window still
  // discarded the user's pan/zoom. Source-level for the same reason as the
  // test above — the assertion is about what the consumer passes.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  assert.ok(
    /autoFitOnResize=\{false\}/.test(src),
    'NodeCanvas must opt out of the primitive resize auto-fit',
  );
});

test('the shot media slot keeps its status text UNDER the poster', () => {
  // Regression pin for the blank-tile defect: `<CellPoster>` returns null both
  // while its batch is in flight and on a CONFIRMED miss, and a confirmed miss
  // is a normal path (`render.ingest_external` writes a done row and never
  // extracts a poster). Rendering the poster INSTEAD of the status text left
  // those tiles as an empty box with no label at all.
  const src = readFileSync(new URL('../views/NodeCanvas.tsx', import.meta.url), 'utf8');
  // The poster must not be the ternary ALTERNATIVE to the status span.
  assert.equal(
    /\) : doneRecordId \? \(\s*<CellPoster/.test(src),
    false,
    'CellPoster must not replace the status-text fallback',
  );
  // It layers over it, and only for an id the board-wide batch covered.
  assert.ok(/\{posterRecordId && \(\s*<CellPoster/.test(src));
  assert.ok(/batchedPosterIds\.has\(doneRecordId\)/.test(src));
  // A done record with no PNG still says something.
  assert.ok(/'No poster'/.test(src));
  assert.ok(/'Not rendered'/.test(src));
  // And the batch itself is capped under CellPoster's 50-entry LRU.
  assert.ok(/doneRecordIdsFor\(shotUids, doneIdByUid, POSTER_BATCH_MAX\)/.test(src));
  const cap = src.match(/const POSTER_BATCH_MAX = (\d+);/);
  assert.ok(cap, 'POSTER_BATCH_MAX must be declared');
  assert.ok(Number(cap![1]) < 50, 'the cap must sit under CellPoster MAX_ENTRIES (50)');
});

test('NODE_NODRAG_SELECTOR covers the controls that live inside a node', () => {
  for (const tag of ['button', 'a', 'input', 'select', 'textarea', 'iframe']) {
    assert.ok(NODE_NODRAG_SELECTOR.split(',').includes(tag), `${tag} missing`);
  }
  assert.ok(NODE_NODRAG_SELECTOR.includes('[data-canvas-nodrag]'));
});

test('layoutsEqual is identity-blind and length-aware', () => {
  const a = { one: laneSlot(0, false), two: laneSlot(1, false) };
  const b = { one: laneSlot(0, false), two: laneSlot(1, false) };
  assert.notEqual(a, b);
  assert.equal(layoutsEqual(a, b), true);
  assert.equal(layoutsEqual(a, { ...b, three: laneSlot(2, false) }), false);
  assert.equal(layoutsEqual(a, { one: a.one, two: { ...a.two, x: a.two.x + 24 } }), false);
  // Same key COUNT, different keys.
  assert.equal(layoutsEqual(a, { one: a.one, three: a.two }), false);
});

test('syncLayoutBox: an echo with equal content changes nothing (no new identity)', () => {
  // The snap-back loop in one test. A `canvas.write` came back through the fs
  // watcher, the storyboard refetched, `cells` was a NEW array with the SAME
  // content, so the derived layout was re-derived — and the primitive's
  // auto-fit re-fired. The box must not notice.
  const derive = () => ({
    'node-script': { x: 40, y: 160, w: 220, h: 96 },
    shotA: laneSlot(0, false),
    shotB: laneSlot(1, false),
  });
  const box: Record<string, Placement> = {};
  assert.equal(syncLayoutBox(box, derive()), true); // first fill
  const pinned = box;
  for (let echo = 0; echo < 8; echo++) {
    assert.equal(syncLayoutBox(box, derive()), false, `echo ${echo} re-identified the layout`);
  }
  assert.equal(box, pinned);
  assert.equal(layoutsEqual(box, derive()), true);
});

test('syncLayoutBox: a real move updates the box in place, keeping its identity', () => {
  const box: Record<string, Placement> = {};
  syncLayoutBox(box, { shotA: laneSlot(0, false), shotB: laneSlot(1, false) });
  const pinned = box;
  const dragged = { shotA: { ...laneSlot(0, false), x: 600, y: 720 }, shotB: laneSlot(1, false) };
  assert.equal(syncLayoutBox(box, dragged), true);
  assert.deepEqual(box.shotA, { x: 600, y: 720, w: 200, h: 220 });
  assert.equal(box, pinned); // same object the primitive is still holding
  // A deleted cell's placement leaves the box rather than lingering.
  assert.equal(syncLayoutBox(box, { shotB: laneSlot(1, false) }), true);
  assert.equal('shotA' in box, false);
  assert.equal(box, pinned);
});

test('syncLayoutBox is idempotent (a StrictMode double render is harmless)', () => {
  const next = { shotA: laneSlot(0, false) };
  const box: Record<string, Placement> = {};
  assert.equal(syncLayoutBox(box, next), true);
  assert.equal(syncLayoutBox(box, next), false);
  assert.equal(syncLayoutBox(box, next), false);
});

// ─── G-109: the tile's render status must follow the LATEST attempt ──────
//
// Live 2026-09-13 (`plans/studio/verify/2026-09-12-wp32-live/hf-win-b5/`): four
// HyperFrames cells reached `done` with mp4 + poster on disk and the
// Composition banner moved to `5/7 rendered`, but every canvas tile kept
// reading `○ Standby`. `render.list` is `ORDER BY created_at DESC`, and
// `foldRenderStatus` used to let the later-ITERATED (= older) row win, so a
// cell whose history was failed(t1) -> done(t2) folded to `failed`.

type FoldRow = [string, RenderStatus, string?];

function fold(rows: FoldRow[]): Record<string, RenderStatus> {
  const records = rows.map(([cell_uid, status, finished_at]) => ({
    id: `${cell_uid}-${status}-${finished_at ?? 'none'}`,
    cell_uid,
    engine: 'hyperframes',
    variant: 'default',
    status,
    finished_at,
    metadata: {},
  }));
  return foldRenderStatus(records as unknown as Parameters<typeof foldRenderStatus>[0]);
}

test('foldRenderStatus: a newest-first list folds to the MOST RECENT attempt', () => {
  // The live shape, verbatim: created_at DESC, so done(t2) comes FIRST.
  const out = fold([
    ['hello-hifi', 'done', '2026-09-13T03:29:12.306Z'],
    ['hello-hifi', 'failed', '2026-09-12T21:04:00.000Z'],
  ]);
  assert.equal(out['hello-hifi'], 'done');
});

test('foldRenderStatus: order-independent - an oldest-first list folds the same', () => {
  const out = fold([
    ['hello-hifi', 'failed', '2026-09-12T21:04:00.000Z'],
    ['hello-hifi', 'done', '2026-09-13T03:29:12.306Z'],
  ]);
  assert.equal(out['hello-hifi'], 'done');
});

test('foldRenderStatus: a regression is reported too (done then failed)', () => {
  const out = fold([
    ['a', 'failed', '2026-09-13T04:00:00.000Z'],
    ['a', 'done', '2026-09-13T03:00:00.000Z'],
  ]);
  assert.equal(out['a'], 'failed');
});

test('foldRenderStatus: an in-flight row still outranks any terminal one', () => {
  // A queued row carries neither started_at nor finished_at, so recency alone
  // would let an old `done` mask a re-render that is running right now.
  assert.equal(fold([['a', 'done', '2026-09-13T03:00:00.000Z'], ['a', 'queued']])['a'], 'queued');
  assert.equal(fold([['a', 'queued'], ['a', 'done', '2026-09-13T03:00:00.000Z']])['a'], 'queued');
  assert.equal(fold([['a', 'running'], ['a', 'failed', '2026-09-13T03:00:00.000Z']])['a'], 'running');
});

test('foldRenderStatus: untimestamped terminal rows keep the old later-wins rule', () => {
  assert.equal(fold([['a', 'done'], ['a', 'failed']])['a'], 'failed');
});

test('G-109 end to end: the fold + done-map pair a tile reads for a re-rendered cell', () => {
  // What the tile derives after the live re-render: done status (the beacon
  // reads ✓ Ready), a poster id for the board batch, and the `render` chip.
  const records = [
    { id: 'r2', cell_uid: 'a', status: 'done', finished_at: '2026-09-13T03:29:12.306Z' },
    { id: 'r1', cell_uid: 'a', status: 'failed', finished_at: '2026-09-12T21:04:00.000Z' },
  ];
  const status = foldRenderStatus(records as unknown as Parameters<typeof foldRenderStatus>[0])['a'];
  const doneId = doneRecordIdByUid(records)['a'];
  assert.equal(status, 'done', 'beacon reads Ready, not Standby');
  assert.equal(doneId, 'r2', 'the newest done record is the one the poster batch asks for');
  assert.deepEqual(doneRecordIdsFor(['a'], doneRecordIdByUid(records), 50), ['r2']);
  assert.equal(deriveShotStage(shotCell('a'), status, Boolean(doneId)), 'render');
});

console.log(`\n${passed} passed`);
