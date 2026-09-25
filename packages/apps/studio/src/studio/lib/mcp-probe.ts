// com.ikenga.studio · MCP probe policy — the pure half of the real-vs-mock decision
//
// WHY THIS FILE EXISTS (G-105, WP-32 live round 2026-09-12):
//
//   A pkg reload remounts the iframe the INSTANT the kernel reloads
//   (16:28:40.2 in the live log) while the supervised `studio` MCP server needs
//   ~3.4 s to finish booting and answer its first `tools/call`. The old
//   `mcp-client.ts` fired ONE `render.list_engines` probe behind a 3 s timeout
//   and, on the throw, silently swapped in the mock client for the rest of the
//   session — the pane came back reading `~/Untitled (mock)/`, archetype
//   `musicvideo`, `3 / 6 rendered` (the 6-cell mock timeline). Every check run
//   after such a reload was grading demo data, and the user had no signal at
//   all that they were looking at a fixture.
//     evidence: plans/studio/verify/2026-09-12-wp32-live/g61/7-gate.md  (G-105)
//               plans/studio/verify/2026-09-12-wp32-live/wp26-poll/verdict.md
//
// The fix has two halves. The IMPURE half (timers, dynamic imports, the client
// instances, the iyke publish) stays in `mcp-client.ts`. This file is the PURE
// half — classification of a probe failure plus the retry/backoff/fallback
// decision — so the state machine that used to be one untested `catch {}` can
// be asserted directly (`mcp-probe.test.ts`).
//
// The decision rule, in one sentence: keep probing for a bounded window while
// the failure looks like a server that is still coming up, fall back to demo
// data only when the window is exhausted, and LATCH that fallback only when
// the host says there is no MCP server to wait for.

// ─── Failure classification ─────────────────────────────────────────────
//
// A failed probe arrives as a thrown Error whose message is built by
// `real-mcp.ts`'s `raw()`. When the shell's `pkg_mcp_call` fails it answers
// `{ content:[{ type:'text', text: <host error> }], isError:true }` and the
// host error text is a plain sentence, not JSON — so `raw()` throws
// `[studio] render.list_engines: non-JSON MCP result: <host error>` and the
// host's own wording is carried verbatim inside the message. That wording is
// therefore the only classifier available to the iframe, and the strings below
// are quoted from the shell:
//
//   shell/src-tauri/src/commands/pkg_mcp.rs
//     "pkg `{id}` is not installed"                        → absent
//     "pkg `{id}` declares no mcp servers"                 → absent
//     "supervisor has no entry — install may have failed …" → transient
//   shell/src-tauri/src/pkg/mcp_runtime.rs
//     "package declares no mcp servers"                    → absent
//     "no mcp server named `{name}`"                       → absent
//     "mcp tool `{t}` timed out after {d}"                 → transient
//     "mcp server closed stdout before id={n}"             → transient
//   shell/src-tauri/src/pkg/lifecycle.rs  (the supervised/long-lived path —
//   this is what a mid-boot studio server actually answers)
//     "supervised sidecar for `{id}` is not running (state=Starting)" → transient
//     "supervised tools/call `{t}` timed out after {d}"     → transient
//     "child exited before responding"                     → transient
//   shell/src-tauri/src/pkg/trust.rs
//     "trust_required: pkg `{id}` is awaiting user approval …" → trust-required
//
// Anything unrecognised is TRANSIENT on purpose: mistaking a slow boot for a
// missing server is the bug this file exists to prevent, and the bounded window
// makes an over-optimistic classification cost seconds, not a session.

/** What kind of thing went wrong with a `render.list_engines` probe.
 *
 *   • `absent`         — the host says there is no MCP server for this pkg at
 *                        all (not installed / declares none / no such server).
 *                        Waiting cannot help; demo mode is the honest answer.
 *   • `trust-required` — the pkg is installed and has a server, but every
 *                        tools/call is gated pending the user's approval in
 *                        Settings → Pkgs → Trust. Retrying on a 250 ms backoff
 *                        is pointless (it is a human action), but the grant can
 *                        land at any time, so this must NOT latch.
 *   • `transient`      — anything else: still booting, mid-restart, timed out,
 *                        stdout closed, or unrecognised. Retry. */
export type ProbeFailureKind = 'absent' | 'trust-required' | 'transient';

