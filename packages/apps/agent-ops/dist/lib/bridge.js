// MCP Apps SDK bridge — the canonical iframe⇄host protocol Ikenga uses.
//
// SOURCE OF TRUTH (WP-19). This file is the single, byte-identical bridge core
// vendored into every no-build app pkg's dist/lib/bridge.js. The two per-pkg
// identifiers that used to be hand-edited into each copy — the source-id passed
// to host.sendToActiveSession and the short log tag in error/console strings —
// are now injected via the generated sibling `./pkg-id.js` (PKG_ID, LOG_TAG),
// which kills the copy-paste-id bug class (a `tasks`/`sales` id or `[sales]`
// tag left behind in the wrong pkg). Never hand-edit a vendored copy; edit here
// and re-run the pkg's `scripts/build.mjs`.
//
// Pattern from @modelcontextprotocol/ext-apps Quickstart + the shell's
// pkg-iframe-host.tsx implementation:
//   1. new App(...) — register handlers before connect
//   2. await app.connect() — runs ui/initialize handshake automatically
//   3. app.getHostContext() — read theme / styles / supabase / royaltiAuth
//   4. app.callServerTool({ name: 'host.<x>', arguments }) — invoke host tools
//      (shell intercepts `host.*` names in dispatchHostCall; everything else
//      proxies to pkg MCP servers if any).
//
// The host re-emits hostContext on theme change via onhostcontextchanged.

// Use the bundled `app-with-deps` build — the default entry pulls
// `zod/v4` as a peer-via-esm.sh and dependency resolution sometimes
// produces a Zod build missing `.custom()`. The bundled variant
// inlines its deps so it works regardless of esm.sh's resolver state.
// NOTE: we deliberately do NOT import the SDK's applyDocumentTheme /
// applyHostStyleVariables / applyHostFonts helpers. Theme is owned by app.js's
// parent-<html> mirror (the artifact pattern). applyDocumentTheme in particular
// clobbers our workspace `data-theme` (A/B/C) with 'light'|'dark', breaking the
// bundled @ikenga/tokens palette — so the bridge stays out of theming entirely.
import { App } from 'https://esm.sh/@modelcontextprotocol/ext-apps@1.7.1/app-with-deps';
import { PKG_ID, LOG_TAG } from './pkg-id.js';

let app = null;

export async function connectBridge({ name, version, onContextChange }) {
  app = new App({ name, version }, {
    // Capabilities the pkg advertises to the host. Keep minimal — declare only
    // what we actually use.
    tools: { listChanged: false },
  });

  app.onerror = (err) => console.error(`[${LOG_TAG}] bridge error`, err);
  // Theme is NOT applied here — app.js mirrors it from the parent <html>.
  // We still forward context so live activeFeature (side-menu) updates reach
  // the app; data flows through host.dbQuery/dbExec, not the context payload.
  app.onhostcontextchanged = (ctx) => {
    onContextChange?.(ctx);
  };
  app.onteardown = async () => ({});

  await app.connect();
  return app.getHostContext();
}

/** Navigate the focused shell pane (cross-pkg or in-pkg sub-route). */
export async function hostNavigate(path) {
  if (!app) throw new Error('bridge not connected');
  return app.callServerTool({
    name: 'host.navigate',
    arguments: { path },
  });
}

/** Open an external link via the host. */
export async function openLink(url) {
  if (!app) throw new Error('bridge not connected');
  return app.openLink({ url });
}

/** Publish the pkg's sidebar menu to the shell. PkgMode renders these items in
 *  the left side panel when this pkg's pane is focused (normal AppMode). Item
 *  clicks come back as hostContext changes via `royaltiSuite.activeFeature` —
 *  listen via onContextChange in connectBridge.
 *  items: [{ id, label, icon?, badge? }] */
export async function setMenu(items) {
  if (!app) throw new Error('bridge not connected');
  return app.callServerTool({
    name: 'host.pkg.setMenu',
    arguments: { items },
  });
}

/**
 * Seed a user turn into the shell's active Claude session. This is how the
 * Tasks pkg "creates" work: anon RLS only grants UPDATE of status/completed_at
 * (never INSERT), so a new task can't be written client-side. Instead we
 * dispatch a natural-language request to the agent, which creates the task via
 * its privileged path. Verb confirmed in shell/src/components/pkg/
 * pkg-iframe-host.tsx (`host.sendToActiveSession`).
 *
 *   prompt: string   — the instruction shown as the user turn
 *   source?: string  — provenance tag (defaults to the pkg id)
 */
export async function hostSendToActiveSession(prompt, source = PKG_ID) {
  if (!app) throw new Error('bridge not connected');
  return app.callServerTool({
    name: 'host.sendToActiveSession',
    arguments: { prompt, source },
  });
}

