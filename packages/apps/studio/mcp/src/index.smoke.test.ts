// com.ikenga.studio MCP server · WP-32 poll-fallback test knob smoke test
//
//   bun run src/index.smoke.test.ts   (from mcp/, AFTER `bash build.sh`)
//
// The event-relay suppression gate (STUDIO_SUPPRESS_EVENTS) lives inside a
// closure over `sidecar.onEvent` in index.ts — there's no exported unit to
// import and drive directly without duplicating that wiring. So this spawns
// the real BUILT server (dist/index.js) as a child process, the way the MCP
// client does, points STUDIO_SIDECAR_PATH at a stub sidecar that emits real
// `{"jsonrpc":"2.0","method":"event",…}` frames, completes the MCP initialize
// handshake on stdin, and watches BOTH sides of the relay:
//
//   • stdout — does an outbound `notifications/message` frame appear?
//   • stderr — do the suppression-armed / dropped-frame lines appear?
//
// That combination is what makes the test bite: asserting only the startup
// line would stay green if the `return` in the relay body were deleted (every
// frame still forwarded, knob completely ineffective), which is precisely the
// failure the WP-32 DoD ("poll fallback verified when events are suppressed")
// must rule out.
//
// Three phases:
//   1. STUDIO_SUPPRESS_EVENTS=1 → armed line + "dropped event frame #1" line,
//      and NO notifications/message frame reaches the client.
//   2. env unset (default)      → no armed line, and a notifications/message
//      frame carrying the stub's event DOES reach the client.
//   3. STUDIO_SUPPRESS_EVENTS=true → knob OFF *and it says so* on stderr, with
//      events still flowing (a silently-ignored value would otherwise look
//      exactly like "the MCP never restarted").
//
// Both phases also assert the server actually reached `server.connect` (it
// answers `initialize` on stdout) and did not die on its own — so a crash on
// either path fails loudly instead of passing as "line absent".

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(HERE, '../dist/index.js');

const READY_LINE = /\[studio-mcp\] ready name=/;
const ARMED_LINE = /\[studio-mcp\] STUDIO_SUPPRESS_EVENTS=1 — event forwarding suppressed/;
const FIRST_DROP_LINE = /\[studio-mcp\] STUDIO_SUPPRESS_EVENTS=1 — dropped event frame #1 \(topic=/;
const MISSET_LINE = /\[studio-mcp\] STUDIO_SUPPRESS_EVENTS is set to ".*" — not the exact string "1"/;
const FATAL_LINE = /\[studio-mcp\] fatal:/;

/** Topic the stub sidecar stamps on every event frame — asserted end-to-end on
 * the forwarded notification so phase 2 can't pass on some unrelated frame. */
const STUB_TOPIC = 'smoke/heartbeat';
const STUB_PROJECT_ID = 'smoke-project';

/** Overall per-phase budget before the phase is declared failed. */
const PHASE_TIMEOUT_MS = 20_000;
/** After the phase's success condition is met, keep listening this long — a
 * broken suppression forwards asynchronously, just after the drop line. */
const SETTLE_MS = 750;
/** SIGTERM → SIGKILL → give-up ladder, so a child that ignores signals fails
 * the test instead of hanging it forever. */
const SIGKILL_AFTER_MS = 3_000;
const EXIT_GIVEUP_MS = 8_000;

/** A stand-in for the project sidecar: speaks just enough of the wire format
 * (line-delimited JSON-RPC on stdout) to drive the MCP's event relay. Written
 * to a temp dir at test time; `node`/`bun` runs it as the MCP's child. */
const STUB_SIDECAR_SOURCE = `
// studio MCP smoke-test stub sidecar — emits event notifications, nothing else.
let n = 0;
const timer = setInterval(() => {
  n += 1;
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        topic: ${JSON.stringify(STUB_TOPIC)},
        projectId: ${JSON.stringify(STUB_PROJECT_ID)},
        payload: { n },
        ts: Date.now(),
      },
    }) + '\\n',
  );
  if (n >= 400) clearInterval(timer);
}, 150);
// Exit when the parent closes our stdin (SidecarClient.stop) or goes away.
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
// Backstop so a stranded stub never outlives the test run.
setTimeout(() => process.exit(0), 60_000).unref?.();
`;

