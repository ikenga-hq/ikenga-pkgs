import { describe, it, beforeEach, afterEach, after } from 'node:test';
import { sweepTmp, tmpDir } from './test-tmp.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from './audit.js';
import type { AuditRecord } from './audit.js';
import type { ApprovalRecord } from './approvals.js';
import { MattermostBridge } from './bridge.js';
import { resolveBridgeConfigs } from './config.js';
import type { BridgeFileConfig } from './config.js';
import { DaemonClient } from './daemon.js';
import { MockDaemon } from './mock-daemon.js';
import { MockMattermostServer } from './mock-server.js';
import { Rails } from './rails.js';
import type { WireMode } from './rails.js';
import { ThreadRouter } from './sessions.js';
import { ThreadStore } from './store.js';
import type { MattermostBridgeConfig, MattermostPost } from './types.js';

/**
 * B5 through the real bridge against the mocks: what the audit log records for each kind of event, that it never
 * holds message text or a secret, and that the mode ceiling and the audit gate refuse at every `chi_run` /
 * `chi_resume` call site. Unit tests of the pieces are in audit.test.ts and rails.test.ts.
 */

const PASSWORD = 'hunter2-very-secret';
const MM_TOKEN = 'mm-token-sekrit-xyz';
const FAST = { pollMinMs: 10, pollMaxMs: 20, editIntervalMs: 0, maxWaitMs: 60_000, maxPollFailures: 3 };
const PLAN = 'Plan: 1. edit src/a.ts  2. add a test';
const PLAN_SHA = createHash('sha256').update(PLAN).digest('hex');
const TEXT = 'SECRET-USER-TEXT-do-not-log';

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mm: MockMattermostServer;
let daemon: MockDaemon;
let dir: string;
let mmUrl: string;
let daemonUrl: string;
const bridges: MattermostBridge[] = [];
const auditFile = () => path.join(dir, 'audit-rex.jsonl');

beforeEach(async () => {
  mm = new MockMattermostServer();
  daemon = new MockDaemon('t1', { username: 'rex', password: PASSWORD });
  mmUrl = await mm.listen();
  daemonUrl = await daemon.listen();
  dir = tmpDir('mm-b5-int-');
});

