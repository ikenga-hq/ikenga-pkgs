import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { sweepTmp, tmpDir } from './test-tmp.js';
import { MockMattermostServer } from './mock-server.js';
import { MattermostBridge, installExitGuard } from './bridge.js';
import { MattermostClient, backoffDelayMs } from './client.js';
import type { MattermostClientTiming } from './client.js';
import type { MattermostBridgeConfig, MattermostPost } from './types.js';

/** Poll instead of a fixed sleep. */
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Small, fast, jitter-free timings so the suite does not wait on production delays. */
const FAST: MattermostClientTiming = { backoffMinMs: 20, backoffMaxMs: 160, healthyMs: 60_000, pingIntervalMs: 0, random: () => 1 };

function cfg(url: string): MattermostBridgeConfig {
  return { mattermostUrl: url, mattermostToken: 'tok', allowedUsers: ['alice-uid'], allowedChannels: ['c-allowed'] };
}

const post = (id: string): MattermostPost => ({ id, user_id: 'alice-uid', channel_id: 'c-allowed', message: id });

describe('backoffDelayMs', () => {
  it('doubles from the minimum and is capped at the maximum', () => {
    const d = (n: number) => backoffDelayMs(n, 1000, 60_000, () => 1);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 50].map(d), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it('jitters between half and all of the delay', () => {
    assert.equal(backoffDelayMs(3, 1000, 60_000, () => 0), 4000);
    assert.equal(backoffDelayMs(3, 1000, 60_000, () => 0.999999), 8000);
    for (let i = 0; i < 200; i++) {
      const v = backoffDelayMs(2, 1000, 60_000, Math.random);
      assert.ok(v >= 2000 && v <= 4000, `got ${v}`);
    }
  });
});

describe('MattermostClient websocket resilience', () => {
  let server: MockMattermostServer | undefined;
  let client: MattermostClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
  });

  async function start(timing: MattermostClientTiming): Promise<{ url: string }> {
    server = new MockMattermostServer();
    const url = await server.listen();
    client = new MattermostClient(cfg(url), timing);
    client.on('error', () => {});
    return { url };
  }

  it('(a) reconnects after the server drops it abruptly and receives a post sent afterwards', async () => {
    await start(FAST);
    const events: string[] = [];
    const closes: Array<[number, boolean]> = [];
    const got: string[] = [];
    client!.on('post', (_e, p) => got.push(p.id));
    client!.on('close', (code, _r, expected) => closes.push([code, expected]));
    client!.on('reconnecting', () => events.push('reconnecting'));
    client!.on('reconnected', () => events.push('reconnected'));
    await client!.connect();
    await until(() => server!.clientCount === 1, 'first connection');

    server!.dropClients();
    await until(() => events.includes('reconnected'), 'reconnected');
    await until(() => server!.clientCount === 1, 'second connection registered');

    server!.broadcastPost(post('after-reconnect'));
    await until(() => got.includes('after-reconnect'), 'post after reconnect');
    assert.equal(server!.connectionCount, 2);
    assert.deepEqual(closes, [[1006, false]]);
    assert.deepEqual(events, ['reconnecting', 'reconnected']);
  });

  it('(a) also reconnects after a clean server-side close frame, and re-sends the auth challenge', async () => {
    await start(FAST);
    let reconnected = 0;
    const got: string[] = [];
    client!.on('post', (_e, p) => got.push(p.id));
    client!.on('reconnected', () => reconnected++);
    await client!.connect();
    await until(() => server!.clientCount === 1, 'first connection');

    server!.closeClients(1001, 'server restart');
    await until(() => reconnected === 1, 'reconnected');
    await until(() => server!.clientCount === 1, 'second connection registered');
    server!.broadcastPost(post('p2'));
    await until(() => got.includes('p2'), 'post after clean close');
    // One challenge per connection: the mock only authenticates (and so only ever replies to) a challenge it received.
    assert.equal(server!.connectionCount, 2);
  });

  it('(b) our own close() does not reconnect', async () => {
    await start(FAST);
    const reconnecting: number[] = [];
    const closes: boolean[] = [];
    client!.on('reconnecting', (a) => reconnecting.push(a));
    client!.on('close', (_c, _r, expected) => closes.push(expected));
    await client!.connect();
    await until(() => server!.clientCount === 1, 'connection');

    client!.close();
    await until(() => server!.clientCount === 0, 'server saw the hang-up');
    await sleep(FAST.backoffMaxMs! * 3);
    assert.equal(server!.connectionCount, 1);
    assert.deepEqual(reconnecting, []);
    assert.ok(closes.every((e) => e), 'any close reported is the expected one');
  });

  it('(b) close() while a reconnect is pending cancels it', async () => {
    await start({ ...FAST, backoffMinMs: 200, backoffMaxMs: 200 });
    let scheduled = 0;
    client!.on('reconnecting', () => scheduled++);
    await client!.connect();
    await until(() => server!.clientCount === 1, 'connection');
    server!.dropClients();
    await until(() => scheduled === 1, 'reconnect scheduled');
    client!.close();
    await sleep(400);
    assert.equal(server!.connectionCount, 1, 'no second connection after close()');
  });

  it('(c) backoff grows, is capped, and keeps trying while the server is down', async () => {
    await start(FAST);
    const delays: number[] = [];
    client!.on('reconnecting', (_a, d) => delays.push(d));
    await client!.connect();
    await until(() => server!.clientCount === 1, 'connection');

    await server!.close(); // the port now refuses connections
    await until(() => delays.length >= 6, 'six reconnect attempts');
    assert.deepEqual(delays.slice(0, 6), [20, 40, 80, 160, 160, 160]);
    server = undefined;
  });

  it('(c) backoff starts over once a connection has been healthy long enough', async () => {
    await start({ ...FAST, healthyMs: 100 });
    const delays: number[] = [];
    let reconnected = 0;
    client!.on('reconnecting', (_a, d) => delays.push(d));
    client!.on('reconnected', () => reconnected++);
    await client!.connect();
    await until(() => server!.clientCount === 1, 'connection');

    server!.dropClients();
    await until(() => reconnected === 1, 'first reconnect');
    await sleep(250); // healthy: the counter resets
    server!.dropClients();
    await until(() => reconnected === 2, 'second reconnect');
    assert.deepEqual(delays, [20, 20]);
  });

  it('(c) a connection that is not healthy keeps the delay growing', async () => {
    await start({ ...FAST, healthyMs: 60_000 });
    const delays: number[] = [];
    let reconnected = 0;
    client!.on('reconnecting', (_a, d) => delays.push(d));
    client!.on('reconnected', () => reconnected++);
    await client!.connect();
    await until(() => server!.clientCount === 1, 'connection');
    for (let i = 1; i <= 3; i++) {
      server!.dropClients();
      await until(() => reconnected === i, `reconnect ${i}`);
      await until(() => server!.clientCount === 1, `registered ${i}`);
    }
    assert.deepEqual(delays, [20, 40, 80]);
  });

  it('(d) liveness ping: a silent connection is detected and replaced', async () => {
    await start({ ...FAST, pingIntervalMs: 40 });
    let reconnected = 0;
    const closes: Array<[number, string]> = [];
    client!.on('reconnected', () => reconnected++);
    client!.on('close', (c, r) => closes.push([c, r]));
    await client!.connect();
    await until(() => server!.clientCount === 1, 'connection');
    await until(() => server!.pingCount >= 2, 'pings flowing');

    server!.answerPings = false; // the peer goes half-open: it accepts frames and says nothing
    await until(() => reconnected >= 1, 'reconnect after silence');
    assert.equal(closes[0]?.[0], 1006);
    assert.match(closes[0]?.[1] ?? '', /liveness/);
    assert.ok(server!.connectionCount >= 2);
  });

  it('(d) liveness ping: an answering connection is left alone', async () => {
    await start({ ...FAST, pingIntervalMs: 30 });
    await client!.connect();
    await until(() => server!.pingCount >= 6, 'six answered pings');
    assert.equal(server!.connectionCount, 1);
  });

  it('a failed FIRST connect rejects (and does not start a reconnect loop)', async () => {
    server = new MockMattermostServer();
    const url = await server.listen();
    await server.close(); // nothing listens on `url` now
    server = undefined;
    client = new MattermostClient(cfg(url), FAST);
    let scheduled = 0;
    client.on('reconnecting', () => scheduled++);
    await assert.rejects(client.connect(), /WebSocket/);
    await sleep(100);
    assert.equal(scheduled, 0);
  });

  it('a failed first connect rejects even with no error listener attached', async () => {
    server = new MockMattermostServer();
    const url = await server.listen();
    await server.close();
    server = undefined;
    client = new MattermostClient(cfg(url), FAST); // deliberately no .on('error')
    await assert.rejects(client.connect());
  });

  it('REST keeps working while the websocket is down', async () => {
    await start({ ...FAST, backoffMinMs: 500, backoffMaxMs: 500 });
    await client!.connect();
    await until(() => server!.clientCount === 1, 'connection');
    server!.dropClients();
    await sleep(50); // down, waiting to reconnect
    const created = await client!.reply('c-allowed', 'still posting');
    assert.equal(created.message, 'still posting');
    assert.equal(server!.receivedPosts.at(-1)?.message, 'still posting');
  });
});

