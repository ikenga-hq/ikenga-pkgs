/**
 * Child-process manager + JSON-RPC client for the @ikenga/studio project
 * sidecar.
 *
 * Spawns `node <sidecar.js>`, pipes line-delimited JSON-RPC over its
 * stdio, correlates requests by `id`, fans out `event` notifications
 * (`method: 'event'` per sidecar `events.ts`) to subscribers, and
 * auto-respawns on stdio EOF with exponential backoff (up to 3 retries).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

/**
 * Generous timeout for tool calls that synchronously await an external
 * dependency inside the RPC (fal.ai image generation, large asset downloads).
 * The 30s default is too tight for a cold fal round-trip or a big file fetch;
 * these calls mutate on-disk state, so a premature timeout would surface a
 * false failure while the mutation completes anyway.
 */
export const EXTERNAL_CALL_TIMEOUT_MS = 600_000;

/**
 * After a respawn, the child must stay alive this long before it counts as
 * recovered and we reset the retry counter. Node populates a ChildProcess
 * synchronously even when the binary dies instantly, so a crash-looping child
 * would otherwise reset the counter forever and never reach the cap.
 */
const RESPAWN_GRACE_MS = 10_000;

/** How long a timed-out call's id/method is remembered so a late response can
 * be named in the drop log. Bounds the tracking map. */
const LATE_RESPONSE_TTL_MS = 300_000;

// ─────────────────────────────────────────────────────────────────────────
// JSON-RPC framing types (mirror sidecars/project/src/rpc.ts)
// ─────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcEventNotification {
  jsonrpc: '2.0';
  method: 'event';
  params: {
    topic: string;
    projectId: string;
    payload: unknown;
    ts: number;
  };
}

export type EventListener = (evt: JsonRpcEventNotification['params']) => void;

// ─────────────────────────────────────────────────────────────────────────
// Sidecar path resolution
// ─────────────────────────────────────────────────────────────────────────

function defaultSidecarPath(): string {
  if (process.env.STUDIO_SIDECAR_PATH) return process.env.STUDIO_SIDECAR_PATH;
  // dist/index.js → ../../sidecars/project/dist/sidecar.js  (relative to MCP dist)
  // src/sidecar-client.ts (during typecheck) → ../../sidecars/project/dist/sidecar.js
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '../../sidecars/project/dist/sidecar.js');
}

// ─────────────────────────────────────────────────────────────────────────
// SidecarClient
// ─────────────────────────────────────────────────────────────────────────

export interface SidecarClientOptions {
  /** Absolute path to the sidecar's built `dist/sidecar.js`. Defaults to STUDIO_SIDECAR_PATH or `../../sidecars/project/dist/sidecar.js`. */
  sidecarPath?: string;
  /** Optional env overrides passed to the child. */
  env?: NodeJS.ProcessEnv;
  /** Max auto-respawn attempts before giving up (default 3). */
  maxRespawnAttempts?: number;
}

export interface SidecarCallOptions {
  /** Per-call timeout in ms (default 30_000). */
  timeoutMs?: number;
}

export class SidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarUnavailableError';
  }
}

export class SidecarRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'SidecarRpcError';
    this.code = code;
    this.data = data;
  }
}

