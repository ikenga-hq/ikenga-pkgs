import { Redactor } from './secrets.js';

/**
 * Client for the ikenga-server daemon's `/api/rpc` surface, as used by the
 * Mattermost bridge to drive Chi runs.
 *
 * Wire facts (shell repo, origin/main a9f88d2e; see README "Daemon contract"):
 *  - `POST /api/rpc` with `{cmd, args}` -> `{ok:true,data}` | `{ok:false,error}`.
 *  - T1 (multi-user broker): `POST /auth/login {username,password}` -> 204 +
 *    `Set-Cookie: ikenga_session=...`. Bearer tokens are refused under T1.
 *    `Origin`, when present, must be the daemon's own or allow-listed; a
 *    missing `Origin` (which is what Node's fetch sends) is accepted.
 *  - T0 (single operator): `Authorization: Bearer <token>`.
 */

export type DaemonAuth =
  | { kind: 'session'; username: string; password: string }
  | { kind: 'bearer'; token: string };

export interface DaemonClientConfig {
  /** Base URL, e.g. `https://ikenga.example.com` or `http://127.0.0.1:4000`. */
  url: string;
  auth: DaemonAuth;
  /** Sent as the `Origin` header when set. Normally left unset (see above). */
  origin?: string;
  requestTimeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export type ChiRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_auth'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'timed_out']);

/** `ChiRunResult` (shell `server/shared/chi.rs` `pub struct ChiRunResult`). */
export interface ChiRunResult {
  run_id: string;
  status: ChiRunStatus | string;
  output?: string | null;
  output_truncated?: boolean | null;
  error?: string | null;
}

/** `chi_run` options (shell `chi_exec::ChiRunOpts`; camelCase on the wire). */
export interface ChiRunOpts {
  engineId: string;
  prompt: string;
  cwd?: string;
  model?: string;
  mode?: string;
  timeoutSeconds?: number;
  parentId?: string;
  resumeSessionId?: string;
  persistent?: boolean;
}

export type DaemonErrorKind = 'auth' | 'throttled' | 'rpc' | 'http' | 'network';

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly kind: DaemonErrorKind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DaemonError';
  }

  /**
   * True when the daemon says the run cannot be continued: it was never there
   * (expired / another principal's / daemon data reset) or has no engine
   * session id to resume against. The bridge answers by starting a fresh run.
   */
  get runGone(): boolean {
    return this.kind === 'rpc' && /chi run not found|no engine session id to resume/i.test(this.message);
  }

  /** True when the daemon refuses a resume because a detached runner is still going. */
  get runStillRunning(): boolean {
    return this.kind === 'rpc' && /is still running/i.test(this.message);
  }
}

const SESSION_COOKIE = 'ikenga_session';

export class DaemonClient {
  private readonly base: string;
  private readonly auth: DaemonAuth;
  private readonly origin?: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly redactor = new Redactor();
  private cookie: string | undefined;
  private loginInFlight: Promise<void> | undefined;
  /** Number of `/auth/login` calls made (observable for tests and logs). */
  loginCount = 0;

  constructor(config: DaemonClientConfig) {
    this.base = config.url.replace(/\/+$/, '');
    this.auth = config.auth;
    this.origin = config.origin;
    this.timeoutMs = config.requestTimeoutMs ?? 30_000;
    this.doFetch = config.fetch ?? fetch;
    if (config.auth.kind === 'session') this.redactor.add(config.auth.password);
    else this.redactor.add(config.auth.token);
  }

  /** Strip every credential this client knows about from `text`. */
  redact(text: string): string {
    return this.redactor.redact(text);
  }

  // ── typed wrappers ───────────────────────────────────────────────────────

  /** `chi_run`: options travel nested under `opts`, as `tauri-cmd.ts` sends them. */
  chiRun(opts: ChiRunOpts): Promise<ChiRunResult> {
    return this.rpc<ChiRunResult>('chi_run', { opts });
  }

