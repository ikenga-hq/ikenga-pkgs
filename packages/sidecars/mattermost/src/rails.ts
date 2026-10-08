import { createHash, randomUUID } from 'node:crypto';
import type { AuditFields, AuditLog } from './audit.js';
import { AuditUnavailableError } from './audit.js';

/**
 * B5 mode rails. Everything in this file is enforced by the bridge: it bounds what the bridge will ASK the
 * daemon for. It does not (and cannot) bound what a run does inside the mode it was given, and it does not stop
 * another client of the daemon using the bot's own account. The README's "Enforced where" table says so.
 */

/** The daemon's permission-mode ids (`AcpSessionMode::from_acp_id`). `auto` is Claude Code's `acceptEdits`. */
export type WireMode = 'plan' | 'default' | 'auto' | 'bypassPermissions';

const RANK: Record<WireMode, number> = { plan: 0, default: 1, auto: 2, bypassPermissions: 3 };
/** A run started with no mode becomes `default` on the daemon. */
const DAEMON_DEFAULT: WireMode = 'default';

/** Spellings accepted for `maxMode` (the task's vocabulary is Claude Code's; `auto` is the daemon's id for acceptEdits). */
const MAX_MODE_NAMES: Record<string, WireMode> = {
  plan: 'plan',
  acceptEdits: 'auto',
  auto: 'auto',
  bypassPermissions: 'bypassPermissions',
};

/** Spellings accepted for `chi.mode`; `acceptEdits` is rewritten to the id the daemon actually understands. */
const CHI_MODE_NAMES: Record<string, WireMode> = {
  plan: 'plan',
  default: 'default',
  acceptEdits: 'auto',
  auto: 'auto',
  bypassPermissions: 'bypassPermissions',
};

export function isWireMode(m: string): m is WireMode {
  return Object.prototype.hasOwnProperty.call(RANK, m);
}

/** Rank of a mode; an absent mode is the daemon's default, an unknown one is above everything (fails closed). */
export function modeRank(mode: string | undefined | null): number {
  if (mode === undefined || mode === null || mode === '') return RANK[DAEMON_DEFAULT];
  return isWireMode(mode) ? RANK[mode] : Number.POSITIVE_INFINITY;
}

/** `auto` reads as `auto (acceptEdits)` in messages. */
export function modeLabel(mode: string): string {
  return mode === 'auto' ? 'auto (acceptEdits)' : mode;
}

export class ModeRailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeRailError';
  }
}

export interface ResolvedModeRails {
  /** The ceiling for every run this bot starts. Default `plan`. */
  maxMode: WireMode;
  /** The mode of an ordinary thread run (no approvals): `chi.mode`, or `plan` when it is unset. */
  threadMode: WireMode;
  /** The mode of an approved run, when the bot has approvals. */
  actingMode?: WireMode;
}

export interface ModeRailInput {
  maxMode?: string;
  chi?: { mode?: string };
  approvals?: { actingMode?: string };
}

/**
 * Validate a bot's modes against its `maxMode`, at config load. Throws, naming the bot, when `maxMode` is not one
 * of plan | acceptEdits | bypassPermissions, when `chi.mode` is unknown or above `maxMode`, or when the approvals
 * acting mode is above `maxMode`. Never downgrades silently: a config that asks for more than `maxMode` is refused.
 *
 * `maxMode` defaults to `plan`. That is a behaviour change from B2-B4, which let `chi.mode` and
 * `approvals.actingMode` stand on their own; the message says what to set.
 */
export function resolveModeRails(input: ModeRailInput, where: string): ResolvedModeRails {
  let maxMode: WireMode = 'plan';
  const rawMax = input.maxMode;
  if (rawMax !== undefined) {
    const m = typeof rawMax === 'string' ? MAX_MODE_NAMES[rawMax] : undefined;
    if (!m) {
      throw new Error(`${where}: maxMode must be one of plan, acceptEdits, bypassPermissions (got '${String(rawMax)}')`);
    }
    maxMode = m;
  }
  const hint = `maxMode is '${maxMode}'${rawMax === undefined ? ' (the default: a bot may not leave plan mode unless you raise it)' : ''}; set maxMode in this bot's config to allow it`;

  let threadMode: WireMode = 'plan';
  const rawMode = input.chi?.mode;
  if (rawMode !== undefined && !input.approvals) {
    const m = typeof rawMode === 'string' ? CHI_MODE_NAMES[rawMode] : undefined;
    if (!m) {
      throw new Error(
        `${where}: chi.mode '${String(rawMode)}' is not a mode the daemon knows (plan, default, acceptEdits, bypassPermissions); the daemon would silently run it as 'default'`,
      );
    }
    if (modeRank(m) > modeRank(maxMode)) {
      throw new Error(`${where}: chi.mode '${rawMode}' is above this bot's ceiling: ${hint}`);
    }
    threadMode = m;
  }

  let actingMode: WireMode | undefined;
  if (input.approvals) {
    const raw = input.approvals.actingMode ?? 'auto';
    const m = CHI_MODE_NAMES[raw];
    if (!m) throw new Error(`${where}: approvals.actingMode '${raw}' is not a mode the daemon knows`);
    if (modeRank(m) > modeRank(maxMode)) {
      throw new Error(`${where}: approvals.actingMode '${raw}' is above this bot's ceiling: ${hint}`);
    }
    actingMode = m;
  }
  return { maxMode, threadMode, actingMode };
}

