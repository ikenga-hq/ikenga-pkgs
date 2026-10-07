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

interface Turn {
  rootId: string;
  channelId: string;
  runId?: string;
  progressPostId?: string;
  startedAt: number;
  cancelRequested: boolean;
  finished: boolean;
  abort: AbortController;
  done?: Promise<void>;
}

export interface RouterOptions {
  bot: string;
  client: PostApi;
  daemon: ChiApi;
  store: ThreadStore;
  chi: BotChiConfig;
  progress?: ProgressConfig;
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
      rootId,
      channelId: post.channel_id,
      startedAt: this.now(),
      cancelRequested: false,
      finished: false,
      abort: new AbortController(),
    };
    this.turns.set(rootId, turn);

    try {
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
      turn.done = this.track(turn, rec, active.notice);
    }
  }

  // ── starting / resuming ────────────────────────────────────────────────────

  private async start(turn: Turn, post: MattermostPost, text: string, isReply: boolean): Promise<void> {
    const { daemon, store, chi } = this.opts;
    const rootId = turn.rootId;
    const rec = store.get(rootId);

    // Say something straight away; the engine can take a while to boot.
    const working = await this.opts.client.reply(post.channel_id, 'Working…', rootId);
    turn.progressPostId = working.id;

    let notice: string | undefined;
    let record: ThreadRecord | undefined;
    let result: ChiRunResult | undefined;

    if (rec) {
      try {
        result = await daemon.chiResume(rec.run_id, text);
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
    } else if (isReply) {
      notice =
        'I have no earlier run for this thread (it may predate me or have been cleared), so I started a new one with just this message.';
    }

    if (!record) {
      const prompt = this.withPrefix(text);
      result = await daemon.chiRun({
        engineId: chi.engine,
        prompt,
        cwd: chi.cwd,
        model: chi.model,
        mode: chi.mode,
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
      active: { run_id: started.run_id, progress_post_id: working.id, started_at: turn.startedAt, notice },
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

    switch (st.status) {
      case 'done': {
        const body = output
          ? `${output}${trunc}`
          : `The run finished, but the daemon returned no result text for it. Run \`${st.run_id}\` is in Ikenga's Chi view.`;
        await this.finish(turn, progressId, `Done in ${secs}s.`, body, true);
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
      await this.edit(progressId, summary);
      if (body) await this.say(turn.channelId, turn.rootId, body);
    } finally {
      this.turns.delete(turn.rootId);
    }
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  private async cancel(rootId: string, channelId: string, turn: Turn | undefined): Promise<void> {
    if (!turn) {
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
