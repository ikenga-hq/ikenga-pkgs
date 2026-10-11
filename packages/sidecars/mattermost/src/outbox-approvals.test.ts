/**
 * Tests for Outbox Draft Approval Handler in Mattermost Bridge.
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

test('outbox draft approval: server-side allowlist check and socket dispatch', async (t) => {
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

  const users: Record<string, { id: string; username: string }> = {
    'mm-chinedum': { id: 'mm-chinedum', username: 'chinedum' },
    'mm-intruder': { id: 'mm-intruder', username: 'intruder' },
  };

  const mockClient = {
    async getUser(id: string) {
      if (users[id]) return users[id];
      throw new Error('user not found');
    },
  } as unknown as MattermostClient;

  const manager = new DraftApprovalManager({
    approvers: ['chinedum'],
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

  await t.test('non-approver is refused server-side without socket call', async () => {
    receivedMessage = null;
    const res = await manager.approveDraft({
      draftId: 'draft-1',
      payload,
      clickerUserId: 'mm-intruder',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_in_approvers_allowlist');
    assert.equal(receivedMessage, null, 'socket must not be touched');
  });

  await t.test('unverifiable user is refused', async () => {
    receivedMessage = null;
    const res = await manager.approveDraft({
      draftId: 'draft-2',
      payload,
      clickerUserId: 'non-existent-user-id',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unverifiable_user');
    assert.equal(receivedMessage, null);
  });

  await t.test('authorized approver succeeds and records exact hash to socket', async () => {
    receivedMessage = null;
    const res = await manager.approveDraft({
      draftId: 'draft-valid',
      payload,
      clickerUserId: 'mm-chinedum',
    });
    assert.equal(res.ok, true);
    assert.equal(res.approver, 'chinedum');
    assert.ok(receivedMessage);
    assert.equal(receivedMessage.draftId, 'draft-valid');
    assert.equal(receivedMessage.bridgeUid, 1005);
    assert.equal(receivedMessage.payloadHash, computeDraftPayloadHash(payload));
    assert.equal(receivedMessage.approver, 'chinedum');
  });

  await t.test('wrong bridge UID returns socket error', async () => {
    const wrongUidManager = new DraftApprovalManager({
      approvers: ['chinedum'],
      socketPath,
      bridgeUid: 9999, // wrong UID
      client: mockClient,
    });
    const res = await wrongUidManager.approveDraft({
      draftId: 'draft-wrong-uid',
      payload,
      clickerUserId: 'mm-chinedum',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized_bridge_uid');
  });

  await mockServer.close();
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});
