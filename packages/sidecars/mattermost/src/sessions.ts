import { PLAN_MODE } from './approvals.js';
import type { ApprovalManager, ApprovalRecord } from './approvals.js';
import { DaemonError, TERMINAL_STATUSES } from './daemon.js';
import type { ChiRunResult, DaemonClient } from './daemon.js';
import type { ThreadRecord, ThreadStore } from './store.js';
import type { BotChiConfig, MattermostPost, ProgressConfig } from './types.js';

/** The slice of the Mattermost client the router needs. */
export interface PostApi {
  reply(channelId: string, message: string, rootId?: string): Promise<MattermostPost>;
  updatePost(postId: string, message: string): Promise<MattermostPost>;
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
const MAX_POST_CHARS = 15_000;

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
  finished: boolean;
  abort: AbortController;
  /** Kept through to the final summary so it isn't edited away. */
  notice?: string;
  done?: Promise<void>;
}

export interface RouterOptions {
  bot: string;
  client: PostApi;
  daemon: ChiApi;
  store: ThreadStore;
  chi: BotChiConfig;
  progress?: ProgressConfig;
  /**
   * B3. When set, thread turns run in plan mode and an approved plan runs once, in
   * `actingMode`. Unset keeps the B2 behaviour (`chi.mode`, no gate).
   */
  approvals?: { manager: ApprovalManager; actingMode: string };
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

  stop(): void {
    for (const t of this.turns.values()) t.abort.abort();
  }

  async handle(post: MattermostPost): Promise<void> {
    const rootId = post.root_id || post.id;
    const isReply = Boolean(post.root_id);
    const text = this.stripMention(post.message).trim();
    if (!text) return;

    const existing = this.turns.get(rootId);

    if (isReply && CANCEL_RE.test(text)) {
      await this.cancel(rootId, post.channel_id, existing);
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
      finished: false,
      abort: new AbortController(),
    };
    this.turns.set(rootId, turn);

    try {
      // A new message supersedes a plan still waiting for a decision: an approver
      // must not be able to 👍 a plan the conversation has moved past.
      await this.opts.approvals?.manager.withdraw(rootId, 'a newer message arrived in this thread');
      await this.start(turn, post, text, isReply);
    } catch (err) {
      await this.failStart(turn, err);
    }
  }

