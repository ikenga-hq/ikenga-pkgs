import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditLog } from './audit.js';
import { SenderSocketError } from './sender-socket.js';
import type { OutreachEvent, OutreachPause, OutreachStatus, SenderSocket } from './sender-socket.js';
import type { MattermostPost, MattermostReaction, OutreachConfig } from './types.js';

/**
 * The bridge side of the box outreach sender (approvals contract r5 sections 3.8, 3.9 and 4.6 to 4.9).
 *
 * Outreach emails are approved in the Ikenga Outbox by their assignee, never by reaction, so the per-draft card flow
 * skips them (`isOutreachDraft`). What lives in the channel instead is three things, all counts and ids:
 *
 *   a PAUSE card      after the 30th send the sender pauses; one card, a 👍 asks the sender to resume
 *   REPLY cards       one per reply or bounce; a :no_entry_sign: on a reply card asks the sender to opt the lead out
 *   a DAILY post      counts per sender and per status, with the sender's export file attached when the bridge can read it
 *
 * The bridge decides nothing. A reaction is forwarded with the reaction event's own user id (never a username, never
 * anything in the post) and the sender answers `not_chinedum`, `approver_not_assignee`, `stale_pause_id` and the rest.
 * Nothing here ever holds a prospect's address, a reply's text or a subject: the contract's events carry none, and the
 * one reply that does carry an address (`outreach_optout`) is dropped inside `SenderSocket`.
 */

export const OUTREACH_DEFAULT_TIMEZONE = 'Africa/Lagos';
export const OUTREACH_DEFAULT_EXPORT_TIME = '08:00';
/** Events asked for per `outreach_replies` call (the contract allows 1 to 200). */
const REPLY_BATCH = 100;
/** Batches drained in one poll; the rest wait for the next one. */
const MAX_REPLY_BATCHES = 5;
/** Post and card records kept; the oldest go first. A cursor that has moved on never asks for them again. */
const MAX_REMEMBERED = 5000;
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const USER_CACHE_MS = 5 * 60 * 1000;
const MAX_TEXT_FIELD = 80;

// ── config ───────────────────────────────────────────────────────────────────

export interface ResolvedOutreach {
  /** Absolute path of the export file; `{day}` stands for the local day (`YYYY-MM-DD`). */
  exportPath?: string;
  /** Minutes after local midnight at which the day's post is due. */
  exportMinutes: number;
  timezone: string;
  pollMs: number;
}

const OUTREACH_KEYS = new Set(['enabled', 'exportPath', 'exportLocalTime', 'timezone', 'pollMs']);

/**
 * Validate an `outboxApprovals.outreach` block. Throws, naming the bot and the field. Returns `undefined` for a block
 * that is valid but not enabled (`enabled` defaults to false): nothing outreach-related is then constructed at all.
 */
