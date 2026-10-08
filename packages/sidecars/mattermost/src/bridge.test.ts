import { describe, it, before, after } from 'node:test';
import { sweepTmp, tmpDir } from './test-tmp.js';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MattermostGate } from './gate.js';
import { MockMattermostServer } from './mock-server.js';
import { MattermostBridge } from './bridge.js';
import type { MattermostPost, MattermostPostEvent } from './types.js';

/** Poll instead of a fixed sleep: a loaded CI box can miss a 150 ms window. */
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('MattermostGate (Unit Tests)', () => {
  it('denies by default when allowed_users is empty', () => {
    const gate = new MattermostGate({
      mattermostUrl: 'http://localhost',
      mattermostToken: 'token',
      allowedUsers: [],
      allowedChannels: ['general'],
    });

    const post: MattermostPost = {
      id: 'p1',
      user_id: 'user1',
      channel_id: 'c1',
      message: 'hello',
    };
    const event: MattermostPostEvent = {
      event: 'posted',
      data: { channel_name: 'general', post: JSON.stringify(post) },
      seq: 1,
    };

    const res = gate.check(event, post);
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /deny by default/);
  });

  it('denies by default when allowed_channels is empty', () => {
    const gate = new MattermostGate({
      mattermostUrl: 'http://localhost',
      mattermostToken: 'token',
      allowedUsers: ['user1'],
      allowedChannels: [],
    });

    const post: MattermostPost = {
      id: 'p1',
      user_id: 'user1',
      channel_id: 'c1',
      message: 'hello',
    };
    const event: MattermostPostEvent = {
      event: 'posted',
      data: { channel_name: 'general', post: JSON.stringify(post) },
      seq: 1,
    };

    const res = gate.check(event, post);
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /deny by default/);
  });

  it('denies bot own posts', () => {
    const gate = new MattermostGate({
      mattermostUrl: 'http://localhost',
      mattermostToken: 'token',
      botUserId: 'bot-123',
      allowedUsers: ['bot-123', 'alice'],
      allowedChannels: ['general'],
    });

    const post: MattermostPost = {
      id: 'p1',
      user_id: 'bot-123',
      channel_id: 'c1',
      message: 'echo reply',
    };
    const event: MattermostPostEvent = {
      event: 'posted',
      data: { channel_name: 'general', post: JSON.stringify(post) },
      seq: 1,
    };

    const res = gate.check(event, post);
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /own post/);
  });

  it('denies unlisted user', () => {
    const gate = new MattermostGate({
      mattermostUrl: 'http://localhost',
      mattermostToken: 'token',
      allowedUsers: ['alice'],
      allowedChannels: ['general'],
    });

    const post: MattermostPost = {
      id: 'p1',
      user_id: 'mallory',
      channel_id: 'c1',
      message: 'hack attempt',
    };
    const event: MattermostPostEvent = {
      event: 'posted',
      data: { channel_name: 'general', post: JSON.stringify(post) },
      seq: 1,
    };

    const res = gate.check(event, post);
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /not in allowed_users/);
  });

  it('ignores a client-supplied props.username (cannot impersonate an allowed user)', () => {
    const gate = new MattermostGate({
      mattermostUrl: 'http://localhost',
      mattermostToken: 'token',
      allowedUsers: ['alice'],
      allowedChannels: ['general'],
    });

    const post: MattermostPost = {
      id: 'p1',
      user_id: 'mallory',
      channel_id: 'c1',
      message: 'spoof',
      props: { username: 'alice' },
    };
    const event: MattermostPostEvent = {
      event: 'posted',
      data: { channel_name: 'general', sender_name: '@mallory', post: JSON.stringify(post) },
      seq: 1,
    };

    const res = gate.check(event, post);
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /not in allowed_users/);
  });

  it('denies unlisted channel', () => {
    const gate = new MattermostGate({
      mattermostUrl: 'http://localhost',
      mattermostToken: 'token',
      allowedUsers: ['alice'],
      allowedChannels: ['general'],
    });

    const post: MattermostPost = {
      id: 'p1',
      user_id: 'alice',
      channel_id: 'c-secret',
      message: 'secret post',
    };
    const event: MattermostPostEvent = {
      event: 'posted',
      data: { channel_name: 'secret-channel', post: JSON.stringify(post) },
      seq: 1,
    };

    const res = gate.check(event, post);
    assert.equal(res.allowed, false);
    assert.match(res.reason!, /not in allowed_channels/);
  });

  it('allows message when user and channel are allowed', () => {
    const gate = new MattermostGate({
      mattermostUrl: 'http://localhost',
      mattermostToken: 'token',
      allowedUsers: ['alice'],
      allowedChannels: ['general'],
    });

    const post: MattermostPost = {
      id: 'p1',
      user_id: 'alice',
      channel_id: 'c1',
      message: 'ping',
    };
    const event: MattermostPostEvent = {
      event: 'posted',
      data: { channel_name: 'general', post: JSON.stringify(post) },
      seq: 1,
    };

    const res = gate.check(event, post);
    assert.equal(res.allowed, true);
  });
});

