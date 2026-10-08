import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PLAN_MODE } from './approvals.js';
import { ChannelLookupError } from './client.js';
import { minuteFloor, nextRun, occurrencesBetween, parseCron } from './cron.js';
import type { CronSpec } from './cron.js';
import { DaemonError, TERMINAL_STATUSES } from './daemon.js';
import type { ChiRunResult, DaemonClient } from './daemon.js';
import type { Rails } from './rails.js';
import { MAX_POST_CHARS, PROGRESS_DEFAULTS, chunkText, sleep } from './sessions.js';
import type { ResolvedProgress } from './sessions.js';
import type { BotChiConfig, MattermostPost, ProgressConfig, ScheduleConfig, SchedulerOptions } from './types.js';

/**
 * B4 scheduled posts. At each due time (cron, UTC) a bot starts a Chi run of the schedule's task and posts the
 * result as a new root post in the schedule's channel.
 *
 * Two rules are structural, not configurable (D-B7):
 *  - the run is ALWAYS in the daemon's read-only `plan` mode. This module never reads `chi.mode` or the approvals
 *    block, and a schedule has no `mode` field;
 *  - it NEVER goes through approvals. This module has no handle on the approval manager and records no thread, so
 *    nothing here can ask for, or be granted, write access.
 */

// ── config ────────────────────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCHEDULE_KEYS = new Set(['name', 'cron', 'channel', 'task', 'cwd', 'engine', 'timeoutSeconds', 'enabled', 'onMissed', 'quiet']);
const MAX_TASK_CHARS = 20_000;

export interface ResolvedSchedule {
  name: string;
  cron: CronSpec;
  channel: string;
  task: string;
  cwd?: string;
  engine?: string;
  timeoutSeconds?: number;
  enabled: boolean;
  onMissed: 'skip' | 'once';
  quiet: boolean;
}

function normalizeChannel(ref: string): string {
  return ref.trim().replace(/^#/, '');
}

/**
 * Validate a bot's `schedules` array. Throws, naming the bot and the schedule, on: a non-object entry, an unknown
 * field (`mode` included), a bad name, a duplicate name, a bad or never-firing cron, an empty task or channel, a
 * channel that is not one of the bot's `allowedChannels`, a bad `onMissed`.
 */
export function resolveSchedules(list: ScheduleConfig[] | undefined, where: string, allowedChannels: string[]): ResolvedSchedule[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${where}: schedules must be an array`);
  const allowed = new Set(allowedChannels.map(normalizeChannel));
  const seen = new Set<string>();
  const out: ResolvedSchedule[] = [];

  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: schedules[${i}] must be an object`);
    const label = typeof raw.name === 'string' && raw.name ? `${where}: schedule '${raw.name}'` : `${where}: schedules[${i}]`;
    for (const key of Object.keys(raw)) {
      if (!SCHEDULE_KEYS.has(key)) {
        const hint = key === 'mode' ? ' (scheduled runs are always read-only plan mode and never use approvals)' : '';
        throw new Error(`${label}: unknown field '${key}'${hint}; allowed: ${[...SCHEDULE_KEYS].join(', ')}`);
      }
    }
    if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) {
      throw new Error(`${label}: name is required (letters, digits, '.', '_', '-'; at most 64 characters)`);
    }
    const key = raw.name.toLowerCase();
    if (seen.has(key)) throw new Error(`${label}: duplicate schedule name`);
    seen.add(key);

    let cron: CronSpec;
    try {
      cron = parseCron(raw.cron);
    } catch (err) {
      throw new Error(`${label}: invalid cron: ${(err as Error).message}`);
    }
    if (nextRun(cron, Date.now()) === undefined) throw new Error(`${label}: cron '${cron.source}' never fires`);

    if (typeof raw.task !== 'string' || !raw.task.trim()) throw new Error(`${label}: task is required`);
    if (raw.task.length > MAX_TASK_CHARS) throw new Error(`${label}: task is longer than ${MAX_TASK_CHARS} characters`);

    if (typeof raw.channel !== 'string' || !normalizeChannel(raw.channel)) throw new Error(`${label}: channel is required`);
    const channel = normalizeChannel(raw.channel);
    if (!allowed.has(channel)) {
      throw new Error(
        `${label}: unknown channel '${raw.channel}': it is not in this bot's allowedChannels (${[...allowed].join(', ') || 'none'}). A bot only posts where it may also listen`,
      );
    }

    if (raw.onMissed !== undefined && raw.onMissed !== 'skip' && raw.onMissed !== 'once') {
      throw new Error(`${label}: onMissed must be 'skip' or 'once' (got '${String(raw.onMissed)}')`);
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`${label}: enabled must be true or false`);
    if (raw.quiet !== undefined && typeof raw.quiet !== 'boolean') throw new Error(`${label}: quiet must be true or false`);
    for (const k of ['cwd', 'engine'] as const) {
      if (raw[k] !== undefined && (typeof raw[k] !== 'string' || !(raw[k] as string).trim())) throw new Error(`${label}: ${k} must be a non-empty string`);
    }
    if (raw.timeoutSeconds !== undefined && (!Number.isFinite(raw.timeoutSeconds) || raw.timeoutSeconds <= 0)) {
      throw new Error(`${label}: timeoutSeconds must be a positive number`);
    }

    out.push({
      name: raw.name,
      cron,
      channel,
      task: raw.task,
      cwd: raw.cwd,
      engine: raw.engine,
      timeoutSeconds: raw.timeoutSeconds,
      enabled: raw.enabled ?? true,
      onMissed: raw.onMissed ?? 'once',
      quiet: raw.quiet ?? false,
    });
  });
  return out;
}

