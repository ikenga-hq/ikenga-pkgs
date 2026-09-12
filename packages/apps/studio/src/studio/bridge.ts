// com.ikenga.studio · iframe ↔ host bridge
//
// One module, two surfaces:
//
//  1. The MCP Apps SDK (`@modelcontextprotocol/ext-apps`) — the canonical
//     iframe⇄host protocol the shell speaks (see shell/src/components/pkg/
//     pkg-iframe-host.tsx). After `connectBridge()` resolves, the host has
//     handed us a `hostContext` with theme, CSS variables, royaltiAuth, an
//     optional supabase config block, and a royaltiSuite namespace for shell
//     state. We call back into the host via `app.callServerTool({ name:
//     'host.*', ... })`; the shell's `dispatchHostCall` resolves names that
//     start with `host.` directly.
//
//  2. The iyke postMessage channel (`{ __iyke: true, kind: 'state', ... }`)
//     — orthogonal to MCP. The shell-side `iframe-bridge.ts` listens for
//     state envelopes so the `iyke iframe-state <pane>` CLI (and any
//     observing agent) can read the iframe's published 4-value snapshot
//     without crossing the MCP bus. Cheap, fire-and-forget, no awaiting
//     replies. WP-07's shared store calls `publishStudioState` from every
//     setter (see commit 3).
//
// Both surfaces are gracefully degraded in standalone-dev mode (no parent
// window): `connectBridge()` resolves with `mode: 'standalone'` and every
// helper becomes a no-op or returns mocked values. This is what lets
// `pnpm dev` boot the iframe in a plain browser tab without a shell.

