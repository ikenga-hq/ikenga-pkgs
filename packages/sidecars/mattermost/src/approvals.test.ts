import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MattermostBridge } from './bridge.js';
import { MockDaemon } from './mock-daemon.js';
import { MockMattermostServer } from './mock-server.js';
import { resolveApprovals } from './approvals.js';
import { resolveBridgeConfigs } from './config.js';
import { PLAN_NOTE } from './sessions.js';
import type { BotApprovalsConfig, MattermostBridgeConfig } from './types.js';

const PASSWORD = 'hunter2-very-secret';
const FAST = { pollMinMs: 10, pollMaxMs: 20, editIntervalMs: 0, maxWaitMs: 60_000, maxPollFailures: 3 };
const PLAN = 'Plan: 1. edit src/a.ts  2. add a test';

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  mm: MockMattermostServer;
  daemon: MockDaemon;
  dir: string;
  bridges: MattermostBridge[];
  boot: (over?: Partial<MattermostBridgeConfig>) => Promise<MattermostBridge>;
  say: (id: string, text: string, opts?: { root?: string }) => void;
  /** Start a thread, let the plan run finish, return the id of its approval post. */
  planned: (root: string, output?: string) => Promise<string>;
  approvalPostId: (root: string) => string | undefined;
  react: (postId: string, user: string, emoji?: string) => void;
  current: (postId: string) => string;
}

let rig: Rig;

function makeRig(approvals: BotApprovalsConfig = { approvers: ['alice', 'bob'], timeoutMs: 60_000 }): Rig {
  const mm = new MockMattermostServer();
  const daemon = new MockDaemon('t1', { username: 'rex', password: PASSWORD });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mm-b3-'));
  const bridges: MattermostBridge[] = [];
  let urls: { mm: string; daemon: string } | undefined;

  const boot: Rig['boot'] = async (over = {}) => {
    urls ??= { mm: await mm.listen(), daemon: await daemon.listen() };
    const b = new MattermostBridge({
      name: 'rex',
      mattermostUrl: urls.mm,
      mattermostToken: 'mm-token',
      allowedUsers: ['alice'],
      allowedChannels: ['engineering'],
      dataDir: dir,
      daemon: { url: urls.daemon, auth: { kind: 'session', username: 'rex', password: PASSWORD } },
      chi: { engine: 'claude-code', cwd: '~/work/rex', systemPrompt: 'You are Rex.' },
      progress: FAST,
      approvals,
      ...over,
    });
    await b.start();
    bridges.push(b);
    await pause(60); // WS handshake
    return b;
  };

  const say: Rig['say'] = (id, text, opts = {}) =>
    mm.broadcastPost({ id, user_id: 'alice', channel_id: 'c1', message: text, root_id: opts.root }, 'engineering');

  const approvalPostId = (root: string) =>
    mm.receivedPosts.find((p) => p.root_id === root && p.message.startsWith('**Approval needed**'))?.id;

  const planned: Rig['planned'] = async (root, output = PLAN) => {
    const before = daemon.runs.size;
    say(root, 'please change the thing');
    await waitFor(() => daemon.runs.size === before + 1, 'plan run');
    daemon.settle(`run-${before + 1}`, 'done', { output });
    await waitFor(() => approvalPostId(root) !== undefined, 'approval post');
    const id = approvalPostId(root) as string;
    // The approval post goes up before its record is stored; wait for the
    // record too, or a test racing ahead sees no pending approval.
    await waitFor(() => {
      try {
        return Boolean(JSON.parse(readFileSync(path.join(dir, 'approvals-rex.json'), 'utf8')).approvals?.[id]);
      } catch {
        return false;
      }
    }, 'approval record');
    return id;
  };

  return {
    mm,
    daemon,
    dir,
    bridges,
    boot,
    say,
    planned,
    approvalPostId,
    react: (postId, user, emoji = '+1') => mm.broadcastReaction({ user_id: user, post_id: postId, emoji_name: emoji }),
    current: (postId) => mm.posts.get(postId)?.message ?? '',
  };
}

beforeEach(() => {
  rig = makeRig();
});

afterEach(async () => {
  for (const b of rig.bridges) b.stop();
  await rig.mm.close();
  await rig.daemon.close();
  rmSync(rig.dir, { recursive: true, force: true });
});

