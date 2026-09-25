// com.ikenga.studio · MCP client (thin wrapper)
//
// Two implementations behind one interface:
//
//   - real:  routes every call through bridge.app.callServerTool({ name, args })
//            and exposes events via the host's `pkg://com.ikenga.studio/<event>`
//            notification channel. Lights up in Wave 3 once WP-06 ships the
//            real MCP server.
//
//   - mock:  ./__mocks__/mcp.ts — canned responses + a setTimeout-driven event
//            emitter that mirrors what WP-06 will publish, so commits 5–15 can
//            light up the cross-linking, scrub-sync, and now-rendering beacon
//            against synthetic data.
//
// Selection rule:
//   - Standalone-dev (no parent window)               → mock ('demo')
//   - In-shell, real MCP server answers the probe      → real
//   - In-shell, host reports NO mcp server for the pkg → mock ('demo'), but
//                                                        only once the verdict
//                                                        repeats (one answer is
//                                                        a per-call manifest
//                                                        read, not a fact)
//   - In-shell, server slow / booting / mid-restart    → keep probing
//                                                        ('connecting'), then
//                                                        demo data with a
//                                                        background re-probe
//                                                        ('degraded')
//
// The real-vs-mock choice in-shell is decided by a cheap `render.list_engines`
// probe (getMcpClient below), RETRIED on a backoff for a bounded ~15 s window
// (lib/mcp-probe.ts owns that policy, and is unit-tested). See the G-105 note
// on `resolveClient` for why a single-shot probe was not enough.
//
// WHAT CALLERS HOLD (and why it is not the transport)
//
//   `getMcpClient()` resolves to ONE stable facade object for the iframe's
//   lifetime. Every call on it is routed to whichever transport is live at the
//   moment of the call, and `mode` is a live getter. That is deliberate: views
//   cache the resolved client in a ref (`clientRef.current ?? (clientRef
//   .current = await getMcpClient())` — Launcher, ArchetypeBuilder), and a
//   degraded→real upgrade used to leave those refs pointing at the MOCK for the
//   rest of the mount. The Launcher's create path is the sharp edge: it would
//   `project.create` against the mock, get an id, flip the store open and paint
//   a header for a project that exists nowhere on disk, while `/iyke/state`
//   reported `mcp.phase: 'real'`. A facade makes a stale ref impossible, so no
//   view has to subscribe to the upgrade edge to stay correct (subscribing is
//   still how a view RENDERS the phase — see subscribeMcpConnection).
//
//   Event subscriptions taken through the facade are re-bound onto the new
//   transport on every swap, so a subscription taken while degraded stops
//   hearing the mock's synthetic emitter once the real server is live.

import { connectBridge, isBridgeConnected, isStandalone, publishState } from './bridge';
import {
  DEFAULT_PROBE_POLICY,
  classifyProbeError,
  connectionMessage,
  foldAbsentStreak,
  isDemoPhase,
  phaseForFallback,
  recordProbeFailure,
  shouldLatchAbsent,
  startProbeWindow,
  type McpConnectionPhase,
  type ProbeFallbackReason,
  type ProbePolicy,
} from './lib/mcp-probe';
import type {
  StudioEventName,
  StudioEventPayloadMap,
} from './mcp-types';

// ─── Public interface ───────────────────────────────────────────────────

export interface McpClient {
  /** Invoke an MCP tool by namespaced name (e.g. 'storyboard.read'). The
   *  result type is whatever the caller asserts — the canonical typed
   *  helpers below (callStoryboard*, callComposition*, …) wrap callTool
   *  with the correct narrowing. */
  callTool<TResult = unknown>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<TResult>;

  /** Subscribe to a pkg event channel
   *  (pkg://com.ikenga.studio/<event>). Returns an unsubscribe fn. */
  subscribe<E extends StudioEventName>(
    event: E,
    handler: (payload: StudioEventPayloadMap[E]) => void,
  ): () => void;

  /** Mode tag for diagnostics + UI badges. */
  readonly mode: 'mock' | 'real';
}

// ─── Selection / factory ────────────────────────────────────────────────

let _client: McpClient | null = null;

/** In-flight construction, shared across concurrent callers so three
 *  simultaneous Launcher loaders (archetypes/recents/engines, each firing its
 *  own `getMcpClient()` on mount) await ONE probe window + ONE client instead
 *  of each building a real client and racing to win `_client` — a losing
 *  instance could be left holding a stale/null active-project reference and
 *  throw "no open project" on its first real call. Cleared in the `finally`
 *  below so a later background re-probe starts fresh rather than replaying a
 *  long-settled promise. */
let _clientPromise: Promise<McpClient> | null = null;

/** The one real client instance for this iframe's lifetime, built lazily on
 *  the first in-shell resolve and REUSED by every re-probe. Holds the active
 *  project + cell cache (real-mcp.ts), so re-probing must never mint a second
 *  one — a fresh instance would come back with no active project and throw
 *  "no open project" on its first call after an upgrade. */
let _real: McpClient | null = null;
let _mock: McpClient | null = null;

/** Cache of the probe's own `render.list_engines` result (real mode only) so
 *  callers that need the engine list right after `getMcpClient()` resolves
 *  (Launcher's engines rail) don't re-issue the same call the probe just
 *  made. `null` whenever the probe hasn't run or didn't succeed — callers
 *  fall back to calling render.list_engines themselves. */
let _probedEngines: EngineCapability[] | null = null;

/** Returns the engine list captured by the last successful probe, or `null`
 *  if none is cached (mock mode, or the probe hasn't resolved / failed). */
export function getProbedEngines(): EngineCapability[] | null {
  return _probedEngines;
}

// ─── The facade every caller actually holds ─────────────────────────────

/** Forces call routing to a specific transport for the duration of an upgrade,
 *  BEFORE that transport becomes `_client`. The upgrade has to re-open the
 *  project on the real client while the session is still nominally degraded
 *  (adoptReal), and those two calls must not go to the mock. */
let _pinned: McpClient | null = null;

/** Open while an upgrade is mid-flight. Every facade call that is not the
 *  upgrade's own `project.open` / `project.info` waits on it, so nothing can
 *  reach the real transport in the window where it has no active project yet
 *  (`real-mcp.ts` would throw "no open project"). Resolves — never rejects —
 *  when the upgrade has settled one way or the other. */
let _upgradeGate: Promise<void> | null = null;

function isUpgradeOwnCall(name: string): boolean {
  return name === 'project.open' || name === 'project.info';
}

/** The transport a call made right now should go to. */
function activeTransport(): McpClient | null {
  return _pinned ?? _client;
}

interface FacadeSubscription {
  event: StudioEventName;
  handler: (payload: unknown) => void;
  /** Unsubscribe fn of the CURRENT binding, re-made on every transport swap. */
  off: (() => void) | null;
}

