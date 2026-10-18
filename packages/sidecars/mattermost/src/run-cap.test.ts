import { describe, it, beforeEach, afterEach, after } from 'node:test';
import { sweepTmp, tmpDir } from './test-tmp.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AuditLog } from './audit.js';
import { MattermostBridge } from './bridge.js';
import { loadBridgeSetup, resolveBridgeConfigs } from './config.js';
import { DaemonError } from './daemon.js';
import type { ChiRunOpts, ChiRunResult } from './daemon.js';
import { MockDaemon } from './mock-daemon.js';
import { MockMattermostServer } from './mock-server.js';
import { Rails } from './rails.js';
import { DEFAULT_MAX_CONCURRENT_RUNS, RunGate, RunGateClosedError, RunWaitAbortedError, resolveLimits } from './run-gate.js';
import { ScheduleRunner, ScheduleStore, resolveSchedules } from './schedules.js';
import type { ScheduleApi, ScheduleChiApi } from './schedules.js';
import type { BotApprovalsConfig, MattermostBridgeConfig, MattermostPost } from './types.js';

const PASSWORD = 'hunter2-very-secret';
const FAST = { pollMinMs: 5, pollMaxMs: 10, editIntervalMs: 0, maxWaitMs: 60_000, maxPollFailures: 3 };
const quiet = () => undefined;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── the gate itself ────────────────────────────────────────────────────────────

describe('RunGate', () => {
  it('lets max runs through, queues the rest FIFO, and starts them as slots come back', async () => {
    const logs: string[] = [];
    const gate = new RunGate({ max: 2, log: (l) => logs.push(l) });
    const a = await gate.acquire({ bot: 'rex', kind: 'thread' });
    const b = await gate.acquire({ bot: 'ruby', kind: 'thread' });
    assert.equal(gate.inFlight, 2);

    const order: string[] = [];
    const ahead: number[] = [];
    const c = gate.acquire({ bot: 'rex', kind: 'thread' }, { onQueued: (q) => ahead.push(q.ahead) }).then((s) => (order.push('c'), s));
    const d = gate.acquire({ bot: 'ruby', kind: 'schedule' }, { onQueued: (q) => ahead.push(q.ahead) }).then((s) => (order.push('d'), s));
    const e = gate.acquire({ bot: 'rex', kind: 'act' }, { onQueued: (q) => ahead.push(q.ahead) }).then((s) => (order.push('e'), s));
    assert.deepEqual(ahead, [0, 1, 2]);
    assert.equal(gate.queued, 3);
    await pause(20);
    assert.deepEqual(order, [], 'nothing starts while full');

    a.release();
    const sc = await c;
    assert.deepEqual(order, ['c']);
    assert.equal(gate.inFlight, 2);
    b.release();
    const sd = await d;
    sc.release();
    const se = await e;
    assert.deepEqual(order, ['c', 'd', 'e'], 'first in, first out');
    sd.release();
    se.release();
    assert.equal(gate.inFlight, 0);
    assert.equal(gate.queued, 0);

    assert.ok(logs.some((l) => /run queued: bot=rex kind=thread ahead=0 depth=1 inFlight=2\/2/.test(l)));
    assert.ok(logs.some((l) => /run started after waiting \d+s: bot=ruby kind=schedule depth=1/.test(l)));
  });

  it('release is idempotent: a second release never frees somebody else\'s slot', async () => {
    const gate = new RunGate({ max: 1, log: quiet });
    const a = await gate.acquire({ bot: 'rex', kind: 'thread' });
    const waiting = gate.acquire({ bot: 'rex', kind: 'thread' });
    a.release();
    const b = await waiting;
    a.release(); // a stale handle
    a.release();
    assert.equal(gate.inFlight, 1, 'b still holds its slot');
    let started = false;
    const third = gate.acquire({ bot: 'rex', kind: 'thread' }).then((s) => ((started = true), s));
    await pause(20);
    assert.equal(started, false, 'the stale releases did not let a third run in');
    b.release();
    (await third).release();
    assert.equal(gate.inFlight, 0);
  });

  it('a request that is aborted while queued leaves the queue without taking or losing a slot', async () => {
    const gate = new RunGate({ max: 1, log: quiet });
    const a = await gate.acquire({ bot: 'rex', kind: 'thread' });
    const ac = new AbortController();
    const gone = gate.acquire({ bot: 'rex', kind: 'thread' }, { signal: ac.signal });
    const next = gate.acquire({ bot: 'ruby', kind: 'thread' });
    ac.abort();
    await assert.rejects(gone, RunWaitAbortedError);
    assert.equal(gate.queued, 1);
    a.release();
    (await next).release();
    assert.equal(gate.inFlight, 0);
    await assert.rejects(gate.acquire({ bot: 'x', kind: 'thread' }, { signal: ac.signal }), RunWaitAbortedError, 'an already-aborted signal never queues');
    assert.equal(gate.queued, 0);
  });

  it('adopted runs count against the cap, even above it, and new requests wait behind them', async () => {
    const gate = new RunGate({ max: 2, log: quiet });
    const adopted = [gate.adopt({ bot: 'rex', kind: 'recovered' }), gate.adopt({ bot: 'rex', kind: 'recovered' }), gate.adopt({ bot: 'ruby', kind: 'recovered' })];
    assert.equal(gate.inFlight, 3);
    let started = false;
    const p = gate.acquire({ bot: 'rex', kind: 'thread' }).then((s) => ((started = true), s));
    await pause(20);
    assert.equal(started, false);
    adopted[0]!.release();
    await pause(20);
    assert.equal(started, false, 'still 2 of 2 in flight');
    adopted[1]!.release();
    (await p).release();
    adopted[2]!.release();
    assert.equal(gate.inFlight, 0);
  });

  it('close rejects everyone waiting and every later request, and held slots stay releasable', async () => {
    const gate = new RunGate({ max: 1, log: quiet });
    const a = await gate.acquire({ bot: 'rex', kind: 'thread' });
    const waiting = gate.acquire({ bot: 'rex', kind: 'thread' });
    gate.close();
    await assert.rejects(waiting, RunGateClosedError);
    await assert.rejects(gate.acquire({ bot: 'rex', kind: 'thread' }), RunGateClosedError);
    a.release();
    assert.equal(gate.inFlight, 0);
  });
});