// ── state ─────────────────────────────────────────────────────────────────────

export interface InFlight {
  /** Absent when the bridge stopped before the daemon answered `chi_run`. */
  run_id?: string;
  slot: number;
  started_at: number;
}

export interface ScheduleState {
  /** The latest due time that has been handled (run started, skipped or collapsed). Nothing at or before it runs again. */
  last_slot: number;
  last_run_at?: number;
  last_status?: 'ok' | 'failed' | 'quiet' | 'interrupted';
  last_run_id?: string;
  /** When the "all OK" line of a `quiet` schedule was last posted. */
  last_ok_post_at?: number;
  in_flight?: InFlight;
}

interface StateFile {
  version: 1;
  schedules: Record<string, ScheduleState>;
}

/**
 * Per-bot scheduler state in a JSON file (mode 0600, temp file + rename, same discipline as `ThreadStore`). `last_slot`
 * is written BEFORE a run starts, so a restart can never post the same occurrence twice (at most once, never twice).
 */
export class ScheduleStore {
  private readonly items = new Map<string, ScheduleState>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get(name: string): ScheduleState | undefined {
    return this.items.get(name);
  }

  names(): string[] {
    return [...this.items.keys()];
  }

  put(name: string, state: ScheduleState): Promise<void> {
    this.items.set(name, state);
    return this.flush();
  }

  /** Merge `patch` into an existing entry; `in_flight: null` clears it. */
  patch(name: string, patch: Partial<Omit<ScheduleState, 'in_flight'>> & { in_flight?: InFlight | null }): Promise<void> {
    const cur = this.items.get(name);
    if (!cur) return Promise.resolve();
    const { in_flight, ...rest } = patch;
    const next: ScheduleState = { ...cur, ...rest };
    if (in_flight === null) delete next.in_flight;
    else if (in_flight) next.in_flight = in_flight;
    this.items.set(name, next);
    return this.flush();
  }