const _facadeSubs = new Set<FacadeSubscription>();

type LooseSubscribe = (event: string, handler: (payload: unknown) => void) => () => void;

function bindSubscription(sub: FacadeSubscription): void {
  sub.off = null;
  const transport = activeTransport();
  if (!transport) return;
  try {
    sub.off = (transport.subscribe as unknown as LooseSubscribe)(sub.event, sub.handler);
  } catch {
    // A transport that can't take subscriptions must not break the caller; the
    // next swap re-tries the binding.
    sub.off = null;
  }
}

/** Re-point every live subscription at the transport that just became active.
 *  Without this, a subscription taken while degraded keeps hearing the mock's
 *  setTimeout emitter after the real server is live. */
function rebindSubscriptions(): void {
  for (const sub of _facadeSubs) {
    try {
      sub.off?.();
    } catch {
      // Best effort — a failed unsubscribe must not strand the rebind.
    }
    bindSubscription(sub);
  }
}

function dropSubscriptions(): void {
  for (const sub of _facadeSubs) {
    try {
      sub.off?.();
    } catch {
      // ignore
    }
    sub.off = null;
  }
  _facadeSubs.clear();
}

/** Await a usable transport. Only reached before the first resolve settles (a
 *  facade handed out by `getMcpClient()` always already has one), so the
 *  recursion into getMcpClient() is one level deep and shares the in-flight
 *  probe window rather than starting a second one. */
async function requireTransport(): Promise<McpClient> {
  const now = activeTransport();
  if (now) return now;
  await getMcpClient();
  const settled = activeTransport();
  if (settled) return settled;
  throw new Error('[studio] mcp transport unavailable (no client resolved)');
}

/** The one object callers hold. Stable for the iframe's lifetime; routes to
 *  whatever transport is live at call time (see the header note). */
const MCP_FACADE: McpClient = {
  async callTool<TResult = unknown>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<TResult> {
    // `_pinned !== null` is what marks the upgrade's OWN open/info round-trip:
    // outside that pin even a project.* call waits, so a user click can't slip a
    // second open in between the re-open and the swap.
    if (_upgradeGate && !(_pinned !== null && isUpgradeOwnCall(name))) {
      await _upgradeGate;
    }
    const transport = await requireTransport();
    return transport.callTool<TResult>(name, args);
  },
  subscribe<E extends StudioEventName>(
    event: E,
    handler: (payload: StudioEventPayloadMap[E]) => void,
  ): () => void {
    const sub: FacadeSubscription = {
      event,
      handler: handler as (payload: unknown) => void,
      off: null,
    };
    _facadeSubs.add(sub);
    bindSubscription(sub);
    return () => {
      _facadeSubs.delete(sub);
      try {
        sub.off?.();
      } catch {
        // ignore
      }
      sub.off = null;
    };
  },
  get mode(): 'mock' | 'real' {
    return activeTransport()?.mode ?? 'mock';
  },
};

// ─── Connection state (the visible half of the G-105 fix) ───────────────

/** What the client is doing about its transport, for the UI to render.
 *  `message` is plain language and safe to show verbatim. */
export interface McpConnectionState {
  phase: McpConnectionPhase;
  message: string;
  /** Failed probes in the current window (0 before any failure). */
  failures: number;
  /** Why demo data is being served, `null` in `idle` / `connecting` / `real`. */
  reason: ProbeFallbackReason | null;
}

const IDLE_STATE: McpConnectionState = {
  phase: 'idle',
  message: connectionMessage('idle', null),
  failures: 0,
  reason: null,
};

let _conn: McpConnectionState = IDLE_STATE;
const _connListeners = new Set<(s: McpConnectionState) => void>();

/** Synchronous read of the current transport state. */
export function getMcpConnectionState(): McpConnectionState {
  return _conn;
}

/** Subscribe to transport-state changes. Returns an unsubscribe fn. Fires only
 *  on a phase/reason TRANSITION, never on a re-probe that changed nothing.
 *
 *  This is for RENDERING the phase, not for correctness: render
 *  `state.message` while `phase === 'connecting'`, and badge the surface while
 *  `isDemoMcpPhase(state.phase)`, so a booting MCP server reads as
 *  "connecting" and demo data is never mistaken for the open project.
 *
 *  Rehydrating on the `degraded`/`demo` → `real` edge is NOT a consumer's job:
 *  `adoptReal` re-opens the project on the real client and re-reads the
 *  storyboard itself, and the client callers hold is a facade that re-routes on
 *  the swap, so a cached client ref cannot go stale (header note). */
export function subscribeMcpConnection(fn: (s: McpConnectionState) => void): () => void {
  _connListeners.add(fn);
  return () => {
    _connListeners.delete(fn);
  };
}

/** True while the data on screen is a fixture rather than the open project. */
export function isDemoMcpPhase(phase: McpConnectionPhase): boolean {
  return isDemoPhase(phase);
}

function setConnection(
  phase: McpConnectionPhase,
  reason: ProbeFallbackReason | null,
  failures: number,
): void {
  const next: McpConnectionState = {
    phase,
    reason,
    failures,
    message: connectionMessage(phase, reason),
  };
  // `failures` is bookkeeping, NOT part of the dedupe key: a permanently dead
  // server re-probes every `reprobeMs` forever, and including the counter made
  // every one of those ticks publish a fresh iyke state for a pane that had not
  // changed — the shell then bumps its state generation, dispatches
  // IFRAME_STATE_EVENT and re-pushes the whole panes payload, and any component
  // subscribed here re-renders, indefinitely. Only a phase/reason TRANSITION is
  // user-visible, so only a transition is published. The counter is still kept
  // on `_conn` (the next real transition carries the current number).
  const quiet = next.phase === _conn.phase && next.reason === _conn.reason;
  _conn = next;
  if (quiet) return;
  // Publish on the iyke state channel under its own key so the running shell
  // (and any observing agent) can read the mode straight out of
  // `/iyke/state` — G-105's instruction to "check for `mock` in the tree
  // after every reload" had no reliable signal to check, since the iframe
  // console is not captured (G-93) and every DOM name is fixture-shaped.
  // No-op standalone (bridge.postIyke bails without a parent window).
  publishState('mcp', {
    phase: next.phase,
    reason: next.reason,
    failures: next.failures,
    // The same plain-language copy a view renders, so `/iyke/state` carries the
    // human-readable mode too and an agent reading the tree doesn't have to map
    // phase+reason back to meaning.
    message: next.message,
  });
  for (const fn of _connListeners) {
    try {
      fn(next);
    } catch {
      // A listener must never break the transport.
    }
  }
}

// ─── The probe ──────────────────────────────────────────────────────────