// ── config ─────────────────────────────────────────────────────────────────────

describe('limits config', () => {
  const bot = {
    mattermostToken: { value: 'tok' },
    allowedUsers: ['alice'],
    allowedChannels: ['engineering'],
    daemon: { url: 'http://d', auth: { kind: 'session' as const, username: 'rex', password: { value: PASSWORD } } },
    chi: { engine: 'claude-code' },
  };
  const load = (limits: unknown) => resolveBridgeConfigs({ mattermostUrl: 'http://mm', limits: limits as never, bots: { rex: bot } });

  it('defaults to 4 when absent, empty, or without the field', () => {
    assert.equal(DEFAULT_MAX_CONCURRENT_RUNS, 4);
    assert.deepEqual(resolveLimits(undefined), { maxConcurrentRuns: 4 });
    assert.deepEqual(resolveLimits({}), { maxConcurrentRuns: 4 });
    assert.doesNotThrow(() => load(undefined));
    assert.doesNotThrow(() => load({}));
  });

  it('accepts integers from 1 to 32', () => {
    for (const n of [1, 2, 4, 16, 32]) assert.deepEqual(resolveLimits({ maxConcurrentRuns: n }), { maxConcurrentRuns: n });
    assert.doesNotThrow(() => load({ maxConcurrentRuns: 8 }));
  });

  it('refuses anything else, naming the field', () => {
    for (const bad of [0, -1, 33, 2.5, '4', null, Number.NaN, Infinity, true]) {
      assert.throws(() => load({ maxConcurrentRuns: bad }), /limits\.maxConcurrentRuns must be an integer from 1 to 32/, `value ${String(bad)}`);
    }
    assert.throws(() => load([]), /limits must be an object/);
    assert.throws(() => load('4'), /limits must be an object/);
    assert.throws(() => load({ maxConcurrentRuns: 2, perBot: 1 }), /limits: unknown field 'perBot'/);
  });

  it('loadBridgeSetup returns the bots and the limits of one file', () => {
    const dir = tmpDir('mm-cap-cfg-');
    const file = path.join(dir, 'bridge.json');
    writeFileSync(file, JSON.stringify({ mattermostUrl: 'http://mm', dataDir: dir, limits: { maxConcurrentRuns: 3 }, bots: { rex: bot, ruby: bot } }));
    const setup = loadBridgeSetup(file);
    assert.equal(setup.limits.maxConcurrentRuns, 3);
    assert.deepEqual(setup.bots.map((b) => b.name), ['rex', 'ruby']);
    writeFileSync(file, JSON.stringify({ mattermostUrl: 'http://mm', dataDir: dir, bots: { rex: bot } }));
    assert.equal(loadBridgeSetup(file).limits.maxConcurrentRuns, 4);
    writeFileSync(file, JSON.stringify({ mattermostUrl: 'http://mm', dataDir: dir, limits: { maxConcurrentRuns: 99 }, bots: { rex: bot } }));
    assert.throws(() => loadBridgeSetup(file), /limits\.maxConcurrentRuns/);
  });
});

// ── threads, approvals: bridges sharing one gate ────────────────────────────────

interface Rig {
  mm: MockMattermostServer;
  daemon: MockDaemon;
  dir: string;
  gate: RunGate;
  gateLogs: string[];
  bridges: MattermostBridge[];
  boot: (name: 'rex' | 'ruby', over?: Partial<MattermostBridgeConfig>, gate?: RunGate) => Promise<MattermostBridge>;
  /** Build a bridge without starting it. */
  make: (name: 'rex' | 'ruby', over?: Partial<MattermostBridgeConfig>, gate?: RunGate) => MattermostBridge;
  say: (bot: 'rex' | 'ruby', id: string, text: string, root?: string) => void;
  runs: () => number;
  /** The bridge's first post in a thread (the progress post). */
  progress: (root: string) => { id: string; message: string };
}

const CHANNEL = { rex: 'engineering', ruby: 'royalti-co' } as const;
let rig: Rig;

async function makeRig(max: number): Promise<Rig> {
  const mm = new MockMattermostServer();
  const daemon = new MockDaemon('t1', { username: 'rex', password: PASSWORD });
  const mmUrl = await mm.listen();
  const daemonUrl = await daemon.listen();
  const dir = tmpDir('mm-cap-');
  const gateLogs: string[] = [];
  const gate = new RunGate({ max, log: (l) => gateLogs.push(l) });
  const bridges: MattermostBridge[] = [];
  return {
    mm,
    daemon,
    dir,
    gate,
    gateLogs,
    bridges,
    make: (name, over = {}, g = gate) => {
      const b = new MattermostBridge(
        {
          name,
          mattermostUrl: mmUrl,
          mattermostToken: 'mm-token',
          allowedUsers: ['alice'],
          allowedChannels: [CHANNEL[name]],
          dataDir: dir,
          daemon: { url: daemonUrl, auth: { kind: 'session', username: 'rex', password: PASSWORD } },
          chi: { engine: 'claude-code', cwd: `~/work/${name}`, systemPrompt: `You are ${name}.` },
          progress: FAST,
          ...over,
        },
        undefined,
        g,
      );
      bridges.push(b);
      return b;
    },
    boot: async (name, over = {}, g = gate) => {
      const b = rig.make(name, over, g);
      await b.start();
      await pause(60); // WS handshake
      return b;
    },
    say: (bot, id, text, root) => mm.broadcastPost({ id, user_id: 'alice', channel_id: 'c1', message: text, root_id: root }, CHANNEL[bot]),
    runs: () => daemon.rpcCalls('chi_run').length,
    progress: (root) => {
      const p = [...mm.posts.values()].find((x) => x.root_id === root);
      assert.ok(p, `a post in thread ${root}`);
      return { id: p.id, message: p.message };
    },
  };
}

async function closeRig(r: Rig): Promise<void> {
  for (const b of r.bridges) b.stop();
  await r.mm.close();
  await r.daemon.close();
  rmSync(r.dir, { recursive: true, force: true });
}

