/**
 * SQLite open + migrations for the render queue.
 *
 * Stored at `$IKENGA_PKG_DATA/studio.db` (falls back to
 * `~/.local/share/ikenga/studio/studio.db` when the env var is unset).
 *
 * Uses better-sqlite3 — synchronous, simple, ESM-friendly prebuilt
 * binaries. The sidecar is single-process and never multi-threads through
 * the queue, so the sync API is the right shape.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Imported lazily so typecheck doesn't require the native module to be
// installed (and so the build script can mark it external).
export type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

/**
 * Constructs a `Database` for a path. Defaults to `better-sqlite3`; tests may
 * inject an API-compatible driver so the *real* migration + PRAGMA path runs
 * on machines without a native-module toolchain.
 */
export type DbDriver = (dbPath: string) => Database;

export interface RenderQueueRow {
  record_id: string;
  project_id: string;
  cell_id: string;
  engine: string;
  options: string; // JSON
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  output_path: string | null;
  error: string | null;
  metadata: string; // JSON — {model_id, cost_actual, cost_estimate, seed, …} (H1)
  variant: string | null; // engine variant / model tag (H1)
}

/**
 * Export queue row (WP-07c, G-38). A *parallel* table to `render_queue`
 * rather than a `kind` column on the existing one — exports key on a
 * project (not a cell), carry a different options shape (music preset,
 * explicit cellIds/rung selection), and never resolve an engine. Keeping
 * them separate avoids overloading the render queue's cell-centric columns
 * and its single-cell drain semantics. The export runner drains this table
 * with the same serial model the render runner uses for `render_queue`.
 */
export interface ExportQueueRow {
  export_id: string;
  project_id: string;
  options: string; // JSON — { rung?, cellIds?, music_preset?, outputPath? }
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  output_path: string | null;
  error: string | null;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS render_queue (
     record_id   TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     cell_id     TEXT NOT NULL,
     engine      TEXT NOT NULL,
     options     TEXT NOT NULL,
     status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER,
     output_path TEXT,
     error       TEXT,
     metadata    TEXT DEFAULT '{}',
     variant     TEXT
   );
   CREATE INDEX IF NOT EXISTS render_queue_status_idx  ON render_queue(status);
   CREATE INDEX IF NOT EXISTS render_queue_project_idx ON render_queue(project_id);

