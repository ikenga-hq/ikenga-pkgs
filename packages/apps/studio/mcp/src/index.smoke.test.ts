// com.ikenga.studio MCP server · WP-32 poll-fallback test knob smoke test
//
//   bun run src/index.smoke.test.ts   (from mcp/, AFTER `bash build.sh`)
//
// Runs against `../dist/index.js` by default. Set STUDIO_MCP_SERVER_PATH to
// point it at a bundle built somewhere else — needed whenever mcp/dist is in
// use (a live verification round driving the shell from it, say) and must not
// be rewritten just to run this test.
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
// Four phases:
//   1. STUDIO_SUPPRESS_EVENTS=1 → armed line + "dropped event frame #1" line,
//      the every-10 running count (G-108: the old every-50 cadence printed
//      nothing on a realistic ~12-frame run), and NO notifications/message
//      frame reaches the client. On POSIX it also asserts the SIGTERM census
//      line; on Windows it cannot — see SIGNALS_DELIVERABLE below.
//   2. env unset (default)      → no armed line, and a notifications/message
//      frame carrying the stub's event DOES reach the client.
//   3. STUDIO_SUPPRESS_EVENTS=true → knob OFF *and it says so* on stderr, with
//      events still flowing (a silently-ignored value would otherwise look
//      exactly like "the MCP never restarted").
//   4. (G-108) stdin EOF, no signal ever sent — the test closes the server's
//      own stdin and requires the process to leave on its own with the census
//      attributed to "stdin EOF". This is the kernel's reload path reproduced:
//      `lifecycle.rs`'s shutdown branch drops the stdin channel and then drops
//      the child handle (kill_on_drop → TerminateProcess / SIGKILL, no grace),
//      so stdin EOF is the ONLY notice the server gets. Neither the signal
//      handlers nor the 'beforeExit'/'exit' backstop can cover that, which is
//      why the census now hangs off stdin 'end' / transport close.
//
// All four phases also assert the server actually reached `server.connect` (it
// answers `initialize` on stdout) and did not die on its own — so a crash on
// either path fails loudly instead of passing as "line absent".

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = process.env.STUDIO_MCP_SERVER_PATH
  ? resolve(process.env.STUDIO_MCP_SERVER_PATH)
  : resolve(HERE, '../dist/index.js');

/**
 * The built bundle is `--target=bun` (see build.sh), so it has to run under
 * bun. Prefer THIS process's own interpreter when the test itself is running
 * under bun (which is how it's documented to be run): on Windows `bun` on
 * PATH is an npm shell shim, so `spawn('bun', …)` makes the real server a
 * grandchild of a wrapper — its 'close' event then may never arrive and its
 * final stderr chunk (the census line, the last thing it writes) gets
 * truncated. `process.execPath` is bun.exe itself, no wrapper in between.
 */
const BUN_BIN =
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? process.execPath : 'bun';

/**
 * `child.kill('SIGTERM')` on Windows is TerminateProcess — the child's JS
 * signal handlers never run, so nothing the SIGTERM path prints (including
 * the census) is assertable there. Phase 4's stdin-EOF path covers the same
 * census on every platform, and is the path the kernel reload actually takes.
 */
const SIGNALS_DELIVERABLE = process.platform !== 'win32';

const READY_LINE = /\[studio-mcp\] ready name=/;
const ARMED_LINE = /\[studio-mcp\] STUDIO_SUPPRESS_EVENTS=1 — event forwarding suppressed/;
const FIRST_DROP_LINE = /\[studio-mcp\] STUDIO_SUPPRESS_EVENTS=1 — dropped event frame #1 \(topic=/;
/** G-108: the running count must print every 10 dropped frames. A realistic
 * 5-cell run emits ~12 event frames, so an every-50 cadence yields no count
 * line at all and the frame-#1 line is the only drop witness. */
const RUNNING_COUNT_LINE =
  /\[studio-mcp\] STUDIO_SUPPRESS_EVENTS=1 — dropped 10 event frame\(s\) so far/;
