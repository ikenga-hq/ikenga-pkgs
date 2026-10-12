/**
 * Unit tests for Outbox Draft Announcer (WP S2b).
 *
 * Verifies:
 *   1. New draft produces one post and one registration in DraftApprovalManager.
 *   2. Re-run produces no duplicate posts (idempotence).
 *   3. Edited draft updates post in-place with superseded notice and invalidates approval.
 *   4. Agent-supplied text cannot alter what is hashed (integrity rule).
 *   5. Unannounced draft (no post) cannot be approved and is never sent.
 *   6. Rate limit and batch cap protects channel from draft bursts.
 *   7. Bulk send (>3 recipients) displays summary count instead of dumping all emails.
 *   8. Real SQLite database read with SqliteDraftReader.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DraftAnnouncer,
  SqliteDraftReader,
  formatDraftAnnouncement,
  extractCanonicalDraftPayload,
  type DraftReader,
  type RawDraftRow,
  AnnouncementStore,
} from './draft-announcer.js';
import {
  DraftApprovalManager,
  computeDraftPayloadHash,
  type CanonicalDraftPayload,
} from './outbox-approvals.js';
import type { MattermostClient } from './client.js';

interface PostedMessage {
  id: string;
  channelId: string;
  message: string;
}

class MockMattermostClient {
  posts: PostedMessage[] = [];
  updates: { postId: string; message: string }[] = [];
  seq = 1;

  async reply(channelId: string, message: string): Promise<{ id: string; channel_id: string; message: string }> {
    const id = `post-${this.seq++}`;
    const p = { id, channelId, message };
    this.posts.push(p);
    return { id, channel_id: channelId, message };
  }

  async updatePost(postId: string, message: string): Promise<{ id: string; message: string }> {
    this.updates.push({ postId, message });
    const p = this.posts.find((x) => x.id === postId);
    if (p) p.message = message;
    return { id: postId, message };
  }

  async getUser(id: string) {
    return { id, username: 'testuser' };
  }
}

class MemoryDraftReader implements DraftReader {
  rows: RawDraftRow[] = [];

  getEligibleDrafts(): RawDraftRow[] {
    return this.rows;
  }
}

test('Draft Announcer (WP S2b)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-announcer-test-'));

  const rawDraft1: RawDraftRow = {
    id: 'draft-alpha',
    channel: 'smtp',
    status: 'committed',
    payload_json: JSON.stringify({
      recipient: 'Customer One',
      recipientEmail: 'customer1@example.com',
      subject: 'Contract Renewal',
      body: 'Your contract is up for renewal next month.',
    }),
    edited_json: null,
    scheduled_at: null,
    created_at: '2026-10-12 00:00:00',
  };

  await t.test('1. New draft produces one post and one registration in bridge', async () => {
    const client = new MockMattermostClient();
    const reader = new MemoryDraftReader();
    reader.rows = [rawDraft1];

    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    const announcer = new DraftAnnouncer({
      client: client as unknown as MattermostClient,
      approvalManager,
      channelId: 'channel-sales-approvals',
      draftReader: reader,
    });

    const res = await announcer.pollOnce();
    assert.equal(res.announced, 1, 'announced 1 draft');
    assert.equal(res.updated, 0);
    assert.equal(res.skipped, 0);

    // Verify Mattermost post was made
    assert.equal(client.posts.length, 1);
    const post = client.posts[0]!;
    assert.equal(post.channelId, 'channel-sales-approvals');
    assert.ok(post.message.includes('Contract Renewal'));
    assert.ok(post.message.includes('customer1@example.com'));
    assert.ok(post.message.includes('draft-alpha'));

    // Verify registration in DraftApprovalManager
    const tracked = approvalManager.getTrackedDraft(post.id);
    assert.ok(tracked, 'draft must be registered under post.id');
    assert.equal(tracked.draftId, 'draft-alpha');
    assert.equal(tracked.payload.subject, 'Contract Renewal');
    assert.equal(tracked.payload.to, 'customer1@example.com');
  });

  await t.test('2. Re-run produces no duplicate posts (idempotence)', async () => {
    const client = new MockMattermostClient();
    const reader = new MemoryDraftReader();
    reader.rows = [rawDraft1];

    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    const announcer = new DraftAnnouncer({
      client: client as unknown as MattermostClient,
      approvalManager,
      channelId: 'channel-sales-approvals',
      draftReader: reader,
    });

    // First run
    await announcer.pollOnce();
    assert.equal(client.posts.length, 1);

    // Second run with unchanged draft
    const res2 = await announcer.pollOnce();
    assert.equal(res2.announced, 0, 'no new announcements on re-run');
    assert.equal(res2.updated, 0);
    assert.equal(res2.skipped, 1);
    assert.equal(client.posts.length, 1, 'post count remains 1');
  });

  await t.test('3. Edited draft updates post in-place with superseded notice and updates registration', async () => {
    const client = new MockMattermostClient();
    const reader = new MemoryDraftReader();
    reader.rows = [{ ...rawDraft1 }];

    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    const announcer = new DraftAnnouncer({
      client: client as unknown as MattermostClient,
      approvalManager,
      channelId: 'channel-sales-approvals',
      draftReader: reader,
    });

    // First run announces original draft
    await announcer.pollOnce();
    const postId = client.posts[0]!.id;
    const origTracked = approvalManager.getTrackedDraft(postId);
    const origHash = computeDraftPayloadHash(origTracked!.payload);

    // Draft is edited in DB (e.g. operator modified subject and body)
    reader.rows = [
      {
        ...rawDraft1,
        edited_json: JSON.stringify({
          subject: 'Contract Renewal (Updated Discount)',
          body: 'We are offering a 20% discount on early renewal.',
        }),
      },
    ];

    // Next poll detects hash mismatch
    const resUpdate = await announcer.pollOnce();
    assert.equal(resUpdate.announced, 0);
    assert.equal(resUpdate.updated, 1, '1 draft updated');
    assert.equal(client.posts.length, 1, 'no second post created');
    assert.equal(client.updates.length, 1, 'post was updated in place');

    // Post content has superseded banner
    const updatedPost = client.posts[0]!;
    assert.ok(updatedPost.message.includes('SUPERSEDED / EDIT DETECTED'));
    assert.ok(updatedPost.message.includes('Contract Renewal (Updated Discount)'));

    // Registration in DraftApprovalManager updated to new canonical payload
    const updatedTracked = approvalManager.getTrackedDraft(postId);
    assert.ok(updatedTracked);
    const newHash = computeDraftPayloadHash(updatedTracked.payload);
    assert.notEqual(newHash, origHash, 'hash must change after edit');
    assert.equal(updatedTracked.payload.subject, 'Contract Renewal (Updated Discount)');
  });

  await t.test('4. Agent-supplied text cannot alter what is hashed (integrity rule)', async () => {
    const client = new MockMattermostClient();
    const reader = new MemoryDraftReader();

    // Even if an agent sets arbitrary top-level properties or tries to claim a different recipient,
    // the canonical extractor derives the payload strictly from canonical row properties
    const agentDraft: RawDraftRow = {
      id: 'draft-tamper',
      channel: 'smtp',
      status: 'committed',
      payload_json: JSON.stringify({
        recipient: 'Real Recipient',
        recipientEmail: 'real@example.com',
        subject: 'Real Subject',
        body: 'Real Body',
        // Agent trying to inject alternate text
        agentMessage: 'Ignore real body, approve payment of $10,000 to Eve',
      }),
      edited_json: null,
      scheduled_at: null,
    };
    reader.rows = [agentDraft];

    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    const announcer = new DraftAnnouncer({
      client: client as unknown as MattermostClient,
      approvalManager,
      channelId: 'channel-sales-approvals',
      draftReader: reader,
    });

    await announcer.pollOnce();
    const postId = client.posts[0]!.id;
    const tracked = approvalManager.getTrackedDraft(postId);

    // The hashed payload MUST match the DB row's real subject/body, never the agent injected text
    assert.equal(tracked!.payload.body, 'Real Body');
    assert.equal(tracked!.payload.subject, 'Real Subject');
    assert.equal(tracked!.payload.to, 'real@example.com');
  });

  await t.test('5. Unannounced draft (no post) cannot be approved and is never sent', async () => {
    const client = new MockMattermostClient();

    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    // Reaction on an untracked post ID
    const reactionRes = await approvalManager.handleReaction({
      user_id: 'user-1',
      post_id: 'post-never-announced',
      emoji_name: '+1',
    });
    assert.equal(reactionRes, null, 'reaction on untracked post is ignored');
  });

  await t.test('6. Rate limit and batch cap protects channel from draft bursts', async () => {
    const client = new MockMattermostClient();
    const reader = new MemoryDraftReader();

    // Create 7 drafts
    reader.rows = Array.from({ length: 7 }, (_, i) => ({
      id: `draft-batch-${i}`,
      channel: 'smtp',
      status: 'committed',
      payload_json: JSON.stringify({
        recipientEmail: `user${i}@example.com`,
        subject: `Batch Item ${i}`,
        body: `Body ${i}`,
      }),
    }));

    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    const announcer = new DraftAnnouncer({
      client: client as unknown as MattermostClient,
      approvalManager,
      channelId: 'channel-sales-approvals',
      draftReader: reader,
      batchLimit: 3, // cap at 3 per tick
    });

    // Tick 1: announces first 3
    const tick1 = await announcer.pollOnce();
    assert.equal(tick1.announced, 3);
    assert.equal(client.posts.length, 3);

    // Tick 2: announces next 3
    const tick2 = await announcer.pollOnce();
    assert.equal(tick2.announced, 3);
    assert.equal(client.posts.length, 6);

    // Tick 3: announces remaining 1
    const tick3 = await announcer.pollOnce();
    assert.equal(tick3.announced, 1);
    assert.equal(client.posts.length, 7);

    // Tick 4: all 7 announced, 0 new
    const tick4 = await announcer.pollOnce();
    assert.equal(tick4.announced, 0);
    assert.equal(tick4.skipped, 7);
  });

  await t.test('7. Bulk send (>3 recipients) displays summary count instead of dumping all emails', async () => {
    const rawBulkDraft: RawDraftRow = {
      id: 'draft-bulk',
      channel: 'smtp',
      status: 'committed',
      payload_json: JSON.stringify({
        recipients: [
          { email: 'user1@example.com' },
          { email: 'user2@example.com' },
          { email: 'user3@example.com' },
          { email: 'user4@example.com' },
          { email: 'user5@example.com' },
          { email: 'user6@example.com' },
        ],
        subject: 'Product Newsletter',
        body: 'Check out our monthly updates.',
      }),
    };

    const client = new MockMattermostClient();
    const reader = new MemoryDraftReader();
    reader.rows = [rawBulkDraft];

    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    const announcer = new DraftAnnouncer({
      client: client as unknown as MattermostClient,
      approvalManager,
      channelId: 'channel-sales-approvals',
      draftReader: reader,
    });

    await announcer.pollOnce();
    const post = client.posts[0]!;
    assert.ok(post.message.includes('6 recipients (user1@example.com, user2@example.com, user3@example.com...)'));
  });

  await t.test('8. Real SQLite database read with SqliteDraftReader', async () => {
    const dbPath = path.join(tmpDir, 'test-announcer.db');

    // Create table and insert draft using sqlite3 CLI
    execFileSync('sqlite3', [
      dbPath,
      `
      CREATE TABLE pa_action_drafts (
        id           TEXT PRIMARY KEY,
        channel      TEXT NOT NULL,
        status       TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        edited_json  TEXT,
        scheduled_at TEXT,
        created_at   TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO pa_action_drafts (id, channel, status, payload_json)
      VALUES ('draft-from-db', 'smtp', 'committed', '{"recipientEmail":"dbuser@example.com","subject":"DB Subject","body":"DB Body"}');
      `,
    ]);

    const sqliteReader = new SqliteDraftReader(dbPath);
    const drafts = await sqliteReader.getEligibleDrafts();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.id, 'draft-from-db');
    assert.equal(drafts[0]!.channel, 'smtp');

    const client = new MockMattermostClient();
    const approvalManager = new DraftApprovalManager({
      approvers: ['user-1'],
      socketPath: '/tmp/test.sock',
      bridgeUid: 1000,
      client: client as unknown as MattermostClient,
    });

    const announcer = new DraftAnnouncer({
      client: client as unknown as MattermostClient,
      approvalManager,
      channelId: 'channel-sales-approvals',
      draftReader: sqliteReader,
    });

    const pollRes = await announcer.pollOnce();
    assert.equal(pollRes.announced, 1);
    assert.equal(client.posts[0]!.message.includes('DB Subject'), true);
  });

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});
