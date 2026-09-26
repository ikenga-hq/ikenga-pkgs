/**
 * Spend gate + ledger (WP-12 / Plan 16 D-b).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Round 3 made the flip (FLUX inpaint → Kling O1 interpolation) the PRIMARY
 * lane. Every shot on that lane bills per render, and until this module there
 * was no ceiling anywhere in the system. Six experimental generations reached
 * $6.30; a 14-shot film with rework is not self-limiting. The failure mode is
 * not a visible error — it is an unattended overnight run that keeps working
 * exactly as designed while the invoice climbs.
 *
 * ── Why it lives here and not in fal.ts ──────────────────────────────────
 * A gate inside the fal adapter guards one adapter. This module is consulted
 * at the *call sites* — `RenderRunner.enqueue` and `anchors.generate` — so it
 * covers any paid engine (Veo, Runway, a future Kling adapter) with no change
 * at this file. The adapter contract already marks the metered ones:
 * `capabilities.requires_network === true` (see registry.ts, which uses the
 * same bit for the auto-resolution consent guard).
 *
 * ── Two paid doors, not one ──────────────────────────────────────────────
 * `render.enqueue` is the obvious one. `anchor.generate` is the other: it
 * calls `generateStill()` directly and NEVER touches the render queue, which
 * is precisely how the Round-3 experiments spent their $6.30. A gate on the
 * queue alone would not have caught a single one of them. Both doors call
 * `reserve()`.
 *
 * ── Why estimates, not just cost_actual ──────────────────────────────────
 * `extractCost()` in fal.ts is best-effort and its own comment says fal
 * "rarely returns a cost field". A ledger that summed only `cost_actual`
 * would read $0.00 forever while real money left the account — a gate that
 * cannot see spend is not a gate. So every paid call is CHARGED AN ESTIMATE
 * at reserve time from the price table below, and reconciled down (or up) to
 * the real figure by `settle()` when the provider does report one.
 *
 * ── Reserve → settle → void ──────────────────────────────────────────────
 * Enqueuing 14 shots reserves 14 estimates immediately, so the ceiling sees
 * the whole batch rather than only what has finished billing. Without this,
 * 30 queued renders read as $0.00 spent until they start landing — which is
 * exactly the unattended-overnight case. A render that fails or is cancelled
 * calls `voidEntry()` and gives its reservation back.
 *
 * ── The refusal is not agent-overridable ─────────────────────────────────
 * There is deliberately no `force` / `approve` / `override` parameter on any
 * function here, and none is plumbed through the RPC or MCP surface. Raising
 * a ceiling is a human act: edit `Project.metadata.spend_ceiling_usd`, or set
 * `STUDIO_SPEND_CEILING_USD` in the environment. This mirrors the
 * `Cell.approved` rule — the agent proposes, the human approves — and it is
 * the whole point of the work package. Do not add an override flag.
 */

import { randomUUID } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────
// Ceiling resolution
// ─────────────────────────────────────────────────────────────────────────

/**
 * Applied when a project has authored no ceiling of its own. Conservative by
 * intent: it is a backstop against a fresh project spending money nobody
 * sized, not a budget. A real film authors its own — The Forge carries $25 in
 * `Project.metadata.spend_ceiling_usd`, ~2× its ~$11/90s estimate.
 */
export const DEFAULT_CEILING_USD = 15;

/** Environment override. A human act, same as editing project metadata. */
export const CEILING_ENV = 'STUDIO_SPEND_CEILING_USD';

/** Project-metadata key holding a hand-authored per-project ceiling, in USD. */
export const CEILING_METADATA_KEY = 'spend_ceiling_usd';

export type CeilingSource = 'env' | 'project' | 'default';

export interface ResolvedCeiling {
  usd: number;
  source: CeilingSource;
}

/**
 * Precedence: env > project metadata > built-in default.
 *
 * Env wins because it is the operator's hand on the machine actually running
 * the renders — useful both to tighten a run below what the project document
 * says and to raise it for one deliberate session without editing the film.
 * Both are human acts; neither is reachable from an agent tool call.
 *
 * A non-finite or negative value from either source is ignored rather than
 * honoured: a typo'd `STUDIO_SPEND_CEILING_USD=abc` must not silently become
 * an unbounded budget. Zero IS honoured — it means "spend nothing", which is
 * a legitimate and useful setting.
 */