/**
 * Dispatch a structured PA action through the host. Kept as a thin alias for
 * forward-compat: if/when the shell exposes a dedicated `host.paActionsRun`
 * verb, point this at it. Today the shell does NOT expose that verb (only
 * host.navigate / host.sendToActiveSession / host.openSessionDialog /
 * host.pkg.setMenu exist), so the create path uses hostSendToActiveSession.
 */
export async function hostPaActionsRun(args) {
  if (!app) throw new Error('bridge not connected');
  return app.callServerTool({
    name: 'host.paActionsRun',
    arguments: args,
  });
}

/**
 * Read the local `ikenga.db` via the host's `host.dbQuery` verb (WP-04 read-swap).
 * SELECT/WITH only — the shell rejects writes and gates this on the pkg
 * declaring `capabilities.sqlite`. Returns the row array
 * (`structuredContent.rows`); throws on a closed/failed bridge so callers can
 * surface the error in the query layer. Requires a connected bridge — there is
 * no standalone fallback (reads no longer go through supabase-js).
 *
 *   sql:    string         — a single SELECT/WITH statement with `?` params
 *   params: SqlValue[]      — positional bind values
 */
export async function hostDbQuery(sql, params = []) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — db_query unavailable`);
  const res = await app.callServerTool({
    name: 'host.dbQuery',
    arguments: { sql, params },
  });
  const sc = res?.structuredContent;
  if (!sc || sc.ok !== true) {
    const err = new Error(sc?.error ?? res?.content?.[0]?.text ?? 'host.dbQuery failed');
    if (sc?.reason) err.reason = sc.reason;
    if (sc?.code) err.code = sc.code;
    throw err;
  }
  return Array.isArray(sc.rows) ? sc.rows : [];
}

export function setBridgeAppForTesting(mockApp) {
  app = mockApp;
}

/**
 * Write to the local `ikenga.db` via the host's `host.dbExec` verb (write-path WP).
 * INSERT/UPDATE/DELETE only — the shell rejects reads/DDL, gates on the pkg
 * declaring `capabilities.sqlite`, and scopes the target table to the pkg's
 * declared `permissions['sqlite.tables']`. Resolves on success; throws on a
 * closed/failed bridge so callers can surface the error in the mutation layer.
 *
 *   sql:    string         — a single INSERT/UPDATE/DELETE statement with `?` params
 *   params: SqlValue[]      — positional bind values
 */
export async function hostDbExec(sql, params = []) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — db_exec unavailable`);
  const res = await app.callServerTool({
    name: 'host.dbExec',
    arguments: { sql, params },
  });
  const sc = res?.structuredContent;
  if (!sc || sc.ok !== true) {
    throw new Error(sc?.error ?? res?.content?.[0]?.text ?? 'host.dbExec failed');
  }
}

/** Read the current hostContext snapshot. */
export function getContext() {
  return app?.getHostContext() ?? null;
}

/** Detect standalone-dev (no parent shell). */
export function isStandalone() {
  return typeof window !== 'undefined' && window.parent === window;
}

/**
 * Publish a key/value into the shell's iyke iframe-state registry, so
 * external agents can read "what's open in this pane" via
 * `iyke iframe-state` / `iyke state` instead of guessing from the DB.
 *
 * This is NOT the AppBridge wire: the shell's window-level iyke listener
 * (iframe-registry.ts) matches `{__iyke:true, kind:'state'}` postMessages by
 * source window for any registered iframe — pkg iframes are registered by the
 * host (pkg-iframe-host.tsx Step 1c). Fire-and-forget; no-ops standalone.
 */
export function publishIykeState(key, value) {
  if (isStandalone()) return;
  try {
    window.parent.postMessage({ __iyke: true, kind: 'state', payload: { key, value } }, '*');
  } catch {
    /* never let debug-surface publishing break the app */
  }
}

// ── pkg-specific bridge extension: com.ikenga.agent-ops (WP-19) ─────────────
// CONCATENATION FRAGMENT — appended verbatim after bridge.js (the core) by the
// vendor step. It relies on the core's module-scoped `app` binding and the
// `LOG_TAG` import at the top of the composed file; it is NOT a standalone
// module and must never be imported on its own. Keeps agent-ops' cron
// control-plane verbs (host.agentOps.*) working after the bridge core was shared.

/**
 * List all configured cron jobs + their runtime state via the shell's
 * host.agentOps.listJobs verb (WP-09 adds this host-side; we call it here).
 *
 * Returns the structuredContent payload directly:
 *   { ok: true,  daemon_up, daemon_pid, jobs: RawJob[] }
 * | { ok: false, error: string }
 *
 * Throws if the bridge is not connected (caller should handle).
 */
