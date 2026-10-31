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
  /**
   * Contract 4.3 names exactly three fields; these two are read only if a sender ever adds them, and only to widen the
   * outreach and company-update skip rules (`isOutreachDraft`, `isCompanyUpdateDraft`). Never rendered, never stored.
   */
  actionId?: string;
  sourceKind?: string;
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

/** The pause nobody has resumed (contract 4.6 `P`). `cardPostId` is null until `outreach_pause_ack`. */
export interface OutreachPause {
  id: number;
  at: string;
  sentCount: number;
  threshold: number;
  cardPostId: string | null;
}

/** Counts only (contract 4.6 `C` and `S`). Nothing here names a prospect or an address. */
export interface OutreachStatus {
  pause: OutreachPause | null;
  counts: { lagosDay: string; total: number; cap: number; pauseAt: number; today: { ada: number; chinedum: number } };
  summary?: { replies: number; bounces: number; states: Record<string, number> };
}

/** One reply or bounce event (contract 4.9): exactly these five fields, no text, no subject, no address. */
export interface OutreachEvent {
  draftId: string;
  company: string;
  assignee: string;
  kind: 'reply' | 'bounce';
  at: string;
}

/** One vault audit event (contract 4.10): who, action, group, label, at, names. Never credential values. */
export interface VaultEvent {
  id: number;
  at: string;
  actor: string;
  group: string;
  label: string;
  action: string;
  names: string[];
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

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
        out.push({
          draftId: a.draftId,
          payloadHash: a.payloadHash,
          renderedText: a.renderedText,
          ...(typeof a.actionId === 'string' ? { actionId: a.actionId } : typeof a.action_id === 'string' ? { actionId: a.action_id } : {}),
          ...(typeof a.sourceKind === 'string' ? { sourceKind: a.sourceKind } : {}),
        });
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

  /** `outreach_status` (no draftIds): the open pause, today's counts and the lead-state summary. Counts only. */
  async outreachStatus(): Promise<OutreachStatus> {
    const r = await this.request({ action: 'outreach_status' });
    const o = r.outreach as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object') throw new SenderSocketError('malformed_reply', false);
    let pause: OutreachPause | null = null;
    if (o.pause !== null && o.pause !== undefined) {
      const p = o.pause as Record<string, unknown>;
      if (!p || typeof p !== 'object' || !isCount(p.id) || p.id < 1 || !isCount(p.sentCount)) throw new SenderSocketError('malformed_reply', false);
      pause = {
        id: p.id,
        at: typeof p.at === 'string' ? p.at : '',
        sentCount: p.sentCount,
        threshold: isCount(p.threshold) ? p.threshold : 0,
        cardPostId: typeof p.cardPostId === 'string' && p.cardPostId ? p.cardPostId : null,
      };
    }
    const c = (o.counts ?? {}) as Record<string, unknown>;
    const today = (c.today ?? {}) as Record<string, unknown>;
    const counts = {
      lagosDay: typeof c.lagosDay === 'string' ? c.lagosDay : '',
      total: isCount(c.total) ? c.total : 0,
      cap: isCount(c.cap) ? c.cap : 0,
      pauseAt: isCount(c.pauseAt) ? c.pauseAt : 0,
      today: { ada: isCount(today.ada) ? today.ada : 0, chinedum: isCount(today.chinedum) ? today.chinedum : 0 },
    };
    let summary: OutreachStatus['summary'];
    const s = o.summary as Record<string, unknown> | undefined;
    if (s && typeof s === 'object') {
      const states: Record<string, number> = {};
      for (const [k, v] of Object.entries((s.states ?? {}) as Record<string, unknown>)) if (isCount(v)) states[k] = v;
      summary = { replies: isCount(s.replies) ? s.replies : 0, bounces: isCount(s.bounces) ? s.bounces : 0, states };
    }
    return { pause, counts, ...(summary ? { summary } : {}) };
  }

  /** `outreach_replies`: events after `since`, oldest first, and the cursor to pass next time. Malformed events are dropped. */
  async outreachReplies(since: number, limit: number): Promise<{ events: OutreachEvent[]; cursor: number }> {
    const r = await this.request({ action: 'outreach_replies', since, limit });
    if (!Array.isArray(r.replies) || !isCount(r.cursor)) throw new SenderSocketError('malformed_reply', false);
    const events: OutreachEvent[] = [];
    for (const e of r.replies as Array<Record<string, unknown>>) {
      if (
        e &&
        typeof e.draftId === 'string' && e.draftId &&
        typeof e.company === 'string' &&
        typeof e.assignee === 'string' &&
        (e.kind === 'reply' || e.kind === 'bounce') &&
        typeof e.at === 'string' && e.at
      ) {
        events.push({ draftId: e.draftId, company: e.company, assignee: e.assignee, kind: e.kind, at: e.at });
      }
    }
    return { events, cursor: r.cursor };
  }

  /** `outreach_resume` with source `mattermost`. The approver is the reaction event's user id; the sender decides. */
  async outreachResume(pauseId: number, approverId: string): Promise<void> {
    await this.request({ action: 'outreach_resume', pauseId, source: 'mattermost', approver: { kind: 'mattermost', id: approverId } });
  }

  /** `outreach_pause_ack` (bridge only): the post that carries the pause card, so it is not posted twice. */
  async outreachPauseAck(pauseId: number, postId: string): Promise<void> {
    await this.request({ action: 'outreach_pause_ack', pauseId, postId });
  }

  /**
   * `outreach_optout`. The request names the draft only; the sender takes the address from its own record. The reply
   * carries the address, which this method drops: nothing downstream can log or post it.
   */
  async outreachOptout(draftId: string, approverId: string): Promise<{ added: boolean }> {
    const r = await this.request({ action: 'outreach_optout', draftId, source: 'mattermost', approver: { kind: 'mattermost', id: approverId } });
    return { added: r.added === true };
  }

  /** `vault.events`: credential events after `since`, oldest first, and newest cursor. Malformed events are dropped. */
  async vaultEvents(since: number, limit = 100): Promise<{ events: VaultEvent[]; cursor: number }> {
    const r = await this.request({ action: 'vault.events', since, limit });
    if (!Array.isArray(r.events) || !isCount(r.cursor)) throw new SenderSocketError('malformed_reply', false);
    const events: VaultEvent[] = [];
    for (const e of r.events as Array<Record<string, unknown>>) {
      if (
        e &&
        isCount(e.id) &&
        typeof e.at === 'string' && e.at &&
        typeof e.actor === 'string' &&
        typeof e.group === 'string' &&
        typeof e.label === 'string' &&
        typeof e.action === 'string'
      ) {
        events.push({
          id: e.id,
          at: e.at,
          actor: e.actor,
          group: e.group,
          label: e.label,
          action: e.action,
          names: Array.isArray(e.names) ? e.names.filter((n): n is string => typeof n === 'string') : [],
        });
      }
    }
    return { events, cursor: r.cursor };
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
