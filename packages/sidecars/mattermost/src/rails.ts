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

/*
 * Name lookups use Maps and Sets, never plain objects: a plain-object lookup answers for `constructor`, `__proto__`,
 * `toString` and the rest of Object.prototype, and a config value like `maxMode: "constructor"` would then read as a
 * valid (and unlimited) ceiling.
 */
const RANK: ReadonlyMap<string, number> = new Map([
  ['plan', 0],
  ['default', 1],
  ['auto', 2],
  ['bypassPermissions', 3],
]);
/** A run started with no mode becomes `default` on the daemon. */
const DAEMON_DEFAULT: WireMode = 'default';

/** Spellings accepted for `maxMode` (the task's vocabulary is Claude Code's; `auto` is the daemon's id for acceptEdits). */
const MAX_MODE_NAMES: ReadonlyMap<string, WireMode> = new Map<string, WireMode>([
  ['plan', 'plan'],
  ['acceptEdits', 'auto'],
  ['auto', 'auto'],
  ['bypassPermissions', 'bypassPermissions'],
]);

/** Spellings accepted for `chi.mode`; `acceptEdits` is rewritten to the id the daemon actually understands. */
const CHI_MODE_NAMES: ReadonlyMap<string, WireMode> = new Map<string, WireMode>([
  ['plan', 'plan'],
  ['default', 'default'],
  ['acceptEdits', 'auto'],
  ['auto', 'auto'],
  ['bypassPermissions', 'bypassPermissions'],
]);

/**
 * The engines for which the daemon turns `mode` into a permission flag: `claude-code` only (`build_engine_command_with`
 * in the shell's `chi_exec.rs`: `--permission-mode <flag>`). `antigravity-cli` is handed the raw string as `--mode` and
 * nothing here knows that its agent honours it; `codex`, `opencode` and `pi` get no permission argument at all. A mode
 * is therefore ENFORCED only on a listed engine; on every other engine (and on a name the daemon does not know) a run
 * is unrestricted whatever mode was asked for, so its effective mode is `bypassPermissions`.
 */
const ENFORCING_ENGINES: ReadonlySet<string> = new Set(['claude-code']);

/** True when the daemon maps `mode` to a permission flag for this engine. Exact match, as the daemon matches. */
export function engineEnforcesMode(engine: unknown): boolean {
  return typeof engine === 'string' && ENFORCING_ENGINES.has(engine);
}

/**
 * The mode a run actually has: the requested one (the daemon default when none) on an engine that enforces modes,
 * `bypassPermissions` on any other. An unknown engine (a stored run with no recorded engine) counts as not enforcing.
 */
export function effectiveMode(engine: unknown, mode: string | undefined | null): string {
  const requested = mode === undefined || mode === null || mode === '' ? DAEMON_DEFAULT : mode;
  return engineEnforcesMode(engine) ? requested : 'bypassPermissions';
}

export function isWireMode(m: string): m is WireMode {
  return RANK.has(m);
}

/** Rank of a mode; an absent mode is the daemon's default, an unknown one is above everything (fails closed). */
export function modeRank(mode: string | undefined | null): number {
  if (mode === undefined || mode === null || mode === '') return RANK.get(DAEMON_DEFAULT) as number;
  return RANK.get(mode) ?? Number.POSITIVE_INFINITY;
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
  chi?: { mode?: string; engine?: string };
  approvals?: { actingMode?: string };
  /** Only `name` and `engine` are read here (the rest is `resolveSchedules`' business). */
  schedules?: Array<{ name?: string; engine?: string }>;
}

/**
 * Validate a bot's modes against its `maxMode`, at config load. Throws, naming the bot, when `maxMode` is not one
 * of plan | acceptEdits | bypassPermissions, when `chi.mode` is unknown or above `maxMode`, when the approvals
 * acting mode is above `maxMode`, or when `chi.engine` / a schedule's `engine` is an engine that does not enforce modes
 * (anything but `claude-code`) while `maxMode` is below `bypassPermissions`: a run on such an engine is unrestricted
 * whatever mode it is given, so its effective mode is `bypassPermissions`. Never downgrades silently: a config that
 * asks for more than `maxMode` is refused.
 *
 * `maxMode` defaults to `plan`. That is a behaviour change from B2-B4, which let `chi.mode` and
 * `approvals.actingMode` stand on their own; the message says what to set.
 */