afterEach(async () => {
  for (const b of bridges.splice(0)) b.stop();
  await mm.close();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const audit = (): AuditRecord[] => {
  try {
    return readFileSync(auditFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRecord);
  } catch {
    return [];
  }
};
const events = (...names: string[]) => audit().filter((r) => names.includes(r.event));
const hasEvent = (event: string, pred: (r: AuditRecord) => boolean = () => true) => audit().some((r) => r.event === event && pred(r));
const rawAudit = () => (existsSync(auditFile()) ? readFileSync(auditFile(), 'utf8') : '');

const baseConfig = (over: Partial<MattermostBridgeConfig> = {}): MattermostBridgeConfig => ({
  name: 'rex',
  mattermostUrl: mmUrl,
  mattermostToken: MM_TOKEN,
  allowedUsers: ['alice'],
  allowedChannels: ['engineering', 'rex-test'],
  dataDir: dir,
  daemon: { url: daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } },
  chi: { engine: 'claude-code', cwd: '~/work/rex', systemPrompt: 'You are Rex.' },
  progress: FAST,
  ...over,
});

async function boot(over: Partial<MattermostBridgeConfig> = {}): Promise<MattermostBridge> {
  const b = new MattermostBridge(baseConfig(over));
  bridges.push(b);
  await b.start();
  await pause(60); // WS handshake
  return b;
}

const say = (id: string, text: string, opts: { root?: string; user?: string; channel?: string; name?: string | null } = {}) =>
  mm.broadcastPost(
    { id, user_id: opts.user ?? 'alice', channel_id: 'c1', message: text, root_id: opts.root },
    opts.channel ?? 'engineering',
    opts.name === null ? undefined : (opts.name ?? '@alice'),
  );
const react = (postId: string, user: string, emoji = '+1') => mm.broadcastReaction({ user_id: user, post_id: postId, emoji_name: emoji });
const approvalPost = (root: string) => mm.receivedPosts.find((p) => p.root_id === root && p.message.startsWith('**Approval needed**'))?.id;
const breakAudit = () => {
  rmSync(auditFile(), { force: true });
  mkdirSync(auditFile()); // a directory where the log should be: every write now fails
};
const APPROVALS = { approvers: ['alice', 'bob'], timeoutMs: 60_000 };

/** Start a gated thread, let the plan run finish, return the approval post id. */
async function planned(root: string, text = TEXT): Promise<string> {
  const before = daemon.runs.size;
  say(root, text);
  await waitFor(() => daemon.runs.size === before + 1, 'plan run');
  daemon.settle(`run-${before + 1}`, 'done', { output: PLAN });
  await waitFor(() => approvalPost(root) !== undefined, 'approval post');
  const id = approvalPost(root) as string;
  await waitFor(() => hasEvent('approval.requested', (r) => r.thread_root === root), 'approval.requested record');
  return id;
}

// ── thread runs ──────────────────────────────────────────────────────────────

describe('audit: thread runs', () => {
  it('records config load, then started / resumed / finished / cancelled, with who asked, and no message text or secret', async () => {
    await boot();
    say('p1', `${TEXT} one`);
    await waitFor(() => daemon.runs.size === 1, 'run-1');
    daemon.settle('run-1', 'done', { output: 'SECRET-OUTPUT' });
    await waitFor(() => mm.thread('p1').includes('SECRET-OUTPUT'), 'first result posted');

    say('p2', `${TEXT} two`, { root: 'p1' });
    await waitFor(() => daemon.rpcCalls('chi_resume').length === 1, 'resume');
    daemon.settle('run-1', 'done', { output: 'SECRET-OUTPUT-2' });
    await waitFor(() => mm.thread('p1').includes('SECRET-OUTPUT-2'), 'second result posted');

    say('p3', `${TEXT} three`, { root: 'p1' });
    await waitFor(() => daemon.rpcCalls('chi_resume').length === 2, 'second resume');
    await waitFor(() => hasEvent('run.resumed', (r) => r.attached === undefined && events('run.resumed').length === 2), 'second resumed record');
    say('p4', 'stop', { root: 'p1' });
    await waitFor(() => hasEvent('run.cancelled'), 'cancelled');

    const names = audit().map((r) => r.event);
    assert.deepEqual(names, [
      'config.loaded',
      'run.requested', 'run.started', 'run.finished',
      'run.requested', 'run.resumed', 'run.finished',
      'run.requested', 'run.resumed', 'run.cancelled',
    ]);
    const [, req1, started, fin1, req2, resumed, , , , cancelled] = audit();
    assert.equal(req1?.kind, 'thread');
    assert.equal(req1?.mode, 'plan');
    assert.equal(req1?.max_mode, 'plan');
    assert.equal(req1?.thread_root, 'p1');
    assert.equal(req1?.channel_id, 'c1');
    assert.equal(req1?.user_id, 'alice');
    assert.equal(req1?.user_name, 'alice', 'leading @ stripped');
    assert.equal(started?.run_id, 'run-1');
    assert.equal(started?.request_id, req1?.request_id, 'the pre-record and the started record are tied together');
    assert.equal(fin1?.status, 'done');
    assert.equal(fin1?.run_id, 'run-1');
    assert.equal(typeof fin1?.duration_s, 'number');
    assert.equal(req2?.kind, 'resume');
    assert.equal(resumed?.run_id, 'run-1');
    assert.equal(resumed?.request_id, req2?.request_id);
    assert.equal(cancelled?.run_id, 'run-1');
    assert.equal(cancelled?.user_id, 'alice');
    assert.equal(cancelled?.mode, 'plan');

    const raw = rawAudit();
    for (const secret of [TEXT, 'SECRET-OUTPUT', PASSWORD, MM_TOKEN, 'You are Rex']) assert.ok(!raw.includes(secret), `audit must not contain ${secret}`);
    assert.ok(!raw.includes('prompt_sha'), 'no prompt hash unless the bot asks for it');
    assert.equal(statSync(auditFile()).mode & 0o777, 0o600);
  });

  it('config.loaded says what the bot is allowed to do, by count and name, never by secret', async () => {
    await boot({ maxMode: 'acceptEdits', branchPrefix: 'rex/', approvals: APPROVALS });
    const r = events('config.loaded')[0];
    assert.equal(r?.max_mode, 'auto');
    assert.equal(r?.thread_mode, 'plan');
    assert.equal(r?.acting_mode, 'auto');
    assert.equal(r?.approvals, true);
    assert.equal(r?.approvers, 2);
    assert.equal(r?.branch_prefix, 'rex/');
    assert.equal(r?.allowed_users, 1);
    assert.equal(r?.allowed_channels, 2);
    assert.ok(!rawAudit().includes(MM_TOKEN));
    assert.ok(!rawAudit().includes('alice'), 'no user names in config.loaded, only counts');
  });

  it('a bot with no chi_run permission above plan sends mode `plan` explicitly (B5 default), not the daemon default', async () => {
    await boot();
    say('p1', 'hi');
    await waitFor(() => daemon.runs.size === 1, 'run');
    assert.equal(daemon.runs.get('run-1')?.mode, 'plan');
  });

  it('chi.mode is honoured up to maxMode, and `acceptEdits` reaches the daemon as its id `auto`', async () => {
    await boot({ maxMode: 'acceptEdits', chi: { engine: 'claude-code', mode: 'acceptEdits' } });
    say('p1', 'hi');
    await waitFor(() => daemon.runs.size === 1, 'run');
    assert.equal(daemon.runs.get('run-1')?.mode, 'auto');
    assert.equal(events('run.requested')[0]?.mode, 'auto');
  });

  it('audit.promptHash adds a truncated SHA-256 and a length, still no text', async () => {
    await boot({ audit: { promptHash: true } });
    say('p1', 'hello world');
    await waitFor(() => hasEvent('run.requested'), 'record');
    const r = events('run.requested')[0];
    assert.equal(r?.prompt_sha, createHash('sha256').update('hello world').digest('hex').slice(0, 16));
    assert.equal(r?.prompt_len, 11);
    assert.ok(!rawAudit().includes('hello world'));
  });
});

// ── approvals ────────────────────────────────────────────────────────────────

describe('audit: approvals', () => {
  it('request -> decision -> acting run: plan hash, approver id+name, mode, branch prefix; plan text never recorded', async () => {
    await boot({ maxMode: 'acceptEdits', branchPrefix: 'rex/', approvals: APPROVALS });
    const post = await planned('r1');
    react(post, 'bob');
    await waitFor(() => daemon.runs.size === 2, 'acting run');
    daemon.settle('run-2', 'done', { output: 'did it' });
    await waitFor(() => events('run.finished').length === 2, 'act finished');

    const req = events('approval.requested')[0];
    assert.equal(req?.plan_hash, PLAN_SHA);
    assert.equal(req?.plan_run_id, 'run-1');
    assert.equal(req?.thread_root, 'r1');
    assert.equal(req?.requester_id, 'alice');
    assert.equal(req?.requester_name, 'alice');
    assert.equal(req?.acting_mode, 'auto');
    assert.match(String(req?.expires_at), /^\d{4}-\d\d-\d\dT/);

    const dec = events('approval.decided')[0];
    assert.equal(dec?.decision, 'approved');
    assert.equal(dec?.approver_id, 'bob');
    assert.equal(dec?.approver_name, 'bob');
    assert.equal(dec?.plan_hash, PLAN_SHA);
    assert.equal(dec?.request_id, req?.request_id);

    const act = events('run.requested').find((r) => r.kind === 'act');
    assert.equal(act?.mode, 'auto');
    assert.equal(act?.approver_id, 'bob');
    assert.equal(act?.approver_name, 'bob');
    assert.equal(act?.requester_name, 'alice');
    assert.equal(act?.plan_hash, PLAN_SHA);
    assert.equal(act?.approval_id, req?.request_id);
    assert.equal(act?.branch_prefix, 'rex/');
    const started = events('run.started').find((r) => r.kind === 'act');
    assert.equal(started?.run_id, 'run-2');
    assert.equal(started?.parent_run_id, 'run-1');
    assert.equal(started?.request_id, act?.request_id);
    assert.equal(events('run.finished').find((r) => r.run_id === 'run-2')?.kind, 'act');

    // order: the decision is on record before the acting run is requested, which is before it starts
    const names = audit().map((r) => r.event);
    assert.ok(names.indexOf('approval.decided') < names.indexOf('run.requested', names.indexOf('run.finished')));
    const raw = rawAudit();
    for (const s of [PLAN, 'edit src/a.ts', TEXT, 'did it']) assert.ok(!raw.includes(s), `audit must not contain ${s}`);
  });

  it('the branch prefix reaches the plan prompt and the acting prompt as an ADVISORY note; nothing else changes', async () => {
    await boot({ maxMode: 'acceptEdits', branchPrefix: 'rex/', approvals: APPROVALS });
    const post = await planned('r1');
    react(post, 'alice');
    await waitFor(() => daemon.runs.size === 2, 'acting run');
    const [plan, act] = [daemon.runs.get('run-1')?.brief ?? '', daemon.runs.get('run-2')?.brief ?? ''];
    assert.match(plan, /branches whose names start with `rex\/`/);
    assert.match(act, /branches whose names start with `rex\/`/);
    assert.ok(act.includes(PLAN), 'the approved plan is still handed over exactly');
  });

  it('without a prefix there is no branch note', async () => {
    await boot({ maxMode: 'acceptEdits', approvals: APPROVALS });
    const post = await planned('r1');
    react(post, 'alice');
    await waitFor(() => daemon.runs.size === 2, 'acting run');
    assert.ok(!(daemon.runs.get('run-2')?.brief ?? '').includes('Bridge note: work only on git branches'));
    assert.equal(events('run.requested').find((r) => r.kind === 'act')?.branch_prefix, undefined);
  });

  it('a denial, an expiry, a withdrawal by new message and one by `stop` are each recorded, with the plan hash', async () => {
    await boot({ maxMode: 'acceptEdits', approvals: { approvers: ['alice'], timeoutMs: 1500 } });
    const denied = await planned('d1');
    react(denied, 'alice', '-1');
    await waitFor(() => hasEvent('approval.decided'), 'denied');
    assert.equal(events('approval.decided')[0]?.decision, 'denied');
    assert.equal(daemon.runs.size, 1, 'a denial starts nothing');

    await planned('e1');
    await waitFor(() => hasEvent('approval.expired'), 'expired', 8_000);
    assert.equal(events('approval.expired')[0]?.thread_root, 'e1');

  });

  it('withdrawals: a newer message supersedes, and `stop` cancels', async () => {
    await boot({ maxMode: 'acceptEdits', approvals: APPROVALS });
    await planned('w1');
    say('w1b', 'actually, different idea', { root: 'w1' });
    await waitFor(() => hasEvent('approval.withdrawn'), 'superseded');
    assert.equal(events('approval.withdrawn')[0]?.reason, 'superseded');
    assert.equal(events('approval.withdrawn')[0]?.plan_hash, PLAN_SHA);

    await planned('w2');
    say('w2b', 'stop', { root: 'w2' });
    await waitFor(() => events('approval.withdrawn').length === 2, 'cancelled');
    assert.equal(events('approval.withdrawn')[1]?.reason, 'cancelled');
  });

  it('a 👍 from someone who is not an approver, or who cannot be looked up, is recorded as a rejected attempt and starts nothing', async () => {
    await boot({ maxMode: 'acceptEdits', approvals: APPROVALS });
    const post = await planned('x1');
    react(post, 'mallory');
    await waitFor(() => hasEvent('approval.rejected'), 'rejected');
    let r = events('approval.rejected')[0];
    assert.equal(r?.user_id, 'mallory');
    assert.equal(r?.user_name, 'mallory');
    assert.equal(r?.reason, 'not_approver');
    assert.equal(r?.verdict, 'approve');
    mm.users.delete('ghost');
    react(post, 'ghost');
    await waitFor(() => events('approval.rejected').length === 2, 'unverifiable');
    r = events('approval.rejected')[1];
    assert.equal(r?.reason, 'unverifiable_user');
    assert.equal(r?.user_name, undefined);
    await pause(80);
    assert.equal(daemon.runs.size, 1);
    assert.equal(events('approval.decided').length, 0);
  });
});

// ── schedules ────────────────────────────────────────────────────────────────

describe('audit: schedules', () => {
  const SCHEDULE = { name: 'check', cron: '0 8 * * 1', channel: 'rex-test', task: 'Check the box.' };
  const cfg = (over: Partial<MattermostBridgeConfig> = {}) => ({ schedules: [SCHEDULE], scheduler: { tickMs: 600_000 }, ...over });

  it('records schedule.requested before the run and schedule.finished with run id, mode and outcome', async () => {
    const b = await boot(cfg());
    const t = setInterval(() => {
      for (const run of daemon.runs.values()) if (run.status === 'running') daemon.settle(run.run_id, 'done', { output: 'The box is healthy.' });
    }, 15);
    const outcome = await b.runScheduleNow('check');
    clearInterval(t);
    assert.equal(outcome.kind, 'posted');
    const names = audit().map((r) => r.event);
    assert.deepEqual(names, ['config.loaded', 'schedule.requested', 'schedule.finished']);
    const [, req, fin] = audit();
    assert.equal(req?.schedule, 'check');
    assert.equal(req?.mode, 'plan');
    assert.equal(req?.manual, true);
    assert.equal(fin?.schedule, 'check');
    assert.equal(fin?.run_id, 'run-1');
    assert.equal(fin?.mode, 'plan');
    assert.equal(fin?.outcome, 'posted');
    assert.equal(fin?.request_id, req?.request_id);
    assert.deepEqual(audit()[0]?.schedules, ['check']);
    assert.ok(!rawAudit().includes('The box is healthy'));
    assert.ok(!rawAudit().includes('Check the box'));
  });

  it('a failed run is recorded as failed at the stage it failed', async () => {
    const b = await boot(cfg());
    const t = setInterval(() => {
      for (const run of daemon.runs.values()) if (run.status === 'running') daemon.settle(run.run_id, 'failed', { error: `boom ${PASSWORD}` });
    }, 15);
    const outcome = await b.runScheduleNow('check');
    clearInterval(t);
    assert.equal(outcome.kind, 'failed');
    const fin = events('schedule.finished')[0];
    assert.equal(fin?.outcome, 'failed');
    assert.equal(fin?.stage, 'run');
    assert.equal(fin?.run_id, 'run-1');
    assert.ok(!rawAudit().includes('boom'), 'error text is not recorded');
    assert.ok(!rawAudit().includes(PASSWORD));
  });
});

// ── gate denials ─────────────────────────────────────────────────────────────

describe('audit: gate denials', () => {
  it('records who and where, never what; repeats are coalesced; the bot\'s own posts are not denials; nothing reaches the daemon', async () => {
    await boot();
    say('g1', `${TEXT} from a stranger`, { user: 'mallory', name: '@mallory' });
    say('g2', `${TEXT} again`, { user: 'mallory', name: '@mallory' });
    say('g3', `${TEXT} wrong channel`, { channel: 'random' });
    say('g4', 'my own post', { user: mm.botId });
    await waitFor(() => events('gate.denied').length >= 2, 'denials');
    await pause(100);
    const d = events('gate.denied');
    assert.equal(d.length, 2, 'the second post from the same user is coalesced');
    assert.equal(d[0]?.reason, 'user_not_allowed');
    assert.equal(d[0]?.user_id, 'mallory');
    assert.equal(d[0]?.user_name, 'mallory');
    assert.equal(d[0]?.channel_id, 'c1');
    assert.equal(d[0]?.channel_name, 'engineering');
    assert.equal(d[1]?.reason, 'channel_not_allowed');
    assert.equal(d[1]?.user_id, 'alice');
    assert.equal(d[1]?.channel_name, 'random');
    assert.ok(!rawAudit().includes(TEXT));
    assert.equal(daemon.rpcCalls('chi_run').length, 0);
  });
});

// ── fail closed: no audit, no run ────────────────────────────────────────────

describe('audit unavailable refuses the action', () => {
  it('start() refuses when the audit log cannot be written, and closes the connection', async () => {
    mkdirSync(auditFile(), { recursive: true });
    const b = new MattermostBridge(baseConfig());
    bridges.push(b);
    await assert.rejects(b.start(), /audit log unavailable/);
    assert.equal(b.isRunning(), false);
  });

  it('thread site: a new thread starts no run', async () => {
    await boot();
    breakAudit();
    say('p1', 'hello');
    await waitFor(() => mm.thread('p1').some((m) => /audit log cannot be written/.test(m)), 'refusal posted');
    assert.equal(daemon.rpcCalls('chi_run').length, 0);
  });

  it('resume site: a reply resumes nothing and starts nothing', async () => {
    await boot();
    say('p1', 'hello');
    await waitFor(() => daemon.runs.size === 1, 'run');
    daemon.settle('run-1', 'done', { output: 'ok' });
    await waitFor(() => mm.thread('p1').includes('ok'), 'result posted');
    breakAudit();
    say('p2', 'more', { root: 'p1' });
    await waitFor(() => mm.thread('p1').some((m) => /audit log cannot be written/.test(m)), 'refusal posted');
    assert.equal(daemon.rpcCalls('chi_resume').length, 0);
    assert.equal(daemon.rpcCalls('chi_run').length, 1, 'no fresh run either');
  });

  it('approved-run site: a 👍 with no audit starts no acting run', async () => {
    await boot({ maxMode: 'acceptEdits', approvals: APPROVALS });
    const post = await planned('a1');
    breakAudit();
    react(post, 'alice');
    await waitFor(() => mm.thread('a1').some((m) => /audit log cannot be written/.test(m)), 'refusal posted');
    assert.equal(daemon.rpcCalls('chi_run').length, 1, 'only the plan run');
  });

  it('schedule site: a due schedule starts no run and posts a notice', async () => {
    const b = await boot({ schedules: [{ name: 'check', cron: '0 8 * * 1', channel: 'rex-test', task: 't' }], scheduler: { tickMs: 600_000 } });
    breakAudit();
    const outcome = await b.runScheduleNow('check');
    assert.equal(outcome.kind, 'failed');
    assert.equal(daemon.rpcCalls('chi_run').length, 0);
    assert.ok(mm.receivedPosts.some((p) => p.channel_id === 'c-rex-test' && /audit log cannot be written/.test(p.message)));
  });
});

// ── the ceiling at run time (a second wall behind the load-time refusal) ─────

describe('maxMode is asserted at every call site, not only at config load', () => {
  /** A router whose Rails disagrees with the modes it is asked for, as if the load-time check were bypassed. */
  function rig(rails: { maxMode: WireMode; threadMode: WireMode; actingMode?: WireMode }, chi: { engine: string } = { engine: 'claude-code' }) {
    const file = path.join(dir, 'audit-direct.jsonl');
    const log = new AuditLog({ file, bot: 'rex', log: () => undefined });
    const posts: Array<{ id: string; text: string }> = [];
    const client = {
      async reply(_c: string, message: string): Promise<MattermostPost> {
        const id = `p${posts.length + 1}`;
        posts.push({ id, text: message });
        return { id, user_id: 'bot', channel_id: 'c1', message };
      },
      async updatePost(id: string, message: string): Promise<MattermostPost> {
        const p = posts.find((x) => x.id === id);
        if (p) p.text = message;
        return { id, user_id: 'bot', channel_id: 'c1', message };
      },
    };
    const store = new ThreadStore(path.join(dir, 'threads-direct.json'), 'rex');
    const router = new ThreadRouter({
      bot: 'rex',
      client,
      daemon: new DaemonClient({ url: daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } }),
      store,
      chi: { ...chi, cwd: '~/w' },
      rails: new Rails({ bot: 'rex', audit: log, ...rails }),
      progress: FAST,
      // the approval manager is only used to withdraw; a stub is enough for the act-site test
      approvals: rails.actingMode ? { manager: { withdraw: async () => 0 } as never, actingMode: rails.actingMode } : undefined,
      log: () => undefined,
    });
    const recs = () =>
      existsSync(file)
        ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord)
        : [];
    const post = (id: string, root?: string): MattermostPost => ({ id, user_id: 'alice', channel_id: 'c1', message: 'do it', root_id: root });
    return { router, store, posts, recs, post };
  }

  it('new thread: a thread mode above the ceiling is refused, nothing reaches the daemon, run.refused is recorded', async () => {
    const r = rig({ maxMode: 'plan', threadMode: 'bypassPermissions' });
    await r.router.handle(r.post('t1'), { id: 'alice', name: 'alice' });
    await r.router.whenIdle();
    assert.equal(daemon.calls.filter((c) => c.cmd === 'chi_run').length, 0);
    const refused = r.recs().find((x) => x.event === 'run.refused');
    assert.equal(refused?.kind, 'thread');
    assert.equal(refused?.requested_mode, 'bypassPermissions');
    assert.equal(refused?.max_mode, 'plan');
    assert.equal(refused?.user_id, 'alice');
    assert.ok(r.posts.some((p) => /may run in plan mode at most/.test(p.text)));
    assert.ok(!r.recs().some((x) => x.event === 'run.requested'), 'a refused run is not "requested"');
  });

  it('resume: a stored run above the ceiling, or with no recorded mode, is not resumed; a fresh read-only run starts instead', async () => {
    for (const stored of ['auto', undefined] as const) {
      daemon.runs.clear();
      daemon.calls.length = 0;
      const r = rig({ maxMode: 'plan', threadMode: 'plan' });
      await r.store.put({ root_id: 'old', run_id: 'run-old', bot: 'rex', channel_id: 'c1', brief: 'b', mode: stored, created_at: 1, updated_at: 1 });
      daemon.runs.set('run-old', { run_id: 'run-old', status: 'done', brief: 'b', engineId: 'claude-code', hasSession: true, prompts: [], mode: stored });
      await r.router.handle(r.post('rep', 'old'), { id: 'alice', name: 'alice' });
      await waitFor(() => daemon.calls.some((c) => c.cmd === 'chi_run'), 'fresh run');
      r.router.stop();
      assert.equal(daemon.calls.filter((c) => c.cmd === 'chi_resume').length, 0, `stored mode ${stored}: not resumed`);
      const fresh = daemon.calls.find((c) => c.cmd === 'chi_run')?.args.opts as { mode: string };
      assert.equal(fresh.mode, 'plan');
      const refused = r.recs().find((x) => x.event === 'run.refused');
      assert.equal(refused?.kind, 'resume');
      assert.equal(refused?.run_id, 'run-old');
      assert.equal(refused?.requested_mode, stored ?? 'default');
      await waitFor(() => r.posts.some((p) => /more permissions than this bot is now allowed/.test(p.text)), 'notice');
      rmSync(path.join(dir, 'threads-direct.json'), { force: true });
      rmSync(path.join(dir, 'audit-direct.jsonl'), { force: true });
    }
  });

  it('approved run: an acting mode above the ceiling is refused even after a valid 👍', async () => {
    const r = rig({ maxMode: 'plan', threadMode: 'plan', actingMode: 'auto' });
    await r.store.put({ root_id: 'a1', run_id: 'run-plan', bot: 'rex', channel_id: 'c1', brief: 'b', mode: 'plan', created_at: 1, updated_at: 1 });
    const rec: ApprovalRecord = {
      request_id: 'req-1', post_id: 'ap1', root_id: 'a1', channel_id: 'c1', bot: 'rex', plan_run_id: 'run-plan', plan: PLAN, created_at: 1, expires_at: 2,
    };
    await r.router.runApproved(rec, { id: 'bob', name: 'bob' });
    assert.equal(daemon.calls.filter((c) => c.cmd === 'chi_run').length, 0);
    const refused = r.recs().find((x) => x.event === 'run.refused');
    assert.equal(refused?.kind, 'act');
    assert.equal(refused?.requested_mode, 'auto');
    assert.equal(refused?.approver_id, 'bob');
    assert.equal(refused?.plan_hash, PLAN_SHA);
    assert.ok(r.posts.some((p) => /may run in plan mode at most/.test(p.text)));
  });
});