// WHY `absent` IS NOT A ONE-WAY DOOR (review of the G-105 fix):
//
//   `absent` is the only verdict that latches demo mode for the rest of the
//   iframe's life, and the host wordings that produce it are NOT stable facts
//   about the install — they are answers to a per-call manifest read.
//   `shell/src-tauri/src/commands/pkg_mcp.rs` re-reads `manifest.json` off
//   disk on EVERY `pkg_mcp_call` and answers "pkg `X` declares no mcp servers"
//   whenever that read parses with an empty/absent mcp block. `ikenga dev`'s
//   watcher exists precisely so a manifest can be edited live (round G of the
//   WP-32 verify session edited the manifest's mcp env key and reverted it), and
//   a shell-side uninstall/reinstall briefly drops the kernel entry the same
//   way ("pkg `X` is not installed"). One probe landing in either window used
//   to latch the pane to the 6-cell mock timeline until `/iyke/refresh` —
//   strictly worse than the single-shot probe it replaced, which at least
//   re-probed 10 s later regardless of the failure kind.
//
//   So `absent` must be CONFIRMED: `policy.absentConfirmations` consecutive
//   absent verdicts (default 2, re-checked after `absentRecheckMs`) before the
//   latch. Any other verdict in between resets the streak. The cost of the
//   extra probe is one cheap tools/call; the cost of getting it wrong is a
//   session of silently-graded fixture data.

/** Host wordings that mean "there is no MCP server here to wait for". Matched
 *  case-insensitively as substrings of the thrown message. */
const ABSENT_PATTERNS: readonly string[] = [
  'is not installed',
  'declares no mcp servers',
  'no mcp server named',
];

const TRUST_PATTERN = 'trust_required';

/** Flatten any thrown value to the string the patterns are matched against.
 *  Errors carry `.message`; the SDK can also reject with an `McpError` (whose
 *  `message` already embeds the host text) or, rarely, a bare string. */
export function probeErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(err);
}

/** Classify a failed probe. Unknown failures are `transient` BY DESIGN — see
 *  the header note. */
export function classifyProbeError(err: unknown): ProbeFailureKind {
  const text = probeErrorText(err).toLowerCase();
  if (text.includes(TRUST_PATTERN)) return 'trust-required';
  for (const p of ABSENT_PATTERNS) {
    if (text.includes(p)) return 'absent';
  }
  return 'transient';
}

// ─── Policy ─────────────────────────────────────────────────────────────

/** Retry policy for the first-mount probe window. */
export interface ProbePolicy {
  /** Total wall-clock budget for the whole retry window, measured from the
   *  first attempt. ~15 s — comfortably past the ~3.4 s the supervised studio
   *  server took to answer in the live round, and still short enough that a
   *  genuinely dead server does not hang the pane indefinitely. */
  windowMs: number;
  /** Per-attempt timeout on the `render.list_engines` call itself. */
  timeoutMs: number;
  /** Backoff before attempt N+1 (index = number of failures so far, clamped to
   *  the last entry, which then repeats). Starts tight so the common
   *  reload race costs the user a few hundred ms, not the full window. */
  backoffMs: readonly number[];
  /** How long to wait before a BACKGROUND re-probe once the window has been
   *  exhausted and the client is serving demo data. Only used while the
   *  fallback is un-latched. */
  reprobeMs: number;
  /** How many CONSECUTIVE `absent` verdicts it takes to latch demo mode. Must
   *  be >= 2: a single absent answer is reachable from a transient host state
   *  (a live manifest edit, an uninstall/reinstall) and latching on it is a
   *  one-way door to the fixture. See the header note. */
  absentConfirmations: number;
  /** Minimum wait before re-verifying an unconfirmed `absent` verdict. Longer
   *  than the first transient backoff on purpose — the point is to land AFTER
   *  the manifest write that produced the answer has settled. */
  absentRecheckMs: number;
}

export const DEFAULT_PROBE_POLICY: ProbePolicy = {
  windowMs: 15_000,
  timeoutMs: 3_000,
  backoffMs: [250, 500, 1_000, 1_500, 2_500],
  reprobeMs: 10_000,
  absentConfirmations: 2,
  absentRecheckMs: 750,
};

/** Backoff before the attempt that follows `failures` failed attempts. The
 *  schedule's last entry repeats forever (the window, not the schedule, is
 *  what bounds the loop). */
export function backoffDelayMs(failures: number, policy: ProbePolicy = DEFAULT_PROBE_POLICY): number {
  const table = policy.backoffMs;
  if (table.length === 0) return 0;
  const i = Math.max(0, Math.min(failures, table.length) - 1);
  return table[i] ?? 0;
}

// ─── The window state machine ───────────────────────────────────────────