describe('MattermostBridge against Mock Server (Hermetic Integration)', () => {
  let mockServer: MockMattermostServer;
  let serverUrl: string;
  let bridge: MattermostBridge;
  // B5: every bot writes an audit file; keep it out of the real home directory.
  const dataDir = tmpDir('mm-b1-');

  before(async () => {
    mockServer = new MockMattermostServer();
    serverUrl = await mockServer.listen();

    bridge = new MattermostBridge({
      mattermostUrl: serverUrl,
      mattermostToken: 'mock-bot-token',
      allowedUsers: ['alice-uid', 'bob-uid'],
      allowedChannels: ['c-allowed', 'engineering'],
      echoPrefix: 'echo: ',
      dataDir,
    });

    await bridge.start();
    await until(() => mockServer.clientCount > 0, 'WebSocket handshake');
  });

  after(async () => {
    bridge.stop();
    await mockServer.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('receives post from allowed user on allowed channel and sends echo reply', async () => {
    const initialCount = mockServer.receivedPosts.length;

    mockServer.broadcastPost(
      {
        id: 'post-1',
        user_id: 'alice-uid',
        channel_id: 'c-allowed',
        message: 'hello bridge',
      },
      'c-allowed'
    );

    // Wait for async processing
    await until(() => mockServer.receivedPosts.length >= initialCount + 1, 'echo reply');

    assert.equal(mockServer.receivedPosts.length, initialCount + 1);
    const reply = mockServer.receivedPosts[mockServer.receivedPosts.length - 1]!;
    assert.equal(reply.channel_id, 'c-allowed');
    assert.equal(reply.message, 'echo: hello bridge');
    assert.equal(reply.root_id, 'post-1');
  });

  it('maintains existing thread root_id on threaded reply', async () => {
    const initialCount = mockServer.receivedPosts.length;

    mockServer.broadcastPost(
      {
        id: 'post-2',
        root_id: 'thread-root-999',
        user_id: 'bob-uid',
        channel_id: 'c-allowed',
        message: 'reply in thread',
      },
      'c-allowed'
    );

    await until(() => mockServer.receivedPosts.length >= initialCount + 1, 'echo reply');

    assert.equal(mockServer.receivedPosts.length, initialCount + 1);
    const reply = mockServer.receivedPosts[mockServer.receivedPosts.length - 1]!;
    assert.equal(reply.channel_id, 'c-allowed');
    assert.equal(reply.message, 'echo: reply in thread');
    assert.equal(reply.root_id, 'thread-root-999');
  });

  it('denies and ignores post from unauthorized user', async () => {
    const initialCount = mockServer.receivedPosts.length;

    mockServer.broadcastPost(
      {
        id: 'post-3',
        user_id: 'mallory-unauth',
        channel_id: 'c-allowed',
        message: 'should be dropped',
      },
      'c-allowed'
    );

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mockServer.receivedPosts.length, initialCount);
  });

  it('denies and ignores post from unauthorized channel', async () => {
    const initialCount = mockServer.receivedPosts.length;

    mockServer.broadcastPost(
      {
        id: 'post-4',
        user_id: 'alice-uid',
        channel_id: 'c-forbidden',
        message: 'should also be dropped',
      },
      'random-channel'
    );

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mockServer.receivedPosts.length, initialCount);
  });

  it('ignores own bot messages to prevent echo loops', async () => {
    const initialCount = mockServer.receivedPosts.length;

    mockServer.broadcastPost(
      {
        id: 'post-5',
        user_id: mockServer.botId,
        channel_id: 'c-allowed',
        message: 'echo: loop prevention test',
      },
      'c-allowed'
    );

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mockServer.receivedPosts.length, initialCount);
  });
});

// Remove every temp directory the file made, including ones a stopped bridge wrote into again.
after(() => sweepTmp());