export function resolveCeiling(projectMetadata?: Record<string, unknown>): ResolvedCeiling {
  const raw = process.env[CEILING_ENV];
  if (raw != null && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return { usd: n, source: 'env' };
  }
  const fromProject = projectMetadata?.[CEILING_METADATA_KEY];
  if (typeof fromProject === 'number' && Number.isFinite(fromProject) && fromProject >= 0) {
    return { usd: fromProject, source: 'project' };
  }
  return { usd: DEFAULT_CEILING_USD, source: 'default' };
}

// ─────────────────────────────────────────────────────────────────────────
// Price table
// ─────────────────────────────────────────────────────────────────────────

/**
 * Rates as established on 2026-09-07 by the `studio-ai-shot-prompting` skill,
 * which took them from the ACTUAL fal invoice — several published figures
 * were wrong by 2–3×, so do not "correct" these against a pricing page
 * without re-running a billed job.
 *
 * Billing units are inconsistent and the inconsistency matters:
 *  - Fill / inpaint bills per MEGAPIXEL, ROUNDED UP. A 1280×704 frame (0.90 MP)
 *    costs a full megapixel; 1080p rounds to 3 MP — triple the 720p rate,
 *    not the 2.3× the pixel count suggests.
 *  - Kling O1 bills per VIDEO-SECOND.
 *  - Seedance bills per token, which made it ~2.4× cheaper than its published
 *    per-second figure; the per-clip figures below are the measured ones.
 *  - wan-vace rounds each job up to ~5s, so short clips carry a minimum.
 */
type Rate =
  | { unit: 'per_megapixel'; usd: number }
  | { unit: 'per_video_second'; usd: number; min_seconds?: number }
  | { unit: 'per_image'; usd: number }
  | { unit: 'per_clip_5s'; usd: number };

const RATES: Record<string, Rate> = {
  // ── stills / inpaint (invoice-verified) ──
  'fal-ai/flux-lora/inpainting': { unit: 'per_megapixel', usd: 0.035 },
  'fal-ai/flux-pro/v1/fill': { unit: 'per_megapixel', usd: 0.05 },
  'fal-ai/bytedance/seedream/v4/edit': { unit: 'per_image', usd: 0.03 },

  // ── video (invoice-verified) ──
  'fal-ai/kling-video/o1/image-to-video': { unit: 'per_video_second', usd: 0.112 },
  'fal-ai/bytedance/seedance/v1/pro/image-to-video': { unit: 'per_clip_5s', usd: 0.26 },
  'fal-ai/bytedance/seedance/v1/pro/fast/image-to-video': { unit: 'per_clip_5s', usd: 0.1 },
  'fal-ai/wan-vace-14b/inpainting': { unit: 'per_video_second', usd: 0.08, min_seconds: 5 },
};

/**
 * Charged when the model id is not in the table above.
 *
 * Deliberately priced at or above the most expensive KNOWN tier, because the
 * two error directions are not symmetric: estimating low lets an unlisted
 * model walk straight through the ceiling (and makes the gate trivially
 * bypassable by naming a model we have not priced), while estimating high
 * merely stops work early and visibly. A refusal you can see and raise beats
 * an invoice you cannot.
 */
const FALLBACK_STILL_USD = 0.15;
const FALLBACK_VIDEO_USD_PER_SECOND = 0.15;

/** Default clip length assumed when neither the range nor the cell says. */
const DEFAULT_CLIP_MS = 5000;

/** Default still size assumed when no resolution is known (720p ≈ 1 MP). */
const DEFAULT_STILL_MP = 1;

export interface EstimateInput {
  /** Which door: a queued video/render, or a one-shot still generation. */
  kind: 'render' | 'still';
  /** Resolved model id, when known (`cell.metadata.fal_model`, env, adapter default). */
  model_id?: string;
  /** Output framing, for per-megapixel models. */
  resolution?: { w: number; h: number };
  /** Clip length in ms, for per-video-second models. */
  durationMs?: number;
}

export interface Estimate {
  usd: number;
  /** Human-readable derivation, persisted on the ledger row so a refusal is auditable. */
  basis: string;
}

/** Megapixels, rounded UP with a floor of 1 — how fill actually bills. */
function megapixels(res?: { w: number; h: number }): number {
  if (!res || !(res.w > 0) || !(res.h > 0)) return DEFAULT_STILL_MP;
  return Math.max(1, Math.ceil((res.w * res.h) / 1_000_000));
}