// ── B1 through the router: the engine decides what mode a run really has ─────

describe('B1 engine vs maxMode at the call sites', () => {
  function rigFor(rails: { maxMode: WireMode; threadMode: WireMode; actingMode?: WireMode }, engine: string) {
    // reuse the rig of the block above through a fresh router (same wiring, other engine)
    const file = path.join(dir, 'audit-direct.jsonl');
    const log = new AuditLog({ file, bot: 'rex', log: () => undefined });
    const posts: Array<{ id: string; text: string }> = [];
    const client = {
      async reply(_c: string, message: string): Promise<MattermostPost> {
        const id = `p${posts.length + 1}`;
        posts.push({ id, text: message });
        return { id, user_id: 'bot', channel_id: 'c1', message };
      },
      async updatePost(id: string, message: string): Promise<MattermostPost> {
        const p = posts.find((x) => x.id === id);
        if (p) p.text = message;
        return { id, user_id: 'bot', channel_id: 'c1', message };
      },
    };
    const store = new ThreadStore(path.join(dir, 'threads-direct.json'), 'rex');
    const router = new ThreadRouter({
      bot: 'rex',
      client,
      daemon: new DaemonClient({ url: daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } }),
      store,
      chi: { engine, cwd: '~/w' },
      rails: new Rails({ bot: 'rex', audit: log, ...rails }),
      progress: FAST,
      approvals: rails.actingMode ? { manager: { withdraw: async () => 0 } as never, actingMode: rails.actingMode } : undefined,
      log: () => undefined,
    });
    const recs = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord) : []);
    const post = (id: string, root?: string): MattermostPost => ({ id, user_id: 'alice', channel_id: 'c1', message: 'do it', root_id: root });
    return { router, store, posts, recs, post };
  }

  it('a new thread on an engine that ignores modes is refused under a plan ceiling, even though the request says plan; nothing reaches the daemon', async () => {
    const r = rigFor({ maxMode: 'plan', threadMode: 'plan' }, 'pi');
    await r.router.handle(r.post('t1'), { id: 'alice', name: 'alice' });
    await r.router.whenIdle();
    assert.equal(daemon.calls.filter((c) => c.cmd === 'chi_run').length, 0);
    const refused = r.recs().find((x) => x.event === 'run.refused');
    assert.equal(refused?.engine, 'pi');
    assert.equal(refused?.requested_mode, 'plan');
    assert.equal(refused?.effective_mode, 'bypassPermissions');
    assert.ok(!r.recs().some((x) => x.event === 'run.requested'));
  });

  it('under a bypass ceiling the run goes ahead, and every record says engine pi and bypassPermissions, never plan', async () => {
    const r = rigFor({ maxMode: 'bypassPermissions', threadMode: 'plan' }, 'pi');
    await r.router.handle(r.post('t1'), { id: 'alice', name: 'alice' });
    await waitFor(() => daemon.runs.size === 1, 'run');
    daemon.settle('run-1', 'done', { output: 'ok' });
    await r.router.whenIdle();
    const mine = r.recs().filter((x) => ['run.requested', 'run.started', 'run.finished'].includes(x.event));
    assert.deepEqual(mine.map((x) => x.event), ['run.requested', 'run.started', 'run.finished']);
    for (const x of mine) {
      assert.equal(x.engine, 'pi', x.event);
      assert.equal(x.mode, 'bypassPermissions', x.event);
    }
    assert.equal(r.store.get('t1')?.engine, 'pi', 'the engine is stored with the run, for the resume check');
  });

  it('resume: a stored run on an engine that ignores modes is not resumed under acceptEdits, even though it was started "in plan"', async () => {
    const r = rigFor({ maxMode: 'auto', threadMode: 'plan' }, 'claude-code');
    await r.store.put({ root_id: 'old', run_id: 'run-old', bot: 'rex', channel_id: 'c1', brief: 'b', mode: 'plan', engine: 'pi', created_at: 1, updated_at: 1 });
    daemon.runs.set('run-old', { run_id: 'run-old', status: 'done', brief: 'b', engineId: 'pi', hasSession: true, prompts: [], mode: 'plan' });
    await r.router.handle(r.post('rep', 'old'), { id: 'alice', name: 'alice' });
    await waitFor(() => daemon.calls.some((c) => c.cmd === 'chi_run'), 'fresh run');
    r.router.stop();
    assert.equal(daemon.calls.filter((c) => c.cmd === 'chi_resume').length, 0);
    const refused = r.recs().find((x) => x.event === 'run.refused');
    assert.equal(refused?.kind, 'resume');
    assert.equal(refused?.engine, 'pi');
    assert.equal(refused?.effective_mode, 'bypassPermissions');
  });

  it('resume: a stored run with no recorded engine counts as unrestricted (fails closed)', async () => {
    const r = rigFor({ maxMode: 'plan', threadMode: 'plan' }, 'claude-code');
    await r.store.put({ root_id: 'old', run_id: 'run-old', bot: 'rex', channel_id: 'c1', brief: 'b', mode: 'plan', created_at: 1, updated_at: 1 });
    daemon.runs.set('run-old', { run_id: 'run-old', status: 'done', brief: 'b', engineId: 'claude-code', hasSession: true, prompts: [], mode: 'plan' });
    await r.router.handle(r.post('rep', 'old'), { id: 'alice', name: 'alice' });
    await waitFor(() => daemon.calls.some((c) => c.cmd === 'chi_run'), 'fresh run');
    r.router.stop();
    assert.equal(daemon.calls.filter((c) => c.cmd === 'chi_resume').length, 0);
  });

  it('resume of a claude-code plan run under a plan ceiling still works, and the records carry engine and mode', async () => {
    const r = rigFor({ maxMode: 'plan', threadMode: 'plan' }, 'claude-code');
    await r.store.put({ root_id: 'old', run_id: 'run-old', bot: 'rex', channel_id: 'c1', brief: 'b', mode: 'plan', engine: 'claude-code', created_at: 1, updated_at: 1 });
    daemon.runs.set('run-old', { run_id: 'run-old', status: 'done', brief: 'b', engineId: 'claude-code', hasSession: true, prompts: [], mode: 'plan' });
    await r.router.handle(r.post('rep', 'old'), { id: 'alice', name: 'alice' });
    await waitFor(() => daemon.calls.some((c) => c.cmd === 'chi_resume'), 'resume');
    r.router.stop();
    const resumed = r.recs().find((x) => x.event === 'run.resumed');
    assert.equal(resumed?.engine, 'claude-code');
    assert.equal(resumed?.mode, 'plan');
  });

  it('a schedule on an engine override that ignores modes is refused at run time under a plan ceiling', async () => {
    const b = await boot({ schedules: [{ name: 'check', cron: '0 8 * * 1', channel: 'rex-test', task: 't' }], scheduler: { tickMs: 600_000 } });
    // the config-load refusal already stops a bad engine override; this is the wall behind it
    (b.scheduler as unknown as { byName: Map<string, { engine?: string }> }).byName.get('check')!.engine = 'opencode';
    const outcome = await b.runScheduleNow('check');
    assert.equal(outcome.kind, 'failed');
    assert.equal(daemon.rpcCalls('chi_run').length, 0);
    const refused = events('run.refused')[0];
    assert.equal(refused?.engine, 'opencode');
    assert.equal(refused?.effective_mode, 'bypassPermissions');
    const fin = events('schedule.finished')[0];
    assert.equal(fin?.engine, 'opencode');
    assert.notEqual(fin?.mode, 'plan', 'a schedule that never started must not claim plan');
  });

  it('the bridge refuses to be built with such an engine under a plan ceiling', () => {
    assert.throws(() => new MattermostBridge(baseConfig({ chi: { engine: 'pi' } })), /chi.engine 'pi' does not enforce permission modes/);
    assert.throws(
      () => new MattermostBridge(baseConfig({ schedules: [{ name: 'c', cron: '0 8 * * 1', channel: 'rex-test', task: 't', engine: 'codex' }] })),
      /schedule 'c' engine 'codex' does not enforce/,
    );
  });
});

