import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BotApprovalsConfig, MattermostPost, MattermostReaction } from './types.js';

/**
 * B3 approvals: a plan is posted, and an approver's reaction decides whether it
 * is carried out. See the README ("Approvals") for what the daemon offers and
 * why this is a plan-then-act flow rather than per-tool prompts.
 */

export const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
/** `setTimeout` overflows past 2^31-1 ms (24.8 days); stay well below. */
const MAX_APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** The Claude Code permission mode a gated bot's turns run in (read-only; no tool can write). */
export const PLAN_MODE = 'plan';
/**
 * Modes an approved run may use. `plan` would approve nothing; `default` makes
 * every tool prompt that nobody can answer. Anything else the daemon would
 * silently turn into `default` (`AcpSessionMode::from_acp_id(..).unwrap_or_default()`).
 */
const ACTING_MODES = ['auto', 'bypassPermissions'] as const;

export interface ResolvedApprovals {
  approvers: string[];
  timeoutMs: number;
  actingMode: string;
}

/** Validate and default a bot's `approvals` block. Throws with the bot named. */
export function resolveApprovals(cfg: BotApprovalsConfig, where: string): ResolvedApprovals {
  const approvers = (cfg.approvers ?? []).map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean);
  if (approvers.length === 0) {
    throw new Error(`${where}: approvals.approvers must name at least one approver (deny by default)`);
  }
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_APPROVAL_TIMEOUT_MS) {
    throw new Error(`${where}: approvals.timeoutMs must be between 1 and ${MAX_APPROVAL_TIMEOUT_MS} ms`);
  }
  const actingMode = cfg.actingMode ?? 'auto';
  if (!(ACTING_MODES as readonly string[]).includes(actingMode)) {
    throw new Error(`${where}: approvals.actingMode must be one of ${ACTING_MODES.join(', ')} (got '${actingMode}')`);
  }
  return { approvers, timeoutMs, actingMode };
}

// ── persistence ──────────────────────────────────────────────────────────────

/** One approval that is still waiting for a reaction. */
export interface ApprovalRecord {
  request_id: string;
  /** The approval post: the key a reaction is matched on. */
  post_id: string;
  root_id: string;
  channel_id: string;
  bot: string;
  /** The thread's run that produced the plan (the approved run's parent). */
  plan_run_id: string;
  /** The plan text as the approver saw it; the approved run is given exactly this. */
  plan: string;
  created_at: number;
  expires_at: number;
}

interface ApprovalFile {
  version: 1;
  approvals: Record<string, ApprovalRecord>;
}

/**
 * Pending approvals for one bot. Same discipline as `ThreadStore`: served from
 * memory, every change rewrites the file atomically (temp file, then rename),
 * mode 0600. `take` removes synchronously, which is what makes the first
 * decision the only one.
 */
