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
 *   • stdin EOF (MCP transport closed) → same shutdown path.
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
 *                              Observability when armed — three stderr lines,
 *                              so a run that drops only a handful of frames
 *                              still proves the frames were dropped:
 *                                • one at startup ("armed"),
 *                                • one on the FIRST dropped frame,
 *                                • a running count every 50 frames,
 *                                • a total in the shutdown path.
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
const SUPPRESS_LOG_EVERY = 50;

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
  // alone would print nothing on a realistic verification run and leave the
  // tester unable to tell "N frames were dropped and the UI polled" from "the
  // sidecar emitted nothing / the relay was never wired". Hence: a line on the
  // first drop, the running count every 50 after that, and a total at shutdown.
  let droppedEventCount = 0;
  sidecar.onEvent((evt) => {
    if (SUPPRESS_EVENTS) {
      droppedEventCount++;
      if (droppedEventCount === 1) {
        process.stderr.write(
          `[studio-mcp] STUDIO_SUPPRESS_EVENTS=1 — dropped event frame #1 (topic=${evt.topic}) ` +
            `— push path is off, the iframe must poll\n`,
        );
      } else if (droppedEventCount % SUPPRESS_LOG_EVERY === 0) {
        process.stderr.write(
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
      process.stderr.write(`[studio-mcp] failed to forward event: ${err.message}\n`);
    });
  });

  if (SUPPRESS_EVENTS) {
    process.stderr.write(
      '[studio-mcp] STUDIO_SUPPRESS_EVENTS=1 — event forwarding suppressed (poll-fallback test mode)\n',
    );
  } else if (SUPPRESS_ENV_MISSET) {
    process.stderr.write(
      `[studio-mcp] STUDIO_SUPPRESS_EVENTS is set to "${SUPPRESS_ENV_RAW}" — not the exact string "1", ` +
        'so event suppression is OFF and every event is still forwarded\n',
    );
  }

  // Boot banner (stderr only — stdout is the MCP transport).
  process.stderr.write(`[studio-mcp] ready name=${NAME} pid=${process.pid}\n`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean shutdown.
  const shutdown = async (sig: string) => {
    process.stderr.write(`[studio-mcp] received ${sig}, shutting down\n`);
    if (SUPPRESS_EVENTS) {
      process.stderr.write(
        `[studio-mcp] STUDIO_SUPPRESS_EVENTS=1 — dropped ${droppedEventCount} event frame(s) total this session\n`,
      );
    }
    try { await sidecar.stop(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[studio-mcp] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
