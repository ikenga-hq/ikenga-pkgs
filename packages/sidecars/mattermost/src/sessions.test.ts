import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MattermostBridge } from './bridge.js';
import { DaemonClient, DaemonError } from './daemon.js';
import { MockDaemon } from './mock-daemon.js';
import { MockMattermostServer } from './mock-server.js';
import { resolveBridgeConfigs } from './config.js';
import { ThreadStore } from './store.js';
import type { MattermostBridgeConfig } from './types.js';

const PASSWORD = 'hunter2-very-secret';
const TOKEN = 'bearer-token-abcdef123456';
const FAST = { pollMinMs: 10, pollMaxMs: 20, editIntervalMs: 0, maxWaitMs: 60_000, maxPollFailures: 3 };

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Rig {
  mm: MockMattermostServer;
  daemon: MockDaemon;
  dir: string;
  mmUrl: string;
  daemonUrl: string;
  config: (over?: Partial<MattermostBridgeConfig>) => MattermostBridgeConfig;
  boot: (over?: Partial<MattermostBridgeConfig>) => Promise<MattermostBridge>;
  say: (id: string, text: string, opts?: { root?: string; user?: string; channel?: string }) => void;
  bridges: MattermostBridge[];
}

let rig: Rig;

async function makeRig(mode: 't0' | 't1' = 't1'): Promise<Rig> {
  const mm = new MockMattermostServer();
  const daemon = new MockDaemon(mode, { username: 'rex', password: PASSWORD, token: TOKEN });
  const mmUrl = await mm.listen();
  const daemonUrl = await daemon.listen();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mm-b2-'));
  const bridges: MattermostBridge[] = [];

  const config = (over: Partial<MattermostBridgeConfig> = {}): MattermostBridgeConfig => ({
    name: 'rex',
    mattermostUrl: mmUrl,
    mattermostToken: 'mm-token',
    allowedUsers: ['alice'],
    allowedChannels: ['engineering'],
    dataDir: dir,
    daemon: {
      url: daemonUrl,
      auth:
        mode === 't1'
          ? { kind: 'session', username: 'rex', password: PASSWORD }
          : { kind: 'bearer', token: TOKEN },
    },
    chi: { engine: 'claude-code', cwd: '~/work/rex', systemPrompt: 'You are Rex.' },
    progress: FAST,
    ...over,
  });

  const boot = async (over: Partial<MattermostBridgeConfig> = {}) => {
    const b = new MattermostBridge(config(over));
    await b.start();
    bridges.push(b);
    await new Promise((r) => setTimeout(r, 60)); // WS handshake
    return b;
  };

  const say: Rig['say'] = (id, text, opts = {}) =>
    mm.broadcastPost(
      { id, user_id: opts.user ?? 'alice', channel_id: 'c1', message: text, root_id: opts.root },
      opts.channel ?? 'engineering',
    );

  return { mm, daemon, dir, mmUrl, daemonUrl, config, boot, say, bridges };
}

beforeEach(async () => {
  rig = await makeRig('t1');
});

afterEach(async () => {
  for (const b of rig.bridges) b.stop();
  await rig.mm.close();
  await rig.daemon.close();
  rmSync(rig.dir, { recursive: true, force: true });
});