  remove(name: string): Promise<void> {
    if (!this.items.delete(name)) return Promise.resolve();
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
      throw new Error(`schedule store: cannot read ${this.filePath}: ${(err as Error).message}`);
    }
    let parsed: StateFile;
    try {
      parsed = JSON.parse(raw) as StateFile;
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${this.now()}`);
      } catch {
        /* best effort */
      }
      console.error(`schedule store ${this.filePath} was unreadable; moved aside and starting empty (no catch-up this time)`);
      return;
    }
    for (const [name, st] of Object.entries(parsed.schedules ?? {})) {
      if (st && typeof st.last_slot === 'number' && Number.isFinite(st.last_slot)) this.items.set(name, st);
    }
  }

  private flush(): Promise<void> {
    const body = JSON.stringify({ version: 1, schedules: Object.fromEntries(this.items) } satisfies StateFile, null, 2);
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
        console.error(`schedule store: write failed: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }
}

// ── runner ────────────────────────────────────────────────────────────────────

/** The slice of the Mattermost client the scheduler needs. */
export interface ScheduleApi {
  reply(channelId: string, message: string, rootId?: string): Promise<MattermostPost>;
  resolveChannelId(ref: string): Promise<string>;
}

export type ScheduleChiApi = Pick<DaemonClient, 'chiRun' | 'chiStatus' | 'redact'>;

export const DEFAULT_TICK_MS = 15_000;
export const DEFAULT_LATE_GRACE_MS = 5 * 60_000;

/** Appended to every scheduled prompt. Plan mode is enforced by the daemon; this only keeps the model from `ExitPlanMode`. */
export const SCHEDULE_NOTE =
  '\n\n[Bridge note: this is a scheduled, read-only run (plan mode), so nothing can be changed. Reply with the finished report as your final message. Do not call ExitPlanMode: no one can answer it.]';

/** Appended when `quiet` is on. */
export const QUIET_NOTE =
  '\n\n[Bridge note: if nothing needs attention, reply with exactly one line that starts with ALL_OK followed by a short summary. Otherwise report only the problems, most serious first, and do not start with ALL_OK.]';

const ALL_OK_RE = /^\s*ALL_OK\b[\s:.\-–—]*/i;
const MAX_OK_LINE_CHARS = 500;

export type RunOutcome =
  /** The result (or the problems) were posted. */
  | { kind: 'posted'; runId: string }
  /** A `quiet` schedule found nothing to report and had already posted its OK line today. */
  | { kind: 'quiet'; runId: string }
  /** The run failed, timed out, was cancelled or could not start; a short notice was posted (when the channel was reachable). */
  | { kind: 'failed'; runId?: string; reason: string }
  /** The previous run of this schedule is still going. */
  | { kind: 'overlap' };

export interface ScheduleRunnerOptions {
  bot: string;
  schedules: ResolvedSchedule[];
  client: ScheduleApi;
  daemon: ScheduleChiApi;
  store: ScheduleStore;
  chi: BotChiConfig;
  /** B5: audit log and mode ceiling. A scheduled run is `schedule.requested` (must be recorded first) ... `schedule.finished`. */
  rails: Rails;
  progress?: ProgressConfig;
  scheduler?: SchedulerOptions;
  now?: () => number;
  log?: (msg: string) => void;
}

interface ExecOptions {
  /** The due time this run is for (scheduled runs). */
  slot?: number;
  /** Started by hand: does not touch the persisted state and always posts. */
  manual: boolean;
  /** Noticed more than `lateGraceMs` after it was due. */
  late: boolean;
}

/** What `executeInner` learned, for the one `schedule.finished` record. */
interface RunTrace {
  requestId?: string;
  /** The engine asked for, and the EFFECTIVE mode once the run was authorised (`bypassPermissions` on an engine that ignores modes). */
  engine?: string;
  mode?: string;
  runId?: string;
  stage: 'channel' | 'start' | 'run' | 'aborted';
}

export class ScheduleRunner {
  private readonly byName = new Map<string, ResolvedSchedule>();
  private readonly active = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly channelIds = new Map<string, string>();
  private readonly progress: ResolvedProgress;
  private readonly tickMs: number;
  private readonly lateGraceMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly abort = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private started = false;