describe('MattermostBridge survives a websocket drop', () => {
  it('echoes a post sent after the reconnect, and logs the loss and the recovery', async () => {
    const dataDir = tmpDir('mm-rc-');
    const server = new MockMattermostServer();
    const url = await server.listen();
    const lines: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => void lines.push(a.join(' '));
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    const bridge = new MattermostBridge({ ...cfg(url), name: 'rex', dataDir, allowedChannels: ['c-allowed'] }, FAST);
    try {
      await bridge.start();
      await until(() => server.clientCount === 1, 'first connection');
      server.closeClients(1012, 'service restart');
      await until(() => server.connectionCount === 2 && server.clientCount === 1, 'second connection');
      const before = server.receivedPosts.length;
      server.broadcastPost(post('hello-again'), 'c-allowed');
      await until(() => server.receivedPosts.length > before, 'echo after reconnect');
      assert.equal(server.receivedPosts.at(-1)?.message, 'echo: hello-again');
    } finally {
      console.error = origErr;
      console.log = origLog;
      bridge.stop();
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
    const closed = lines.find((l) => l.includes('closed unexpectedly'));
    assert.ok(closed, lines.join('\n'));
    assert.match(closed, /\[mattermost:rex\].*code 1012.*"service restart"/);
    assert.ok(lines.some((l) => /\[mattermost:rex\] websocket reconnected/.test(l)));
    assert.equal(lines.filter((l) => l.includes('websocket reconnected')).length, 1);
  });
});

describe('installExitGuard', () => {
  it('turns a drained event loop into a non-zero exit with a log line', () => {
    const proc = Object.assign(new EventEmitter(), { exitCode: undefined as number | string | null | undefined });
    const lines: string[] = [];
    installExitGuard(proc as never, (l) => lines.push(l));
    proc.emit('beforeExit', 0);
    assert.equal(proc.exitCode, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /should still be running/);
  });
});

after(() => sweepTmp());
