// com.ikenga.studio · MCP probe policy tests (G-105, WP-32 live round)
//
//   bun run src/studio/lib/mcp-probe.test.ts   (from packages/apps/studio/)
//
// Plain assert-based script (no bun:test / node:test import) so it typechecks
// under `tsc -p tsconfig.web.json` alongside the rest of `src/`, same rationale
// as path.test.ts / canvas-links.test.ts.
//
// What is under test is the PURE half of the real-vs-mock decision: classify a
// probe failure, then decide retry / fall back / latch. The live bug (G-105)
// was a single-shot probe against a server that needs ~3.4 s to boot, so the
// central assertions here are (a) a mid-boot error keeps retrying well past
// 3.4 s, and (b) a window-exhausted fallback never latches while the host
// reports the MCP server present.

import assert from 'node:assert/strict';

import {
  DEFAULT_PROBE_POLICY,
  backoffDelayMs,
  classifyProbeError,
  connectionMessage,
  foldAbsentStreak,
  isDemoPhase,
  phaseForFallback,
  probeErrorText,
  recordProbeFailure,
  shouldLatchAbsent,
  startProbeWindow,
  type ProbePolicy,
  type ProbeStep,
  type ProbeWindow,
} from './mcp-probe';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// The exact string `real-mcp.ts`'s raw() throws when the shell answers
// `{ isError:true, content:[{ text:<host error> }] }` — the host text is not
// JSON, so it lands inside the non-JSON-result message.
function hostError(text: string): Error {
  return new Error(`[studio] render.list_engines: non-JSON MCP result: ${text}`);
}

const PRESENT = { serverPresent: true };
const ABSENT_HOST = { serverPresent: false };

// ─── classification ─────────────────────────────────────────────────────

test('classify: supervised child still booting is transient', () => {
  // shell/src-tauri/src/pkg/lifecycle.rs — what a mid-boot studio server
  // actually answers. This is the G-105 error.
  assert.equal(
    classifyProbeError(
      hostError('supervised sidecar for `com.ikenga.studio` is not running (state=Starting)'),
    ),
    'transient',
  );
});

test('classify: every other shell transport failure is transient', () => {
  for (const text of [
    'supervised tools/call `render.list_engines` timed out after 30s',
    'child exited before responding',
    'mcp server closed stdout before id=1',
    'mcp tool `render.list_engines` timed out after 30s',
    'pkg `com.ikenga.studio` declares lifecycle=long-lived but supervisor has no entry — install may have failed or the child is in shutdown',
    'supervisor lock poisoned',
  ]) {
    assert.equal(classifyProbeError(hostError(text)), 'transient', text);
  }
});

test('classify: our own probe timeout is transient', () => {
  assert.equal(classifyProbeError(new Error('mcp-probe-timeout')), 'transient');
});

test('classify: an unrecognised failure is transient BY DESIGN', () => {
  // Mistaking a slow boot for a missing server is the bug; the bounded window
  // makes an over-optimistic guess cost seconds, not a session.
  assert.equal(classifyProbeError(new Error('kaboom')), 'transient');
  assert.equal(classifyProbeError(undefined), 'transient');
  assert.equal(classifyProbeError({ nope: 1 }), 'transient');
});

test('classify: host says no server ⇒ absent', () => {
  for (const text of [
    'pkg `com.ikenga.studio` is not installed',
    'pkg `com.ikenga.studio` declares no mcp servers',
    'package declares no mcp servers',
    'no mcp server named `studio`',
  ]) {
    assert.equal(classifyProbeError(hostError(text)), 'absent', text);
  }
});

test('classify: trust gate is its own kind', () => {
  assert.equal(
    classifyProbeError(
      hostError('trust_required: pkg `com.ikenga.studio` is awaiting user approval — grant via Settings → Pkgs → Trust'),
    ),
    'trust-required',
  );
});

test('classify: matching is case-insensitive', () => {
  assert.equal(classifyProbeError(new Error('PKG `x` IS NOT INSTALLED')), 'absent');
  assert.equal(classifyProbeError(new Error('TRUST_REQUIRED: …')), 'trust-required');
});