  constructor(private readonly opts: ScheduleRunnerOptions) {
    for (const s of opts.schedules) this.byName.set(s.name, s);
    const p = Object.fromEntries(Object.entries(opts.progress ?? {}).filter(([, v]) => v !== undefined));
    this.progress = { ...PROGRESS_DEFAULTS, ...p };
    this.tickMs = opts.scheduler?.tickMs ?? DEFAULT_TICK_MS;
    this.lateGraceMs = opts.scheduler?.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}:schedules] ${m}`));
  }

  names(): string[] {
    return this.opts.schedules.map((s) => s.name);
  }

  /** The next due time of a schedule after now, epoch ms (for listings). */
  nextDue(name: string): number | undefined {
    const s = this.byName.get(name);
    return s ? nextRun(s.cron, this.now()) : undefined;
  }

  /**
   * Check every enabled channel (refusing to start on an unknown one), forget state of schedules that are gone or
   * disabled, report runs a restart cut short, then catch up and start ticking.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { store } = this.opts;

    for (const s of this.opts.schedules) {
      if (!s.enabled) continue;
      try {
        await this.channelId(s);
      } catch (err) {
        if (err instanceof ChannelLookupError && err.notFound) {
          throw new Error(`bot '${this.opts.bot}': schedule '${s.name}': ${err.message}`);
        }
        this.log(`schedule '${s.name}': channel lookup failed (${this.errText(err)}); will retry when it is due`);
      }
    }

    // A removed or disabled schedule loses its state, so turning it back on later starts fresh instead of catching up.
    for (const name of store.names()) {
      const s = this.byName.get(name);
      if (!s || !s.enabled) {
        this.log(`dropping scheduler state of ${s ? 'disabled' : 'removed'} schedule '${name}'`);
        await store.remove(name);
      }
    }

    for (const s of this.opts.schedules) {
      const st = store.get(s.name);
      if (st?.in_flight) await this.reportInterrupted(s, st.in_flight);
    }

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
  }

  /** Resolves once every run that is in flight has finished (tests, graceful shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * Look for due schedules once. A schedule with no state yet is only recorded (a new schedule never runs "for the
   * past"). Otherwise the occurrences in `(last_slot, now]` are collapsed to the latest one, `last_slot` is persisted,
   * and then the run starts, or is skipped when it is late and the schedule says `onMissed: skip`.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const s of this.opts.schedules) {
        if (!s.enabled) continue;
        const st = this.opts.store.get(s.name);
        if (!st) {
          await this.opts.store.put(s.name, { last_slot: minuteFloor(now) });
          continue;
        }
        const { count, latest } = occurrencesBetween(s.cron, st.last_slot, now);
        if (latest === undefined) continue;
        await this.opts.store.patch(s.name, { last_slot: latest });
        if (count > 1) this.log(`schedule '${s.name}': ${count} occurrences came due; running only the latest (${iso(latest)})`);
        const late = now - latest > this.lateGraceMs;
        if (late && s.onMissed === 'skip') {
          this.log(`schedule '${s.name}': missed ${iso(latest)} while the bridge was down; onMissed is skip, so nothing runs`);
          continue;
        }
        if (this.active.has(s.name)) {
          this.log(`schedule '${s.name}': ${iso(latest)} is due but the previous run is still going; skipping this one`);
          continue;
        }
        const p = this.execute(s, { slot: latest, manual: false, late }).catch((err) => {
          this.log(`schedule '${s.name}': unexpected error: ${this.errText(err)}`);
        });
        this.pending.add(p);
        void p.finally(() => this.pending.delete(p));
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Run a schedule now, by hand (`--run-schedule`). Same run as a scheduled one (plan mode, same prompt, same post) but
   * it leaves the persisted state alone, ignores the once-a-day OK limit, and waits for the outcome.
   */
  async runNow(name: string): Promise<RunOutcome> {
    const s = this.byName.get(name);
    if (!s) throw new Error(`no schedule named '${name}'; this bot has: ${this.names().join(', ') || '(none)'}`);
    return this.execute(s, { manual: true, late: false });
  }

  // ── one run ─────────────────────────────────────────────────────────────────

  private async execute(s: ResolvedSchedule, o: ExecOptions): Promise<RunOutcome> {
    const trace: RunTrace = { stage: 'channel', engine: s.engine ?? this.opts.chi.engine };
    const startedAt = this.now();
    let outcome: RunOutcome | undefined;
    try {
      outcome = await this.executeInner(s, o, trace);
      return outcome;
    } finally {
      this.opts.rails.audit.record('schedule.finished', {
        schedule: s.name,
        request_id: trace.requestId,
        run_id: outcome && 'runId' in outcome ? (outcome.runId ?? trace.runId) : trace.runId,
        engine: trace.engine,
        mode: trace.mode,
        outcome: outcome ? outcome.kind : 'error',
        stage: outcome?.kind === 'failed' ? trace.stage : undefined,
        manual: o.manual,
        slot: o.slot === undefined ? undefined : iso(o.slot),
        duration_s: Math.max(0, Math.round((this.now() - startedAt) / 1000)),
      });
    }
  }

  private async executeInner(s: ResolvedSchedule, o: ExecOptions, trace: RunTrace): Promise<RunOutcome> {
    // Claim before the first await: a manual run and a tick must not both start one.
    if (this.active.has(s.name)) {
      this.log(`schedule '${s.name}': previous run still going; not starting another`);
      return { kind: 'overlap' };
    }
    this.active.add(s.name);
    const { store, daemon, chi } = this.opts;
    const startedAt = this.now();
    let channelId: string | undefined;
    let runId: string | undefined;
    const track = !o.manual;
    try {
      try {
        channelId = await this.channelId(s);
      } catch (err) {
        const reason = `cannot resolve channel '${s.channel}': ${this.errText(err)}`;
        this.log(`schedule '${s.name}': ${reason}`);
        if (track) await store.patch(s.name, { last_run_at: startedAt, last_status: 'failed' });
        return { kind: 'failed', reason };
      }

      if (track) await store.patch(s.name, { in_flight: { slot: o.slot as number, started_at: startedAt } });

      let result: ChiRunResult;
      const prompt = this.prompt(s);
      trace.stage = 'start';
      try {
        // B5: the mode ceiling and the audit record come first; if either refuses, no run is started.
        const engine = s.engine ?? chi.engine;
        const auth = this.opts.rails.authorizeRun({
          kind: 'schedule',
          engine,
          mode: PLAN_MODE,
          fields: { schedule: s.name, manual: o.manual, slot: o.slot === undefined ? undefined : iso(o.slot), late: o.late },
        });
        trace.requestId = auth.requestId;
        trace.mode = auth.mode;
        result = await daemon.chiRun({
          engineId: engine,
          prompt,
          cwd: s.cwd ?? chi.cwd,
          model: chi.model,
          // Always read-only. Never `chi.mode`, never the approvals acting mode.
          mode: PLAN_MODE,
          timeoutSeconds: s.timeoutSeconds ?? chi.timeoutSeconds,
          persistent: chi.persistent ?? true,
        });
      } catch (err) {
        return await this.fail(s, o, channelId, undefined, `could not start: ${this.errText(err)}`, track);
      }
      runId = result.run_id;
      trace.runId = runId;
      trace.stage = 'run';
      if (track) await store.patch(s.name, { in_flight: { run_id: runId, slot: o.slot as number, started_at: startedAt } });

      const final = await this.watch(runId, startedAt);
      if (final === 'aborted') trace.stage = 'aborted';
      if (final === 'aborted') return { kind: 'failed', runId, reason: 'the bridge was stopping' }; // in_flight stays: reported on next start
      if (final.kind === 'lost') return await this.fail(s, o, channelId, runId, final.reason, track);

      const st = final.status;
      const secs = Math.max(0, Math.round((this.now() - startedAt) / 1000));
      const error = st.error ? daemon.redact(st.error) : undefined;
      const output = this.usableOutput(st.output, prompt);

      if (st.status === 'done') {
        if (!output) {
          return await this.fail(s, o, channelId, runId, `finished but returned no result text (run \`${runId}\` is in Ikenga's Chi view)`, track);
        }
        return await this.deliver(s, o, channelId, runId, output, Boolean(st.output_truncated), startedAt);
      }
      const what = st.status === 'cancelled' ? 'was cancelled' : st.status === 'timed_out' ? `timed out after ${secs}s` : `failed after ${secs}s`;
      return await this.fail(s, o, channelId, runId, `${what}${error ? `: ${error}` : ''}`, track);
    } finally {
      this.active.delete(s.name);
    }
  }

  /** Post the result (or, for a quiet schedule, maybe nothing) and record the outcome. */
  private async deliver(
    s: ResolvedSchedule,
    o: ExecOptions,
    channelId: string,
    runId: string,
    output: string,
    truncated: boolean,
    startedAt: number,
  ): Promise<RunOutcome> {
    const { store } = this.opts;
    const track = !o.manual;
    const finishedAt = this.now();
    const state = store.get(s.name);

    if (s.quiet && !o.manual) {
      const oneLine = output.trim();
      if (ALL_OK_RE.test(oneLine) && !oneLine.includes('\n') && oneLine.length <= MAX_OK_LINE_CHARS) {
        const sameDay = state?.last_ok_post_at !== undefined && utcDay(state.last_ok_post_at) === utcDay(finishedAt);
        if (sameDay) {
          this.log(`schedule '${s.name}': all OK, already said so today; posting nothing`);
          await store.patch(s.name, { last_run_at: startedAt, last_status: 'quiet', last_run_id: runId, in_flight: null });
          return { kind: 'quiet', runId };
        }
        const line = oneLine.replace(ALL_OK_RE, '').trim() || 'all OK';
        await this.post(channelId, `${this.header(s, o)}\n\n${line}`);
        await store.patch(s.name, { last_run_at: startedAt, last_status: 'ok', last_run_id: runId, last_ok_post_at: finishedAt, in_flight: null });
        return { kind: 'posted', runId };
      }
      // Anything that is not a clean ALL_OK line is treated as a problem report and posted in full.
    }

    const trunc = truncated ? '\n\n(The daemon marked this output as truncated.)' : '';
    await this.post(channelId, `${this.header(s, o)}\n\n${output}${trunc}`);
    if (track) await store.patch(s.name, { last_run_at: startedAt, last_status: 'ok', last_run_id: runId, in_flight: null });
    return { kind: 'posted', runId };
  }

  private async fail(
    s: ResolvedSchedule,
    o: ExecOptions,
    channelId: string,
    runId: string | undefined,
    reason: string,
    track: boolean,
  ): Promise<RunOutcome> {
    this.log(`schedule '${s.name}' failed: ${reason}`);
    const runNote = runId && !reason.includes(runId) ? ` Run \`${runId}\`.` : '';
    await this.post(channelId, `${this.header(s, o)}\n\nThis scheduled run ${reason.replace(/\.$/, '')}.${runNote}`);
    if (track) {
      await this.opts.store.patch(s.name, { last_run_at: this.now(), last_status: 'failed', last_run_id: runId, in_flight: null });
    }
    return { kind: 'failed', runId, reason };
  }

  /** A run a bridge restart cut short: say so once, never retry it. */
  private async reportInterrupted(s: ResolvedSchedule, f: InFlight): Promise<void> {
    const run = f.run_id ? ` Its Chi run \`${f.run_id}\` may have finished; check Ikenga's Chi view.` : ' It had not started a run yet.';
    try {
      const channelId = await this.channelId(s);
      await this.post(
        channelId,
        `**Scheduled run: ${s.name}** (due ${stamp(f.slot)})\n\nThe bridge restarted while this run was in progress, so its result was not posted.${run} It is not retried; the next one runs at its normal time.`,
      );
    } catch (err) {
      this.log(`schedule '${s.name}': could not report an interrupted run: ${this.errText(err)}`);
    }
    await this.opts.store.patch(s.name, { last_status: 'interrupted', in_flight: null });
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async watch(
    runId: string,
    startedAt: number,
  ): Promise<{ kind: 'done'; status: ChiRunResult } | { kind: 'lost'; reason: string } | 'aborted'> {
    const { daemon } = this.opts;
    const p = this.progress;
    const signal = this.abort.signal;
    let delay = p.pollMinMs;
    let failures = 0;
    while (!signal.aborted) {
      await sleep(delay, signal);
      if (signal.aborted) break;
      let st: ChiRunResult;
      try {
        st = await daemon.chiStatus(runId);
        failures = 0;
      } catch (err) {
        if (err instanceof DaemonError && err.runGone) {
          return { kind: 'lost', reason: `cannot be followed: the daemon no longer has its run (it expired or was removed)` };
        }
        failures += 1;
        this.log(`status poll for ${runId} failed (${failures}/${p.maxPollFailures}): ${this.errText(err)}`);
        if (failures >= p.maxPollFailures) {
          return { kind: 'lost', reason: `lost contact with the Ikenga daemon, so it is unknown how it ended (last error: ${this.errText(err)})` };
        }
        delay = Math.min(Math.ceil(delay * 1.5), p.pollMaxMs);
        continue;
      }
      if (TERMINAL_STATUSES.has(st.status)) return { kind: 'done', status: st };
      if (this.now() - startedAt > p.maxWaitMs) {
        return { kind: 'lost', reason: 'is still running, but I stopped watching it (the run continues on the daemon)' };
      }
      delay = Math.min(Math.ceil(delay * 1.5), p.pollMaxMs);
    }
    return 'aborted';
  }

  private prompt(s: ResolvedSchedule): string {
    const prefix = this.opts.chi.systemPrompt?.trim();
    const body = `${s.task.trim()}${SCHEDULE_NOTE}${s.quiet ? QUIET_NOTE : ''}`;
    return prefix ? `${prefix}\n\n---\n\n${body}` : body;
  }

  /** `chi_status.output` unless it is the prompt echoed back (the cache row's `brief`, for a run that wrote nothing). */
  private usableOutput(output: string | null | undefined, prompt: string): string | undefined {
    const text = output?.trim();
    if (!text || text === prompt.trim()) return undefined;
    return this.opts.daemon.redact(text);
  }

  private header(s: ResolvedSchedule, o: ExecOptions): string {
    const when = o.manual ? `manual run, ${stamp(this.now())}` : `${stamp(o.slot as number)}${o.late ? ', run late after downtime' : ''}`;
    return `**Scheduled run: ${s.name}** (${when})`;
  }

  /** New root post; text beyond Mattermost's limit continues as replies to it. Never throws. */
  private async post(channelId: string, text: string): Promise<void> {
    try {
      const chunks = chunkText(text, MAX_POST_CHARS);
      const root = await this.opts.client.reply(channelId, chunks[0] as string);
      for (const chunk of chunks.slice(1)) await this.opts.client.reply(channelId, chunk, root.id);
    } catch (err) {
      this.log(`could not post to channel ${channelId}: ${this.errText(err)}`);
    }
  }

  private async channelId(s: ResolvedSchedule): Promise<string> {
    const hit = this.channelIds.get(s.channel);
    if (hit) return hit;
    const id = await this.opts.client.resolveChannelId(s.channel);
    this.channelIds.set(s.channel, id);
    return id;
  }

  private errText(err: unknown): string {
    return this.opts.daemon.redact(err instanceof Error ? err.message : String(err));
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `2026-10-12 08:00 UTC` */
function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
