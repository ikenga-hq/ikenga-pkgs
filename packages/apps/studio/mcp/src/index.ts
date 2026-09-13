/**
 * com.ikenga.studio — MCP server entry.
 *
 * Bundled by `bun build --target=node --format=esm` (see ./build.sh). Boots
 * an MCP server over stdio, spawns the project sidecar as a child process,
 * wires the tool registry, and forwards sidecar `event` notifications to
 * the MCP client via `logging/message` (the per-event topic is encoded in
 * the message body).
 *
 * Lifecycle:
 *   • SIGINT/SIGTERM → graceful shutdown (stop sidecar, close transport).
 *   • stdin EOF / transport close → same shutdown path. This is the one the
 *     shell's pkg kernel actually takes on a reload: `tear_down_active()`
 *     drops the stdin channel and then drops the child handle, whose
 *     `kill_on_drop(true)` is TerminateProcess on Windows / SIGKILL on Unix
 *     with no grace period — so no signal handler, no 'exit' and no
 *     'beforeExit' ever runs, and stdin EOF is the only in-process notice
 *     this server gets. The SDK's StdioServerTransport registers only
 *     'data' and 'error' on stdin, so the EOF wiring below is ours.
 *   • Sidecar child exit → auto-respawn (up to 3 attempts, exponential backoff).
 *
 * Env:
 *   STUDIO_SUPPRESS_EVENTS=1   test-only knob (WP-32): drop sidecar `event`
 *                              frames at the relay instead of forwarding them
 *                              as `logging/message`, so the iframe's poll
 *                              fallback (rather than the push path) can be
 *                              exercised deliberately. Default (unset, or any
 *                              value other than exactly "1"): unchanged —
 *                              every event is forwarded.
 *
 *                              Only the exact string "1" arms it; any other
 *                              non-empty value logs a stderr line saying the
 *                              knob is OFF, so "wrong value" never looks like
 *                              "armed" (or like "the MCP never restarted").
 *
 *                              Observability when armed — four stderr lines,
 *                              so a run that drops only a handful of frames
 *                              still proves the frames were dropped:
 *                                • one at startup ("armed"),
 *                                • one on the FIRST dropped frame,
 *                                • a running count every 10 frames (every 50
 *                                  past 100, so a long session doesn't flood),
 *                                • a total in every shutdown path, written
 *                                  synchronously to fd 2.
 *
 *                              Where it must be set: this process is the MCP
 *                              child, spawned by the *shell*, not by the shell
 *                              terminal's CLI. Exporting it in the terminal you
 *                              run `ikenga dev` from does nothing. Arm it in
 *                              the shell's own launch env, in the shell's
 *                              `workspace.env`, or in the project's
 *                              `.env`/`.env.local` — see README "Env vars".
 *
 *                              Caveat (same reason): the project-local `.env`
 *                              layer is unfiltered, so opening someone else's
 *                              Studio project whose `.env` sets this key turns
 *                              the push path off for that session. The armed
 *                              startup line above is the trace to look for.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { writeSync } from 'node:fs';

import { SidecarClient } from './sidecar-client.js';
import { Catalog } from './catalog.js';
import { buildTools } from './tools/index.js';
import type { OpenProjectRegistry, OpenProjectEntry } from './tools/types.js';

const NAME = 'studio-mcp';
const VERSION = '0.0.0';

// WP-32 poll-fallback test knob — see the file-header Env note.
const SUPPRESS_ENV_RAW = process.env.STUDIO_SUPPRESS_EVENTS;
const SUPPRESS_EVENTS = SUPPRESS_ENV_RAW === '1';
/** Set but not exactly "1" → the knob is OFF and the operator probably meant
 * it to be ON. Worth one stderr line: the armed line is otherwise the only
 * signal, and its absence is equally consistent with "MCP never restarted". */
const SUPPRESS_ENV_MISSET =
  !SUPPRESS_EVENTS && SUPPRESS_ENV_RAW !== undefined && SUPPRESS_ENV_RAW.trim() !== '';
/** G-108: the running drop count has to be recoverable on a *realistic* run.
 * A 5-cell render emits roughly a dozen event frames, so the previous
 * every-50 cadence printed nothing at all and the only drop witness was the
 * single "frame #1" line. Count every 10 frames… */
