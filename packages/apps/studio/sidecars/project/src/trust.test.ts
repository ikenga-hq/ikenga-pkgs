// com.ikenga.studio project sidecar · WP-04 per-folder trust gate
//
//   bun run src/trust.test.ts   (from sidecars/project/)
//   bun run test                 (package script — runs this + the others)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as session.test.ts / recents.test.ts: this file typechecks under the shared
// `tsc -p ../../tsconfig.json` project, which has no Bun types, while still
// running for real under the bun runtime.
//
// ── What is being proved ─────────────────────────────────────────────────
//
// WP-04's whole point is that `project.open` reaches the shell's real trust
// prompt without `STUDIO_TRUST_STUB=1`, and that nothing about the new path
// lets the sidecar (or a caller of `project.open`) grant itself access.
//
// So the assertions split three ways:
//
//   1. ENDPOINT RESOLUTION — the relay URL is derived from the shell-minted
//      `IKENGA_PKG_DB_URL` / `IKENGA_PKG_DB_TOKEN` pair and from nothing else.
//      No credential ⇒ no channel ⇒ `trust-unreachable`, never a grant.
//   2. DECISION MAPPING — the host's `{ granted }` is relayed verbatim:
//      true ⇒ granted, false ⇒ `denied` (the user said no), and every
//      non-decision (404, refusal envelope, connection refused, abort) ⇒
//      `trust-unreachable`. Fails closed in all four.
//   3. NO SELF-GRANT — the request body carries `{ path }` and nothing else,
//      so there is no field by which this process could assert a grant.
//
// A real `node:http` server stands in for the shell's
// `POST /iyke/pkg-trust/project-access` route, so the transport under test is
// the shipping one (real fetch, real headers, real status codes) rather than a
// stubbed `hostInvoke`.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_TRUST_TIMEOUT_MS,
  HOST_TRUST_COMMAND,
  createHostTrustInvoke,
  requestProjectAccess,
  resolveTrustEndpoint,
} from './trust.js';

const FIXTURE_PATH = '/tmp/studio-wp04-fixture';
const TOKEN = 'pkg-db-token-deadbeef';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Fake shell — one route, scriptable per request
// ─────────────────────────────────────────────────────────────────────────