export async function hostAgentOpsListJobs() {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — agentOps.listJobs unavailable`);
  const res = await app.callServerTool({
    name: 'host.agentOps.listJobs',
    arguments: {},
  });
  const sc = res?.structuredContent;
  if (!sc) {
    throw new Error(res?.content?.[0]?.text ?? 'host.agentOps.listJobs returned no structuredContent');
  }
  // ok:false is a valid application-level response (daemon down, etc.); return it
  // so the query layer can handle gracefully rather than throwing.
  return sc;
}

/**
 * Trigger an immediate out-of-schedule run for a job via the shell's
 * host.agentOps.runNow verb (WP-09 host side, WP-12 wires the call).
 *
 * Returns the structuredContent payload directly:
 *   { ok: true,  status: 200, message: string }
 * | { ok: false, code: string, status: number, error: string }
 *
 * Throws if the bridge is not connected (caller should handle).
 *
 * @param {string} jobId
 */
export async function hostAgentOpsRunNow(jobId) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — agentOps.runNow unavailable`);
  const res = await app.callServerTool({
    name: 'host.agentOps.runNow',
    arguments: { jobId },
  });
  return res?.structuredContent ?? null;
}

/**
 * Enable or disable a job via the shell's host.agentOps.setEnabled verb
 * (WP-09 host side, WP-12 wires the call).
 *
 * Returns the structuredContent payload directly:
 *   { ok: true,  jobId: string, enabled: boolean }
 * | { ok: false, code: string, error: string }
 *
 * Throws if the bridge is not connected (caller should handle).
 *
 * @param {string} jobId
 * @param {boolean} enabled
 */
export async function hostAgentOpsSetEnabled(jobId, enabled) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — agentOps.setEnabled unavailable`);
  const res = await app.callServerTool({
    name: 'host.agentOps.setEnabled',
    arguments: { jobId, enabled },
  });
  return res?.structuredContent ?? null;
}

/**
 * Create or update a cron job via the shell's host.agentOps.upsertJob verb (WP-14).
 *
 * Sends a full AgentOpsJobInput; the shell writes the job definition to config
 * and notifies the daemon. Returns the structuredContent payload directly:
 *   { ok: true,  jobId: string, created: boolean }
 * | { ok: false, code: string, error: string }
 *
 * Throws if the bridge is not connected (caller should handle).
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   schedule: string,
 *   command: string,
 *   timezone?: string,
 *   enabled?: boolean,
 *   mode?: 'agent'|'script',
 *   model?: string,
 *   agent?: string,
 *   schedule_dialect?: '5f'|'6f',
 *   timeout_ms?: number,
 * }} AgentOpsJobInput
 *
 * @param {AgentOpsJobInput} job
 */
export async function hostAgentOpsUpsertJob(job) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — agentOps.upsertJob unavailable`);
  const res = await app.callServerTool({
    name: 'host.agentOps.upsertJob',
    arguments: { job },
  });
  return res?.structuredContent ?? null;
}

/**
 * Delete a cron job via the shell's host.agentOps.deleteJob verb (WP-14).
 *
 * Returns the structuredContent payload directly:
 *   { ok: true,  jobId: string }
 * | { ok: false, code: string, error: string }
 *
 * Throws if the bridge is not connected (caller should handle).
 *
 * @param {string} jobId
 */
export async function hostAgentOpsDeleteJob(jobId) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — agentOps.deleteJob unavailable`);
  const res = await app.callServerTool({
    name: 'host.agentOps.deleteJob',
    arguments: { jobId },
  });
  return res?.structuredContent ?? null;
}

/**
 * Tail the output of a currently-running (or recently-completed) job via the
 * shell's host.agentOps.tailRun verb (WP-13).
 *
 * Returns the structuredContent payload directly:
 *   { ok: true,  running: boolean, status: 'running'|'done'|null,
 *     startedAtMs: number|null, mode: 'agent'|'script'|null,
 *     chunk: string, nextOffset: number, eof: boolean }
 * | { ok: false, code: string, status: number|null, error: string }
 *
 * Returns null if the bridge is not connected (caller must guard).
 *
 * @param {string} jobId
 * @param {number} [offset]
 * @returns {Promise<object|null>}
 */
export async function hostAgentOpsTailRun(jobId, offset) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — agentOps.tailRun unavailable`);
  const res = await app.callServerTool({
    name: 'host.agentOps.tailRun',
    arguments: { jobId, offset },
  });
  return res?.structuredContent ?? null;
}
