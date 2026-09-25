/**
 * Per-folder trust gate caller.
 *
 * On the live path (post-WP-04) this reaches the shell's
 * `pkg_studio_request_project_access` decision — which canonicalizes the path,
 * returns `true` with no prompt when a grant row already exists, and otherwise
 * pops the native trust dialog — over the shell's per-pkg localhost relay:
 *
 *     POST <bridge>/iyke/pkg-trust/project-access
 *          Authorization: Bearer $IKENGA_PKG_DB_TOKEN
 *          { "path": "<abs path>" }
 *       -> { "ok": true, "granted": true|false }
 *
 * ── Why a relay, and why this one ────────────────────────────────────────
 *
 * A sidecar is a separate OS process: it cannot `invoke()` a Tauri command.
 * The obvious shortcut — let `project.open` take a `grantedByHost: true` /
 * `trustToken` argument that the iframe sets after a successful
 * `host.openFolder` — is NOT safe, because `project.open` is not an
 * iframe-only entry point. The same RPC is reachable from this pkg's MCP
 * server (any agent holding its tools) and from the manifest's iyke route
 * `POST /pkg/com.ikenga.studio/project/open`. Anything the *caller* supplies
 * is forgeable by the party the gate exists to constrain, so a caller-supplied
 * grant claim is the sidecar self-granting with one extra hop.
 *
 * The relay's credential is the one thing the forgeable side never sees: the
 * shell mints `IKENGA_PKG_DB_TOKEN` per pkg at spawn time and injects it into
 * the child's environment (`pkg/db_scope.rs::inject_env`). It is not the global
 * iyke bearer token, it is not in `hostContext`, and it never appears in a tool
 * argument. The request itself asserts nothing — its only field is a path, so
 * it can ask but never decide.
 *
 * Fails closed at every step. No env, no route (404), connection refused, an
 * `ok:false` refusal, or a timeout all resolve to `trust-unreachable`, which is
 * exactly the pre-WP-04 behaviour — so the pkg half is safe to ship before the
 * shell route exists.
 *
 * `STUDIO_TRUST_STUB=1` still short-circuits to `{ granted: true }` with a
 * stderr WARN. It comes out in a follow-up commit once the live prompt has been
 * re-verified; `session.ts::trustSourceFromEnv` keeps a stub-minted grant from
 * ever reading as a real one in the meantime.
 *
 * Contract is frozen by WP-04 — do not invent a different signature.
 * Design note: plans/studio/verify/2026-09-12-wp32-live/wp04/design-note.md
 */

export interface TrustResult {
  granted: boolean;
  reason?: 'denied' | 'trust-unreachable';
}

/** Where we call the host bridge. Kept as an injectable shim so the relay can
 *  be swapped (and tested) without touching `requestProjectAccess`. */
export type HostInvoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** The shell command this gate resolves to. Frozen by WP-04 — the HTTP relay
 *  is a transport for *this* decision, not a second one. */
export const HOST_TRUST_COMMAND = 'pkg_studio_request_project_access';

/**
 * How long we wait on the host before calling the channel dead. The prompt is
 * user-paced, so this is deliberately long: the sidecar must not be the layer
 * that gives up while a dialog is still on screen. (The shell's own 10s
 * long-lived-MCP `CALL_TIMEOUT` may still drop the *caller* first; the grant is
 * recorded regardless, so a retry then hits the no-prompt fast path.)
 */
export const DEFAULT_TRUST_TIMEOUT_MS = 600_000;

/** Resolved localhost relay: base URL plus the shell-minted per-pkg bearer. */
export interface TrustEndpoint {
  /** e.g. `http://127.0.0.1:51234/iyke/pkg-trust` — no trailing slash. */
  url: string;
  token: string;
}

