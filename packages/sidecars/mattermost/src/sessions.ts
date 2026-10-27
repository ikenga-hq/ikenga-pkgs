import { PLAN_MODE, planHash } from './approvals.js';
import { effectiveMode, modeRank } from './rails.js';
import { checkPolicyCwd } from './policy.js';
import type { CwdCheck, ResolvedUserPolicy } from './policy.js';
import type { Rails } from './rails.js';
import type { ApprovalManager, ApprovalRecord } from './approvals.js';
import { DaemonError, TERMINAL_STATUSES } from './daemon.js';
import type { MediaHook } from './media.js';
import { RunGateClosedError, RunWaitAbortedError, isGateStop } from './run-gate.js';
import type { RunGate, RunSlot } from './run-gate.js';
import type { ChiRunResult, DaemonClient } from './daemon.js';
import type { ThreadRecord, ThreadStore } from './store.js';
import type { BotChiConfig, MattermostPost, ProgressConfig } from './types.js';

/** The slice of the Mattermost client the router needs. */
export interface PostApi {
  reply(channelId: string, message: string, rootId?: string): Promise<MattermostPost>;
  updatePost(postId: string, message: string): Promise<MattermostPost>;
  deletePost(postId: string): Promise<void>;
}

/** The Mattermost user a turn is for. */
export interface Who {
  id: string;
  name?: string;
}

export type ChiApi = Pick<DaemonClient, 'chiRun' | 'chiResume' | 'chiStatus' | 'chiCancel' | 'redact'>;

export type ResolvedProgress = Required<ProgressConfig>;

export const PROGRESS_DEFAULTS: ResolvedProgress = {
  pollMinMs: 1_000,
  pollMaxMs: 10_000,
  editIntervalMs: 5_000,
  maxWaitMs: 2 * 60 * 60 * 1000,
  maxPollFailures: 5,
};

/** Mattermost rejects posts over 16383 characters; stay under it. */
export const MAX_POST_CHARS = 15_000;

/** A thread reply that is only this (case-insensitive) cancels the thread's run. */
const CANCEL_RE = /^(?:\/|!)?(?:cancel|stop)[.!]?$/i;

/**
 * Appended to every prompt of a gated bot. Plan mode is enforced by the daemon
 * (Claude Code's `--permission-mode plan`); this note only stops the model from
 * calling `ExitPlanMode`, which nobody could answer, and from describing that
 * failure as its result.
 */
export const PLAN_NOTE =
  '\n\n[Bridge note: this turn runs in plan mode, so nothing can be changed. Reply with your answer or, if changes are needed, your complete step-by-step plan as your final message. Do not call ExitPlanMode: no one can answer it. A human approver decides afterwards whether a plan is carried out.]';

/** How much of an approved run's report is handed to the thread's next plan turn. */
const CARRY_CHARS = 4_000;

interface Turn {
  kind: 'plan' | 'act';
  rootId: string;
  channelId: string;
  runId?: string;
  progressPostId?: string;
  startedAt: number;
  cancelRequested: boolean;
  /** Who said `stop`, for the audit record of the cancellation. */
  cancelledBy?: Who;
  /** Who asked for this turn. */
  by?: Who;
  /** The user id of the policy this turn runs under (`userPolicies`); absent for an ordinary (allowedUsers) turn. */
  policyKey?: string;
  /** The EFFECTIVE permission mode of `runId` (`bypassPermissions` on an engine that does not enforce modes). */
  mode?: string;
  /** The engine `runId` runs on. */
  engine?: string;
  /** Ties the `run.requested` record to `run.started` / `run.start_failed`. */
  requestId?: string;
  finished: boolean;
  abort: AbortController;
  /** Kept through to the final summary so it isn't edited away. */
  notice?: string;
  done?: Promise<void>;
  /** The bridge-wide concurrency slot this turn holds. Released when the run ends, fails to start, is cancelled or the bridge stops. */
  slot?: RunSlot;
  /** Aborted by `stop`/`cancel` while the turn still waits for a slot. */
  queueAbort: AbortController;
  /** The turn had to wait for a slot, and for how long (seconds), for the audit record. */
  queueWaitS?: number;
}

export interface RouterOptions {
  bot: string;
  client: PostApi;
  daemon: ChiApi;
  store: ThreadStore;
  chi: BotChiConfig;
  /** B5: the mode ceiling, the audit log and the branch note. Every `chi_run` / `chi_resume` below goes through it first. */
  rails: Rails;
  /** The bridge-wide cap on runs in flight, shared by every bot. Every `chi_run` / `chi_resume` below takes a slot first. */
  runGate: RunGate;
  progress?: ProgressConfig;
  /**
   * B3. When set, thread turns run in plan mode and an approved plan runs once, in
   * `actingMode`. Unset keeps the B2 behaviour (`chi.mode`, no gate).
   */
  approvals?: { manager: ApprovalManager; actingMode: string };
  /**
   * Asked before every policy run is started or resumed (`userPolicies`): is the daemon able to enforce `toolPolicy` right now?
   * Absent, or anything but `{ ok: true }`, refuses the run (fail closed): a daemon that does not know the field would run
   * the session with the account's full tools.
   */
  policyGuard?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Inbound images (the `media` block). Asked once per turn, after the thread is claimed and before anything is started: it
   * uploads a listed user's PNG/JPEG attachments and answers with the block to append to the prompt, or a refusal (no run is
   * started). Absent = attachments are ignored, as before.
   */
  media?: MediaHook;
  botUsername?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Maps Mattermost threads onto Chi runs for one bot.
 *
 *  - new root post   -> `chi_run`, remember `root_id -> run_id`
 *  - reply in thread -> `chi_resume` of that run (fresh `chi_run` if it is gone)
 *  - "stop"/"cancel" -> `chi_cancel`
 *
 * Callers must have passed the post through the gate already.
 */
