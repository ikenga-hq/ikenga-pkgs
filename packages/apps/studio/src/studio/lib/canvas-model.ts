// com.ikenga.studio · node-canvas geometry + stage derivation (Plan 25)
//
// Pure functions only, so the load-bearing decisions (D-25-1 stage membership,
// D-25-5 lane semantics) are headless-testable without mounting React or the
// pan/zoom primitive.

import type { Placement } from '@ikenga/contract/canvas';
import { rungDir } from '../mcp-types';
import type { Cell, RenderStatus, Rung } from '../mcp-types';

// ─── done renders: the live record source (G-61 b2, live-fixed 2026-09-12) ─
//
// `Cell.renders` is DECLARED by the persisted document schema
// (`shared/schema.ts` — `renders: z.array(RenderRecordSchema).default([])`)
// but NOTHING WRITES IT. The render runner in `sidecars/project/src` writes
// `render_queue` rows plus files on disk and never folds a finished record
// back onto the cell, so a real project's `storyboard.json` still reads
// `renders: []` on every cell after a successful render — live-verified over
// two full render runs in
// `plans/studio/verify/2026-09-12-wp32-live/g61/2-poster-verdict.md`.
//
// That dead field is why the node canvas never showed a poster while the Rail
// always did: the Rail sources done records from the polled `render.list`
// records in the storyboard store (`views/Canvas.tsx`), the canvas read
// `Cell.renders`. Both surfaces now read the SAME store, through the two
// functions below.
//
// DECISION (WP-32): `Cell.renders` is LEFT ON THE TYPE as a documented-
// unpopulated field, not deleted. It is not an FE-only type — `Cell` comes
// from `@ikenga/studio-schema`, which is the on-disk document contract the
// sidecar parses with `CellSchema`, so removing it is a persisted-schema
// change (and `sidecars/project/src/export/davinci.ts:655` still reads it,
// the same dead-field bug in the DaVinci export, out of this task's scope).
// No code under `src/studio/` reads it any more; anything needing
// "has this shot rendered?" or "which record's poster?" uses these.

/** Structural shape of the fields these helpers read off a `RenderRecord`, so
 *  the derivation is testable without constructing a full schema record. */
export interface DoneRenderRecordLike {
  id?: string;
  cell_uid?: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
}