let _policy: ProbePolicy = DEFAULT_PROBE_POLICY;

/** TEST/DEV ONLY. Override the retry policy (shorter windows in tests, a
 *  longer one on a slow box). Pass no argument to restore the default. */
export function __setProbePolicy(policy?: Partial<ProbePolicy>): void {
  _policy = policy ? { ...DEFAULT_PROBE_POLICY, ...policy } : DEFAULT_PROBE_POLICY;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('mcp-probe-timeout')), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TEST/DEV ONLY overrides. The upgrade edge (degraded → real) is where the
 *  ordering bugs live — the real client must have the project OPEN before it
 *  becomes the transport — and driving it for real needs a shell, an AppBridge
 *  handshake and a supervised sidecar. These four consult points let
 *  `mcp-client.test.ts` drive it with fake transports instead. Nothing in
 *  production sets them. */
interface TransportOverrides {
  real?: McpClient;
  mock?: McpClient;
  /** Force `resolveClient` down the in-shell branch (skip standalone + bridge). */
  inShell?: boolean;
  /** What the probe policy is told about server presence (default: the bridge). */
  serverPresent?: boolean;
}
let _overrides: TransportOverrides | null = null;

/** TEST/DEV ONLY. Pass `null` to restore real behaviour. */
export function __setMcpTransports(overrides: TransportOverrides | null): void {
  _overrides = overrides;
}

async function getRealClient(): Promise<McpClient> {
  if (_real) return _real;
  if (_overrides?.real) {
    _real = _overrides.real;
    return _real;
  }
  const { createRealMcpClient } = await import('./real-mcp.js');
  _real = createRealMcpClient();
  return _real;
}

async function getMockClient(): Promise<McpClient> {
  if (_mock) return _mock;
  if (_overrides?.mock) {
    _mock = _overrides.mock;
    return _mock;
  }
  const { createMockMcpClient } = await import('./__mocks__/mcp.js');
  _mock = createMockMcpClient();
  return _mock;
}

/** One probe attempt. `render.list_engines` needs no open project and is the
 *  cheapest tool the server exposes, so a pass proves the whole path
 *  (iframe → AppBridge → shell `pkg_mcp_call` → supervised studio server).
 *
 *  Resolves to `null` — NOT `[]` — when the answer carries no engines array.
 *  The probe still PASSED (the transport answered); there is just nothing to
 *  cache. `[]` is truthy, so caching it made the Launcher's
 *  `getProbedEngines() ?? (await renderApi.list_engines(client)).engines`
 *  skip the fetch and drop the engine rail for the life of the mount. */
async function probeOnce(real: McpClient): Promise<EngineCapability[] | null> {
  const result = await withTimeout(
    real.callTool<{ engines?: EngineCapability[] }>('render.list_engines'),
    _policy.timeoutMs,
  );
  return Array.isArray(result?.engines) ? result.engines : null;
}

/** How many upgrade attempts may fail to re-open the project before the real
 *  client is adopted anyway (and the unopenable project forgotten). Bounded on
 *  purpose: staying degraded forever would be its own mock-lock, e.g. when the
 *  persisted path came from a MOCK recents row and names nothing on disk. */
const UPGRADE_REOPEN_ATTEMPTS = 2;
let _upgradeReopenFailures = 0;

/** Promote `real` to the session transport.
 *
 *  On an UPGRADE (degraded/demo → real) the project the demo session was
 *  showing is re-opened on the real client FIRST, behind `_upgradeGate`, and
 *  the phase only flips once that succeeded. The previous version swapped
 *  `_client` and published `phase: 'real'` synchronously and then re-opened in
 *  a detached, fully-swallowed async function: anything routed to the real
 *  client in that window threw `no open project` (a CellPoster fetch, a user
 *  click), and if the re-open FAILED the session was stranded — phase `real`,
 *  no active project, `armReprobe()` refusing to arm on `real`, every
 *  project-scoped call throwing for the rest of the pane's life while the
 *  header still showed an open project. */
async function adoptReal(real: McpClient, engines: EngineCapability[] | null): Promise<McpClient> {
  if (!isDemoPhase(_conn.phase)) {
    // First-mount resolve: nothing loaded against a fixture, nothing to redo.
    settleReal(real, engines);
    return MCP_FACADE;
  }

  let release = (): void => {};
  _upgradeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const outcome = await reopenOpenProjectOn(real);
    if (outcome === 'failed') {
      _upgradeReopenFailures += 1;
      if (_upgradeReopenFailures < UPGRADE_REOPEN_ATTEMPTS) {
        // Keep serving the fixture — honestly labelled — and try the whole
        // upgrade again on the next re-probe. Promoting a real client with no
        // active project would break every project-scoped call instead.
        setConnection('degraded', 'project-reopen-failed', _conn.failures);
        armReprobe();
        return MCP_FACADE;
      }
      // The transport answers but this project cannot be opened on it. Stop
      // pretending: forget it and let the user land on the Launcher with a
      // real client, rather than keep a phantom project in the header.
      await forgetUnopenableProject();
    }
    settleReal(real, engines);
    if (outcome === 'opened') void rehydrateStoryboardAfterUpgrade();
    return MCP_FACADE;
  } finally {
    _upgradeGate = null;
    release();
  }
}

/** The actual swap. Split out so the upgrade path can do its work before it. */
function settleReal(real: McpClient, engines: EngineCapability[] | null): void {
  cancelReprobe();
  _pinned = null;
  _client = real;
  _probedEngines = engines;
  _absentStreak = 0;
  _upgradeReopenFailures = 0;
  rebindSubscriptions();
  setConnection('real', null, 0);
}

/** Re-open the currently-open project ON the real client, while that client is
 *  pinned as the call target but is not yet the session transport.
 *
 *  Dynamic imports on purpose: `project-store` / `open-project` /
 *  `storyboard-store` all import THIS module, so a static import here would be
 *  a cycle. Routed through `openProjectByPath` rather than a second open path
 *  of its own — that helper owns the project.info enrichment and the
 *  last-project persistence, and forking it would drift (see its header). */
async function reopenOpenProjectOn(real: McpClient): Promise<'none' | 'opened' | 'failed'> {
  let target: { path: string; name: string } | null = null;
  try {
    const { useProjectStore } = await import('./project-store.js');
    const open = useProjectStore.getState().project;
    target = open?.path ? { path: open.path, name: open.name } : null;
  } catch {
    return 'none';
  }
  if (!target) return 'none';
  _pinned = real;
  try {
    await (await import('./lib/open-project.js')).openProjectByPath(target.path, target.name);
    return 'opened';
  } catch {
    // Moved / access denied / sidecar error / a path that only ever existed in
    // the mock's recents.
    return 'failed';
  } finally {
    _pinned = null;
  }
}