/** A branch prefix such as `rex/`. Lower-case, ends in `/`, no spaces, no `..`. */
export function resolveBranchPrefix(raw: string | undefined, where: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[a-z0-9][a-z0-9._-]*\/$/.test(raw) || raw.includes('..')) {
    throw new Error(`${where}: branchPrefix must look like 'rex/' (lower-case letters, digits, '.', '_', '-', ending in '/'; got '${String(raw)}')`);
  }
  return raw;
}

// ── the runtime choke point ──────────────────────────────────────────────────

export type RunKind = 'thread' | 'resume' | 'act' | 'schedule';

export interface RunRequest {
  kind: RunKind;
  /** The mode the daemon will be asked for (for a resume: the mode stored on the run). */
  mode: string | undefined;
  /** Who/what asked, thread, channel: audit fields. Never message text. */
  fields: AuditFields;
}

export interface RailsOptions {
  bot: string;
  maxMode: WireMode;
  threadMode: WireMode;
  actingMode?: WireMode;
  branchPrefix?: string;
  /** Record a truncated hash of the prompt (and its length) in run records. Default off. */
  promptHash?: boolean;
  audit: AuditLog;
}

/**
 * One per bot. Every `chi_run` / `chi_resume` call site (threads, approved runs, schedules) calls `authorizeRun`
 * first and does not call the daemon if it throws:
 *
 *  1. the requested mode must be <= `maxMode` (else `ModeRailError`, after a `run.refused` record);
 *  2. a `run.requested` / `schedule.requested` record must reach the audit log (else `AuditUnavailableError`).
 *     The record is written BEFORE the daemon is asked, like the old `mutation_audit`: a run nobody can attribute
 *     does not start. (This guards the bridge's own start path only: see the README for what that does not cover.)
 */
export class Rails {
  readonly bot: string;
  readonly maxMode: WireMode;
  readonly threadMode: WireMode;
  readonly actingMode?: WireMode;
  readonly branchPrefix?: string;
  readonly audit: AuditLog;
  private readonly promptHash: boolean;

  constructor(opts: RailsOptions) {
    this.bot = opts.bot;
    this.maxMode = opts.maxMode;
    this.threadMode = opts.threadMode;
    this.actingMode = opts.actingMode;
    this.branchPrefix = opts.branchPrefix;
    this.audit = opts.audit;
    this.promptHash = opts.promptHash ?? false;
  }

  /** Returns the request id that ties the `*.requested` record to the `run.started` / `schedule.finished` one. */
  authorizeRun(req: RunRequest): string {
    const requested = req.mode ?? DAEMON_DEFAULT;
    if (modeRank(req.mode) > modeRank(this.maxMode)) {
      this.audit.record('run.refused', {
        ...req.fields,
        kind: req.kind,
        reason: 'mode_exceeds_max',
        requested_mode: requested,
        max_mode: this.maxMode,
      });
      throw new ModeRailError(
        `this bot may run in ${modeLabel(this.maxMode)} mode at most (maxMode), and this run asked for ${modeLabel(requested)}; nothing was started`,
      );
    }
    const requestId = randomUUID();
    try {
      this.audit.must(req.kind === 'schedule' ? 'schedule.requested' : 'run.requested', {
        ...req.fields,
        kind: req.kind,
        mode: requested,
        max_mode: this.maxMode,
        request_id: requestId,
      });
    } catch (err) {
      if (err instanceof AuditUnavailableError) {
        throw new AuditUnavailableError(`the audit log cannot be written, so I will not start a run that nobody could account for (${err.reason})`, err.reason);
      }
      throw err;
    }
    return requestId;
  }

  /** `prompt_sha` (first 16 hex of SHA-256) and `prompt_len`, only when the bot's `audit.promptHash` is on. */
  promptFields(text: string): AuditFields {
    if (!this.promptHash) return {};
    return { prompt_sha: createHash('sha256').update(text).digest('hex').slice(0, 16), prompt_len: text.length };
  }

  /** Branch-prefix instruction appended to prompts of runs that may change things. ADVISORY: a prompt, not a control. */
  branchNote(): string {
    const p = this.branchPrefix;
    if (!p) return '';
    return `\n\n[Bridge note: work only on git branches whose names start with \`${p}\` (create \`${p}<topic>\` first). Never commit to or push main, master or any other branch, and never force-push. Pushes outside \`${p}*\` are not permitted for this account.]`;
  }
}