// ── restart: the mode a run STARTED with ─────────────────────────────────────

describe('recover() records the mode the run started with', () => {
  it('an acting run that started in auto is still auto in run.finished after the config dropped to plan with no approvals', async () => {
    const file = path.join(dir, 'audit-direct.jsonl');
    const store = new ThreadStore(path.join(dir, 'threads-direct.json'), 'rex');
    await store.put({
      root_id: 'r1', run_id: 'run-plan', bot: 'rex', channel_id: 'c1', brief: 'b', mode: 'plan', engine: 'claude-code', created_at: 1, updated_at: 1,
      active: { run_id: 'run-act', progress_post_id: 'pp1', started_at: Date.now(), kind: 'act', brief: 'act brief', by: { id: 'bob', name: 'bob' }, mode: 'auto', engine: 'claude-code' },
    });
    daemon.runs.set('run-act', { run_id: 'run-act', status: 'done', brief: 'act brief', engineId: 'claude-code', hasSession: true, prompts: [], mode: 'auto', output: 'done it' });
    const posts: string[] = [];
    const client = {
      async reply(_c: string, m: string): Promise<MattermostPost> { posts.push(m); return { id: `n${posts.length}`, user_id: 'bot', channel_id: 'c1', message: m }; },
      async updatePost(id: string, m: string): Promise<MattermostPost> { posts.push(m); return { id, user_id: 'bot', channel_id: 'c1', message: m }; },
    };
    const router = new ThreadRouter({
      bot: 'rex',
      client,
      daemon: new DaemonClient({ url: daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } }),
      store,
      chi: { engine: 'claude-code', cwd: '~/w' },
      // today's config: plan only, no approvals, so no acting mode at all
      rails: new Rails({ bot: 'rex', maxMode: 'plan', threadMode: 'plan', audit: new AuditLog({ file, bot: 'rex', log: () => undefined }) }),
      progress: FAST,
      log: () => undefined,
    });
    router.recover();
    await router.whenIdle();
    const fin = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord).find((x) => x.event === 'run.finished');
    assert.equal(fin?.run_id, 'run-act');
    assert.equal(fin?.mode, 'auto', 'the mode the run started with, not the current config');
    assert.equal(fin?.engine, 'claude-code');
    assert.equal(fin?.kind, 'act');
  });

  it('end to end: an acting run persists its mode and engine in the active-turn record when it starts', async () => {
    await boot({ maxMode: 'acceptEdits', approvals: APPROVALS });
    const post = await planned('a1');
    react(post, 'alice');
    await waitFor(() => daemon.runs.size === 2, 'acting run');
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(path.join(dir, 'threads-rex.json'), 'utf8')).threads?.a1?.active?.kind === 'act';
      } catch {
        return false;
      }
    }, 'active record');
    const active = JSON.parse(readFileSync(path.join(dir, 'threads-rex.json'), 'utf8')).threads.a1.active;
    assert.equal(active.mode, 'auto');
    assert.equal(active.engine, 'claude-code');
  });
});