/** Drop a project that the real client cannot open, so nothing on screen
 *  claims an open project the transport doesn't have. */
async function forgetUnopenableProject(): Promise<void> {
  try {
    const { useProjectStore } = await import('./project-store.js');
    useProjectStore.getState().closeProject();
  } catch {
    // ignore — best effort
  }
  try {
    const { useStoryboardStore } = await import('./storyboard-store.js');
    useStoryboardStore.getState().clear();
  } catch {
    // ignore — best effort
  }
}

/** Re-read the storyboard against the freshly-opened REAL project id.
 *
 *  Re-opening already restarts most of the chain on its own: the project id
 *  changes (mock id → real sidecar id) and App.tsx's effects are keyed on
 *  `project.project_id`. This is belt and braces for the case where the two ids
 *  happen to match. It passes the id EXPLICITLY rather than calling
 *  `refetch()`: refetch reads the storyboard store's own `projectId`, which is
 *  still the MOCK id until React re-keys it, so it issued a `storyboard.read`
 *  for a project the sidecar has never heard of and parked the resulting error
 *  string in the store (rendered by Ledger) after an otherwise clean upgrade. */
async function rehydrateStoryboardAfterUpgrade(): Promise<void> {
  try {
    const { useProjectStore } = await import('./project-store.js');
    const projectId = useProjectStore.getState().project?.project_id;
    if (!projectId) return;
    const { useStoryboardStore } = await import('./storyboard-store.js');
    // Nothing was ever hydrated (no fixture cells on screen) — App.tsx's own
    // effect owns the first hydrate; don't race it with a duplicate read.
    if (useStoryboardStore.getState().projectId === null) return;
    await useStoryboardStore.getState().hydrate(projectId);
  } catch {
    // Best effort — a failed rehydrate must not take the transport down. The
    // phase already says `real`, so the next user action reads live data.
  }
}

async function adoptMock(reason: ProbeFallbackReason, latch: boolean, failures: number): Promise<McpClient> {
  const mock = await getMockClient();
  _pinned = null;
  _client = mock;
  _probedEngines = null;
  rebindSubscriptions();
  setConnection(phaseForFallback(latch), reason, failures);
  if (!latch) armReprobe();
  return MCP_FACADE;
}

// ─── Background re-probe (never latch while the server is present) ──────

let _reprobeTimer: ReturnType<typeof setTimeout> | null = null;
/** True from the moment a background re-probe starts until it has settled.
 *  The timer handle cannot serve as this flag — `armReprobe`'s callback nulls
 *  it BEFORE awaiting `runReprobe`, so every call arriving during an in-flight
 *  probe used to satisfy `nudgeReprobe`'s only guard and start another one
 *  (mounting Composition while degraded meant one concurrent probe per
 *  CellPoster, each holding its own 3 s timer and SDK request, fired at a
 *  server that had already missed its window). */
let _probeInFlight = false;

/** Consecutive `absent` verdicts, carried ACROSS the foreground window and the
 *  background re-probes so the two confirm each other (lib/mcp-probe.ts owns
 *  the rule; a single absent answer must never latch). */
let _absentStreak = 0;

function cancelReprobe(): void {
  if (_reprobeTimer !== null) {
    clearTimeout(_reprobeTimer);
    _reprobeTimer = null;
  }
}

/** Arm a single background re-probe. Serving demo data is never terminal while
 *  the host reports the pkg's MCP server present: the moment a probe succeeds
 *  we flip to the real client and notify subscribers so the views rehydrate. */
function armReprobe(): void {
  if (_reprobeTimer !== null || _conn.phase === 'real' || _conn.phase === 'demo') return;
  _reprobeTimer = setTimeout(() => {
    _reprobeTimer = null;
    void runReprobe();
  }, _policy.reprobeMs);
}

async function runReprobe(): Promise<void> {
  // A foreground resolve or another re-probe already owns the decision.
  if (_probeInFlight || _clientPromise || _conn.phase === 'real' || _conn.phase === 'demo') return;
  _probeInFlight = true;
  try {
    const real = await getRealClient();
    const engines = await probeOnce(real);
    await adoptReal(real, engines);
  } catch (err) {
    const kind = classifyProbeError(err);
    _absentStreak = foldAbsentStreak(_absentStreak, kind);
    if (kind === 'absent' && shouldLatchAbsent(_absentStreak, _policy)) {
      // The host has now said twice in a row that there is no server at all —
      // this is the sanctioned demo mode, and the only case where we stop
      // trying. One absent answer is not enough: the shell re-reads
      // manifest.json on every call, so a live manifest edit or an
      // uninstall/reinstall produces exactly this wording transiently.
      void adoptMock('absent', true, _conn.failures + 1);
      return;
    }
    setConnection(
      'degraded',
      kind === 'trust-required' ? 'trust-required' : kind === 'absent' ? 'absent' : 'window-exhausted',
      _conn.failures + 1,
    );
    armReprobe();
  } finally {
    _probeInFlight = false;
  }
}

/** Kick the background re-probe early. Timers are throttled hard in a hidden
 *  webview, so a view that asks for a client while degraded also nudges the
 *  upgrade rather than waiting on a possibly-parked timeout. */
function nudgeReprobe(): void {
  if (_conn.phase !== 'degraded' || _clientPromise || _probeInFlight) return;
  // Only when nothing is pending, so a burst of view calls can't turn the
  // re-probe into a hot loop against a server that is already struggling.
  if (_reprobeTimer === null) void runReprobe();
}

// ─── Resolve ────────────────────────────────────────────────────────────

/** The full first-mount decision, retried across the probe window.
 *
 *  G-105 (WP-32 live round, 2026-09-12) is why this loops. The kernel remounts
 *  the iframe the instant a pkg reloads, but the supervised `studio` MCP
 *  server needs ~3.4 s to answer its first `tools/call`. The previous version
 *  of this function fired ONE probe behind a 3 s timeout and, on the throw,
 *  cached the mock for the session: the pane came back reading
 *  `~/Untitled (mock)/` with the 6-cell mock timeline, and every subsequent
 *  check silently graded demo data. Now:
 *
 *    • the probe is retried on a backoff for ~15 s (lib/mcp-probe.ts), so the
 *      reload race resolves REAL in a few hundred ms;
 *    • while the window is open the phase is `connecting`, so callers await
 *      and the UI can say "Connecting to studio engine…" instead of painting
 *      a fixture;
 *    • a window-exhausted fallback does NOT latch while the host reports the
 *      MCP server present — demo data is served with a background re-probe
 *      armed, and a later success flips to real + notifies subscribers;
 *    • only a host that reports NO mcp server (or standalone dev) latches.
 *      That is the explicit, sanctioned demo mode. */