interface PhaseResult {
  stdout: string;
  stderr: string;
  /** The server answered `initialize` → it got past `server.connect`. */
  initialized: boolean;
  /** Outbound `notifications/message` frames from the event relay. */
  relayNotifications: Array<{ logger?: string; data?: { topic?: string; projectId?: string } }>;
}

/**
 * Spawn the built server against the stub sidecar, run the MCP handshake, and
 * watch stdout+stderr until `until(state)` is true (then settle briefly and
 * shut down) or the phase budget expires.
 */
async function runPhase(
  env: NodeJS.ProcessEnv,
  stubPath: string,
  until: (s: PhaseResult) => boolean,
): Promise<PhaseResult> {
  return new Promise<PhaseResult>((resolvePromise, reject) => {
    // dist/index.js is bundled with --target=bun (see build.sh) — run it with
    // `bun`, not `node`, to match how it's actually invoked.
    const child = spawn('bun', [SERVER_PATH], {
      env: { ...process.env, ...env, STUDIO_SIDECAR_PATH: stubPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const state: PhaseResult = { stdout: '', stderr: '', initialized: false, relayNotifications: [] };
    let handshakeSent = false;
    let shuttingDown = false;
    let settled = false;
    let stdoutBuf = '';

    let phaseTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;

    const clearAll = () => {
      for (const t of [phaseTimer, settleTimer, sigkillTimer, exitTimer]) if (t) clearTimeout(t);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearAll();
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearAll();
      resolvePromise(state);
    };

    // Kill ladder: SIGTERM → SIGKILL → fail. Note the previous version cleared
    // its only timer *before* killing, so a child that never exited hung the
    // run forever with no output; every path below stays guarded until `exit`.
    const beginShutdown = () => {
      if (shuttingDown || settled) return;
      shuttingDown = true;
      if (phaseTimer) clearTimeout(phaseTimer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      sigkillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, SIGKILL_AFTER_MS);
      exitTimer = setTimeout(
        () => fail(new Error(`server did not exit after SIGTERM/SIGKILL; stderr:\n${state.stderr}`)),
        EXIT_GIVEUP_MS,
      );
    };

    const check = () => {
      if (shuttingDown || settleTimer) return;
      if (until(state)) settleTimer = setTimeout(beginShutdown, SETTLE_MS);
    };

    phaseTimer = setTimeout(() => {
      // Not satisfied in time: shut the child down, then fail with what we saw.
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      fail(
        new Error(
          `phase condition not met within ${PHASE_TIMEOUT_MS}ms\nstderr:\n${state.stderr}\nstdout:\n${state.stdout}`,
        ),
      );
    }, PHASE_TIMEOUT_MS);

    child.stderr.on('data', (b: Buffer) => {
      state.stderr += b.toString();
      if (!handshakeSent && READY_LINE.test(state.stderr)) {
        handshakeSent = true;
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'studio-smoke-test', version: '0.0.0' },
            },
          }) + '\n',
        );
      }
      check();
    });

    child.stdout.on('data', (b: Buffer) => {
      state.stdout += b.toString();
      stdoutBuf += b.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
        if (msg.id === 1 && 'result' in msg) {
          state.initialized = true;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        }
        if (msg.method === 'notifications/message') {
          state.relayNotifications.push(msg.params as PhaseResult['relayNotifications'][number]);
        }
      }
      check();
    });

    // Writing the handshake into a child that is already going away is not a
    // test failure — swallow EPIPE rather than letting it become an unhandled
    // stream error.
    child.stdin.on('error', () => { /* ignore */ });
    child.on('error', (err) => fail(err));

    child.on('exit', (code, signal) => {
      if (settled) return;
      if (!shuttingDown) {
        // Died on its own — never report "line absent" for a server that
        // crashed before (or inside) server.connect.
        fail(
          new Error(
            `server exited unexpectedly (code=${code} signal=${signal}) before the phase condition was met\nstderr:\n${state.stderr}`,
          ),
        );
        return;
      }
      succeed();
    });
  });
}

function relayEventNotifications(s: PhaseResult) {
  return s.relayNotifications.filter((p) => p?.data?.topic === STUB_TOPIC);
}