// ── run.start_failed ─────────────────────────────────────────────────────────

describe('run.start_failed', () => {
  it('is recorded when the daemon refuses to launch the engine, joined by request_id, with no run id and an explicit "unjoined" flag', async () => {
    daemon.refuseEngines.add('claude-code');
    await boot();
    say('p1', 'hello');
    await waitFor(() => hasEvent('run.start_failed'), 'run.start_failed');
    const req = events('run.requested')[0];
    const failed = events('run.start_failed')[0];
    assert.equal(failed?.request_id, req?.request_id);
    assert.equal(failed?.thread_root, 'p1');
    assert.equal(failed?.kind, 'thread');
    assert.equal(failed?.engine, 'claude-code');
    assert.equal(failed?.mode, 'plan');
    assert.equal(failed?.error_kind, 'rpc');
    assert.equal(failed?.run_unjoined, true, 'the daemon left a row but returned no id to join it by');
    assert.equal('run_id' in (failed ?? {}), false);
    assert.equal(daemon.runs.size, 1, 'and the daemon did create a row, which is why the flag matters');
    assert.ok(!hasEvent('run.started'));
  });

  it('carries the daemon run id when one exists (the failure came after the run was created)', async () => {
    await boot({ maxMode: 'acceptEdits', approvals: APPROVALS });
    const post = await planned('a1');
    // lose the thread record between the approval and the start, so runApproved fails after chi_run succeeded
    const bridge = bridges[bridges.length - 1] as MattermostBridge;
    const real = (bridge.router as unknown as { opts: { store: ThreadStore } }).opts.store;
    const realGet = real.get.bind(real);
    real.get = (id: string) => (id === 'a1' && daemon.runs.size >= 2 ? undefined : realGet(id));
    react(post, 'alice');
    await waitFor(() => hasEvent('run.start_failed'), 'run.start_failed');
    const failed = events('run.start_failed')[0];
    assert.equal(failed?.kind, 'act');
    assert.equal(failed?.run_id, 'run-2');
    assert.equal(failed?.run_unjoined, false);
  });
});

