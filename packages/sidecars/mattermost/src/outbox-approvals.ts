import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AuditUnavailableError } from './audit.js';
import type { AuditLog } from './audit.js';
import { ChannelLookupError } from './client.js';
import { SenderSocketError } from './sender-socket.js';
import type { SenderSocket } from './sender-socket.js';
import type { MattermostPost, MattermostReaction, OutboxApprovalsConfig } from './types.js';

/**
 * Outbox approvals: Mattermost cards for the sender's drafts, and the approvers' decisions on them.
 *
 * The sender (royalti-co `scripts/cron`, run as `ikenga-sender`) owns the drafts and the approvals ledger and publishes
 * them over a Unix socket; the wire format and every reply code are in its `docs/approvals-contract.md` (contract v1,
 * pinned in `draft-hash.ts`). This module is the Mattermost side of that contract:
 *
 *   pull_announcements -> one card per (draft, hash) in the configured channel -> ack_announcement
 *   an approver's 👍 / Approve button -> get_draft (is this still what the card showed?) -> approve (source mattermost)
 *   an approver's 👎 / Reject button  -> the card is marked rejected; the draft stays in the Ikenga Outbox
 *
 * Every rule fails closed. The approver is named by Mattermost USER ID in config and checked by id, then looked up
 * with `GET /users/{id}` (the event's username is never read); the bot itself, bot accounts and `ik-*` accounts are
 * refused. What gets approved is always the draft id and hash the bridge stored when it posted the card, never anything
 * a client sent. The sender repeats the checks that matter (uid, allowlist, owner, hash at send time): this is the
 * first wall, not the only one.
 */

export const DEFAULT_SOCKET_PATH = '/run/ikenga-sender/approvals.sock';
export const DEFAULT_POLL_MS = 30_000;
export const DEFAULT_BODY_MAX_CHARS = 1500;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Mattermost caps a post at 16383 characters. */
const POST_MAX_CHARS = 15_000;
/** The body is squeezed to this before a card is given up as too long to approve. */
const MIN_BODY_CHARS = 200;
/** How much of an unapprovable draft's text its closed card previews. */
const UNFIT_PREVIEW_CHARS = 3000;
/** Cards announced per poll; the rest wait for the next one. */
const MAX_CARDS_PER_CYCLE = 20;
/** Finished cards are forgotten after this long. Pending cards are kept until decided. */
const RETAIN_FINISHED_MS = 30 * 24 * 60 * 60 * 1000;
const USER_CACHE_MS = 5 * 60 * 1000;
const MAX_BUTTON_BODY_BYTES = 16 * 1024;

const looksLikeUserId = (s: string) => /^[a-z0-9]{26}$/.test(s);

// ── config ───────────────────────────────────────────────────────────────────

export interface ResolvedOutboxApprovals {
  channel: string;
  approvers: string[];
  socketPath: string;
  pollMs: number;
  bodyMaxChars: number;
  requestTimeoutMs: number;
  outboxUrl?: string;
  buttons?: { callbackUrl: string; listenHost: string; listenPort: number; secret: string };
}

const OUTBOX_KEYS = new Set(['channel', 'approvers', 'socketPath', 'pollMs', 'bodyMaxChars', 'requestTimeoutMs', 'outboxUrl', 'buttons']);
const BUTTON_KEYS = new Set(['callbackUrl', 'listenHost', 'listenPort', 'secret']);