export function resolveOutreach(cfg: unknown, where: string, defaultPollMs: number): ResolvedOutreach | undefined {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${where}: outboxApprovals.outreach must be an object`);
  const c = cfg as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!OUTREACH_KEYS.has(k)) throw new Error(`${where}: outboxApprovals.outreach: unknown field '${k}'; allowed: ${[...OUTREACH_KEYS].join(', ')}`);
  }
  const bad = (field: string, msg: string) => new Error(`${where}: outboxApprovals.outreach.${field} ${msg}`);

  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') throw bad('enabled', 'must be true or false');

  let exportPath: string | undefined;
  if (c.exportPath !== undefined) {
    if (typeof c.exportPath !== 'string' || !path.isAbsolute(c.exportPath) || c.exportPath.includes('\0')) {
      throw bad('exportPath', 'must be an absolute path ({day} stands for the local day, YYYY-MM-DD)');
    }
    exportPath = c.exportPath;
  }

  const time = c.exportLocalTime === undefined ? OUTREACH_DEFAULT_EXPORT_TIME : c.exportLocalTime;
  const m = typeof time === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time) : null;
  if (!m) throw bad('exportLocalTime', 'must be a 24-hour time such as 08:00');

  const timezone = c.timezone === undefined ? OUTREACH_DEFAULT_TIMEZONE : c.timezone;
  if (typeof timezone !== 'string' || !timezone.trim()) throw bad('timezone', 'must be an IANA time zone such as Africa/Lagos');
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw bad('timezone', `'${timezone}' is not a known time zone`);
  }

  let pollMs = defaultPollMs;
  if (c.pollMs !== undefined) {
    const p = c.pollMs;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1000 || p > 3_600_000) throw bad('pollMs', 'must be a whole number of ms from 1000 to 3600000');
    pollMs = p;
  }

  if (c.enabled !== true) return undefined;
  return { ...(exportPath ? { exportPath } : {}), exportMinutes: Number(m[1]) * 60 + Number(m[2]), timezone, pollMs };
}

// ── what is outreach ─────────────────────────────────────────────────────────

/** The sender's approver text puts the hashed fields first, then `**Body:**` and a block quote. */
const BODY_MARKER = '\n\n**Body:**\n';
/** Field labels and values that only an outreach draft carries (contract 3.8; see `renderAnnouncementText`). */
const OUTREACH_TEXT = /\*\*Outreach [a-z ]+:\*\*|ruby\/outreach-email|outreach_email|\*\*Sender address:\*\*\s*outreach:/i;

/**
 * Is this announced draft an outreach email? Outreach drafts are approved by their assignee in the Ikenga Outbox and
 * must never get a per-draft card: 168 cards would flood the channel, and each card would show a prospect's address.
 * Every test fails towards "yes": a missing or oddly typed field counts as outreach. The announcement carries only the
 * id and the rendered text, so those are what is read; `actionId` and `sourceKind` are read too if a sender sends them.
 */
export function isOutreachDraft(d: { draftId?: unknown; renderedText?: unknown; actionId?: unknown; sourceKind?: unknown }): boolean {
  if (typeof d.draftId !== 'string') return true;
  if (d.draftId.trim().toLowerCase().startsWith('outreach')) return true; // `outreach:<key>`, `outreach-fu:<key>`
  for (const extra of [d.actionId, d.sourceKind]) {
    if (extra === undefined) continue;
    if (typeof extra !== 'string' || /outreach/i.test(extra)) return true;
  }
  if (typeof d.renderedText !== 'string') return true;
  // Only the fields above the body are looked at, so a plain reply that merely talks about outreach still gets its card.
  const at = d.renderedText.indexOf(BODY_MARKER);
  return OUTREACH_TEXT.test(at < 0 ? d.renderedText : d.renderedText.slice(0, at));
}

/**
 * A company or assignee name as it may appear on a card: one line, short, no mention that could page the room and
 * nothing shaped like an address. The sender's events carry names only, but they come from imported data.
 */
export function cardField(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const noAddress = oneLine.replace(/\S+@\S+/g, '(address removed)');
  const short = noAddress.length > MAX_TEXT_FIELD ? `${noAddress.slice(0, MAX_TEXT_FIELD)}...` : noAddress;
  return short.replace(/@/g, '@\u200b').replace(/[`[\]<>]/g, ' ');
}

// ── persistence ──────────────────────────────────────────────────────────────

export interface PauseRecord {
  pause_id: number;
  /** The pause card's post: the only post a 👍 can resume from. */
  post_id: string;
  channel_id: string;
  /** The sender has been told which post carries the card (`outreach_pause_ack`). */
  acked: boolean;
}

export interface ReplyCardRecord {
  draft_id: string;
  channel_id: string;
  /** The lead has been marked do-not-contact from this card. */
  done?: boolean;
}

interface OutreachState {
  version: 1;
  pause: PauseRecord | null;
  /** The `outreach_replies` cursor: advanced only after every card of the batch was posted. */
  reply_cursor: number;
  /** `draftId|at|kind` -> the card's post id: a retry after a partial failure finds its card instead of posting another. */
  posted: Record<string, string>;
  /** Reply-card post id -> the lead's first-email draft id. Bounce cards are not here: they offer no opt-out. */
  reply_cards: Record<string, ReplyCardRecord>;
  /** The local day of the last daily post. */
  last_export_day: string | null;
}

function emptyState(): OutreachState {
  return { version: 1, pause: null, reply_cursor: 0, posted: {}, reply_cards: {}, last_export_day: null };
}