  /** Re-attach to turns that were in flight when the bridge last stopped. */
  recover(): void {
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
        finished: false,
        abort: new AbortController(),
      };
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
  async runApproved(a: ApprovalRecord, approver: string): Promise<void> {
    const gate = this.opts.approvals;
    if (!gate) return;
    const { daemon, store, chi } = this.opts;
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
      finished: false,
      abort: new AbortController(),
    };
    this.turns.set(rootId, turn);
    try {
      const working = await this.opts.client.reply(a.channel_id, 'Working…', rootId);
      turn.progressPostId = working.id;
      const prompt = this.withPrefix(
        `The plan below was approved by @${approver} in Mattermost. Carry it out now, exactly as written, and do not widen its scope. Then report briefly what you did and anything that failed.\n\n--- approved plan ---\n${a.plan}`,
      );
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
      turn.runId = result.run_id;
      const thread = store.get(rootId);
      if (!thread) throw new Error('the thread record is gone');
      await store.update(rootId, {
        active: { run_id: result.run_id, progress_post_id: working.id, started_at: turn.startedAt, kind: 'act', brief: prompt },
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

  private async start(turn: Turn, post: MattermostPost, text: string, isReply: boolean): Promise<void> {
    const { daemon, store, chi } = this.opts;
    const rootId = turn.rootId;
    // Ignore a record from another channel (defence in depth; Mattermost
    // already keeps a reply's root in its own channel).
    const stored = store.get(rootId);
    let rec = stored && stored.channel_id === post.channel_id ? stored : undefined;
    const gated = Boolean(this.opts.approvals);

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

    if (rec) {
      try {
        const carry = rec.carry ? `[What happened since your last turn: an approved run carried out your plan. Its report follows.]\n${rec.carry}\n\n---\n\n` : '';
        result = await daemon.chiResume(rec.run_id, `${carry}${text}${gated ? PLAN_NOTE : ''}`);
        if (rec.carry) await store.update(rootId, { carry: '' });
        record = rec;
      } catch (err) {
        if (err instanceof DaemonError && err.runGone) {
          notice =
            'I could not continue the earlier run for this thread (it has expired or was removed), so I started a fresh one. It will not remember the earlier messages.';
        } else if (err instanceof DaemonError && err.runStillRunning) {
          // The daemon is still running the previous turn (e.g. the bridge
          // restarted). Watch that run rather than start a second writer.
          notice = 'The previous message in this thread is still being worked on; I am following that run.';
          result = { run_id: rec.run_id, status: 'running' };
          record = rec;
        } else {
          throw err;
        }
      }
    } else if (isReply && !notice) {
      notice =
        'I have no earlier run for this thread (it may predate me or have been cleared), so I started a new one with just this message.';
    }

    if (!record) {
      const prompt = this.withPrefix(gated ? `${text}${PLAN_NOTE}` : text);
      const mode = gated ? PLAN_MODE : chi.mode;
      result = await daemon.chiRun({
        engineId: chi.engine,
        prompt,
        cwd: chi.cwd,
        model: chi.model,
        mode,
        timeoutSeconds: chi.timeoutSeconds,
        persistent: chi.persistent ?? true,
      });
      const t = this.now();
      record = {
        root_id: rootId,
        run_id: result.run_id,
        bot: this.opts.bot,
        channel_id: post.channel_id,
        brief: prompt,
        mode,
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
      active: { run_id: started.run_id, progress_post_id: working.id, started_at: turn.startedAt, notice, kind: 'plan' },
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

  private async failStart(turn: Turn, err: unknown): Promise<void> {
    const msg = this.errText(err);
    this.log(`start failed for thread ${turn.rootId}: ${msg}`);
    this.turns.delete(turn.rootId);
    turn.finished = true;
    const text = `I could not start the run: ${msg}`;
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
            await this.finish(turn, progressId, 'The run is no longer on the daemon (it expired or was removed).', undefined, true);
            return;
          }
          failures += 1;
          this.log(`status poll for ${runId} failed (${failures}/${p.maxPollFailures}): ${this.errText(err)}`);
          if (failures >= p.maxPollFailures) {
            await this.finish(
              turn,
              progressId,
              'Lost contact with the Ikenga daemon, so I cannot tell how this run ended.',
              `Run \`${runId}\` may still be going; check Ikenga's Chi view. Last error: ${this.errText(err)}`,
              false,
            );
            return;
          }
          delay = Math.min(Math.ceil(delay * 1.5), p.pollMaxMs);
          continue;
        }

        if (TERMINAL_STATUSES.has(st.status)) {
          await this.finishWithStatus(turn, progressId, st, rec);
          return;
        }

        const elapsed = this.now() - turn.startedAt;
        if (elapsed > p.maxWaitMs) {
          await this.finish(
            turn,
            progressId,
            'Still running, but I have stopped watching it.',
            `Run \`${runId}\` is still going on the daemon; follow it in Ikenga's Chi view.`,
            false,
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
        this.turns.delete(turn.rootId);
      }
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
        await this.finish(turn, progressId, `Done in ${secs}s.`, body, true);
        if (turn.kind === 'plan' && this.opts.approvals && output) {
          await this.offerApproval(turn, output, Boolean(st.output_truncated));
        }
        return;
      }
      case 'cancelled':
        await this.finish(turn, progressId, `Cancelled after ${secs}s.`, 'Run cancelled.', true);
        return;
      case 'timed_out':
        await this.finish(
          turn,
          progressId,
          `Timed out after ${secs}s.`,
          [`The run timed out.${error ? ` ${error}` : ''}`, output ? `Partial output:\n\n${output}` : ''].filter(Boolean).join('\n\n'),
          true,
        );
        return;
      default:
        await this.finish(
          turn,
          progressId,
          `Failed after ${secs}s.`,
          [`The run failed: ${error ?? 'the daemon gave no reason'}.`, output ? `Partial output:\n\n${output}` : ''].filter(Boolean).join('\n\n'),
          true,
        );
    }
  }

  /**
   * Close out a turn: summarise in the progress post (edits do not notify),
   * then post the body as a new reply so people are notified. `clearActive`
   * is false when the run may still be going and a restart should keep
   * watching.
   */
  private async finish(
    turn: Turn,
    progressId: string,
    summary: string,
    body: string | undefined,
    clearActive: boolean,
  ): Promise<void> {
    if (turn.finished) return;
    turn.finished = true;
    try {
      if (clearActive) await this.opts.store.update(turn.rootId, { active: undefined }).catch(() => undefined);
      await this.edit(progressId, turn.notice ? `${turn.notice}\n\n${summary}` : summary);
      if (body) await this.say(turn.channelId, turn.rootId, body);
    } finally {
      this.turns.delete(turn.rootId);
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
      await gate.manager.request({ rootId: turn.rootId, channelId: turn.channelId, planRunId: turn.runId as string, plan });
    } catch (err) {
      this.log(`could not post the approval request for ${turn.runId}: ${this.errText(err)}`);
    }
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  private async cancel(rootId: string, channelId: string, turn: Turn | undefined): Promise<void> {
    if (!turn) {
      if (await this.opts.approvals?.manager.withdraw(rootId, 'cancelled by a reply')) {
        await this.say(channelId, rootId, 'Plan withdrawn. Nothing was run.');
        return;
      }
      await this.say(channelId, rootId, 'Nothing is running in this thread.');
      return;
    }
    turn.cancelRequested = true;
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
    try {
      await this.opts.store.update(turn.rootId, { active: undefined }).catch(() => undefined);
      const secs = secondsSince(turn.startedAt, this.now());
      if (turn.progressPostId) await this.edit(turn.progressPostId, `Cancelled after ${secs}s.`);
      await this.say(turn.channelId, turn.rootId, 'Run cancelled.');
    } finally {
      this.turns.delete(turn.rootId);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private withPrefix(text: string): string {
    const prefix = this.opts.chi.systemPrompt?.trim();
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

  private async say(channelId: string, rootId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text, MAX_POST_CHARS)) {
      try {
        await this.opts.client.reply(channelId, chunk, rootId);
      } catch (err) {
        this.log(`could not post reply in ${rootId}: ${this.errText(err)}`);
        return;
      }
    }
  }
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