/** Round to cents so ledger arithmetic doesn't accumulate float dust. */
function usd(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Price one paid call BEFORE it runs. Never returns 0 for a paid engine — a
 * free-looking estimate is indistinguishable from an ungated call.
 */
export function estimate(input: EstimateInput): Estimate {
  const model = input.model_id;
  const rate = model ? RATES[model] : undefined;

  if (!rate) {
    if (input.kind === 'still') {
      return {
        usd: FALLBACK_STILL_USD,
        basis: `fallback (unpriced model ${model ?? 'unknown'}): $${FALLBACK_STILL_USD}/still`,
      };
    }
    const secs = Math.max(1, (input.durationMs ?? DEFAULT_CLIP_MS) / 1000);
    return {
      usd: usd(secs * FALLBACK_VIDEO_USD_PER_SECOND),
      basis: `fallback (unpriced model ${model ?? 'unknown'}): ${secs}s × $${FALLBACK_VIDEO_USD_PER_SECOND}/s`,
    };
  }

  switch (rate.unit) {
    case 'per_megapixel': {
      const mp = megapixels(input.resolution);
      return { usd: usd(mp * rate.usd), basis: `${model}: ${mp} MP (rounded up) × $${rate.usd}/MP` };
    }
    case 'per_image':
      return { usd: usd(rate.usd), basis: `${model}: $${rate.usd}/image` };
    case 'per_video_second': {
      const raw = (input.durationMs ?? DEFAULT_CLIP_MS) / 1000;
      const secs = Math.max(raw, rate.min_seconds ?? 0);
      const note = secs > raw ? ` (billed to ${secs}s minimum)` : '';
      return { usd: usd(secs * rate.usd), basis: `${model}: ${secs}s × $${rate.usd}/s${note}` };
    }
    case 'per_clip_5s': {
      const clips = Math.max(1, Math.ceil((input.durationMs ?? DEFAULT_CLIP_MS) / 5000));
      return { usd: usd(clips * rate.usd), basis: `${model}: ${clips}×5s clip @ $${rate.usd}` };
    }
  }
}

/** Whether a model id has a real invoice-derived rate (vs. the fallback). */
export function isPriced(modelId?: string): boolean {
  return !!modelId && modelId in RATES;
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────

type Db = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

/** Public alias — the minimum DB surface a caller must hand the spend gate. */
export type SpendDb = Db;

export interface SpendLedgerRow {
  entry_id: string;
  project_id: string;
  /** Render `record_id` or anchor id — whatever the caller can look up later. */
  ref_id: string | null;
  kind: 'render' | 'still';
  engine: string;
  model_id: string | null;
  estimate_usd: number;
  actual_usd: number | null;
  /** `reserved` counts against the ceiling; `settled` counts; `void` does not. */
  state: 'reserved' | 'settled' | 'void';
  basis: string | null;
  created_at: number;
  settled_at: number | null;
}

export interface SpendTotals {
  /** Finished work, at its real (or best-known) price. */
  settled_usd: number;
  /** Queued or in-flight work, at estimate. */
  reserved_usd: number;
  /** settled + reserved — what the ceiling is actually compared against. */
  committed_usd: number;
}

/**
 * Cumulative project spend.
 *
 * `COALESCE(actual_usd, estimate_usd)` is the load-bearing part: a settled
 * entry whose provider reported no cost keeps its estimate rather than
 * collapsing to zero. fal usually reports nothing, so without the coalesce
 * the ledger would drift toward $0 exactly as work completed.
 */
export function totals(db: Db, projectId: string): SpendTotals {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'settled'  THEN COALESCE(actual_usd, estimate_usd) END), 0) AS settled,
         COALESCE(SUM(CASE WHEN state = 'reserved' THEN estimate_usd END), 0) AS reserved
       FROM spend_ledger
       WHERE project_id = ? AND state != 'void'`,
    )
    .get(projectId) as { settled: number; reserved: number } | undefined;
  const settled = usd(row?.settled ?? 0);
  const reserved = usd(row?.reserved ?? 0);
  return { settled_usd: settled, reserved_usd: reserved, committed_usd: usd(settled + reserved) };
}

export function listLedger(db: Db, projectId: string, limit = 200): SpendLedgerRow[] {
  return db
    .prepare(
      `SELECT * FROM spend_ledger WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectId, limit) as SpendLedgerRow[];
}

export interface ReserveInput {
  projectId: string;
  refId?: string;
  kind: 'render' | 'still';
  engine: string;
  model_id?: string;
  /** Project document metadata, for the per-project ceiling. */
  projectMetadata?: Record<string, unknown>;
  resolution?: { w: number; h: number };
  durationMs?: number;
}