// ── the audit channel is compared by what it resolves to ─────────────────────

describe('audit channel overlap by id', () => {
  const ID = 'a'.repeat(26);

  it('audit.channel by NAME while allowedChannels lists the same channel by ID: start() refuses', async () => {
    mm.channels.set('rex-audit', ID);
    const b = new MattermostBridge(baseConfig({ allowedChannels: ['engineering', ID], audit: { channel: 'rex-audit' } }));
    bridges.push(b);
    await assert.rejects(b.start(), /audit\.channel 'rex-audit' is the same channel as allowedChannels entry/);
    assert.equal(b.isRunning(), false);
  });

  it('audit.channel by ID while allowedChannels lists the same channel by NAME: start() refuses', async () => {
    mm.channels.set('rex-audit', ID);
    const b = new MattermostBridge(baseConfig({ allowedChannels: ['engineering', 'rex-audit'], audit: { channel: ID } }));
    bridges.push(b);
    await assert.rejects(b.start(), /is the same channel as allowedChannels entry 'rex-audit'/);
  });

  it('a different channel, by id or by name, is fine', async () => {
    mm.channels.set('rex-audit', ID);
    const b = await boot({ audit: { channel: ID } });
    assert.equal(b.isRunning(), true);
  });
});

// ── the Mattermost mirror ────────────────────────────────────────────────────