/**
 * Outreach state of one bot. Same discipline as `OutboxCardStore`: served from memory, every change rewrites the file
 * atomically (temp file, then rename), mode 0600. It holds ids, a cursor and a day. Never an address or a text.
 */
export class OutreachStore {
  readonly state: OutreachState = emptyState();
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {
    this.load();
  }

  save(): Promise<void> {
    this.prune();
    const body = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.then(() => {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, body, { mode: 0o600 });
        renameSync(tmp, this.filePath);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        console.error(`outreach store: write failed: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }

  private prune(): void {
    for (const map of [this.state.posted, this.state.reply_cards] as Array<Record<string, unknown>>) {
      const keys = Object.keys(map);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete map[k];
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`outreach store: cannot read ${this.filePath}: ${(err as Error).message}`);
    }
    let parsed: Partial<OutreachState>;
    try {
      parsed = JSON.parse(raw) as Partial<OutreachState>;
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      console.error(`outreach store ${this.filePath} was unreadable; moved aside and starting empty`);
      return;
    }
    const p = parsed.pause;
    if (p && Number.isInteger(p.pause_id) && typeof p.post_id === 'string' && p.post_id) {
      this.state.pause = { pause_id: p.pause_id, post_id: p.post_id, channel_id: String(p.channel_id ?? ''), acked: p.acked === true };
    }
    if (Number.isInteger(parsed.reply_cursor) && (parsed.reply_cursor as number) >= 0) this.state.reply_cursor = parsed.reply_cursor as number;
    for (const [k, v] of Object.entries(parsed.posted ?? {})) if (typeof v === 'string') this.state.posted[k] = v;
    for (const [k, v] of Object.entries(parsed.reply_cards ?? {})) {
      if (v && typeof v.draft_id === 'string') this.state.reply_cards[k] = { draft_id: v.draft_id, channel_id: String(v.channel_id ?? ''), ...(v.done ? { done: true } : {}) };
    }
    if (typeof parsed.last_export_day === 'string') this.state.last_export_day = parsed.last_export_day;
  }
}

// ── time ─────────────────────────────────────────────────────────────────────

/** The calendar day (`YYYY-MM-DD`) and minutes since midnight at `ms` in `timeZone`. */
export function localDayParts(ms: number, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

// ── the manager ──────────────────────────────────────────────────────────────

/** The slice of the Mattermost client the manager needs. */
export interface OutreachApi {
  reply(channelId: string, message: string, rootId?: string, props?: Record<string, unknown>, fileIds?: string[]): Promise<MattermostPost>;
  getUser(userId: string): Promise<{ id: string; username: string; is_bot?: boolean }>;
  resolveChannelId(ref: string): Promise<string>;
  uploadFile(channelId: string, filename: string, data: Uint8Array): Promise<string>;
}

export type OutreachSender = Pick<SenderSocket, 'outreachStatus' | 'outreachReplies' | 'outreachResume' | 'outreachPauseAck' | 'outreachOptout'>;

export interface OutreachManagerOptions {
  bot: string;
  client: OutreachApi;
  store: OutreachStore;
  config: ResolvedOutreach;
  /** The channel the cards go to: the outbox channel. */
  channel: string;
  sender: OutreachSender;
  audit: AuditLog;
  redact?: (s: string) => string;
  now?: () => number;
  log?: (msg: string) => void;
}

type Wanted = 'resume' | 'optout';

/** Mattermost emoji names; a skin tone rides after `::`. Exactly two are acted on, each on its own kind of card. */
function wantedOf(emoji: string): Wanted | undefined {
  const name = emoji.split('::', 1)[0];
  if (name === '+1' || name === 'thumbsup') return 'resume';
  if (name === 'no_entry_sign') return 'optout';
  return undefined;
}

/** A sender or transport failure as a short, safe code for a log line. */
function codeOf(err: unknown): string {
  const raw = err instanceof SenderSocketError ? err.code : err instanceof Error ? err.message : 'error';
  return raw.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 60);
}

export class OutreachManager {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly redact: (s: string) => string;
  private readonly users = new Map<string, { user: { id: string; username: string; is_bot?: boolean }; at: number }>();
  /** Reply cards with an opt-out in flight: a second reaction waits for the first, not for a second confirmation. */
  private readonly optingOut = new Set<string>();
  private botUserId?: string;
  private channelId?: string;
  private timer?: NodeJS.Timeout;
  private cycling?: Promise<void>;
  private stopped = false;
  private lastSenderProblem?: string;

  constructor(private readonly opts: OutreachManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}] outreach: ${m}`));
    this.redact = opts.redact ?? ((s) => s);
  }

