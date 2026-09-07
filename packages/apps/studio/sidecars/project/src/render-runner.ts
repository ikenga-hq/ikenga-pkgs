/**
 * Render queue EXECUTION (WP-03b).
 *
 * WP-03 created the `render_queue` SQLite table but nothing ran it. This
 * module is the worker: it resolves the engine (G23) + capability-checks
 * (G2) at enqueue, inserts a `queued` row, and an on-enqueue-triggered loop
 * dequeues → builds a `RenderContext` → calls `adapter.render` → persists
 * `running`/`done`/`failed`/`cancelled` transitions → emits `render/progress`
 * (forwarded from the adapter's `ctx.emit`) and `render/done`.
 *
 * Concurrency model: a single in-process worker drains the queue serially
 * (one render at a time). The sidecar is single-process and HF/Excalidraw
 * each saturate a Chrome + FFmpeg, so serial is the right P1 default and
 * keeps the queue semantics trivial. `kick()` is idempotent — calling it
 * while the worker is busy is a no-op; the worker re-checks the queue when
 * it finishes each job.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_RESOLUTION,
  rungDir,
  type AspectRatio,
  type Cell,
  type RenderRecord,
} from '@ikenga/studio-schema';

import {
  enqueue as dbEnqueue,
  insertExternalDone,
  listQueue,
  markDone,
  markStarted,
  mimeForPath,
  reapOrphanRenderPids,
} from './queue.js';
import type { RenderQueueRow } from './db.js';
import {
  emitRenderDone,
  emitRenderProgress,
  type EventWriter,
} from './events.js';
import {
  EngineResolutionError,
  getAdapter,
  resolveEngineWithRequest,
} from './registry.js';
import type { RenderContext, RenderOptions } from './renderers/types.js';
import { resolveFalModel } from './renderers/fal.js';
import {
  reserve as reserveSpend,
  settle as settleSpend,
  voidEntry as voidSpend,
  voidByRef as voidSpendByRef,
  voidOrphanedReservations,
} from './spend.js';

type Db = Parameters<typeof markStarted>[0];

/** Per-project context the runner needs to build a RenderContext + find cells. */
export interface ProjectLookup {
  /** Return the absolute project root for an open project, or undefined. */
  projectRoot(projectId: string): string | undefined;
  /** Return a cell by uid from the open project's in-memory document, or undefined. */
  cell(projectId: string, cellId: string): Cell | undefined;
  /** Project-default aspect ratio. */
  aspectRatio(projectId: string): AspectRatio | undefined;
  /** Project-default resolution (already derived from aspect when absent on disk). */
  resolution(projectId: string): { w: number; h: number } | undefined;
  /**
   * The open project document's `metadata` bag — the spend gate reads the
   * hand-authored `spend_ceiling_usd` out of it (WP-12). Optional so existing
   * lookups (the exporter's) keep type-checking without one; a missing
   * implementation just falls back to the built-in default ceiling.
   */
  projectMetadata?(projectId: string): Record<string, unknown> | undefined;
}

export interface RenderRunnerDeps {
  db: Db;
  lookup: ProjectLookup;
  writer: EventWriter;
}

export interface EnqueueOptions extends RenderOptions {
  engine?: string;
  range?: { start_ms?: number; end_ms?: number };
  /**
   * WP-12 — the `spend_ledger` reservation this render owns, when it is on a
   * metered engine. Written into the queue row's `options` blob at enqueue and
   * read back by `runOne` to settle (on success) or void (on failure/cancel).
   * Absent for free engines, which never reserve.
   */
  spend_entry_id?: string;
}

export type EnqueueResult =
  | { ok: true; recordId: string; engine: string; spend?: SpendDisclosure }
  | { ok: false; error: string; message?: string; spend?: SpendDisclosure };

/**
 * What a paid enqueue discloses about the ledger — returned on BOTH arms.
 *
 * On success it is the receipt ("this shot reserved $0.56; $18.20 left"); on a
 * `spend-ceiling-exceeded` refusal it is the evidence. Present only for
 * metered engines: a Blender or HyperFrames render costs nothing and gets no
 * ledger row, so it gets no disclosure either.
 */
export interface SpendDisclosure {
  estimate_usd: number;
  basis: string;
  ceiling_usd: number;
  ceiling_source: 'env' | 'project' | 'default';
  committed_usd: number;
  remaining_usd: number;
}

