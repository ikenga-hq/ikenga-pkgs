/**
 * Outbox Draft Announcer for Mattermost Bridge (WP S2b).
 *
 * Responsibilities:
 *   1. Finds drafts that are committed-eligible in `pa_action_drafts` with no live approval.
 *   2. Formats and posts each to a configured Mattermost channel (e.g. #sales-approvals)
 *      with channel, recipient (or summary count for bulk), subject, body preview,
 *      scheduled time, and canonical payload hash.
 *   3. Calls `registerOutboxDraft(postId, draftId, canonicalPayload, channelId)` on the bridge.
 *   4. Integrity rule: Approver text and hash come strictly from the draft row read by
 *      a trusted UID (bridge UID), never from agent-supplied text or messages.
 *   5. Edit after approval: If draft payload hash changes after announcement, edits the
 *      previous post with a superseded warning, updates registered hash, and requires fresh approval.
 *   6. Idempotent: Re-running does not double-post.
 *   7. Rate limits and batches (batchLimit per tick).
 *
 * Runs as the bridge sidecar (`ikenga-bridge`), NOT `ik-ruby`. Holds Mattermost bot token
 * but zero send credentials.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MattermostClient } from './client.js';
import type { DraftApprovalManager } from './outbox-approvals.js';
import { computeDraftPayloadHash, type CanonicalDraftPayload } from './outbox-approvals.js';
import type { AuditLog } from './audit.js';

const execFileAsync = promisify(execFile);

export interface RawDraftRow {
  id: string;
  channel: string;
  status: string;
  payload_json: string;
  edited_json?: string | null;
  scheduled_at?: string | null;
  created_at?: string;
}

export interface AnnounceableDraft {
  id: string;
  channel: string;
  status: string;
  canonicalPayload: CanonicalDraftPayload;
  payloadHash: string;
  recipientSummary: string;
  isBulk: boolean;
  recipientCount: number;
}

export interface DraftReader {
  getEligibleDrafts(): Promise<RawDraftRow[]> | RawDraftRow[];
}

export interface AnnouncementRecord {
  draftId: string;
  postId: string;
  payloadHash: string;
  announcedAt: number;
  channelId: string;
  status: 'announced' | 'superseded' | 'resolved';
}

interface AnnouncementsFile {
  version: 1;
  announcements: Record<string, AnnouncementRecord>;
}

/**
 * Coalesce recipient destination to canonical string and calculate summary.
 */
function resolveRecipients(item: any): { destination: string; summary: string; isBulk: boolean; count: number } {
  if (item.recipients && Array.isArray(item.recipients) && item.recipients.length > 0) {
    const emails = item.recipients
      .map((r: any) => (typeof r === 'string' ? r : r.email)?.trim().toLowerCase() ?? '')
      .filter(Boolean)
      .sort();
    const destination = emails.join(',');
    const count = emails.length;
    const isBulk = count > 3;
    const summary = isBulk
      ? `${count} recipients (${emails.slice(0, 3).join(', ')}...)`
      : destination;
    return { destination, summary, isBulk, count };
  }

  if (item.recipientEmail) {
    const destination = String(item.recipientEmail).trim().toLowerCase();
    return { destination, summary: destination, isBulk: false, count: 1 };
  }

  if (item.channelId) {
    const destination = String(item.channelId).trim();
    return { destination, summary: destination, isBulk: false, count: 1 };
  }

  const destination = (item.recipient ? String(item.recipient) : '').trim();
  return { destination, summary: destination || '(unspecified)', isBulk: false, count: 1 };
}

/**
 * Extract canonical fields from a draft row (including operator edits).
 */
export function extractCanonicalDraftPayload(row: RawDraftRow): {
  canonical: CanonicalDraftPayload;
  recipientSummary: string;
  isBulk: boolean;
  recipientCount: number;
} {
  let raw: any = null;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    raw = {};
  }

  const item = raw && typeof raw === 'object' && 'item' in raw && raw.item
    ? raw.item
    : (raw ?? {});

  let edited: { subject?: string; body?: string } | undefined;
  if (row.edited_json) {
    try {
      edited = JSON.parse(row.edited_json);
    } catch {
      // Malformed edited_json ignored
    }
  }

  const subject = edited?.subject !== undefined ? edited.subject : (item.subject ?? '');
  const body = edited?.body !== undefined ? edited.body : (item.body ?? '');
  const { destination, summary, isBulk, count } = resolveRecipients(item);
  const scheduled_at = row.scheduled_at ?? item.scheduledIso ?? null;

  const canonical: CanonicalDraftPayload = {
    channel: (row.channel ?? item.channel ?? '').trim().toLowerCase(),
    to: destination,
    subject,
    body,
    scheduled_at,
  };

  return {
    canonical,
    recipientSummary: summary,
    isBulk,
    recipientCount: count,
  };
}

/**
 * Format Mattermost post text for an outbox action draft announcement.
 */
export function formatDraftAnnouncement(opts: {
  draftId: string;
  canonical: CanonicalDraftPayload;
  recipientSummary: string;
  payloadHash: string;
  isUpdate?: boolean;
}): string {
  const { draftId, canonical, recipientSummary, payloadHash, isUpdate } = opts;
  const updateBanner = isUpdate
    ? `⚠️ **[SUPERSEDED / EDIT DETECTED]**\n*This draft was modified after being announced. Previous approval has been invalidated.*\n*A fresh approval is required for the updated payload below.*\n\n`
    : '';

  const bodyPreview = canonical.body.length > 500
    ? `${canonical.body.slice(0, 500)}...`
    : canonical.body;

  const scheduledText = canonical.scheduled_at ? `\`${canonical.scheduled_at}\`` : '*Immediate*';

  return `${updateBanner}### 📬 Outbox Action Draft Approval Required${isUpdate ? ' (Updated)' : ''}
**Draft ID:** \`${draftId}\`
**Channel:** \`${canonical.channel}\`
**To:** ${recipientSummary}
**Subject:** ${canonical.subject || '*(No subject)*'}
**Scheduled:** ${scheduledText}

**Preview:**
> ${bodyPreview.replace(/\n/g, '\n> ')}

---
*React with :+1: or :thumbsup: to approve this draft for transmission.*
*Canonical Payload Hash:* \`sha256:${payloadHash}\``;
}

