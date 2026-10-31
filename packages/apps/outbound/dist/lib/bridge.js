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

// ── pkg-specific bridge extension: com.ikenga.outbound (WP-19) ──────────────
// CONCATENATION FRAGMENT — appended verbatim after bridge.js (the core) by the
// vendor step. It relies on the core's module-scoped `app` binding and the
// `LOG_TAG` import at the top of the composed file; it is NOT a standalone
// module and must never be imported on its own. Keeps outbound's trusted-tier
// HTTP + approve-gate write surface working after the bridge core was shared.

/**
 * Trusted-tier outbound HTTP via the host's `host.fetch` verb (WP-04/WP-07).
 * The shell attaches the declared auth secret host-side (per the manifest
 * `capabilities.http.auth_secret` → `capabilities.secrets` → Stronghold vault)
 * and enforces the `permissions.net` URL allowlist; the secret is NEVER echoed
 * back in the response. `body` comes back as a STRING — callers JSON.parse it.
 *
 * req: { url, method?, headers?, body?, timeout? }
 * → { ok, status?, headers?, body?, truncated?, bytes?, reason? }
 *
 * Throws if the bridge isn't connected OR the host doesn't implement host.fetch
 * (old/untrusted shell) — callers MUST catch and fall back. We do NOT swallow
 * the error here so callers can distinguish "no host.fetch" from "no match".
 */
export async function hostFetch(req) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — host.fetch unavailable`);
  const res = await app.callServerTool({
    name: 'host.fetch',
    arguments: req,
  });
  const sc = res?.structuredContent;
  if (!sc) {
    throw new Error(res?.content?.[0]?.text ?? 'host.fetch returned no structuredContent');
  }
  return sc;
}

// ── Approve-gate verbs (host.paActions*) — the folded approve-gate write path. ──
// Strategy B (plans/outbound-pkg/01-plan.md §G-PAACTIONS): four thin verbs the
// shell wraps over the existing, tested `pa_actions_*` Rust commands, gated by
// the pkg declaring `capabilities.paActions === true`. The pkg never gets raw
// write access to pa_action_drafts — commit/event/wake/normalization stay
// shell-owned. Each verb operates on the pa_action_drafts row `id` (NOT a legacy
// table id) and resolves only when structuredContent.ok === true.

async function callPaAction(verb, args) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — host.paActions.${verb} unavailable`);
  const res = await app.callServerTool({
    name: `host.paActions.${verb}`,
    arguments: args,
  });
  const sc = res?.structuredContent;
  if (!sc || sc.ok !== true) {
    throw new Error(sc?.error ?? res?.content?.[0]?.text ?? `host.paActions.${verb} failed`);
  }
  return sc;
}

/** Commit an approved draft → worker sends it for real. */
export async function hostPaActionsCommit(draftId) {
  return callPaAction('commit', { draftId });
}

/** Reject a draft (will not send). */
export async function hostPaActionsReject(draftId) {
  return callPaAction('reject', { draftId });
}

/** Retry a failed draft (failed → committed; clears claim/error + wakes worker). */
export async function hostPaActionsRetry(draftId) {
  return callPaAction('retry', { draftId });
}

/** Edit-in-place: patch a draft's subject/body (writes edited_json, awaiting→edited). */
export async function hostPaActionsUpdate(draftId, patch) {
  return callPaAction('update', { draftId, patch });
}