export interface IngestExternalOptions {
  /** Path to the mp4/png the filmmaker produced and dropped on disk. */
  filePath: string;
  /** Provenance engine, e.g. 'higgsfield' | 'flow' | 'manual'. */
  engine: string;
  model_id?: string;
  cost_actual?: number;
}

export type IngestExternalResult =
  | { ok: true; recordId: string; engine: string; outputPath: string; record: RenderRecord }
  | { ok: false; error: string; message?: string };

/** Cap on `listPosters`'s batch size — bounds the synchronous per-record
 *  disk reads a single RPC turn can do (Canvas grid batching, review §2.5). */
const MAX_LIST_POSTERS = 100;

/**
 * The runner owns the AbortControllers for in-flight renders so `cancel`
 * can abort the right one. Keyed by recordId.
 */
export class RenderRunner {
  private readonly db: Db;
  private readonly lookup: ProjectLookup;
  private readonly writer: EventWriter;
  private readonly controllers = new Map<string, AbortController>();
  private draining = false;

  constructor(deps: RenderRunnerDeps) {
    this.db = deps.db;
    this.lookup = deps.lookup;
    this.writer = deps.writer;
  }

  /**
   * Recover from a restart. Any `running` rows are stale — but a crash may have
   * left the previous sidecar's detached writer group still running, so we
   * SIGKILL those orphans FIRST (via the persisted PID registry) to guarantee
   * the requeued render can't race a survivor over the same output file. We
   * then flip `running → queued` but do NOT drain here: at boot no project is
   * open, so draining would resolve every row's projectRoot to `undefined`.
   * The requeued rows stay `queued` and resume when their owning project
   * reopens (the `open` handler kicks the runner). `nextQueued` already skips
   * closed-project rows, so the kick below is a safe no-op at boot and only
   * matters if a project happened to be open already.
   */
  recover(): void {
    reapOrphanRenderPids();
    // WP-12 — release reservations belonging to rows we are about to requeue.
    // Those rows will re-reserve when they run, so leaving the old entries
    // `reserved` would double-count them against the ceiling permanently: a
    // project could be strangled by nothing but a history of crashes. Must run
    // BEFORE the running → queued flip below, since it selects on the very
    // statuses that flip is about to rewrite.
    voidOrphanedReservations(this.db);
    const rows = listQueue(this.db);
    for (const row of rows) {
      if (row.status === 'running') {
        this.db
          .prepare(`UPDATE render_queue SET status = 'queued', started_at = NULL WHERE record_id = ?`)
          .run(row.record_id);
      }
    }
    this.kick();
  }

  /**
   * Shutdown hook: abort every in-flight render — killing the detached HF
   * process groups via `ctx.signal` → `killTree` — and wait, bounded by
   * `timeoutMs`, for the workers to settle before the process exits. Without
   * this a killed sidecar orphans the npx → chrome → ffmpeg trees.
   */
  async shutdown(timeoutMs = 2000): Promise<void> {
    for (const ctrl of this.controllers.values()) ctrl.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.controllers.size > 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }

  /**
   * G23 engine resolution + G2 capability gate, then insert a `queued` row.
   * Rejections happen HERE (at enqueue), mirroring WP-06's in-MCP shim — so a
   * 21:9-on-hyperframes render never reaches the worker.
   */
  enqueue(projectId: string, cellId: string, opts: EnqueueOptions = {}): EnqueueResult {
    const root = this.lookup.projectRoot(projectId);
    if (!root) {
      return { ok: false, error: 'project-not-open', message: `projectId ${projectId} is not open` };
    }
    const cell = this.lookup.cell(projectId, cellId);
    if (!cell) {
      return { ok: false, error: 'cell-not-found', message: `cell ${cellId} not found in ${projectId}` };
    }

    // G23 — resolve engine from content_path (honoring an explicit pick).
    let engine: string;
    try {
      engine = resolveEngineWithRequest(cell.content_path, opts.engine);
    } catch (e) {
      if (e instanceof EngineResolutionError) {
        return { ok: false, error: e.code, message: e.message };
      }
      return { ok: false, error: 'internal-error', message: (e as Error).message };
    }

    const adapter = getAdapter(engine);
    if (!adapter) {
      return { ok: false, error: 'unresolvable-engine', message: `no adapter for ${engine}` };
    }

    // G2 — capability gate against the resolved adapter.
    const aspect = opts.aspect_ratio;
    if (aspect && !adapter.capabilities.aspect_ratios.includes(aspect)) {
      return {
        ok: false,
        error: 'unsupported-aspect-ratio',
        message: `engine ${engine} does not support ${aspect}; supported: ${adapter.capabilities.aspect_ratios.join(',')}`,
      };
    }
    const durationMs =
      opts.range && typeof opts.range.end_ms === 'number'
        ? opts.range.end_ms - (opts.range.start_ms ?? 0)
        : undefined;
    if (
      durationMs != null &&
      adapter.capabilities.max_duration_ms != null &&
      durationMs > adapter.capabilities.max_duration_ms
    ) {
      return {
        ok: false,
        error: 'duration-exceeds-cap',
        message: `engine ${engine} caps at ${adapter.capabilities.max_duration_ms}ms; requested ${durationMs}ms`,
      };
    }

    const recordId = randomUUID();

    // WP-12 — the spend gate. Metered engines only: `requires_network` is the
    // same bit registry.ts uses for the auto-resolution consent guard, so a
    // future Veo/Runway/Kling adapter is covered here the day it is registered
    // without touching this call site.
    //
    // The gate runs at ENQUEUE, not in the drain loop, for the same reason the
    // G2 capability check does: a render that must not happen should never
    // become a queued row. It also means a 14-shot batch is priced as a batch —
    // shot 9 sees shots 1–8 already reserved and refuses, rather than all 14
    // sailing through because none of them has billed yet.
    let spend: SpendDisclosure | undefined;
    let spendEntryId: string | undefined;
    if (adapter.capabilities.requires_network) {
      const falResolved = engine === 'fal'
        ? resolveFalModel(cell, { variant: opts.variant })
        : { model: undefined as string | undefined, kind: 'video' as const };
      const reservation = reserveSpend(this.db, {
        projectId,
        refId: recordId,
        engine,
        // Priced against the same id the adapter will actually call, resolved
        // through fal's own override chain so the gate and the invoice agree.
        // `kind` matters as much as the model: an inpaint bills per megapixel
        // and a clip bills per video-second, so a still priced as video would
        // be wrong by an order of magnitude in either direction.
        model_id: falResolved.model,
        kind: falResolved.kind === 'still' ? 'still' : 'render',
        projectMetadata: this.lookup.projectMetadata?.(projectId),
        resolution: opts.resolution ?? this.lookup.resolution(projectId),
        durationMs: durationMs ?? cell.duration_ms,
      });
      spend = {
        estimate_usd: reservation.estimate_usd,
        basis: reservation.basis,
        ceiling_usd: reservation.ceiling_usd,
        ceiling_source: reservation.ceiling_source,
        committed_usd: reservation.committed_usd,
        remaining_usd: reservation.remaining_usd,
      };
      if (!reservation.ok) {
        // Terminal. No queue row is written, and there is no argument the
        // caller can change to get past this — raising the ceiling is a human
        // act (project metadata or STUDIO_SPEND_CEILING_USD).
        return { ok: false, error: reservation.error, message: reservation.message, spend };
      }
      spendEntryId = reservation.entryId;
    }

    dbEnqueue(this.db, {
      recordId,
      projectId,
      cellId,
      engine,
      options: {
        aspect_ratio: opts.aspect_ratio,
        resolution: opts.resolution,
        variant: opts.variant,
        range: opts.range,
        // Carried in the options blob so `runOne` can settle or void the
        // reservation without a second lookup keyed on record_id.
        spend_entry_id: spendEntryId,
      },
    });
    this.kick();
    return { ok: true, recordId, engine, spend };
  }

  status(recordId: string): { ok: true; record: RenderQueueRow } | { ok: false; error: string; message?: string } {
    const row = this.db
      .prepare(`SELECT * FROM render_queue WHERE record_id = ?`)
      .get(recordId) as RenderQueueRow | undefined;
    if (!row) return { ok: false, error: 'render-record-not-found', message: recordId };
    return { ok: true, record: row };
  }

