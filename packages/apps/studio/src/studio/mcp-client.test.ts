// com.ikenga.studio · MCP client transport tests (the IMPURE half of G-105)
//
//   bun run src/studio/mcp-client.test.ts   (from packages/apps/studio/)
//
// Plain assert-based script (no bun:test / node:test import) so it typechecks
// under `tsc -p tsconfig.web.json` alongside the rest of `src/`, same rationale
// as lib/mcp-probe.test.ts.
//
// lib/mcp-probe.test.ts covers the pure decision machine. What is under test
// HERE is the part that machine cannot reach: the degraded → real UPGRADE EDGE,
// which is where the ordering bugs live.
//
//   • the real client must have the project OPEN before it becomes the
//     session's transport — promoting it first published `phase: 'real'` while
//     every project-scoped call threw `no open project`, and a FAILED re-open
//     stranded the session there for good (no re-probe arms on `real`);
//   • a view that cached the client in a ref must not keep talking to the mock
//     after the swap (the Launcher's create path would `project.create` against
//     the fixture and paint a header for a project that exists nowhere);
//   • the storyboard must be re-read with the REAL project id, never the mock
//     one;
//   • a single `absent` verdict must not latch demo mode for the session;
//   • a burst of view calls while degraded must not fan out into concurrent
//     probes;
//   • a permanently dead server must not republish iyke state every tick.
//
// The transports are injected via `__setMcpTransports` (TEST/DEV-only seam)
// because the real edge needs a shell, an AppBridge handshake and a supervised
// sidecar to happen at all — it was only ever observed live, by hand (G-105).

import assert from 'node:assert/strict';

import {
  __resetMcpClient,
  __setMcpTransports,
  __setProbePolicy,
  getMcpClient,
  getMcpConnectionState,
  getProbedEngines,
  subscribeMcpConnection,
  type McpClient,
} from './mcp-client';
import { openProjectByPath } from './lib/open-project';
import type { McpConnectionPhase } from './lib/mcp-probe';
import { useProjectStore } from './project-store';
import { useStoryboardStore } from './storyboard-store';
import type { StudioEventName, StudioEventPayloadMap } from './mcp-types';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`  FAIL  ${name}\n        ${(err as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(what: string, pred: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${what} (phase=${getMcpConnectionState().phase} reason=${getMcpConnectionState().reason})`);
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** The exact wording the shell answers when a per-call manifest read finds no
 *  mcp block (pkg_mcp.rs) — the verdict that used to latch on sight. */
const ABSENT_ERROR = new Error(
  '[studio] render.list_engines: non-JSON MCP result: pkg `com.ikenga.studio` declares no mcp servers',
);
const TRANSIENT_ERROR = new Error('mcp-probe-timeout');

// ─── fake transports ────────────────────────────────────────────────────

interface RecordedCall {
  name: string;
  /** The connection phase AT THE MOMENT the transport was called. This is what
   *  makes the ordering assertion possible. */
  phase: McpConnectionPhase;
  args?: Record<string, unknown>;
}

class FakeReal implements McpClient {
  readonly mode = 'real' as const;
  calls: RecordedCall[] = [];
  /** Non-null ⇒ every `render.list_engines` probe throws this. */
  probeError: Error | null = TRANSIENT_ERROR;
  /** Non-null ⇒ the probe blocks on it (concurrency test). */
  probeBlocker: Promise<void> | null = null;
  enginesResult: unknown = { engines: [{ id: 'fal', label: 'fal.ai' }] };
  /** Non-null ⇒ `project.open` throws this (moved folder / revoked grant). */
  openError: Error | null = null;
  openBlocker: Promise<void> | null = null;
  /** Set by a successful project.open — mirrors real-mcp.ts's `active`. */
  active: string | null = null;
  subscribeCount = 0;
  unsubscribeCount = 0;

  async callTool<TResult = unknown>(name: string, args?: Record<string, unknown>): Promise<TResult> {
    this.calls.push({ name, phase: getMcpConnectionState().phase, args });
    if (name === 'render.list_engines') {
      if (this.probeBlocker) await this.probeBlocker;
      if (this.probeError) throw this.probeError;
      return this.enginesResult as TResult;
    }
    if (name === 'project.open') {
      if (this.openBlocker) await this.openBlocker;
      if (this.openError) throw this.openError;
      this.active = String(args?.path ?? '');
      return { project_id: 'real-1' } as TResult;
    }
    if (name === 'project.info') {
      return { title: 'Real Project', archetype_id: 'musicvideo', aspect_ratio: '16:9' } as TResult;
    }
    // Everything else is project-scoped, exactly like real-mcp.ts.
    if (!this.active) {
      throw new Error(`[studio] ${name}: no open project (call project.open/create first)`);
    }
    if (name === 'storyboard.read') {
      return { project: null, beats: [], cells: [{ uid: 'real-cell' }] } as TResult;
    }
    if (name === 'render.list') return { records: [] } as TResult;
    return {} as TResult;
  }