test('probeErrorText flattens whatever was thrown', () => {
  assert.equal(probeErrorText(new Error('boom')), 'boom');
  assert.equal(probeErrorText('boom'), 'boom');
  assert.equal(probeErrorText({ message: 'boom' }), 'boom');
  assert.equal(probeErrorText(null), 'null');
});

// ─── backoff schedule ───────────────────────────────────────────────────

test('backoff: tight first, then the last entry repeats', () => {
  const p: ProbePolicy = { ...DEFAULT_PROBE_POLICY, backoffMs: [250, 500, 1000] };
  assert.equal(backoffDelayMs(1, p), 250); // after the 1st failure
  assert.equal(backoffDelayMs(2, p), 500);
  assert.equal(backoffDelayMs(3, p), 1000);
  assert.equal(backoffDelayMs(4, p), 1000); // clamps, does not grow unbounded
  assert.equal(backoffDelayMs(99, p), 1000);
});

test('backoff: degenerate inputs are safe', () => {
  assert.equal(backoffDelayMs(0, { ...DEFAULT_PROBE_POLICY, backoffMs: [250] }), 250);
  assert.equal(backoffDelayMs(1, { ...DEFAULT_PROBE_POLICY, backoffMs: [] }), 0);
});

test('the default window is comfortably past the observed boot time', () => {
  // The live round measured ~3.4 s from iframe remount to the MCP server's
  // first answer. Guard the headroom so a future tuning pass can't silently
  // shrink the window back under the thing it exists to cover.
  assert.ok(DEFAULT_PROBE_POLICY.windowMs >= 12_000, 'window >= 12s');
  assert.ok(DEFAULT_PROBE_POLICY.timeoutMs <= DEFAULT_PROBE_POLICY.windowMs / 2);
});

// ─── the window state machine ───────────────────────────────────────────

/** Drive a whole window with a fixed per-attempt cost, returning every step. */
function driveWindow(opts: {
  err: unknown;
  serverPresent: boolean;
  policy: ProbePolicy;
  /** How long each failed attempt itself takes (the probe timeout, usually). */
  attemptCostMs: number;
  startMs?: number;
}): { steps: ProbeStep[]; elapsedMs: number } {
  const start = opts.startMs ?? 1_000_000;
  let now = start;
  let win: ProbeWindow = startProbeWindow(now);
  const steps: ProbeStep[] = [];
  for (let i = 0; i < 500; i += 1) {
    now += opts.attemptCostMs;
    const out = recordProbeFailure(win, opts.err, now, {
      serverPresent: opts.serverPresent,
      policy: opts.policy,
    });
    win = out.window;
    steps.push(out.step);
    if (out.step.action === 'fallback') break;
    now += out.step.delayMs;
  }
  return { steps, elapsedMs: now - start };
}

const BOOTING = hostError('supervised sidecar for `com.ikenga.studio` is not running (state=Starting)');