describe('audit mirror', () => {
  it('posts one-line summaries to the audit channel, in order, with no message text', async () => {
    mm.channels.set('rex-audit', 'c-audit');
    await boot({ audit: { channel: 'rex-audit' } });
    say('p1', `${TEXT} hello`);
    await waitFor(() => daemon.runs.size === 1, 'run');
    daemon.settle('run-1', 'done', { output: 'SECRET-OUTPUT' });
    await waitFor(() => mm.receivedPosts.filter((p) => p.channel_id === 'c-audit').length >= 4, 'mirror lines');
    const lines = mm.receivedPosts.filter((p) => p.channel_id === 'c-audit').map((p) => p.message);
    assert.match(lines[0] as string, /^`rex config.loaded /);
    assert.match(lines[1] as string, /^`rex run.requested thread_root=p1 channel_id=c1 user_id=alice user_name=alice kind=thread engine=claude-code mode=plan requested_mode=plan mode_enforced=true max_mode=plan request_id=\S+`$/);
    assert.match(lines[2] as string, /^`rex run.started /);
    for (const l of lines) {
      assert.ok(!l.includes('\n') || l.startsWith('`'), 'one line');
      assert.ok(!l.includes(TEXT) && !l.includes('SECRET-OUTPUT') && !l.includes(PASSWORD) && !l.includes(MM_TOKEN));
    }
    assert.ok(lines.length <= audit().length, 'never more mirrored than recorded');
  });

  it('an audit channel Mattermost does not know refuses the start', async () => {
    const b = new MattermostBridge(baseConfig({ audit: { channel: 'no-such-channel' } }));
    bridges.push(b);
    await assert.rejects(b.start(), /bot 'rex': audit.channel: channel '#no-such-channel' not found/);
    assert.equal(b.isRunning(), false);
  });

  it('an audit channel that is also in allowedChannels is refused at construction (the mirror must be write-only)', () => {
    assert.throws(() => new MattermostBridge(baseConfig({ audit: { channel: 'engineering' } })), /write-only/);
  });

  it('a Mattermost outage costs mirror lines, never audit records', async () => {
    mm.channels.set('rex-audit', 'c-audit');
    await boot({ audit: { channel: 'rex-audit' } });
    // The mirror has already resolved and cached the channel id, so break the post itself.
    const realFetch = globalThis.fetch;
    const mirrorBefore = mm.receivedPosts.filter((p) => p.channel_id === 'c-audit').length;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).includes('/api/v4/posts') && String(init?.body ?? '').includes('c-audit')) throw new Error('mattermost down');
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      say('p1', 'hello');
      await waitFor(() => hasEvent('run.started'), 'run.started recorded');
      await pause(100);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(mm.receivedPosts.filter((p) => p.channel_id === 'c-audit').length, mirrorBefore, 'nothing mirrored while down');
    assert.ok(hasEvent('run.requested') && hasEvent('run.started'), 'the file has everything');
  });
});