  cancel(recordId: string): { ok: true } | { ok: false; error: string; message?: string } {
    const row = this.db
      .prepare(`SELECT * FROM render_queue WHERE record_id = ?`)
      .get(recordId) as RenderQueueRow | undefined;
    if (!row) return { ok: false, error: 'render-record-not-found', message: recordId };
    if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
      return { ok: false, error: 'render-cancel-failed', message: 'record already terminal' };
    }
    const ctrl = this.controllers.get(recordId);
    if (ctrl) {
      // Running — abort the adapter; the worker tags it cancelled on throw.
      ctrl.abort();
    } else {
      // Still queued — mark cancelled directly so the worker skips it.
      // Release its spend reservation too (WP-12): this row will never reach
      // `runOne`, so nothing else would ever give the budget back. Voiding by
      // `ref_id` rather than parsing the options blob keeps this path honest
      // even for a row whose options are malformed.
      voidSpendByRef(this.db, recordId);
      markDone(this.db, recordId, 'cancelled');
      this.emitDone(row, 'cancelled');
    }
    return { ok: true };
  }

  list(filter: { projectId?: string; status?: string } = {}): { ok: true; records: RenderQueueRow[] } {
    let rows = listQueue(this.db, filter.projectId);
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    return { ok: true, records: rows };
  }

  /**
   * Read a finished render's MP4 off disk and return it base64-encoded so the
   * UI iframe can preview it as a `blob:` URL. A `file://` path is unloadable
   * from a null-origin srcdoc pane (WebKitGTK) and the pkg-content HTTP route
   * only serves `dist/`, so bytes-over-the-bridge → Blob is the one seam that
   * plays real pixels+audio in-pane (playback-seam probe, Wave-2). Keyed on
   * the render record id (not an arbitrary path) so it can't read outside the
   * queue's own outputs.
   */
  readBytes(recordId: string):
    | { ok: true; base64: string; mime: string; sizeBytes: number; path: string }
    | { ok: false; error: string; message?: string } {
    const row = this.db
      .prepare(`SELECT * FROM render_queue WHERE record_id = ?`)
      .get(recordId) as RenderQueueRow | undefined;
    if (!row) return { ok: false, error: 'render-record-not-found', message: recordId };
    if (!row.output_path) return { ok: false, error: 'render-not-done', message: 'no output on disk yet' };
    if (!existsSync(row.output_path)) return { ok: false, error: 'render-output-missing', message: row.output_path };
    try {
      const buf = readFileSync(row.output_path);
      return {
        ok: true,
        base64: buf.toString('base64'),
        mime: mimeForPath(row.output_path),
        sizeBytes: buf.length,
        path: row.output_path,
      };
    } catch (e) {
      return { ok: false, error: 'render-read-failed', message: (e as Error).message };
    }
  }

  /**
   * Read a finished render's poster PNG off disk and return it base64-encoded,
   * mirroring readBytes. The poster is extracted by `extractPoster` when the
   * render finishes (a single frame written next to the mp4 as `.png`). Used by
   * the Canvas grid + Composition timeline to show real thumbnails via the same
   * bytes-over-bridge → blob: seam (file:// fails in srcdoc). Keyed on the
   * render record id so it can't read outside the queue's own outputs.
   */
  readPoster(recordId: string):
    | { ok: true; base64: string; mime: string; sizeBytes: number; path: string }
    | { ok: false; error: string; message?: string } {
    const row = this.db
      .prepare(`SELECT * FROM render_queue WHERE record_id = ?`)
      .get(recordId) as RenderQueueRow | undefined;
    if (!row) return { ok: false, error: 'render-record-not-found', message: recordId };
    if (!row.output_path) return { ok: false, error: 'render-not-done', message: 'no output on disk yet' };
    const posterPath = posterPathFor(row.output_path);
    if (!existsSync(posterPath)) return { ok: false, error: 'poster-not-found', message: posterPath };
    try {
      const buf = readFileSync(posterPath);
      return {
        ok: true,
        base64: buf.toString('base64'),
        mime: mimeForPath(posterPath),
        sizeBytes: buf.length,
        path: posterPath,
      };
    } catch (e) {
      return { ok: false, error: 'render-read-failed', message: (e as Error).message };
    }
  }

  /**
   * Batched poster read (review §2.5): the Canvas grid mounts one
   * `<CellPoster>` per tile, and each used to issue its own `readPoster`
   * round-trip — N done cells meant N concurrent base64-PNG calls. This
   * collapses them into one. Reuses `readPoster` per id rather than a
   * shared bulk query — posters are small PNGs, so N sync `readFileSync`
   * calls stay cheap even at `MAX_LIST_POSTERS`, and a record with no
   * poster (or an unreadable one) maps to `b64: null` instead of failing
   * the whole batch, mirroring `readPoster`'s own per-record honesty.
   * Silently truncates past the cap rather than erroring the batch — a
   * caller sending too many ids gets a partial answer, not a hard failure.
   */
  listPosters(recordIds: string[]): { ok: true; posters: Array<{ recordId: string; b64: string | null }> } {
    const posters = recordIds.slice(0, MAX_LIST_POSTERS).map((recordId) => {
      const r = this.readPoster(recordId);
      return { recordId, b64: r.ok ? r.base64 : null };
    });
    return { ok: true, posters };
  }

  /**
   * Attach a filmmaker's externally-produced clip to a cell as a done
   * RenderRecord (manual provenance — Track B, the return leg of the
   * `export.prompt_package` handoff). Copies the file into
   * `<rendersDir>/<engine>/<rungDir>/<cellUid>.<ext>` and writes a terminal
   * `done` row so `render.list` surfaces it exactly like a completed real
   * render for that project. The full RenderRecord (engine, model_id,
   * variant, cost_actual, output) is persisted in the row's `options` blob so
   * the manual provenance survives.
   */
  ingestExternal(projectId: string, cellId: string, opts: IngestExternalOptions): IngestExternalResult {
    const root = this.lookup.projectRoot(projectId);
    if (!root) {
      return { ok: false, error: 'project-not-open', message: `projectId ${projectId} is not open` };
    }
    const cell = this.lookup.cell(projectId, cellId);
    if (!cell) {
      return { ok: false, error: 'cell-not-found', message: `cell ${cellId} not found in ${projectId}` };
    }
    if (typeof opts.filePath !== 'string' || opts.filePath.trim().length === 0) {
      return { ok: false, error: 'invalid-args', message: 'filePath is required' };
    }
    if (typeof opts.engine !== 'string' || opts.engine.trim().length === 0) {
      return { ok: false, error: 'invalid-args', message: 'engine is required' };
    }
    const srcAbs = isAbsolute(opts.filePath) ? opts.filePath : resolve(root, opts.filePath);
    if (!existsSync(srcAbs)) {
      return { ok: false, error: 'source-not-found', message: srcAbs };
    }

    const ext = extname(srcAbs).toLowerCase() || '.mp4';
    const rendersDir = join(root, 'renders');
    const destDir = join(rendersDir, opts.engine, rungDir(cell.rung));
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    let destPath = join(destDir, `${cell.uid}${ext}`);
    if (existsSync(destPath)) {
      // Don't clobber a prior ingest for the same cell — suffix a short uuid.
      destPath = join(destDir, `${cell.uid}.${randomUUID().slice(0, 8)}${ext}`);
    }
    try {
      copyFileSync(srcAbs, destPath);
    } catch (e) {
      return { ok: false, error: 'ingest-copy-failed', message: (e as Error).message };
    }

    const recordId = randomUUID();
    const nowIso = new Date().toISOString();
    const mime = mimeForPath(destPath);
    const record: RenderRecord = {
      id: recordId,
      cell_uid: cell.uid,
      engine: opts.engine,
      model_id: opts.model_id,
      variant: 'default',
      status: 'done',
      output: { uri: destPath, mime },
      cost_actual: typeof opts.cost_actual === 'number' ? opts.cost_actual : undefined,
      started_at: nowIso,
      finished_at: nowIso,
      // H4 — provenance:'manual' so the Handoff/Ledger views label this as
      // an ingested clip, not a rendered one.
      metadata: { ingested: true, source_path: srcAbs, provenance: 'manual' },
    };

    insertExternalDone(this.db, {
      recordId,
      projectId,
      cellId,
      engine: opts.engine,
      outputPath: destPath,
      options: { ingested: true, record },
      metadata: JSON.stringify({
        model_id: opts.model_id,
        cost_actual: typeof opts.cost_actual === 'number' ? opts.cost_actual : undefined,
        provenance: 'manual',
        ingested: true,
        source_path: srcAbs,
      }),
      variant: record.variant,
    });

    // Surface the new record live so the Composition pane's render list
    // refreshes, mirroring the drain loop's terminal emit.
    emitRenderDone(this.writer, projectId, {
      recordId,
      cellId,
      engine: opts.engine,
      status: 'done',
      outputPath: destPath,
    });

    return { ok: true, recordId, engine: opts.engine, outputPath: destPath, record };
  }

  /** Kick the drain loop (idempotent). */
  kick(): void {
    if (this.draining) return;
    this.draining = true;
    // Defer to a microtask/tick so enqueue returns before work starts.
    void this.drain().finally(() => {
      this.draining = false;
      // Re-arm only if a RUNNABLE (open-project) row remains. A raw
      // `status = 'queued'` count would spin forever here: rows for closed
      // projects stay queued by design (they resume on reopen), so counting
      // them would re-kick a drain that immediately finds nothing to run.
      if (this.nextQueued()) this.kick();
    });
  }

  /**
   * Next queued row whose owning project is currently open. Rows for closed
   * projects are intentionally skipped (left `queued`) rather than drained and
   * failed — they resume when the project reopens (see `recover`).
   */
  private nextQueued(): RenderQueueRow | undefined {
    const rows = this.db
      .prepare(`SELECT * FROM render_queue WHERE status = 'queued' ORDER BY created_at ASC`)
      .all() as RenderQueueRow[];
    for (const row of rows) {
      if (this.lookup.projectRoot(row.project_id)) return row;
    }
    return undefined;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const row = this.nextQueued();
      if (!row) return;
      await this.runOne(row);
    }
  }

  private async runOne(row: RenderQueueRow): Promise<void> {
    // Parsed FIRST so every failure path below — including the two that bail
    // before an adapter or project is resolved — can release this row's spend
    // reservation (WP-12). A reservation that outlives its render is budget
    // held against work that will never bill.
    let opts: EnqueueOptions = {};
    try {
      opts = JSON.parse(row.options) as EnqueueOptions;
    } catch {
      opts = {};
    }
    /** Release this row's reservation, if it has one. Safe to call twice. */
    const releaseSpend = (): void => {
      if (opts.spend_entry_id) voidSpend(this.db, opts.spend_entry_id);
    };

    const adapter = getAdapter(row.engine);
    if (!adapter) {
      releaseSpend();
      markDone(this.db, row.record_id, 'failed', { error: `no adapter for ${row.engine}` });
      this.emitDone(row, 'failed', undefined, `no adapter for ${row.engine}`);
      return;
    }

    const root = this.lookup.projectRoot(row.project_id);
    const cell = this.lookup.cell(row.project_id, row.cell_id);
    if (!root || !cell) {
      releaseSpend();
      const msg = !root ? 'project not open' : `cell ${row.cell_id} not found`;
      markDone(this.db, row.record_id, 'failed', { error: msg });
      this.emitDone(row, 'failed', undefined, msg);
      return;
    }

    const aspect: AspectRatio = opts.aspect_ratio ?? this.lookup.aspectRatio(row.project_id) ?? '16:9';
    const resolution =
      opts.resolution ?? this.lookup.resolution(row.project_id) ?? DEFAULT_RESOLUTION[aspect];

    const cellDir = dirname(absContentPath(root, cell));
    const rendersDir = join(root, 'renders');
    if (!existsSync(rendersDir)) mkdirSync(rendersDir, { recursive: true });

    const controller = new AbortController();
    this.controllers.set(row.record_id, controller);

    const ctx: RenderContext = {
      projectRoot: root,
      cellDir,
      rendersDir,
      aspectRatio: aspect,
      resolution,
      // Env-based vault shim: network adapters (fal) resolve their key here.
      // For 'studio.fal' return process.env.FAL_KEY; else nothing. In-shell the
      // key is NOT read from launch env — the pkg supervisor resolves the
      // manifest secret (`fal_api_key`, env:"FAL_KEY") from Stronghold and
      // injects FAL_KEY into this process's env at spawn (F-9). Standalone/
      // headless, a launch-env FAL_KEY is the fallback. Either way this shim
      // just reads process.env.FAL_KEY.
      vault: { get: async (key: string) => (key === 'studio.fal' ? process.env.FAL_KEY : undefined) },
      emit: (event) => {
        // Forward the adapter's render.progress events onto the pkg event bus.
        const p = (event.payload ?? {}) as {
          recordId?: string;
          cellId?: string;
          engine?: string;
          progress?: number | null;
          frame?: number;
          message?: string;
        };
        emitRenderProgress(this.writer, row.project_id, {
          recordId: p.recordId ?? row.record_id,
          cellId: p.cellId ?? row.cell_id,
          engine: p.engine ?? row.engine,
          progress: typeof p.progress === 'number' ? p.progress : 0,
          frame: p.frame,
          // Thread the human-readable line through so a fal fallback
          // ("anchor upload failed; text-only") or queue log actually reaches
          // the UI, not just the record metadata.
          ...(p.message ? { message: p.message } : {}),
        });
      },
      signal: controller.signal,
    };

    markStarted(this.db, row.record_id);

    const renderOpts: RenderOptions = {
      aspect_ratio: opts.aspect_ratio,
      resolution: opts.resolution,
      variant: opts.variant,
    };

    try {
      const record = await adapter.render(cell, renderOpts, ctx);
      const outputPath = record.output?.uri;
      // H1 — serialize the full adapter provenance (model_id, cost, seed,
      // request_id, elapsed_ms, …) into the metadata column so the UI Ledger
      // surfaces real spend / model / seed instead of blanks.
      markDone(this.db, row.record_id, 'done', {
        outputPath,
        metadata: JSON.stringify({
          model_id: record.model_id,
          cost_actual: record.cost_actual,
          cost_estimate: record.cost_estimate,
          ...record.metadata,
        }),
        variant: record.variant,
      });
      // WP-12 — reconcile the reservation. `record.cost_actual` is usually
      // undefined (fal rarely reports a cost), in which case the entry settles
      // at its estimate rather than collapsing to zero — see spend.ts `totals`.
      if (opts.spend_entry_id) settleSpend(this.db, opts.spend_entry_id, record.cost_actual);
      this.emitDone(row, 'done', outputPath);
      // Best-effort poster extraction (Issue 3): write a single PNG frame next
      // to the mp4 so Canvas tiles + Composition clips can show a real
      // thumbnail without loading the full video. Never fails the render — a
      // missing poster just falls back to the status-text preview.
      if (outputPath) {
        try { await extractPoster(outputPath); } catch { /* best-effort */ }
      }
    } catch (e) {
      // WP-12 — a render that threw or was cancelled gives its reservation
      // back. Best-effort and deliberately unconditional across both branches:
      // the honest default for work that did not complete is that it did not
      // bill. A provider that charged for a failed job would show up as an
      // invoice/ledger gap, which is the right place to notice it — far better
      // than permanently holding budget for every failed experiment.
      releaseSpend();
      const cancelled = (e as Error & { cancelled?: boolean }).cancelled === true || controller.signal.aborted;
      if (cancelled) {
        markDone(this.db, row.record_id, 'cancelled');
        this.emitDone(row, 'cancelled');
      } else {
        const msg = (e as Error).message;
        markDone(this.db, row.record_id, 'failed', { error: msg });
        this.emitDone(row, 'failed', undefined, msg);
      }
    } finally {
      this.controllers.delete(row.record_id);
    }
  }

  private emitDone(
    row: RenderQueueRow,
    status: 'done' | 'failed' | 'cancelled',
    outputPath?: string,
    error?: string,
  ): void {
    emitRenderDone(this.writer, row.project_id, {
      recordId: row.record_id,
      cellId: row.cell_id,
      engine: row.engine,
      status,
      outputPath,
      error,
    });
  }
}