// NOTE: the ext-apps theme helpers (applyDocumentTheme / applyHostStyleVariables
// / applyHostFonts) are intentionally NOT imported. Studio owns its theme via
// the parent-mirror in theme.ts; applyDocumentTheme wrote data-theme='light'|
// 'dark' and clobbered the Dusk Wood palette (Wave 0 root-cause fix).
import { App, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { ErrorCode, LoggingMessageNotificationSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { StudioEventName, StudioEventPayloadMap } from './mcp-types';

// ─── Host-context contract ────────────────────────────────────────────────
//
// Mirrors shell/src/lib/pkg/host-context.ts. Kept in this file (not @ikenga/
// contract) until the WP-08 manifest authoring lands — at which point the
// canonical type should move there and this file should re-export. Tracked
// as a follow-up in 10-wp07-iframe.md commit 16's swap line item.

export interface HostSupabaseConfig {
  url: string;
  anonKey: string;
}

export interface RoyaltiAuth {
  token: string;
  pkg_id: string;
  /** Current user's Supabase access token; null when signed out. */
  supabaseJwt: string | null;
}

export interface RoyaltiSuiteContext {
  /** Last shell-sidebar selection — pkgs that publish menus should route off
   *  this rather than their own internal selection state. Undefined means the
   *  iframe picks its own default (used for first-mount). */
  activeFeature?: string;
}

/** The shape we actually read off the MCP `hostContext` passthrough. The MCP
 *  spec types `McpUiHostContext` as `[key: string]: unknown`, so all Royalti
 *  namespaces (`royaltiAuth`, `supabase`, `royaltiSuite`) are technically
 *  optional from the SDK's standpoint. */
export type StudioHostContext = McpUiHostContext & {
  royaltiAuth?: RoyaltiAuth;
  supabase?: HostSupabaseConfig;
  royaltiSuite?: RoyaltiSuiteContext;
};

// ─── The 4-value publish payload ──────────────────────────────────────────
//
// Authoritative shape for the iyke channel — the shared store (commit 3)
// will call publishStudioState() with exactly this snapshot on every change.
// `cellUid: null` and `playheadMs: 0` are the empty-project defaults.

export interface StudioPublishedState {
  cellUid: string | null;
  playheadMs: number;
  hoverBeat: string | null;
  engineMode: 'hf' | 'remotion';
}

// ─── Connection lifecycle ─────────────────────────────────────────────────

export interface BridgeConnection {
  /** 'shell' when running inside an Ikenga pane; 'standalone' when running
   *  in a plain browser tab (no parent). Caller branches off this rather
   *  than re-checking `window.parent === window` everywhere. */
  mode: 'shell' | 'standalone';
  /** Initial host context. `undefined` in standalone mode. */
  hostContext: StudioHostContext | undefined;
}

let _app: App | null = null;
let _connection: BridgeConnection | null = null;
let _connectionPromise: Promise<BridgeConnection> | null = null;
let _contextListeners = new Set<(ctx: StudioHostContext) => void>();

/** True when there is no parent window — the iframe is being run standalone
 *  via `pnpm dev` rather than embedded in a shell pane. The MCP handshake
 *  would hang forever in this case, so we skip it. */
export function isStandalone(): boolean {
  return typeof window === 'undefined' || window.parent === window;
}

/** Connect to the host and resolve once the initial context handshake is
 *  complete. Idempotent — a second call returns the same promise. */
export function connectBridge(opts: {
  name?: string;
  version?: string;
} = {}): Promise<BridgeConnection> {
  if (_connectionPromise) return _connectionPromise;

  if (isStandalone()) {
    const connection: BridgeConnection = { mode: 'standalone', hostContext: undefined };
    _connection = connection;
    _connectionPromise = Promise.resolve(connection);
    return _connectionPromise;
  }

  const name = opts.name ?? '@ikenga/studio';
  const version = opts.version ?? '0.1.0';

  _connectionPromise = (async () => {
    const app = new App({ name, version }, {
      // Studio publishes no MCP tools of its own at P1 — the host-tool
      // surface (`host.navigate`, `host.openFolder`, etc.) is invoked via
      // `callServerTool`, not provided by us.
      tools: { listChanged: false },
    });

    app.onerror = (err: unknown) => {
      // Never throw out of the iframe boot — log and let the App stay up
      // so the user at least sees the placeholder rather than a blank pane.
      // eslint-disable-next-line no-console
      console.error('[studio] bridge error', err);
    };

    app.onhostcontextchanged = (ctx: McpUiHostContext) => {
      const typed = ctx as StudioHostContext;
      // Theme is NOT applied here anymore (theme.ts owns it via parent-mirror);
      // we only fan out activeFeature / supabaseJwt / etc. to view listeners.
      for (const fn of _contextListeners) fn(typed);
    };

    app.onteardown = async () => ({});

    // Host→iframe pkg-event relay (S7). The shell's Rust supervisor forwards
    // every `notifications/message` (logging/message) frame our long-lived MCP
    // server streams — the sidecar tunnels render/progress + render/done through
    // that path (mcp/src/index.ts → server.sendLoggingMessage). Register the
    // handler BEFORE connect so no early frame is missed. The params are the
    // server's original logging params (`{ level, logger, data }`) where `data`
    // is the sidecar's `{ topic, projectId, payload, ts }` event envelope.
    app.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      dispatchIncomingLoggingNotification(n.params);
    });

    await app.connect();
    const ctx = app.getHostContext() as StudioHostContext | undefined;

    _app = app;
    const connection: BridgeConnection = { mode: 'shell', hostContext: ctx };
    _connection = connection;
    return connection;
  })();

  return _connectionPromise;
}

/** Subscribe to hostContext changes (theme flips, royaltiSuite.activeFeature
 *  swaps, supabaseJwt refresh). Returns an unsubscribe fn. */
export function onHostContextChange(fn: (ctx: StudioHostContext) => void): () => void {
  _contextListeners.add(fn);
  return () => _contextListeners.delete(fn);
}

/** Synchronous read of the most recent hostContext. `undefined` before
 *  `connectBridge()` resolves and in standalone mode. */
export function getHostContext(): StudioHostContext | undefined {
  return _connection?.hostContext ?? undefined;
}

// ─── Host→iframe pkg-event relay ───────────────────────────────────────────
//
// The shell relays our MCP server's outbound `logging/message` frames back into
// this iframe (see the `setNotificationHandler` wiring in connectBridge). Each
// frame carries the sidecar's event envelope; we demultiplex by topic and fan
// out to typed subscribers. `real-mcp.ts`'s `subscribe()` delegates here, so a
// view calling `client.subscribe('render/done', …)` receives a live push the
// moment the render finishes — no polling round-trip. In standalone dev (no
// parent window) no frames ever arrive, so subscribers simply never fire and
// the views' poll fallback is the only signal, exactly as before.

const STUDIO_TOPIC_PREFIX = 'pkg://com.ikenga.studio/';

type StudioEventHandler = (payload: StudioEventPayloadMap[StudioEventName]) => void;
const _studioEventListeners = new Map<StudioEventName, Set<StudioEventHandler>>();