describe('DaemonClient', () => {
  it('T1: logs in once, sends the session cookie, never a bearer', async () => {
    const c = new DaemonClient({ url: rig.daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } });
    const r1 = await c.chiRun({ engineId: 'claude-code', prompt: 'hi' });
    const r2 = await c.chiStatus(r1.run_id);
    assert.equal(r2.status, 'running');
    assert.equal(rig.daemon.loginCount, 1);
    assert.equal(c.loginCount, 1);
  });

  it('T0: sends the bearer token and does not log in', async () => {
    const t0 = await makeRig('t0');
    try {
      const c = new DaemonClient({ url: t0.daemonUrl, auth: { kind: 'bearer', token: TOKEN } });
      const r = await c.chiRun({ engineId: 'claude-code', prompt: 'hi' });
      assert.match(r.run_id, /^run-/);
      assert.equal(t0.daemon.loginCount, 0);
      const bad = new DaemonClient({ url: t0.daemonUrl, auth: { kind: 'bearer', token: 'wrong-token-value' } });
      await assert.rejects(bad.chiStatus(r.run_id), (e: DaemonError) => e.kind === 'auth');
    } finally {
      await t0.mm.close();
      await t0.daemon.close();
      rmSync(t0.dir, { recursive: true, force: true });
    }
  });

  it('T1 refuses a bearer token (as the real daemon does)', async () => {
    const c = new DaemonClient({ url: rig.daemonUrl, auth: { kind: 'bearer', token: TOKEN } });
    await assert.rejects(c.chiRun({ engineId: 'claude-code', prompt: 'x' }), (e: DaemonError) => e.kind === 'auth');
  });

  it('re-logs in exactly once on a 401 and retries the call', async () => {
    const c = new DaemonClient({ url: rig.daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } });
    const run = await c.chiRun({ engineId: 'claude-code', prompt: 'hi' });
    assert.equal(c.loginCount, 1);

    rig.daemon.expireSessions();
    const st = await c.chiStatus(run.run_id); // 401 -> login -> retry succeeds
    assert.equal(st.run_id, run.run_id);
    assert.equal(c.loginCount, 2);
    assert.equal(rig.daemon.loginCount, 2);
  });

  it('gives up after one re-login if the daemon keeps answering 401', async () => {
    let logins = 0;
    let rpcs = 0;
    const stub = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/auth/login')) {
        logins += 1;
        return new Response(null, { status: 204, headers: { 'Set-Cookie': `ikenga_session=s${logins}; Path=/` } });
      }
      rpcs += 1;
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
    }) as typeof fetch;
    const c = new DaemonClient({
      url: 'http://stub',
      auth: { kind: 'session', username: 'rex', password: PASSWORD },
      fetch: stub,
    });
    await assert.rejects(c.chiStatus('run-1'), (e: DaemonError) => e.kind === 'auth' && e.status === 401);
    assert.equal(logins, 2, 'initial login + exactly one re-login');
    assert.equal(rpcs, 2, 'original call + exactly one retry');
  });

  it('reports a rejected login without saying why or echoing the password', async () => {
    const wrong = new DaemonClient({
      url: rig.daemonUrl,
      auth: { kind: 'session', username: 'rex', password: 'not-the-password' },
    });
    await assert.rejects(wrong.chiStatus('run-1'), (e: DaemonError) => e.kind === 'auth' && e.status === 401);
    assert.equal(wrong.loginCount, 1);
  });

  it('never leaks the password, token or cookie in errors', async () => {
    const wrong = new DaemonClient({
      url: rig.daemonUrl,
      auth: { kind: 'session', username: 'rex', password: 'not-the-password' },
    });
    const e1 = await wrong.chiStatus('x').catch((e: Error) => e);
    assert.ok(e1 instanceof DaemonError);
    assert.doesNotMatch((e1 as Error).message, /not-the-password/);

    // Even if a daemon echoed a secret back inside an error string, redact() removes it.
    const c = new DaemonClient({ url: rig.daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } });
    assert.equal(c.redact(`boom ${PASSWORD} and ikenga_session=abc123def`), 'boom [redacted] and ikenga_session=[redacted]');

    // An unreachable daemon: the message names the problem, not the credentials.
    const dead = new DaemonClient({
      url: 'http://127.0.0.1:1',
      auth: { kind: 'bearer', token: TOKEN },
      requestTimeoutMs: 500,
    });
    const e2 = await dead.chiStatus('x').catch((e: Error) => e);
    assert.ok(e2 instanceof DaemonError && e2.kind === 'network');
    assert.doesNotMatch((e2 as Error).message, new RegExp(TOKEN));
  });

  it('classifies run-gone and still-running errors', () => {
    assert.equal(new DaemonError('chi_resume: chi run not found: r1', 'rpc').runGone, true);
    assert.equal(
      new DaemonError('chi_resume: chi run r1 has no engine session id to resume against', 'rpc').runGone,
      true,
    );
    assert.equal(
      new DaemonError('chi_resume: chi run r1 is still running (detached chi-runner pid 4)', 'rpc').runStillRunning,
      true,
    );
    assert.equal(new DaemonError('chi_run: engine binary missing', 'rpc').runGone, false);
  });
});