async function resolveClient(): Promise<McpClient> {
  if (!_overrides?.inShell && isStandalone()) {
    cancelReprobe();
    const mock = await getMockClient();
    _pinned = null;
    _client = mock;
    _probedEngines = null;
    rebindSubscriptions();
    setConnection('demo', 'standalone', 0);
    return MCP_FACADE;
  }

  if (!_overrides?.inShell) await connectBridge();
  const real = await getRealClient();

  let win = startProbeWindow(Date.now());
  setConnection('connecting', null, 0);

  for (;;) {
    // The probe and the ADOPTION are separate steps on purpose: a throw out of
    // adoptReal (which now awaits a project re-open) must not be folded into
    // the window as another probe failure.
    let engines: EngineCapability[] | null = null;
    let failure: unknown = null;
    let probed = false;
    try {
      engines = await probeOnce(real);
      probed = true;
    } catch (err) {
      failure = err;
    }
    if (probed) return adoptReal(real, engines);

    // NB: destructured as `nextWindow` — binding it as `window` would shadow
    // the global.
    const { window: nextWindow, step } = recordProbeFailure(win, failure, Date.now(), {
      // The AppBridge handshake completed, so the kernel mounted this iframe
      // as a pkg pane from a manifest that declares the `studio` server:
      // the server is reported present and a fallback must stay un-latched.
      serverPresent: _overrides?.serverPresent ?? isBridgeConnected(),
      policy: _policy,
    });
    win = nextWindow;
    // Carried into the background re-probe so a foreground absent verdict and a
    // background one confirm each other (and any other verdict resets both).
    _absentStreak = win.absentStreak;
    if (step.action === 'retry') {
      setConnection('connecting', null, step.failures);
      await sleep(step.delayMs);
      continue;
    }
    return adoptMock(step.reason, step.latch, step.failures);
  }
}

/** Lazily resolves and caches the MCP client. Idempotent — concurrent callers
 *  share one probe window and one client.
 *
 *  Selection is RUNTIME, not a build flag:
 *    • Standalone dev (plain browser tab, no shell parent) → mock. Lets
 *      `pnpm dev` boot the iframe without a backend.
 *    • In-shell (mounted in an Ikenga pane) → REAL, once the retried
 *      `render.list_engines` probe confirms the pkg's `studio` MCP server
 *      answers. While that window is open this promise stays PENDING — a
 *      caller that awaits it is what makes the "connecting" state honest.
 *    • Demo data is only handed out once the window is exhausted (or the host
 *      reports no server at all), and then only alongside a live
 *      `connection.phase` saying so.
 *
 *  `isStandalone()` is the synchronous discriminator. main.tsx only renders
 *  <App/> after connectBridge() resolves, so in shell mode the bridge is
 *  already connected before any view calls this; we await it again here
 *  (idempotent) so the real client's transport is guaranteed live. */
export function getMcpClient(): Promise<McpClient> {
  // Settled for good: real, or an explicitly latched demo mode. (The facade is
  // the same object either way — see the header note on why callers never hold
  // a transport directly.)
  if (_client && (_conn.phase === 'real' || _conn.phase === 'demo')) {
    return Promise.resolve(MCP_FACADE);
  }

  // Concurrent callers (Launcher's three loaders all fire on mount) share the
  // one construction + probe window already underway rather than each starting
  // its own real client and probe.
  if (_clientPromise) return _clientPromise;

  // Degraded: a client exists (the mock) and a background re-probe owns the
  // upgrade. Hand it over immediately — blocking every view on a server that
  // already missed its window would be worse than clearly-labelled demo data.
  if (_client) {
    nudgeReprobe();
    return Promise.resolve(MCP_FACADE);
  }

  _clientPromise = resolveClient().finally(() => {
    _clientPromise = null;
  });
  return _clientPromise;
}

/** TEST/DEV ONLY. Drops the cached client so the next getMcpClient() call
 *  re-resolves. Used by view tests that need to inject a custom mock. */
export function __resetMcpClient(): void {
  cancelReprobe();
  dropSubscriptions();
  _client = null;
  _pinned = null;
  _upgradeGate = null;
  _clientPromise = null;
  _probedEngines = null;
  _real = null;
  _mock = null;
  _absentStreak = 0;
  _probeInFlight = false;
  _upgradeReopenFailures = 0;
  _conn = IDLE_STATE;
}

// ─── Typed helpers ──────────────────────────────────────────────────────
//
// Thin sugar over callTool so views read like `await sb.read({...})` rather
// than `await client.callTool('storyboard.read', {...})`. The view layer
// imports these directly — it never sees the string method name.

import type {
  Project, Cell, Beat, RenderRecord, EngineCapability, Block,
  Archetype, ExportRecord, AspectRatio, Rung,
} from './mcp-types';
// Separate line (own domain) so the shared type import above stays untouched.
import type { Anchor, PromptPackage } from './mcp-types';

/** What `project.list` / `project.recents` ACTUALLY return, tolerant of the
 *  three real runtime shapes they resolve to (the "honesty rule" — this
 *  boundary genuinely drifts):
 *
 *   • real, project.list: the sidecar's `ProjectSummary` — `projectId` /
 *     `name` / `path` / `lastOpened` (epoch ms), camelCase, one row per
 *     previously-opened project, most-recent first. Carries NO archetype /
 *     aspect / cell-count — those aren't cheaply reachable there (render.list
 *     is projectId-scoped to the open project).
 *   • real, project.recents (G-47): the sidecar's `RecentProject` — same
 *     camelCase shape PLUS `archetypeId` / `cellCount` / `aspect`, recorded at
 *     open time. Dead paths are filtered out server-side rather than flagged.
 *   • mock (standalone): a full `Project` schema object (snake_case `slug` /
 *     `title` / `archetype_id` / `aspect_ratio` / `cells[]` / `updated_at`).
 *
 *  All fields are optional so the Launcher's `normalizeRecent()` can read
 *  whichever the active client emitted and degrade honestly (drop the coverage
 *  meter + exported/draft pill for rows that don't carry them). */
export interface RawRecentProject {
  // real ProjectSummary / RecentProject (camelCase)
  projectId?: string;
  lastOpened?: number;
  archetypeId?: string;
  cellCount?: number;
  aspect?: AspectRatio;
  // full Project / mock (snake_case + schema)
  project_id?: string;
  slug?: string;
  title?: string;
  updated_at?: string;
  created_at?: string;
  archetype_id?: string;
  aspect_ratio?: AspectRatio;
  cells?: unknown[];
  // shared
  name?: string;
  path?: string;
  /** Whether the stored path still exists on disk (real project.list only —
   *  project.recents omits dead rows entirely, so this is always true there).
   *  Absent on mock/full-Project rows → treated as present. */
  exists?: boolean;
}