  chiResume(runId: string, prompt: string): Promise<ChiRunResult> {
    return this.rpc<ChiRunResult>('chi_resume', { runId, prompt });
  }

  chiStatus(runId: string): Promise<ChiRunResult> {
    return this.rpc<ChiRunResult>('chi_status', { runId });
  }

  chiCancel(runId: string): Promise<ChiRunResult> {
    return this.rpc<ChiRunResult>('chi_cancel', { runId });
  }

  // ── transport ────────────────────────────────────────────────────────────

  async rpc<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    let res = await this.send('/api/rpc', { cmd, args });

    // A session that the daemon no longer knows (expired, restarted, password
    // changed) is a 401. Log in again exactly once, then retry the call.
    if (res.status === 401 && this.auth.kind === 'session') {
      this.cookie = undefined;
      res = await this.send('/api/rpc', { cmd, args });
    }

    const body = await this.readJson(res);
    if (res.status === 401 || res.status === 403) {
      throw new DaemonError(
        this.redact(`daemon refused ${cmd}: HTTP ${res.status}${errorText(body) ? ` ${errorText(body)}` : ''}`),
        'auth',
        res.status,
      );
    }
    if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === true) {
      return (body as { data: T }).data;
    }
    if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === false) {
      throw new DaemonError(this.redact(errorText(body) || `${cmd} failed`), 'rpc', res.status);
    }
    throw new DaemonError(this.redact(`daemon ${cmd}: unexpected HTTP ${res.status}`), 'http', res.status);
  }

  /** POST JSON with the current credential; logs in first when none is held. */
  private async send(path: string, payload: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.origin) headers.Origin = this.origin;

    if (this.auth.kind === 'bearer') {
      headers.Authorization = `Bearer ${this.auth.token}`;
    } else {
      if (!this.cookie) await this.login();
      headers.Cookie = this.cookie as string;
    }

    const res = await this.fetchJson(path, headers, payload);
    if (this.auth.kind === 'session') this.captureCookie(res); // the daemon may rotate the id
    return res;
  }

  /** Single-flight `POST /auth/login`. */
  private login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    const auth = this.auth;
    if (auth.kind !== 'session') return Promise.resolve();

    this.loginInFlight = (async () => {
      this.loginCount += 1;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.origin) headers.Origin = this.origin;
      const res = await this.fetchJson('/auth/login', headers, {
        username: auth.username,
        password: auth.password,
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        throw new DaemonError(
          'daemon login throttled (too many attempts)',
          'throttled',
          429,
          Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
        );
      }
      if (!res.ok) {
        // The daemon deliberately does not say why; neither do we.
        throw new DaemonError(`daemon login failed for user '${auth.username}': HTTP ${res.status}`, 'auth', res.status);
      }
      if (!this.captureCookie(res)) {
        throw new DaemonError('daemon login succeeded but set no session cookie', 'auth', res.status);
      }
    })().finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  /** Remember `ikenga_session=<id>` from a response. Returns whether one was set. */
  private captureCookie(res: Response): boolean {
    const jar = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of jar) {
      const pair = line.split(';', 1)[0]?.trim();
      if (pair && pair.toLowerCase().startsWith(`${SESSION_COOKIE}=`)) {
        this.redactor.add(pair.slice(pair.indexOf('=') + 1));
        this.cookie = pair;
        return true;
      }
    }
    return false;
  }

  private async fetchJson(path: string, headers: Record<string, string>, payload: unknown): Promise<Response> {
    try {
      return await this.doFetch(`${this.base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      const msg = err instanceof Error ? err.message : String(err);
      throw new DaemonError(this.redact(`daemon unreachable: ${msg}${cause ? ` (${cause})` : ''}`), 'network');
    }
  }

  private async readJson(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => '');
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}

function errorText(body: unknown): string {
  if (body && typeof body === 'object') {
    const e = (body as { error?: unknown }).error;
    if (typeof e === 'string') return e;
  }
  return '';
}