function httpUrl(v: unknown, what: string): URL {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    throw new Error(`${what} must be an http(s) URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${what} must be an http(s) URL`);
  return u;
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${what} must be a whole number from ${min} to ${max}`);
  return v;
}

/** Validate and default a bot's `outboxApprovals` block (secrets already resolved). Throws, naming the bot. */
export function resolveOutboxApprovals(cfg: OutboxApprovalsConfig, where: string): ResolvedOutboxApprovals {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${where}: outboxApprovals must be an object`);
  const c = cfg as unknown as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!OUTBOX_KEYS.has(k)) throw new Error(`${where}: outboxApprovals: unknown field '${k}'; allowed: ${[...OUTBOX_KEYS].join(', ')}`);
  }
  const at = (field: string, fn: () => unknown) => {
    try {
      return fn();
    } catch (err) {
      throw new Error(`${where}: outboxApprovals.${field}: ${(err as Error).message}`);
    }
  };

  const channel = typeof c.channel === 'string' ? c.channel.replace(/^#/, '').trim() : '';
  if (!channel) throw new Error(`${where}: outboxApprovals.channel is required (a channel name or id)`);

  if (!Array.isArray(c.approvers)) throw new Error(`${where}: outboxApprovals.approvers must be a list of Mattermost user ids`);
  const approvers: string[] = [];
  for (const a of c.approvers) {
    const id = typeof a === 'string' ? a.trim() : '';
    if (!looksLikeUserId(id)) {
      throw new Error(`${where}: outboxApprovals.approvers entries must be Mattermost user ids (26 lowercase letters and digits); usernames are never matched`);
    }
    if (!approvers.includes(id)) approvers.push(id);
  }
  if (approvers.length === 0) throw new Error(`${where}: outboxApprovals.approvers must name at least one approver (deny by default)`);

  const socketPath = c.socketPath === undefined ? DEFAULT_SOCKET_PATH : c.socketPath;
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error(`${where}: outboxApprovals.socketPath must be an absolute path`);

  const out: ResolvedOutboxApprovals = {
    channel,
    approvers,
    socketPath,
    pollMs: c.pollMs === undefined ? DEFAULT_POLL_MS : (at('pollMs', () => intIn(c.pollMs, 1000, 3_600_000, 'pollMs (ms)')) as number),
    bodyMaxChars: c.bodyMaxChars === undefined ? DEFAULT_BODY_MAX_CHARS : (at('bodyMaxChars', () => intIn(c.bodyMaxChars, 200, 8000, 'bodyMaxChars')) as number),
    requestTimeoutMs:
      c.requestTimeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : (at('requestTimeoutMs', () => intIn(c.requestTimeoutMs, 500, 120_000, 'requestTimeoutMs (ms)')) as number),
  };
  if (c.outboxUrl !== undefined) out.outboxUrl = at('outboxUrl', () => httpUrl(c.outboxUrl, 'outboxUrl').toString()) as string;

  if (c.buttons !== undefined) {
    const b = c.buttons as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(`${where}: outboxApprovals.buttons must be an object`);
    for (const k of Object.keys(b)) {
      if (!BUTTON_KEYS.has(k)) throw new Error(`${where}: outboxApprovals.buttons: unknown field '${k}'; allowed: ${[...BUTTON_KEYS].join(', ')}`);
    }
    const callbackUrl = at('buttons.callbackUrl', () => httpUrl(b.callbackUrl, 'callbackUrl')) as URL;
    const listenPort = at('buttons.listenPort', () => intIn(b.listenPort, 1, 65535, 'listenPort')) as number;
    const listenHost = b.listenHost === undefined ? '127.0.0.1' : b.listenHost;
    if (typeof listenHost !== 'string' || !listenHost.trim()) throw new Error(`${where}: outboxApprovals.buttons.listenHost must be a host or address`);
    if (typeof b.secret !== 'string' || b.secret.length < 12) {
      throw new Error(`${where}: outboxApprovals.buttons.secret is required and must be at least 12 characters, 32 random ones recommended (it authenticates Mattermost's button callbacks)`);
    }
    out.buttons = { callbackUrl: callbackUrl.toString(), listenHost: listenHost.trim(), listenPort, secret: b.secret };
  }
  return out;
}

// ── card text ────────────────────────────────────────────────────────────────

/** `@channel` / `@all` / `@here` in customer text must not page the room. */
function defang(text: string): string {
  return text.replace(/@(channel|all|here)\b/gi, '@​$1');
}

