import type { DaemonAuth } from './daemon.js';

/** How a bot reaches the Ikenga daemon. Each bot has its own entry. */
export interface BotDaemonConfig {
  url: string;
  /** Resolved credentials (see `config.ts` for the file form). */
  auth: DaemonAuth;
  origin?: string;
  requestTimeoutMs?: number;
}

/** What a bot's Chi runs look like. */
export interface BotChiConfig {
  /** Chi engine id, e.g. `claude-code`. */
  engine: string;
  /** Working directory on the daemon host. `~` is expanded daemon-side. */
  cwd?: string;
  model?: string;
  mode?: string;
  /** Prepended to the FIRST prompt of a thread only (Chi has no system-prompt field). */
  systemPrompt?: string;
  /** Detached chi-runner, so the first turn survives a daemon restart. Default true. */
  persistent?: boolean;
  timeoutSeconds?: number;
}

/** Timing of the progress post. All optional; defaults suit production. */
export interface ProgressConfig {
  /** First poll delay and its floor, ms. Default 1000. */
  pollMinMs?: number;
  /** Backoff ceiling, ms. Default 10000. */
  pollMaxMs?: number;
  /** Minimum gap between edits of the progress post, ms. Default 5000. */
  editIntervalMs?: number;
  /** Stop watching a run after this long, ms. Default 2 hours. */
  maxWaitMs?: number;
  /** Consecutive failed status polls before giving up on the daemon. Default 5. */
  maxPollFailures?: number;
}

/**
 * B3 approvals. When present the bot runs every thread turn in the daemon's
 * read-only `plan` mode, posts the plan, and only an approver's reaction starts
 * a second run in `actingMode`. Deny by default: `approvers` must be non-empty
 * and is separate from `allowedUsers`.
 */
export interface BotApprovalsConfig {
  /** Usernames (or user ids) whose 👍/👎 may decide. Required, non-empty. */
  approvers: string[];
  /** An undecided approval expires (= deny) after this long, ms. Default 15 minutes. */
  timeoutMs?: number;
  /**
   * Claude Code permission mode of the approved run: `auto` (acceptEdits, the
   * default) or `bypassPermissions`. `plan` and `default` are refused.
   */
  actingMode?: string;
}

/**
 * B4: a scheduled post. At each due time (cron, 5 fields, UTC) the bot starts a Chi run of `task` in the
 * daemon's read-only `plan` mode and posts the result to `channel` as a new root post. There is no `mode`
 * field on purpose: a scheduled run is always read-only and never goes through approvals (D-B7).
 */
export interface ScheduleConfig {
  /** Unique within the bot. Letters, digits, `.`, `_`, `-`. Used in the header, the state file and `--run-schedule`. */
  name: string;
  /** 5-field cron, UTC: `minute hour day-of-month month day-of-week`. */
  cron: string;
  /** Channel name (with or without `#`) or id to post in. Must also be in the bot's `allowedChannels`. */
  channel: string;
  /** The prompt of the run. */
  task: string;
  /** Overrides `chi.cwd` for this schedule. */
  cwd?: string;
  /** Overrides `chi.engine` for this schedule. */
  engine?: string;
  /** Overrides `chi.timeoutSeconds` for this schedule. */
  timeoutSeconds?: number;
  /** Default true. A disabled schedule is validated but never runs. */
  enabled?: boolean;
  /**
   * What to do about an occurrence that came due while the bridge was down (more than a few minutes ago).
   * `once` (default): run the latest missed occurrence, once. `skip`: run nothing until the next one.
   */
  onMissed?: 'skip' | 'once';
  /**
   * Post only problems. The run is told to answer with one line starting `ALL_OK` when nothing needs attention;
   * the bridge posts that line at most once per UTC day and posts anything else in full.
   */
  quiet?: boolean;
}

/** Scheduler timing. Optional; defaults suit production. Mostly for tests. */
export interface SchedulerOptions {
  /** How often the scheduler looks for due schedules, ms. Default 15 000. */
  tickMs?: number;
  /** A due time older than this when it is noticed counts as missed (see `onMissed`), ms. Default 5 minutes. */
  lateGraceMs?: number;
}

/** B5: the audit log (always on) and its options. */
export interface AuditConfig {
  /**
   * Mirror a one-line summary of every audit record to this channel (name or id). Write-only: it must NOT be in the
   * bot's `allowedChannels`. The file stays the record; the mirror is an off-box copy.
   */
  channel?: string;
  /** Add `prompt_sha` (16 hex of SHA-256) and `prompt_len` to run records. Default false. Message text is never recorded. */
  promptHash?: boolean;
  /** Rotate the file at this size. Default 10 MiB. */
  maxBytes?: number;
  /** Rotated files kept. Default 10. */
  keep?: number;
  /** File path. Default `<dataDir>/audit-<bot>.jsonl`. */
  path?: string;
}

export interface MattermostBridgeConfig {
  mattermostUrl: string;
  mattermostToken: string;
  botUserId?: string;
  allowedUsers: string[];
  allowedChannels: string[];
  echoPrefix?: string;
  /** Bot name: store partition and log label. Default `bot`. */
  name?: string;
  /** B2: when both `daemon` and `chi` are set the bridge runs Chi runs; otherwise it echoes (B1). */
  daemon?: BotDaemonConfig;
  chi?: BotChiConfig;
  /** Thread store file. Default `<dataDir>/threads-<name>.json`. */
  storePath?: string;
  /** Used to derive `storePath` when it is not given. */
  dataDir?: string;
  /** Forget threads idle for longer than this, ms. Default 30 days. */
  retentionMs?: number;
  progress?: ProgressConfig;
  /** B3: gate the bot's actions behind an approver's reaction. Needs `daemon` + `chi`. */
  approvals?: BotApprovalsConfig;
  /** B4: scheduled posts. Needs `daemon` + `chi`. */
  schedules?: ScheduleConfig[];
  scheduler?: SchedulerOptions;
  /**
   * B5: the most permissive Chi permission mode this bot may ever ask the daemon for: `plan` | `acceptEdits` |
   * `bypassPermissions`. Default `plan`. A config whose `chi.mode` or `approvals.actingMode` is above it is refused at load.
   */
  maxMode?: string;
  /** B5: branch prefix an acting run is told to confine itself to (`rex/`). ADVISORY; see the README for the real control. */
  branchPrefix?: string;
  /** B5: audit options. The audit log itself cannot be switched off. */
  audit?: AuditConfig;
  /** Scheduler state file. Default `<dataDir>/schedules-<name>.json`. */
  schedulesPath?: string;
}

export interface MattermostPost {
  id: string;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
  is_pinned?: boolean;
  user_id: string;
  channel_id: string;
  root_id?: string;
  original_id?: string;
  message: string;
  type?: string;
  props?: Record<string, unknown>;
  filenames?: string[];
}

export interface MattermostPostEvent {
  event: 'posted';
  data: {
    channel_name?: string;
    channel_type?: string;
    channel_display_name?: string;
    team_id?: string;
    sender_name?: string;
    post: string; // JSON-serialized MattermostPost
  };
  broadcast?: {
    channel_id?: string;
    user_id?: string;
    team_id?: string;
  };
  seq: number;
}

/** A `reaction_added` payload (`data.reaction` is this, JSON-serialized). */
export interface MattermostReaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at?: number;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
  /** Machine-readable denial reason (the audit log records this, not `reason`, which names a user). */
  code?: 'own_post' | 'system_post' | 'no_allowed_users' | 'user_not_allowed' | 'no_allowed_channels' | 'channel_not_allowed';
}