const acts = () => rig.daemon.rpcCalls('chi_run').slice(1);

describe('approvals config', () => {
  it('denies by default: approvers must be non-empty, and are separate from allowedUsers', () => {
    assert.throws(() => resolveApprovals({ approvers: [] }, "bot 'rex'"), /at least one approver \(deny by default\)/);
    assert.throws(() => resolveApprovals({ approvers: ['  '] }, "bot 'rex'"), /at least one approver/);
    assert.throws(() => resolveApprovals({} as BotApprovalsConfig, "bot 'rex'"), /at least one approver/);
  });

  it('defaults to 15 minutes and `auto`, and refuses modes that approve nothing or are silently remapped', () => {
    assert.deepEqual(resolveApprovals({ approvers: ['a'] }, 'x'), { approvers: ['a'], timeoutMs: 900_000, actingMode: 'auto' });
    assert.equal(resolveApprovals({ approvers: ['a'], actingMode: 'bypassPermissions' }, 'x').actingMode, 'bypassPermissions');
    for (const bad of ['plan', 'default', 'acceptEdits', 'yolo']) {
      assert.throws(() => resolveApprovals({ approvers: ['a'], actingMode: bad }, 'x'), /actingMode must be one of/);
    }
    assert.throws(() => resolveApprovals({ approvers: ['a'], timeoutMs: 0 }, 'x'), /timeoutMs/);
    assert.throws(() => resolveApprovals({ approvers: ['a'], timeoutMs: 1e12 }, 'x'), /timeoutMs/);
  });

  it('is validated when the file config loads, naming the bot, and conflicts with chi.mode', () => {
    const base = {
      mattermostToken: { value: 'x' } as never,
      allowedUsers: ['alice'],
      allowedChannels: ['eng'],
      daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { value: 'x' } as never } },
    };
    process.env.TEST_MM_B3_TOK = 'tok';
    try {
      const withEnv = {
        ...base,
        mattermostToken: { env: 'TEST_MM_B3_TOK' },
        daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { env: 'TEST_MM_B3_TOK' } } },
      };
      assert.throws(
        () => resolveBridgeConfigs({ mattermostUrl: 'http://mm', bots: { rex: { ...withEnv, chi: { engine: 'claude-code' }, approvals: { approvers: [] } } } }),
        /bot 'rex': approvals.approvers/,
      );
      assert.throws(
        () =>
          resolveBridgeConfigs({
            mattermostUrl: 'http://mm',
            bots: { rex: { ...withEnv, chi: { engine: 'claude-code', mode: 'bypassPermissions' }, approvals: { approvers: ['bob'] } } },
          }),
        /chi.mode is ignored under approvals/,
      );
      const [cfg] = resolveBridgeConfigs({
        mattermostUrl: 'http://mm',
        bots: { rex: { ...withEnv, chi: { engine: 'claude-code' }, approvals: { approvers: ['bob'], timeoutMs: 5000 } } },
      });
      assert.deepEqual(cfg?.approvals, { approvers: ['bob'], timeoutMs: 5000 });
    } finally {
      delete process.env.TEST_MM_B3_TOK;
    }
  });

  it('a bot with approvals but no daemon/chi refuses to start rather than echoing ungated', () => {
    assert.throws(
      () =>
        new MattermostBridge({
          mattermostUrl: 'http://mm',
          mattermostToken: 't',
          allowedUsers: ['alice'],
          allowedChannels: ['eng'],
          approvals: { approvers: ['bob'] },
        }),
      /approvals needs daemon and chi/,
    );
  });
});