  setBotUserId(id: string): void {
    this.botUserId = id;
  }

  /** Begin polling the sender. Never waits on the sender or throws: a channel that cannot be resolved yet is retried. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.resolveChannel();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resolves once the poll in flight (if any) is done. */
  async whenIdle(): Promise<void> {
    await this.cycling;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runCycle()
        .catch((err) => this.log(`poll failed: ${this.redact(codeOf(err))}`))
        .finally(() => this.schedule(this.opts.config.pollMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private async resolveChannel(): Promise<string | undefined> {
    if (this.channelId) return this.channelId;
    try {
      return (this.channelId = await this.opts.client.resolveChannelId(this.opts.channel));
    } catch (err) {
      this.log(`channel lookup failed (${this.redact((err as Error).message)}); will retry`);
      return undefined;
    }
  }

  // ── polling ────────────────────────────────────────────────────────────────

  /** One poll: status (pause card, daily post), then replies and bounces. A failure in one step never stops the next. */
  runCycle(): Promise<void> {
    if (this.cycling) return this.cycling;
    const run = this.cycleInner().finally(() => {
      if (this.cycling === run) this.cycling = undefined;
    });
    this.cycling = run;
    return run;
  }

  private async cycleInner(): Promise<void> {
    const { sender } = this.opts;
    let status: OutreachStatus;
    try {
      status = await sender.outreachStatus();
      this.noteSender(undefined);
    } catch (err) {
      this.noteSender(codeOf(err));
      return;
    }
    await this.step('pause card', () => this.syncPause(status));
    if (this.stopped) return;
    await this.step('daily post', () => this.maybePostDaily(status));
    if (this.stopped) return;
    await this.step('reply cards', () => this.syncReplies());
  }

  /** Run one step; whatever it throws is logged by code and goes no further. */
  private async step(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log(`${what} failed (${this.redact(codeOf(err))}); will retry`);
    }
  }

  private noteSender(problem: string | undefined): void {
    if (problem === this.lastSenderProblem) return;
    this.lastSenderProblem = problem;
    this.log(problem ? `sender unavailable (${this.redact(problem)}); will keep trying` : 'sender reachable');
  }

  // ── the pause card ─────────────────────────────────────────────────────────

  private async syncPause(status: OutreachStatus): Promise<void> {
    const { store, audit } = this.opts;
    const st = store.state;
    const pause = status.pause;
    if (!pause) {
      // Resumed (here or in the Outbox): the old card is no longer the current one.
      if (st.pause) {
        st.pause = null;
        await store.save();
      }
      return;
    }
    if (st.pause && st.pause.pause_id !== pause.id) {
      // A later pause: a 👍 on the earlier card must do nothing.
      st.pause = null;
      await store.save();
    }
    if (pause.cardPostId) {
      // The sender knows the card (a restart, or an ack that did get through): rebuild the mapping from it.
      if (!st.pause || st.pause.post_id !== pause.cardPostId || !st.pause.acked) {
        st.pause = { pause_id: pause.id, post_id: pause.cardPostId, channel_id: st.pause?.channel_id ?? '', acked: true };
        await store.save();
      }
      return;
    }
    if (st.pause?.post_id) {
      // Posted, but the sender never recorded it: ask again, and only that. A second card would split the reactions.
      await this.ackPause(st.pause);
      return;
    }
    const channelId = await this.resolveChannel();
    if (!channelId) return;
    const post = await this.opts.client.reply(channelId, this.pauseText(pause, status));
    st.pause = { pause_id: pause.id, post_id: post.id, channel_id: channelId, acked: false };
    await store.save(); // on disk before the ack: a restart must not post it twice
    audit.record('outreach.pause_card_posted', { pause_id: pause.id, post_id: post.id, channel_id: channelId });
    await this.ackPause(st.pause);
  }

  private async ackPause(rec: PauseRecord): Promise<void> {
    try {
      await this.opts.sender.outreachPauseAck(rec.pause_id, rec.post_id);
      rec.acked = true;
      await this.opts.store.save();
    } catch (err) {
      this.log(`ack of pause ${rec.pause_id} failed (${codeOf(err)}); will retry the ack`);
    }
  }

  private pauseText(pause: OutreachPause, status: OutreachStatus): string {
    const tally = status.summary ? ` ${status.summary.replies} replies, ${status.summary.bounces} bounces so far.` : '';
    return `Outreach sending is paused after ${pause.sentCount} sends.${tally} React with :+1: to resume. Only Chinedum can resume.`;
  }

  // ── reply and bounce cards ─────────────────────────────────────────────────

  private async syncReplies(): Promise<void> {
    const { store, sender } = this.opts;
    const st = store.state;
    for (let batch = 0; batch < MAX_REPLY_BATCHES; batch++) {
      const { events, cursor } = await sender.outreachReplies(st.reply_cursor, REPLY_BATCH);
      if (events.length > 0) {
        const channelId = await this.resolveChannel();
        if (!channelId) return;
        for (const ev of events) {
          const key = `${ev.draftId}|${ev.at}|${ev.kind}`;
          if (st.posted[key]) continue; // posted before a failure or a restart
          const post = await this.opts.client.reply(channelId, this.eventText(ev));
          st.posted[key] = post.id;
          if (ev.kind === 'reply') st.reply_cards[post.id] = { draft_id: ev.draftId, channel_id: channelId };
          await store.save();
        }
      }
      // Only now, with every card of the batch posted (a throw above leaves the cursor where it was).
      if (cursor !== st.reply_cursor) {
        st.reply_cursor = cursor;
        await store.save();
      }
      if (events.length < REPLY_BATCH) return;
    }
  }

  private eventText(ev: OutreachEvent): string {
    const company = cardField(ev.company);
    const assignee = cardField(ev.assignee);
    return ev.kind === 'reply'
      ? `Reply from ${company} (assigned to ${assignee}). React with :no_entry_sign: to mark do-not-contact.`
      : `Bounce: ${company} (${assignee})`;
  }

  // ── the daily post ─────────────────────────────────────────────────────────

  private async maybePostDaily(status: OutreachStatus): Promise<void> {
    const { store, config } = this.opts;
    const { day, minutes } = localDayParts(this.now(), config.timezone);
    if (store.state.last_export_day === day || minutes < config.exportMinutes) return;
    const channelId = await this.resolveChannel();
    if (!channelId) return;

    const fileIds: string[] = [];
    if (config.exportPath) {
      const file = config.exportPath.replace(/\{day\}/g, day);
      try {
        const info = statSync(file);
        if (!info.isFile()) throw Object.assign(new Error('not_a_file'), { code: 'not_a_file' });
        if (info.size > MAX_EXPORT_BYTES) throw Object.assign(new Error('too_large'), { code: 'too_large' });
        // The bytes go straight to Mattermost: they are not parsed, logged or kept.
        fileIds.push(await this.opts.client.uploadFile(channelId, path.basename(file), readFileSync(file)));
      } catch (err) {
        this.log(`export file not attached (${codeOf(new Error((err as NodeJS.ErrnoException).code ?? 'unreadable'))})`);
      }
    }
    await this.opts.client.reply(channelId, this.dailyText(status, day), undefined, undefined, fileIds);
    store.state.last_export_day = day;
    await store.save();
  }

  private dailyText(status: OutreachStatus, day: string): string {
    const c = status.counts;
    const lines = [`**Outreach summary for ${day}**`];
    if (status.pause) lines.push(`Sending is paused after ${status.pause.sentCount} sends.`);
    lines.push(`Sent today: Ada ${c.today.ada}, Chinedum ${c.today.chinedum}.`);
    lines.push(`Sent in total: ${c.total}${c.pauseAt ? ` (pause at ${c.pauseAt})` : ''}.`);
    if (status.summary) {
      lines.push(`Replies: ${status.summary.replies}. Bounces: ${status.summary.bounces}.`);
      const states = Object.entries(status.summary.states).filter(([, n]) => n > 0);
      if (states.length) lines.push(`By status: ${states.map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ')}.`);
    }
    return lines.join('\n');
  }

  // ── reactions ──────────────────────────────────────────────────────────────

  /**
   * A `reaction_added` event. Only a 👍 on the current pause card and a :no_entry_sign: on a reply card are acted on,
   * and only when a human made them. Who may resume or opt out is the sender's call; the reactor's id is forwarded as is.
   */
  async handleReaction(r: MattermostReaction): Promise<void> {
    const wanted = wantedOf(r.emoji_name ?? '');
    if (!wanted || typeof r.user_id !== 'string' || !r.user_id) return;
    if (this.botUserId && r.user_id === this.botUserId) return;
    const st = this.opts.store.state;

    if (wanted === 'resume') {
      const rec = st.pause;
      if (!rec || rec.post_id !== r.post_id) return;
      if (!(await this.isHuman(r.user_id))) return;
      await this.resume(rec, r.user_id);
      return;
    }
    const card = st.reply_cards[r.post_id];
    if (!card || card.done || this.optingOut.has(r.post_id)) return;
    // Taken before the first await, so two reactions arriving together make one request and one confirmation.
    this.optingOut.add(r.post_id);
    try {
      if (!(await this.isHuman(r.user_id))) return;
      await this.optOut(r.post_id, card, r.user_id);
    } finally {
      this.optingOut.delete(r.post_id);
    }
  }

  private async resume(rec: PauseRecord, userId: string): Promise<void> {
    const { sender, audit } = this.opts;
    try {
      await sender.outreachResume(rec.pause_id, userId);
    } catch (err) {
      const code = codeOf(err);
      this.log(`resume of pause ${rec.pause_id} refused: ${this.redact(code)}`);
      audit.record('outreach.resume_refused', { pause_id: rec.pause_id, approver_id: userId, reason: code });
      return;
    }
    audit.record('outreach.resumed', { pause_id: rec.pause_id, approver_id: userId });
    this.log(`pause ${rec.pause_id} resumed`);
    await this.say(rec.channel_id, 'Outreach sending resumed.', rec.post_id);
  }

  private async optOut(postId: string, card: ReplyCardRecord, userId: string): Promise<void> {
    const { sender, store, audit } = this.opts;
    try {
      await sender.outreachOptout(card.draft_id, userId);
    } catch (err) {
      const code = codeOf(err);
      this.log(`opt-out refused: ${this.redact(code)}`);
      audit.record('outreach.optout_refused', { draft_id: card.draft_id, approver_id: userId, reason: code });
      return;
    }
    card.done = true;
    await store.save();
    audit.record('outreach.optout', { draft_id: card.draft_id, approver_id: userId });
    await this.say(card.channel_id, 'Marked do-not-contact.', postId);
  }

  /** A short threaded line. The decision is already made, so a failure to say so is only logged. */
  private async say(channelId: string, text: string, rootId: string): Promise<void> {
    try {
      await this.opts.client.reply(channelId || (await this.resolveChannel()) || '', text, rootId);
    } catch (err) {
      this.log(`could not post a confirmation (${this.redact((err as Error).message)})`);
    }
  }

  /** The reactor must be a person: not the bot, not a bot account, not an `ik-*` agent account. Unverifiable counts as no. */
  private async isHuman(userId: string): Promise<boolean> {
    let user = this.users.get(userId);
    if (!user || this.now() - user.at >= USER_CACHE_MS) {
      try {
        const got = await this.opts.client.getUser(userId);
        // The profile must be the one asked for: a reply for someone else is not a verification.
        if (!got || got.id !== userId || typeof got.username !== 'string') return false;
        user = { user: got, at: this.now() };
        this.users.set(userId, user);
      } catch {
        this.log('could not verify a reactor with Mattermost; reaction ignored');
        return false;
      }
    }
    return !(user.user.is_bot || /^ik-/i.test(user.user.username));
  }
}