  subscribe<E extends StudioEventName>(
    _event: E,
    _handler: (payload: StudioEventPayloadMap[E]) => void,
  ): () => void {
    this.subscribeCount += 1;
    return () => {
      this.unsubscribeCount += 1;
    };
  }

  named(name: string): RecordedCall[] {
    return this.calls.filter((c) => c.name === name);
  }
}

class FakeMock implements McpClient {
  readonly mode = 'mock' as const;
  calls: string[] = [];
  subscribeCount = 0;
  unsubscribeCount = 0;

  async callTool<TResult = unknown>(name: string, _args?: Record<string, unknown>): Promise<TResult> {
    this.calls.push(name);
    // The mock accepts ANY path — that is how a fixture project ends up in the
    // store during a degraded session in the first place.
    if (name === 'project.open') return { project_id: 'mock-1' } as TResult;
    if (name === 'project.info') return {} as TResult;
    if (name === 'storyboard.read') {
      return { project: null, beats: [], cells: [{ uid: 'mock-cell' }] } as TResult;
    }
    if (name === 'render.list_engines') return { engines: [] } as TResult;
    return {} as TResult;
  }

  subscribe<E extends StudioEventName>(
    _event: E,
    _handler: (payload: StudioEventPayloadMap[E]) => void,
  ): () => void {
    this.subscribeCount += 1;
    return () => {
      this.unsubscribeCount += 1;
    };
  }
}

// ─── harness ────────────────────────────────────────────────────────────

interface Harness {
  real: FakeReal;
  mock: FakeMock;
  /** The client a view would cache in a ref while degraded. */
  client: McpClient;
}

/** Boot a session that has already fallen back to demo data with a background
 *  re-probe armed — the state a pkg reload leaves behind (G-105). */
async function degradedSession(): Promise<Harness> {
  __resetMcpClient();
  __setMcpTransports(null);
  useProjectStore.getState().closeProject();
  useStoryboardStore.getState().clear();
  const real = new FakeReal();
  const mock = new FakeMock();
  __setMcpTransports({ inShell: true, real, mock, serverPresent: true });
  __setProbePolicy({
    // Small window + tight backoff so the fallback lands in a couple of ms,
    // but a per-attempt timeout big enough that a deliberately GATED probe (the
    // concurrency test) is not cut short by `withTimeout` and mistaken for a
    // second probe.
    windowMs: 12,
    timeoutMs: 500,
    backoffMs: [1],
    reprobeMs: 4,
    absentRecheckMs: 1,
  });
  const client = await getMcpClient();
  assert.equal(getMcpConnectionState().phase, 'degraded', 'expected the demo fallback');
  assert.equal(client.mode, 'mock');
  return { real, mock, client };
}

/** What App.tsx's optimistic resume does while degraded: open the persisted
 *  path (the MOCK accepts it) and hydrate the storyboard from the fixture. */
async function resumeAgainstTheMock(): Promise<void> {
  await openProjectByPath('C:/Users/nedJamez/Projects/wp32-verify', 'wp32-verify');
  assert.equal(useProjectStore.getState().project?.project_id, 'mock-1');
  await useStoryboardStore.getState().hydrate('mock-1');
  assert.equal(useStoryboardStore.getState().cells[0]?.uid, 'mock-cell');
}

function cleanup(): void {
  __setMcpTransports(null);
  __setProbePolicy();
  __resetMcpClient();
  useProjectStore.getState().closeProject();
  useStoryboardStore.getState().clear();
}

// ─── the upgrade edge ───────────────────────────────────────────────────

