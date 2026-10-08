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
}