// ── the operator command ─────────────────────────────────────────────────────

describe('--audit CLI', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, 'bridge.ts');
  let cfgPath: string;

  function cli(...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      // No secrets in this environment: the command must not need any.
      const env = { ...process.env, MATTERMOST_BRIDGE_CONFIG: cfgPath } as NodeJS.ProcessEnv;
      delete env.MM_REX_TOKEN;
      const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], { cwd: path.join(here, '..'), env });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }

  beforeEach(() => {
    cfgPath = path.join(dir, 'bridge.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mattermostUrl: mmUrl,
        dataDir: dir,
        bots: { rex: { mattermostToken: { env: 'MM_REX_TOKEN' }, allowedUsers: ['alice'], allowedChannels: ['engineering'], daemon: { url: daemonUrl, auth: { kind: 'bearer', token: { env: 'MM_REX_TOKEN' } } }, chi: { engine: 'claude-code' } } },
      }),
    );
  });

  it('prints the records as JSON lines, filters with --since, verifies the chain, and needs no secrets', async () => {
    const log = new AuditLog({ file: auditFile(), bot: 'rex', log: () => undefined, now: () => Date.now() - 3 * 3_600_000 });
    log.record('run.started', { run_id: 'old' });
    new AuditLog({ file: auditFile(), bot: 'rex', log: () => undefined }).record('run.started', { run_id: 'new' });

    const all = await cli('--audit', 'rex');
    assert.equal(all.code, 0, all.err);
    assert.deepEqual(all.out.trim().split('\n').map((l) => JSON.parse(l).run_id), ['old', 'new']);

    const recent = await cli('--audit', 'rex', '--since', '1h');
    assert.deepEqual(recent.out.trim().split('\n').map((l) => JSON.parse(l).run_id), ['new']);

    const ok = await cli('--audit', 'rex', '--verify');
    assert.equal(ok.code, 0);
    assert.match(ok.out, /rex: chain ok, 2 records/);

    writeFileSync(auditFile(), readFileSync(auditFile(), 'utf8').replace('"run_id":"old"', '"run_id":"OLD"'));
    const bad = await cli('--audit', 'rex', '--verify');
    assert.equal(bad.code, 1);
    assert.match(bad.out, /chain BROKEN/);

    assert.equal((await cli('--audit', 'ruby')).code, 2);
    assert.equal((await cli('--audit', 'rex', '--since', 'soon')).code, 2);
  });
});

// ── the shipped example ──────────────────────────────────────────────────────

describe('bridge.example.json', () => {
  it('Rex may act (acceptEdits, rex/ branches), Ruby is capped at plan, both mirror to an audit channel', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(readFileSync(path.join(here, '..', 'bridge.example.json'), 'utf8'));
    const lit = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(lit);
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (('env' in o || 'file' in o) && Object.keys(o).length === 1) return { value: 'example-secret' };
        return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, lit(x)]));
      }
      return v;
    };
    const cfgs = resolveBridgeConfigs(lit(raw) as BridgeFileConfig);
    const rex = cfgs.find((c) => c.name === 'rex');
    const ruby = cfgs.find((c) => c.name === 'ruby');
    assert.equal(rex?.maxMode, 'acceptEdits');
    assert.equal(rex?.branchPrefix, 'rex/');
    assert.equal(ruby?.maxMode, 'plan');
    assert.equal(ruby?.approvals, undefined);
    assert.equal(rex?.audit?.channel, 'rex-audit');
    assert.equal(ruby?.audit?.channel, 'ruby-audit');
  });
});

// Remove every temp directory the file made, including ones a stopped bridge wrote into again.
after(() => sweepTmp());