/**
 * Announcement persistence store.
 */
export class AnnouncementStore {
  private data: AnnouncementsFile = { version: 1, announcements: {} };

  constructor(private readonly filePath?: string) {
    if (filePath && existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 && parsed.announcements) {
          this.data = parsed;
        }
      } catch {
        // Fallback to fresh store
      }
    }
  }

  get(draftId: string): AnnouncementRecord | undefined {
    return this.data.announcements[draftId];
  }

  set(record: AnnouncementRecord): void {
    this.data.announcements[record.draftId] = record;
    this.save();
  }

  all(): Record<string, AnnouncementRecord> {
    return this.data.announcements;
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch {
      // Best-effort write
    }
  }
}

/**
 * SQLite reader using /usr/bin/sqlite3 CLI (strictly -readonly).
 */
export class SqliteDraftReader implements DraftReader {
  constructor(private readonly dbPath: string) {}

  async getEligibleDrafts(): Promise<RawDraftRow[]> {
    if (!existsSync(this.dbPath)) {
      return [];
    }

    try {
      const query = `
        SELECT id, channel, status, payload_json, edited_json, scheduled_at, created_at
          FROM pa_action_drafts
         WHERE status IN ('committed', 'awaiting')
         ORDER BY COALESCE(scheduled_at, created_at) ASC
      `;
      const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', this.dbPath, query]);
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      return JSON.parse(trimmed) as RawDraftRow[];
    } catch {
      return [];
    }
  }
}

export interface DraftAnnouncerOptions {
  client: MattermostClient;
  approvalManager: DraftApprovalManager;
  channelId: string;
  draftReader: DraftReader;
  store?: AnnouncementStore;
  batchLimit?: number;
  audit?: AuditLog;
}

export class DraftAnnouncer {
  private readonly store: AnnouncementStore;
  private readonly batchLimit: number;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly opts: DraftAnnouncerOptions) {
    this.store = opts.store ?? new AnnouncementStore();
    this.batchLimit = opts.batchLimit ?? 10;
  }

  /**
   * Run one announcement cycle across eligible drafts.
   */
  async pollOnce(): Promise<{ announced: number; updated: number; skipped: number }> {
    if (this.polling) return { announced: 0, updated: 0, skipped: 0 };
    this.polling = true;

    let announced = 0;
    let updated = 0;
    let skipped = 0;

    try {
      const rows = await this.opts.draftReader.getEligibleDrafts();

      for (const row of rows) {
        const { canonical, recipientSummary } = extractCanonicalDraftPayload(row);
        const payloadHash = computeDraftPayloadHash(canonical);
        const existing = this.store.get(row.id);

        if (!existing) {
          // Check batch limit before creating new post
          if (announced >= this.batchLimit) {
            skipped++;
            continue;
          }

          const message = formatDraftAnnouncement({
            draftId: row.id,
            canonical,
            recipientSummary,
            payloadHash,
            isUpdate: false,
          });

          try {
            const post = await this.opts.client.reply(this.opts.channelId, message);
            const postId = post.id;

            // Register in DraftApprovalManager for reaction routing
            this.opts.approvalManager.registerDraftPost(postId, row.id, canonical, this.opts.channelId);

            this.store.set({
              draftId: row.id,
              postId,
              payloadHash,
              announcedAt: Date.now(),
              channelId: this.opts.channelId,
              status: 'announced',
            });

            if (this.opts.audit) {
              this.opts.audit.record('draft.announced', {
                draft_id: row.id,
                post_id: postId,
                channel_id: this.opts.channelId,
                payload_hash: payloadHash,
              });
            }

            announced++;
          } catch (err) {
            // Post failed; retry on next tick
          }
        } else if (existing.status === 'announced') {
          // Check if payload changed (edit after announcement)
          if (existing.payloadHash !== payloadHash) {
            const updateMessage = formatDraftAnnouncement({
              draftId: row.id,
              canonical,
              recipientSummary,
              payloadHash,
              isUpdate: true,
            });

            try {
              await this.opts.client.updatePost(existing.postId, updateMessage);

              // Update registration in DraftApprovalManager: old hash is invalidated
              this.opts.approvalManager.registerDraftPost(existing.postId, row.id, canonical, this.opts.channelId);

              this.store.set({
                ...existing,
                payloadHash,
                announcedAt: Date.now(),
                status: 'announced',
              });

              if (this.opts.audit) {
                this.opts.audit.record('draft.announcement_updated', {
                  draft_id: row.id,
                  post_id: existing.postId,
                  previous_hash: existing.payloadHash,
                  new_hash: payloadHash,
                });
              }

              updated++;
            } catch {
              // Edit failed; retry next tick
            }
          } else {
            // Unchanged and already announced
            skipped++;
          }
        } else {
          skipped++;
        }
      }
    } finally {
      this.polling = false;
    }

    return { announced, updated, skipped };
  }

  /**
   * Start recurring background poller.
   */
  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.pollOnce().catch(() => {});
    this.timer = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, intervalMs);
    // Unref so process can cleanly exit if no other tasks
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stop background poller.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