export type ReserveResult =
  | {
      ok: true;
      entryId: string;
      estimate_usd: number;
      basis: string;
      ceiling_usd: number;
      ceiling_source: CeilingSource;
      committed_usd: number;
      remaining_usd: number;
    }
  | {
      ok: false;
      error: 'spend-ceiling-exceeded';
      message: string;
      estimate_usd: number;
      basis: string;
      ceiling_usd: number;
      ceiling_source: CeilingSource;
      committed_usd: number;
      remaining_usd: number;
    };

/**
 * Price a paid call, check it against the ceiling, and — only if it fits —
 * write a `reserved` ledger row.
 *
 * The refusal is terminal by design. There is no override parameter, and the
 * message names the two human remedies rather than implying the caller can
 * retry its way through. An agent that receives `spend-ceiling-exceeded`
 * should stop and report, not re-attempt with different arguments.
 */
export function reserve(db: Db, input: ReserveInput): ReserveResult {
  const est = estimate({
    kind: input.kind,
    model_id: input.model_id,
    resolution: input.resolution,
    durationMs: input.durationMs,
  });
  const ceiling = resolveCeiling(input.projectMetadata);
  const t = totals(db, input.projectId);
  const wouldBe = usd(t.committed_usd + est.usd);

  if (wouldBe > ceiling.usd) {
    return {
      ok: false,
      error: 'spend-ceiling-exceeded',
      message:
        `This ${input.kind} is estimated at $${est.usd.toFixed(4)} (${est.basis}). ` +
        `Project ${input.projectId} has already committed $${t.committed_usd.toFixed(4)} ` +
        `($${t.settled_usd.toFixed(4)} settled + $${t.reserved_usd.toFixed(4)} in flight) ` +
        `against a $${ceiling.usd.toFixed(2)} ceiling (source: ${ceiling.source}); ` +
        `this call would reach $${wouldBe.toFixed(4)}. ` +
        `Refusing. To proceed a human must raise the ceiling — set ` +
        `${CEILING_METADATA_KEY} in the project's storyboard.json metadata, or set ` +
        `${CEILING_ENV} in the environment. This refusal cannot be overridden from a tool call.`,
      estimate_usd: est.usd,
      basis: est.basis,
      ceiling_usd: ceiling.usd,
      ceiling_source: ceiling.source,
      committed_usd: t.committed_usd,
      remaining_usd: usd(Math.max(0, ceiling.usd - t.committed_usd)),
    };
  }

  // Check-and-insert in ONE statement, so the ceiling test and the reservation
  // cannot be separated.
  //
  // The read-then-insert this replaced was safe within a process — reserve() is
  // synchronous and JS is single-threaded — and unsafe across them. Nothing
  // stops two sidecars sharing a studio.db (three ran side by side during this
  // pipeline's own build), and two of them could each read a total under the
  // ceiling and each insert, landing over it. A money gate that holds only
  // while exactly one process is running is not a gate; it is a convention.
  //
  // SQLite evaluates the WHERE against the table at write time, so the sum is
  // taken under the same lock as the insert. `changes === 0` means the ceiling
  // moved underneath us — someone else reserved first — which is a refusal,
  // not an error.
  const entryId = randomUUID();
  const res = db.prepare(
    `INSERT INTO spend_ledger
       (entry_id, project_id, ref_id, kind, engine, model_id, estimate_usd, actual_usd, state, basis, created_at, settled_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, NULL
      WHERE (
        SELECT COALESCE(SUM(CASE WHEN state = 'settled'  THEN COALESCE(actual_usd, estimate_usd)
                                 WHEN state = 'reserved' THEN estimate_usd END), 0)
          FROM spend_ledger WHERE project_id = ? AND state != 'void'
      ) + ? <= ?`,
  ).run(
    entryId,
    input.projectId,
    input.refId ?? null,
    input.kind,
    input.engine,
    input.model_id ?? null,
    est.usd,
    est.basis,
    Date.now(),
    input.projectId,
    est.usd,
    ceiling.usd,
  );

  if (res.changes === 0) {
    const now = totals(db, input.projectId);
    return {
      ok: false,
      error: 'spend-ceiling-exceeded',
      message:
        `This ${input.kind} is estimated at $${est.usd.toFixed(4)} (${est.basis}). ` +
        `Project ${input.projectId} is at $${now.committed_usd.toFixed(4)} against a ` +
        `$${ceiling.usd.toFixed(2)} ceiling (source: ${ceiling.source}) — another writer ` +
        `reserved between this call's check and its insert. Refusing. ` +
        `Raising the ceiling is a human act (${CEILING_METADATA_KEY} in project metadata, ` +
        `or ${CEILING_ENV}); this refusal cannot be overridden from a tool call.`,
      estimate_usd: est.usd,
      basis: est.basis,
      ceiling_usd: ceiling.usd,
      ceiling_source: ceiling.source,
      committed_usd: now.committed_usd,
      remaining_usd: usd(Math.max(0, ceiling.usd - now.committed_usd)),
    };
  }

  return {
    ok: true,
    entryId,
    estimate_usd: est.usd,
    basis: est.basis,
    ceiling_usd: ceiling.usd,
    ceiling_source: ceiling.source,
    committed_usd: wouldBe,
    remaining_usd: usd(Math.max(0, ceiling.usd - wouldBe)),
  };
}

