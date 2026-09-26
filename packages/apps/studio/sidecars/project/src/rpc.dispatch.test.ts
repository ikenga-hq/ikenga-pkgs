// com.ikenga.studio project sidecar · rpc.ts dispatcher — export.davinci_timeline reachability (G-75 #1)
//
//   bun run src/rpc.dispatch.test.ts   (from sidecars/project/)
//   bun run test                        (package script — runs this + the others)
//
// G-75 #1: `export.davinci_timeline` was implemented in index.ts's extended()
// switch since WP-23 but never added to rpc.ts's EXTENDED_METHODS gate, so
// every call over the real stdio transport 404'd with -32601 method-not-found
// before index.ts's handler ever ran. This proves the FULL stdio path — a
// real child process, a real JSON-RPC request line written to its real
// stdin, a real response line read back off its real stdout — dispatches
// the method through `startRpcLoop()` to a handler and gets back a
// non-(-32601) response.
//
// ── Why a driver is spawned (self-re-exec) ─────────────────────────────────
// `startRpcLoop()` owns process.stdin/stdout directly; it can't be exercised
// in-process alongside this test's own console-based assertions without the
// two fighting over the same streams. So — same technique as
// session.test.ts's respawn simulation — this file re-execs ITSELF as a
// child with a `serve` argv, which runs `startRpcLoop` against a minimal
// stub `RpcHandlers` (no real project, no real DaVinci/Resolve dependency —
// this test is about dispatcher WIRING, not the handler's own behavior,
// which davinci.test.ts already covers in full).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { startRpcLoop, type RpcHandlers } from './rpc.js';
import type { ErrorCode, GenericResult, RpcMethod } from './rpc-types.js';

const SELF = fileURLToPath(import.meta.url);

function stubHandlers(): RpcHandlers {
  const notImpl = async (): Promise<never> => {
    throw new Error('not implemented in stub');
  };
  return {
    open: notImpl as never,
    close: notImpl as never,
    list: notImpl as never,
    recents: notImpl as never,
    lastOpen: notImpl as never,
    create: notImpl as never,
    info: notImpl as never,
    async extended(method: RpcMethod, _params: unknown): Promise<GenericResult> {
      // Deliberately narrow: proves EXTENDED_METHODS gating in rpc.ts routes
      // the method through to a handler at all — not what the real
      // index.ts handler does with it (davinci.test.ts covers that).
      if (
        method === 'export.davinci_timeline' ||
        method === 'canvas.read' ||
        method === 'canvas.write' ||
        method === 'storyboard.reorder_cells' ||
        method === 'spend.status'
      ) {
        return { ok: true, stub: true, method };
      }
      return { ok: false, error: 'internal-error' as ErrorCode, message: `stub: unhandled ${method}` };
    },
  };
}

async function runServe(): Promise<void> {
  startRpcLoop(stubHandlers());
  // Keep the event loop alive on stdin; the parent kills this process once done.
}

async function main(): Promise<number> {
  let passed = 0;
  function ok(name: string): void {
    passed += 1;
    console.log(`  ok - ${name}`);
  }

  const child = spawn('bun', ['run', SELF, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: child.stdout! });
  const waiters = new Map<number, (v: Record<string, unknown>) => void>();

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const id = parsed.id as number;
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      waiter(parsed);
    }
  });

  function send(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        rejectPromise(new Error(`timed out waiting for a response to ${method}`));
      }, 15000);
      waiters.set(id, (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    // ── G-75 #1: the method dispatches — no -32601 ──────────────────────
    const davinciResp = await send(1, 'export.davinci_timeline', { projectId: 'p1' });
    assert.equal(davinciResp.error, undefined, `expected no error, got: ${JSON.stringify(davinciResp.error)}`);
    assert.ok(davinciResp.result, 'expected a result envelope');
    assert.equal((davinciResp.result as Record<string, unknown>).method, 'export.davinci_timeline');
    ok('export.davinci_timeline dispatches through startRpcLoop (no -32601 method-not-found)');

    // ── G-76: the additive Plan-25 verbs are registered too ─────────────
    // Same failure mode as G-75 #1 — a handler implemented in index.ts but
    // missing from rpc.ts's gate is unreachable over the real stdio transport.
    // WP-12's `spend.status` rides along here for the same reason: it is a
    // brand-new verb implemented in index.ts's extended() switch, which is
    // precisely the shape that produced G-75 #1. A spend gate whose status
    // verb 404s over stdio is a gate nobody can inspect.
    const additive = ['canvas.read', 'canvas.write', 'storyboard.reorder_cells', 'spend.status'];
    for (let i = 0; i < additive.length; i++) {
      const name = additive[i]!;
      const resp = await send(10 + i, name, { projectId: 'p1' });
      assert.equal(resp.error, undefined, `expected no error for ${name}, got: ${JSON.stringify(resp.error)}`);
      assert.equal((resp.result as Record<string, unknown>).method, name);
      ok(`${name} dispatches through startRpcLoop (no -32601 method-not-found)`);
    }

    // ── Negative control: a truly unregistered method still 404s ────────
    const unknownResp = await send(2, 'export.totally_made_up_method', {});
    assert.equal((unknownResp.error as { code?: number } | undefined)?.code, -32601);
    ok(
      'an actually-unregistered method still 404s (-32601) — proves the positive result above reflects real EXTENDED_METHODS gating, not a dispatcher that accepts anything',
    );
  } finally {
    child.kill();
  }

  console.log(`\n${passed} passed`);
  return 0;
}

const argv2 = process.argv[2];
if (argv2 === 'serve') {
  await runServe();
} else {
  process.exit(await main());
}