interface Capture {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

type Reply = { status: number; json: unknown };

interface FakeShell {
  /** `<origin>/iyke/pkg-db` — what the shell puts in IKENGA_PKG_DB_URL. */
  dbUrl: string;
  captures: Capture[];
  /** Reply used for the next request (and every one after it). */
  reply: Reply;
  close(): Promise<void>;
}

async function startFakeShell(): Promise<FakeShell> {
  const captures: Capture[] = [];
  const state: { reply: Reply } = { reply: { status: 200, json: { ok: true, granted: true } } };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { __unparseable: raw };
        }
      }
      captures.push({
        url: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization,
        body,
      });
      // Only the real route answers; anything else 404s the way an axum router
      // without the WP-04 route would.
      if (req.url !== '/iyke/pkg-trust/project-access') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
        return;
      }
      res.writeHead(state.reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.reply.json));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    dbUrl: `http://127.0.0.1:${port}/iyke/pkg-db`,
    captures,
    get reply(): Reply {
      return state.reply;
    },
    set reply(r: Reply) {
      state.reply = r;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A port nothing is listening on — connection refused, not a 404. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const shell = await startFakeShell();
  try {
    // ── 1. endpoint resolution ───────────────────────────────────────────

    test('the relay URL is derived from the shell-minted pkg-db URL', () => {
      const ep = resolveTrustEndpoint({
        IKENGA_PKG_DB_URL: 'http://127.0.0.1:4321/iyke/pkg-db',
        IKENGA_PKG_DB_TOKEN: TOKEN,
      } as NodeJS.ProcessEnv);
      assert.deepEqual(ep, { url: 'http://127.0.0.1:4321/iyke/pkg-trust', token: TOKEN });
    });

    test('a trailing slash on the pkg-db URL does not double up', () => {
      const ep = resolveTrustEndpoint({
        IKENGA_PKG_DB_URL: 'http://127.0.0.1:4321/iyke/pkg-db/',
        IKENGA_PKG_DB_TOKEN: TOKEN,
      } as NodeJS.ProcessEnv);
      assert.equal(ep?.url, 'http://127.0.0.1:4321/iyke/pkg-trust');
    });

    test('an explicit IKENGA_PKG_TRUST_URL wins over the derivation', () => {
      // Lets the shell publish the endpoint later without a pkg change.
      const ep = resolveTrustEndpoint({
        IKENGA_PKG_DB_URL: 'http://127.0.0.1:4321/iyke/pkg-db',
        IKENGA_PKG_TRUST_URL: 'http://127.0.0.1:9999/iyke/pkg-trust',
        IKENGA_PKG_DB_TOKEN: TOKEN,
      } as NodeJS.ProcessEnv);
      assert.equal(ep?.url, 'http://127.0.0.1:9999/iyke/pkg-trust');
    });

    test('no token ⇒ no endpoint, even with a URL present', () => {
      // The token IS the credential. A URL alone proves nothing.
      assert.equal(
        resolveTrustEndpoint({
          IKENGA_PKG_DB_URL: 'http://127.0.0.1:4321/iyke/pkg-db',
        } as NodeJS.ProcessEnv),
        null,
      );
    });

    test('no URL ⇒ no endpoint', () => {
      assert.equal(
        resolveTrustEndpoint({ IKENGA_PKG_DB_TOKEN: TOKEN } as NodeJS.ProcessEnv),
        null,
      );
    });

    test('an unrecognised pkg-db URL shape degrades instead of guessing', () => {
      // A future shell that moves the pkg-db route must not have us POSTing at
      // an address we invented.
      assert.equal(
        resolveTrustEndpoint({
          IKENGA_PKG_DB_URL: 'http://127.0.0.1:4321/iyke/somewhere-else',
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv),
        null,
      );
    });

    // ── 2. decision mapping ──────────────────────────────────────────────

    await testAsync('stub mode still grants, and never touches the network', async () => {
      const before = shell.captures.length;
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {
          STUDIO_TRUST_STUB: '1',
          IKENGA_PKG_DB_URL: shell.dbUrl,
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv,
      });
      assert.deepEqual(r, { granted: true });
      assert.equal(shell.captures.length, before, 'stub mode must not call the host');
    });

    await testAsync('a host grant relays through as granted', async () => {
      shell.reply = { status: 200, json: { ok: true, granted: true } };
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {
          IKENGA_PKG_DB_URL: shell.dbUrl,
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv,
      });
      assert.deepEqual(r, { granted: true });
    });

    await testAsync('the request carries the bearer and hits the WP-04 route', () => {
      const last = shell.captures[shell.captures.length - 1]!;
      assert.equal(last.method, 'POST');
      assert.equal(last.url, '/iyke/pkg-trust/project-access');
      assert.equal(last.authorization, `Bearer ${TOKEN}`);
      return Promise.resolve();
    });

    await testAsync('the request body is exactly { path } — no grant claim', () => {
      // The core of the design: there is no field on this wire by which the
      // sidecar (or a caller of project.open) could assert its own trust.
      // If this ever grows a `granted` / `trustToken` key, the gate is gone.
      const last = shell.captures[shell.captures.length - 1]!;
      assert.deepEqual(last.body, { path: FIXTURE_PATH });
      assert.deepEqual(Object.keys(last.body), ['path']);
      return Promise.resolve();
    });

    await testAsync('a host decline is `denied`, not `trust-unreachable`', async () => {
      shell.reply = { status: 200, json: { ok: true, granted: false } };
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {
          IKENGA_PKG_DB_URL: shell.dbUrl,
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv,
      });
      assert.deepEqual(r, { granted: false, reason: 'denied' });
    });

    await testAsync('a host refusal envelope is `trust-unreachable`', async () => {
      // 200 + { ok:false } is the host declining to *decide* (unknown token,
      // wrong pkg) — distinct from the user declining. No prompt was shown, so
      // this is unreachable, not denied.
      shell.reply = { status: 200, json: { ok: false, reason: 'unknown-token' } };
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {
          IKENGA_PKG_DB_URL: shell.dbUrl,
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv,
      });
      assert.deepEqual(r, { granted: false, reason: 'trust-unreachable' });
    });

    await testAsync('a 403 from the host is `trust-unreachable`', async () => {
      shell.reply = { status: 403, json: { ok: false, reason: 'unknown-token' } };
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {
          IKENGA_PKG_DB_URL: shell.dbUrl,
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv,
      });
      assert.deepEqual(r, { granted: false, reason: 'trust-unreachable' });
    });

    await testAsync('a shell without the WP-04 route (404) is `trust-unreachable`', async () => {
      // Shipping the pkg half ahead of the shell half must behave exactly like
      // the pre-WP-04 sidecar did: refuse, never self-grant.
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {
          IKENGA_PKG_TRUST_URL: `${shell.dbUrl.replace('/iyke/pkg-db', '')}/iyke/not-wired-yet`,
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv,
      });
      assert.deepEqual(r, { granted: false, reason: 'trust-unreachable' });
    });

    await testAsync('no shell at all (no env) is `trust-unreachable`', async () => {
      const r = await requestProjectAccess(FIXTURE_PATH, { env: {} as NodeJS.ProcessEnv });
      assert.deepEqual(r, { granted: false, reason: 'trust-unreachable' });
    });

    await testAsync('a dead bridge (connection refused) is `trust-unreachable`', async () => {
      const port = await deadPort();
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {
          IKENGA_PKG_DB_URL: `http://127.0.0.1:${port}/iyke/pkg-db`,
          IKENGA_PKG_DB_TOKEN: TOKEN,
        } as NodeJS.ProcessEnv,
      });
      assert.deepEqual(r, { granted: false, reason: 'trust-unreachable' });
    });

    await testAsync('a host that never answers times out to `trust-unreachable`', async () => {
      const hung = createServer(() => {
        /* accept the request, never respond */
      });
      await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
      const { port } = hung.address() as AddressInfo;
      try {
        const r = await requestProjectAccess(FIXTURE_PATH, {
          env: {
            IKENGA_PKG_DB_URL: `http://127.0.0.1:${port}/iyke/pkg-db`,
            IKENGA_PKG_DB_TOKEN: TOKEN,
          } as NodeJS.ProcessEnv,
          timeoutMs: 150,
        });
        assert.deepEqual(r, { granted: false, reason: 'trust-unreachable' });
      } finally {
        await new Promise<void>((resolve) => hung.close(() => resolve()));
      }
    });

    // ── 3. shim guards ───────────────────────────────────────────────────

    await testAsync('the relay refuses to carry any command but the frozen one', async () => {
      const invoke = createHostTrustInvoke({ url: 'http://127.0.0.1:1/iyke/pkg-trust', token: TOKEN });
      await assert.rejects(
        () => invoke('pkg_studio_grant_everything', { path: FIXTURE_PATH }),
        /unsupported host command/,
      );
    });

    await testAsync('an injected hostInvoke is honoured verbatim (the WP-03 seam)', async () => {
      const seen: Array<[string, Record<string, unknown>]> = [];
      const r = await requestProjectAccess(FIXTURE_PATH, {
        env: {} as NodeJS.ProcessEnv,
        hostInvoke: async (cmd, args) => {
          seen.push([cmd, args]);
          return { granted: true };
        },
      });
      assert.deepEqual(r, { granted: true });
      assert.deepEqual(seen, [[HOST_TRUST_COMMAND, { path: FIXTURE_PATH }]]);
    });

    test('the default timeout outlives a user-paced dialog', () => {
      // The prompt is a human click. If this ever drops below a minute the
      // sidecar becomes the layer that gives up on the user.
      assert.ok(
        DEFAULT_TRUST_TIMEOUT_MS >= 60_000,
        `expected a generous default, got ${DEFAULT_TRUST_TIMEOUT_MS}ms`,
      );
    });

    console.log(`\n${passed} passed`);
    return 0;
  } finally {
    await shell.close();
  }
}

process.exit(await main());