export class ApprovalStore {
  private readonly items = new Map<string, ApprovalRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly bot: string,
  ) {
    this.load();
  }

  get(postId: string): ApprovalRecord | undefined {
    return this.items.get(postId);
  }

  all(): ApprovalRecord[] {
    return [...this.items.values()];
  }

  size(): number {
    return this.items.size;
  }

  put(rec: ApprovalRecord): Promise<void> {
    this.items.set(rec.post_id, { ...rec, bot: this.bot });
    return this.flush();
  }

  /** Remove and return a record, synchronously. `undefined` when it is not (or no longer) pending. */
  take(postId: string): ApprovalRecord | undefined {
    const rec = this.items.get(postId);
    if (!rec) return undefined;
    this.items.delete(postId);
    void this.flush();
    return rec;
  }

  /** Resolves once every queued write has hit the disk. */
  flushed(): Promise<void> {
    return this.writing;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`approval store: cannot read ${this.filePath}: ${(err as Error).message}`);
    }
    let parsed: ApprovalFile;
    try {
      parsed = JSON.parse(raw) as ApprovalFile;
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      console.error(`approval store ${this.filePath} was unreadable; moved aside and starting empty`);
      return;
    }
    for (const rec of Object.values(parsed.approvals ?? {})) {
      if (rec && rec.post_id && rec.plan_run_id && rec.bot === this.bot && Number.isFinite(rec.expires_at)) {
        this.items.set(rec.post_id, rec);
      }
    }
  }

  private flush(): Promise<void> {
    const snapshot: ApprovalFile = { version: 1, approvals: Object.fromEntries(this.items) };
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
        console.error(`approval store: write failed: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }
}

// ── the manager ──────────────────────────────────────────────────────────────

/** The slice of the Mattermost client the manager needs. */
export interface ApprovalApi {
  reply(channelId: string, message: string, rootId?: string): Promise<MattermostPost>;
  updatePost(postId: string, message: string): Promise<MattermostPost>;
  getReactions(postId: string): Promise<MattermostReaction[]>;
  getUser(userId: string): Promise<{ id: string; username: string }>;
}

export interface ApprovalManagerOptions {
  bot: string;
  client: ApprovalApi;
  store: ApprovalStore;
  approvals: ResolvedApprovals;
  /** Called once, after a 👍 from an approver has claimed the approval and the post says so. */
  onApproved: (rec: ApprovalRecord, approver: string) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface ApprovalRequest {
  rootId: string;
  channelId: string;
  planRunId: string;
  plan: string;
}

/** Mattermost emoji names for 👍 / 👎; a skin tone rides after `::`. */
function verdictOf(emoji: string): 'approve' | 'deny' | undefined {
  const name = emoji.split('::', 1)[0];
  if (name === '+1' || name === 'thumbsup') return 'approve';
  if (name === '-1' || name === 'thumbsdown') return 'deny';
  return undefined;
}

const hhmm = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const looksLikeUserId = (s: string) => /^[a-z0-9]{26}$/.test(s);

/**
 * Posts approval requests, decides them from reactions, expires them, and
 * re-attaches to the ones left pending by a restart.
 *
 * Every rule fails closed: a reaction counts only if it is 👍/👎 on a pending
 * approval post, from an approver (resolved by the Mattermost API, never by a
 * client-supplied field), not from the bot; the first such reaction decides; an
 * approval nobody decides expires as a denial.
 */
export class ApprovalManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly users = new Map<string, string>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private botUserId?: string;

  constructor(private readonly opts: ApprovalManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}] ${m}`));
  }

  setBotUserId(id: string): void {
    this.botUserId = id;
  }

  pendingCount(): number {
    return this.opts.store.size();
  }

  hasPending(rootId: string): boolean {
    return this.opts.store.all().some((r) => r.root_id === rootId);
  }

  /** Cancel timers (shutdown). Pending records stay on disk for the next start. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Post the approval request under the plan and start its clock. */
  async request(req: ApprovalRequest): Promise<void> {
    const t = this.now();
    const rec: ApprovalRecord = {
      request_id: randomUUID(),
      post_id: '',
      root_id: req.rootId,
      channel_id: req.channelId,
      bot: this.opts.bot,
      plan_run_id: req.planRunId,
      plan: req.plan,
      created_at: t,
      expires_at: t + this.opts.approvals.timeoutMs,
    };
    const post = await this.opts.client.reply(req.channelId, this.requestText(rec), req.rootId);
    rec.post_id = post.id;
    await this.opts.store.put(rec);
    this.arm(rec);
  }

  /** A `reaction_added` event. Everything that is not a decision on a pending approval is ignored. */
  async handleReaction(r: MattermostReaction): Promise<void> {
    if (this.botUserId && r.user_id === this.botUserId) return;
    const verdict = verdictOf(r.emoji_name ?? '');
    if (!verdict) return;
    const rec = this.opts.store.get(r.post_id);
    if (!rec) return; // not an approval post, or already decided / expired / withdrawn

    // The clock decides, not the timer: a late timer must not let a stale 👍 through.
    if (this.now() >= rec.expires_at) {
      await this.expire(rec.post_id);
      return;
    }

    const who = await this.approverName(r.user_id);
    if (!who) {
      this.log(`ignored ${r.emoji_name} on approval ${rec.request_id} from non-approver ${r.user_id}`);
      return;
    }

    // The lookup above awaited: another reaction, the timer or a new message may
    // have settled this approval meanwhile. `take` is synchronous, so exactly
    // one caller gets the record.
    const taken = this.opts.store.take(r.post_id);
    if (!taken) return;
    this.disarm(taken.post_id);

    if (verdict === 'deny') {
      await this.edit(taken.post_id, `**Denied** by @${who} at ${hhmm(this.now())}. Nothing was run.`);
      this.log(`approval ${taken.request_id} denied by ${who}`);
      return;
    }
    await this.edit(
      taken.post_id,
      `**Approved** by @${who} at ${hhmm(this.now())}. Carrying out the plan with \`${this.opts.approvals.actingMode}\` permissions.`,
    );
    this.log(`approval ${taken.request_id} approved by ${who}`);
    await this.opts.onApproved(taken, who);
  }

  /** Withdraw every pending approval of a thread (the conversation moved on, or someone said `stop`). */
  async withdraw(rootId: string, reason: string): Promise<number> {
    let n = 0;
    for (const rec of this.opts.store.all().filter((r) => r.root_id === rootId)) {
      const taken = this.opts.store.take(rec.post_id);
      if (!taken) continue;
      this.disarm(taken.post_id);
      n += 1;
      await this.edit(taken.post_id, `**Withdrawn**: ${reason}. Nothing was run.`);
    }
    return n;
  }

  /**
   * After a restart: re-arm the clock of every pending approval, expire the
   * ones that ran out while the bridge was down, and apply a decision that was
   * made while it was down (reactions are fetched; the earliest approver
   * reaction wins, as it would have live).
   */
  async recover(): Promise<void> {
    for (const rec of this.opts.store.all()) {
      if (this.now() >= rec.expires_at) {
        await this.expire(rec.post_id);
        continue;
      }
      this.arm(rec);
      this.log(`re-attached to approval ${rec.request_id} (expires ${hhmm(rec.expires_at)})`);
      let reactions: MattermostReaction[] = [];
      try {
        reactions = await this.opts.client.getReactions(rec.post_id);
      } catch (err) {
        this.log(`could not read reactions on ${rec.post_id}: ${(err as Error).message}`);
      }
      reactions.sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));
      for (const r of reactions) {
        if (!this.opts.store.get(rec.post_id)) break; // decided
        await this.handleReaction({ ...r, post_id: rec.post_id });
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private arm(rec: ApprovalRecord): void {
    this.disarm(rec.post_id);
    const timer = setTimeout(() => {
      void this.expire(rec.post_id).catch((err) => this.log(`expiry of ${rec.post_id} failed: ${(err as Error).message}`));
    }, Math.max(0, rec.expires_at - this.now()));
    timer.unref?.();
    this.timers.set(rec.post_id, timer);
  }

  private disarm(postId: string): void {
    const t = this.timers.get(postId);
    if (t) clearTimeout(t);
    this.timers.delete(postId);
  }

  private async expire(postId: string): Promise<void> {
    const taken = this.opts.store.take(postId);
    if (!taken) return;
    this.disarm(postId);
    const mins = Math.max(1, Math.round((taken.expires_at - taken.created_at) / 60000));
    await this.edit(
      postId,
      `**Expired**: no approver decided within ${mins} min, so this is a denial. Nothing was run. Reply in this thread to start again.`,
    );
    this.log(`approval ${taken.request_id} expired`);
  }

  /** The approver's username, or `undefined` for anyone who may not decide (or cannot be checked). */
  private async approverName(userId: string): Promise<string | undefined> {
    const allow = new Set(this.opts.approvals.approvers.map((a) => a.replace(/^@/, '')));
    let username = this.users.get(userId);
    if (username === undefined) {
      try {
        username = (await this.opts.client.getUser(userId)).username;
      } catch (err) {
        this.log(`could not resolve user ${userId}: ${(err as Error).message}`);
        return undefined; // cannot verify, so not an approver
      }
      this.users.set(userId, username);
    }
    return allow.has(userId) || allow.has(username) ? username : undefined;
  }

  private requestText(rec: ApprovalRecord): string {
    const who = this.opts.approvals.approvers
      .map((a) => (looksLikeUserId(a) ? 'an approver' : `@${a.replace(/^@/, '')}`))
      .join(', ');
    const mins = Math.max(1, Math.round(this.opts.approvals.timeoutMs / 60000));
    return [
      `**Approval needed**: ${this.opts.bot} proposes the plan above (run \`${rec.plan_run_id}\`).`,
      `React 👍 to carry it out with \`${this.opts.approvals.actingMode}\` permissions, or 👎 to deny. Only ${who} can decide.`,
      `No decision by ${hhmm(rec.expires_at)} (${mins} min) counts as a denial; nothing runs without a 👍.`,
    ].join('\n');
  }

  private async edit(postId: string, text: string): Promise<void> {
    try {
      await this.opts.client.updatePost(postId, text);
    } catch (err) {
      this.log(`could not edit approval post ${postId}: ${(err as Error).message}`);
    }
  }
}