/** Why the client settled on demo data.
 *
 *   • `standalone`           — no parent window (`pnpm dev` in a plain tab).
 *                              Never probed; this is the sanctioned demo mode.
 *   • `absent`               — host says no MCP server. Latches (and so means
 *                              "sanctioned demo mode") only once CONFIRMED —
 *                              see `absentConfirmations`. An unconfirmed absent
 *                              verdict carries this reason with `latch:false`,
 *                              i.e. demo data while the re-check is pending.
 *   • `trust-required`       — awaiting the user's trust grant.
 *   • `window-exhausted`     — the server should be there but never answered
 *                              inside the window.
 *   • `project-reopen-failed`— the transport answered, but the project the demo
 *                              session was showing could not be re-opened on
 *                              it, so promoting the real client would leave
 *                              every project-scoped call throwing "no open
 *                              project". Demo data, un-latched, retrying. */
export type ProbeFallbackReason =
  | 'standalone'
  | 'absent'
  | 'trust-required'
  | 'window-exhausted'
  | 'project-reopen-failed';

/** What to do after a failed probe. */
export type ProbeStep =
  | {
      action: 'retry';
      /** Failed attempts so far, including the one that produced this step. */
      failures: number;
      /** Wait this long before the next attempt. Clamped so an attempt is
       *  never scheduled past the end of the window. */
      delayMs: number;
      /** Window budget left at the moment of the decision. */
      remainingMs: number;
    }
  | {
      action: 'fallback';
      reason: ProbeFallbackReason;
      /** `true` ⇒ stop probing for good (there is nothing to wait for).
       *  `false` ⇒ serve demo data but KEEP re-probing in the background, and
       *  flip to the real client the moment a probe succeeds. G-105's
       *  "never lock into mock while the server is reported present". */
      latch: boolean;
      failures: number;
    };

/** Immutable window state. Carry it through `recordProbeFailure`. */
export interface ProbeWindow {
  startedAtMs: number;
  /** Probes that have failed in this window. */
  failures: number;
  /** Classification of the most recent failure, or `null` before any. */
  lastKind: ProbeFailureKind | null;
  /** CONSECUTIVE `absent` verdicts, reset by any other kind. The latch needs
   *  `policy.absentConfirmations` of them — see the header note on why one is
   *  not enough. The background re-probe keeps the same counter across windows
   *  (`foldAbsentStreak`), so a foreground absent + a background absent
   *  confirm each other. */
  absentStreak: number;
}

export function startProbeWindow(nowMs: number): ProbeWindow {
  return { startedAtMs: nowMs, failures: 0, lastKind: null, absentStreak: 0 };
}

/** Fold one verdict into a consecutive-absent counter. Exported so the
 *  BACKGROUND re-probe (which has no window — one attempt per tick) shares the
 *  foreground window's confirmation rule instead of re-deriving it. */
export function foldAbsentStreak(prev: number, kind: ProbeFailureKind): number {
  return kind === 'absent' ? prev + 1 : 0;
}

/** Is an absent streak long enough to latch demo mode for good? */
export function shouldLatchAbsent(
  absentStreak: number,
  policy: ProbePolicy = DEFAULT_PROBE_POLICY,
): boolean {
  return absentStreak >= Math.max(2, policy.absentConfirmations);
}

export interface RecordProbeFailureOpts {
  /** Does the host report this pkg's MCP server as present? In practice
   *  `isBridgeConnected()` — the AppBridge handshake completed, so the kernel
   *  mounted this iframe as a pkg pane and the pkg's manifest (which declares
   *  the `studio` server) is what it mounted. When true, a window-exhausted
   *  fallback must NOT latch. */
  serverPresent: boolean;
  policy?: ProbePolicy;
}

/** Fold one probe failure into the window and decide what happens next.
 *
 *  Pure: same inputs ⇒ same outputs. `nowMs` is injected so tests can drive a
 *  whole window without real timers. */