await test('upgrade: the project is opened on the real client BEFORE the phase flips', async () => {
  const { real } = await degradedSession();
  await resumeAgainstTheMock();

  real.probeError = null; // the supervised server finished booting
  void getMcpClient(); // a view asking for a client while degraded nudges the re-probe
  await waitFor('phase real', () => getMcpConnectionState().phase === 'real');

  const opens = real.named('project.open');
  assert.equal(opens.length, 1, 'the upgrade re-opens exactly once');
  assert.equal(
    opens[0]?.phase,
    'degraded',
    'project.open must land BEFORE the swap — a real transport with no active project throws on every project-scoped call',
  );
  assert.equal(useProjectStore.getState().project?.project_id, 'real-1');
  assert.equal(useProjectStore.getState().project?.name, 'Real Project');
  cleanup();
});

await test('upgrade: a client cached in a ref while degraded routes to the real transport after it', async () => {
  const { real, client } = await degradedSession();
  await resumeAgainstTheMock();

  real.probeError = null;
  void getMcpClient();
  await waitFor('phase real', () => getMcpConnectionState().phase === 'real');

  // This is the Launcher/ArchetypeBuilder pattern: `clientRef.current` was
  // captured while degraded and is never re-read.
  assert.equal(client.mode, 'real', 'the cached ref must report the live mode');
  assert.equal(client, await getMcpClient(), 'the handed-out client is stable across the swap');
  const before = real.calls.length;
  await client.callTool('render.list');
  assert.equal(real.calls.length, before + 1, 'the call went to the real transport');
  cleanup();
});

await test('upgrade: a project-scoped call issued mid-upgrade waits for the open instead of throwing', async () => {
  const { real, client } = await degradedSession();
  await resumeAgainstTheMock();

  const gate = deferred();
  real.openBlocker = gate.promise;
  real.probeError = null;
  void getMcpClient();
  await waitFor('project.open in flight', () => real.named('project.open').length === 1);

  // A CellPoster fetch / a user click landing in the upgrade window.
  const inFlight = client.callTool('render.list', { probe: 'mid-upgrade' });
  await sleep(5);
  gate.release();
  await inFlight; // must not reject with "no open project"

  const names = real.calls.map((c) => c.name);
  assert.ok(
    names.indexOf('render.list') > names.indexOf('project.open'),
    `expected the queued call after the open, got ${names.join(',')}`,
  );
  cleanup();
});

await test('upgrade: the storyboard is re-read with the REAL project id, never the mock one', async () => {
  const { real } = await degradedSession();
  await resumeAgainstTheMock();

  real.probeError = null;
  void getMcpClient();
  await waitFor(
    'storyboard hydrated from the real client',
    () => useStoryboardStore.getState().projectId === 'real-1',
  );

  const reads = real.named('storyboard.read');
  assert.ok(reads.length >= 1, 'the real client was asked for the storyboard');
  assert.ok(
    !reads.some((c) => c.args?.project_id === 'mock-1'),
    'a storyboard.read for the mock id would be rejected by the sidecar and park an error in the store',
  );
  assert.equal(useStoryboardStore.getState().cells[0]?.uid, 'real-cell');
  assert.equal(useStoryboardStore.getState().error, null, 'no stale error survives the upgrade');
  assert.equal(useStoryboardStore.getState().source, 'real');
  cleanup();
});

await test('upgrade: a failed re-open keeps serving demo data, honestly labelled, and retries', async () => {
  const { real, client } = await degradedSession();
  await resumeAgainstTheMock();

  real.openError = new Error('[studio] project.open failed: ENOENT');
  real.probeError = null;
  void getMcpClient();
  await waitFor(
    'the re-open failure to surface',
    () => getMcpConnectionState().reason === 'project-reopen-failed',
  );
  assert.equal(getMcpConnectionState().phase, 'degraded', 'must NOT promote a client with no open project');
  assert.equal(client.mode, 'mock', 'the fixture keeps serving until the real client has the project');
  assert.match(getMcpConnectionState().message, /could not be re-opened/);
  cleanup();
});

await test('upgrade: a persistently unopenable project is forgotten rather than faked forever', async () => {
  const { real } = await degradedSession();
  await resumeAgainstTheMock();

  // e.g. the path came from a MOCK recents row and names nothing on disk:
  // staying degraded forever would be its own mock-lock.
  real.openError = new Error('[studio] project.open failed: ENOENT');
  real.probeError = null;
  void getMcpClient();
  await waitFor('phase real after the bounded retry', () => getMcpConnectionState().phase === 'real', 5_000);
  assert.ok(real.named('project.open').length >= 2, 'the re-open was retried before giving up');
  assert.equal(useProjectStore.getState().project, null, 'no phantom project in the header');
  assert.equal(useProjectStore.getState().isOpen, false);
  assert.equal(useStoryboardStore.getState().projectId, null);
  cleanup();
});

