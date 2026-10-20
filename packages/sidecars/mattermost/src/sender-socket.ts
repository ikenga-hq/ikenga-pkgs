import net from 'node:net';
import { isPayloadHash } from './draft-hash.js';

/**
 * Client for the sender's approvals socket (approvals contract v1, section 4): newline-delimited JSON, one request
 * line, one reply line, one connection per request. The sender identifies this process by the kernel's SO_PEERCRED
 * uid (the bridge's own uid, nothing in the message), so there is no credential here to leak.
 */

/** A reply that is `{"ok":false}`, or no usable reply at all. `code` is the contract's reply code or a transport code. */
export class SenderSocketError extends Error {
  constructor(
    readonly code: string,
    /** True when the sender answered (a refusal); false when the request may not have reached it. */
    readonly refused: boolean,
  ) {
    super(code);
    this.name = 'SenderSocketError';
  }
}

export interface Announcement {
  draftId: string;
  payloadHash: string;
  renderedText: string;
}

export interface DraftInfo {
  draftId: string;
  status: string;
  payloadHash: string;
}

export interface MattermostApprover {
  kind: 'mattermost';
  id: string;
}

const MAX_REPLY_BYTES = 8 * 1024 * 1024;

export interface SenderSocketOptions {
  socketPath: string;
  /** Give up on a request after this long. Default 10 s. */
  timeoutMs?: number;
}

export class SenderSocket {
  constructor(private readonly opts: SenderSocketOptions) {}

  /** `pull_announcements`: committed drafts not yet announced or approved at their current hash. Malformed items are dropped. */
  async pullAnnouncements(): Promise<Announcement[]> {
    const reply = await this.request({ action: 'pull_announcements' });
    const raw = reply.announcements;
    if (!Array.isArray(raw)) throw new SenderSocketError('malformed_reply', false);
    const out: Announcement[] = [];
    for (const a of raw as Array<Record<string, unknown>>) {
      if (a && typeof a.draftId === 'string' && a.draftId && isPayloadHash(a.payloadHash) && typeof a.renderedText === 'string') {
        out.push({ draftId: a.draftId, payloadHash: a.payloadHash, renderedText: a.renderedText });
      }
    }
    return out;
  }

  /** `ack_announcement`: this draft+hash was posted, do not offer it again. */
  async ackAnnouncement(draftId: string, payloadHash: string, postId: string): Promise<void> {
    await this.request({ action: 'ack_announcement', draftId, payloadHash, postId });
  }

  /** `get_draft`: the sender's current status and canonical hash of one draft. */
  async getDraft(draftId: string): Promise<DraftInfo> {
    const r = await this.request({ action: 'get_draft', draftId });
    if (typeof r.status !== 'string' || !isPayloadHash(r.payloadHash)) throw new SenderSocketError('malformed_reply', false);
    return { draftId, status: r.status, payloadHash: r.payloadHash };
  }

  /** `approve` with source `mattermost`. Resolves on `{"ok":true}`; throws `SenderSocketError(code)` on a refusal. */
  async approve(draftId: string, payloadHash: string, approver: MattermostApprover): Promise<void> {
    await this.request({ action: 'approve', draftId, payloadHash, source: 'mattermost', approver });
  }

  /** One request. Throws `SenderSocketError` for `{"ok":false,"error":...}` (refused) and for transport trouble (not refused). */
  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.opts.socketPath);
      let buffer = '';
      let bytes = 0;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new SenderSocketError('socket_timeout', false))), timeoutMs);
      timer.unref?.();
      client.on('connect', () => client.write(`${JSON.stringify({ v: 1, ...msg })}\n`));
      client.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_REPLY_BYTES) return done(() => reject(new SenderSocketError('reply_too_large', false)));
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        let reply: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(buffer.slice(0, nl));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          reply = parsed as Record<string, unknown>;
        } catch {
          return done(() => reject(new SenderSocketError('malformed_reply', false)));
        }
        if (reply.ok === true) return done(() => resolve(reply));
        const code = typeof reply.error === 'string' && reply.error ? reply.error : 'unknown_error';
        done(() => reject(new SenderSocketError(code, true)));
      });
      client.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code ?? 'error';
        done(() => reject(new SenderSocketError(`socket_unreachable:${code}`, false)));
      });
      // The sender closes without a reply line (for example an unauthorized peer uid: the reply is written, then the
      // connection is dropped, so a reply normally arrives first).
      client.on('close', () => done(() => reject(new SenderSocketError('socket_closed', false))));
    });
  }
}
