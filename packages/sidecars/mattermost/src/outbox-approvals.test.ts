/**
 * Tests for Outbox Draft Approval Handler in Mattermost Bridge (S2 / D-B13).
 *
 * Verifies:
 *   1. Approver allowlist matching STRICTLY by Mattermost user ID (never by username).
 *   2. Box allowlist with exactly the 3 required user IDs:
 *        - chinedumokerengwor (9s65in45np8h98qeatgx7anuoa)
 *        - ada (buay4kf99bbk7cjtbeupd5rxow)
 *        - onyedikachi (f3w99k5x6fgomdprh8axosmmsc)
 *   3. Fail-closed default: empty approvers list rejects all users.
 *   4. Bot refusal: ik-ruby, ik-rex, is_bot: true, and ik-* are refused (bot_cannot_approve).
 *   5. Username lookalike refusal: matching username with differing user ID is refused.
 *   6. Reaction handler: +1 and thumbsup route to socket; other emojis ignored; bots & unauthorized refused.
 *   7. Button action handler: routes to socket for authorized approver.
 *   8. Socket UID check: unauthorized bridge UID rejected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  DraftApprovalManager,
  computeDraftPayloadHash,
  type CanonicalDraftPayload,
} from './outbox-approvals.js';
import type { MattermostClient } from './client.js';

const BOX_APPROVER_IDS = [
  '9s65in45np8h98qeatgx7anuoa', // chinedumokerengwor
  'buay4kf99bbk7cjtbeupd5rxow', // ada
  'f3w99k5x6fgomdprh8axosmmsc', // onyedikachi
];

function createMockSocketServer(socketPath: string, onMessage: (msg: any) => { ok: boolean; error?: string }) {
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) {
        const msg = JSON.parse(buf.trim());
        const resp = onMessage(msg);
        c.write(JSON.stringify(resp) + '\n');
        c.end();
      }
    });
  });
  return new Promise<{ server: net.Server; close: () => Promise<void> }>((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test('outbox draft approval: allowlist, bots, lookalikes, reactions, buttons, socket', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-outbox-test-'));
  const socketPath = path.join(tmpDir, 'test.sock');

  let receivedMessage: any = null;
  const mockServer = await createMockSocketServer(socketPath, (msg) => {
    receivedMessage = msg;
    if (msg.bridgeUid !== 1005) {
      return { ok: false, error: 'unauthorized_bridge_uid' };
    }
    return { ok: true, draftId: msg.draftId };
  });

  const users: Record<string, { id: string; username: string; is_bot?: boolean }> = {
    // 3 allowlisted users
    '9s65in45np8h98qeatgx7anuoa': { id: '9s65in45np8h98qeatgx7anuoa', username: 'chinedumokerengwor' },
    'buay4kf99bbk7cjtbeupd5rxow': { id: 'buay4kf99bbk7cjtbeupd5rxow', username: 'ada' },
    'f3w99k5x6fgomdprh8axosmmsc': { id: 'f3w99k5x6fgomdprh8axosmmsc', username: 'onyedikachi' },
    // Lookalike: username 'chinedumokerengwor' but DIFFERENT user ID
    'attacker-lookalike-chinedum': { id: 'attacker-lookalike-chinedum', username: 'chinedumokerengwor' },
    // Lookalike: username 'ada' but DIFFERENT user ID
    'attacker-lookalike-ada': { id: 'attacker-lookalike-ada', username: 'ada' },
    // Bots
    'bot-ik-ruby-id': { id: 'bot-ik-ruby-id', username: 'ik-ruby' },
    'bot-ik-rex-id': { id: 'bot-ik-rex-id', username: 'ik-rex' },
    'bot-flagged-id': { id: 'bot-flagged-id', username: 'somebot', is_bot: true },
    'bot-prefixed-id': { id: 'bot-prefixed-id', username: 'ik-assistant' },
    // Ordinary non-allowlisted user
    'intruder-user-id': { id: 'intruder-user-id', username: 'intruder' },
  };

  const repliedMessages: { channelId: string; message: string; rootId?: string }[] = [];

  const mockClient = {
    async getUser(id: string) {
      if (users[id]) return users[id];
      throw new Error(`user not found: ${id}`);
    },
    async reply(channelId: string, message: string, rootId?: string) {
      repliedMessages.push({ channelId, message, rootId });
      return { id: 'reply-1', channel_id: channelId, message };
    },
  } as unknown as MattermostClient;

  const manager = new DraftApprovalManager({
    approvers: BOX_APPROVER_IDS,
    socketPath,
    bridgeUid: 1005,
    client: mockClient,
  });

  const payload: CanonicalDraftPayload = {
    channel: 'smtp',
    to: 'customer@example.com',
    subject: 'Terms Update',
    body: 'Please find attached the updated terms.',
    scheduled_at: null,
  };

  await t.test('1. fail-closed: empty approver list rejects all users', async () => {
    const emptyManager = new DraftApprovalManager({
      approvers: [], // empty default
      socketPath,
      bridgeUid: 1005,
      client: mockClient,
    });
    receivedMessage = null;
    const res = await emptyManager.approveDraft({
      draftId: 'draft-empty-test',
      payload,
      clickerUserId: '9s65in45np8h98qeatgx7anuoa',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_in_approvers_allowlist');
    assert.equal(receivedMessage, null, 'socket must never be contacted when allowlist is empty');
  });

  await t.test('2. non-allowlisted user is refused', async () => {
    receivedMessage = null;
    const res = await manager.approveDraft({
      draftId: 'draft-intruder',
      payload,
      clickerUserId: 'intruder-user-id',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_in_approvers_allowlist');
    assert.equal(receivedMessage, null);
  });

  await t.test('3. username lookalike is refused (matched on user ID ONLY)', async () => {
    receivedMessage = null;
    // User has username 'chinedumokerengwor', but user ID is 'attacker-lookalike-chinedum'
    const res = await manager.approveDraft({
      draftId: 'draft-lookalike-1',
      payload,
      clickerUserId: 'attacker-lookalike-chinedum',
    });
    assert.equal(res.ok, false, 'lookalike must be rejected');
    assert.equal(res.error, 'not_in_approvers_allowlist');
    assert.equal(receivedMessage, null, 'socket must never be called for lookalike');

    // Also lookalike for Ada
    const resAda = await manager.approveDraft({
      draftId: 'draft-lookalike-2',
      payload,
      clickerUserId: 'attacker-lookalike-ada',
    });
    assert.equal(resAda.ok, false);
    assert.equal(resAda.error, 'not_in_approvers_allowlist');
    assert.equal(receivedMessage, null);
  });

  await t.test('4. bots are refused (ik-ruby, ik-rex, is_bot: true, ik-*)', async () => {
    receivedMessage = null;

    // ik-ruby
    const resRuby = await manager.approveDraft({
      draftId: 'draft-ruby',
      payload,
      clickerUserId: 'bot-ik-ruby-id',
    });
    assert.equal(resRuby.ok, false);
    assert.equal(resRuby.error, 'bot_cannot_approve');
    assert.equal(receivedMessage, null);

    // ik-rex
    const resRex = await manager.approveDraft({
      draftId: 'draft-rex',
      payload,
      clickerUserId: 'bot-ik-rex-id',
    });
    assert.equal(resRex.ok, false);
    assert.equal(resRex.error, 'bot_cannot_approve');
    assert.equal(receivedMessage, null);

    // is_bot: true
    const resBot = await manager.approveDraft({
      draftId: 'draft-flagged-bot',
      payload,
      clickerUserId: 'bot-flagged-id',
    });
    assert.equal(resBot.ok, false);
    assert.equal(resBot.error, 'bot_cannot_approve');
    assert.equal(receivedMessage, null);

    // ik-* prefix
    const resPrefixed = await manager.approveDraft({
      draftId: 'draft-prefixed-bot',
      payload,
      clickerUserId: 'bot-prefixed-id',
    });
    assert.equal(resPrefixed.ok, false);
    assert.equal(resPrefixed.error, 'bot_cannot_approve');
    assert.equal(receivedMessage, null);
  });

  await t.test('5. unverifiable user is refused', async () => {
    receivedMessage = null;
    const res = await manager.approveDraft({
      draftId: 'draft-unverifiable',
      payload,
      clickerUserId: 'completely-unknown-user-id',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unverifiable_user');
    assert.equal(receivedMessage, null);
  });

  await t.test('6. all 3 allowlisted user IDs succeed and dispatch to socket', async () => {
    const allowlistedUsers: [string, string][] = [
      ['9s65in45np8h98qeatgx7anuoa', 'chinedumokerengwor'],
      ['buay4kf99bbk7cjtbeupd5rxow', 'ada'],
      ['f3w99k5x6fgomdprh8axosmmsc', 'onyedikachi'],
    ];
    for (const [userId, expectedUser] of allowlistedUsers) {
      receivedMessage = null;
      const draftId = `draft-${expectedUser}`;
      const res = await manager.approveDraft({
        draftId,
        payload,
        clickerUserId: userId,
      });
      assert.equal(res.ok, true);
      assert.equal(res.approver, expectedUser);
      assert.ok(receivedMessage, 'socket must receive approval message');
      assert.equal(receivedMessage.draftId, draftId);
      assert.equal(receivedMessage.bridgeUid, 1005);
      assert.equal(receivedMessage.payloadHash, computeDraftPayloadHash(payload));
      assert.equal(receivedMessage.approver, expectedUser);
    }
  });

  await t.test('7. reaction handler (+1 / thumbsup) triggers approval for allowlisted user', async () => {
    manager.registerDraftPost('post-reaction-1', 'draft-react-1', payload, 'channel-alerts');
    assert.ok(manager.getTrackedDraft('post-reaction-1'));

    // Non-approval emoji: ignored
    const nonApproval = await manager.handleReaction({
      user_id: '9s65in45np8h98qeatgx7anuoa',
      post_id: 'post-reaction-1',
      emoji_name: 'heart',
    });
    assert.equal(nonApproval, null);
    assert.ok(manager.getTrackedDraft('post-reaction-1'), 'still tracked');

    // Reaction by intruder: refused
    const intruderReact = await manager.handleReaction({
      user_id: 'intruder-user-id',
      post_id: 'post-reaction-1',
      emoji_name: '+1',
    });
    assert.ok(intruderReact);
    assert.equal(intruderReact.ok, false);
    assert.equal(intruderReact.error, 'not_in_approvers_allowlist');
    assert.ok(manager.getTrackedDraft('post-reaction-1'), 'still tracked after rejected attempt');

    // Reaction by ik-ruby: refused
    const rubyReact = await manager.handleReaction({
      user_id: 'bot-ik-ruby-id',
      post_id: 'post-reaction-1',
      emoji_name: '+1',
    });
    assert.ok(rubyReact);
    assert.equal(rubyReact.ok, false);
    assert.equal(rubyReact.error, 'bot_cannot_approve');

    // Reaction by allowlisted user Ada (+1)
    receivedMessage = null;
    const adaReact = await manager.handleReaction({
      user_id: 'buay4kf99bbk7cjtbeupd5rxow',
      post_id: 'post-reaction-1',
      emoji_name: '+1',
    });
    assert.ok(adaReact);
    assert.equal(adaReact.ok, true);
    assert.equal(adaReact.approver, 'ada');
    assert.equal(receivedMessage.draftId, 'draft-react-1');
    assert.equal(manager.getTrackedDraft('post-reaction-1'), undefined, 'untracked after successful approval');
    assert.ok(repliedMessages.some((r) => r.rootId === 'post-reaction-1' && r.message.includes('approved by @ada')));

    // Reaction with 'thumbsup' from Onyedikachi
    manager.registerDraftPost('post-reaction-2', 'draft-react-2', payload, 'channel-alerts');
    receivedMessage = null;
    const onyeReact = await manager.handleReaction({
      user_id: 'f3w99k5x6fgomdprh8axosmmsc',
      post_id: 'post-reaction-2',
      emoji_name: 'thumbsup',
    });
    assert.ok(onyeReact);
    assert.equal(onyeReact.ok, true);
    assert.equal(onyeReact.approver, 'onyedikachi');
    assert.equal(receivedMessage.draftId, 'draft-react-2');
  });

  await t.test('8. button action handler routes to socket for authorized approver', async () => {
    manager.registerDraftPost('post-btn-1', 'draft-btn-1', payload);

    // Intruder clicks button
    const intruderBtn = await manager.handleButtonAction({
      user_id: 'intruder-user-id',
      post_id: 'post-btn-1',
    });
    assert.equal(intruderBtn.ok, false);
    assert.equal(intruderBtn.error, 'not_in_approvers_allowlist');

    // Chinedum clicks button
    receivedMessage = null;
    const validBtn = await manager.handleButtonAction({
      user_id: '9s65in45np8h98qeatgx7anuoa',
      post_id: 'post-btn-1',
    });
    assert.equal(validBtn.ok, true);
    assert.equal(validBtn.approver, 'chinedumokerengwor');
    assert.equal(receivedMessage.draftId, 'draft-btn-1');
  });

  await t.test('9. wrong bridge UID returns socket error', async () => {
    const wrongUidManager = new DraftApprovalManager({
      approvers: BOX_APPROVER_IDS,
      socketPath,
      bridgeUid: 9999, // wrong UID
      client: mockClient,
    });
    const res = await wrongUidManager.approveDraft({
      draftId: 'draft-wrong-uid',
      payload,
      clickerUserId: '9s65in45np8h98qeatgx7anuoa',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized_bridge_uid');
  });

  await mockServer.close();
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});