/** Subscribe to a relayed pkg event. Returns an unsubscribe fn. */
export function subscribeStudioEvent<E extends StudioEventName>(
  event: E,
  handler: (payload: StudioEventPayloadMap[E]) => void,
): () => void {
  let set = _studioEventListeners.get(event);
  if (!set) {
    set = new Set();
    _studioEventListeners.set(event, set);
  }
  set.add(handler as StudioEventHandler);
  return () => {
    _studioEventListeners.get(event)?.delete(handler as StudioEventHandler);
  };
}

function fanOutStudioEvent<E extends StudioEventName>(
  event: E,
  payload: StudioEventPayloadMap[E],
): void {
  const set = _studioEventListeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[studio] studio-event handler threw for ${event}`, err);
    }
  }
}

/** Translate one incoming `logging/message` frame into a typed studio event and
 *  fan it out. `params` is the MCP logging params (`{ level, logger, data }`);
 *  `data` is the sidecar's `{ topic, projectId, payload, ts }` envelope. Field
 *  names cross the camelCase (sidecar) → snake_case (studio type) boundary here.
 */
function dispatchIncomingLoggingNotification(params: unknown): void {
  const data = (params as { data?: unknown } | undefined)?.data as
    | { topic?: unknown; projectId?: unknown; payload?: unknown }
    | undefined;
  if (!data || typeof data.topic !== 'string') return;
  if (!data.topic.startsWith(STUDIO_TOPIC_PREFIX)) return;
  const name = data.topic.slice(STUDIO_TOPIC_PREFIX.length) as StudioEventName;
  const p = (data.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

  switch (name) {
    case 'cells/changed':
      fanOutStudioEvent('cells/changed', {
        project_id: str(data.projectId),
        changed_uids: p.cellId != null ? [str(p.cellId)] : [],
      });
      break;
    case 'render/progress':
      fanOutStudioEvent('render/progress', {
        record_id: str(p.recordId),
        cell_uid: str(p.cellId),
        frame: typeof p.progress === 'number' ? p.progress : 0,
      });
      break;
    case 'render/done':
      fanOutStudioEvent('render/done', {
        record_id: str(p.recordId),
        cell_uid: str(p.cellId),
        output_uri: str(p.outputPath),
      });
      break;
    default:
      // Unknown topic under our namespace — ignore (forward-compat).
      break;
  }
}

// ─── Lazy Supabase getter ─────────────────────────────────────────────────
//
// Per workspace CLAUDE.md "Supabase capability" rule: the iframe must not
// run `createClient()` at module-eval, because `hostContext.supabase` is
// resolved from the shell's Stronghold vault and threaded through an async
// handshake. Views that need Supabase call `await getSupabase()` lazily;
// the first call awaits the connect promise, subsequent calls reuse the
// same client. In standalone mode the getter throws — pkgs that need a
// real backend should hand-author a dev token via env (the launcher will
// surface that path in commit 11).
//
// As of 2026-07-16 no view under src/studio calls this (grep for
// `getSupabase(` turns up only this definition), and manifest.json
// deliberately carries no `capabilities.supabase` / `permissions
// ["supabase.tables"]` block — the shell has nothing to thread into
// hostContext.supabase, so this would throw for every real caller today.
// Do NOT add the capability speculatively for dead code (that would make
// the shell resolve + vault-expose Supabase keys nobody reads). The first
// view that actually needs Supabase must add capabilities.supabase (with
// the specific tables it touches) to manifest.json in the same change
// that adds its call site — the error below exists to make that ordering
// unmissable rather than fail silently.

let _supabasePromise: Promise<SupabaseClient> | null = null;

export function getSupabase(): Promise<SupabaseClient> {
  if (!_supabasePromise) {
    _supabasePromise = connectBridge().then((conn) => {
      if (conn.mode === 'standalone') {
        throw new Error(
          '[studio] Supabase is unavailable in standalone dev. Run inside the shell, or '
          + 'supply a dev token (the launcher exposes this path in WP-07 commit 11).',
        );
      }
      const sb = conn.hostContext?.supabase;
      if (!sb) {
        throw new Error(
          '[studio] hostContext.supabase missing — this pkg\'s manifest.json has no '
          + '`capabilities.supabase` block, so the shell never resolved or threaded '
          + 'Supabase config. Add `capabilities.supabase` plus the specific '
          + '`permissions["supabase.tables"]` this call touches to manifest.json '
          + 'BEFORE calling getSupabase() from a real view.',
        );
      }
      return createClient(sb.url, sb.anonKey, {
        auth: {
          // The pkg-side client never owns the session; the shell threads the
          // user's JWT via hostContext.royaltiAuth.supabaseJwt. Persisting in
          // localStorage here would race with the shell on token refresh.
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    });
  }
  return _supabasePromise;
}

/** Read the per-iframe auth token (used by views that authenticate to
 *  pkg-owned sidecars over the host bus). `null` before connect / in
 *  standalone. */
export function getRoyaltiAuth(): RoyaltiAuth | null {
  return _connection?.hostContext?.royaltiAuth ?? null;
}

// ─── Host-tool calls ──────────────────────────────────────────────────────
//
// Thin typed wrappers around `app.callServerTool({ name: 'host.*', ... })`.
// Names match the host's `dispatchHostCall` (shell/src/components/pkg/
// pkg-iframe-host.tsx). All return the raw tool-call result; callers narrow.

interface HostCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Subset of the MCP-apps SDK's `RequestOptions` a caller may want to override
 *  per-call. `timeout` replaces the SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s);
 *  `maxTotalTimeout` is a hard ceiling even when progress notifications reset
 *  the rolling timeout (not used by any host.* call today, but accepted for
 *  parity with the SDK's own option shape).
 *
 *  `signal` lets a caller abandon a long user-paced call (see
 *  {@link openFolder}) instead of sitting on the promise until the ceiling
 *  expires. Two things about it are load-bearing and easy to get wrong:
 *
 *   1. Aborting is **client-side only**. `Protocol.request`'s abort path
 *      deletes the response handler and sends `notifications/cancelled`; the
 *      shell's in-flight work (`openDialog`, `pkg_studio_request_project_
 *      access`) is not abortable, so a native dialog already on screen STAYS
 *      on screen and a grant the user then confirms is still written.
 *   2. The rejection is **indistinguishable from a real timeout by code**:
 *      the SDK wraps a non-`McpError` abort reason in
 *      `McpError(ErrorCode.RequestTimeout, String(reason))`, so
 *      {@link isHostCallTimeout} answers `true` for a user cancel too. A
 *      caller that offers a cancel affordance must remember that it cancelled
 *      (a ref/flag checked before the timeout branch) rather than trying to
 *      recover the intent from the error. */
export interface HostCallOptions {
  timeout?: number;
  maxTotalTimeout?: number;
  signal?: AbortSignal;
}

async function callHostTool(
  name: string,
  args: Record<string, unknown> = {},
  options?: HostCallOptions,
): Promise<HostCallResult> {
  if (!_app) {
    throw new Error(`[studio] callHostTool(${name}) before connectBridge() resolved`);
  }
  // The MCP App's callServerTool returns the spec's CallToolResult shape;
  // we narrow to HostCallResult since that's the contract the shell-side
  // dispatchHostCall honours (text + optional structuredContent + isError).
  return (await _app.callServerTool({ name, arguments: args }, options)) as HostCallResult;
}

/** True when `e` is the MCP-apps SDK's own request-timeout rejection (the
 *  `App.callServerTool` promise rejects with `McpError(ErrorCode.RequestTimeout,
 *  …)` when the host doesn't answer within the call's timeout — see
 *  `HostCallOptions.timeout` / `DEFAULT_REQUEST_TIMEOUT_MSEC` in the SDK).
 *
 *  What this is for: telling "the host never answered" apart from "the host
 *  answered with a failure", so the caller can say something TRUE about the
 *  state the user is in — for `host.openFolder`, that the picker/grant dialog
 *  is probably still open and a grant they already confirmed was still
 *  written host-side (WP-04 live round:
 *  `plans/studio/verify/2026-09-12-wp32-live/wp04/verdict.md` "Live-found
 *  gap"). It is explicitly NOT a recovery seam: the timed-out response is the
 *  only carrier of the picked path, and nothing on the host side of
 *  `host.openFolder` writes the project registry (no `project.open`; see
 *  shell `dispatchHostCall`'s `host.openFolder` branch, which only does
 *  `openDialog` + `pkg_studio_request_project_access`), so after a timeout the
 *  iframe genuinely does not know which folder was picked and must not guess.
 *
 *  Also note (see `HostCallOptions.signal`) that a caller-initiated abort
 *  rejects with this same code — a `true` here means "no answer", not
 *  necessarily "the deadline expired".
 *
 *  Reads `.code` off an `McpError` instance, and falls back to a duck-typed
 *  `.code` check on any other object so this still answers correctly if a
 *  bundler duplicates the McpError class across module instances. */
export function isHostCallTimeout(e: unknown): boolean {
  if (e instanceof McpError) return e.code === ErrorCode.RequestTimeout;
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === ErrorCode.RequestTimeout;
}

/** Invoke one of the pkg's OWN MCP-server tools (e.g. 'archetype.list',
 *  'storyboard.read', 'render.enqueue'). Same `callServerTool` wire as
 *  `callHostTool`, but the name does NOT start with `host.` — so the shell's
 *  `oncalltool` router falls through to `pkg_mcp_call`, which forwards the
 *  call to this pkg's long-lived `studio` MCP server (mcp/dist/index.js).
 *  Returns the raw MCP `CallToolResult`; the real MCP client (mcp-client.ts)
 *  parses `content[0].text` and reshapes it to the UI types. Throws in
 *  standalone/pre-connect (no `_app`) — the real client is only selected
 *  when a shell bridge is present, so that never fires in practice. */
export function callPkgTool(name: string, args: Record<string, unknown> = {}): Promise<HostCallResult> {
  return callHostTool(name, args);
}

/** True once the MCP App handshake has completed and the pkg can reach its
 *  own MCP server via `callPkgTool`. Distinct from `isStandalone()` (which is
 *  a synchronous window-parent probe): this is only true AFTER connectBridge()
 *  resolved in shell mode. The MCP-client factory uses it to decide real vs
 *  mock at call time. */
export function isBridgeConnected(): boolean {
  return _app !== null && _connection?.mode === 'shell';
}

/** Cross-pkg or in-pkg sub-route navigation. The shell routes this through
 *  pane-store + TanStack Router. */
export function hostNavigate(path: string): Promise<HostCallResult> {
  return callHostTool('host.navigate', { path });
}

/** Open an external link via the host (Tauri opens it in the default
 *  browser, not a child webview). */
export function openLink(url: string): Promise<HostCallResult> {
  return callHostTool('host.openLink', { url });
}

/** `host.openFolder` pops the OS folder picker, then (WP-04) the shell's native
 *  per-folder grant dialog — both are user-paced, not host-paced. The SDK's
 *  default request timeout (60s, `DEFAULT_REQUEST_TIMEOUT_MSEC`) is sized for
 *  host-side work, not "wait for a human to click through two native dialogs";
 *  a slow user hits it even though the host finishes the grant write correctly
 *  (verdict: `plans/studio/verify/2026-09-12-wp32-live/wp04/verdict.md` "Live-
 *  found gap"). Give this ONE call a ceiling generous enough that only an
 *  actually-stuck host trips it — nothing else calls callHostTool with a
 *  custom timeout, so this doesn't loosen anything else's contract.
 *
 *  A ceiling this long is only honest if the UI says it is waiting and offers
 *  a way out: the caller MUST render a visible waiting state for the whole
 *  await and pass a `signal` it can abort (the Launcher's open-folder banner
 *  does both). Without that, a dialog the user never answers leaves the
 *  calling surface inert for ten minutes with no explanation. */
const OPEN_FOLDER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Trust-gate seam for the Launcher's "Open folder…" affordance (10-wp07-
 *  iframe.md commit 11 — "calls host.openFolder()"). Same shape as every
 *  other `host.*` call: routed through the shell's `dispatchHostCall`. The
 *  shell side of the per-folder trust gate (Tauri `pkg_studio_request_
 *  project_access`, WP-04) isn't wired yet — in standalone/dev this call
 *  simply rejects (no `_app`) or the shell responds `isError` until the real
 *  command lands; the Launcher's own dialog is the mocked trust-gate UX for
 *  now (launcher.md §"API"). See {@link isHostCallTimeout} for how a caller
 *  should react if this still times out, and `HostCallOptions.signal` for what
 *  `signal` does and does not cancel (client side only — a native dialog
 *  already on screen stays there, and a grant confirmed after the abort is
 *  still written host-side). */
export function openFolder(options?: { signal?: AbortSignal }): Promise<HostCallResult> {
  return callHostTool(
    'host.openFolder',
    {},
    {
      timeout: OPEN_FOLDER_TIMEOUT_MS,
      maxTotalTimeout: OPEN_FOLDER_TIMEOUT_MS,
      signal: options?.signal,
    },
  );
}

/** Result of {@link sendToChi}. Mirrors the shell's `host.sendToActiveSession`
 *  structured payload 1:1 (shell/src/components/pkg/pkg-iframe-host.tsx) —
 *  `{ ok: true, threadId }` on success, `{ ok: false, reason }` on refusal.
 *  `reason` is `'scope-denied'` when the manifest lacks `permissions.engine:
 *  ["invoke"]`, `'no-active-session'` when a shell IS present but no chat
 *  pane is currently focused, `'no-host'` when there is no shell at all (see
 *  {@link isStandalone}) — a distinct case because standalone dev has no
 *  panes for a "focus a chat pane" instruction to point at — or any other
 *  string the shell's refusal path grows in future. */
export type SendToChiResult =
  | { ok: true; threadId: string }
  | { ok: false; reason: 'scope-denied' | 'no-active-session' | 'no-host' | string };

/** Dispatch a prompt into the user's Chi — seeds a user turn in the focused
 *  chat pane's existing thread via `host.sendToActiveSession`. Gated on this
 *  pkg's manifest declaring `permissions.engine: ["invoke"]` (see
 *  manifest.json); without it the shell refuses with `reason: 'scope-denied'`
 *  and `reason: 'no-active-session'` when a shell is present but no chat pane
 *  is focused. Degrades gracefully in standalone dev (no parent shell) —
 *  returns `{ ok: false, reason: 'no-host' }` rather than throwing, same as
 *  every other helper in this file when `_app` is unset. `'no-host'` is
 *  distinct from `'no-active-session'` on purpose: standalone dev has no
 *  panes at all, so "open your Chi in a pane" is not an actionable message
 *  there the way it is when a shell exists but nothing is focused. Never
 *  throws. */
export async function sendToChi(prompt: string, source?: string): Promise<SendToChiResult> {
  if (isStandalone() || !_app) {
    return { ok: false, reason: 'no-host' };
  }
  try {
    const res = await callHostTool('host.sendToActiveSession', { prompt, source });
    const sc = res.structuredContent as { ok?: boolean; threadId?: string; reason?: string } | undefined;
    if (sc?.ok === true && typeof sc.threadId === 'string') {
      return { ok: true, threadId: sc.threadId };
    }
    return { ok: false, reason: sc?.reason ?? 'no-active-session' };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[studio] sendToChi failed', err);
    return { ok: false, reason: err instanceof Error ? err.message : 'no-active-session' };
  }
}

/** A published sidebar-menu item. Mirrors the shell's `PkgMenuItem`
 *  (shell/src/lib/pkg/pkg-menu-store.ts) 1:1 so the M-A "production ledger"
 *  menu can publish sections / badges / a `kind:'seg'` layout strip /
 *  disabled+active state — the shell renders all of these; the pkg only
 *  publishes the data. Keep this in lockstep with the shell contract. */
export interface PublishedMenuItem {
  id: string;
  label: string;
  icon?: string | null;
  badge?: string | number | null;
  /** Two-line context header. PRESENCE-SENSITIVE on both sides of the wire: the
   *  shell keys off `'subtitle' in item`, so `null` is a header with no meta
   *  line while an absent key stays a plain nav row. Publishing `undefined` is
   *  therefore NOT the same as publishing `null` — an explicit `null` is the
   *  only way to say "header, no meta". A header never dims, never clicks, and
   *  drops `icon` / `badge`. Shells older than the header support ignore the key
   *  and render the row vocabulary instead. */
  subtitle?: string | null;
  /** Consecutive items sharing a `section` render under one heading; items with
   *  no section form the implicit first group. Order is preserved as published. */
  section?: string | null;
  /** Renders dimmed + non-interactive (project-header row, inert states). */
  disabled?: boolean;
  /** Explicit active-highlight; overrides the shell's last-clicked fallback so
   *  view rows can track the FOCUSED pane's view independent of last click. */
  active?: boolean;
  /** `'seg'` renders an inline Segmented pill strip (layout presets); each
   *  option's id is published back as activeFeature on click. */
  kind?: 'item' | 'seg';
  options?: Array<{ id: string; label: string; active?: boolean }>;
}

/** Publish a sidebar menu to the shell. Click feedback arrives back through
 *  `hostContext.royaltiSuite.activeFeature` on the next `onhostcontextchanged`. */
export function setMenu(items: PublishedMenuItem[]): Promise<HostCallResult> {
  return callHostTool('host.pkg.setMenu', { items });
}

// ─── iyke postMessage channel ─────────────────────────────────────────────
//
// Separate from MCP — small payloads, no replies. The shell-side
// iframe-bridge listens for `{ __iyke: true, kind: 'state', payload }`
// envelopes and surfaces them to `iyke iframe-state <pane>`. The shared
// store (WP-07 commit 3) calls `publishStudioState` on every setter; the
// agent loop reads the 4-value snapshot to reason about cursor + playhead
// without rolling another RPC.

interface IykeEnvelope {
  __iyke: true;
  kind: string;
  payload: unknown;
}

function postIyke(envelope: IykeEnvelope): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  try {
    window.parent.postMessage(envelope, '*');
  } catch {
    // postMessage is heavily-sandboxed in some iframe configs; swallow the
    // error rather than crash the studio.
  }
}

/** Publish a single key/value pair on the iyke state channel. The four
 *  shared-state values use the canonical key 'studio'; ad-hoc keys are
 *  allowed for view-local introspection. */
export function publishState(key: string, value: unknown): void {
  postIyke({ __iyke: true, kind: 'state', payload: { key, value } });
}

// ─── Playhead publish throttle ────────────────────────────────────────────
//
// `playheadMs` advances once per rendered frame during playback (lib/
// player.ts's rAF loop, ~30/s) and every shared-state setter publishes the
// FULL snapshot — so an unthrottled publish here fires ~30 postMessages/sec
// at the shell for the whole duration of playback even though nothing but
// the scrub position moved (review §2 "Cross-window postMessage flood").
// Trailing-edge coalesce: a change that touches ONLY playheadMs is bucketed
// to ~8Hz; a change that also touches cellUid/hoverBeat/engineMode (rare,
// user-driven edges — selection, engine toggle) goes out immediately and
// flushes/cancels any pending playhead-only tick first, so the shell never
// sees an out-of-order snapshot (a stale playhead landing after a newer
// full snapshot). The in-app store itself is untouched — this only throttles
// the outbound iyke publish.

const PLAYHEAD_THROTTLE_MS = 125; // ~8Hz

let _lastPublished: StudioPublishedState | null = null;
let _throttleTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSnapshot: StudioPublishedState | null = null;

function onlyPlayheadChanged(next: StudioPublishedState, prev: StudioPublishedState | null): boolean {
  if (!prev) return false;
  return (
    next.cellUid === prev.cellUid
    && next.hoverBeat === prev.hoverBeat
    && next.engineMode === prev.engineMode
    && next.playheadMs !== prev.playheadMs
  );
}

/** Publish the canonical 4-value snapshot under key 'studio'. Called from
 *  every setter in src/studio/shared-state.ts (WP-07 commit 3). Playhead-only
 *  changes are throttled (see above); everything else is immediate. */
export function publishStudioState(snapshot: StudioPublishedState): void {
  if (onlyPlayheadChanged(snapshot, _lastPublished)) {
    _pendingSnapshot = snapshot;
    if (_throttleTimer) return; // already scheduled — trailing edge coalesces
    _throttleTimer = setTimeout(() => {
      _throttleTimer = null;
      const pending = _pendingSnapshot;
      _pendingSnapshot = null;
      if (pending) {
        _lastPublished = pending;
        publishState('studio', pending);
      }
    }, PLAYHEAD_THROTTLE_MS);
    return;
  }

  if (_throttleTimer) {
    clearTimeout(_throttleTimer);
    _throttleTimer = null;
    _pendingSnapshot = null;
  }
  _lastPublished = snapshot;
  publishState('studio', snapshot);
}

// ─── Internal — exposed for tests / debug ─────────────────────────────────

/** TEST/DEV ONLY. Tears down the cached connection so a follow-up
 *  `connectBridge()` re-handshakes. Production code should never need this. */
export function __resetBridge(): void {
  _app = null;
  _connection = null;
  _connectionPromise = null;
  _supabasePromise = null;
  _contextListeners = new Set();
  if (_throttleTimer) clearTimeout(_throttleTimer);
  _throttleTimer = null;
  _pendingSnapshot = null;
  _lastPublished = null;
}
