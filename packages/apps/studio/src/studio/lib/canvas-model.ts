// com.ikenga.studio · node-canvas geometry + stage derivation (Plan 25)
//
// Pure functions only, so the load-bearing decisions (D-25-1 stage membership,
// D-25-5 lane semantics) are headless-testable without mounting React or the
// pan/zoom primitive.

import type { Placement } from '@ikenga/contract/canvas';
import { rungDir } from '../mcp-types';
import type { Cell, RenderStatus, Rung } from '../mcp-types';

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
 * `failed`/`cancelled` deliberately report `generate` — that is where the work
 * stalled, and the stage node's own warning affordance is what flags it.
 */
export function deriveShotStage(cell: Cell, status: RenderStatus | undefined): StageId {
  if (status === 'done') return cell.approved ? 'export' : 'render';
  const hasDoneRender = (cell.renders ?? []).some((r) => r.status === 'done');
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
): StageRollup {
  const counts = {} as Record<StageId, number>;
  const failed = {} as Record<StageId, number>;
  for (const s of PIPELINE_STAGES) {
    counts[s.id] = 0;
    failed[s.id] = 0;
  }
  for (const c of cells) {
    const status = statusOf(c.uid);
    const stage = deriveShotStage(c, status);
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
// One field deliberately DIFFERS, and the difference is not an oversight:
// `index`. The Rail sends `displayCells.length` (views/Canvas.tsx). This module
// sends `nextLaneIndex` = max(maxIndex + 1, length). Those agree on an unbroken
// board and diverge on a board with a gap — which is exactly the board the
// delete seam below creates, since the sidecar's `deleteCell`
// (sidecars/project/src/storyboard.ts) does not reindex. Delete the index-3 of
// 8 shots and the Rail's next create sends `length` = 7, colliding with the
// surviving index-7 cell (laneShots sorts on index, so it lands second-to-last);
// this one sends 8, the true end of the lane. Parity of shape, NOT of that
// arithmetic — and the node canvas's answer is the correct one.
//
// The Rail builds its cell inline in JSX-land and has NOT been refactored to
// call `buildNewLaneCell` (a Rail change, outside this seam's blast radius), so
// nothing in the type system keeps the two literals aligned. What does keep
// them honest is the key-set + value lock in `canvas-links.test.ts`: a field
// added or a default changed on either side fails a written-down contract
// instead of surfacing only as the sidecar's `CellSchema.safeParse`
// 'invalid-args' in the node-canvas error banner.

/** The Rail's default label when the user types nothing in the New cell dialog. */
export const NEW_CELL_LABEL = 'new beat';
/** The Rail's default rung (its `newRung` initial state). */
export const NEW_CELL_RUNG: Rung = '2_hifi';

const slugifyBeat = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'beat';

const rnd6 = () => Math.random().toString(36).slice(2, 8);

/**
 * The `Cell.index` a new shot gets so it lands at the END of the lane.
 *
 * The Rail uses `displayCells.length`, which is right on a fresh scaffold
 * (every index is 0 there) but collides on a board whose indexes have already
 * been written past the cell count — a reorder that left a gap, or a delete.
 * Taking the max of the two is end-of-lane in both cases and never duplicates
 * an existing ordinal, which matters because `laneShots` sorts on `index` and
 * a duplicate would fall back to storyboard order.
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