async function main() {
  assert.ok(
    existsSync(SERVER_PATH),
    `${SERVER_PATH} not found — run \`bash build.sh\` (or \`bun run build:mcp\` from the studio pkg root) first`,
  );

  const tmp = mkdtempSync(join(tmpdir(), 'studio-mcp-smoke-'));
  const stubPath = join(tmp, 'stub-sidecar.mjs');
  writeFileSync(stubPath, STUB_SIDECAR_SOURCE, 'utf8');

  try {
    // ── Phase 1: STUDIO_SUPPRESS_EVENTS=1 ────────────────────────────────
    // Wait until a frame has demonstrably reached the relay (the drop line),
    // then settle — so "no notification" means "dropped", not "none arrived".
    const suppressed = await runPhase(
      { STUDIO_SUPPRESS_EVENTS: '1' },
      stubPath,
      (s) => s.initialized && FIRST_DROP_LINE.test(s.stderr),
    );
    assert.ok(suppressed.initialized, `server never answered initialize; stderr:\n${suppressed.stderr}`);
    assert.ok(READY_LINE.test(suppressed.stderr), `no ready banner; stderr:\n${suppressed.stderr}`);
    assert.ok(!FATAL_LINE.test(suppressed.stderr), `server logged a fatal; stderr:\n${suppressed.stderr}`);
    assert.ok(
      ARMED_LINE.test(suppressed.stderr),
      `expected suppression-armed startup line with STUDIO_SUPPRESS_EVENTS=1, got:\n${suppressed.stderr}`,
    );
    assert.ok(
      FIRST_DROP_LINE.test(suppressed.stderr),
      `expected a first-dropped-frame line with STUDIO_SUPPRESS_EVENTS=1, got:\n${suppressed.stderr}`,
    );
    assert.equal(
      relayEventNotifications(suppressed).length,
      0,
      `expected NO forwarded event notifications while suppressed, got ${
        relayEventNotifications(suppressed).length
      }:\n${suppressed.stdout}`,
    );

    // ── Phase 2: default (unset) ─────────────────────────────────────────
    // Positive assertion: the same stub frame must arrive as an outbound
    // notifications/message, proving the relay is live by default.
    const dflt = await runPhase(
      { STUDIO_SUPPRESS_EVENTS: undefined },
      stubPath,
      (s) => s.initialized && relayEventNotifications(s).length > 0,
    );
    assert.ok(dflt.initialized, `server never answered initialize; stderr:\n${dflt.stderr}`);
    assert.ok(READY_LINE.test(dflt.stderr), `no ready banner; stderr:\n${dflt.stderr}`);
    assert.ok(!FATAL_LINE.test(dflt.stderr), `server logged a fatal; stderr:\n${dflt.stderr}`);
    assert.ok(
      !ARMED_LINE.test(dflt.stderr),
      `did not expect suppression line with STUDIO_SUPPRESS_EVENTS unset, got:\n${dflt.stderr}`,
    );
    assert.ok(
      !FIRST_DROP_LINE.test(dflt.stderr),
      `did not expect a dropped-frame line with STUDIO_SUPPRESS_EVENTS unset, got:\n${dflt.stderr}`,
    );
    const forwarded = relayEventNotifications(dflt);
    assert.ok(
      forwarded.length > 0,
      `expected at least one forwarded event notification by default, got none:\n${dflt.stdout}`,
    );
    assert.equal(forwarded[0]?.logger, 'studio-mcp/sidecar-event');
    assert.equal(forwarded[0]?.data?.projectId, STUB_PROJECT_ID);

    // ── Phase 3: set, but not the exact string "1" ───────────────────────
    // The knob is off — and must say so, because a silently-absent armed line
    // is indistinguishable from "the MCP never restarted".
    const misset = await runPhase(
      { STUDIO_SUPPRESS_EVENTS: 'true' },
      stubPath,
      (s) => s.initialized && relayEventNotifications(s).length > 0,
    );
    assert.ok(
      MISSET_LINE.test(misset.stderr),
      `expected an "is set to … not the exact string 1" line for STUDIO_SUPPRESS_EVENTS=true, got:\n${misset.stderr}`,
    );
    assert.ok(!ARMED_LINE.test(misset.stderr), `unexpected armed line for =true:\n${misset.stderr}`);
    assert.ok(
      relayEventNotifications(misset).length > 0,
      `expected events to keep flowing for STUDIO_SUPPRESS_EVENTS=true, got none:\n${misset.stdout}`,
    );

    console.log(
      `ok - index.smoke.test.ts (STUDIO_SUPPRESS_EVENTS: suppressed drops frames; default forwarded ${forwarded.length}; non-"1" value reported OFF)`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