const MISSET_LINE = /\[studio-mcp\] STUDIO_SUPPRESS_EVENTS is set to ".*" — not the exact string "1"/;
const FATAL_LINE = /\[studio-mcp\] fatal:/;

/**
 * G-108: the shutdown census line ("dropped N event frame(s) total this
 * session") must appear on every exit path this process can actually observe,
 * not just a clean SIGTERM/SIGINT. The reason prefix is captured so callers
 * can tell which path printed it — "received SIGTERM"/"received SIGINT" for
 * the signal handlers, "stdin EOF" for the transport-closed path the kernel
 * reload takes, "beforeExit"/"exit" for the backstops.
 */
const CENSUS_LINE =
  /\[studio-mcp\] (received SIGTERM|received SIGINT|stdin EOF|beforeExit|exit) — dropped (\d+) event frame\(s\) total this session/;
/** Phase 4: the census must be attributed to stdin EOF *and* carry a non-zero
 * count — a "dropped 0" line would pass a presence-only check while proving
 * nothing about frames actually being counted up to the teardown. */
const EOF_CENSUS_LINE =
  /\[studio-mcp\] stdin EOF — dropped [1-9]\d* event frame\(s\) total this session/;
const ANY_SIGNAL_LINE = /\[studio-mcp\] received SIG(TERM|INT)/;

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
/** stdin-EOF mode: how long the server gets to leave on its own after its
 * stdin closes before the phase is declared failed. The server's own failsafe
 * is 4 s (SHUTDOWN_GIVEUP_MS in index.ts), so this has to clear that. */
const EOF_EXIT_GIVEUP_MS = 10_000;
/** After 'exit' fires, wait this long for 'close' (all stdio drained) before
 * resolving anyway. The census is the LAST thing the child writes, so
 * resolving on 'exit' alone can read a truncated stderr; but 'close' is not
 * guaranteed to arrive at all if anything else holds the pipe. */
const CLOSE_GRACE_MS = 1_500;

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
  /** Process exit code / signal, so a phase can assert a *clean* exit rather
   * than accepting any death that happened to print the right line. */
  exitCode: number | null;
  exitSignal: string | null;
}

/**
 * How the phase ends the server once its condition is met:
 *   'signal'    — SIGTERM → SIGKILL ladder (the classic teardown).
 *   'stdin-eof' — close the server's stdin and NEVER signal it, then require
 *                 it to exit on its own. This is the kernel's reload path:
 *                 `tear_down_active()` drops the stdin channel, and the hard
 *                 kill that follows leaves no other in-process notice.
 */
type ShutdownMode = 'signal' | 'stdin-eof';

/**
 * Spawn the built server against the stub sidecar, run the MCP handshake, and
 * watch stdout+stderr until `until(state)` is true (then settle briefly and
 * shut down per `mode`) or the phase budget expires.
 */