export interface TrustOptions {
  /** Host invoke shim. Defaults to the localhost relay below. */
  hostInvoke?: HostInvoke;
  /** Injectable for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** Overrides {@link DEFAULT_TRUST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

function warn(msg: string): void {
  process.stderr.write(`[studio-sidecar][trust][WARN] ${msg}\n`);
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

const PKG_DB_SUFFIX = '/iyke/pkg-db';
const PKG_TRUST_SUFFIX = '/iyke/pkg-trust';

/**
 * Resolve the host trust relay from the environment the shell handed this
 * process, or `null` when there is no shell (standalone dev, a bare `bun run`,
 * or a shell too old to publish the bridge).
 *
 * `IKENGA_PKG_TRUST_URL` wins when present — that lets the shell publish the
 * endpoint explicitly later without a pkg change. Otherwise we derive it from
 * `IKENGA_PKG_DB_URL`, which the shell already sets to `<bridge>/iyke/pkg-db`;
 * the suffix is asserted rather than assumed, so a future shell that changes
 * that shape degrades to `trust-unreachable` instead of POSTing at a guess.
 */
export function resolveTrustEndpoint(env: NodeJS.ProcessEnv = process.env): TrustEndpoint | null {
  const token = env.IKENGA_PKG_DB_TOKEN;
  if (!token) return null;

  const explicit = env.IKENGA_PKG_TRUST_URL;
  if (explicit) return { url: stripTrailingSlash(explicit), token };

  const dbUrl = env.IKENGA_PKG_DB_URL;
  if (!dbUrl) return null;
  const base = stripTrailingSlash(dbUrl);
  if (!base.endsWith(PKG_DB_SUFFIX)) return null;
  return { url: `${base.slice(0, -PKG_DB_SUFFIX.length)}${PKG_TRUST_SUFFIX}`, token };
}

/**
 * Build the authenticated `HostInvoke` for `endpoint`.
 *
 * Note what crosses the wire: `{ path }` and nothing else. There is
 * deliberately no field by which this process could assert a grant — the host
 * is the only party that decides, and the only party that writes a grant row.
 *
 * Throws on every non-decision (bad status, refusal envelope, abort); the
 * caller maps a throw to `trust-unreachable`. A real `{ granted: false }` is
 * NOT a throw — that is the user saying no, which is `denied`.
 */
export function createHostTrustInvoke(
  endpoint: TrustEndpoint,
  opts: { fetchImpl?: typeof globalThis.fetch; timeoutMs?: number } = {},
): HostInvoke {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS;

  return async (cmd, args) => {
    if (cmd !== HOST_TRUST_COMMAND) {
      throw new Error(`unsupported host command: ${cmd}`);
    }
    if (typeof doFetch !== 'function') {
      throw new Error('no fetch implementation available in this runtime');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${endpoint.url}/project-access`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify({ path: args.path }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`host trust relay returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        ok?: boolean;
        granted?: boolean;
        reason?: string;
        error?: string;
      };
      if (body?.ok === false) {
        throw new Error(`host refused the trust relay: ${body.reason ?? body.error ?? 'unknown'}`);
      }
      return { granted: Boolean(body?.granted) };
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function requestProjectAccess(
  path: string,
  opts: TrustOptions = {},
): Promise<TrustResult> {
  const env = opts.env ?? process.env;

  // Test/dev stub — explicitly opted in via env. Checked first so a stub run
  // never touches the network.
  if (env.STUDIO_TRUST_STUB === '1') {
    warn(`STUDIO_TRUST_STUB=1 auto-granting trust for ${path}`);
    return { granted: true };
  }

  let invoke = opts.hostInvoke;
  if (!invoke) {
    const endpoint = resolveTrustEndpoint(env);
    if (!endpoint) {
      // No shell-minted credential ⇒ no host to ask. Refuse politely rather
      // than crashing, and never self-grant.
      warn(`no host trust channel (IKENGA_PKG_DB_TOKEN/URL unset) for ${path}`);
      return { granted: false, reason: 'trust-unreachable' };
    }
    invoke = createHostTrustInvoke(endpoint, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
  }

  try {
    const res = (await invoke(HOST_TRUST_COMMAND, { path })) as { granted?: boolean };
    // `reason` is OMITTED on a grant rather than set to `undefined` — the same
    // shape the stub branch returns, so callers (and `assert.deepEqual`) see one
    // success shape instead of two.
    return res?.granted ? { granted: true } : { granted: false, reason: 'denied' };
  } catch (err) {
    warn(`hostInvoke failed for ${path}: ${(err as Error).message}`);
    return { granted: false, reason: 'trust-unreachable' };
  }
}
