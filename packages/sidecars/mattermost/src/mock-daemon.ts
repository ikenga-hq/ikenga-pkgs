import http from 'node:http';
import crypto from 'node:crypto';

/**
 * A fake ikenga-server daemon: just enough of `/auth/login` and `/api/rpc` to
 * drive the bridge, mirroring the real shapes (shell origin/main a9f88d2e):
 *  - T1: login -> 204 + `ikenga_session` cookie; bearer refused (401).
 *  - T0: Bearer token only.
 *  - rpc: `{ok:true,data}` | `{ok:false,error:"<cmd>: <msg>"}`; no/invalid
 *    credential -> HTTP 401 `{ok:false,error}`.
 *  - chi_status `output` falls back to the run's brief while nothing was written.
 */
export interface FakeRun {
  run_id: string;
  status: string;
  brief: string;
  engineId: string;
  cwd?: string;
  mode?: string;
  parentId?: string;
  output?: string;
  error?: string;
  output_truncated?: boolean;
  hasSession: boolean;
  prompts: string[];
}

export interface RpcCall {
  cmd: string;
  args: Record<string, unknown>;
  origin?: string;
}

export class MockDaemon {
  private server: http.Server;
  private port = 0;
  readonly runs = new Map<string, FakeRun>();
  readonly calls: RpcCall[] = [];
  readonly sessions = new Set<string>();
  loginCount = 0;
  /** Engines the daemon will not launch: `chi_run` leaves a failed row behind and answers with an error (seen live with cursor-agent). */
  readonly refuseEngines = new Set<string>();
  private nextRun = 1;

  constructor(
    private readonly mode: 't0' | 't1',
    private readonly creds: { username?: string; password?: string; token?: string },
  ) {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => this.route(req, res, body));
    });
  }

  async listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (typeof addr === 'object' && addr) this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  close(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Forget every session, so the next call with an old cookie gets a 401. */
  expireSessions(): void {
    this.sessions.clear();
  }

  /** Make a run reach a state (what the engine / sweep would do). */
  settle(runId: string, status: string, patch: Partial<FakeRun> = {}): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no fake run ${runId}`);
    Object.assign(run, { status }, patch);
  }

  /** Delete a run, as TTL cleanup or a data reset would. */
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  rpcCalls(cmd: string): RpcCall[] {
    return this.calls.filter((c) => c.cmd === cmd);
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const json = (status: number, payload?: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    if (req.method === 'POST' && req.url === '/auth/login') {
      if (this.mode !== 't1') return json(404, { ok: false, error: 'not found' });
      const { username, password } = JSON.parse(body || '{}') as { username?: string; password?: string };
      if (username !== this.creds.username || password !== this.creds.password) {
        return json(401, { ok: false, error: 'invalid credentials' });
      }
      this.loginCount += 1;
      const id = crypto.randomBytes(12).toString('hex');
      this.sessions.add(id);
      res.writeHead(204, { 'Set-Cookie': `ikenga_session=${id}; HttpOnly; SameSite=Strict; Path=/; Secure` });
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/api/rpc') {
      if (!this.authorised(req)) return json(401, { ok: false, error: 'Unauthorized' });
      const { cmd, args } = JSON.parse(body || '{}') as { cmd: string; args: Record<string, unknown> };
      this.calls.push({ cmd, args, origin: req.headers.origin });
      const ok = (data: unknown) => json(200, { ok: true, data });
      const err = (msg: string) => json(200, { ok: false, error: `${cmd}: ${msg}` });

      switch (cmd) {
        case 'chi_run': {
          const opts = (args.opts ?? args) as {
            engineId: string;
            prompt: string;
            cwd?: string;
            mode?: string;
            parentId?: string;
          };
          const run_id = `run-${this.nextRun++}`;
          if (this.refuseEngines.has(opts.engineId)) {
            this.runs.set(run_id, { run_id, status: 'failed', brief: opts.prompt, engineId: opts.engineId, mode: opts.mode, hasSession: false, prompts: [opts.prompt] });
            return err(`engine '${opts.engineId}' could not be launched`);
          }
          this.runs.set(run_id, {
            run_id,
            status: 'running',
            brief: opts.prompt,
            engineId: opts.engineId,
            cwd: opts.cwd,
            mode: opts.mode,
            parentId: opts.parentId,
            hasSession: true,
            prompts: [opts.prompt],
          });
          return ok({ run_id, status: 'running', output: null, output_truncated: null, error: null });
        }
        case 'chi_resume': {
          const run = this.runs.get(args.runId as string);
          if (!run) return err(`chi run not found: ${args.runId}`);
          if (!run.hasSession) return err(`chi run ${run.run_id} has no engine session id to resume against`);
          run.status = 'running';
          run.output = undefined;
          run.prompts.push(args.prompt as string);
          return ok({ run_id: run.run_id, status: 'running', output: null, output_truncated: null, error: null });
        }
        case 'chi_status': {
          const run = this.runs.get(args.runId as string);
          if (!run) return err(`chi run not found: ${args.runId}`);
          return ok({
            run_id: run.run_id,
            status: run.status,
            output: run.output ?? run.brief,
            output_truncated: run.output_truncated ?? false,
            error: run.error ?? null,
          });
        }
        case 'chi_cancel': {
          const run = this.runs.get(args.runId as string);
          if (!run) return err(`chi run not found: ${args.runId}`);
          run.status = 'cancelled';
          return ok({ run_id: run.run_id, status: 'cancelled', output: null, output_truncated: null, error: null });
        }
        default:
          return err(`unknown command`);
      }
    }

    json(404, { ok: false, error: 'not found' });
  }

  private authorised(req: http.IncomingMessage): boolean {
    if (this.mode === 't0') return req.headers.authorization === `Bearer ${this.creds.token}`;
    // T1: the bearer grants nothing; only a live session cookie does.
    const m = /(?:^|;\s*)ikenga_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return Boolean(m && this.sessions.has(m[1] as string));
  }
}
