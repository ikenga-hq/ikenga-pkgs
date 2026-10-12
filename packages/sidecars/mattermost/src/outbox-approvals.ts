/**
 * Outbox Action Draft Approval Handler for Mattermost Bridge (S2 / D-B13).
 *
 * Checks the clicker's Mattermost user id server-side against an approvers
 * allowlist using the Mattermost API (never trusting client-supplied fields or
 * post text).
 *
 * On valid approval, calculates the exact canonical SHA-256 payload hash and
 * writes the ledger entry to the sender's Unix domain socket as the bridge UID.
 *
 * Never writes through `ik-ruby`'s DB or process.
 */

import net from 'node:net';
import { createHash } from 'node:crypto';
import type { MattermostClient } from './client.js';
import type { AuditLog } from './audit.js';

export interface CanonicalDraftPayload {
  channel: string;
  to: string;
  subject: string;
  body: string;
  scheduled_at: string | null;
}

export interface TrackedDraftPost {
  draftId: string;
  payload: CanonicalDraftPayload;
  channelId?: string;
  postId: string;
  createdAt: number;
}

export interface DraftApprovalManagerOptions {
  approvers: string[];
  socketPath: string;
  bridgeUid: number;
  client: MattermostClient;
  botUserId?: string;
  audit?: AuditLog;
}

export interface ApproveDraftRequest {
  draftId: string;
  payload: CanonicalDraftPayload;
  clickerUserId: string;
}

export interface ApproveDraftResult {
  ok: boolean;
  approver?: string;
  error?: string;
  payloadHash?: string;
}

/**
 * Compute the SHA-256 hex digest of the canonical outbound payload.
 * Canonical sorted JSON keys: body, channel, scheduled_at, subject, to.
 */
export function computeDraftPayloadHash(payload: CanonicalDraftPayload): string {
  const canonical = JSON.stringify({
    body: payload.body,
    channel: payload.channel,
    scheduled_at: payload.scheduled_at,
    subject: payload.subject,
    to: payload.to,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Send the approval record over the Unix domain socket to `ikenga-sender`.
 */
export async function sendApprovalToSenderSocket(opts: {
  socketPath: string;
  bridgeUid: number;
  draftId: string;
  payloadHash: string;
  approver: string;
}): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(opts.socketPath);
    let buffer = '';

    client.on('connect', () => {
      const msg = {
        bridgeUid: opts.bridgeUid,
        action: 'approve',
        draftId: opts.draftId,
        payloadHash: opts.payloadHash,
        approver: opts.approver,
        ts: new Date().toISOString(),
      };
      client.write(JSON.stringify(msg) + '\n');
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) {
        try {
          const resp = JSON.parse(buffer.trim());
          client.end();
          resolve(resp);
        } catch (e) {
          client.end();
          reject(e);
        }
      }
    });

    client.on('error', (err) => {
      reject(err);
    });
  });
}

function isApprovalEmoji(emoji: string): boolean {
  const name = emoji.split('::', 1)[0];
  return name === '+1' || name === 'thumbsup';
}

export class DraftApprovalManager {
  private readonly approverIdSet: Set<string>;
  private readonly trackedDrafts = new Map<string, TrackedDraftPost>();

  constructor(private readonly opts: DraftApprovalManagerOptions) {
    // Matched strictly by user ID only: never by username
    this.approverIdSet = new Set(
      opts.approvers.map((a) => a.trim().toLowerCase()).filter(Boolean),
    );
  }

  setBotUserId(id: string): void {
    this.opts.botUserId = id;
  }

  /**
   * Register a post as representing a pending outbox action draft.
   */
  registerDraftPost(postId: string, draftId: string, payload: CanonicalDraftPayload, channelId?: string): void {
    this.trackedDrafts.set(postId, {
      postId,
      draftId,
      payload,
      channelId,
      createdAt: Date.now(),
    });
  }

  getTrackedDraft(postId: string): TrackedDraftPost | undefined {
    return this.trackedDrafts.get(postId);
  }