export class SidecarClient {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }
  >();
  /** ids of calls that already timed out, kept briefly so a late response can
   * be named (not just dropped) in the log. */
  private timedOut = new Map<number, { method: string; at: number }>();
  private listeners = new Set<EventListener>();
  private respawnAttempts = 0;
  private respawning = false;
  private respawnGraceTimer: NodeJS.Timeout | null = null;
  private readonly sidecarPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxRespawnAttempts: number;
  private deadReason: string | null = null;
  private shuttingDown = false;

  constructor(opts: SidecarClientOptions = {}) {
    this.sidecarPath = opts.sidecarPath ?? defaultSidecarPath();
    this.env = { ...process.env, ...(opts.env ?? {}) };
    this.maxRespawnAttempts = opts.maxRespawnAttempts ?? 3;
  }

  start(): void {
    if (this.child) return;
    this.spawnChild();
  }

  /** Subscribe to event notifications. Returns an unsubscribe fn. */
  onEvent(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Send a JSON-RPC request and await its response. */
  async call<T = unknown>(method: string, params?: unknown, opts: SidecarCallOptions = {}): Promise<T> {
    if (this.deadReason && !this.child) {
      throw new SidecarUnavailableError(this.deadReason);
    }
    if (!this.child) this.spawnChild();
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new SidecarUnavailableError('sidecar stdin not writable');
    }

    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = opts.timeoutMs ?? 30_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.recordTimedOut(id, method);
        reject(new Error(`sidecar call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        method,
      });
      try {
        child.stdin!.write(JSON.stringify(req) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SidecarUnavailableError(`sidecar write failed: ${(e as Error).message}`));
      }
    });
  }

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (!this.child) return;
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    // Give it 1.5s to exit cleanly, then SIGTERM.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
        resolve();
      }, 1500);
      this.child?.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private spawnChild(): void {
    // Single spawn lock shared by start(), call(), and attemptRespawn(): never
    // overwrite a live child (that would orphan its process + leak its readline
    // listener). A backoff-sleeping respawn and a concurrent call() both funnel
    // here; whoever spawns first sets this.child, the other no-ops.
    if (this.child) return;
    if (!existsSync(this.sidecarPath)) {
      this.deadReason = `sidecar binary not found at ${this.sidecarPath}`;
      process.stderr.write(`[studio-mcp] ${this.deadReason}\n`);
      return;
    }

    // Report the REAL runtime, not a hardcoded "node". The sidecar is built
    // `--target=bun` with a `#!/usr/bin/env bun` shebang, and it inherits
    // whatever runtime this MCP is running under via `process.execPath` — so
    // launching the MCP with node kills the child on `Cannot find package
    // 'ws'`. This line used to say "node" unconditionally, which actively
    // pointed debugging away from the real cause.
    process.stderr.write(`[studio-mcp] spawning sidecar: ${process.execPath} ${this.sidecarPath}\n`);
    const child = spawn(process.execPath, [this.sidecarPath], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.deadReason = null;

    // Stderr → our stderr (preserve sidecar diagnostics).
    child.stderr?.on('data', (b: Buffer) => {
      process.stderr.write(b);
    });

    // Stdout → line-delimited JSON.
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.rl = rl;
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcResponse | JsonRpcEventNotification;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcEventNotification;
      } catch {
        process.stderr.write(`[studio-mcp] sidecar emitted non-JSON line: ${trimmed.slice(0, 200)}\n`);
        return;
      }
      this.routeMessage(msg);
    });

    child.on('error', (err) => {
      process.stderr.write(`[studio-mcp] sidecar spawn error: ${err.message}\n`);
    });

    child.on('exit', (code, signal) => {
      process.stderr.write(`[studio-mcp] sidecar exited code=${code} signal=${signal}\n`);
      // Reject every in-flight call.
      const reason = `sidecar exited (code=${code} signal=${signal})`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new SidecarUnavailableError(reason));
      }
      this.pending.clear();
      this.child = null;
      this.rl?.close();
      this.rl = null;
      // Child exited before proving it stayed up: cancel the pending
      // recovery-reset so this counts toward the retry cap.
      if (this.respawnGraceTimer) {
        clearTimeout(this.respawnGraceTimer);
        this.respawnGraceTimer = null;
      }

      if (this.shuttingDown) return;
      this.attemptRespawn();
    });
  }

  private routeMessage(msg: JsonRpcResponse | JsonRpcEventNotification): void {
    // Event notification: no `id`, `method === 'event'`.
    if ('method' in msg && msg.method === 'event' && 'params' in msg) {
      const params = (msg as JsonRpcEventNotification).params;
      for (const l of this.listeners) {
        try { l(params); } catch (err) {
          process.stderr.write(`[studio-mcp] event listener threw: ${(err as Error).message}\n`);
        }
      }
      return;
    }

    // Response.
    const resp = msg as JsonRpcResponse;
    if (resp.id == null || typeof resp.id !== 'number') return;
    // A real response proves a respawned child is up → recover early (before
    // the grace timer would).
    if (this.respawnAttempts > 0) this.markRecovered();
    const slot = this.pending.get(resp.id);
    if (!slot) {
      // No pending slot: the call already timed out (response is late) or the
      // id is unknown. Log it — a silently-dropped late response is exactly
      // what makes false-failure / duplicate-mutation bugs invisible.
      const late = this.timedOut.get(resp.id);
      if (late) {
        this.timedOut.delete(resp.id);
        process.stderr.write(
          `[studio-mcp] dropping late sidecar response id=${resp.id} method='${late.method}' ` +
            `(call already timed out — its mutation may have completed on disk)\n`,
        );
      } else {
        process.stderr.write(`[studio-mcp] dropping sidecar response for unknown id=${resp.id}\n`);
      }
      return;
    }
    this.pending.delete(resp.id);
    clearTimeout(slot.timer);
    if (resp.error) {
      slot.reject(new SidecarRpcError(resp.error.code, resp.error.message, resp.error.data));
    } else {
      slot.resolve(resp.result);
    }
  }

  /**
   * Single respawn attempt. Re-invoked by the child `exit` handler, so a chain
   * of early-exiting children walks the retry counter up to the cap. The
   * counter is reset only once a child *proves* it stayed up — via a real RPC
   * response (`markRecovered`) or by surviving the grace window
   * (`armRespawnGraceTimer`) — NOT the instant `spawnChild()` returns truthy,
   * which a crash-looping binary always does.
   */
  private attemptRespawn(): void {
    if (this.respawning || this.shuttingDown) return;
    if (this.respawnAttempts >= this.maxRespawnAttempts) {
      this.deadReason = `sidecar respawn gave up after ${this.maxRespawnAttempts} attempts`;
      process.stderr.write(`[studio-mcp] ${this.deadReason}\n`);
      return;
    }
    this.respawning = true;
    this.respawnAttempts++;
    const backoff = Math.min(2000 * 2 ** (this.respawnAttempts - 1), 8000);
    process.stderr.write(
      `[studio-mcp] sidecar respawn attempt ${this.respawnAttempts}/${this.maxRespawnAttempts} in ${backoff}ms\n`,
    );
    setTimeout(() => {
      this.respawning = false;
      if (this.shuttingDown) return;
      this.spawnChild();
      // If the child failed to spawn (e.g. binary missing → deadReason set),
      // stop; a live child arms the grace timer and awaits proof of life.
      if (this.child) this.armRespawnGraceTimer();
    }, backoff);
  }

  /** Counter reset once a respawned child survives the grace window. */
  private armRespawnGraceTimer(): void {
    if (this.respawnGraceTimer) clearTimeout(this.respawnGraceTimer);
    const spawned = this.child;
    this.respawnGraceTimer = setTimeout(() => {
      this.respawnGraceTimer = null;
      if (this.child && this.child === spawned) this.markRecovered();
    }, RESPAWN_GRACE_MS);
  }

  /** The current child is confirmed up: clear the retry state. */
  private markRecovered(): void {
    this.respawnAttempts = 0;
    this.deadReason = null;
    if (this.respawnGraceTimer) {
      clearTimeout(this.respawnGraceTimer);
      this.respawnGraceTimer = null;
    }
  }

  /** Remember a timed-out call's id → method briefly so a late response can be
   * named in the drop log; prune stale entries to bound the map. */
  private recordTimedOut(id: number, method: string): void {
    const now = Date.now();
    for (const [k, v] of this.timedOut) {
      if (now - v.at > LATE_RESPONSE_TTL_MS) this.timedOut.delete(k);
    }
    this.timedOut.set(id, { method, at: now });
  }
}