const SUPPRESS_LOG_EVERY = 10;
/** …and back off to every 50 past this many frames, so a long-lived session
 * that drops thousands doesn't flood stderr. */
const SUPPRESS_LOG_EVERY_BULK = 50;
const SUPPRESS_LOG_BULK_AFTER = 100;

/** Hard ceiling on the async half of a shutdown (sidecar stop + transport
 * close). The census is already on fd 2 before this arms; this only keeps a
 * wedged teardown from leaving a stranded process behind. */
const SHUTDOWN_GIVEUP_MS = 4_000;

/**
 * Write one stderr line *synchronously*.
 *
 * Every diagnostic in this file goes through here rather than
 * `process.stderr.write`, because a piped stderr write is asynchronous on
 * Windows: mixing the two on fd 2 lets the shutdown census overtake (or cut
 * into the middle of) a still-queued line, and the census's whole value is
 * that it is greppable. Falls back to the async writer if fd 2 rejects the
 * sync write (a non-blocking pipe can raise EAGAIN), and swallows everything
 * after that — this is called from exit handlers and must never throw.
 */
function errSync(line: string): void {
  try {
    writeSync(2, line);
  } catch {
    try {
      process.stderr.write(line);
    } catch {
      /* fd 2 is gone — nothing left to do */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Simple in-MCP open-project registry
// ─────────────────────────────────────────────────────────────────────────

class InMemoryRegistry implements OpenProjectRegistry {
  private map = new Map<string, OpenProjectEntry>();
  set(projectId: string, entry: OpenProjectEntry): void { this.map.set(projectId, entry); }
  get(projectId: string): OpenProjectEntry | undefined { return this.map.get(projectId); }
  delete(projectId: string): boolean { return this.map.delete(projectId); }
  values(): IterableIterator<OpenProjectEntry> { return this.map.values(); }
  keys(): IterableIterator<string> { return this.map.keys(); }
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sidecar = new SidecarClient();
  const catalog = new Catalog();
  const registry = new InMemoryRegistry();

  // ───────────────────────────────────────────────────────────────────────
  // G-108: census state and the last-resort exit handlers are installed
  // FIRST, before anything can start dropping frames. The counter is bumped
  // by the relay listener further down; `printCensus` and the
  // 'beforeExit'/'exit' registrations used to sit after the awaited
  // `server.connect`, which left a window (sidecar already emitting, connect
  // not yet resolved) where a death lost the count entirely.
  // ───────────────────────────────────────────────────────────────────────
  let droppedEventCount = 0;
  let censusPrinted = false;
  /**
   * The shutdown census ("dropped N event frame(s) total this session").
   * Synchronous straight to fd 2, because the exit paths this has to survive
   * include ones where an async write would never flush, and guarded to fire
   * exactly once no matter which path gets there first.
   */
  const printCensus = (reason: string) => {
    if (!SUPPRESS_EVENTS || censusPrinted) return;
    censusPrinted = true;
    errSync(
      `[studio-mcp] ${reason} — dropped ${droppedEventCount} event frame(s) total this session\n`,
    );
  };

  // Backstops only. Neither fires on the kernel's reload path (the process is
  // terminated externally, and until then the live sidecar ChildProcess keeps
  // the event loop ref'd so 'beforeExit' cannot run) — the stdin-EOF handler
  // registered below is what actually covers that path. These stay for the
  // ordinary exits: an explicit process.exit() elsewhere, or a genuine drain.
  process.on('beforeExit', () => printCensus('beforeExit'));
  process.on('exit', () => printCensus('exit'));

  // Boot sidecar eagerly so the smoke test can ps for it.
  sidecar.start();

  const tools = buildTools({ sidecar, catalog, registry });
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as never,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = byName.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await tool.handler((args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        // Mirror the iyke-mcp pattern: ok:false results surface as normal
        // tool results with isError=true so the agent can read them.
        isError: result.ok === false,
      };
    } catch (err) {
      if (err instanceof McpError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'internal-error', message: msg }) }],
        isError: true,
      };
    }
  });

  // Forward sidecar events to the MCP client as logging messages. The topic
  // + projectId travel in the JSON body so consumers can demultiplex.
  //
  // WP-32: when STUDIO_SUPPRESS_EVENTS=1 the relay drops frames here instead
  // of forwarding them, so downstream (the iframe) sees no push events and
  // must fall back to polling.
  //
  // A single cell render emits only a handful of frames, so an every-50 log
  // alone printed nothing on a realistic verification run and left the tester
  // unable to tell "N frames were dropped and the UI polled" from "the
  // sidecar emitted nothing / the relay was never wired". Hence: a line on the
  // first drop, the running count every 10 after that, and a total at shutdown.
  sidecar.onEvent((evt) => {
    if (SUPPRESS_EVENTS) {
      droppedEventCount++;
      if (droppedEventCount === 1) {
        errSync(
          `[studio-mcp] STUDIO_SUPPRESS_EVENTS=1 — dropped event frame #1 (topic=${evt.topic}) ` +
            `— push path is off, the iframe must poll\n`,
        );
      } else if (
        droppedEventCount <= SUPPRESS_LOG_BULK_AFTER
          ? droppedEventCount % SUPPRESS_LOG_EVERY === 0
          : droppedEventCount % SUPPRESS_LOG_EVERY_BULK === 0
      ) {
        errSync(
          `[studio-mcp] STUDIO_SUPPRESS_EVENTS=1 — dropped ${droppedEventCount} event frame(s) so far\n`,
        );
      }
      return;
    }
    void server.sendLoggingMessage({
      level: 'info',
      logger: 'studio-mcp/sidecar-event',
      data: evt,
    }).catch((err: Error) => {
      // Logging-message send can fail before the client finishes initialize();
      // we never want to crash the server on that path.
      errSync(`[studio-mcp] failed to forward event: ${err.message}\n`);
    });
  });

  if (SUPPRESS_EVENTS) {
    errSync(
      '[studio-mcp] STUDIO_SUPPRESS_EVENTS=1 — event forwarding suppressed (poll-fallback test mode)\n',
    );
  } else if (SUPPRESS_ENV_MISSET) {
    errSync(
      `[studio-mcp] STUDIO_SUPPRESS_EVENTS is set to "${SUPPRESS_ENV_RAW}" — not the exact string "1", ` +
        'so event suppression is OFF and every event is still forwarded\n',
    );
  }

  // Boot banner (stderr only — stdout is the MCP transport).
  errSync(`[studio-mcp] ready name=${NAME} pid=${process.pid}\n`);

  // ───────────────────────────────────────────────────────────────────────
  // Shutdown paths. Every line here is written synchronously (see errSync)
  // and the census goes out BEFORE any await, because on the kernel's reload
  // path this process is terminated within milliseconds of the notice that
  // triggered the shutdown.
  // ───────────────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (censusReason: string, notice: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    errSync(`[studio-mcp] ${notice}\n`);
    printCensus(censusReason);
    // Failsafe: never let a wedged teardown strand the process.
    setTimeout(() => process.exit(0), SHUTDOWN_GIVEUP_MS).unref?.();
    void (async () => {
      try { await sidecar.stop(); } catch { /* ignore */ }
      try { await server.close(); } catch { /* ignore */ }
      process.exit(0);
    })();
  };

  process.on('SIGINT', () => shutdown('received SIGINT', 'received SIGINT, shutting down'));
  process.on('SIGTERM', () => shutdown('received SIGTERM', 'received SIGTERM, shutting down'));

  // G-108, the path that actually matters: the shell kernel's pkg reload
  // (`lifecycle.rs` shutdown branch) drops our stdin channel and then drops
  // the child handle, which is TerminateProcess / SIGKILL with no grace. No
  // signal handler and no 'exit'/'beforeExit' handler runs on that path, so
  // stdin EOF is the only notice we get — and the SDK's StdioServerTransport
  // never listens for it (it registers 'data' and 'error' only). Hence this.
  const onTransportClosed = () =>
    shutdown('stdin EOF', 'stdin EOF (MCP transport closed), shutting down');
  process.stdin.on('end', onTransportClosed);
  process.stdin.on('close', onTransportClosed);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Protocol.connect() installs its OWN transport.onclose — chain onto it
  // rather than clobbering it, so a transport-side close (one that never
  // surfaces as a stdin 'end') still reaches the census.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    onTransportClosed();
  };
}

main().catch((err) => {
  errSync(`[studio-mcp] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