async function runPhase(
  env: NodeJS.ProcessEnv,
  stubPath: string,
  until: (s: PhaseResult) => boolean,
  mode: ShutdownMode = 'signal',
): Promise<PhaseResult> {
  return new Promise<PhaseResult>((resolvePromise, reject) => {
    // dist/index.js is bundled with --target=bun (see build.sh) — run it with
    // bun, not node, to match how it's actually invoked.
    const child = spawn(BUN_BIN, [SERVER_PATH], {
      env: { ...process.env, ...env, STUDIO_SIDECAR_PATH: stubPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const state: PhaseResult = {
      stdout: '',
      stderr: '',
      initialized: false,
      relayNotifications: [],
      exitCode: null,
      exitSignal: null,
    };
    let handshakeSent = false;
    let shuttingDown = false;
    let settled = false;
    let exited = false;
    let closed = false;
    let stdoutBuf = '';

    let phaseTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    let closeGraceTimer: NodeJS.Timeout | undefined;

    const clearAll = () => {
      for (const t of [phaseTimer, settleTimer, sigkillTimer, exitTimer, closeGraceTimer]) {
        if (t) clearTimeout(t);
      }
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

    // 'signal' mode — kill ladder: SIGTERM → SIGKILL → fail. Note the previous
    // version cleared its only timer *before* killing, so a child that never
    // exited hung the run forever with no output; every path below stays
    // guarded until `exit`.
    // 'stdin-eof' mode — no signal is ever sent (that is the whole point of
    // phase 4), so the ladder is replaced by a single deadline: the server
    // must leave on its own, or the phase fails.
    const beginShutdown = () => {
      if (shuttingDown || settled) return;
      shuttingDown = true;
      if (phaseTimer) clearTimeout(phaseTimer);
      if (mode === 'signal') {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        sigkillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, SIGKILL_AFTER_MS);
        exitTimer = setTimeout(
          () => fail(new Error(`server did not exit after SIGTERM/SIGKILL; stderr:\n${state.stderr}`)),
          EXIT_GIVEUP_MS,
        );
        return;
      }
      try { child.stdin.end(); } catch { /* already gone */ }
      exitTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        fail(
          new Error(
            `server did not exit on its own within ${EOF_EXIT_GIVEUP_MS}ms of stdin EOF — the ` +
              `transport-closed shutdown path (the one the kernel reload takes) never ran; stderr:\n${state.stderr}`,
          ),
        );
      }, EOF_EXIT_GIVEUP_MS);
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

    // Resolve on 'close' (every stdio stream drained), not on 'exit': the
    // census line is the LAST thing the child writes, so resolving on 'exit'
    // can read a stderr that is still missing its final chunk. 'close' is not
    // guaranteed to arrive, though (anything else holding the pipe delays it
    // indefinitely), so 'exit' arms a short grace timer as a backstop.
    child.on('exit', (code, signal) => {
      exited = true;
      state.exitCode = code;
      state.exitSignal = signal;
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
      if (closed) succeed();
      else if (!closeGraceTimer) closeGraceTimer = setTimeout(succeed, CLOSE_GRACE_MS);
    });

    child.on('close', () => {
      closed = true;
      if (settled || !shuttingDown) return;
      if (exited) succeed();
    });
  });
}

function relayEventNotifications(s: PhaseResult) {
  return s.relayNotifications.filter((p) => p?.data?.topic === STUB_TOPIC);
}

async function main() {
  assert.ok(
    existsSync(SERVER_PATH),
    `${SERVER_PATH} not found — run \`bash build.sh\` (or \`bun run build:mcp\` from the studio pkg ` +
      `root) first, or point STUDIO_MCP_SERVER_PATH at a bundle built elsewhere`,
  );

  const tmp = mkdtempSync(join(tmpdir(), 'studio-mcp-smoke-'));
  const stubPath = join(tmp, 'stub-sidecar.mjs');
  writeFileSync(stubPath, STUB_SIDECAR_SOURCE, 'utf8');

  try {
    // ── Phase 1: STUDIO_SUPPRESS_EVENTS=1 ────────────────────────────────
    // Wait until frames have demonstrably reached the relay (the drop line,
    // then the every-10 running count), and settle — so "no notification"
    // means "dropped", not "none arrived". The stub emits every 150 ms, so
    // ten frames is ~1.5 s, well inside PHASE_TIMEOUT_MS.
    const suppressed = await runPhase(
      { STUDIO_SUPPRESS_EVENTS: '1' },
      stubPath,
      (s) => s.initialized && RUNNING_COUNT_LINE.test(s.stderr),
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
    // G-108, half one: the running count has to print on a run of a dozen
    // frames. The previous every-50 cadence printed nothing until frame 50,
    // which a realistic 5-cell render never reaches.
    assert.match(
      suppressed.stderr,
      RUNNING_COUNT_LINE,
      `expected the running drop count at frame 10 — the cadence must be recoverable on a run of a ` +
        `dozen frames, not only past 50 (G-108); got:\n${suppressed.stderr}`,
    );
    assert.equal(
      relayEventNotifications(suppressed).length,
      0,
      `expected NO forwarded event notifications while suppressed, got ${
        relayEventNotifications(suppressed).length
      }:\n${suppressed.stdout}`,
    );
    // G-108, half two on the signal path: SIGTERM must print the final census
    // line (previously an async `stderr.write` racing `process.exit(0)`, so it
    // could — and did — go missing).
    //
    // Only assertable where signals are real. On Windows `child.kill('SIGTERM')`
    // is TerminateProcess: no JS handler in the child runs, so there is nothing
    // to observe and asserting it would fail the platform, not the code. Phase 4
    // covers the same census everywhere via stdin EOF.
    if (SIGNALS_DELIVERABLE) {
      assert.ok(
        CENSUS_LINE.test(suppressed.stderr),
        `expected a shutdown census line ("dropped N event frame(s) total this session") on the ` +
          `SIGTERM path, got:\n${suppressed.stderr}`,
      );
      assert.match(
        suppressed.stderr,
        /\[studio-mcp\] received SIGTERM — dropped \d+ event frame\(s\) total this session/,
        `expected the census line specifically to be attributed to "received SIGTERM", got:\n${suppressed.stderr}`,
      );
    } else {
      console.log(
        'note - phase 1 census assertions skipped: kill(SIGTERM) on win32 is TerminateProcess, ' +
          'no signal handler runs in the child (phase 4 covers the census on this platform)',
      );
    }

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

    // ── Phase 4: G-108 — stdin EOF, and no signal, ever ─────────────────
    // The kernel's reload path reproduced exactly: stdin is closed and the
    // process is expected to leave on its own, census included. No SIGINT,
    // no SIGTERM, no SIGKILL is ever sent (asserted below), and no respawn
    // ladder is involved — the long-lived stub stays alive throughout, so
    // this phase's budget is not coupled to SidecarClient's private backoff
    // constants. A non-zero count is required: "dropped 0" would satisfy a
    // presence-only check while proving nothing.
    const eof = await runPhase(
      { STUDIO_SUPPRESS_EVENTS: '1' },
      stubPath,
      (s) => s.initialized && FIRST_DROP_LINE.test(s.stderr),
      'stdin-eof',
    );
    assert.ok(eof.initialized, `server never answered initialize; stderr:\n${eof.stderr}`);
    assert.ok(!FATAL_LINE.test(eof.stderr), `server logged a fatal; stderr:\n${eof.stderr}`);
    assert.ok(
      FIRST_DROP_LINE.test(eof.stderr),
      `expected at least one dropped frame before stdin was closed; stderr:\n${eof.stderr}`,
    );
    assert.ok(
      CENSUS_LINE.test(eof.stderr),
      `expected a shutdown census line on the stdin-EOF (transport closed) path — this is the one ` +
        `the shell kernel's pkg reload takes, and the gap G-108 is about; stderr:\n${eof.stderr}`,
    );
    assert.match(
      eof.stderr,
      EOF_CENSUS_LINE,
      `expected the census line attributed to "stdin EOF" with a non-zero count (never a signal was ` +
        `sent, and 'beforeExit' cannot fire while the sidecar child refs the loop); got:\n${eof.stderr}`,
    );
    assert.ok(
      !ANY_SIGNAL_LINE.test(eof.stderr),
      `test never sent a signal — a "received SIG…" line here would mean the phase is broken, ` +
        `not the fix:\n${eof.stderr}`,
    );
    // A crash that happens to run the 'exit' handler would print a census too:
    // require the exit itself to be clean, so a thrown relay listener or an
    // unhandled rejection can't pass this phase.
    assert.equal(
      eof.exitCode,
      0,
      `expected a clean exit(0) on the stdin-EOF path, got code=${eof.exitCode} signal=${eof.exitSignal};` +
        ` stderr:\n${eof.stderr}`,
    );
    assert.equal(
      eof.exitSignal,
      null,
      `expected no terminating signal on the stdin-EOF path, got ${eof.exitSignal}; stderr:\n${eof.stderr}`,
    );

    console.log(
      `ok - index.smoke.test.ts (STUDIO_SUPPRESS_EVENTS: suppressed drops frames; default forwarded ${forwarded.length}; non-"1" value reported OFF; stdin-EOF census printed)`,
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