function absContentPath(projectRoot: string, cell: Cell): string {
  return isAbsolute(cell.content_path) ? cell.content_path : resolve(projectRoot, cell.content_path);
}

/** Compute the expected output path for a hyperframes/excalidraw render (for smoke assertions). */
export function expectedRenderPath(rendersDir: string, engine: string, cell: Cell): string {
  return join(rendersDir, engine, rungDir(cell.rung), `${cell.uid}.mp4`);
}

/** Poster path = same dir + basename as the mp4, with a `.png` extension. */
function posterPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return ext ? outputPath.slice(0, -ext.length) + '.png' : outputPath + '.png';
}

/**
 * Best-effort poster-frame extraction: spawn ffmpeg to grab one PNG frame from
 * the finished mp4 and write it next to the output (`.png`). Seeks ~0.5s in to
 * dodge a blank fade-in frame; if the clip is shorter ffmpeg still emits the
 * last available frame. NEVER throws — a failed extraction resolves silently
 * and the tile falls back to the status-text preview.
 */
function extractPoster(outputPath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const posterPath = posterPathFor(outputPath);
    const child = spawn(
      'ffmpeg',
      ['-y', '-ss', '0.5', '-i', outputPath, '-frames:v', '1', posterPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Drain both pipes — an unread stdout/stderr fills its ~64KB OS buffer on a
    // chatty ffmpeg and blocks the child forever (silent zombie).
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}