   CREATE TABLE IF NOT EXISTS projects (
     project_id   TEXT PRIMARY KEY,
     path         TEXT NOT NULL UNIQUE,
     name         TEXT NOT NULL,
     last_opened  INTEGER NOT NULL,
     archetype_id TEXT,
     cell_count   INTEGER,
     aspect       TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS export_queue (
     export_id   TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     options     TEXT NOT NULL,
     status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER,
     output_path TEXT,
     error       TEXT
   );
   CREATE INDEX IF NOT EXISTS export_queue_status_idx  ON export_queue(status);
   CREATE INDEX IF NOT EXISTS export_queue_project_idx ON export_queue(project_id);`,
  // G-50 / WP-32 DoD 8 — open-project session state.
  //
  // Distinct from `projects`, which is a *recents* ledger (every project ever
  // opened, ordered by `last_opened`). This table answers a narrower question:
  // "which projects were still open when the sidecar last stopped, and do we
  // have a recorded trust grant for them?" `closed_at IS NULL` means the row
  // was never closed via `project.close` — i.e. the sidecar died or was killed
  // with the project mounted, so it is a reopen candidate.
  //
  // `trust_source` is deliberately stored alongside `trust_granted_at`: a grant
  // minted by `STUDIO_TRUST_STUB=1` must never read as a real user grant on a
  // later non-stub boot. See session.ts for the disposition rules.
  `CREATE TABLE IF NOT EXISTS project_session (
     project_id       TEXT PRIMARY KEY,
     path             TEXT NOT NULL,
     opened_at        INTEGER NOT NULL,
     closed_at        INTEGER,
     trust_granted_at INTEGER,
     trust_source     TEXT
   );
   CREATE UNIQUE INDEX IF NOT EXISTS project_session_path_idx ON project_session(path);
   CREATE INDEX IF NOT EXISTS project_session_open_idx ON project_session(closed_at);`,
  // WP-12 / Plan 16 D-b — the spend ledger behind the paid-render ceiling.
  //
  // A separate table rather than a column on `render_queue`, for two reasons.
  // First, not every paid call is a queued render: `anchor.generate` bills fal
  // for a still and never inserts a queue row at all, and it is exactly that
  // door the Round-3 experiments spent through. Second, the ledger's lifecycle
  // is its own — reserve at call time, settle or void at completion — and does
  // not match the queue row's, which has no state for "money committed but the
  // job hasn't started".
  //
  // `estimate_usd` is always populated; `actual_usd` is the provider's reported
  // figure and is usually NULL (fal rarely returns one), which is why every sum
  // over this table reads COALESCE(actual_usd, estimate_usd). See spend.ts.
  `CREATE TABLE IF NOT EXISTS spend_ledger (
     entry_id     TEXT PRIMARY KEY,
     project_id   TEXT NOT NULL,
     ref_id       TEXT,
     kind         TEXT NOT NULL CHECK (kind IN ('render','still')),
     engine       TEXT NOT NULL,
     model_id     TEXT,
     estimate_usd REAL NOT NULL,
     actual_usd   REAL,
     state        TEXT NOT NULL CHECK (state IN ('reserved','settled','void')),
     basis        TEXT,
     created_at   INTEGER NOT NULL,
     settled_at   INTEGER
   );
   CREATE INDEX IF NOT EXISTS spend_ledger_project_idx ON spend_ledger(project_id, state);
   CREATE INDEX IF NOT EXISTS spend_ledger_ref_idx     ON spend_ledger(ref_id);`,
];

export function resolvePkgDataDir(): string {
  const fromEnv = process.env.IKENGA_PKG_DATA;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Fallback: ~/.local/share/ikenga/studio
  return join(homedir(), '.local', 'share', 'ikenga', 'studio');
}

export function resolveDbPath(): string {
  return join(resolvePkgDataDir(), 'studio.db');
}

export async function openDb(dbPath?: string, driver?: DbDriver): Promise<Database> {
  const target = dbPath ?? resolveDbPath();
  const dir = dirname(target);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let db: Database;
  if (driver) {
    db = driver(target);
  } else {
    // Under Bun (the standard Ikenga runtime per ADR-010), use built-in bun:sqlite.
    // Falls back to better-sqlite3 only if running under standalone Node.
    if (typeof (globalThis as any).Bun !== 'undefined') {
      // @ts-ignore bun:sqlite is built into Bun at runtime
      const { Database: BunDb } = await import('bun:sqlite');
      db = new BunDb(target) as unknown as Database;
    } else {
      // Dynamic import so this module is typecheck-safe even before deps are installed.
      // The @ts-ignore is load-bearing, not decoration: better-sqlite3 was dropped
      // from package.json by the Bun migration (7e068a6), so without it `tsc` fails
      // with TS2307 on any machine where a transitive copy doesn't happen to be
      // present. Matches the bun:sqlite branch above, which already has one.
      // @ts-ignore better-sqlite3 is an optional Node-only fallback, not a declared dep
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import('better-sqlite3');
      const Ctor = mod.default ?? mod;
      db = new Ctor(target) as Database;
    }
  }
  // sane defaults
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const stmt of MIGRATIONS) {
    db.exec(stmt);
  }

  // H1 — render provenance columns (metadata + variant). Fresh DBs get them
  // from CREATE TABLE above; existing installs need an additive ALTER TABLE.
  // SQLite has no IF NOT EXISTS on ADD COLUMN, so guard via PRAGMA table_info.
  const renderCols = db.prepare(`PRAGMA table_info(render_queue)`).all() as Array<{ name: string }>;
  const renderColNames = new Set(renderCols.map((c) => c.name));
  if (!renderColNames.has('metadata')) {
    db.exec(`ALTER TABLE render_queue ADD COLUMN metadata TEXT DEFAULT '{}'`);
  }
  if (!renderColNames.has('variant')) {
    db.exec(`ALTER TABLE render_queue ADD COLUMN variant TEXT`);
  }

  // G-47 — recents-registry enrichment columns (archetype_id / cell_count /
  // aspect). Fresh DBs get them from CREATE TABLE above; existing installs
  // need an additive ALTER TABLE, same guard pattern as render_queue's.
  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  const projectColNames = new Set(projectCols.map((c) => c.name));
  if (!projectColNames.has('archetype_id')) {
    db.exec(`ALTER TABLE projects ADD COLUMN archetype_id TEXT`);
  }
  if (!projectColNames.has('cell_count')) {
    db.exec(`ALTER TABLE projects ADD COLUMN cell_count INTEGER`);
  }
  if (!projectColNames.has('aspect')) {
    db.exec(`ALTER TABLE projects ADD COLUMN aspect TEXT`);
  }

  return db;
}

/** For tests / debugging — returns the resolved DB path without opening it. */
export function describeDb(): { pkgDataDir: string; dbPath: string } {
  return { pkgDataDir: resolvePkgDataDir(), dbPath: resolveDbPath() };
}