const recordTimeMs = (r: DoneRenderRecordLike): number => {
  const v = r.finished_at ?? r.started_at;
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * cell uid → id of that cell's LATEST DONE render record.
 *
 * `done` only — a queued/running/failed row has no poster and no finished
 * frame, and treating one as a done render is the Round-2 defect the Breakdown
 * header calls out. Among several done records the most-recently-finished
 * wins; lacking timestamps, the later list position does (`>=`), matching
 * `views/composition/format.ts`'s `recordByUid` recency intent.
 *
 * Deliberately NOT `recordByUid` itself: that one returns the best record of
 * ANY status (it ranks, it does not filter), so its result still has to be
 * status-checked by every caller. Posters and stage derivation both want the
 * done record or nothing, so the filter lives here once.
 */
export function doneRecordIdByUid(
  records: readonly DoneRenderRecordLike[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const best: Record<string, number> = {};
  for (const r of records ?? []) {
    if (!r || r.status !== 'done') continue;
    if (typeof r.cell_uid !== 'string' || !r.cell_uid) continue;
    if (typeof r.id !== 'string' || !r.id) continue;
    const t = recordTimeMs(r);
    const prev = best[r.cell_uid];
    if (prev !== undefined && t < prev) continue;
    best[r.cell_uid] = t;
    out[r.cell_uid] = r.id;
  }
  return out;
}

/**
 * The record ids to hand `prefetchPosters` for a set of visible shots — one
 * batched `render.list_posters` for the whole board, never one per tile
 * (review §2.5; the batching contract itself was proven live, it was only
 * never exercised from the canvas because its input was the dead field).
 *
 * Order follows `uids`, duplicates are dropped, and a shot with no done render
 * contributes nothing — so the returned array joined is a stable identity for
 * "the current done-set" and the caller can fire exactly once per change.
 *
 * `limit` CAPS the batch, and it is not cosmetic. Two hard ceilings sit
 * downstream of this list and both fail silently when it overruns them:
 *   • `views/composition/CellPoster.tsx`'s blob cache is a 50-entry LRU, and
 *     `bump()` evicts DURING the resolving batch — so a 60-id batch leaves the
 *     first 10 posters decoded, cached, evicted and revoked. Those tiles then
 *     re-request one id at a time through `<CellPoster>`'s own microtask
 *     fallback (an N+1 burst), and because their effect deps are unchanged the
 *     poster simply disappears instead.
 *   • the sidecar truncates `render.list_posters` at 100 ids without saying so
 *     (`sidecars/project/src/render-runner.ts`), so ids past 100 come back as
 *     honest misses that are then cached as misses forever.
 * A caller with more done shots than the cap must therefore hand over a
 * PREFIX and let the rest fall back to their status text — never the whole
 * board. An un-capped call is still allowed (tests, small fixed sets).
 */
export function doneRecordIdsFor(
  uids: Iterable<string>,
  doneIdByUid: Record<string, string>,
  limit?: number,
): string[] {
  const cap = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const uid of uids) {
    if (ids.length >= cap) break;
    const id = doneIdByUid[uid];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// ─── the pipeline (Plan 25 "node model" table) ───────────────────────────
//
// The plan's fixed pipeline is "~6: script → breakdown → anchors → generate →
// render → export". WP-28 shipped five ending in a `Resolve` stage; that was
// drift, not a decision (G-76 #9). Resolve is one EXPORT TARGET among several
// (Plan 24's `export.davinci_timeline` sits beside `export.compose`), so it is
// a property of the export stage rather than a stage of its own. Back to six.

export type StageId = 'script' | 'breakdown' | 'anchors' | 'generate' | 'render' | 'export';

export interface StageDef {
  id: StageId;
  title: string;
}

export const PIPELINE_STAGES: StageDef[] = [
  { id: 'script', title: 'Script' },
  { id: 'breakdown', title: 'Breakdown' },
  { id: 'anchors', title: 'Anchors' },
  { id: 'generate', title: 'Generate' },
  { id: 'render', title: 'Render' },
  { id: 'export', title: 'Export' },
];

export const stageNodeId = (id: StageId): string => `stage-${id}`;

/**
 * D-25-1 — which pipeline stage a shot is currently IN. Membership, not
 * containment: the answer is rendered as an edge plus a chip on the shot, and a
 * shot passes through every stage over its life, so nothing here owns anything.
 *
 * Every branch reads a fact already on disk or already in the render queue. No
 * branch guesses:
 *   • a shot with nothing authored yet is still being broken down;
 *   • a shot whose prompt names anchors it doesn't have is at the anchors step;
 *   • queued/running is generation in flight;
 *   • a done render has rendered;
 *   • `approved` on top of a done render is what export composes from.
 * `failed`/`cancelled` report `generate` ONLY for a shot with nothing to show
 * — that is where the work stalled, and the stage node's own warning
 * affordance is what flags it. A failure ON TOP of an earlier successful take
 * is a different fact and reports differently: `hasDoneRender` wins, so the
 * chip reads `render`/`export` (what the shot HAS) and `rollupStages` puts the
 * `1 failed` warning on that stage instead of `generate`. This is reachable on
 * a real board — `render.list` rows come back created_at DESC and
 * `foldRenderStatus` (`lib/composition-model.ts`) lets a later-iterated
 * non-active row win, so a shot whose history is failed(t1) → done(t2) folds
 * to status `failed` while `doneRecordIdByUid` still reports its done id.
 * Intended: the warning follows the chip, so the two never disagree about
 * where the shot is. Pinned by the `(failed, true)` / `(cancelled, true)`
 * cases in `canvas-links.test.ts`.
 *
 * `hasDoneRender` is "did this shot EVER finish a render", from the live
 * `render.list` records (`doneRecordIdByUid` above) — it used to be read off
 * `Cell.renders`, which nothing populates, so this branch was unreachable on
 * every real project and a re-queued shot that had already rendered reported
 * `generate`. It is a REQUIRED parameter, not an optional one defaulting to
 * `false`, precisely so a future caller cannot reintroduce that silent dead
 * input: omitting the source is now a compile error.
 *
 * Branch order is unchanged from WP-28: a finished render outranks a render
 * currently in flight, so a shot re-rendering over an existing take reads
 * `render`/`export` (what it HAS) rather than `generate` (what it is doing).
 * The in-flight fact is carried by the render beacon and the tile's own status
 * line, not by the stage chip.
 */
export function deriveShotStage(
  cell: Cell,
  status: RenderStatus | undefined,
  hasDoneRender: boolean,
): StageId {
  if (status === 'done') return cell.approved ? 'export' : 'render';
  if (hasDoneRender) return cell.approved ? 'export' : 'render';
  if (status === 'queued' || status === 'running') return 'generate';
  const authored = Boolean(cell.prompt?.trim() || cell.action?.trim() || cell.intent?.trim());
  if (!authored) return 'breakdown';
  return 'generate';
}

/** Counts per stage plus the failed set, for the stage-node rollup. D-25-4 is
 *  still open with the founder; this implements only its uncontroversial half —
 *  counts are primary, and a failed member promotes a warning WITHOUT changing
 *  the count (never worst-wins, which reads as alarming on a healthy board). */
export interface StageRollup {
  counts: Record<StageId, number>;
  failed: Record<StageId, number>;
}

export function rollupStages(
  cells: Cell[],
  statusOf: (uid: string) => RenderStatus | undefined,
  hasDoneRenderOf: (uid: string) => boolean,
): StageRollup {
  const counts = {} as Record<StageId, number>;
  const failed = {} as Record<StageId, number>;
  for (const s of PIPELINE_STAGES) {
    counts[s.id] = 0;
    failed[s.id] = 0;
  }
  for (const c of cells) {
    const status = statusOf(c.uid);
    const stage = deriveShotStage(c, status, hasDoneRenderOf(c.uid));
    counts[stage] += 1;
    if (status === 'failed') failed[stage] += 1;
  }
  return { counts, failed };
}

// ─── the sequence lane (D-25-5) ──────────────────────────────────────────
//
// "A shot's default placement is DERIVED, not authored: lane position = its
// index." Everything below exists so that stays true after the user drags
// something else: derived slots are recomputed from `Cell.index` on every
// render and are never written into `.studio/canvas.json`.

export const GRID_SNAP = 24;
export const LANE_Y = 320;
export const LANE_X0 = 40;
export const LANE_STEP = 220;
export const LANE_NODE_W = 200;
export const LANE_NODE_H = 220;
/** Collapsed-to-a-strip height (D-25-5's "recovers the Rail's compactness"). */
export const LANE_STRIP_H = 44;
/** Vertical tolerance around the lane: a drop inside this band is a lane
 *  reorder; anything outside it is free placement and stays non-semantic. */
export const LANE_BAND = 90;

export function laneSlot(index: number, laneCollapsed: boolean): Placement {
  return {
    x: LANE_X0 + index * LANE_STEP,
    y: LANE_Y,
    w: LANE_NODE_W,
    h: laneCollapsed ? LANE_STRIP_H : LANE_NODE_H,
  };
}

/** Is this placement sitting in the lane (i.e. did the user drop it back into
 *  the timeline rather than parking it somewhere)? */
export function inLaneBand(p: Placement | undefined): boolean {
  if (!p) return false;
  return Math.abs(p.y - LANE_Y) <= LANE_BAND;
}

export function placementsEqual(a: Placement | undefined, b: Placement | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Keep only what the user really AUTHORED. Any key whose placement is exactly
 * its derived default is dropped, so a shot resting at its lane slot has no
 * persisted position and keeps tracking `Cell.index` when an agent reorders the
 * board. Without this, the first drag anywhere on the canvas would freeze every
 * other node at wherever the lane happened to put it that render — the "lane
 * position is derived, not authored" half of D-25-5, silently lost.
 */
export function stripDerived(
  layout: Record<string, Placement>,
  derived: Record<string, Placement>,
): Record<string, Placement> {
  const authored: Record<string, Placement> = {};
  for (const [id, p] of Object.entries(layout)) {
    if (placementsEqual(p, derived[id])) continue;
    authored[id] = p;
  }
  return authored;
}

/**
 * The order the lane currently READS as, left to right — the array
 * `storyboard.reorder_cells` is handed after an in-lane drop.
 *
 * Only shots sitting inside the lane band participate in the sort; a shot the
 * user broke out keeps its existing ordinal and is spliced back at that
 * position, because breaking a shot out "changes nothing about the film".
 * Ties (two shots at the same x, which grid-snap makes reachable) fall back to
 * the incoming order so the result is deterministic.
 */
export function laneOrderFrom(
  shots: Array<{ uid: string; index: number }>,
  placementOf: (uid: string) => Placement | undefined,
): string[] {
  const inLane: Array<{ uid: string; x: number; seq: number }> = [];
  const outOfLane: Array<{ uid: string; index: number }> = [];

  shots.forEach((s, seq) => {
    const p = placementOf(s.uid);
    if (inLaneBand(p)) inLane.push({ uid: s.uid, x: p!.x, seq });
    else outOfLane.push({ uid: s.uid, index: s.index });
  });

  inLane.sort((a, b) => a.x - b.x || a.seq - b.seq);
  const order = inLane.map((s) => s.uid);

  // Splice the parked shots back at their own ordinals, lowest first, so their
  // index survives the round trip.
  outOfLane
    .sort((a, b) => a.index - b.index)
    .forEach((s) => {
      const at = Math.min(Math.max(s.index, 0), order.length);
      order.splice(at, 0, s.uid);
    });

  return order;
}

/** Did the two orders actually differ? A drag that lands a shot back in its own
 *  slot must not write `Cell.index` at all. */
export function orderChanged(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return true;
  return false;
}

// ─── creating a shot at the end of the lane (G-61 behaviour 5) ───────────
//
// The Rail owns the same two seams (`storyboard.create_cell` /
// `storyboard.delete_cell`); the node canvas calls the SAME RPCs with the same
// cell SHAPE, so `storyboard.json` gains the same fields whichever surface made
// it and the `cells/changed` event re-hydrates both.
//
// `index` used to be the one field that DIFFERED, and the divergence was a real
// defect (G-103). The Rail sent `displayCells.length`; this module sends
// `nextLaneIndex` = max(maxIndex + 1, length). Those agree on an unbroken board
// and diverge on a board with a GAP — which is exactly the board the delete
// seam below creates, since the sidecar's `deleteCell`
// (sidecars/project/src/storyboard.ts) does not reindex. Delete the index-3 of
// 8 shots and the Rail's next create sent `length` = 7, colliding with the
// surviving index-7 cell (laneShots sorts on index, so the new shot landed
// second-to-last instead of at the end). Live-confirmed on the WP-32 fixture:
// from the canvas, a create on a gapped 5-cell board wrote index 5 = max(4)+1,
// where the Rail's arithmetic would have written 4 and collided
// (`g61/5-verdict.md` t6).
//
// So `views/Canvas.tsx`'s create call now routes through `nextLaneIndex` too —
// a one-expression change at the call site, deliberately NOT a refactor of the
// Rail's inline cell literal into `buildNewLaneCell` (that is a Rail change,
// outside this seam's blast radius). End-of-lane is now ONE piece of
// arithmetic, so the two surfaces cannot disagree about where a new shot goes.
//
// ONE function was not enough on its own, because the two surfaces were also
// feeding it DIFFERENT BOARDS. The Rail's first cut passed `displayCells`, its
// PRESENTATION list — and `displayCells` is `hasRealCells ? hydratedCells.map(
// toDisplayCell) : MOCK_CELLS`, where `selectHasRealCells` is
// `source === 'real' && cells.length > 0`. Two boards where that is the wrong
// input:
//   • a REAL project with zero cells (a fresh scaffold, or after deleting the
//     last shot) → `hasRealCells` false → the 10-entry `__mocks__/cells.ts`
//     fixture, none of which carry `raw`, so both terms collapse to `length`
//     and the Rail would write `index: 10` for the FIRST cell on disk while the
//     canvas wrote 0;
//   • the demo board → the same 10-entry display fixture, while
//     `storyboard.create_cell` actually appends to the mock MCP's own 6-cell
//     array (`__mocks__/mcp.ts`), so the Rail wrote 10 into a board whose
//     end-of-lane is 6.
// Both surfaces therefore pass the array the create RPC APPENDS TO — the
// storyboard store's `cells` (`selectHydratedCells`), which is the real board
// in real mode and the mock MCP's board in demo mode. `nextLaneIndex` stays
// tolerant of a missing `index` so a hand-edited or presentation-shaped board
// can still be passed without throwing, but nothing in the app passes one now.
//
// Because the Rail still builds its cell inline in JSX-land, nothing in the
// type system keeps the two literals aligned. What does keep them honest is the
// key-set + value lock in `canvas-links.test.ts`: a field added or a default
// changed on either side fails a written-down contract instead of surfacing
// only as the sidecar's `CellSchema.safeParse` 'invalid-args' in the node-canvas
// error banner. The shared index arithmetic is pinned in
// `canvas-controls.test.ts`.

/** The Rail's default label when the user types nothing in the New cell dialog. */
export const NEW_CELL_LABEL = 'new beat';
/** The Rail's default rung (its `newRung` initial state). */
export const NEW_CELL_RUNG: Rung = '2_hifi';

const slugifyBeat = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'beat';

const rnd6 = () => Math.random().toString(36).slice(2, 8);

/**
 * The `Cell.index` a new shot gets so it lands at the END of the lane. The ONE
 * answer for both create surfaces (the canvas toolbar and the Rail's modal) —
 * see the G-103 note above.
 *
 * `length` alone (what the Rail sent) is right on a fresh scaffold — every
 * index is 0 there, so `max + 1` would be 1 and collide — but wrong on a board
 * whose indexes have already been written past the cell count: a reorder that
 * left a gap, or a delete. `max + 1` alone is right there and wrong on the
 * scaffold. Taking the max of the two is end-of-lane in BOTH cases and never
 * duplicates an existing ordinal, which matters because `laneShots` sorts on
 * `index` and a duplicate falls back to storyboard order.
 *
 * Tolerant of a missing/non-finite `index` (counted as 0), because a
 * hand-edited `storyboard.json` can omit it and a presentation projection never
 * had it — on such a board the two terms collapse back to `length`. That
 * tolerance is a guard, NOT a supported call shape: both call sites pass the
 * storyboard store's schema cells, i.e. the array `storyboard.create_cell`
 * appends to. See the G-103 note above for why passing a presentation list was
 * itself the second half of the bug.
 */
export function nextLaneIndex(cells: Array<{ index?: number }>): number {
  if (cells.length === 0) return 0;
  let max = -1;
  for (const c of cells) {
    const i = typeof c.index === 'number' && Number.isFinite(c.index) ? c.index : 0;
    if (i > max) max = i;
  }
  return Math.max(max + 1, cells.length);
}

/**
 * A minimal valid Cell, the same shape the Rail's `createCell` sends (the Rail
 * still builds its own copy inline — see the section note above for why, and
 * for the test that pins this shape so the two can't drift silently).
 * The sidecar's `CellSchema.parse` fills the rest (shot_type, renderer,
 * approved, …) — hence the cast, exactly as the Rail casts.
 *
 * `suffix` / `now` are injectable so the test can assert the derived strings
 * (uid, beat_id, content_path) instead of asserting around randomness.
 */
export function buildNewLaneCell(params: {
  index: number;
  label?: string;
  rung?: Rung;
  suffix?: () => string;
  now?: () => string;
}): Cell {
  const label = (params.label ?? '').trim() || NEW_CELL_LABEL;
  const rung = params.rung ?? NEW_CELL_RUNG;
  const suffix = params.suffix ?? rnd6;
  const now = params.now ?? (() => new Date().toISOString());
  const beatId = `${slugifyBeat(label)}-${suffix()}`;
  const uid = `${beatId}-${suffix()}`;
  return {
    uid,
    beat_id: beatId,
    rung,
    index: params.index,
    label,
    time: { start: 0, end: 0 },
    frames: { start: 0, end: 0 },
    content_path: `cells/${rungDir(rung)}/${uid}/content.html`,
    rungs: {
      '0_beat_sheet': { status: 'pending' },
      '1_lofi': { status: 'pending' },
      '2_hifi': { status: 'pending' },
    },
    last_edited: now(),
  } as unknown as Cell;
}

// ─── naming the destructive controls (G-102, live-fixed 2026-09-12) ──────
//
// The node canvas renders one delete control PER SHOT, so their accessible
// names are the only thing distinguishing five destructive buttons from each
// other — for a screen reader and for a UI driver that resolves a control by
// name and then clicks it. Getting this wrong is a wrong-shot delete, not a
// cosmetic a11y nit.
//
// The names used to be keyed on `beatNameOf` alone, on the written assumption
// that `beat_id` "carries a random suffix, so it is unique per cell". That is
// true only of cells this FE created (`buildNewLaneCell` appends `rnd6()`); it
// is FALSE for every cell an archetype chain or an agent authored. The live
// fixture is the disproof: all five of its cells carry `beat_id = beat-hello`,
// so the graph surface rendered FIVE buttons named exactly
// `Delete cell beat-hello` — the precise ambiguity the old comment set out to
// avoid (`g61/5-verdict.md`, `g61/5-graphmode-dom.txt` refs e62/e71/e81/e91/e101).
// `label` is no better and often worse: this surface's create path hardcodes
// `NEW_CELL_LABEL`, so three creates give three shots all labelled 'new beat'.
//
// `Cell.uid` is the only project-unique identifier on the record, so it goes in
// the name — the beat stays in front of it because that is the human-readable
// half and it matches the Rail's `DisplayCell.beat`. The three names below are
// the DRIVER-FACING CONTRACT; they are pinned by `canvas-controls.test.ts` and
// listed in the `views/NodeCanvas.tsx` header.

/**
 * The human-readable half of a shot's identity — `DisplayCell.beat`'s own
 * expression (`storyboard-store.ts` `toDisplayCell`). NOT unique on a real
 * board, which is the whole G-102 note above.
 *
 * Accepts EITHER shape, so the two surfaces can share one name helper and
 * genuinely announce the same shot the same way:
 *   • a schema `Cell` (the node canvas) → `beat_id || label || uid`;
 *   • the Rail's `DisplayCell` / `MockCell`, which carries the already-computed
 *     `beat` and no `beat_id` / `label` at all. Without the `beat` branch,
 *     handing this function a display cell silently falls through to `uid`,
 *     which is how a "shared" helper can still produce two different strings
 *     for the same shot.
 * `beat` is checked first and is by construction the same string the other
 * branch would derive, so the two inputs agree for any real cell.
 */
export function beatNameOf(cell: {
  uid: string;
  beat?: string | null;
  beat_id?: string | null;
  label?: string | null;
}): string {
  return cell.beat || cell.beat_id || cell.label || cell.uid;
}

/**
 * Accessible name (and hover tooltip) for a per-shot delete control —
 * `Delete cell <beat> (<uid>)`.
 *
 * Used by ALL THREE per-shot delete controls in the pkg: the node canvas's
 * expanded card and collapsed strip — a driver must not have to know which
 * state a card is in — and the RAIL's hover-revealed ✕. The Rail matters most,
 * not least: `canvasMode` defaults to `'rail'`, so it is the surface a human
 * lands on, it is the one the WP-32 gate calls "currently the only working
 * surface", and its ✕ was the only delete the live round drove end-to-end with
 * a real OS mouse (`g61/5-verdict.md`). Leaving it on `Delete cell ${beat}`
 * would have left five identical destructive controls on the DEFAULT view
 * while claiming G-102 was closed.
 *
 * It is also the `title`, not just the `aria-label`: on the live fixture every
 * cell's `beat` is `beat-hello` and every canvas-created shot's label is
 * `new beat`, so a bare `Delete cell` tooltip is the one affordance a sighted
 * pointer user gets and it identified nothing.
 */
export function deleteCellControlName(cell: {
  uid: string;
  beat?: string | null;
  beat_id?: string | null;
  label?: string | null;
}): string {
  return `Delete cell ${beatNameOf(cell)} (${cell.uid})`;
}

/**
 * Accessible name for the ARMED confirm dialog. Deliberately not the same
 * string as the button that opened it: they coexist in the tree (the per-shot
 * button is still rendered behind the modal), and a driver resolving
 * `Delete cell beat-hello (uid)` must not be able to land on the dialog's own
 * container node instead of the button.
 *
 * The dialog's two buttons keep their unqualified `Cancel delete cell` /
 * `Confirm delete cell` names: the dialog is modal and singleton, so exactly
 * one of each exists while it is open, and its own name plus its printed uid
 * line already say which shot is at stake.
 */
export function deleteConfirmDialogName(target: { uid: string; beat: string }): string {
  return `Confirm deleting cell ${target.beat} (${target.uid})`;
}

// ─── the DOM contract with the <Canvas> primitive (live fix, 2026-09-12) ──
//
// `@ikenga/contract/canvas`'s Canvas.tsx clones what `renderItem` returns and
// injects ONLY `left / top / width` inline, plus `data-id`. Two consequences
// the consumer — not the primitive — has to satisfy, both of which WP-32's
// live round found unsatisfied on this surface:
//
//   1. POSITIONING. The injected left/top are inert unless the card root is
//      `position: absolute`. The bundled canvas.css supplies that only for the
//      shell-home classes (`.home-widget` / `.home-greeting`); every studio
//      node root was `h-full w-full …`, so all of them stacked in document
//      flow at one pane-height each and exactly ONE node was on screen
//      (`plans/studio/verify/2026-09-12-wp32-live/g61/gap-canvas-unpositioned/`).
//      Height is NOT injected either, so the root must take it from
//      `state.placement.h` — `h-full` resolved against the stage, not the node.
//   2. HIT-TESTING. Canvas' `ITEM_SELECTOR` is
//      `'.home-widget, .home-greeting, [data-canvas-item]'`, tested with
//      `closest()` before `onSelectionChange` / `beginDrag`. A root carrying
//      none of the three can never be selected or dragged, which killed the
//      lane reorder, free placement, group membership and the `+ group` button
//      path in one stroke (`wp28/verdict.md`, `wp29/verdict.md`).
//
// Both live here rather than inline in the view so a headless test can assert
// them, and so a new node kind gets them by construction.

/** Positioning class every node root must carry — see (1) above. */
export const NODE_POSITION_CLASS = 'absolute';

/** Hit-test attribute every node root must carry — see (2) above. */
export const CANVAS_ITEM_ATTR = 'data-canvas-item';

/**
 * In-card controls that must NOT start a canvas gesture. `closest()`-matched
 * in the node root's own mousedown, which stops propagation so the primitive's
 * root handler never sees it. Without this the `+ group` / `− group` button is
 * unclickable by construction: mousedown inside a shot card would re-select
 * that shot, `activeGroup` (gated on a GROUP being selected) would go null, and
 * the button would unmount before its click could land.
 */
export const NODE_NODRAG_SELECTOR = 'button,a,input,select,textarea,iframe,[data-canvas-nodrag]';

export interface NodeRootProps {
  className: string;
  style: { height: number };
  'data-canvas-item': string;
}

/**
 * The props every `renderItem` root spreads. `className` leads with the
 * positioning class so the consumer's own classes can still win later in the
 * list; `style.height` is merged UNDER the primitive's injected left/top/width
 * (Canvas spreads the consumer style last), so both survive.
 */
export function nodeRootProps(placement: Placement, className: string): NodeRootProps {
  return {
    className: className ? `${NODE_POSITION_CLASS} ${className}` : NODE_POSITION_CLASS,
    style: { height: placement.h },
    [CANVAS_ITEM_ATTR]: '',
  } as NodeRootProps;
}

/** Content equality for a whole layout map (identity-blind). */
export function layoutsEqual(
  a: Record<string, Placement>,
  b: Record<string, Placement>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!(k in b)) return false;
    if (!placementsEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Mutate `box` in place until its CONTENT equals `next`; return whether
 * anything actually changed.
 *
 * The point is the IDENTITY. `use-pan-zoom.ts` declares
 * `autoFit = useCallback(…, [layout, editMode, setPan])` and then keeps
 * `useEffect(() => autoFit(true), [editMode, autoFit])`, so a layout object
 * that is merely re-derived — same numbers, new object — re-fires auto-fit and
 * snaps the user's pan/zoom back. On this surface every `canvas.write` echoed
 * through the fs watcher as `cells/changed` → storyboard refetch → new `cells`
 * array → new lane order → new derived layout, which is why 8 middle-drags of
 * 1360 px moved the board 138 px and a `-` click reverted inside ~300 ms
 * (`wp29/verdict.md`, `wp29/zoom-snapback-samples.txt`).
 *
 * Handing the primitive ONE box whose identity never changes moves auto-fit
 * back under the consumer's control (once per project open, plus Reset) while
 * keeping placements current: Canvas re-reads `layout[id]` on every render, and
 * `use-drag-snap`/`autoFit` read it through refs at gesture/call time, so a
 * mutated box is as fresh as a replaced one. Idempotent, so a StrictMode
 * double-render is harmless.
 */
export function syncLayoutBox(
  box: Record<string, Placement>,
  next: Record<string, Placement>,
): boolean {
  let changed = false;
  for (const k of Object.keys(box)) {
    if (!(k in next)) {
      delete box[k];
      changed = true;
    }
  }
  for (const k of Object.keys(next)) {
    const p = next[k];
    if (!placementsEqual(box[k], p)) {
      box[k] = p;
      changed = true;
    }
  }
  return changed;
}

// ─── (3) the keyboard bridge ────────────────────────────────────────────────
//
// `use-pan-zoom`'s arrow-pan / ±-zoom branch is gated on
// `document.activeElement === canvasRef.current`, and Canvas's own item
// mousedown MOVES focus to the clicked item in a rAF (its WCAG 2.4.3
// roving-selection behaviour). So after any click on a node — which is the
// normal state of this board, since the cross-view selection effect keeps a
// shot selected — the keyboard alternative to dragging is unreachable: the
// focused element is the node, not the surface. Consumer-side fix: a keydown
// handler on the surface wrapper hands the surface focus when one of the keys
// the primitive implements arrives at a node, so the SAME native event reaches
// the primitive's window listener (which runs after React's bubble phase)
// already satisfying the gate.
//
// The two constants live here so the set can be asserted against the
// primitive's implemented codes without a DOM.

/** Keys `use-pan-zoom` acts on while the canvas ROOT holds focus. Arrows are
 *  matched on `event.key`, zoom on `event.code` — exactly as the primitive
 *  reads them (`use-pan-zoom.js`: `switch (e.key)` with an `e.code` default
 *  branch for `Equal`/`NumpadAdd`/`Minus`/`NumpadSubtract`). */
export const CANVAS_PAN_ZOOM_KEYS: readonly string[] = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Equal',
  'NumpadAdd',
  'Minus',
  'NumpadSubtract',
];

/** True for a keydown the focused canvas surface would act on. */
export function isCanvasPanZoomKey(code: string, key: string): boolean {
  return CANVAS_PAN_ZOOM_KEYS.includes(code) || CANVAS_PAN_ZOOM_KEYS.includes(key);
}

/**
 * Targets the bridge must leave alone: everything that owns its own arrow /
 * space semantics. `NODE_NODRAG_SELECTOR` already names the controls that live
 * inside a node (a `button` treats Space as activation, an `input` treats
 * arrows as caret movement), plus contenteditable for the same reason.
 */
export const KEY_BRIDGE_SKIP_SELECTOR = `${NODE_NODRAG_SELECTOR},[contenteditable="true"]`;