  /**
   * Handle a reaction event (+1 / thumbsup) on a potential draft post.
   */
  async handleReaction(reaction: { user_id: string; post_id: string; emoji_name: string }): Promise<ApproveDraftResult | null> {
    if (!isApprovalEmoji(reaction.emoji_name ?? '')) {
      return null;
    }

    const tracked = this.trackedDrafts.get(reaction.post_id);
    if (!tracked) {
      return null;
    }

    const result = await this.approveDraft({
      draftId: tracked.draftId,
      payload: tracked.payload,
      clickerUserId: reaction.user_id,
    });

    if (result.ok) {
      this.trackedDrafts.delete(reaction.post_id);
      if (tracked.channelId) {
        try {
          await this.opts.client.reply(
            tracked.channelId,
            `Draft \`${tracked.draftId}\` approved by @${result.approver} and sent to outbox ledger.`,
            reaction.post_id,
          );
        } catch {
          // Reply error is non-fatal; ledger is already committed
        }
      }
    }

    return result;
  }

  /**
   * Handle an interactive button action for an action draft.
   */
  async handleButtonAction(action: {
    user_id: string;
    post_id?: string;
    context?: unknown;
  }): Promise<ApproveDraftResult> {
    if (!action.post_id) {
      return { ok: false, error: 'missing_post_id' };
    }

    const tracked = this.trackedDrafts.get(action.post_id);
    if (!tracked) {
      return { ok: false, error: 'untracked_or_unannounced_post' };
    }

    const result = await this.approveDraft({
      draftId: tracked.draftId,
      payload: tracked.payload,
      clickerUserId: action.user_id,
    });

    if (result.ok) {
      this.trackedDrafts.delete(action.post_id);
    }

    return result;
  }

  /**
   * Handle an interactive approve action or click on an action draft.
   */
  async approveDraft(req: ApproveDraftRequest): Promise<ApproveDraftResult> {
    if (!req.clickerUserId || typeof req.clickerUserId !== 'string') {
      return { ok: false, error: 'missing_clicker_id' };
    }

    // Server-side identity check via Mattermost API: never trust post text or payload
    let username: string;
    let userId: string;
    let isBot = false;
    try {
      const user = await this.opts.client.getUser(req.clickerUserId);
      if (!user || !user.id) {
        return { ok: false, error: 'unverifiable_user' };
      }
      userId = user.id.toLowerCase();
      username = (user.username ?? '').toLowerCase();
      isBot = Boolean((user as any).is_bot);
    } catch {
      return { ok: false, error: 'unverifiable_user' };
    }

    // Bots (ik-ruby, ik-rex, or any bot account) are NEVER approvers
    if (
      isBot ||
      username === 'ik-ruby' ||
      username === 'ik-rex' ||
      username.startsWith('ik-') ||
      (this.opts.botUserId && userId === this.opts.botUserId.toLowerCase())
    ) {
      if (this.opts.audit) {
        this.opts.audit.record('draft.approval_rejected', {
          draft_id: req.draftId,
          user_id: userId,
          username,
          reason: 'bot_cannot_approve',
        });
      }
      return { ok: false, error: 'bot_cannot_approve' };
    }

    // Match strictly by user ID only: usernames are never matched
    const isAllowed = this.approverIdSet.has(userId);
    if (!isAllowed) {
      if (this.opts.audit) {
        this.opts.audit.record('draft.approval_rejected', {
          draft_id: req.draftId,
          user_id: userId,
          username,
          reason: 'not_in_approvers_allowlist',
        });
      }
      return { ok: false, error: 'not_in_approvers_allowlist' };
    }

    const payloadHash = computeDraftPayloadHash(req.payload);

    // Write to sender's Unix domain socket
    try {
      const socketResp = await sendApprovalToSenderSocket({
        socketPath: this.opts.socketPath,
        bridgeUid: this.opts.bridgeUid,
        draftId: req.draftId,
        payloadHash,
        approver: username || userId,
      });

      if (!socketResp.ok) {
        return { ok: false, error: socketResp.error ?? 'socket_write_failed' };
      }

      if (this.opts.audit) {
        this.opts.audit.record('draft.approved', {
          draft_id: req.draftId,
          approver_id: userId,
          approver_name: username,
          payload_hash: payloadHash,
          channel: req.payload.channel,
        });
      }

      return {
        ok: true,
        approver: username || userId,
        payloadHash,
      };
    } catch (e) {
      return {
        ok: false,
        error: `socket_connect_error: ${(e as Error).message}`,
      };
    }
  }
}