export function resolveModeRails(input: ModeRailInput, where: string): ResolvedModeRails {
  let maxMode: WireMode = 'plan';
  const rawMax = input.maxMode;
  if (rawMax !== undefined) {
    const m = typeof rawMax === 'string' ? MAX_MODE_NAMES.get(rawMax) : undefined;
    if (!m) {
      throw new Error(`${where}: maxMode must be one of plan, acceptEdits, bypassPermissions (got '${String(rawMax)}')`);
    }
    maxMode = m;
  }
  const hint = `maxMode is '${maxMode}'${rawMax === undefined ? ' (the default: a bot may not leave plan mode unless you raise it)' : ''}; set maxMode in this bot's config to allow it`;

  let threadMode: WireMode = 'plan';
  const rawMode = input.chi?.mode;
  if (rawMode !== undefined && !input.approvals) {
    const m = typeof rawMode === 'string' ? CHI_MODE_NAMES.get(rawMode) : undefined;
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
    const m = typeof raw === 'string' ? CHI_MODE_NAMES.get(raw) : undefined;
    if (!m) throw new Error(`${where}: approvals.actingMode '${String(raw)}' is not a mode the daemon knows`);
    if (modeRank(m) > modeRank(maxMode)) {
      throw new Error(`${where}: approvals.actingMode '${raw}' is above this bot's ceiling: ${hint}`);
    }
    actingMode = m;
  }

  // A mode is only enforced on an engine the daemon maps it for. Anywhere else the run is unrestricted, which is
  // `bypassPermissions` whatever the config says, so it is held to the ceiling as such.
  const engines: Array<{ field: string; engine: unknown }> = [];
  if (input.chi && input.chi.engine !== undefined) engines.push({ field: 'chi.engine', engine: input.chi.engine });
  for (const [i, sch] of (input.schedules ?? []).entries()) {
    if (sch && typeof sch === 'object' && sch.engine !== undefined) {
      engines.push({ field: `schedule '${typeof sch.name === 'string' && sch.name ? sch.name : i}' engine`, engine: sch.engine });
    }
  }
  for (const { field, engine } of engines) {
    if (!engineEnforcesMode(engine) && modeRank(effectiveMode(engine, 'plan')) > modeRank(maxMode)) {
      throw new Error(
        `${where}: ${field} '${String(engine)}' does not enforce permission modes (the daemon passes a mode to claude-code only), so a run on it is effectively bypassPermissions, above this bot's ceiling: ${hint}, or use claude-code`,
      );
    }
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
  /** The engine the daemon will be asked to use (for a resume: the engine stored on the run; undefined = unknown). */
  engine: string | undefined;
  /** The mode the daemon will be asked for (for a resume: the mode stored on the run). */
  mode: string | undefined;
  /** Who/what asked, thread, channel: audit fields. Never message text. */
  fields: AuditFields;
}

/** What `authorizeRun` hands back: the id that ties `*.requested` to what follows, and what the run really has. */
export interface AuthorizedRun {
  requestId: string;
  engine: string | undefined;
  /** The EFFECTIVE mode: the requested one on an engine that enforces it, `bypassPermissions` on any other. Audit this, not the request. */
  mode: string;
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
 *  1. the effective mode (see `effectiveMode`) must be <= `maxMode` (else `ModeRailError`, after a `run.refused` record);
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

  /**
   * Returns the request id (and the effective mode) that ties the `*.requested` record to the `run.started` /
   * `schedule.finished` one. The mode is checked as it will really apply on the engine actually being sent: an engine
   * the daemon does not map modes for has no restriction, so it is checked, and audited, as `bypassPermissions`.
   */
  authorizeRun(req: RunRequest): AuthorizedRun {
    const requested = req.mode ?? DAEMON_DEFAULT;
    const enforced = engineEnforcesMode(req.engine);
    const effective = effectiveMode(req.engine, req.mode);
    if (modeRank(effective) > modeRank(this.maxMode)) {
      this.audit.record('run.refused', {
        ...req.fields,
        kind: req.kind,
        reason: 'mode_exceeds_max',
        engine: req.engine,
        requested_mode: requested,
        effective_mode: effective,
        mode_enforced: enforced,
        max_mode: this.maxMode,
      });
      throw new ModeRailError(
        enforced
          ? `this bot may run in ${modeLabel(this.maxMode)} mode at most (maxMode), and this run asked for ${modeLabel(requested)}; nothing was started`
          : `this bot may run in ${modeLabel(this.maxMode)} mode at most (maxMode), and engine '${String(req.engine ?? 'unknown')}' does not enforce permission modes, so this run would be unrestricted (bypassPermissions); nothing was started`,
      );
    }
    const requestId = randomUUID();
    try {
      this.audit.must(req.kind === 'schedule' ? 'schedule.requested' : 'run.requested', {
        ...req.fields,
        kind: req.kind,
        engine: req.engine,
        mode: effective,
        requested_mode: requested,
        mode_enforced: enforced,
        max_mode: this.maxMode,
        request_id: requestId,
      });
    } catch (err) {
      if (err instanceof AuditUnavailableError) {
        throw new AuditUnavailableError(`the audit log cannot be written, so I will not start a run that nobody could account for (${err.reason})`, err.reason);
      }
      throw err;
    }
    return { requestId, engine: req.engine, mode: effective };
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
