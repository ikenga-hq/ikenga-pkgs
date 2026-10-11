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

export interface DraftApprovalManagerOptions {
  approvers: string[];
  socketPath: string;
  bridgeUid: number;
  client: MattermostClient;
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

export class DraftApprovalManager {
  private readonly approverSet: Set<string>;

  constructor(private readonly opts: DraftApprovalManagerOptions) {
    this.approverSet = new Set(
      opts.approvers.map((a) => a.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    );
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
    try {
      const user = await this.opts.client.getUser(req.clickerUserId);
      if (!user || !user.id) {
        return { ok: false, error: 'unverifiable_user' };
      }
      userId = user.id.toLowerCase();
      username = (user.username ?? '').toLowerCase();
    } catch {
      return { ok: false, error: 'unverifiable_user' };
    }

    // Verify clicker against approvers allowlist
    const isAllowed = this.approverSet.has(userId) || this.approverSet.has(username);
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