/**
 * Close out a reservation for work that ran.
 *
 * `actualUsd` is the provider's reported figure and is usually `undefined` —
 * in that case the row settles at its estimate rather than at zero (see
 * `totals`). Passing a real number reconciles the ledger to the invoice.
 */
export function settle(db: Db, entryId: string, actualUsd?: number): void {
  const actual = typeof actualUsd === 'number' && Number.isFinite(actualUsd) && actualUsd >= 0
    ? actualUsd
    : null;
  db.prepare(
    `UPDATE spend_ledger SET state = 'settled', actual_usd = ?, settled_at = ?
      WHERE entry_id = ? AND state = 'reserved'`,
  ).run(actual, Date.now(), entryId);
}

/**
 * Release a reservation for work that never billed — a failed, cancelled or
 * never-dispatched call. Only voids a row still in `reserved`, so a late void
 * can never un-count money that was actually spent.
 */
export function voidEntry(db: Db, entryId: string): void {
  db.prepare(
    `UPDATE spend_ledger SET state = 'void', settled_at = ? WHERE entry_id = ? AND state = 'reserved'`,
  ).run(Date.now(), entryId);
}

/**
 * Release every reservation attached to a ref (a render `record_id`).
 *
 * The by-ref sibling of `voidEntry`, for callers that hold the record id but
 * not the ledger entry id — notably cancelling a still-queued row, which never
 * reaches the drain loop and so never parses its own options blob. Same
 * `state = 'reserved'` guard, so it can't un-count settled money.
 */
export function voidByRef(db: Db, refId: string): number {
  const r = db
    .prepare(
      `UPDATE spend_ledger SET state = 'void', settled_at = ? WHERE ref_id = ? AND state = 'reserved'`,
    )
    .run(Date.now(), refId);
  return r.changes;
}

/**
 * Boot-time recovery. A sidecar that dies mid-render leaves `reserved` rows
 * for work that will be requeued (and re-reserved) on the next run — without
 * this they would double-count against the ceiling forever, and the gate
 * would slowly strangle a project through nothing but crashes.
 *
 * Called from `RenderRunner.recover()`, alongside the `running → queued` flip
 * it mirrors: same event, same reasoning, opposite direction.
 */
export function voidOrphanedReservations(db: Db): number {
  const r = db
    .prepare(
      `UPDATE spend_ledger SET state = 'void', settled_at = ?
        WHERE state = 'reserved'
          AND kind = 'render'
          AND ref_id IN (SELECT record_id FROM render_queue WHERE status IN ('queued','running'))`,
    )
    .run(Date.now());
  return r.changes;
}

export interface SpendStatus {
  // Index signature so this satisfies the sidecar's `GenericResult`
  // (Record<string, unknown>) at the RPC boundary without a cast.
  [k: string]: unknown;
  ok: true;
  projectId: string;
  ceiling_usd: number;
  ceiling_source: CeilingSource;
  settled_usd: number;
  reserved_usd: number;
  committed_usd: number;
  remaining_usd: number;
  entries: SpendLedgerRow[];
}

/** Read-only view for `spend.status` — what the ledger holds and what is left. */
export function status(
  db: Db,
  projectId: string,
  projectMetadata?: Record<string, unknown>,
  limit = 200,
): SpendStatus {
  const ceiling = resolveCeiling(projectMetadata);
  const t = totals(db, projectId);
  return {
    ok: true,
    projectId,
    ceiling_usd: ceiling.usd,
    ceiling_source: ceiling.source,
    settled_usd: t.settled_usd,
    reserved_usd: t.reserved_usd,
    committed_usd: t.committed_usd,
    remaining_usd: usd(Math.max(0, ceiling.usd - t.committed_usd)),
    entries: listLedger(db, projectId, limit),
  };
}