await test('upgrade: event subscriptions are re-bound onto the new transport', async () => {
  const { real, mock, client } = await degradedSession();
  const off = client.subscribe('cells/changed', () => {});
  assert.equal(mock.subscribeCount, 1, 'bound to the transport that was live');
  assert.equal(real.subscribeCount, 0);

  real.probeError = null;
  void getMcpClient();
  await waitFor('phase real', () => getMcpConnectionState().phase === 'real');

  assert.equal(mock.unsubscribeCount, 1, "the mock's synthetic emitter is dropped");
  assert.equal(real.subscribeCount, 1, 'the subscription now hears the real server');
  off();
  assert.equal(real.unsubscribeCount, 1, 'unsubscribing still reaches the current transport');
  cleanup();
});

// ─── absent is recoverable ──────────────────────────────────────────────

await test('a SINGLE absent verdict on a background re-probe does not latch demo mode', async () => {
  const { real } = await degradedSession();
  real.probeError = ABSENT_ERROR;
  void getMcpClient();
  await waitFor('the absent verdict', () => getMcpConnectionState().reason === 'absent');
  assert.equal(
    getMcpConnectionState().phase,
    'degraded',
    'one per-call manifest read must not be a one-way door to the fixture',
  );

  // …and the session recovers on its own once the manifest reload settles.
  real.probeError = null;
  void getMcpClient();
  await waitFor('phase real', () => getMcpConnectionState().phase === 'real');
  cleanup();
});

await test('two consecutive absent verdicts DO latch, and stop the probing', async () => {
  const { real } = await degradedSession();
  real.probeError = ABSENT_ERROR;
  void getMcpClient();
  await waitFor('phase demo', () => getMcpConnectionState().phase === 'demo');
  const settled = real.named('render.list_engines').length;
  await sleep(20); // several reprobeMs ticks
  assert.equal(real.named('render.list_engines').length, settled, 'latched demo mode stops probing');
  cleanup();
});

// ─── probe hygiene ──────────────────────────────────────────────────────

await test('a burst of view calls while degraded does not fan out into concurrent probes', async () => {
  const { real } = await degradedSession();
  const gate = deferred();
  real.probeBlocker = gate.promise;
  real.probeError = null;
  const baseline = real.named('render.list_engines').length;

  // Mounting Composition while degraded: one getMcpClient() per CellPoster.
  await waitFor('a probe in flight', () => real.named('render.list_engines').length === baseline + 1);
  for (let i = 0; i < 6; i += 1) void getMcpClient();
  await sleep(10);
  assert.equal(
    real.named('render.list_engines').length,
    baseline + 1,
    'the in-flight probe must absorb the burst (the timer handle is not an in-flight flag)',
  );
  gate.release();
  real.probeBlocker = null;
  await waitFor('phase real', () => getMcpConnectionState().phase === 'real');
  cleanup();
});

await test('a dead server does not republish connection state on every re-probe tick', async () => {
  const { real } = await degradedSession();
  let notifications = 0;
  const off = subscribeMcpConnection(() => {
    notifications += 1;
  });
  const probesBefore = real.named('render.list_engines').length;
  await sleep(30); // ~7 reprobeMs ticks against a permanently dead server
  assert.ok(
    real.named('render.list_engines').length > probesBefore + 1,
    'the re-probe kept trying (that part is the point)',
  );
  assert.equal(notifications, 0, 'nothing user-visible changed, so nothing was published');
  off();
  cleanup();
});

await test('the probed-engines cache stays null when the answer carries no engines array', async () => {
  const { real } = await degradedSession();
  real.enginesResult = {}; // envelope drift: a result without `engines`
  real.probeError = null;
  void getMcpClient();
  await waitFor('phase real', () => getMcpConnectionState().phase === 'real');
  assert.equal(
    getProbedEngines(),
    null,
    'an empty array here is truthy and would make the Launcher skip its own fetch, dropping the engine rail',
  );
  cleanup();
});

await test('the probed-engines cache carries the probe result when there is one', async () => {
  const { real } = await degradedSession();
  real.probeError = null;
  void getMcpClient();
  await waitFor('phase real', () => getMcpConnectionState().phase === 'real');
  assert.equal(getProbedEngines()?.length, 1);
  cleanup();
});

if (failures.length > 0) {
  console.log(`\n${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