export const projectApi = {
  open:   (c: McpClient, path: string) =>
    c.callTool<{ project_id: string }>('project.open', { path }),
  close:  (c: McpClient, project_id: string) =>
    c.callTool<{ closed: boolean }>('project.close', { project_id }),
  list:   (c: McpClient) =>
    c.callTool<{ projects: RawRecentProject[] }>('project.list'),
  /** G-47 — enriched recents (archetype/cell-count/aspect, dead paths
   *  filtered). Real mode only; the mock client has no matching tool case, so
   *  callers gate on `client.mode === 'real'` (Launcher does). */
  recents: (c: McpClient, limit?: number) =>
    c.callTool<{ projects: RawRecentProject[] }>('project.recents', limit != null ? { limit } : {}),
  create: (c: McpClient, args: { archetype_id: string; path: string; name: string; aspect_ratio?: AspectRatio }) =>
    c.callTool<{ project_id: string }>('project.create', args),
  info:   (c: McpClient, project_id: string) =>
    c.callTool<Project>('project.info', { project_id }),
};

export const storyboardApi = {
  read:        (c: McpClient, project_id: string) =>
    c.callTool<{ project: Project; beats: Beat[]; cells: Cell[] }>('storyboard.read', { project_id }),
  read_cell:   (c: McpClient, cell_uid: string) =>
    c.callTool<Cell>('storyboard.read_cell', { cell_uid }),
  /** Read the open project's Fountain screenplay source (<root>/script.fountain).
   *  `exists:false` (empty text) = the project has no .fountain on disk yet. */
  read_fountain: (c: McpClient) =>
    c.callTool<FountainRead>('storyboard.read_fountain'),
  /** Persist the project's Fountain screenplay to <root>/script.fountain (UTF-8).
   *  Replaces the file wholesale — the durable save seam for a future edit / Chi
   *  authoring flow. */
  write_fountain: (c: McpClient, text: string) =>
    c.callTool<FountainWrite>('storyboard.write_fountain', { text }),
  /** Read the cell's REAL authored source file (the markup at its content_path).
   *  `exists:false` (empty html) = a cell with no source written yet. */
  read_cell_content: (c: McpClient, cell_uid: string) =>
    c.callTool<CellContent>('storyboard.read_cell_content', { cell_uid }),
  /** Persist the FULL edited html to the cell's content_path (durable save). */
  write_cell_content: (c: McpClient, cell_uid: string, html: string) =>
    c.callTool<{ content_path: string; bytes: number }>('storyboard.write_cell_content', { cell_uid, html }),
  write_cell:  (c: McpClient, cell_uid: string, patch: Partial<Cell>) =>
    c.callTool<Cell>('storyboard.write_cell', { cell_uid, patch }),
  /** Create a new cell from a full Cell record (Canvas "New cell"). The active
   *  project is injected real-side; the sidecar validates against CellSchema and
   *  scaffolds the on-disk cell dir. */
  create_cell: (c: McpClient, cell: Cell) =>
    c.callTool<{ cell: Cell }>('storyboard.create_cell', { cell }),
  /** Delete a cell by uid. Removes the record from storyboard.json; the on-disk
   *  cell dir is left in place (sidecar deleteCell — content files stay). */
  delete_cell: (c: McpClient, cell_uid: string) =>
    c.callTool<{ cellId: string }>('storyboard.delete_cell', { cell_uid }),
  list_cells:  (c: McpClient, args?: { beat_id?: string; rung?: Rung }) =>
    c.callTool<{ cells: Cell[] }>('storyboard.list_cells', args ?? {}),
  set_approved:(c: McpClient, cell_uid: string, approved: boolean) =>
    c.callTool<{ ok: true }>('storyboard.set_approved', { cell_uid, approved }),
  /** Reassign `Cell.index` across the named cells, in the order given — the
   *  node canvas sequence lane's ONE sanctioned mutation (Plan 25 D-25-5).
   *  `order` is the FULL lane order front-to-back; cells not named keep their
   *  index. One atomic write on the sidecar, so one watcher event. Free 2D
   *  placement on the canvas is non-semantic and must never call this. */
  reorder_cells: (c: McpClient, order: string[]) =>
    c.callTool<{ moved: number; order: string[] }>('storyboard.reorder_cells', { order }),
};

/** The authored canvas document as it comes off `canvas.read` — `exists:false`
 *  with a null `doc` is a project that has never been arranged, NOT an error. */
export interface CanvasRead {
  exists: boolean;
  doc: unknown;
  path: string;
}

export const canvasApi = {
  /** Read `<project>/.studio/canvas.json` (Plan 25 authored state). Real mode
   *  only — the mock client has no project on disk, so callers gate on
   *  `client.mode === 'real'` and fall back to a local cache off-shell. */
  read:  (c: McpClient) => c.callTool<CanvasRead>('canvas.read'),
  /** Persist the authored canvas document, atomically. Replaces the file
   *  wholesale (read → amend → write). Never touches storyboard.json. */
  write: (c: McpClient, doc: unknown) =>
    c.callTool<{ path: string; bytes: number; doc: unknown }>('canvas.write', { doc }),
};

/** One shot `breakdown.run` projected out of the script — an action paragraph
 *  plus the OTIO ids derived from its position. `uid` is the cell uid AND the
 *  `[[tag]]` written back into script.fountain, so it's the exact join key the
 *  Breakdown rail links on. */
export interface BreakdownShot {
  /** OTIO shot id `sc<N>_sh<M>` — the cell uid and the script tag. */
  uid: string;
  /** OTIO scene id `sc<N>`. */
  beat_id: string;
  /** The action paragraph text, verbatim from the script. */
  action: string;
}

/** What a `breakdown.run` call actually did — the discriminant to switch on.
 *  See `BreakdownRun` for the per-outcome field rules.
 *
 *   • `scaffolded`          — board was empty; cells created and tags written.
 *   • `retagged`            — board had cells; NOTHING created, tags written.
 *   • `already-tagged`      — board had cells, every paragraph already tagged
 *                             correctly. A true no-op — nothing was written.
 *   • `ambiguous-needs-chi` — board had cells but which paragraph belongs to
 *                             which shot is judgment. Nothing written. Read
 *                             `ambiguous` and hand off to the Chi.
 *   • `script-write-failed` — script.fountain could not be written. `created`
 *                             may still be non-empty (scaffold got that far).
 *                             Read `script_error`.
 *   • `planned`             — dry run. NOTHING happened; read `would_create` /
 *                             `would_tag`.
 *   • `demo-inert`          — MOCK CLIENT ONLY. Demo mode has no project on
 *                             disk and no script.fountain, so the verb cannot
 *                             run at all. Nothing happened and every count is
 *                             `null`. Render `message`, not numbers. The
 *                             sidecar never emits this. */