describe('config', () => {
  it('resolves secrets from env or file and never from inline values in the file form', () => {
    process.env.TEST_MM_B2_PW = PASSWORD;
    try {
      const [cfg] = resolveBridgeConfigs({
        mattermostUrl: 'http://mm',
        dataDir: rig.dir,
        bots: {
          rex: {
            mattermostToken: { value: 'tok' },
            allowedUsers: ['alice'],
            allowedChannels: ['engineering'],
            daemon: { url: 'http://d', auth: { kind: 'session', username: 'rex', password: { env: 'TEST_MM_B2_PW' } } },
            chi: { engine: 'claude-code' },
          },
        },
      });
      assert.equal(cfg?.name, 'rex');
      assert.deepEqual(cfg?.daemon?.auth, { kind: 'session', username: 'rex', password: PASSWORD });
    } finally {
      delete process.env.TEST_MM_B2_PW;
    }
    assert.throws(
      () =>
        resolveBridgeConfigs({
          mattermostUrl: 'http://mm',
          bots: {
            rex: {
              mattermostToken: { value: 'tok' },
              allowedUsers: [],
              allowedChannels: [],
              daemon: { url: 'http://d', auth: { kind: 'session', username: 'rex', password: { env: 'TEST_MM_B2_UNSET' } } },
              chi: { engine: 'claude-code' },
            },
          },
        }),
      /TEST_MM_B2_UNSET is not set/,
    );
  });

  it('lets two bots name the same daemon account, each with its own entry', () => {
    const shared = { kind: 'session' as const, username: 'ops', password: { value: PASSWORD } };
    const bot = (channel: string) => ({
      mattermostToken: { value: 'tok' },
      allowedUsers: ['alice'],
      allowedChannels: [channel],
      daemon: { url: 'http://d', auth: shared },
      chi: { engine: 'claude-code' },
    });
    const cfgs = resolveBridgeConfigs({
      mattermostUrl: 'http://mm',
      dataDir: rig.dir,
      bots: { rex: bot('engineering'), ruby: bot('royalti-co') },
    });
    assert.deepEqual(cfgs.map((c) => c.name), ['rex', 'ruby']);
    assert.deepEqual(cfgs[0]?.daemon?.auth, cfgs[1]?.daemon?.auth);
  });
});