export class ThreadRouter {
  private readonly turns = new Map<string, Turn>();
  private readonly progress: ResolvedProgress;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private botUsername?: string;

  constructor(private readonly opts: RouterOptions) {
    this.progress = { ...PROGRESS_DEFAULTS, ...stripUndefined(opts.progress ?? {}) };
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}] ${m}`));
    this.botUsername = opts.botUsername;
  }

  setBotUsername(name: string): void {
    this.botUsername = name;
  }

  /** Threads that currently have a run being watched. */
  activeCount(): number {
    return this.turns.size;
  }

  /** Resolves once every watched run has finished (tests, graceful shutdown). */
  async whenIdle(): Promise<void> {
    while (this.turns.size > 0) {
      await Promise.all([...this.turns.values()].map((t) => t.done ?? Promise.resolve()));
      // A turn without `done` yet is still starting; yield so it can register.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Give back slots reserved for runs that were never re-attached (a failed start, a stop). */
  releaseReserved(): void {
    for (const slot of this.reserved.values()) slot.release();
    this.reserved.clear();
  }

  stop(): void {
    this.releaseReserved();
    for (const t of this.turns.values()) {
      t.abort.abort();
      t.queueAbort.abort();
      t.slot?.release();
    }
  }

  async handle(post: MattermostPost, who?: Who, policy?: ResolvedUserPolicy): Promise<void> {
    const by: Who = who ?? { id: post.user_id };
    const rootId = post.root_id || post.id;
    const isReply = Boolean(post.root_id);
    const text = this.stripMention(post.message).trim();
    if (!text) return;

    const existing = this.turns.get(rootId);

    // A thread belongs to one session. Someone with a different policy (or none) can neither cancel nor queue behind
    // another session's turn.
    if (existing && (existing.policyKey ?? '') !== (policy?.userId ?? '')) {
      await this.say(post.channel_id, rootId, 'Another session is working in this thread. Start a new message of your own instead.');
      return;
    }

    if (isReply && CANCEL_RE.test(text)) {
      await this.cancel(rootId, post.channel_id, existing, by);
      return;
    }

    if (existing) {
      await this.say(
        post.channel_id,
        rootId,
        'Still working on your previous message in this thread. Reply `stop` to cancel it, or send this again once it finishes.',
      );
      return;
    }

    // Claim the thread before the first await: two quick replies must not
    // both start a run.
    const turn: Turn = {
      kind: 'plan',
      rootId,
      channelId: post.channel_id,
      startedAt: this.now(),
      cancelRequested: false,
      by,
      policyKey: policy?.userId,
      finished: false,
      abort: new AbortController(),
      queueAbort: new AbortController(),
    };
    this.turns.set(rootId, turn);

    try {
      // Images first: a refused or failed upload starts nothing, and must not withdraw a plan that is waiting for a decision.
      let prompt = text;
      if (this.opts.media) {
        const media = await this.opts.media.process(post, text);
        if (media.kind === 'refused' || turn.cancelRequested) {
          turn.finished = true;
          this.endTurn(turn);
          await this.say(post.channel_id, rootId, media.kind === 'refused' ? media.reply : 'Cancelled while the images were uploading. Nothing was run.');
          return;
        }
        // The user's words stay exactly as written; the bridge's block comes after them (its lines carry sanitized names only).
        if (media.kind === 'ok') prompt = `${text}\n\n${media.block}`;
      }
      // A new message supersedes a plan still waiting for a decision: an approver
      // must not be able to 👍 a plan the conversation has moved past.
      await this.opts.approvals?.manager.withdraw(rootId, 'a newer message arrived in this thread', 'superseded');
      await this.start(turn, post, prompt, isReply, policy);
    } catch (err) {
      await this.failStart(turn, err);
    }
  }

  /**
   * Slots taken for runs a restart found still active, keyed by thread root. Taken synchronously (see
   * `reserveRecovered`) so every bot in the process counts its survivors before ANY bot can start new work;
   * `recover()` hands each to the turn that re-attaches to that run.
   */
  private readonly reserved = new Map<string, RunSlot>();

  /**
   * Take a slot for every thread run that was still active when the bridge last stopped. Synchronous and idempotent.
   * The bridge calls it for ALL bots before any of them awaits anything, so a bot that finishes starting early cannot
   * find an empty gate while another bot's survivors have not been counted yet.
   */
  reserveRecovered(): void {
    for (const rec of this.opts.store.activeThreads()) {
      if (!rec.active || this.turns.has(rec.root_id) || this.reserved.has(rec.root_id)) continue;
      this.reserved.set(rec.root_id, this.opts.runGate.adopt({ bot: this.opts.bot, kind: 'recovered' }));
    }
  }

  /** Re-attach to turns that were in flight when the bridge last stopped. */
  recover(): void {
    this.reserveRecovered();
    try {
      this.reattach();
    } finally {
      // A slot reserved for a thread that did not re-attach (nothing to follow) must not stay held.
      this.releaseReserved();
    }
  }

  private reattach(): void {
    for (const rec of this.opts.store.activeThreads()) {
      const active = rec.active;
      if (!active || this.turns.has(rec.root_id)) continue;
      const turn: Turn = {
        kind: active.kind ?? 'plan',
        rootId: rec.root_id,
        channelId: rec.channel_id,
        runId: active.run_id,
        progressPostId: active.progress_post_id,
        startedAt: active.started_at,
        cancelRequested: false,
        by: active.by,
        policyKey: rec.policy,
        // The mode the run STARTED with, as persisted when it started; never today's config. A record from before this
        // was persisted falls back to the thread's own record (a plan turn) or to nothing (an acting run): unrecorded
        // beats a guess that may be wrong.
        mode: active.mode ?? (active.kind === 'act' || !rec.engine ? undefined : effectiveMode(rec.engine, rec.mode)),
        engine: active.engine ?? (active.kind === 'act' ? undefined : rec.engine),
        finished: false,
        abort: new AbortController(),
        queueAbort: new AbortController(),
        // The run is already going on the daemon: it counts against the cap, so a restart cannot start N more on top.
        slot: this.reserved.get(rec.root_id) ?? this.opts.runGate.adopt({ bot: this.opts.bot, kind: 'recovered' }),
      };
      this.reserved.delete(rec.root_id);
      this.turns.set(rec.root_id, turn);
      this.log(`re-attached to run ${active.run_id} for thread ${rec.root_id}`);
      turn.done = this.track(turn, active.brief ? { ...rec, brief: active.brief } : rec, active.notice);
    }
  }

  /**
   * An approver's 👍 (the approval is already claimed and its post edited):
   * start the approved plan as a NEW run in the acting mode, parented to the
   * plan run. The thread's own run stays the plan run, so a later reply is
   * planned (read-only) and approved again, never resumed with write access.
   */
  async runApproved(a: ApprovalRecord, approver: Who & { name: string }): Promise<void> {
    const gate = this.opts.approvals;
    if (!gate) return;
    const { daemon, store, chi, rails } = this.opts;
    const rootId = a.root_id;
    if (this.turns.has(rootId)) {
      await this.say(a.channel_id, rootId, 'The plan was approved, but another turn is running in this thread, so I did not start it. Send the request again once that finishes.');
      return;
    }
    const turn: Turn = {
      kind: 'act',
      rootId,
      channelId: a.channel_id,
      startedAt: this.now(),
      cancelRequested: false,
      by: approver,
      mode: gate.actingMode,
      finished: false,
      abort: new AbortController(),
      queueAbort: new AbortController(),
    };
    this.turns.set(rootId, turn);
    try {
      const working = await this.opts.client.reply(a.channel_id, 'Working…', rootId);
      turn.progressPostId = working.id;
      const prompt = this.withPrefix(
        `The plan below was approved by @${approver.name} in Mattermost. Carry it out now, exactly as written, and do not widen its scope. Then report briefly what you did and anything that failed.\n\n--- approved plan ---\n${a.plan}${rails.branchNote()}`,
      );
      const auth = rails.authorizeRun({
        kind: 'act',
        engine: chi.engine,
        mode: gate.actingMode,
        fields: {
          thread_root: rootId,
          channel_id: a.channel_id,
          plan_run_id: a.plan_run_id,
          approval_id: a.request_id,
          plan_hash: planHash(a.plan),
          approver_id: approver.id,
          approver_name: approver.name,
          requester_id: a.requester_id,
          requester_name: a.requester_name,
          branch_prefix: rails.branchPrefix,
        },
      });
      turn.requestId = auth.requestId;
      turn.mode = auth.mode;
      turn.engine = auth.engine;
      await this.takeSlot(turn, 'act');
      const result = await daemon.chiRun({
        engineId: chi.engine,
        prompt,
        cwd: chi.cwd,
        model: chi.model,
        mode: gate.actingMode,
        timeoutSeconds: chi.timeoutSeconds,
        persistent: chi.persistent ?? true,
        parentId: a.plan_run_id,
      });
      requireRunId(result);
      turn.runId = result.run_id;
      rails.audit.record('run.started', {
        request_id: turn.requestId,
        run_id: result.run_id,
        kind: 'act',
        engine: auth.engine,
        mode: auth.mode,
        queue_wait_s: turn.queueWaitS,
        thread_root: rootId,
        channel_id: a.channel_id,
        parent_run_id: a.plan_run_id,
        approver_id: approver.id,
        approver_name: approver.name,
      });
      const thread = store.get(rootId);
      if (!thread) throw new Error('the thread record is gone');
      await store.update(rootId, {
        active: { run_id: result.run_id, progress_post_id: working.id, started_at: turn.startedAt, kind: 'act', brief: prompt, by: approver, mode: auth.mode, engine: auth.engine },
      });
      if (turn.cancelRequested) {
        await this.cancelRun(turn);
        return;
      }
      turn.done = this.track(turn, { ...thread, brief: prompt });
    } catch (err) {
      await this.failStart(turn, err);
    }
  }

  // ── starting / resuming ────────────────────────────────────────────────────

  private async start(turn: Turn, post: MattermostPost, text: string, isReply: boolean, policy?: ResolvedUserPolicy): Promise<void> {
    const { daemon, store, chi, rails } = this.opts;
    const rootId = turn.rootId;
    const by = turn.by ?? { id: post.user_id };
    const base = {
      thread_root: rootId,
      channel_id: post.channel_id,
      user_id: by.id,
      user_name: by.name,
      // A policy session says so in every record, so the audit trail shows which limits the run was started under.
      policy: policy?.label,
      policy_enforced_by: policy?.enforcedBy,
      ...rails.promptFields(text),
    };
    // Ignore a record from another channel (defence in depth; Mattermost
    // already keeps a reply's root in its own channel).
    const stored = store.get(rootId);
    let rec = stored && stored.channel_id === post.channel_id ? stored : undefined;
    const gated = Boolean(this.opts.approvals);

    // A run is resumed only by the session that started it. A resume cannot change a run's tools or cwd, and the thread
    // record is keyed by thread alone: letting a different policy continue it would hand them the other's permissions
    // (or, writing a fresh run over it, take the other's thread away). Nothing is started.
    if (rec && (rec.policy ?? '') !== (policy?.userId ?? '')) {
      rails.audit.record('run.refused', { ...base, kind: 'thread', reason: 'thread_policy_mismatch', run_id: rec.run_id });
      turn.finished = true;
      this.endTurn(turn);
      await this.say(post.channel_id, rootId, 'This thread was started by a session with different permissions, so I will not continue it here. Start a new message of your own instead.');
      return;
    }

    // A policy session is started or resumed only on a daemon that says it enforces `toolPolicy` (checked live, every time):
    // otherwise the field would be dropped and the run would have every tool the account has. Nothing is started.
    if (policy) {
      let guard: { ok: true } | { ok: false; reason: string };
      try {
        guard = (await this.opts.policyGuard?.()) ?? { ok: false, reason: 'no policy guard is configured' };
      } catch (err) {
        guard = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      if (!guard.ok) {
        rails.audit.record('run.refused', { ...base, kind: rec ? 'resume' : 'thread', reason: 'policy_capability_missing', detail: guard.reason, run_id: rec?.run_id });
        turn.finished = true;
        this.endTurn(turn);
        await this.say(post.channel_id, rootId, 'I cannot run this: the Ikenga daemon does not report that it enforces tool limits for this kind of session, so nothing was started. Ask the operator to upgrade the daemon.');
        return;
      }
    }

    // The policy's cwd is the session's read boundary: walked again now, before every start and resume (it is cheap), and
    // refused if anything in it could be read through (a symlink that appeared since load, a FIFO, a hard link ...).
    if (policy) {
      const tree = this.policyCwdCheck(policy, base, rec ? 'resume' : 'thread', rec?.run_id);
      if (!tree.ok) {
        turn.finished = true;
        this.endTurn(turn);
        await this.say(post.channel_id, rootId, 'I cannot run this: the working directory for this kind of session failed its safety check, so nothing was started. Ask the operator to look at the audit log.');
        return;
      }
    }

    // Say something straight away; the engine can take a while to boot.
    const working = await this.opts.client.reply(post.channel_id, 'Working…', rootId);
    turn.progressPostId = working.id;

    let notice: string | undefined;
    let record: ThreadRecord | undefined;
    let result: ChiRunResult | undefined;

    // A resume cannot change a run's permission mode. Under approvals only a run
    // that was itself started in plan mode may be resumed; anything else (a B2
    // thread, or one from before approvals were switched on) could write.
    if (rec && gated && rec.mode !== PLAN_MODE) {
      notice =
        'The earlier run in this thread was not started under approvals, so I cannot safely continue it. I started a fresh read-only run; it will not remember the earlier messages.';
      rec = undefined;
    }

    // B5: a resume cannot change a run's mode, so a stored run above the ceiling (or from before modes were
    // recorded, which the daemon ran as `default`) is never resumed. This is the resume-side mode rail.
    // The mode that really applies depends on the engine the run was STARTED on (a resume cannot change it): a stored
    // run on an engine that ignores modes, or with no recorded engine, is unrestricted.
    if (rec && modeRank(effectiveMode(rec.engine, rec.mode)) > modeRank(rails.maxMode)) {
      rails.audit.record('run.refused', {
        ...base,
        kind: 'resume',
        reason: 'mode_exceeds_max',
        run_id: rec.run_id,
        engine: rec.engine,
        requested_mode: rec.mode ?? 'default',
        effective_mode: effectiveMode(rec.engine, rec.mode),
        max_mode: rails.maxMode,
      });
      notice =
        'The earlier run in this thread has more permissions than this bot is now allowed (maxMode), so I cannot continue it. I started a fresh run; it will not remember the earlier messages.';
      rec = undefined;
    }

    if (rec) {
      try {
        const auth = rails.authorizeRun({ kind: 'resume', engine: rec.engine, mode: rec.mode, fields: { ...base, run_id: rec.run_id } });
        turn.requestId = auth.requestId;
        turn.mode = auth.mode;
        turn.engine = auth.engine;
        await this.takeSlot(turn, 'resume');
        if (policy) this.policyCwdMustBeSafe(policy, base, 'resume', rec.run_id); // the wait for a slot can be long: once more, immediately before
        const carry = rec.carry ? `[What happened since your last turn: an approved run carried out your plan. Its report follows.]\n${rec.carry}\n\n---\n\n` : '';
        result = await daemon.chiResume(rec.run_id, `${carry}${text}${gated ? PLAN_NOTE + rails.branchNote() : ''}`);
        if (rec.carry) await store.update(rootId, { carry: '' });
        record = rec;
        rails.audit.record('run.resumed', { ...base, request_id: turn.requestId, run_id: rec.run_id, kind: 'resume', engine: turn.engine, mode: turn.mode, queue_wait_s: turn.queueWaitS });
      } catch (err) {
        if (err instanceof RunWaitAbortedError || err instanceof RunGateClosedError) throw err; // not a daemon answer
        if (err instanceof DaemonError && err.runGone) {
          notice =
            'I could not continue the earlier run for this thread (it has expired or was removed), so I started a fresh one. It will not remember the earlier messages.';
        } else if (err instanceof DaemonError && err.runStillRunning) {
          // The daemon is still running the previous turn (e.g. the bridge
          // restarted). Watch that run rather than start a second writer.
          notice = 'The previous message in this thread is still being worked on; I am following that run.';
          result = { run_id: rec.run_id, status: 'running' };
          record = rec;
          rails.audit.record('run.resumed', { ...base, request_id: turn.requestId, run_id: rec.run_id, kind: 'resume', engine: turn.engine, mode: turn.mode, attached: true, queue_wait_s: turn.queueWaitS });
        } else {
          throw err;
        }
      }
    } else if (isReply && !notice) {
      notice =
        'I have no earlier run for this thread (it may predate me or have been cleared), so I started a new one with just this message.';
    }

    if (!record) {
      const prompt = this.withPrefix(gated ? `${text}${PLAN_NOTE}${rails.branchNote()}` : text, policy);
      // Under approvals the thread is always read-only; a policy user's session runs in the policy's mode; otherwise
      // `chi.mode`, which is `plan` when unset (B5).
      const mode = gated ? PLAN_MODE : (policy ? policy.mode : rails.threadMode);
      const auth = rails.authorizeRun({ kind: 'thread', engine: chi.engine, mode, fields: base });
      turn.requestId = auth.requestId;
      turn.mode = auth.mode;
      turn.engine = auth.engine;
      // After the fallback from a resume that found its run gone the turn already holds its slot (that call started nothing).
      await this.takeSlot(turn, 'thread');
      if (policy) this.policyCwdMustBeSafe(policy, base, 'thread'); // the wait for a slot can be long: once more, immediately before
      result = await daemon.chiRun({
        engineId: chi.engine,
        prompt,
        cwd: policy ? policy.cwd : chi.cwd,
        model: chi.model,
        mode,
        timeoutSeconds: chi.timeoutSeconds,
        persistent: chi.persistent ?? true,
        ...(policy ? { toolPolicy: policy.toolPolicy } : {}),
      });
      requireRunId(result);
      rails.audit.record('run.started', { ...base, request_id: turn.requestId, run_id: result.run_id, kind: 'thread', engine: auth.engine, mode: auth.mode, queue_wait_s: turn.queueWaitS });
      const t = this.now();
      record = {
        root_id: rootId,
        run_id: result.run_id,
        bot: this.opts.bot,
        channel_id: post.channel_id,
        brief: prompt,
        mode,
        engine: chi.engine,
        ...(policy ? { policy: policy.userId } : {}),
        created_at: t,
        updated_at: t,
      };
      await store.put(record);
    }

    const started = result as ChiRunResult;
    turn.runId = started.run_id;
    // A non-fatal warning rides in `error` while the status is still running
    // (for example "persistent run fell back to in-process").
    if (started.error && !TERMINAL_STATUSES.has(started.status)) {
      this.log(`run ${started.run_id}: ${this.opts.daemon.redact(started.error)}`);
    }

    await store.update(rootId, {
      active: { run_id: started.run_id, progress_post_id: working.id, started_at: turn.startedAt, notice, kind: 'plan', by, mode: turn.mode, engine: turn.engine },
    });

    if (notice) await this.edit(working.id, `${notice}\n\n${this.statusLine('running', turn)}`);

    if (turn.cancelRequested) {
      // "stop" arrived while the run was still starting.
      await this.cancelRun(turn);
      return;
    }

    const fresh = store.get(rootId) as ThreadRecord;
    turn.done = this.track(turn, fresh, notice);
  }

  /** Walk the policy cwd; on a problem write `policy.cwd_unsafe` (the first offending path, never contents) and return the result. */
  private policyCwdCheck(policy: ResolvedUserPolicy, base: Record<string, string | number | boolean | undefined | null | string[]>, kind: 'thread' | 'resume', runId?: string): CwdCheck {
    let tree: CwdCheck;
    try {
      tree = checkPolicyCwd(policy.cwd);
    } catch {
      tree = { ok: false, code: 'unreadable', path: '.', detail: 'the check itself failed' };
    }
    if (!tree.ok) {
      this.opts.rails.audit.record('policy.cwd_unsafe', {
        thread_root: base.thread_root as string,
        channel_id: base.channel_id as string,
        user_id: base.user_id as string,
        policy: policy.label,
        kind,
        reason: tree.code,
        path: tree.path,
        run_id: runId,
      });
      this.log(`policy '${policy.label}': cwd is unsafe (${tree.code} at ${JSON.stringify(tree.path)}); no run started`);
    }
    return tree;
  }

  private policyCwdMustBeSafe(policy: ResolvedUserPolicy, base: Record<string, string | number | boolean | undefined | null | string[]>, kind: 'thread' | 'resume', runId?: string): void {
    if (!this.policyCwdCheck(policy, base, kind, runId).ok) throw new Error('the working directory for this kind of session failed its safety check (see the audit log)');
  }

  private async failStart(turn: Turn, err: unknown): Promise<void> {
    const cancelledInQueue = err instanceof RunWaitAbortedError && turn.cancelRequested;
    const msg = this.errText(err);
    this.log(`start failed for thread ${turn.rootId}: ${msg}`);
    if (turn.requestId) {
      // Authorized and recorded, but the daemon never produced a run: say so, so `*.requested` is not left dangling.
      // The daemon may have created a row before it failed (seen live: an engine it refuses to launch), but a failed
      // `chi_run` hands back no run id. Say which case this is, so a `chi_list` row with no audit twin is explained.
      this.opts.rails.audit.record('run.start_failed', {
        request_id: turn.requestId,
        thread_root: turn.rootId,
        kind: turn.kind === 'act' ? 'act' : 'thread',
        engine: turn.engine,
        mode: turn.mode,
        run_id: turn.runId,
        run_unjoined: turn.runId === undefined,
        error_kind: err instanceof DaemonError ? err.kind : cancelledInQueue ? 'cancelled_in_queue' : isGateStop(err) ? 'gate_stopped' : 'error',
      });
    }
    this.endTurn(turn);
    turn.finished = true;
    const text = cancelledInQueue ? 'Cancelled while queued. Nothing was run.' : `I could not start the run: ${msg}`;
    if (turn.progressPostId) {
      await this.edit(turn.progressPostId, text);
    } else {
      await this.say(turn.channelId, turn.rootId, text);
    }
    await this.opts.store.update(turn.rootId, { active: undefined }).catch(() => undefined);
  }

  // ── watching a run ───────────────────────────────────────────────────────

  /**
   * Poll `chi_status` with backoff, keep the progress post current (rate
   * limited), and post the outcome when the run ends.
   */
  private async track(turn: Turn, rec: ThreadRecord, notice?: string): Promise<void> {
    const { daemon } = this.opts;
    const p = this.progress;
    const runId = turn.runId as string;
    const progressId = turn.progressPostId as string;
    if (notice) turn.notice = notice;
    let delay = p.pollMinMs;
    let failures = 0;
    let lastEdit = this.now();
    let lastText: string | undefined;

    try {
      while (!turn.abort.signal.aborted) {
        await sleep(delay, turn.abort.signal);
        if (turn.abort.signal.aborted) return;

        let st: ChiRunResult;
        try {
          st = await daemon.chiStatus(runId);
          failures = 0;
        } catch (err) {
          if (err instanceof DaemonError && err.runGone) {
            this.releaseSlot(turn);
            await this.finish(turn, progressId, 'The run is no longer on the daemon (it expired or was removed).', undefined, true, 'run_gone');
            return;
          }
          failures += 1;
          this.log(`status poll for ${runId} failed (${failures}/${p.maxPollFailures}): ${this.errText(err)}`);
          if (failures >= p.maxPollFailures) {
            this.releaseSlot(turn);
            await this.finish(
              turn,
              progressId,
              'Lost contact with the Ikenga daemon, so I cannot tell how this run ended.',
              `Run \`${runId}\` may still be going; check Ikenga's Chi view. Last error: ${this.errText(err)}`,
              false,
              'lost_contact',
            );
            return;
          }
          delay = Math.min(Math.ceil(delay * 1.5), p.pollMaxMs);
          continue;
        }

        if (TERMINAL_STATUSES.has(st.status)) {
          // The run is over: free its slot before the (possibly slow) posts, not after.
          this.releaseSlot(turn);
          await this.finishWithStatus(turn, progressId, st, rec);
          return;
        }

        const elapsed = this.now() - turn.startedAt;
        if (elapsed > p.maxWaitMs) {
          this.releaseSlot(turn);
          await this.finish(
            turn,
            progressId,
            'Still running, but I have stopped watching it.',
            `Run \`${runId}\` is still going on the daemon; follow it in Ikenga's Chi view.`,
            false,
            'unwatched',
          );
          return;
        }

        const text = this.progressText(st.status, elapsed, notice);
        if (text !== lastText && this.now() - lastEdit >= p.editIntervalMs) {
          await this.edit(progressId, text);
          lastText = text;
          lastEdit = this.now();
        }
        delay = Math.min(Math.ceil(delay * 1.5), p.pollMaxMs);
      }
    } catch (err) {
      // Never let a watcher die silently.
      this.log(`watcher for ${runId} crashed: ${this.errText(err)}`);
      if (!turn.finished) {
        turn.finished = true;
      }
      this.endTurn(turn);
    }
  }

  private async finishWithStatus(turn: Turn, progressId: string, st: ChiRunResult, rec: ThreadRecord): Promise<void> {
    const secs = secondsSince(turn.startedAt, this.now());
    const error = st.error ? this.opts.daemon.redact(st.error) : undefined;
    const output = this.usableOutput(st.output, rec);
    const trunc = st.output_truncated ? '\n\n(The daemon marked this output as truncated.)' : '';

    // The thread's next plan turn cannot remember an approved run: hand it the report.
    if (turn.kind === 'act') {
      const report = output
        ? `Run ${st.run_id} ended ${st.status}. Its report:\n${output.slice(0, CARRY_CHARS)}`
        : `Run ${st.run_id} ended ${st.status}${error ? `: ${error}` : ''}.`;
      await this.opts.store.update(turn.rootId, { carry: report }).catch(() => undefined);
    }

    switch (st.status) {
      case 'done': {
        const body = output
          ? `${output}${trunc}`
          : `The run finished, but the daemon returned no result text for it. Run \`${st.run_id}\` is in Ikenga's Chi view.`;
        await this.finish(turn, progressId, `Done in ${secs}s.`, body, true, 'done');
        if (turn.kind === 'plan' && this.opts.approvals && output) {
          await this.offerApproval(turn, output, Boolean(st.output_truncated));
        }
        return;
      }
      case 'cancelled':
        await this.finish(turn, progressId, `Cancelled after ${secs}s.`, 'Run cancelled.', true, 'cancelled');
        return;
      case 'timed_out':
        await this.finish(
          turn,
          progressId,
          `Timed out after ${secs}s.`,
          [`The run timed out.${error ? ` ${error}` : ''}`, output ? `Partial output:\n\n${output}` : ''].filter(Boolean).join('\n\n'),
          true,
          'timed_out',
        );
        return;
      default:
        await this.finish(
          turn,
          progressId,
          `Failed after ${secs}s.`,
          [`The run failed: ${error ?? 'the daemon gave no reason'}.`, output ? `Partial output:\n\n${output}` : ''].filter(Boolean).join('\n\n'),
          true,
          'failed',
        );
    }
  }

  /**
   * Close out a turn: post the body (plus the summary as an italic footer) as a
   * new reply so people are notified, then delete the progress post. With no body, when the run may still be
   * going (`clearActive` false), or if posting or deleting fails, the progress post is edited to the summary instead. `clearActive`
   * is false when the run may still be going and a restart should keep
   * watching.
   */
  private async finish(
    turn: Turn,
    progressId: string,
    summary: string,
    body: string | undefined,
    clearActive: boolean,
    outcome: string,
  ): Promise<void> {
    if (turn.finished) return;
    turn.finished = true;
    this.opts.rails.audit.record('run.finished', {
      run_id: turn.runId,
      thread_root: turn.rootId,
      kind: turn.kind === 'act' ? 'act' : 'thread',
      engine: turn.engine,
      mode: turn.mode,
      status: outcome,
      duration_s: secondsSince(turn.startedAt, this.now()),
    });
    try {
      if (clearActive) await this.opts.store.update(turn.rootId, { active: undefined }).catch(() => undefined);
      const summaryText = turn.notice ? `${turn.notice}\n\n${summary}` : summary;
      if (!body || !clearActive) {
        // No answer, or the run may still be going: a restart re-attaches to the progress post, so keep it.
        await this.edit(progressId, summaryText);
        if (body) await this.say(turn.channelId, turn.rootId, body);
      } else {
        // The answer goes first, as a new post (notifies), then the progress post is removed, so the
        // thread never reads "Done" above its own answer.
        const answer = `${turn.notice ? `${turn.notice}\n\n` : ''}${body}\n\n_${summary}_`;
        const posted = await this.say(turn.channelId, turn.rootId, answer);
        if (!posted) {
          await this.edit(progressId, summaryText);
        } else {
          try {
            await this.opts.client.deletePost(progressId);
          } catch (err) {
            this.log(`could not delete progress post ${progressId}: ${this.errText(err)}`);
            await this.edit(progressId, summaryText);
          }
        }
      }
    } finally {
      this.endTurn(turn);
    }
  }

  /** Post the approval request under a finished plan. Never throws: the plan is already in the thread. */
  private async offerApproval(turn: Turn, plan: string, truncated: boolean): Promise<void> {
    const gate = this.opts.approvals;
    if (!gate) return;
    if (truncated) {
      // Approving would run a plan the approver never saw in full.
      await this.say(turn.channelId, turn.rootId, 'The daemon truncated that plan, so I am not offering it for approval. Ask for a shorter plan.');
      return;
    }
    try {
      await gate.manager.request({ rootId: turn.rootId, channelId: turn.channelId, planRunId: turn.runId as string, plan, requester: turn.by });
    } catch (err) {
      this.log(`could not post the approval request for ${turn.runId}: ${this.errText(err)}`);
    }
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  private async cancel(rootId: string, channelId: string, turn: Turn | undefined, by: Who): Promise<void> {
    if (!turn) {
      if (await this.opts.approvals?.manager.withdraw(rootId, 'cancelled by a reply', 'cancelled')) {
        await this.say(channelId, rootId, 'Plan withdrawn. Nothing was run.');
        return;
      }
      await this.say(channelId, rootId, 'Nothing is running in this thread.');
      return;
    }
    turn.cancelRequested = true;
    turn.cancelledBy = by;
    turn.queueAbort.abort(); // leaves the queue if it is waiting there; a no-op otherwise
    if (!turn.runId) return; // still starting; `start` cancels once it has a run id
    await this.cancelRun(turn);
  }

  private async cancelRun(turn: Turn): Promise<void> {
    const runId = turn.runId as string;
    try {
      await this.opts.daemon.chiCancel(runId);
    } catch (err) {
      if (!(err instanceof DaemonError && err.runGone)) {
        turn.cancelRequested = false;
        await this.say(
          turn.channelId,
          turn.rootId,
          `I could not cancel the run: ${this.errText(err)}. It may still be going.`,
        );
        if (!turn.done) turn.done = this.track(turn, this.opts.store.get(turn.rootId) as ThreadRecord);
        return;
      }
    }
    if (turn.finished) return;
    turn.finished = true;
    turn.abort.abort();
    const by = turn.cancelledBy;
    this.opts.rails.audit.record('run.cancelled', {
      run_id: runId,
      thread_root: turn.rootId,
      kind: turn.kind === 'act' ? 'act' : 'thread',
      engine: turn.engine,
      mode: turn.mode,
      user_id: by?.id,
      user_name: by?.name,
    });
    try {
      await this.opts.store.update(turn.rootId, { active: undefined }).catch(() => undefined);
      const secs = secondsSince(turn.startedAt, this.now());
      const summary = `Cancelled after ${secs}s.`;
      // Same order as `finish`: the acknowledgement first (notifies), then the progress post goes.
      const posted = await this.say(turn.channelId, turn.rootId, `Run cancelled.\n\n_${summary}_`);
      if (turn.progressPostId) {
        if (!posted) {
          await this.edit(turn.progressPostId, summary);
        } else {
          try {
            await this.opts.client.deletePost(turn.progressPostId);
          } catch (err) {
            this.log(`could not delete progress post ${turn.progressPostId}: ${this.errText(err)}`);
            await this.edit(turn.progressPostId, summary);
          }
        }
      }
    } finally {
      this.endTurn(turn);
    }
  }

  // ── concurrency slots ────────────────────────────────────────────────────

  /**
   * Take the bridge-wide slot for this turn before it calls `chi_run` / `chi_resume`. Idempotent: a turn that already
   * holds one (a resume that found its run gone and falls back to a fresh run) keeps it. When the bridge is full the
   * progress post says so (once) and the turn waits its turn, FIFO; it goes back to "Working…" when it starts.
   */
  private async takeSlot(turn: Turn, kind: 'thread' | 'resume' | 'act'): Promise<void> {
    if (turn.slot) return;
    let notice: Promise<void> | undefined;
    let slot: RunSlot;
    try {
      slot = await this.opts.runGate.acquire(
        { bot: this.opts.bot, kind },
        {
          signal: turn.queueAbort.signal,
          onQueued: ({ ahead, max }) => {
            const place = ahead === 0 ? 'This one is next.' : `${ahead} queued ahead of this one.`;
            const text = `Queued: ${max} run${max === 1 ? ' is' : 's are'} already going on this bridge. ${place} I will start it as soon as one finishes. Reply \`stop\` to cancel.`;
            notice = turn.progressPostId ? this.edit(turn.progressPostId, text) : this.say(turn.channelId, turn.rootId, text).then(() => undefined);
          },
        },
      );
    } catch (err) {
      // Let the "Queued" edit land first, or it can overwrite the cancellation text that follows.
      await notice;
      throw err;
    }
    turn.slot = slot;
    await notice;
    if (turn.abort.signal.aborted) {
      // The bridge stopped while the grant was in flight.
      this.releaseSlot(turn);
      throw new RunGateClosedError();
    }
    if (notice) {
      const waitedS = Math.round(slot.waitedMs / 1000);
      turn.queueWaitS = waitedS;
      turn.startedAt = this.now(); // the wait is not the run's time (maxWaitMs, "Done in Ns")
      if (turn.progressPostId) await this.edit(turn.progressPostId, 'Working…');
    }
  }

  private releaseSlot(turn: Turn): void {
    turn.slot?.release();
  }

  /** The one place a turn leaves `turns`: it also gives back its slot, so no exit path can forget to. */
  private endTurn(turn: Turn): void {
    if (this.turns.get(turn.rootId) === turn) this.turns.delete(turn.rootId);
    turn.slot?.release();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private withPrefix(text: string, policy?: ResolvedUserPolicy): string {
    const prefix = (policy?.systemPrompt ?? this.opts.chi.systemPrompt)?.trim();
    return prefix ? `${prefix}\n\n---\n\n${text}` : text;
  }

  private stripMention(message: string): string {
    if (!this.botUsername) return message;
    const name = this.botUsername.replace(/^@/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return message.replace(new RegExp(`^\\s*@${name}\\b[\\s:,]*`, 'i'), '');
  }

  /** `chi_status.output` unless it is just the prompt echoed back as the run's `brief`. */
  private usableOutput(output: string | null | undefined, rec: ThreadRecord): string | undefined {
    const text = output?.trim();
    if (!text) return undefined;
    if (text === rec.brief.trim()) return undefined;
    return this.opts.daemon.redact(text);
  }

  private statusLine(status: string, turn: Turn): string {
    return this.progressText(status, this.now() - turn.startedAt);
  }

  private progressText(status: string, elapsedMs: number, notice?: string): string {
    const secs = Math.max(0, Math.round(elapsedMs / 1000));
    const line =
      status === 'awaiting_auth'
        ? `Waiting for the engine to sign in on the Ikenga host (${secs}s). A person needs to authenticate it.`
        : status === 'queued'
          ? `Queued (${secs}s)…`
          : `Working… (${secs}s)`;
    return notice ? `${notice}\n\n${line}` : line;
  }

  private errText(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.opts.daemon.redact(raw);
  }

  private async edit(postId: string, text: string): Promise<void> {
    try {
      await this.opts.client.updatePost(postId, text.slice(0, MAX_POST_CHARS));
    } catch (err) {
      this.log(`could not edit post ${postId}: ${this.errText(err)}`);
    }
  }

  /** Post `text` as reply(s). Resolves true only if every chunk was posted. */
  private async say(channelId: string, rootId: string, text: string): Promise<boolean> {
    for (const chunk of chunkText(text, MAX_POST_CHARS)) {
      try {
        await this.opts.client.reply(channelId, chunk, rootId);
      } catch (err) {
        this.log(`could not post reply in ${rootId}: ${this.errText(err)}`);
        return false;
      }
    }
    return true;
  }
}

/** `chi_run` is supposed to answer with a run id. Without one there is nothing to follow: fail the start (and free the slot). */
function requireRunId(result: ChiRunResult | undefined): void {
  if (!result || typeof result.run_id !== 'string' || !result.run_id) throw new Error('the daemon answered without a run id');
}

export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

function secondsSince(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 1000));
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
