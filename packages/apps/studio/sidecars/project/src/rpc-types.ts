/**
 * Per-method param + result shapes for the project sidecar's JSON-RPC
 * surface. Kept in a sibling file (NOT `types.ts`) because the renderer
 * adapter trait already owns `renderers/types.ts` (frozen by WP-05a).
 */

import type { Project } from '@ikenga/studio-schema';
import type { LastOpenEntry } from './session.js';
import type { RecentProject } from './recents.js';

export type ErrorCode =
  | 'trust-denied'
  | 'trust-unreachable'
  | 'project-not-found'
  | 'project-already-open'
  | 'invalid-path'
  | 'invalid-args'
  | 'internal-error';

export interface ProjectOpenParams {
  path: string;
}
export type ProjectOpenResult =
  | { ok: true; projectId: string; project: Project }
  | { ok: false; error: ErrorCode; message?: string };

export interface ProjectCloseParams {
  projectId: string;
}
export type ProjectCloseResult =
  | { ok: true }
  | { ok: false; error: ErrorCode; message?: string };

export type ProjectListParams = Record<string, never>;
export interface ProjectSummary {
  projectId: string;
  path: string;
  name: string;
  lastOpened: number;
  /** Whether the stored path still exists on disk (cheap fs.existsSync at
   *  list-time). The Launcher dims rows whose folder has moved/been deleted
   *  and withholds the Open affordance (audit: Recents hygiene). */
  exists: boolean;
}
export type ProjectListResult = { ok: true; projects: ProjectSummary[] };

/**
 * `project.recents` (G-47 / WP-13 gate closer) — the enriched recents ledger:
 * unlike `project.list`'s `ProjectSummary` (name/path/lastOpened only, dead
 * paths kept and flagged `exists:false`), each row also carries the cheap
 * fields recorded at open time (archetypeId/cellCount/aspect) and dead paths
 * are filtered OUT rather than flagged — see recents.ts.
 */
export interface ProjectRecentsParams {
  /** Cap on returned entries (default 20). */
  limit?: number;
}
export type ProjectRecentsResult = { ok: true; projects: RecentProject[] };

/**
 * `project.last_open` (G-50 / WP-32 DoD 8) — the open-project registry as it
 * stood when the sidecar last stopped, so a respawn can *offer* the reopen.
 *
 * Advisory only. Entries are not mounted; the caller reopens by calling
 * `project.open`, which re-runs the WP-04 trust gate. See session.ts.
 */
export interface ProjectLastOpenParams {
  /** Cap on returned entries (default 20). */
  limit?: number;
  /** When true, return only sessions still open at the previous exit. */
  openOnly?: boolean;
}
export type ProjectLastOpenResult = { ok: true; entries: LastOpenEntry[] };

export interface ProjectCreateParams {
  archetype_id: string;
  path: string;
  name: string;
}
export type ProjectCreateResult =
  | { ok: true; projectId: string; project: Project }
  | { ok: false; error: ErrorCode; message?: string };

export interface ProjectInfoParams {
  projectId: string;
}
export type ProjectInfoResult =
  | { ok: true; project: Project; openCells: number; queueDepth: number }
  | { ok: false; error: ErrorCode; message?: string };

/**
 * Generic envelope for the WP-03b method surface (storyboard / anchor /
 * asset / composition / archetype / render). Handlers return a plain
 * `Record<string, unknown>` that already carries `ok: true|false`; the
 * dispatcher writes it straight onto the JSON-RPC `result`.
 */
export type GenericResult = Record<string, unknown>;

/** Dispatch-table value type. */
export type RpcMethod =
  | 'project.open'
  | 'project.close'
  | 'project.list'
  | 'project.recents'
  | 'project.last_open'
  | 'project.create'
  | 'project.info'
  // storyboard.*
  | 'storyboard.read'
  | 'storyboard.read_cell'
  | 'storyboard.read_fountain'
  | 'storyboard.write_fountain'
  | 'storyboard.read_cell_content'
  | 'storyboard.write_cell'
  | 'storyboard.write_cell_content'
  | 'storyboard.create_cell'
  | 'storyboard.delete_cell'
  | 'storyboard.list_cells'
  | 'storyboard.upsert_beat'
  | 'storyboard.upsert_rung'
  | 'storyboard.set_approved'
  // storyboard.* (Plan 25 / D-25-5 — the sequence lane's one sanctioned write)
  | 'storyboard.reorder_cells'
  // canvas.* (Plan 25 / G-76 — authored layout in <root>/.studio/canvas.json)
  | 'canvas.read'
  | 'canvas.write'
  // breakdown.* (plans/studio/19 WP-3 — deterministic script→cells scaffold)
  | 'breakdown.run'
  // anchor.*
  | 'anchor.list'
  | 'anchor.create'
  | 'anchor.generate'
  | 'anchor.delete'
  // asset.*
  | 'asset.list'
  | 'asset.import'
  | 'asset.resolve'
  // composition.*
  | 'composition.preview'
  | 'composition.validate'
  // archetype.*
  | 'archetype.instantiate_into_project'
  // render.*
  | 'render.enqueue'
  | 'render.status'
  | 'render.cancel'
  | 'render.list'
  | 'render.list_engines'
  | 'render.read_bytes'
  | 'render.read_poster'
  | 'render.list_posters'
  | 'render.ingest_external'
  // spend.* (WP-12 / Plan 16 D-b) — read-only; there is deliberately no set_ceiling
  | 'spend.status'
  // export.* (WP-07c / G-38)
  | 'export.compose'
  | 'export.status'
  | 'export.list'
  | 'export.read_bytes'
  | 'export.check_bed'
  // export.* (Stage 4 / Track B — prompt handoff)
  | 'export.prompt_package'
  // export.* (Plan 24 / WP-23 — DaVinci Resolve & OTIO)
  | 'export.davinci_timeline';