const queuedPatches = (r: Rig, postId: string) => r.mm.patches.filter((p) => p.id === postId && /^Queued:/.test(p.message));

describe('thread runs under the cap (two bots, one gate)', () => {
  beforeEach(async () => {
    rig = await makeRig(2);
  });
  afterEach(() => closeRig(rig));

  it('never has more than max runs in flight across bots; the rest queue FIFO and say so exactly once', async () => {
    await rig.boot('rex');
    await rig.boot('ruby');
    rig.say('rex', 't1', 'first from rex');
    rig.say('ruby', 't2', 'second from ruby');
    await waitFor(() => rig.runs() === 2, 'two runs');
    assert.equal(queuedPatches(rig, rig.progress('t1').id).length, 0, 'a run that starts at once is not announced as queued');

    rig.say('rex', 't3', 'third from rex');
    await waitFor(() => rig.gate.queued === 1, 'third queued');
    rig.say('ruby', 't4', 'fourth from ruby');
    await waitFor(() => rig.gate.queued === 2, 'fourth queued');
    await pause(100);
    assert.equal(rig.runs(), 2, 'the cap holds');
    assert.equal(rig.gate.inFlight, 2);

    const p3 = rig.progress('t3');
    const p4 = rig.progress('t4');
    assert.match(p3.message, /^Queued: 2 runs are already going on this bridge\. This one is next\./);
    assert.match(p4.message, /^Queued: .*1 queued ahead of this one\./);
    assert.equal(rig.mm.thread('t3').length, 1, 'one message in the thread, not an extra reply');
    assert.equal(queuedPatches(rig, p3.id).length, 1, 'queued notice posted once');
    assert.equal(queuedPatches(rig, p4.id).length, 1);
    assert.ok(!rig.daemon.calls.some((c) => JSON.stringify(c.args).includes('third from rex')), 'nothing was sent to the daemon for it yet');

    // A slot frees: the OLDEST waiter starts, whichever bot it belongs to.
    rig.daemon.settle('run-1', 'done', { output: 'one' });
    await waitFor(() => rig.runs() === 3, 'third starts');
    assert.match(String((rig.daemon.rpcCalls('chi_run')[2]!.args.opts as ChiRunOpts).prompt), /third from rex/);
    await pause(100);
    assert.equal(rig.runs(), 3, 'the fourth is still waiting');
    await waitFor(() => /Working/.test(rig.progress('t3').message) || rig.mm.thread('t3').length === 1, 'third back to working');
    assert.doesNotMatch(rig.progress('t3').message, /^Queued:/, 'the queued text is replaced once it starts');

    rig.daemon.settle('run-2', 'failed', { error: 'boom' });
    await waitFor(() => rig.runs() === 4, 'fourth starts');
    assert.match(String((rig.daemon.rpcCalls('chi_run')[3]!.args.opts as ChiRunOpts).prompt), /fourth from ruby/);
    assert.equal(queuedPatches(rig, p3.id).length, 1, 'still announced once');

    // Logs name bot and depth, never the message text.
    assert.ok(rig.gateLogs.some((l) => /run queued: bot=rex kind=thread ahead=0 depth=1/.test(l)));
    assert.ok(rig.gateLogs.some((l) => /run started after waiting \d+s: bot=ruby kind=thread/.test(l)));
    assert.ok(!rig.gateLogs.some((l) => /third from rex|fourth from ruby|You are/.test(l)));

    // The wait is in the audit record of the run that waited, and only there.
    const started = readFileSync(path.join(rig.dir, 'audit-rex.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.event === 'run.started');
    assert.equal(started.length, 2);
    assert.equal(started[0]!.queue_wait_s, undefined);
    assert.equal(typeof started[1]!.queue_wait_s, 'number');
  });

  it('frees the slot on every kind of terminal status', async () => {
    rig.gate.close();
    rig.gate = new RunGate({ max: 1, log: quiet });
    await rig.boot('rex', {}, rig.gate);
    let n = 0;
    for (const status of ['done', 'failed', 'cancelled', 'timed_out']) {
      n += 1;
      rig.say('rex', `s${n}`, `go ${status}`);
      await waitFor(() => rig.runs() === n, `run ${n}`);
      assert.equal(rig.gate.inFlight, 1);
      rig.daemon.settle(`run-${n}`, status, { output: status === 'done' ? 'ok' : undefined, error: 'x' });
      await waitFor(() => rig.gate.inFlight === 0, `slot back after ${status}`);
    }
  });

  it('frees the slot when chi_run fails, and when it answers without a run id', async () => {
    const rex = await rig.boot('rex', { chi: { engine: 'cursor-agent' }, maxMode: 'bypassPermissions' });
    rig.daemon.refuseEngines.add('cursor-agent');
    rig.say('rex', 'f1', 'will be refused');
    await waitFor(() => rig.mm.thread('f1').some((m) => /could not start the run/.test(m)), 'start failure shown');
    assert.equal(rig.gate.inFlight, 0);

    (rex.daemon as unknown as { chiRun: () => Promise<ChiRunResult> }).chiRun = async () => ({ status: 'running' }) as ChiRunResult;
    rig.say('rex', 'f2', 'no run id comes back');
    await waitFor(() => rig.mm.thread('f2').some((m) => /answered without a run id/.test(m)), 'missing run id shown');
    assert.equal(rig.gate.inFlight, 0);
    assert.equal(rig.gate.queued, 0);
  });

  it('a resume goes through the gate too, and frees its slot on error', async () => {
    rig.gate = new RunGate({ max: 1, log: quiet });
    const rex = await rig.boot('rex', {}, rig.gate);
    rig.say('rex', 'r1', 'start');
    await waitFor(() => rig.runs() === 1, 'first run');
    rig.daemon.settle('run-1', 'done', { output: 'first answer' });
    await waitFor(() => rig.gate.inFlight === 0 && rex.router!.activeCount() === 0, 'first run over');

    // Something else takes the only slot; the reply's resume must wait for it.
    rig.say('rex', 'r2', 'other thread');
    await waitFor(() => rig.runs() === 2, 'second run');
    rig.say('rex', 'r1-reply', 'and then?', 'r1');
    await waitFor(() => rig.gate.queued === 1, 'resume queued');
    await pause(100);
    assert.equal(rig.daemon.rpcCalls('chi_resume').length, 0, 'no chi_resume while the bridge is full');

    // A resume that fails outright gives its slot back.
    (rex.daemon as unknown as { chiResume: () => Promise<ChiRunResult> }).chiResume = async () => {
      throw new DaemonError('chi_resume: engine exploded', 'rpc');
    };
    rig.daemon.settle('run-2', 'done', { output: 'second answer' });
    await waitFor(() => rig.mm.thread('r1').some((m) => /could not start the run: .*engine exploded/.test(m)), 'resume failure shown');
    assert.equal(rig.gate.inFlight, 0);
    assert.equal(rig.gate.queued, 0);
  });

  it('a resume that finds its run gone falls back to a fresh run on the SAME slot (cap 1 must not deadlock)', async () => {
    rig.gate = new RunGate({ max: 1, log: quiet });
    const rex = await rig.boot('rex', {}, rig.gate);
    rig.say('rex', 'g1', 'start');
    await waitFor(() => rig.runs() === 1, 'first run');
    rig.daemon.settle('run-1', 'done', { output: 'first answer' });
    await waitFor(() => rig.gate.inFlight === 0 && rex.router!.activeCount() === 0, 'first run over');
    rig.daemon.forget('run-1'); // chi_resume answers "chi run not found"

    rig.say('rex', 'g1-reply', 'again', 'g1');
    await waitFor(() => rig.runs() === 2, 'fallback run');
    assert.equal(rig.gate.inFlight, 1, 'one run, one slot');
    assert.equal(rig.gate.queued, 0);
    rig.daemon.settle('run-2', 'done', { output: 'fresh answer' });
    await waitFor(() => rig.gate.inFlight === 0, 'slot back');
  });

  it('`stop` frees a running thread\'s slot, and takes a queued one out of the queue without ever starting it', async () => {
    rig.gate = new RunGate({ max: 1, log: quiet });
    await rig.boot('rex', {}, rig.gate);
    rig.say('rex', 'c1', 'long job');
    await waitFor(() => rig.runs() === 1, 'running');
    rig.say('rex', 'c2', 'waits');
    await waitFor(() => rig.gate.queued === 1, 'queued');

    rig.say('rex', 'c2-stop', 'stop', 'c2');
    await waitFor(() => rig.gate.queued === 0, 'left the queue');
    await waitFor(() => rig.mm.thread('c2').some((m) => /Cancelled while queued/.test(m)), 'told it was cancelled');
    assert.equal(rig.gate.inFlight, 1, 'the running thread still holds its slot');

    rig.say('rex', 'c1-stop', 'stop', 'c1');
    await waitFor(() => rig.gate.inFlight === 0, 'running thread cancelled');
    await pause(100);
    assert.equal(rig.runs(), 1, 'the cancelled queued run never started');
    assert.equal(rig.gate.inFlight, 0);

    // The thread can be used again afterwards.
    rig.say('rex', 'c2-again', 'try again', 'c2');
    await waitFor(() => rig.runs() === 2, 'new run in the cancelled thread');
  });

  it('frees the slot when the bridge gives up following a run (lost contact, or maxWait)', async () => {
    const rex = await rig.boot('rex');
    rig.say('rex', 'l1', 'go');
    await waitFor(() => rig.runs() === 1 && rig.gate.inFlight === 1, 'running');
    (rex.daemon as unknown as { chiStatus: () => Promise<ChiRunResult> }).chiStatus = async () => {
      throw new DaemonError('network down', 'network');
    };
    await waitFor(() => rig.gate.inFlight === 0, 'slot back after lost contact');
    await waitFor(() => rig.mm.thread('l1').some((m) => /Lost contact/.test(m)), 'lost-contact notice');

    const ruby = await rig.boot('ruby', { progress: { ...FAST, maxWaitMs: 150 } });
    assert.ok(ruby);
    rig.say('ruby', 'w1', 'go');
    await waitFor(() => rig.gate.inFlight === 1, 'running');
    await waitFor(() => rig.gate.inFlight === 0, 'slot back after maxWait');
    await waitFor(() => rig.mm.thread('w1').some((m) => /stopped watching/.test(m)), 'gave-up notice');
  });

  it('stopping the bridge releases its slots and abandons its queue', async () => {
    rig.gate = new RunGate({ max: 1, log: quiet });
    const rex = await rig.boot('rex', {}, rig.gate);
    rig.say('rex', 'x1', 'running');
    await waitFor(() => rig.gate.inFlight === 1, 'running');
    rig.say('rex', 'x2', 'queued');
    await waitFor(() => rig.gate.queued === 1, 'queued');
    rex.stop();
    await waitFor(() => rig.gate.inFlight === 0 && rig.gate.queued === 0, 'drained');
    await pause(100);
    assert.equal(rig.runs(), 1, 'the queued run did not start on the freed slot');
  });

  it('after a restart, runs still going on the daemon keep their slots (N more do not start on top)', async () => {
    rig.gate = new RunGate({ max: 1, log: quiet });
    const before = await rig.boot('rex', {}, rig.gate);
    rig.say('rex', 'p1', 'long job');
    await waitFor(() => rig.runs() === 1, 'running');
    await waitFor(() => /"active"/.test(existsSync(path.join(rig.dir, 'threads-rex.json')) ? readFileSync(path.join(rig.dir, 'threads-rex.json'), 'utf8') : ''), 'active run persisted');
    before.stop(); // the daemon keeps the run going (detached)
    assert.equal(rig.gate.inFlight, 0);

    const restartGate = new RunGate({ max: 1, log: quiet });
    await rig.boot('rex', {}, restartGate);
    assert.equal(restartGate.inFlight, 1, 'the recovered run occupies a slot');

    rig.say('rex', 'p2', 'new work');
    await waitFor(() => restartGate.queued === 1, 'new work queued behind the recovered run');
    await pause(100);
    assert.equal(rig.runs(), 1, 'nothing new started');

    rig.daemon.settle('run-1', 'done', { output: 'finally' });
    await waitFor(() => rig.runs() === 2, 'queued work starts once the recovered run ends');
  });

  it('every bot\'s survivors are counted before ANY bot can start new work (staggered starts)', async () => {
    rig.gate = new RunGate({ max: 1, log: quiet });
    const ruby1 = await rig.boot('ruby', {}, rig.gate);
    rig.say('ruby', 'q1', 'long job');
    await waitFor(() => rig.runs() === 1, 'ruby running');
    await waitFor(() => /"active"/.test(existsSync(path.join(rig.dir, 'threads-ruby.json')) ? readFileSync(path.join(rig.dir, 'threads-ruby.json'), 'utf8') : ''), 'active run persisted');
    ruby1.stop(); // the daemon keeps run-1 going

    const restartGate = new RunGate({ max: 1, log: quiet });
    const rex = rig.make('rex', {}, restartGate);
    const ruby = rig.make('ruby', {}, restartGate);
    // Built, nothing started, nothing awaited: ruby's survivor already counts.
    assert.equal(restartGate.inFlight, 1, 'ruby\'s recovered run is counted before either bot starts');

    // rex finishes starting first and ruby has not re-attached yet (it has not even started).
    await rex.start();
    await pause(60);
    rig.say('rex', 'q2', 'new work');
    await waitFor(() => restartGate.queued === 1, 'rex\'s new work queues behind ruby\'s survivor');
    await pause(100);
    assert.equal(rig.runs(), 1, 'nothing new started on top of the survivor');
    assert.ok(restartGate.inFlight <= 1);

    await ruby.start(); // re-attaches: adopts the slot reserved for it, not a second one
    assert.equal(restartGate.inFlight, 1, 'no double count when ruby re-attaches');
    rig.daemon.settle('run-1', 'done', { output: 'finally' });
    await waitFor(() => rig.runs() === 2, 'queued work starts once the survivor ends');
  });

  it('started together (as the CLI does), the cap holds however the starts interleave', async () => {
    rig.gate = new RunGate({ max: 1, log: quiet });
    const ruby1 = await rig.boot('ruby', {}, rig.gate);
    rig.say('ruby', 'q1', 'long job');
    await waitFor(() => rig.runs() === 1, 'ruby running');
    await waitFor(() => /"active"/.test(existsSync(path.join(rig.dir, 'threads-ruby.json')) ? readFileSync(path.join(rig.dir, 'threads-ruby.json'), 'utf8') : ''), 'active run persisted');
    ruby1.stop();

    const restartGate = new RunGate({ max: 1, log: quiet });
    // rex has a schedule that came due while the bridge was down; ruby is slower to start (it also looks up an audit
    // channel), so rex's catch-up fires before ruby has re-attached.
    writeFileSync(
      path.join(rig.dir, 'schedules-rex.json'),
      JSON.stringify({ version: 1, schedules: { sweep: { last_slot: Date.now() - 10 * 60_000 } } }),
    );
    rig.mm.channels.set('ruby-audit', 'ruby-audit-id');
    const rex = rig.make('rex', { schedules: [{ name: 'sweep', cron: '* * * * *', channel: 'engineering', task: 'sweep the box' }] }, restartGate);
    const ruby = rig.make('ruby', { audit: { channel: 'ruby-audit' } }, restartGate);
    await Promise.all([rex.start(), ruby.start()]);
    await pause(150);
    assert.equal(rig.runs(), 1, 'only the survivor is running: the catch-up schedule had to queue');
    assert.equal(restartGate.inFlight, 1);
    assert.equal(restartGate.queued, 1, 'the due schedule waits behind ruby\'s survivor');

    rig.daemon.settle('run-1', 'done', { output: 'finally' });
    await waitFor(() => rig.runs() === 2, 'the schedule starts once the survivor ends');
  });

  it('a bridge that fails to start, or is stopped before it starts, gives its reserved slots back', async () => {
    rig.gate = new RunGate({ max: 2, log: quiet });
    const ruby1 = await rig.boot('ruby', {}, rig.gate);
    rig.say('ruby', 'q1', 'long job');
    await waitFor(() => rig.runs() === 1, 'ruby running');
    await waitFor(() => /"active"/.test(existsSync(path.join(rig.dir, 'threads-ruby.json')) ? readFileSync(path.join(rig.dir, 'threads-ruby.json'), 'utf8') : ''), 'active run persisted');
    ruby1.stop();

    const g = new RunGate({ max: 2, log: quiet });
    const ruby = rig.make('ruby', {}, g);
    assert.equal(g.inFlight, 1);
    ruby.stop(); // never started
    assert.equal(g.inFlight, 0, 'stop gives the reservation back');
    ruby.reserveRecovered(); // idempotent, and takes it again
    ruby.reserveRecovered();
    assert.equal(g.inFlight, 1, 'reserving twice holds one slot');
    ruby.stop();
    assert.equal(g.inFlight, 0);
  });
});

describe('approved runs under the cap', () => {
  const approvals: BotApprovalsConfig = { approvers: ['alice', 'bob'], timeoutMs: 60_000 };
  beforeEach(async () => {
    rig = await makeRig(1);
  });
  afterEach(() => closeRig(rig));

  it('an approved run waits for a slot like any other, then runs in the acting mode', async () => {
    await rig.boot('rex', { approvals, maxMode: 'acceptEdits' });
    rig.say('rex', 'a1', 'change the thing');
    await waitFor(() => rig.runs() === 1, 'plan run');
    rig.daemon.settle('run-1', 'done', { output: 'Plan: 1. edit a.ts' });
    await waitFor(() => rig.mm.receivedPosts.some((p) => p.root_id === 'a1' && p.message.startsWith('**Approval needed**')), 'approval post');
    const approval = rig.mm.receivedPosts.find((p) => p.root_id === 'a1' && p.message.startsWith('**Approval needed**'))!.id as string;
    await waitFor(() => rig.gate.inFlight === 0, 'plan run over');
    await pause(50);

    rig.say('rex', 'a2', 'other work'); // takes the only slot
    await waitFor(() => rig.runs() === 2, 'other run');

    rig.mm.broadcastReaction({ user_id: 'bob', post_id: approval, emoji_name: '+1' });
    await waitFor(() => rig.gate.queued === 1, 'approved run queued');
    await pause(100);
    assert.equal(rig.runs(), 2, 'the approved run has not been sent to the daemon');
    assert.ok(rig.mm.thread('a1').some((m) => /^Queued: /.test(m)));

    rig.daemon.settle('run-2', 'done', { output: 'other done' });
    await waitFor(() => rig.runs() === 3, 'approved run starts');
    const act = rig.daemon.rpcCalls('chi_run')[2]!.args.opts as { mode: string; parentId: string };
    assert.equal(act.mode, 'auto');
    assert.equal(act.parentId, 'run-1');
    rig.daemon.settle('run-3', 'done', { output: 'edited' });
    await waitFor(() => rig.gate.inFlight === 0, 'slot back');
  });
});

// ── restart ordering ───────────────────────────────────────────────────────────

describe('restart: survivor reservations are followed independently of startup ordering', () => {
  const approvals: BotApprovalsConfig = { approvers: ['alice', 'bob'], timeoutMs: 600_000 };
  const schedules = [{ name: 'sweep', cron: '0 3 * * *', channel: 'engineering', task: 'sweep' }];
  beforeEach(async () => {
    rig = await makeRig(1);
  });
  afterEach(() => closeRig(rig));

  /** A bot with a pending approval and (on disk) a schedule run that was in flight when the bridge died, now finished. */
  async function downWithApprovalAndSurvivor(): Promise<{ post: string; stateFile: string }> {
    const over = { approvals, maxMode: 'acceptEdits' as const, schedules };
    const first = await rig.boot('rex', over, new RunGate({ max: 4, log: quiet }));
    rig.say('rex', 'root1', 'please change it');
    await waitFor(() => rig.runs() === 1, 'plan run');
    rig.daemon.settle('run-1', 'done', { output: 'Plan: 1. edit' });
    await waitFor(() => rig.mm.receivedPosts.some((p) => p.root_id === 'root1' && p.message.startsWith('**Approval needed**')), 'approval post');
    const post = rig.mm.receivedPosts.find((p) => p.root_id === 'root1' && p.message.startsWith('**Approval needed**'))!.id as string;
    await waitFor(() => {
      try {
        return Boolean(JSON.parse(readFileSync(path.join(rig.dir, 'approvals-rex.json'), 'utf8')).approvals?.[post]);
      } catch {
        return false;
      }
    }, 'approval record');
    await first.router!.whenIdle();
    first.stop();
    return { post, stateFile: path.join(rig.dir, 'schedules-rex.json') };
  }

  it('an approval decided while down does not wait for a slot that only a later startup step can free (max 1)', async () => {
    const { post, stateFile } = await downWithApprovalAndSurvivor();
    // While down: the schedule's run (run-1 on the daemon, already finished) was in flight, and bob approved the plan.
    writeFileSync(stateFile, JSON.stringify({ version: 1, schedules: { sweep: { last_slot: Date.now() - 1000, in_flight: { run_id: 'run-1', slot: Date.now() - 1000, started_at: Date.now() - 1000 } } } }));
    rig.mm.addReaction({ user_id: 'bob', post_id: post, emoji_name: '+1', create_at: 5 });

    const gate = new RunGate({ max: 1, log: quiet });
    const b = rig.make('rex', { approvals, maxMode: 'acceptEdits', schedules }, gate);
    assert.equal(gate.inFlight, 1, 'the survivor is counted at construction');
    let started = false;
    const p = b.start().then(() => {
      started = true;
    });
    await waitFor(() => started, 'start() resolves (it must not wait for the approved run)', 5000);
    await waitFor(() => rig.runs() === 2, 'the approved run starts once the finished survivor releases its slot', 5000);
    await p;
    rig.daemon.settle('run-2', 'done', { output: 'edited' });
    await waitFor(() => gate.inFlight === 0, 'slots back');
  });

  it('a stop() during start() installs no timers and starts no scheduler', async () => {
    const gate = new RunGate({ max: 4, log: quiet });
    const b = rig.make('rex', { schedules }, gate);
    const starting = b.start();
    b.stop(); // before the first await in startInner has finished
    await starting.catch(() => undefined);
    await pause(100);
    assert.equal(b.isRunning(), false);
    assert.equal((b.scheduler as unknown as { timer?: unknown }).timer, undefined, 'no tick timer was installed');
    assert.equal((b.scheduler as unknown as { started: boolean }).started, false, 'scheduler.start() was never called');
  });
});

// ── schedules ──────────────────────────────────────────────────────────────────

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const EVERY5: { name: string; cron: string; channel: string; task: string; enabled?: boolean }[] = [{ name: 'box-alerts', cron: '*/5 * * * *', channel: 'rex-test', task: 'check the box' }];

class FakeClient implements ScheduleApi {
  posts: string[] = [];
  async reply(channel: string, message: string): Promise<MattermostPost> {
    this.posts.push(message);
    return { id: `p${this.posts.length}`, user_id: 'bot', channel_id: channel, message };
  }
  async resolveChannelId(ref: string): Promise<string> {
    return `id-${ref}`;
  }
}

class FakeDaemon implements ScheduleChiApi {
  calls: ChiRunOpts[] = [];
  runs = new Map<string, { status: string; output?: string }>();
  next = { status: 'running' } as { status: string; output?: string };
  startError?: Error;
  statusError?: Error;
  async chiRun(opts: ChiRunOpts): Promise<ChiRunResult> {
    if (this.startError) throw this.startError;
    this.calls.push(opts);
    const id = `run-${this.calls.length}`;
    this.runs.set(id, { ...this.next });
    return { run_id: id, status: 'running' };
  }
  async chiStatus(runId: string): Promise<ChiRunResult> {
    if (this.statusError) throw this.statusError;
    const r = this.runs.get(runId);
    if (!r) throw new DaemonError('chi_status: chi run not found', 'rpc');
    return { run_id: runId, status: r.status, output: r.output ?? null, error: null, output_truncated: false };
  }
  redact(t: string): string {
    return t;
  }
}

function scheduleUnit(max: number) {
  const dir = tmpDir('mm-cap-sched-');
  const statePath = path.join(dir, 'schedules-rex.json');
  const client = new FakeClient();
  const daemon = new FakeDaemon();
  const clock = { t: utc(2026, 10, 12, 7, 59, 30) };
  const logs: string[] = [];
  const gate = new RunGate({ max, log: quiet });
  const make = (runGate: RunGate = gate, schedules: typeof EVERY5 = EVERY5) =>
    new ScheduleRunner({
      bot: 'rex',
      schedules: resolveSchedules(schedules, 'bot rex', ['rex-test']),
      client,
      daemon,
      store: new ScheduleStore(statePath),
      chi: { engine: 'claude-code', cwd: '~/work' },
      rails: new Rails({ bot: 'rex', maxMode: 'plan', threadMode: 'plan', audit: new AuditLog({ file: path.join(dir, 'audit-rex.jsonl'), bot: 'rex', now: () => clock.t }) }),
      runGate,
      progress: { pollMinMs: 5, pollMaxMs: 10, editIntervalMs: 0, maxWaitMs: 3_600_000, maxPollFailures: 2 }, // the fake clock jumps minutes at a time
      scheduler: { tickMs: 600_000 },
      now: () => clock.t,
      log: (m) => logs.push(m),
    });
  return { dir, statePath, client, daemon, clock, logs, gate, make };
}

describe('scheduled runs under the cap', () => {
  it('a schedule waits for a slot, is not queued twice, and runs when one frees', async () => {
    const u = scheduleUnit(1);
    const hog = await u.gate.acquire({ bot: 'ruby', kind: 'thread' }); // the bridge is full
    const r = u.make();
    await r.tick(); // baseline
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r.tick();
    await waitFor(() => u.gate.queued === 1, 'schedule queued');
    assert.equal(u.daemon.calls.length, 0, 'no chi_run while full');

    u.clock.t = utc(2026, 10, 12, 8, 5, 5);
    await r.tick(); // the next occurrence while the previous one is still waiting
    assert.equal(u.gate.queued, 1, 'not queued a second time');
    assert.ok(u.logs.some((l) => /box-alerts.*previous run is still going; skipping/.test(l)));

    hog.release();
    await waitFor(() => u.daemon.calls.length === 1, 'schedule starts');
    assert.equal(u.gate.queued, 0);
    assert.equal(u.gate.inFlight, 1);
    u.daemon.runs.set('run-1', { status: 'done', output: 'ALL GOOD' });
    await r.whenIdle();
    assert.equal(u.gate.inFlight, 0, 'slot back when the run ended');
    assert.equal(u.client.posts.length, 1);

    const finished = readFileSync(path.join(u.dir, 'audit-rex.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((x) => x.event === 'schedule.finished');
    assert.equal(typeof finished?.queue_wait_s, 'number');
    r.stop();
  });

  it('frees its slot when chi_run fails, answers without a run id, or the run cannot be followed', async () => {
    const u = scheduleUnit(1);
    const r = u.make();
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    u.daemon.startError = new Error('engine missing');
    await r.tick();
    await r.whenIdle();
    assert.equal(u.gate.inFlight, 0, 'start error');
    assert.ok(u.client.posts.some((p) => /could not start/.test(p)));

    u.daemon.startError = undefined;
    const real = u.daemon.chiRun.bind(u.daemon);
    u.daemon.chiRun = async () => ({ status: 'running' }) as ChiRunResult;
    u.clock.t = utc(2026, 10, 12, 8, 5, 5);
    await r.tick();
    await r.whenIdle();
    assert.equal(u.gate.inFlight, 0, 'missing run id');
    assert.ok(u.client.posts.some((p) => /without a run id/.test(p)));

    u.daemon.chiRun = real;
    u.daemon.statusError = new DaemonError('down', 'network');
    u.clock.t = utc(2026, 10, 12, 8, 10, 5);
    await r.tick();
    await r.whenIdle();
    assert.equal(u.gate.inFlight, 0, 'lost contact');
    r.stop();
  });

  it('stopping releases a running schedule\'s slot and abandons one that is waiting', async () => {
    const u = scheduleUnit(1);
    const r = u.make();
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r.tick();
    await waitFor(() => u.gate.inFlight === 1, 'running');
    r.stop();
    await r.whenIdle();
    assert.equal(u.gate.inFlight, 0);

    const u2 = scheduleUnit(1);
    const hog = await u2.gate.acquire({ bot: 'ruby', kind: 'thread' });
    const r2 = u2.make();
    await r2.tick();
    u2.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r2.tick();
    await waitFor(() => u2.gate.queued === 1, 'waiting');
    r2.stop();
    await r2.whenIdle();
    assert.equal(u2.gate.queued, 0);
    hog.release();
    await pause(50);
    assert.equal(u2.daemon.calls.length, 0, 'it never ran');
    assert.equal(u2.gate.inFlight, 0);
  });

  it('after a restart a schedule\'s run that is still going keeps its slot until it ends', async () => {
    const u = scheduleUnit(1);
    const r1 = u.make();
    await r1.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r1.tick();
    await waitFor(() => u.daemon.calls.length === 1, 'run started');
    await waitFor(() => /"run_id": "run-1"/.test(readFileSync(u.statePath, 'utf8')), 'in_flight persisted');
    r1.stop(); // the bridge dies; run-1 is still running on the daemon
    await r1.whenIdle();

    const gate2 = new RunGate({ max: 1, log: quiet });
    u.clock.t = utc(2026, 10, 12, 8, 1, 0);
    const r2 = u.make(gate2);
    await r2.start();
    assert.equal(gate2.inFlight, 1, 'the interrupted run still occupies a slot');
    u.clock.t = utc(2026, 10, 12, 8, 5, 5);
    await r2.tick();
    await pause(60);
    assert.equal(gate2.queued, 1, 'a new occurrence waits behind it');
    assert.equal(u.daemon.calls.length, 1);

    u.daemon.runs.set('run-1', { status: 'done', output: 'x' });
    await waitFor(() => u.daemon.calls.length === 2, 'the new occurrence starts when the old run ends');
    r2.stop();
    await r2.whenIdle();
    assert.equal(gate2.inFlight, 0);
  });

  it('a schedule\'s surviving run is counted synchronously at start(), before any channel lookup or post', async () => {
    const u = scheduleUnit(1);
    const r1 = u.make();
    await r1.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r1.tick();
    await waitFor(() => u.daemon.calls.length === 1, 'run started');
    await waitFor(() => /"run_id": "run-1"/.test(readFileSync(u.statePath, 'utf8')), 'in_flight persisted');
    r1.stop();
    await r1.whenIdle();

    const gate2 = new RunGate({ max: 1, log: quiet });
    const r2 = u.make(gate2);
    const started = r2.start(); // NOT awaited: the channel lookups and the interrupted-run post are still ahead
    assert.equal(gate2.inFlight, 1, 'counted before the first await');
    await started;
    assert.equal(gate2.inFlight, 1, 'still counted while it runs');
    u.daemon.runs.set('run-1', { status: 'done', output: 'x' });
    await waitFor(() => gate2.inFlight === 0, 'released once chiStatus shows it terminal');
    r2.stop();
  });

  it('a surviving schedule run that already ended, or is gone, gives its slot straight back', async () => {
    for (const how of ['terminal', 'gone'] as const) {
      const u = scheduleUnit(1);
      const r1 = u.make();
      await r1.tick();
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r1.tick();
      await waitFor(() => u.daemon.calls.length === 1, 'run started');
      await waitFor(() => /"run_id": "run-1"/.test(readFileSync(u.statePath, 'utf8')), 'in_flight persisted');
      r1.stop();
      await r1.whenIdle();
      if (how === 'terminal') u.daemon.runs.set('run-1', { status: 'done', output: 'x' });
      else u.daemon.statusError = new DaemonError('chi run not found', 'rpc');

      const gate2 = new RunGate({ max: 1, log: quiet });
      const r2 = u.make(gate2);
      r2.reserveRecovered();
      assert.equal(gate2.inFlight, 1, `${how}: reserved by the runner`);
      await r2.start();
      assert.equal(gate2.inFlight, 0, `${how}: slot returned`);
      r2.stop();
    }
  });

  it('stopping a runner that never got to follow its survivor gives the reservation back', async () => {
    const u = scheduleUnit(1);
    const r1 = u.make();
    await r1.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r1.tick();
    await waitFor(() => u.daemon.calls.length === 1, 'run started');
    await waitFor(() => /"run_id": "run-1"/.test(readFileSync(u.statePath, 'utf8')), 'in_flight persisted');
    r1.stop();
    await r1.whenIdle();

    const gate2 = new RunGate({ max: 1, log: quiet });
    const r2 = u.make(gate2);
    r2.reserveRecovered();
    r2.reserveRecovered();
    assert.equal(gate2.inFlight, 1, 'idempotent');
    r2.stop();
    assert.equal(gate2.inFlight, 0);
  });

  it('a survivor of a schedule that was removed or disabled across the restart is still counted and followed', async () => {
    for (const how of ['removed', 'disabled'] as const) {
      const u = scheduleUnit(1);
      const r1 = u.make();
      await r1.tick();
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r1.tick();
      await waitFor(() => u.daemon.calls.length === 1, 'run started');
      await waitFor(() => /"run_id": "run-1"/.test(readFileSync(u.statePath, 'utf8')), 'in_flight persisted');
      r1.stop();
      await r1.whenIdle();

      const gate2 = new RunGate({ max: 1, log: quiet });
      const after = how === 'removed' ? [] : [{ ...EVERY5[0]!, enabled: false }];
      const r2 = u.make(gate2, after);
      r2.reserveRecovered(); // what the bridge does for every bot at construction
      assert.equal(gate2.inFlight, 1, `${how}: counted`);
      await r2.start();
      await pause(30);
      assert.equal(gate2.inFlight, 1, `${how}: still going on the daemon, still counted after the state was dropped`);
      u.daemon.runs.set('run-1', { status: 'done', output: 'x' });
      await waitFor(() => gate2.inFlight === 0, `${how}: released when the run ends`);
      r2.stop();
    }
  });

  it('survivors are followed by followRecovered() alone, before start() has done anything else', async () => {
    const u = scheduleUnit(1);
    const r1 = u.make();
    await r1.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r1.tick();
    await waitFor(() => u.daemon.calls.length === 1, 'run started');
    await waitFor(() => /"run_id": "run-1"/.test(readFileSync(u.statePath, 'utf8')), 'in_flight persisted');
    r1.stop();
    await r1.whenIdle();
    u.daemon.runs.set('run-1', { status: 'done', output: 'x' });

    const gate2 = new RunGate({ max: 1, log: quiet });
    const r2 = u.make(gate2);
    r2.reserveRecovered();
    assert.equal(gate2.inFlight, 1);
    await r2.followRecovered(); // start() was never called
    assert.equal(gate2.inFlight, 0, 'the finished survivor released its slot without start()');
    r2.stop();
  });

  it('a slot granted in the same tick as stop() does not start a run during shutdown', async () => {
    const u = scheduleUnit(1);
    const hog = await u.gate.acquire({ bot: 'ruby', kind: 'thread' });
    const r = u.make();
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r.tick();
    await waitFor(() => u.gate.queued === 1, 'schedule queued');
    hog.release(); // the gate grants the queued schedule right here, synchronously ...
    r.stop(); // ... and stop() aborts before the schedule's continuation runs
    await r.whenIdle();
    await pause(50);
    assert.equal(u.daemon.calls.length, 0, 'no chi_run during shutdown');
    assert.equal(u.gate.inFlight, 0, 'the granted slot was given back');
  });

  it('a stop() while start() is still working installs no timer and never ticks', async () => {
    const u = scheduleUnit(4);
    const r = u.make();
    const starting = r.start();
    r.stop();
    await starting;
    await pause(30);
    assert.equal((r as unknown as { timer?: unknown }).timer, undefined);
    assert.equal(u.daemon.calls.length, 0);
  });
});

after(() => sweepTmp());