test('G-105: a booting server is retried, not mocked, on the first failure', () => {
  const win = startProbeWindow(0);
  const { step } = recordProbeFailure(win, BOOTING, 3_000, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.equal(step.action, 'retry');
  if (step.action !== 'retry') return;
  assert.equal(step.failures, 1);
  assert.equal(step.delayMs, 250);
  assert.equal(step.remainingMs, 12_000);
});

test('G-105: retries keep going past the ~3.4s the live server needed', () => {
  // Simulate the real shape: each attempt burns the 3s probe timeout.
  const { steps, elapsedMs } = driveWindow({
    err: BOOTING,
    serverPresent: true,
    policy: DEFAULT_PROBE_POLICY,
    attemptCostMs: DEFAULT_PROBE_POLICY.timeoutMs,
  });
  const retries = steps.filter((s) => s.action === 'retry');
  assert.ok(retries.length >= 3, `expected >=3 retries, got ${retries.length}`);
  // The 2nd attempt starts at 3000+250 = 3250ms and can run to 6250ms, so the
  // 3.4s answer observed live is reached inside the window. The old code gave
  // up at 3000ms.
  assert.ok(elapsedMs >= 12_000, `window ran ${elapsedMs}ms`);
  assert.ok(elapsedMs <= DEFAULT_PROBE_POLICY.windowMs + DEFAULT_PROBE_POLICY.timeoutMs);
});

test('the window is bounded — it always terminates in a fallback', () => {
  const { steps } = driveWindow({
    err: BOOTING,
    serverPresent: true,
    policy: DEFAULT_PROBE_POLICY,
    attemptCostMs: 10,
  });
  const last = steps[steps.length - 1];
  assert.ok(last);
  assert.equal(last.action, 'fallback');
  if (last.action !== 'fallback') return;
  assert.equal(last.reason, 'window-exhausted');
});

test('G-105 core: a window-exhausted fallback NEVER latches while the server is present', () => {
  const win = startProbeWindow(0);
  const { step } = recordProbeFailure(win, BOOTING, 20_000, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.equal(step.action, 'fallback');
  if (step.action !== 'fallback') return;
  assert.equal(step.reason, 'window-exhausted');
  assert.equal(step.latch, false);
  assert.equal(phaseForFallback(step.latch), 'degraded');
});

test('a window-exhausted fallback DOES latch when the host reports no server', () => {
  const win = startProbeWindow(0);
  const { step } = recordProbeFailure(win, BOOTING, 20_000, { ...ABSENT_HOST, policy: DEFAULT_PROBE_POLICY });
  assert.equal(step.action, 'fallback');
  if (step.action !== 'fallback') return;
  assert.equal(step.latch, true);
  assert.equal(phaseForFallback(step.latch), 'demo');
});

// ─── absent is a CONFIRMED verdict, not a one-way door ──────────────────
//
// `absent` is the only verdict that latches demo mode for good, and the host
// wordings that produce it come from a per-call manifest read: the shell
// re-reads manifest.json on EVERY pkg_mcp_call and answers "declares no mcp
// servers" whenever that read parses with an empty mcp block. A live manifest
// edit (`ikenga dev`'s whole purpose; round G of the WP-32 session did exactly
// this) or an uninstall/reinstall therefore produces it transiently — so one
// verdict must never latch.

const ABSENT = hostError('pkg `com.ikenga.studio` declares no mcp servers');
const NOT_INSTALLED = hostError('pkg `com.ikenga.studio` is not installed');

test('the absent latch requires at least two confirmations by policy', () => {
  assert.ok(
    DEFAULT_PROBE_POLICY.absentConfirmations >= 2,
    'one absent verdict must never be enough to latch',
  );
  // And an override cannot reintroduce the one-way door.
  assert.equal(shouldLatchAbsent(1, { ...DEFAULT_PROBE_POLICY, absentConfirmations: 1 }), false);
  assert.equal(shouldLatchAbsent(2, { ...DEFAULT_PROBE_POLICY, absentConfirmations: 1 }), true);
});

test('absent: the FIRST verdict re-verifies instead of latching', () => {
  const win = startProbeWindow(0);
  const { window, step } = recordProbeFailure(win, ABSENT, 1, {
    ...PRESENT,
    policy: DEFAULT_PROBE_POLICY,
  });
  assert.equal(step.action, 'retry', 'a transient host answer must not cost the session');
  if (step.action !== 'retry') return;
  assert.ok(
    step.delayMs >= DEFAULT_PROBE_POLICY.absentRecheckMs,
    `re-check waits for the manifest write to settle, got ${step.delayMs}ms`,
  );
  assert.equal(window.absentStreak, 1);
  assert.equal(window.lastKind, 'absent');
});

test('absent: the SECOND consecutive verdict latches demo mode', () => {
  let win = startProbeWindow(0);
  let out = recordProbeFailure(win, ABSENT, 1, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  win = out.window;
  // A different wording, same verdict — the streak is about the KIND.
  out = recordProbeFailure(win, NOT_INSTALLED, 800, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.equal(out.window.absentStreak, 2);
  assert.equal(out.step.action, 'fallback');
  if (out.step.action !== 'fallback') return;
  assert.equal(out.step.reason, 'absent');
  assert.equal(out.step.latch, true, 'confirmed: nothing to wait for');
  assert.equal(phaseForFallback(out.step.latch), 'demo');
});

test('absent: any other verdict in between resets the streak', () => {
  let win = startProbeWindow(0);
  win = recordProbeFailure(win, ABSENT, 1, { ...PRESENT, policy: DEFAULT_PROBE_POLICY }).window;
  assert.equal(win.absentStreak, 1);
  // The manifest reload finished; the server is now merely booting.
  win = recordProbeFailure(win, BOOTING, 900, { ...PRESENT, policy: DEFAULT_PROBE_POLICY }).window;
  assert.equal(win.absentStreak, 0, 'not consecutive any more');
  const out = recordProbeFailure(win, ABSENT, 1_800, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.equal(out.step.action, 'retry', 'back to needing a confirmation');
});

test('absent at the window edge falls back UN-LATCHED so the re-probe confirms', () => {
  const win = startProbeWindow(0);
  const { step } = recordProbeFailure(win, ABSENT, DEFAULT_PROBE_POLICY.windowMs + 1, {
    ...PRESENT,
    policy: DEFAULT_PROBE_POLICY,
  });
  assert.equal(step.action, 'fallback');
  if (step.action !== 'fallback') return;
  assert.equal(step.reason, 'absent');
  assert.equal(step.latch, false, 'no budget to re-verify in the foreground — do it in the background');
  assert.equal(phaseForFallback(step.latch), 'degraded');
});

test('an absent window still terminates, in a LATCHED fallback', () => {
  const { steps } = driveWindow({
    err: ABSENT,
    serverPresent: true,
    policy: DEFAULT_PROBE_POLICY,
    attemptCostMs: 10,
  });
  const last = steps[steps.length - 1];
  assert.ok(last);
  assert.equal(last.action, 'fallback');
  if (last.action !== 'fallback') return;
  assert.equal(last.reason, 'absent');
  assert.equal(last.latch, true);
  assert.equal(steps.length, 2, 'exactly one re-verification, then the latch');
});

test('foldAbsentStreak carries the confirmation rule to the background re-probe', () => {
  // The background probe has no window (one attempt per tick), so it folds the
  // streak with this helper instead of re-deriving the rule.
  assert.equal(foldAbsentStreak(0, 'absent'), 1);
  assert.equal(foldAbsentStreak(1, 'absent'), 2);
  assert.equal(foldAbsentStreak(1, 'transient'), 0);
  assert.equal(foldAbsentStreak(3, 'trust-required'), 0);
  assert.equal(shouldLatchAbsent(foldAbsentStreak(0, 'absent')), false);
  assert.equal(shouldLatchAbsent(foldAbsentStreak(1, 'absent')), true);
});

test('trust-required falls back at once but does NOT latch', () => {
  const win = startProbeWindow(0);
  const { step } = recordProbeFailure(
    win,
    hostError('trust_required: pkg `com.ikenga.studio` is awaiting user approval'),
    1,
    { ...PRESENT, policy: DEFAULT_PROBE_POLICY },
  );
  assert.equal(step.action, 'fallback');
  if (step.action !== 'fallback') return;
  assert.equal(step.reason, 'trust-required');
  // A grant is a human action: don't hammer it, but a later grant must still
  // be able to flip the session to real.
  assert.equal(step.latch, false);
});

test('the last retry is clamped to start inside the window', () => {
  const p: ProbePolicy = { ...DEFAULT_PROBE_POLICY, windowMs: 5_000, backoffMs: [2_500] };
  const win = startProbeWindow(0);
  const { step } = recordProbeFailure(win, BOOTING, 4_900, { ...PRESENT, policy: p });
  assert.equal(step.action, 'retry');
  if (step.action !== 'retry') return;
  assert.equal(step.delayMs, 100, 'clamped to the 100ms left, not the 2500ms schedule');
  assert.equal(step.remainingMs, 100);
});

test('a failure exactly at the window edge falls back', () => {
  const win = startProbeWindow(0);
  const { step } = recordProbeFailure(win, BOOTING, DEFAULT_PROBE_POLICY.windowMs, {
    ...PRESENT,
    policy: DEFAULT_PROBE_POLICY,
  });
  assert.equal(step.action, 'fallback');
});

test('recordProbeFailure is pure — the input window is never mutated', () => {
  const win = startProbeWindow(1_000);
  const snapshot = { ...win };
  const a = recordProbeFailure(win, BOOTING, 1_100, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  const b = recordProbeFailure(win, BOOTING, 1_100, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.deepEqual(win, snapshot);
  assert.deepEqual(a.step, b.step, 'same inputs ⇒ same decision');
  assert.equal(a.window.failures, 1);
  assert.equal(a.window.lastKind, 'transient');
  assert.equal(a.window.startedAtMs, 1_000, 'the window start is carried, not reset');
});

test('failures accumulate across the window', () => {
  const { steps } = driveWindow({
    err: BOOTING,
    serverPresent: true,
    policy: { ...DEFAULT_PROBE_POLICY, windowMs: 2_000, backoffMs: [200] },
    attemptCostMs: 100,
  });
  steps.forEach((s, i) => {
    assert.equal(s.failures, i + 1);
  });
});

test('a mixed window: transient retries, then a confirmed absent verdict mid-window', () => {
  let win = startProbeWindow(0);
  let out = recordProbeFailure(win, BOOTING, 500, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.equal(out.step.action, 'retry');
  win = out.window;
  // The pkg was uninstalled between attempts — re-verify once …
  out = recordProbeFailure(win, NOT_INSTALLED, 1_000, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.equal(out.step.action, 'retry');
  assert.equal(out.window.absentStreak, 1);
  win = out.window;
  // … and it still says so: stop, don't ride out the window.
  out = recordProbeFailure(win, NOT_INSTALLED, 1_900, { ...PRESENT, policy: DEFAULT_PROBE_POLICY });
  assert.equal(out.step.action, 'fallback');
  if (out.step.action !== 'fallback') return;
  assert.equal(out.step.reason, 'absent');
  assert.equal(out.step.failures, 3);
  assert.equal(out.window.lastKind, 'absent');
});

// ─── phases and copy ────────────────────────────────────────────────────

test('phase → demo-ness', () => {
  assert.equal(isDemoPhase('real'), false);
  assert.equal(isDemoPhase('connecting'), false);
  assert.equal(isDemoPhase('idle'), false);
  assert.equal(isDemoPhase('degraded'), true);
  assert.equal(isDemoPhase('demo'), true);
});

test('the connecting message is the visible state G-105 was missing', () => {
  assert.equal(connectionMessage('connecting', null), 'Connecting to studio engine…');
});

test('every phase has non-empty copy, and demo copy never claims a connection', () => {
  const cases: Array<[Parameters<typeof connectionMessage>[0], Parameters<typeof connectionMessage>[1]]> = [
    ['idle', null],
    ['connecting', null],
    ['real', null],
    ['degraded', null],
    ['degraded', 'window-exhausted'],
    ['degraded', 'trust-required'],
    ['degraded', 'absent'],
    ['degraded', 'project-reopen-failed'],
    ['demo', 'standalone'],
    ['demo', 'absent'],
  ];
  for (const [phase, reason] of cases) {
    const msg = connectionMessage(phase, reason);
    assert.ok(msg.length > 0, `${phase}/${reason}`);
    if (isDemoPhase(phase)) {
      assert.match(msg, /demo/i, `${phase}/${reason} must say it is demo data`);
    }
  }
});

test('the trust-required degraded message tells the user where to grant', () => {
  assert.match(connectionMessage('degraded', 'trust-required'), /Settings/);
});

test('an UNCONFIRMED absent verdict does not read like the latched demo mode', () => {
  const unconfirmed = connectionMessage('degraded', 'absent');
  assert.match(unconfirmed, /re-check/i, 'says the verdict is still being checked');
  assert.notEqual(unconfirmed, connectionMessage('demo', 'absent'));
});

test('a failed project re-open says the engine is up but the project is not', () => {
  // The one fallback where the transport answered: adoptReal refuses to promote
  // a real client whose project could not be re-opened, because every
  // project-scoped call would throw "no open project".
  const msg = connectionMessage('degraded', 'project-reopen-failed');
  assert.match(msg, /re-opened/i);
  assert.match(msg, /retrying/i);
});

console.log(`\n${passed} passed`);