describe('thread routing (bridge + fake daemon)', () => {
  it('a new root post starts a Chi run with the bot engine, cwd and prompt prefix; progress and result come back', async () => {
    await rig.boot();
    rig.say('root-1', 'check the build');

    await waitFor(() => rig.daemon.rpcCalls('chi_run').length === 1, 'chi_run');
    const call = rig.daemon.rpcCalls('chi_run')[0]!;
    const opts = call.args.opts as Record<string, unknown>;
    assert.equal(opts.engineId, 'claude-code');
    assert.equal(opts.cwd, '~/work/rex');
    assert.equal(opts.prompt, 'You are Rex.\n\n---\n\ncheck the build');
    assert.equal(opts.persistent, true);
    assert.equal(call.origin, undefined, 'no Origin header is sent by default');

    // A "Working…" post exists in the thread right away and is edited in place.
    await waitFor(() => rig.mm.thread('root-1').length === 1, 'progress post');
    await waitFor(() => /Working… \(\d+s\)/.test(rig.mm.thread('root-1')[0] ?? ''), 'progress edit');
    assert.ok(rig.mm.patches.length >= 1);

    rig.daemon.settle('run-1', 'done', { output: 'Build is green.' });
    await waitFor(() => rig.mm.thread('root-1').includes('Build is green.'), 'final result');
    const thread = rig.mm.thread('root-1');
    assert.match(thread[0]!, /^Done in \d+s\.$/);
    assert.equal(thread[1], 'Build is green.');
    assert.equal(rig.mm.receivedPosts.every((p) => p.root_id === 'root-1'), true);
  });

  it('a reply in the thread resumes the same run via chi_resume (no second chi_run)', async () => {
    await rig.boot();
    rig.say('root-2', 'first');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    rig.daemon.settle('run-1', 'done', { output: 'one' });
    await waitFor(() => rig.mm.thread('root-2').includes('one'), 'first result');

    rig.say('reply-2', 'and now the second thing', { root: 'root-2' });
    await waitFor(() => rig.daemon.rpcCalls('chi_resume').length === 1, 'chi_resume');
    const resume = rig.daemon.rpcCalls('chi_resume')[0]!;
    assert.deepEqual(resume.args, { runId: 'run-1', prompt: 'and now the second thing' });
    assert.equal(rig.daemon.rpcCalls('chi_run').length, 1);

    rig.daemon.settle('run-1', 'done', { output: 'two' });
    await waitFor(() => rig.mm.thread('root-2').includes('two'), 'second result');
  });

  it('persists root_id -> run_id so a bridge restart keeps threading', async () => {
    const b1 = await rig.boot();
    rig.say('root-3', 'before restart');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    rig.daemon.settle('run-1', 'done', { output: 'ok1' });
    await waitFor(() => rig.mm.thread('root-3').includes('ok1'), 'result');
    await b1.router!.whenIdle();
    b1.stop();

    const file = path.join(rig.dir, 'threads-rex.json');
    assert.ok(existsSync(file));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const rec = saved.threads['root-3'];
    assert.equal(rec.run_id, 'run-1');
    assert.equal(rec.bot, 'rex');
    assert.equal(typeof rec.created_at, 'number');
    assert.equal(rec.active, undefined);

    const store2 = new ThreadStore(file, 'rex');
    assert.equal(store2.get('root-3')?.run_id, 'run-1');
    assert.equal(new ThreadStore(file, 'ruby').get('root-3'), undefined, 'another bot does not see it');

    await rig.boot(); // brand new bridge, same store file
    rig.say('reply-3', 'after restart', { root: 'root-3' });
    await waitFor(() => rig.daemon.rpcCalls('chi_resume').length === 1, 'chi_resume after restart');
    assert.equal(rig.daemon.rpcCalls('chi_resume')[0]!.args.runId, 'run-1');
    assert.equal(rig.daemon.rpcCalls('chi_run').length, 1);
  });

  it('resume of a run the daemon no longer has starts a fresh run and says so in the thread', async () => {
    await rig.boot();
    rig.say('root-4', 'first');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    rig.daemon.settle('run-1', 'done', { output: 'a' });
    await waitFor(() => rig.mm.thread('root-4').includes('a'), 'first result');

    rig.daemon.forget('run-1'); // TTL cleanup / data reset

    rig.say('reply-4', 'carry on', { root: 'root-4' });
    await waitFor(() => rig.daemon.rpcCalls('chi_run').length === 2, 'fresh chi_run');
    assert.equal(rig.daemon.rpcCalls('chi_resume').length, 1);
    assert.equal((rig.daemon.rpcCalls('chi_run')[1]!.args.opts as { prompt: string }).prompt, 'You are Rex.\n\n---\n\ncarry on');

    await waitFor(() => rig.mm.thread('root-4').some((m) => /started a fresh one/.test(m)), 'notice');
    rig.daemon.settle('run-2', 'done', { output: 'b' });
    await waitFor(() => rig.mm.thread('root-4').includes('b'), 'fresh result');
    // The notice must survive completion, not be edited away by "Done in Ns.".
    await waitFor(
      () => rig.mm.thread('root-4').some((m) => /started a fresh one/.test(m) && /Done in/.test(m)),
      'notice kept in final summary',
    );

    // The mapping now points at the new run.
    const saved = JSON.parse(readFileSync(path.join(rig.dir, 'threads-rex.json'), 'utf8'));
    assert.equal(saved.threads['root-4'].run_id, 'run-2');
  });

  it('a reply in a thread with no stored run starts a run and says there was no earlier one', async () => {
    await rig.boot();
    rig.say('reply-5', 'hello?', { root: 'someone-elses-root' });
    await waitFor(() => rig.daemon.rpcCalls('chi_run').length === 1, 'chi_run');
    assert.equal(rig.daemon.rpcCalls('chi_resume').length, 0);
    await waitFor(() => rig.mm.thread('someone-elses-root').some((m) => /no earlier run/.test(m)), 'notice');
    rig.daemon.settle('run-1', 'done', { output: 'hi' });
    await waitFor(() => rig.mm.thread('someone-elses-root').includes('hi'), 'result');
    await waitFor(
      () => rig.mm.thread('someone-elses-root').some((m) => /no earlier run/.test(m) && /Done in/.test(m)),
      'notice kept in final summary',
    );
  });

  it('"stop" as a thread reply calls chi_cancel and reports it', async () => {
    await rig.boot();
    rig.say('root-6', 'long job');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    await waitFor(() => rig.mm.thread('root-6').length === 1, 'progress post');

    rig.say('reply-6', 'stop', { root: 'root-6' });
    await waitFor(() => rig.daemon.rpcCalls('chi_cancel').length === 1, 'chi_cancel');
    assert.deepEqual(rig.daemon.rpcCalls('chi_cancel')[0]!.args, { runId: 'run-1' });
    await waitFor(() => rig.mm.thread('root-6').includes('Run cancelled.'), 'cancel ack');
    assert.match(rig.mm.thread('root-6')[0]!, /^Cancelled after \d+s\.$/);
    assert.equal(rig.daemon.rpcCalls('chi_resume').length, 0, 'stop is not sent to the agent as a prompt');

    // Nothing running now: stop says so, and does not call the daemon again.
    rig.say('reply-6b', 'cancel', { root: 'root-6' });
    await waitFor(() => rig.mm.thread('root-6').includes('Nothing is running in this thread.'), 'nothing running');
    assert.equal(rig.daemon.rpcCalls('chi_cancel').length, 1);
  });

  it('a message while a turn is running is not resumed on top of it', async () => {
    await rig.boot();
    rig.say('root-7', 'job');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    rig.say('reply-7', 'also this', { root: 'root-7' });
    await waitFor(() => rig.mm.thread('root-7').some((m) => /Still working/.test(m)), 'busy notice');
    assert.equal(rig.daemon.rpcCalls('chi_resume').length, 0);
  });

  it('gate denial: unlisted user, unlisted channel and own posts reach neither the daemon nor Mattermost', async () => {
    await rig.boot();
    rig.say('x1', 'let me in', { user: 'mallory' });
    rig.say('x2', 'wrong place', { channel: 'random' });
    rig.say('x3', 'self', { user: rig.mm.botId });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rig.daemon.calls.length, 0);
    assert.equal(rig.daemon.loginCount, 0, 'a denied post does not even log in');
    assert.equal(rig.mm.receivedPosts.length, 0);
  });

  it('with no allow-lists configured, nothing is routed (deny by default)', async () => {
    await rig.boot({ allowedUsers: [], allowedChannels: [] });
    rig.say('x4', 'hello');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rig.daemon.calls.length, 0);
  });

  it('reports a failed run with the daemon reason, and a done run with no text honestly', async () => {
    await rig.boot();
    rig.say('root-8', 'will fail');
    await waitFor(() => rig.daemon.runs.size === 1, 'run 1');
    rig.daemon.settle('run-1', 'failed', { error: 'engine exited with code 2' });
    await waitFor(() => rig.mm.thread('root-8').some((m) => /The run failed: engine exited with code 2/.test(m)), 'failure');
    assert.match(rig.mm.thread('root-8')[0]!, /^Failed after \d+s\.$/);

    // The daemon reports `output = brief` (the prompt) for a run that wrote nothing.
    rig.say('root-9', 'silent');
    await waitFor(() => rig.daemon.runs.size === 2, 'run 2');
    rig.daemon.settle('run-2', 'done'); // output stays undefined -> mock falls back to the brief
    await waitFor(() => rig.mm.thread('root-9').some((m) => /returned no result text/.test(m)), 'honest no-result');
    assert.ok(!rig.mm.thread('root-9').some((m) => m.includes('silent') && m.includes('Rex')), 'prompt is not echoed back as the result');
  });

  it('survives a daemon session expiring mid-run (re-login while polling)', async () => {
    await rig.boot();
    rig.say('root-10', 'slow');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    rig.daemon.expireSessions();
    await new Promise((r) => setTimeout(r, 60));
    rig.daemon.settle('run-1', 'done', { output: 'still got it' });
    await waitFor(() => rig.mm.thread('root-10').includes('still got it'), 'result after re-login');
    assert.equal(rig.daemon.loginCount, 2);
  });

  it('re-attaches to a run that was in flight when the bridge restarted', async () => {
    const b1 = await rig.boot();
    rig.say('root-11', 'long');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    await waitFor(() => rig.mm.thread('root-11').length === 1, 'progress post');
    // The record (with the active turn) is stored after the progress post goes up.
    await waitFor(() => {
      try {
        return Boolean(JSON.parse(readFileSync(path.join(rig.dir, 'threads-rex.json'), 'utf8')).threads?.['root-11']?.active);
      } catch {
        return false;
      }
    }, 'active turn stored');
    b1.stop(); // dies mid-run; the store still says the turn is active
    const saved = JSON.parse(readFileSync(path.join(rig.dir, 'threads-rex.json'), 'utf8'));
    assert.equal(saved.threads['root-11'].active.run_id, 'run-1');

    await rig.boot();
    rig.daemon.settle('run-1', 'done', { output: 'finished while you were away' });
    await waitFor(() => rig.mm.thread('root-11').includes('finished while you were away'), 'result after recovery');
    assert.equal(rig.daemon.rpcCalls('chi_run').length, 1);
    assert.match(rig.mm.thread('root-11')[0]!, /^Done in \d+s\.$/);
  });

  it('strips a leading @mention of the bot from the prompt', async () => {
    await rig.boot();
    rig.say('root-12', `@${rig.mm.botUsername} what is up`);
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    assert.equal((rig.daemon.rpcCalls('chi_run')[0]!.args.opts as { prompt: string }).prompt, 'You are Rex.\n\n---\n\nwhat is up');
  });

  it('a bot without daemon config still echoes (B1 behaviour preserved)', async () => {
    const b = new MattermostBridge({
      mattermostUrl: rig.mmUrl,
      mattermostToken: 'mm-token',
      allowedUsers: ['alice'],
      allowedChannels: ['engineering'],
      dataDir: rig.dir,
    });
    await b.start();
    rig.bridges.push(b);
    await new Promise((r) => setTimeout(r, 60));
    rig.say('root-13', 'ping');
    await waitFor(() => rig.mm.thread('root-13').includes('echo: ping'), 'echo');
    assert.equal(rig.daemon.calls.length, 0);
  });
});
