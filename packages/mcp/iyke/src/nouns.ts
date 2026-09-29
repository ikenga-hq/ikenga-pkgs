// WP-21b — logic behind the Project / Ngwa noun tools.
//
// `iyke-cli`'s `src/cmd/{project,ngwa}.rs` implements the same noun set in
// Rust for the `iyke` binary; keep the two behaviorally identical
// (id-then-path project resolution, verbatim NgwaSnapshot, missing-route
// errors) so a CLI call and an MCP call read the same.

/**
 * The v16 rail's CoreMode set — `project | chi | ngwa | settings`.
 * `ACTIVITY_MODES` in `@ikenga/contract` still carries the pre-v16 names
 * because the shell's `/iyke/mode` endpoint accepts them for one
 * compatibility release; the MCP surface intentionally advertises only the
 * modes the v16 shell actually owns.
 */
export const V16_MODES = ['project', 'chi', 'ngwa', 'settings'] as const;
export type V16Mode = (typeof V16_MODES)[number];

/**
 * Bridge route for the unified equipment catalogue — the HTTP twin of
 * WP-14's `ngwa_snapshot` Tauri command. Pending WP-28: shells this MCP
 * server can reach today don't expose it, so every ngwa_* tool goes
 * through `ngwaSnapshot` which converts a bare 404 into an actionable
 * error instead of a confusing one.
 */
export const NGWA_SNAPSHOT_PATH = '/iyke/ngwa/snapshot';
/** Pending WP-28: the Explorer sidebar's section registry (G-STATE
 * `ExplorerSectionState[]`). */
export const EXPLORER_SECTIONS_PATH = '/iyke/explorer/sections';
/** Cold snapshot on a post-0065 database scans transcripts (~100 s per the
 * WP-14 rollout notes); the default 5 s GET timeout would abort mid-scan. */
export const NGWA_SNAPSHOT_TIMEOUT_MS = 130_000;

export function isRouteMissing(e: unknown): boolean {
  return e instanceof Error && e.message.includes('returned HTTP 404');
}

export function routeMissingError(path: string, what: string, e: unknown): Error {
  return new Error(
    `${path} is not exposed by this shell — ${what} is pending a WP-28 bridge ` +
      `route (WP-21b filed the gap as needs-decision). Underlying error: ` +
      `${e instanceof Error ? e.message : String(e)}`,
  );
}

// ── Project ──────────────────────────────────────────────────────────────

export interface ProjectListEntry {
  id: string;
  root_path?: string | null;
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Resolve a `switch <path>` argument to a project id: exact `id` match
 * first (so `switch default` works), then a `root_path` match after
 * separator/trailing-slash normalization, then a case-insensitive pass for
 * Windows callers. Errors list the candidates the caller could have meant.
 */
export function resolveProjectId(projects: ProjectListEntry[], target: string): string {
  if (projects.some((p) => p.id === target)) return target;

  const want = normalizePath(target);
  const byPath = projects.filter(
    (p) => typeof p.root_path === 'string' && normalizePath(p.root_path) === want,
  );
  if (byPath.length === 1) return byPath[0].id;
  if (byPath.length > 1) {
    throw new Error(
      `ambiguous project path ${JSON.stringify(target)} — matches ${byPath.length} projects; switch by id instead`,
    );
  }

  const lower = want.toLowerCase();
  const ci = projects.filter(
    (p) =>
      typeof p.root_path === 'string' &&
      normalizePath(p.root_path).toLowerCase() === lower,
  );
  if (ci.length === 1) return ci[0].id;
  if (ci.length > 1) {
    throw new Error(
      `ambiguous project path ${JSON.stringify(target)} — matches ${ci.length} projects; switch by id instead`,
    );
  }

  const candidates = projects
    .map((p) => `  ${p.id}  ${p.root_path ?? '-'}`)
    .join('\n');
  throw new Error(
    `no project with id or root_path matching ${JSON.stringify(target)}. Known projects:\n${candidates}`,
  );
}

// ── Ngwa ─────────────────────────────────────────────────────────────────

export interface NgwaScope {
  kind: 'personal' | 'project';
  project_id?: string;
}

export interface NgwaItem {
  id: string;
  kind: string;
  state: string;
  scope?: NgwaScope;
  [k: string]: unknown;
}

export interface NgwaSnapshot {
  items?: NgwaItem[];
  as_of_ms?: number;
  sources?: Record<string, { ok?: boolean; error?: string | null; count?: number }>;
}

/** Stable facet key for a NgwaScope — same `personal` / `project:<id>`
 * grouping the `/ngwa/scopes` surface renders. */
export function ngwaScopeKey(item: NgwaItem): string {
  if (item.scope?.kind === 'project') return `project:${item.scope.project_id ?? '?'}`;
  return 'personal';
}

export function findNgwaItem(snap: NgwaSnapshot, id: string): NgwaItem {
  const items = snap.items ?? [];
  const hit = items.find((i) => i.id === id);
  if (!hit) {
    throw new Error(
      `no ngwa item ${JSON.stringify(id)} in the snapshot (${items.length} items — iyke_ngwa_installed lists ids)`,
    );
  }
  return hit;
}