/** The length of the longest run of backticks in `text` (0 when there are none). */
export function longestBacktickRun(text: string): number {
  let best = 0;
  for (const m of text.matchAll(/`+/g)) best = Math.max(best, m[0].length);
  return best;
}

/**
 * The sender's approver text (`renderedText`) shows every field the hash covers and block-quotes the body. Only the body
 * is shortened: every field above it (and after it) stays whole, because the approval binds all of them. Text with no
 * `**Body:**` marker cannot be told apart from its fields, so it is never cut here; if it does not fit on a card the
 * card is not approvable (see `OutboxApprovals.fits`).
 */
export function shortenRenderedText(text: string, bodyMaxChars: number): string {
  const marker = '\n\n**Body:**\n';
  const at = text.indexOf(marker);
  let out: string;
  if (at < 0) {
    out = text;
  } else {
    const head = text.slice(0, at + marker.length);
    const rest = text.slice(at + marker.length).split('\n');
    const body: string[] = [];
    let i = 0;
    while (i < rest.length && (rest[i] as string).startsWith('> ')) body.push(rest[i++] as string);
    const tail = rest.slice(i).join('\n');
    const bodyText = body.join('\n');
    let shown = bodyText;
    if (bodyText.length > bodyMaxChars) {
      shown = `${bodyText.slice(0, bodyMaxChars)}\n> ... (truncated: ${bodyText.length - bodyMaxChars} more characters; the full text is in the Ikenga Outbox)`;
    }
    out = `${head}${shown}${tail ? `\n${tail}` : ''}`;
  }
  return defang(out);
}

// ── persistence ──────────────────────────────────────────────────────────────

export type CardState = 'pending' | 'approved' | 'rejected' | 'superseded' | 'closed';

export interface CardRecord {
  /** The card's Mattermost post: the key a reaction or button is matched on. */
  post_id: string;
  channel_id: string;
  bot: string;
  draft_id: string;
  /** The hash the sender announced for the text on the card: the only hash this card can ever approve. */
  payload_hash: string;
  state: CardState;
  /** The sender-rendered text as shown on the card (body already shortened). */
  shown: string;
  /** Last refusal or problem, shown on the card. */
  note?: string;
  /**
   * Mattermost's `edit_at` for the card as the bridge last wrote it (0 for a post never edited). A pending card whose
   * `edit_at` differs now was edited by someone else, so what the approver saw may not be what the hash covers.
   */
  edit_at?: number;
  /**
   * The message text the bridge last actually got onto the post (set when the card is posted and when an edit succeeds).
   * `cardText` can drift ahead of it in memory when an edit fails (a note set during a Mattermost outage), so the
   * integrity check compares the live post with this, not with a re-render. Absent on records saved before it existed.
   */
  written?: string;
  /** The fields the hash covers did not fit on a card, so it was posted closed: it can only be approved in the Outbox. */
  unapprovable?: boolean;
  created_at: number;
  /** Reactions made before this time were already looked at. */
  seen_until: number;
  /** The sender has been told this card exists. */
  acked: boolean;
  decided_at?: number;
  decided_by_id?: string;
  decided_by_name?: string;
}

interface CardFile {
  version: 1;
  cards: Record<string, CardRecord>;
}

/**
 * Cards of one bot. Same discipline as `ApprovalStore`: served from memory, every change rewrites the file atomically
 * (temp file, then rename), mode 0600. The file holds the card text, which is customer email content.
 */
export class OutboxCardStore {
  private readonly items = new Map<string, CardRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly bot: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get(postId: string): CardRecord | undefined {
    return this.items.get(postId);
  }

  all(): CardRecord[] {
    return [...this.items.values()];
  }

  byDraftHash(draftId: string, hash: string): CardRecord | undefined {
    return this.all().find((c) => c.draft_id === draftId && c.payload_hash === hash);
  }

  forDraft(draftId: string): CardRecord[] {
    return this.all().filter((c) => c.draft_id === draftId);
  }

  put(rec: CardRecord): Promise<void> {
    this.items.set(rec.post_id, rec);
    return this.flush();
  }

  flushed(): Promise<void> {
    return this.writing;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`outbox approvals store: cannot read ${this.filePath}: ${(err as Error).message}`);
    }
    let parsed: CardFile;
    try {
      parsed = JSON.parse(raw) as CardFile;
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      console.error(`outbox approvals store ${this.filePath} was unreadable; moved aside and starting empty`);
      return;
    }
    const cutoff = this.now() - RETAIN_FINISHED_MS;
    for (const rec of Object.values(parsed.cards ?? {})) {
      if (!rec || !rec.post_id || !rec.draft_id || !rec.payload_hash || rec.bot !== this.bot) continue;
      if (rec.state !== 'pending' && (rec.decided_at ?? rec.created_at) < cutoff) continue;
      this.items.set(rec.post_id, rec);
    }
  }

  private flush(): Promise<void> {
    const snapshot: CardFile = { version: 1, cards: Object.fromEntries(this.items) };
    const body = JSON.stringify(snapshot, null, 2);
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
        console.error(`outbox approvals store: write failed: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }
}

// ── the manager ──────────────────────────────────────────────────────────────

/** The slice of the Mattermost client the manager needs. */
export interface OutboxApi {
  reply(channelId: string, message: string, rootId?: string, props?: Record<string, unknown>): Promise<MattermostPost>;
  updatePost(postId: string, message: string, props?: Record<string, unknown>): Promise<MattermostPost>;
  getPost(postId: string): Promise<MattermostPost>;
  getReactions(postId: string): Promise<MattermostReaction[]>;
  getUser(userId: string): Promise<{ id: string; username: string; is_bot?: boolean }>;
  resolveChannelId(ref: string): Promise<string>;
}

export type SenderApi = Pick<SenderSocket, 'pullAnnouncements' | 'ackAnnouncement' | 'getDraft' | 'approve'>;

export interface OutboxManagerOptions {
  bot: string;
  client: OutboxApi;
  store: OutboxCardStore;
  config: ResolvedOutboxApprovals;
  sender: SenderApi;
  audit: AuditLog;
  /** Applied to every text that leaves the bridge (secrets). */
  redact?: (s: string) => string;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Outcome {
  kind: 'approved' | 'rejected' | 'refused' | 'ignored';
  /** A short machine code for refused / ignored. */
  reason?: string;
  /** What the clicker is told (the button's ephemeral reply). */
  text: string;
}

type Verdict = 'approve' | 'reject';

/** Mattermost emoji names for 👍 / 👎; a skin tone rides after `::`. */
function verdictOf(emoji: string): Verdict | undefined {
  const name = emoji.split('::', 1)[0];
  if (name === '+1' || name === 'thumbsup') return 'approve';
  if (name === '-1' || name === 'thumbsdown') return 'reject';
  return undefined;
}

/** Sender replies that end a card (the draft is gone or its approval is already used); anything else leaves it open. */
const isTerminalRefusal = (code: string) =>
  code === 'draft_not_found' || code === 'draft_not_approvable' || code.startsWith('ledger_error');

const REFUSAL_HELP: Record<string, string> = {
  unauthorized_approver: 'the sender does not list this user as an approver',
  approver_is_owner: 'the approver is the account that wrote the draft',
  source_uid_mismatch: 'the bridge is not running as the user the sender expects',
  unauthorized_peer_uid: 'the bridge is not running as the user the sender expects',
  draft_not_found: 'the sender has no such draft',
  draft_not_approvable: 'the draft is no longer awaiting approval (rejected, failed, sending or sent)',
  ruby_db_unavailable: 'the sender cannot read the drafts database',
  draft_unreadable: 'the sender could not read or hash the draft',
};

export class OutboxApprovals {
  private readonly approvers: Set<string>;
  private readonly users = new Map<string, { user: { id: string; username: string; is_bot?: boolean }; at: number }>();
  /** Decisions on one card run one after another: the second sees what the first did. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly redact: (s: string) => string;
  private botUserId?: string;
  private channelId?: string;
  private timer?: NodeJS.Timeout;
  private cycling?: Promise<void>;
  private stopped = false;
  private server?: http.Server;
  private lastSenderProblem?: string;

  constructor(private readonly opts: OutboxManagerOptions) {
    this.approvers = new Set(opts.config.approvers);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}] outbox: ${m}`));
    this.redact = opts.redact ?? ((s) => s);
  }

  setBotUserId(id: string): void {
    this.botUserId = id;
  }

  pendingCount(): number {
    return this.opts.store.all().filter((c) => c.state === 'pending').length;
  }

  /** The port the button callback listener is bound to (tests), once started. */
  buttonsPort(): number | undefined {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : undefined;
  }

  /**
   * Resolve the channel (a channel Mattermost does not know refuses the start), start the button listener, replay
   * decisions made while the bridge was down, and begin polling the sender. Never waits on the sender.
   */
  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.channelId = await this.opts.client.resolveChannelId(this.opts.config.channel);
    } catch (err) {
      if (err instanceof ChannelLookupError && err.notFound) {
        throw new Error(`bot '${this.opts.bot}': outboxApprovals.channel: ${err.message}`);
      }
      this.log(`channel lookup failed (${(err as Error).message}); will retry`);
    }
    if (this.opts.config.buttons) await this.listen();
    await this.recover().catch((err) => this.log(`recovery failed: ${(err as Error).message}`));
    if (this.stopped) return;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = undefined;
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
        .catch((err) => this.log(`poll failed: ${(err as Error).message}`))
        .finally(() => this.schedule(this.opts.config.pollMs));
    }, delayMs);
    this.timer.unref?.();
  }

  // ── announcing ─────────────────────────────────────────────────────────────

  /** One poll: pull announcements, post a card per new (draft, hash), supersede the older cards of an edited draft, ack. */
  runCycle(): Promise<void> {
    if (this.cycling) return this.cycling;
    const run = this.cycleInner().finally(() => {
      if (this.cycling === run) this.cycling = undefined;
    });
    this.cycling = run;
    return run;
  }

  private async cycleInner(): Promise<void> {
    const { store, sender } = this.opts;
    let items;
    try {
      items = await sender.pullAnnouncements();
      this.noteSender(undefined);
    } catch (err) {
      this.noteSender(err instanceof SenderSocketError ? err.code : (err as Error).message);
      return;
    }
    let posted = 0;
    for (const item of items) {
      if (this.stopped) return;
      const existing = store.byDraftHash(item.draftId, item.payloadHash);
      if (existing) {
        // Posted already (the ack was lost, or the sender forgot it): one card per draft+hash, just tell it again.
        if (!existing.acked) await this.ack(existing);
        continue;
      }
      if (posted >= MAX_CARDS_PER_CYCLE) break;
      const channelId = (this.channelId ??= await this.opts.client.resolveChannelId(this.opts.config.channel).catch((err) => {
        this.log(`channel lookup failed (${(err as Error).message}); will retry`);
        return undefined;
      }));
      if (!channelId) return;

      const rec: CardRecord = {
        post_id: '',
        channel_id: channelId,
        bot: this.opts.bot,
        draft_id: item.draftId,
        payload_hash: item.payloadHash,
        state: 'pending',
        shown: shortenRenderedText(item.renderedText, this.opts.config.bodyMaxChars),
        created_at: this.now(),
        seen_until: this.now(),
        acked: false,
      };
      if (!this.fits(rec)) {
        // Squeeze the body first; the fields the hash covers are never shortened.
        rec.shown = shortenRenderedText(item.renderedText, MIN_BODY_CHARS);
      }
      if (!this.fits(rec)) {
        // The fields themselves are too long to show: an approval would bind text the approver never saw. Fail closed.
        rec.shown = `${rec.shown.slice(0, UNFIT_PREVIEW_CHARS)}\n... (cut: the rest of this draft is in the Ikenga Outbox)`;
        rec.state = 'closed';
        rec.unapprovable = true;
        rec.decided_at = this.now();
        rec.note = `**This draft cannot be approved here.** Its fields are too long to show in full on a card, so an approval would cover text no approver saw. Review it in the Ikenga Outbox${
          this.opts.config.outboxUrl ? `: ${this.opts.config.outboxUrl}` : ''
        }.`;
        this.opts.audit.record('outbox.refused', { draft_id: rec.draft_id, payload_hash: rec.payload_hash, reason: 'card_too_long' });
      }
      let post: MattermostPost;
      try {
        const text = this.cardText(rec);
        post = await this.opts.client.reply(channelId, text, undefined, this.propsFor(rec));
        rec.written = text;
      } catch (err) {
        this.log(`could not post the card for draft ${item.draftId}: ${this.redact((err as Error).message)}`);
        continue; // not acked: offered again next poll
      }
      rec.post_id = post.id;
      rec.edit_at = post.edit_at ?? 0;
      await this.opts.store.put(rec); // on disk before the ack: a restart must not post it twice
      posted += 1;
      this.opts.audit.record('outbox.card_posted', {
        draft_id: rec.draft_id,
        payload_hash: rec.payload_hash,
        post_id: rec.post_id,
        channel_id: rec.channel_id,
        ...(rec.unapprovable ? { unapprovable: true } : {}),
      });
      await this.supersedeOlder(rec);
      await this.ack(rec);
    }
  }

  private async ack(rec: CardRecord): Promise<void> {
    try {
      await this.opts.sender.ackAnnouncement(rec.draft_id, rec.payload_hash, rec.post_id);
      rec.acked = true;
      await this.opts.store.put(rec);
    } catch (err) {
      // Not fatal: the draft is offered again and the card for it is found, not duplicated.
      this.log(`ack of draft ${rec.draft_id} failed (${err instanceof SenderSocketError ? err.code : (err as Error).message}); will retry`);
    }
  }

  /** An edited draft has a new hash and a new card: the earlier live cards of the same draft can no longer approve it. */
  private async supersedeOlder(fresh: CardRecord): Promise<void> {
    for (const old of this.opts.store.forDraft(fresh.draft_id)) {
      if (old.post_id === fresh.post_id || (old.state !== 'pending' && old.state !== 'approved')) continue;
      const wasApproved = old.state === 'approved';
      old.state = 'superseded';
      old.note = wasApproved
        ? 'It was approved, then the draft was edited: that approval no longer applies. The newer card needs a new decision.'
        : 'The draft was edited after this card was posted. See the newer card.';
      old.decided_at = this.now();
      await this.opts.store.put(old);
      await this.edit(old);
      this.opts.audit.record('outbox.superseded', {
        draft_id: old.draft_id,
        payload_hash: old.payload_hash,
        post_id: old.post_id,
        by_post_id: fresh.post_id,
        was_approved: wasApproved,
      });
    }
  }

  private noteSender(problem: string | undefined): void {
    if (problem === this.lastSenderProblem) return;
    this.lastSenderProblem = problem;
    if (problem) {
      this.log(`sender unavailable (${this.redact(problem)}); will keep trying`);
      this.opts.audit.record('outbox.sender_unavailable', { reason: this.redact(problem).slice(0, 120) });
    } else {
      this.log('sender reachable');
    }
  }

  // ── deciding ───────────────────────────────────────────────────────────────

  /** A `reaction_added` event. Anything that is not a 👍/👎 on a pending card is ignored. */
  async handleReaction(r: MattermostReaction): Promise<Outcome | undefined> {
    const verdict = verdictOf(r.emoji_name ?? '');
    if (!verdict) return undefined;
    const card = this.opts.store.get(r.post_id);
    if (!card || card.state !== 'pending') return undefined;
    return this.decide(card, verdict, r.user_id, 'reaction');
  }

  /**
   * An Approve / Reject button. The action is the only thing taken from the callback besides the clicker's id: the
   * draft and hash are the stored ones. The callback is authenticated by an HMAC over (draft, hash, action) that only
   * this bridge and the card's buttons carry.
   */
  async handleButton(body: { user_id?: unknown; post_id?: unknown; context?: { action?: unknown; sig?: unknown } }): Promise<{ status: number; text: string }> {
    const action = body.context?.action;
    if (typeof body.user_id !== 'string' || typeof body.post_id !== 'string' || (action !== 'approve' && action !== 'reject')) {
      return { status: 400, text: 'malformed callback' };
    }
    const card = this.opts.store.get(body.post_id);
    const secret = this.opts.config.buttons?.secret;
    if (!card || !secret) return { status: 200, text: 'This card is no longer active.' };
    if (!sigEquals(body.context?.sig, this.sig(card, action))) {
      this.opts.audit.record('outbox.refused', { reason: 'bad_signature', post_id: card.post_id, draft_id: card.draft_id });
      return { status: 403, text: 'forbidden' };
    }
    if (card.state !== 'pending') return { status: 200, text: `This card is already ${card.state}.` };
    const out = await this.decide(card, action, body.user_id, 'button');
    return { status: 200, text: out.text };
  }

  private decide(card: CardRecord, verdict: Verdict, userId: string, via: 'reaction' | 'button'): Promise<Outcome> {
    const prior = this.locks.get(card.post_id) ?? Promise.resolve();
    const run = prior.then(() => this.decideNow(card, verdict, userId, via));
    const tail = run.catch(() => undefined);
    this.locks.set(card.post_id, tail);
    void tail.then(() => {
      if (this.locks.get(card.post_id) === tail) this.locks.delete(card.post_id);
    });
    return run;
  }

  private async decideNow(card: CardRecord, verdict: Verdict, userId: string, via: 'reaction' | 'button'): Promise<Outcome> {
    const { audit, store } = this.opts;
    const base = { draft_id: card.draft_id, payload_hash: card.payload_hash, post_id: card.post_id, user_id: userId, via };

    // The card may have been decided while this waited its turn (a second 👍, a button and a reaction racing).
    if (card.state !== 'pending') return { kind: 'ignored', reason: 'card_closed', text: `This card is already ${card.state}.` };

    if (this.botUserId && userId === this.botUserId) {
      audit.recordCoalesced(`outbox-refused|self|${card.post_id}`, 'outbox.refused', { ...base, reason: 'self' });
      return { kind: 'refused', reason: 'self', text: 'The bot cannot decide.' };
    }
    // Matched on the Mattermost user id, from config. Never on a username.
    if (!this.approvers.has(userId)) {
      audit.recordCoalesced(`outbox-refused|not_approver|${userId}|${card.post_id}`, 'outbox.refused', { ...base, reason: 'not_approver' });
      return { kind: 'ignored', reason: 'not_approver', text: 'You are not an approver for this channel.' };
    }

    try {
      const user = await this.lookup(userId);
      if (!user) {
        audit.record('outbox.refused', { ...base, reason: 'unverifiable_user' });
        return { kind: 'refused', reason: 'unverifiable_user', text: 'Could not verify who you are with Mattermost; nothing was decided.' };
      }
      if (user.is_bot || /^ik-/i.test(user.username)) {
        audit.record('outbox.refused', { ...base, user_name: user.username, reason: 'bot' });
        return { kind: 'refused', reason: 'bot', text: 'Bot accounts cannot decide.' };
      }
      const who = { id: userId, name: user.username };
      if (verdict === 'reject') return await this.reject(card, who, via);
      return await this.approve(card, who, via);
    } finally {
      card.seen_until = this.now();
      void store.put(card);
    }
  }

  private async reject(card: CardRecord, who: { id: string; name: string }, via: string): Promise<Outcome> {
    card.state = 'rejected';
    card.note = undefined;
    card.decided_at = this.now();
    card.decided_by_id = who.id;
    card.decided_by_name = who.name;
    await this.opts.store.put(card);
    await this.edit(card);
    this.opts.audit.record('outbox.decided', {
      draft_id: card.draft_id,
      payload_hash: card.payload_hash,
      post_id: card.post_id,
      decision: 'rejected',
      approver_id: who.id,
      approver_name: who.name,
      via,
    });
    this.log(`draft ${card.draft_id} rejected by ${who.name}`);
    return { kind: 'rejected', text: 'Rejected. The draft stays in the Ikenga Outbox.' };
  }

  private async approve(card: CardRecord, who: { id: string; name: string }, via: string): Promise<Outcome> {
    const { sender, audit } = this.opts;
    const base = { draft_id: card.draft_id, payload_hash: card.payload_hash, post_id: card.post_id, approver_id: who.id, approver_name: who.name, via };

    // Is the draft still exactly what the card showed? (An approval of a stale hash would be recorded and never match.)
    let info;
    try {
      info = await sender.getDraft(card.draft_id);
    } catch (err) {
      const code = err instanceof SenderSocketError ? err.code : (err as Error).message;
      return this.refuse(card, who, base, code, err instanceof SenderSocketError && !err.refused ? 'transport' : 'sender', 'could not check the draft with the sender');
    }
    if (info.payloadHash !== card.payload_hash) {
      card.state = 'superseded';
      card.note = 'The draft changed after this card was posted, so nothing was approved. A new card follows for the current version.';
      card.decided_at = this.now();
      await this.opts.store.put(card);
      await this.edit(card);
      audit.record('outbox.decided', { ...base, decision: 'refused', reason: 'draft_changed' });
      return { kind: 'refused', reason: 'draft_changed', text: 'The draft changed since this card was posted; nothing was approved.' };
    }
    if (info.status === 'sending' || info.status === 'sent') {
      card.state = 'closed';
      card.note = `The draft is already ${info.status}; nothing to approve.`;
      card.decided_at = this.now();
      await this.opts.store.put(card);
      await this.edit(card);
      audit.record('outbox.decided', { ...base, decision: 'refused', reason: `draft_${info.status}` });
      return { kind: 'refused', reason: `draft_${info.status}`, text: card.note };
    }

    // Is the card still exactly what the bridge posted? Whoever can edit the bot's posts could otherwise show an approver
    // one text under a hash that covers another. Checked after the draft (so a stale card is reported as stale) and
    // before anything is recorded or sent.
    let post: MattermostPost;
    try {
      post = await this.opts.client.getPost(card.post_id);
    } catch (err) {
      return this.refuse(card, who, base, `card_unverifiable: ${(err as Error).message}`, 'transport', 'could not check the card with Mattermost');
    }
    if (!this.cardIntact(card, post)) {
      card.state = 'closed';
      card.note = 'This card was edited after the bridge posted it, so what it showed may not be what the draft says. Nothing was approved. Review the draft in the Ikenga Outbox.';
      card.decided_at = this.now();
      await this.opts.store.put(card);
      await this.edit(card); // puts the real text back
      audit.record('outbox.decided', { ...base, decision: 'refused', reason: 'card_edited' });
      return { kind: 'refused', reason: 'card_edited', text: 'This card was edited after it was posted; nothing was approved.' };
    }

    // No record, no action: the approval request is on disk before the sender hears of it.
    try {
      audit.must('outbox.approve_requested', base);
    } catch (err) {
      if (!(err instanceof AuditUnavailableError)) throw err;
      return { kind: 'refused', reason: 'audit_unavailable', text: 'The audit log is unavailable, so nothing was approved.' };
    }

    try {
      await sender.approve(card.draft_id, card.payload_hash, { kind: 'mattermost', id: who.id });
    } catch (err) {
      const code = err instanceof SenderSocketError ? err.code : (err as Error).message;
      return this.refuse(card, who, base, code, err instanceof SenderSocketError && err.refused ? 'sender' : 'transport', 'the sender refused the approval');
    }

    card.state = 'approved';
    card.note = undefined;
    card.decided_at = this.now();
    card.decided_by_id = who.id;
    card.decided_by_name = who.name;
    await this.opts.store.put(card);
    await this.edit(card);
    audit.record('outbox.decided', { ...base, decision: 'approved' });
    this.log(`draft ${card.draft_id} approved by ${who.name}`);
    return { kind: 'approved', text: 'Approved. The sender will send it on its next run.' };
  }

  /** The sender said no (or could not be asked): say so on the card, and close it only when nothing can change that. */
  private async refuse(
    card: CardRecord,
    who: { id: string; name: string },
    base: Record<string, string>,
    rawCode: string,
    from: 'sender' | 'transport',
    what: string,
  ): Promise<Outcome> {
    const code = this.redact(rawCode).replace(/[`\r\n]/g, ' ').slice(0, 160);
    const help = REFUSAL_HELP[code];
    card.note =
      from === 'transport'
        ? `Approval by @${who.name} did not go through: could not reach ${code.startsWith('card_unverifiable') ? 'Mattermost to check this card' : 'the sender'} (\`${code}\`). Nothing was approved. Remove and re-add your 👍, or use the Approve button, to try again.`
        : `Approval by @${who.name} refused: \`${code}\`${help ? ` (${help})` : ''}.`;
    if (from === 'sender' && isTerminalRefusal(rawCode)) card.state = 'closed';
    card.decided_at = card.state === 'closed' ? this.now() : card.decided_at;
    await this.opts.store.put(card);
    await this.edit(card);
    this.opts.audit.record('outbox.decided', { ...base, decision: 'refused', reason: code.slice(0, 120) });
    this.log(`approval of draft ${card.draft_id} by ${who.name} not accepted: ${code}`);
    return { kind: 'refused', reason: code, text: `Not approved: ${what} (${code}).` };
  }

  private async lookup(userId: string): Promise<{ id: string; username: string; is_bot?: boolean } | undefined> {
    const hit = this.users.get(userId);
    if (hit && this.now() - hit.at < USER_CACHE_MS) return hit.user;
    try {
      const user = await this.opts.client.getUser(userId);
      // The profile must be the one asked for: a reply for someone else is not a verification.
      if (!user || user.id !== userId || typeof user.username !== 'string') return undefined;
      this.users.set(userId, { user, at: this.now() });
      return user;
    } catch (err) {
      this.log(`could not resolve user ${userId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  // ── restart ────────────────────────────────────────────────────────────────

  /**
   * After a restart: apply what approvers did on pending cards while the bridge was down (earliest first, as live), and
   * re-ask the sender about cards whose ack was lost.
   */
  async recover(): Promise<void> {
    for (const card of this.opts.store.all()) {
      if (card.state !== 'pending') continue;
      let reactions: MattermostReaction[] = [];
      const since = card.seen_until;
      try {
        reactions = await this.opts.client.getReactions(card.post_id);
      } catch (err) {
        this.log(`could not read reactions on ${card.post_id}: ${(err as Error).message}`);
        continue;
      }
      reactions = reactions.filter((r) => (r.create_at ?? 0) > since).sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));
      for (const r of reactions) {
        if (card.state !== 'pending') break;
        await this.handleReaction({ ...r, post_id: card.post_id });
      }
      if (card.state === 'pending') {
        card.seen_until = this.now();
        await this.opts.store.put(card);
      }
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private cardText(rec: CardRecord): string {
    const buttons = Boolean(this.opts.config.buttons);
    const hint = `Also reviewable (and editable) in the Ikenga Outbox${this.opts.config.outboxUrl ? `: ${this.opts.config.outboxUrl}` : '.'}`;
    let head: string;
    switch (rec.state) {
      case 'pending':
        head = `**Draft awaiting approval.** React 👍 to approve or 👎 to reject${buttons ? ', or use the buttons' : ''}. Only the listed approvers can decide.`;
        break;
      case 'approved':
        head = `**Approved by @${rec.decided_by_name ?? 'an approver'} — sending.** The sender picks it up on its next run.`;
        break;
      case 'rejected':
        head = `**Rejected by @${rec.decided_by_name ?? 'an approver'}.** Nothing was sent. The draft stays in the Ikenga Outbox: edit it there for a new card, or approve it there.`;
        break;
      case 'superseded':
        head = '**Superseded.**';
        break;
      default:
        head = '**Closed.**';
    }
    const parts = [head];
    if (rec.note) parts.push(rec.note);
    // The sender's text carries agent-controlled fields (subject, cc, references, body). Posted as live markdown, a stray
    // `![` or `[` can swallow the lines after it into image alt text or a link label, hiding hashed fields the approver
    // is meant to see. A code fence longer than any backtick run in the text shows every character literally.
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(rec.shown) + 1));
    parts.push('', '---', fence, rec.shown, fence, '---', hint);
    // Never cut here: a cut would drop hashed fields the approver is meant to see. Too long is decided by `fits`.
    return this.redact(parts.join('\n'));
  }

  /** Does the whole card fit in one post? A card that does not is never offered for approval. */
  private fits(rec: CardRecord): boolean {
    return this.cardText(rec).length <= POST_MAX_CHARS;
  }

  /** Is the live post the one the bridge wrote: same author, never edited by anyone else, same text? */
  private cardIntact(card: CardRecord, post: MattermostPost): boolean {
    if (!post || post.id !== card.post_id) return false;
    if (post.delete_at) return false;
    if (this.botUserId && post.user_id !== this.botUserId) return false;
    if ((post.edit_at ?? 0) !== (card.edit_at ?? 0)) return false;
    return post.message === (card.written ?? this.cardText(card));
  }

  private sig(card: Pick<CardRecord, 'draft_id' | 'payload_hash'>, action: Verdict): string {
    return createHmac('sha256', this.opts.config.buttons?.secret ?? '').update(`${card.draft_id}\n${card.payload_hash}\n${action}`).digest('hex');
  }

  /** Buttons on a pending card; none once it is decided. `undefined` (no props at all) when buttons are not configured. */
  private propsFor(rec: CardRecord): Record<string, unknown> | undefined {
    const b = this.opts.config.buttons;
    if (!b) return undefined;
    if (rec.state !== 'pending') return { attachments: [] };
    const action = (id: Verdict, name: string, style: string) => ({
      id,
      name,
      type: 'button',
      style,
      integration: { url: b.callbackUrl, context: { action: id, sig: this.sig(rec, id) } },
    });
    return { attachments: [{ fallback: 'Approve or reject this draft', actions: [action('approve', 'Approve', 'good'), action('reject', 'Reject', 'danger')] }] };
  }

  private async edit(rec: CardRecord): Promise<void> {
    try {
      const text = this.cardText(rec);
      const post = await this.opts.client.updatePost(rec.post_id, text, this.propsFor(rec));
      rec.written = text;
      rec.edit_at = post?.edit_at ?? rec.edit_at;
      await this.opts.store.put(rec);
    } catch (err) {
      this.log(`could not edit card ${rec.post_id}: ${this.redact((err as Error).message)}`);
    }
  }

  // ── button callbacks ───────────────────────────────────────────────────────

  private listen(): Promise<void> {
    const b = this.opts.config.buttons as NonNullable<ResolvedOutboxApprovals['buttons']>;
    const route = new URL(b.callbackUrl).pathname;
    const server = http.createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let pathname = '';
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        /* falls through to 404 */
      }
      if (req.method !== 'POST' || pathname !== route) return reply(404, { error: 'not found' });
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BUTTON_BODY_BYTES) {
          reply(413, { error: 'too large' });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        let parsed: Parameters<OutboxApprovals['handleButton']>[0];
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return reply(400, { error: 'invalid json' });
        }
        this.handleButton(parsed ?? {}).then(
          (out) => (out.status === 200 ? reply(200, { ephemeral_text: out.text }) : reply(out.status, { error: out.text })),
          (err) => {
            this.log(`button callback failed: ${this.redact((err as Error).message)}`);
            reply(500, { error: 'internal error' });
          },
        );
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(b.listenPort, b.listenHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }
}

function sigEquals(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  // Compare bytes: a multibyte string of the same length would otherwise reach timingSafeEqual with a different size and throw.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