export type BreakdownOutcome =
  | 'scaffolded'
  | 'retagged'
  | 'already-tagged'
  | 'ambiguous-needs-chi'
  | 'script-write-failed'
  | 'planned'
  | 'demo-inert';

/** Why retag refused to auto-match. Facts about the script and the board, never
 *  a judgment about which reading is right.
 *
 *   • `count-mismatch`     — N paragraphs vs M shots (the real forge project:
 *                            8 vs 6). There is no forced pairing.
 *   • `tag-order-conflict` — an authored `[[tag]]` disagrees with board order.
 *   • `unresolved-tag`     — an authored `[[tag]]` names no shot on this board. */
export type BreakdownAmbiguityReason = 'count-mismatch' | 'tag-order-conflict' | 'unresolved-tag';

/** Result of `breakdown.run`. **Switch on `outcome`.** Do not infer success
 *  from the absence of a throw — a hand-off and a failed write both arrive here
 *  as normal results, because both carry facts the user needs.
 *
 *  Honesty rules this shape exists to enforce — the previous version of this
 *  contract reported a fabricated `tagged: 6` / `script_bytes: 1024` against a
 *  script that was never written, and the UI printed it verbatim:
 *
 *   • `tagged` is the LIST of uids whose tag this call wrote. Its length is a
 *     measured count. There is no "tags written" number to invent — if nothing
 *     was written the list is empty, so say "no tags written".
 *   • `script_bytes` is `null` whenever nothing was written. **Never render a
 *     byte count when it is null**, and never substitute a placeholder.
 *   • `scenes` / `paragraphs` / `cell_count` are measured off the script and
 *     the board this call actually read.
 *   • `created` is empty in retag mode BY DESIGN (D-8) — an existing board is
 *     never scaffolded onto. Empty `created` is not a failure.
 *   • Every created cell comes back with `shot_type:'unset'`, `prompt:''`,
 *     `anchors:[]`, `duration_ms:0`. That is not missing data to paper over —
 *     those fields need an LLM (the `studio-breakdown` skill / Chi) and `run`
 *     refuses to guess. Present the board as a scaffold awaiting judgment.
 *   • Genuine errors still arrive as a THROW from the client (see real-mcp
 *     `raw`): `error: 'no-script' | 'no-action-paragraphs' | 'invalid-args'`.
 *     `cells-exist` is GONE — an existing board is now the retag path, not a
 *     refusal. */
export interface BreakdownRun {
  /** What happened. Branch on this. */
  outcome: BreakdownOutcome;
  /** Which half of D-8 ran. `retag` never creates.
   *  `null` on `demo-inert` — no board and no script were ever read, so no mode
   *  was ever chosen. Claiming one would be a guess. */
  mode: 'scaffold' | 'retag' | null;
  /** True when this was a plan-only call (nothing written to disk). */
  dry_run: boolean;
  /** Distinct scenes the parser found in script.fountain. Measured.
   *  `null` ONLY on `demo-inert` — no script was ever parsed, so there is no
   *  number. Do not coalesce null to 0; 0 reads as a measurement. */
  scenes: number | null;
  /** Action paragraphs the parser found in script.fountain. Measured.
   *  `null` on `demo-inert` — see `scenes`. */
  paragraphs: number | null;
  /** Cells on the board when the call started. Measured.
   *  `null` on `demo-inert` — see `scenes`. */
  cell_count: number | null;
  /** The shots the script projects to. SCAFFOLD MODE ONLY — `[]` in retag. */
  planned: BreakdownShot[];
  /** uids of the cells actually created. Always `[]` in retag mode / dry run. */
  created: string[];
  /** The newly created Cell records. Scaffold only; absent on a dry run. */
  cells?: Cell[];
  /** Existing cells left untouched. In retag mode that is every cell. */
  skipped: string[];
  /** uids that WOULD be created — dry run only. */
  would_create?: string[];
  /** uids whose tag WOULD be written — dry run only. */
  would_tag?: string[];
  /** uids whose `[[tag]]` THIS call wrote into script.fountain. */
  tagged: string[];
  /** uids whose paragraph already carried the right tag — left untouched. */
  already_tagged: string[];
  /** Did script.fountain actually get written this call? */
  script_written: boolean;
  /** UTF-8 byte size of the script after tagging, or `null` when nothing was
   *  written. Render nothing when null — there is no number to show. */
  script_bytes: number | null;
  /** Present iff `outcome === 'script-write-failed'`. */
  script_error?: string;
  /** Present iff `outcome === 'ambiguous-needs-chi'` — the facts that made the
   *  paragraph→shot mapping a judgment call. `detail` is a plain-language
   *  explanation safe to show the user. */
  ambiguous?: {
    paragraphs: number;
    cells: number;
    reason: BreakdownAmbiguityReason;
    detail: string;
  };
  /** Plain-language note about a result that carries no numbers to show —
   *  currently only `demo-inert`. Safe to render verbatim. */
  message?: string;
}

export const breakdownApi = {
  /** Link the open project's script.fountain to its storyboard, deterministically.
   *  The active project is injected real-side.
   *
   *  Two modes, auto-selected (D-8): an EMPTY board is scaffolded (one rung-0
   *  cell per action paragraph + `[[sc<N>_sh<M>]]` tags); a board that already
   *  has cells is RETAGGED — nothing is created, and only the `[[tag]]`s are
   *  written, using each cell's uid. Retag auto-matches only when the reading is
   *  forced (one paragraph per cell, in order, no authored tag contradicting it);
   *  otherwise it returns `outcome: 'ambiguous-needs-chi'` rather than guessing.
   *
   *  Spends nothing — no render, no anchor generation, no approval gate.
   *  Never deletes a cell and never overwrites an authored tag.
   *  Pass `{ dry_run: true }` to preview (`outcome: 'planned'`).
   *
   *  **Switch on `result.outcome`.** A resolved promise does not mean the board
   *  changed. */
  run: (c: McpClient, args?: { dry_run?: boolean }) =>
    c.callTool<BreakdownRun>('breakdown.run', args ?? {}),
};

/** A cell's authored source file (storyboard.read_cell_content). `exists:false`
 *  (empty html) is a real cell with no source written yet, NOT an error. */
export interface CellContent {
  html: string;
  content_path: string;
  exists: boolean;
}

/** The project's Fountain screenplay (storyboard.read_fountain). `exists:false`
 *  (empty text) is a project with no script.fountain on disk, NOT an error. */
export interface FountainRead {
  exists: boolean;
  text: string;
}

/** Result of writing the project's Fountain screenplay (storyboard.write_fountain).
 *  The file now exists on disk; `bytes` is the UTF-8 byte count written. */
export interface FountainWrite {
  exists: boolean;
  bytes: number;
}