export function recordProbeFailure(
  win: ProbeWindow,
  err: unknown,
  nowMs: number,
  opts: RecordProbeFailureOpts,
): { window: ProbeWindow; step: ProbeStep } {
  const policy = opts.policy ?? DEFAULT_PROBE_POLICY;
  const kind = classifyProbeError(err);
  const failures = win.failures + 1;
  const absentStreak = foldAbsentStreak(win.absentStreak, kind);
  const window: ProbeWindow = { startedAtMs: win.startedAtMs, failures, lastKind: kind, absentStreak };

  // No server to wait for — the one case where latching is honest, and only
  // once the verdict has been CONFIRMED. A single absent answer is reachable
  // from a transient host state (live manifest edit, uninstall/reinstall), and
  // latching on it is a one-way door to the fixture (header note).
  if (kind === 'absent') {
    if (shouldLatchAbsent(absentStreak, policy)) {
      return { window, step: { action: 'fallback', reason: 'absent', latch: true, failures } };
    }
    const absentRemainingMs = win.startedAtMs + policy.windowMs - nowMs;
    if (absentRemainingMs > 0) {
      // Re-verify inside the window rather than latching.
      return {
        window,
        step: {
          action: 'retry',
          failures,
          delayMs: Math.min(Math.max(policy.absentRecheckMs, backoffDelayMs(failures, policy)), absentRemainingMs),
          remainingMs: absentRemainingMs,
        },
      };
    }
    // No budget left to re-verify in the foreground: serve demo data now, but
    // UN-LATCHED, so the background re-probe does the confirming second look.
    return { window, step: { action: 'fallback', reason: 'absent', latch: false, failures } };
  }

  // A trust grant is a human action; hammering it on a 250 ms backoff would
  // just spam the audit log. Serve demo data, keep the door open.
  if (kind === 'trust-required') {
    return {
      window,
      step: { action: 'fallback', reason: 'trust-required', latch: false, failures },
    };
  }

  const remainingMs = win.startedAtMs + policy.windowMs - nowMs;
  if (remainingMs <= 0) {
    return {
      window,
      step: {
        action: 'fallback',
        reason: 'window-exhausted',
        // The server is reported present but hasn't answered: serve demo data
        // for now and keep re-probing. Only a context with no server at all
        // gets to latch.
        latch: !opts.serverPresent,
        failures,
      },
    };
  }

  // Budget left: retry. The delay is clamped to what's left so the last
  // attempt starts inside the window rather than one backoff past it (a probe
  // that resolves late still wins — a late real client beats a mock one).
  const delayMs = Math.min(backoffDelayMs(failures, policy), remainingMs);
  return { window, step: { action: 'retry', failures, delayMs, remainingMs } };
}

// ─── Connection phase (what the UI renders) ─────────────────────────────

/** The user-visible connection phase.
 *
 *   • `idle`       — nothing has asked for a client yet.
 *   • `connecting` — inside the probe window. Views await; the pane shows
 *                    "Connecting to studio engine…" rather than mock content.
 *                    THIS is the state G-105 was missing.
 *   • `real`       — probe passed; every call goes to the pkg's MCP server.
 *   • `degraded`   — demo data, un-latched: a background re-probe is armed and
 *                    will flip to `real` on success.
 *   • `demo`       — demo data by design (standalone dev, or a host that
 *                    reports no MCP server). No further probing. */
export type McpConnectionPhase = 'idle' | 'connecting' | 'real' | 'degraded' | 'demo';

/** Phase implied by a fallback step. `latch` is the discriminator: an
 *  un-latched fallback is `degraded` (still trying), a latched one is `demo`
 *  (the sanctioned explicit mock mode). */
export function phaseForFallback(latch: boolean): McpConnectionPhase {
  return latch ? 'demo' : 'degraded';
}

/** Copy for each phase. Safe to render verbatim — no numbers are invented and
 *  nothing claims a connection that doesn't exist. */
export function connectionMessage(phase: McpConnectionPhase, reason: ProbeFallbackReason | null): string {
  switch (phase) {
    case 'idle':
      return 'Studio engine not yet contacted';
    case 'connecting':
      return 'Connecting to studio engine…';
    case 'real':
      return 'Studio engine connected';
    case 'degraded':
      switch (reason) {
        case 'trust-required':
          return 'Studio engine needs approval — showing demo data (grant via Settings → Pkgs → Trust)';
        case 'absent':
          // Unconfirmed absent: the host said there is no server, but that
          // answer is a per-call manifest read and is being re-checked.
          return 'Studio engine reported missing — showing demo data while re-checking';
        case 'project-reopen-failed':
          return 'Studio engine connected, but the open project could not be re-opened — showing demo data, still retrying';
        default:
          return 'Studio engine not answering yet — showing demo data, still retrying';
      }
    case 'demo':
      return reason === 'standalone'
        ? 'Demo data — running outside the Ikenga shell'
        : 'Demo data — no studio engine available in this context';
  }
}

/** True while the phase means "the data on screen is a fixture, not this
 *  project". The one predicate a view needs to decide whether to badge. */
export function isDemoPhase(phase: McpConnectionPhase): boolean {
  return phase === 'degraded' || phase === 'demo';
}