describe('plan, then approve', () => {
  it('runs the thread in plan mode, posts the plan, then asks an approver (and only then)', async () => {
    await rig.boot();
    const post = await rig.planned('root-1');

    const first = rig.daemon.rpcCalls('chi_run')[0]!.args.opts as { mode?: string; prompt: string };
    assert.equal(first.mode, 'plan', 'daemon-enforced read-only mode');
    assert.ok(first.prompt.endsWith(PLAN_NOTE));
    assert.ok(rig.mm.thread('root-1').includes(PLAN), 'the plan itself is posted first');
    const text = rig.current(post);
    assert.match(text, /^\*\*Approval needed\*\*/);
    assert.match(text, /@alice, @bob/);
    assert.match(text, /`auto` permissions/);
    assert.match(text, /nothing runs without a 👍/);
    assert.equal(rig.daemon.runs.size, 1, 'nothing acts before a decision');
    // order: plan text before the approval request
    const order = [...rig.mm.posts.values()].filter((p) => p.root_id === 'root-1').map((p) => p.message);
    assert.ok(order.indexOf(PLAN) < order.findIndex((m) => m.startsWith('**Approval needed**')));
  });

  it('persists the pending approval atomically with mode 600 and every field', async () => {
    await rig.boot();
    const post = await rig.planned('root-2');
    const file = path.join(rig.dir, 'approvals-rex.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const rec = saved.approvals[post];
    assert.equal(rec.post_id, post);
    assert.equal(rec.root_id, 'root-2');
    assert.equal(rec.plan_run_id, 'run-1');
    assert.equal(rec.plan, PLAN);
    assert.equal(rec.bot, 'rex');
    assert.match(rec.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(rec.expires_at - rec.created_at, 60_000);
  });

  it('a 👍 from an approver starts ONE acting run, in the acting mode, with exactly the approved plan', async () => {
    await rig.boot();
    const post = await rig.planned('root-3');
    rig.react(post, 'bob');
    await waitFor(() => rig.daemon.runs.size === 2, 'acting run');

    const act = acts()[0]!.args.opts as { mode: string; prompt: string; parentId: string; engineId: string };
    assert.equal(act.mode, 'auto');
    assert.equal(act.parentId, 'run-1');
    assert.equal(act.engineId, 'claude-code');
    assert.match(act.prompt, /^You are Rex\./);
    assert.match(act.prompt, /approved by @bob/);
    assert.ok(act.prompt.endsWith(`--- approved plan ---\n${PLAN}`));
    assert.match(rig.current(post), /^\*\*Approved\*\* by @bob at \d\d:\d\d UTC\. .*`auto` permissions/);

    rig.daemon.settle('run-2', 'done', { output: 'edited a.ts, added a test' });
    await waitFor(() => rig.mm.thread('root-3').includes('edited a.ts, added a test'), 'act result');
    assert.equal(rig.daemon.runs.size, 2);
    assert.equal(rig.bridges[0]!.approvals!.pendingCount(), 0, 'the approval is consumed');
  });

  it('the next reply is planned again (resume of the plan run, read-only), with the act report handed over', async () => {
    await rig.boot();
    const post = await rig.planned('root-4');
    rig.react(post, 'alice');
    await waitFor(() => rig.daemon.runs.size === 2, 'acting run');
    rig.daemon.settle('run-2', 'done', { output: 'all edits made' });
    await waitFor(() => rig.mm.thread('root-4').includes('all edits made'), 'act result');
    await rig.bridges[0]!.router!.whenIdle();

    rig.say('reply-4', 'now also update the docs', { root: 'root-4' });
    await waitFor(() => rig.daemon.rpcCalls('chi_resume').length === 1, 'resume');
    const resume = rig.daemon.rpcCalls('chi_resume')[0]!.args as { runId: string; prompt: string };
    assert.equal(resume.runId, 'run-1', 'the thread stays on the plan run, never on the act run');
    assert.match(resume.prompt, /an approved run carried out your plan/);
    assert.match(resume.prompt, /all edits made/);
    assert.ok(resume.prompt.endsWith(`now also update the docs${PLAN_NOTE}`));
    assert.equal(rig.daemon.runs.get('run-1')?.mode, 'plan');
  });

  it('a 👎 from an approver denies: the post says so and nothing runs', async () => {
    await rig.boot();
    const post = await rig.planned('root-5');
    rig.react(post, 'bob', '-1');
    await waitFor(() => /^\*\*Denied\*\* by @bob/.test(rig.current(post)), 'denied post');
    await pause(80);
    assert.equal(rig.daemon.runs.size, 1);
    assert.match(rig.current(post), /Nothing was run/);
  });

  it('accepts `thumbsup`, `thumbsdown` and skin-tone variants of 👍/👎', async () => {
    await rig.boot();
    const a = await rig.planned('root-6a');
    rig.react(a, 'alice', '+1::skin-tone-3');
    await waitFor(() => rig.daemon.runs.size === 2, 'acting run for the skin-tone 👍');
    const b = await rig.planned('root-6b');
    rig.react(b, 'alice', 'thumbsdown');
    await waitFor(() => /^\*\*Denied\*\*/.test(rig.current(b)), 'thumbsdown denied');
  });

  it('an approval whose plan was truncated by the daemon is not offered', async () => {
    await rig.boot();
    rig.say('root-7', 'big');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    rig.daemon.settle('run-1', 'done', { output: PLAN, output_truncated: true });
    await waitFor(() => rig.mm.thread('root-7').some((m) => /truncated that plan/.test(m)), 'notice');
    assert.equal(rig.approvalPostId('root-7'), undefined);
    assert.equal(rig.bridges[0]!.approvals!.pendingCount(), 0);
  });

  it('no usable plan text, no approval request; a failed run is not offered either', async () => {
    await rig.boot();
    rig.say('root-8', 'x');
    await waitFor(() => rig.daemon.runs.size === 1, 'run');
    rig.daemon.settle('run-1', 'failed', { error: 'boom', output: PLAN });
    await waitFor(() => rig.mm.thread('root-8').some((m) => /failed/i.test(m)), 'failure posted');
    await pause(60);
    assert.equal(rig.approvalPostId('root-8'), undefined);
  });

  it('the acting mode comes from config (bypassPermissions when the operator asks for it)', async () => {
    rig = makeRig({ approvers: ['alice'], timeoutMs: 60_000, actingMode: 'bypassPermissions' });
    await rig.boot();
    const post = await rig.planned('root-9');
    assert.match(rig.current(post), /`bypassPermissions` permissions/);
    rig.react(post, 'alice');
    await waitFor(() => rig.daemon.runs.size === 2, 'acting run');
    assert.equal((acts()[0]!.args.opts as { mode: string }).mode, 'bypassPermissions');
  });
});

describe('who may decide', () => {
  it('ignores the bot itself, non-approvers, unknown posts, other emoji, and users it cannot look up', async () => {
    await rig.boot();
    const post = await rig.planned('root-10');
    const other = rig.mm.receivedPosts.find((p) => p.root_id === 'root-10' && p.message === PLAN)!.id!;

    rig.react(post, rig.mm.botId); // the bot's own 👍
    rig.react(post, 'mallory'); // a channel member who is not an approver
    rig.react(post, 'mallory', '-1');
    rig.react(post, 'alice', 'eyes'); // an approver, but not a verdict
    rig.react(other, 'alice'); // an approver, on a post that is not an approval
    rig.react('no-such-post', 'alice');
    rig.react(post, 'ghost'); // lookup 404s: cannot verify, so not an approver
    await pause(150);
    assert.equal(rig.daemon.runs.size, 1, 'nothing started');
    assert.match(rig.current(post), /^\*\*Approval needed\*\*/, 'still pending');
    assert.equal(rig.bridges[0]!.approvals!.pendingCount(), 1);

    rig.mm.failUserLookups = true; // Mattermost outage: fail closed
    rig.react(post, 'alice');
    await pause(100);
    assert.equal(rig.daemon.runs.size, 1);
    rig.mm.failUserLookups = false;

    rig.react(post, 'alice'); // a real approver, finally
    await waitFor(() => rig.daemon.runs.size === 2, 'acting run');
  });

  it("the bot's own 👍 never counts, even if the bot is (mis)listed as an approver", async () => {
    rig = makeRig({ approvers: ['alice', 'ikenga-bot'], timeoutMs: 60_000 });
    rig.mm.users.set(rig.mm.botId, rig.mm.botUsername);
    await rig.boot();
    const post = await rig.planned('root-10b');
    rig.react(post, rig.mm.botId);
    await pause(150);
    assert.equal(rig.daemon.runs.size, 1);
    assert.match(rig.current(post), /^\*\*Approval needed\*\*/);
  });

  it('allowedUsers is not enough to approve: a user who may talk to the bot cannot decide', async () => {
    rig = makeRig({ approvers: ['bob'], timeoutMs: 60_000 });
    await rig.boot(); // alice is in allowedUsers, only bob approves
    const post = await rig.planned('root-11');
    rig.react(post, 'alice');
    await pause(120);
    assert.equal(rig.daemon.runs.size, 1);
    rig.react(post, 'bob');
    await waitFor(() => rig.daemon.runs.size === 2, 'acting run');
  });

  it('an approver can be named by user id, and by @username', async () => {
    for (const approver of ['u1abc', '@carol']) {
      const r = makeRig({ approvers: [approver], timeoutMs: 60_000 });
      r.mm.users.set('u1abc', 'carol');
      await r.boot();
      const post = await r.planned('root-12');
      r.react(post, 'u1abc');
      await waitFor(() => r.daemon.runs.size === 2, `acting run for approver ${approver}`);
      for (const b of r.bridges) b.stop();
      await r.mm.close();
      await r.daemon.close();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('only the FIRST decision counts, including two reactions that arrive together', async () => {
    await rig.boot();
    const deny = await rig.planned('root-13');
    rig.react(deny, 'alice', '-1');
    rig.react(deny, 'bob', '+1'); // too late
    await waitFor(() => /^\*\*Denied\*\* by @alice/.test(rig.current(deny)), 'denied');
    await pause(100);
    assert.equal(rig.daemon.runs.size, 1, 'the later 👍 did not approve');

    const both = await rig.planned('root-14');
    rig.react(both, 'alice', '+1');
    rig.react(both, 'bob', '+1');
    await waitFor(() => rig.daemon.runs.size === 3, 'one acting run');
    await pause(120);
    assert.equal(rig.daemon.runs.size, 3, 'exactly one acting run');
    const acting = rig.daemon.rpcCalls('chi_run').filter((c) => (c.args.opts as { mode: string }).mode === 'auto');
    assert.equal(acting.length, 1, 'one acting run in total');
  });
});

describe('timeout, withdrawal and thread changes', () => {
  it('no decision in time is a denial: the post is edited and a late 👍 does nothing', async () => {
    rig = makeRig({ approvers: ['alice'], timeoutMs: 150 });
    await rig.boot();
    const post = await rig.planned('root-15');
    await waitFor(() => /^\*\*Expired\*\*/.test(rig.current(post)), 'expiry edit');
    assert.match(rig.current(post), /counts as a denial|this is a denial/);
    assert.match(rig.current(post), /Nothing was run/);
    assert.equal(rig.bridges[0]!.approvals!.pendingCount(), 0);
    const before = rig.mm.patches.length;
    rig.react(post, 'alice');
    await pause(120);
    assert.equal(rig.daemon.runs.size, 1);
    assert.equal(rig.mm.patches.length, before, 'a reaction on an expired post changes nothing');
  });

  it('a new message in the thread withdraws the pending plan; its old post can no longer be approved', async () => {
    await rig.boot();
    const post = await rig.planned('root-16');
    rig.say('reply-16', 'actually, do something else', { root: 'root-16' });
    await waitFor(() => /^\*\*Withdrawn\*\*/.test(rig.current(post)), 'withdrawn');
    await waitFor(() => rig.daemon.rpcCalls('chi_resume').length === 1, 'new plan turn');
    rig.react(post, 'alice');
    await pause(100);
    assert.equal(rig.daemon.runs.size, 1, 'no acting run from the withdrawn plan');
  });

  it('`stop` withdraws a pending plan', async () => {
    await rig.boot();
    const post = await rig.planned('root-17');
    rig.say('stop-17', 'stop', { root: 'root-17' });
    await waitFor(() => /^\*\*Withdrawn\*\*/.test(rig.current(post)), 'withdrawn');
    await waitFor(() => rig.mm.thread('root-17').includes('Plan withdrawn. Nothing was run.'), 'ack');
    rig.react(post, 'alice');
    await pause(100);
    assert.equal(rig.daemon.runs.size, 1);
  });

  it('refuses to resume a run that was not started in plan mode (a B2 thread), starting a fresh read-only one', async () => {
    // A thread record from before approvals were switched on: no `mode`.
    writeFileSync(
      path.join(rig.dir, 'threads-rex.json'),
      JSON.stringify({
        version: 1,
        threads: {
          'root-18': {
            root_id: 'root-18',
            run_id: 'old-run',
            bot: 'rex',
            channel_id: 'c1',
            brief: 'b',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        },
      }),
    );
    await rig.boot();
    rig.say('reply-18', 'carry on', { root: 'root-18' });
    await waitFor(() => rig.daemon.runs.size === 1, 'fresh run');
    assert.equal(rig.daemon.rpcCalls('chi_resume').length, 0, 'never resumed with unknown permissions');
    assert.equal((rig.daemon.rpcCalls('chi_run')[0]!.args.opts as { mode: string }).mode, 'plan');
    await waitFor(() => rig.mm.thread('root-18').some((m) => /not started under approvals/.test(m)), 'notice');
  });
});

describe('restart', () => {
  it('re-attaches to a pending approval: a 👍 after the restart still approves', async () => {
    const b1 = await rig.boot();
    const post = await rig.planned('root-19');
    await b1.router!.whenIdle();
    b1.stop();
    assert.equal(b1.approvals!.pendingCount(), 1);
    const saved = JSON.parse(readFileSync(path.join(rig.dir, 'approvals-rex.json'), 'utf8'));
    assert.ok(saved.approvals[post]);

    const b2 = await rig.boot(); // a brand new bridge over the same files
    assert.equal(b2.approvals!.pendingCount(), 1);
    rig.react(post, 'bob');
    await waitFor(() => rig.daemon.runs.size === 2, 'acting run after restart');
    assert.equal((acts()[0]!.args.opts as { parentId: string }).parentId, 'run-1');
    await waitFor(
      () => JSON.parse(readFileSync(path.join(rig.dir, 'approvals-rex.json'), 'utf8')).approvals[post] === undefined,
      'the decided approval leaves the file',
    );
  });

  it('honours expiry across a restart: an approval that ran out while the bridge was down is a denial', async () => {
    rig = makeRig({ approvers: ['alice'], timeoutMs: 200 });
    const b1 = await rig.boot();
    const post = await rig.planned('root-20');
    await b1.router!.whenIdle();
    b1.stop();
    await pause(300); // expires while down
    await rig.boot();
    await waitFor(() => /^\*\*Expired\*\*/.test(rig.current(post)), 'expired on recovery');
    rig.react(post, 'alice');
    await pause(100);
    assert.equal(rig.daemon.runs.size, 1);
  });

  it('keeps the REMAINING time across a restart (the clock is not reset)', async () => {
    rig = makeRig({ approvers: ['alice'], timeoutMs: 600 });
    const b1 = await rig.boot();
    const post = await rig.planned('root-21');
    await b1.router!.whenIdle();
    b1.stop();
    await pause(200);
    const t0 = Date.now();
    await rig.boot();
    await waitFor(() => /^\*\*Expired\*\*/.test(rig.current(post)), 'expiry', 2000);
    assert.ok(Date.now() - t0 < 560, `expired ${Date.now() - t0}ms after restart, not a fresh 600ms`);
  });

  it('applies a decision made while the bridge was down (earliest approver reaction wins)', async () => {
    const b1 = await rig.boot();
    const post = await rig.planned('root-22');
    await b1.router!.whenIdle();
    b1.stop();
    rig.mm.addReaction({ user_id: 'mallory', post_id: post, emoji_name: '+1', create_at: 1 }); // not an approver
    rig.mm.addReaction({ user_id: 'bob', post_id: post, emoji_name: '-1', create_at: 2 });
    rig.mm.addReaction({ user_id: 'alice', post_id: post, emoji_name: '+1', create_at: 3 }); // later
    await rig.boot();
    await waitFor(() => /^\*\*Denied\*\* by @bob/.test(rig.current(post)), 'denied from the downtime reaction');
    assert.equal(rig.daemon.runs.size, 1);
  });

  it('a reaction on a post the bridge has no record of does nothing', async () => {
    await rig.boot();
    const post = await rig.planned('root-23');
    rig.bridges[0]!.stop();
    rmSync(path.join(rig.dir, 'approvals-rex.json')); // lost state
    await rig.boot();
    rig.react(post, 'alice');
    await pause(120);
    assert.equal(rig.daemon.runs.size, 1);
    assert.match(rig.current(post), /^\*\*Approval needed\*\*/, 'untouched');
  });
});