export const anchorApi = {
  list: (c: McpClient) =>
    c.callTool<{ anchors: Anchor[] }>('anchor.list'),
  /** Generate a reference plate via fal (still image) and store it as a project
   *  anchor (character/location/style/image locking). Needs FAL_KEY in the
   *  sidecar env. `project_id` is optional — real-mcp injects the active project;
   *  pass it to be explicit. Resolves to the created Anchor. */
  generate: (
    c: McpClient,
    args: {
      project_id?: string;
      kind: 'character' | 'location' | 'style' | 'image';
      name: string;
      prompt: string;
      seed?: number;
      model?: string;
    },
  ) => c.callTool<Anchor>('anchor.generate', args),
  /** Create an anchor from a full Anchor record (no generation). */
  create: (c: McpClient, anchor: Anchor) =>
    c.callTool<Anchor>('anchor.create', { anchor }),
  /** Delete an anchor by id. */
  delete: (c: McpClient, anchor_id: string) =>
    c.callTool<{ anchorId: string }>('anchor.delete', { anchor_id }),
};

export const compositionApi = {
  // `cell_uid` scopes a render to a single cell (per-cell re-render / retry).
  // Omitting it renders the whole composition. The mock already keys off
  // `cell_uid`; the real WP-06 server honors the same arg.
  // `variant` threads the user's model pick (Canvas engine picker —
  // ltx-video / flux / flux-i2v for fal) through to the adapter: the fal
  // renderer's resolveVideoModel reads opts.variant first, so this is what
  // makes the picker's selection actually reach the generation call (H2).
  render: (c: McpClient, args: { project_id: string; cell_uid?: string; engine?: string; aspect_ratio?: AspectRatio; variant?: string; rung?: Rung }) =>
    c.callTool<{ record_id: string }>('composition.render', args),
  preview: (c: McpClient, args: { project_id: string; engine?: string }) =>
    c.callTool<{ preview_uri: string }>('composition.preview', args),
  validate: (c: McpClient, args: { project_id: string; engine?: string }) =>
    c.callTool<{ valid: boolean; diagnostics: Array<{ severity: 'error' | 'warn'; message: string }> }>('composition.validate', args),
};

/** Bytes-over-bridge preview payload (render/export → base64 → blob:). The
 *  `base64` may be empty in mock/standalone mode (no real mp4 on disk) — the
 *  caller falls back to the poster/status preview when so. */
export interface MediaBytes {
  base64: string;
  mime: string;
  sizeBytes: number;
  path: string;
}

/** Pre-flight audio-bed check (F7 silent-bed honesty). */
export interface BedCheck {
  has_bed: boolean;
  will_be_silent: boolean;
  by_design: boolean;
  path?: string;
}

export const renderApi = {
  list_engines: (c: McpClient) =>
    c.callTool<{ engines: EngineCapability[] }>('render.list_engines'),
  status:       (c: McpClient, record_id: string) =>
    c.callTool<RenderRecord>('render.status', { record_id }),
  cancel:       (c: McpClient, record_id: string) =>
    c.callTool<{ cancelled: boolean }>('render.cancel', { record_id }),
  list:         (c: McpClient, args?: { cell_uid?: string; status?: string }) =>
    c.callTool<{ records: RenderRecord[] }>('render.list', args ?? {}),
  read_bytes:   (c: McpClient, record_id: string) =>
    c.callTool<MediaBytes>('render.read_bytes', { record_id }),
  /** Read the poster PNG (extracted when the render finished) as base64 for a
   *  blob: thumbnail. Mirrors read_bytes; `base64` is empty in mock/standalone
   *  mode → caller falls back to the status-text preview. */
  read_poster:  (c: McpClient, record_id: string) =>
    c.callTool<MediaBytes>('render.read_poster', { record_id }),
  /** Attach a filmmaker's externally-produced clip (mp4/png on disk) to a cell
   *  as a done RenderRecord with manual provenance — the return leg of
   *  export.prompt_package. `project_id` optional (real-mcp injects the active
   *  project). Resolves to the created RenderRecord. */
  ingest_external: (
    c: McpClient,
    args: {
      project_id?: string;
      cell_id: string;
      file_path: string;
      engine: string;
      model_id?: string;
      cost_actual?: number;
    },
  ) => c.callTool<RenderRecord>('render.ingest_external', args),
};

export const blockApi = {
  list: (c: McpClient, args?: { kind?: Block['kind']; tags?: string[] }) =>
    c.callTool<{ blocks: Block[] }>('block.list', args ?? {}),
  get:  (c: McpClient, id: string) =>
    c.callTool<Block>('block.get', { id }),
  instantiate: (c: McpClient, args: { block_id: string; bindings: Record<string, unknown> }) =>
    c.callTool<{ beat: Beat; cells: Cell[] }>('block.instantiate', args),
};

export const archetypeApi = {
  list: (c: McpClient) =>
    c.callTool<{ archetypes: Archetype[] }>('archetype.list'),
  get:  (c: McpClient, id: string) =>
    c.callTool<Archetype>('archetype.get', { id }),
  instantiate_into_project: (c: McpClient, args: { archetype_id: string; bindings: Record<string, unknown> }) =>
    c.callTool<{ beats: Beat[]; cells: Cell[] }>('archetype.instantiate_into_project', args),
  save_custom: (c: McpClient, args: { archetype_id: string; name: string; chain: Array<{ block_id: string; bindings?: Record<string, unknown> }>; description: string }) =>
    c.callTool<{ archetype_id: string }>('archetype.save_custom', args),
};

export const exportApi = {
  compose: (c: McpClient, args: { project_id: string; rung?: Rung; music_preset?: string; output_path?: string }) =>
    c.callTool<{ export_id: string; export_path: string }>('export.compose', args),
  status:  (c: McpClient, export_id: string) =>
    c.callTool<ExportRecord>('export.status', { export_id }),
  list:    (c: McpClient) =>
    c.callTool<{ exports: ExportRecord[] }>('export.list'),
  read_bytes: (c: McpClient, export_id: string) =>
    c.callTool<MediaBytes>('export.read_bytes', { export_id }),
  check_bed:  (c: McpClient, args: { project_id: string; music_preset?: string }) =>
    c.callTool<BedCheck>('export.check_bed', args),
  /** Produce a platform-shaped prompt bundle for a target generator that has no
   *  API (Higgsfield / Google Flow / Veo / generic). Omit `cell_id` to package
   *  every cell. `project_id` optional (real-mcp injects the active project).
   *  Also writes prompts/<platform>/<cell_id|'all'>.json sidecar-side. */
  prompt_package: (
    c: McpClient,
    args: { project_id?: string; cell_id?: string; platform: PromptPackage['platform'] },
  ) => c.callTool<PromptPackage>('export.prompt_package', args),
};
