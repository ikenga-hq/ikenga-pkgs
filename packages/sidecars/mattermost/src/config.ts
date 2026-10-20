import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSecret } from './secrets.js';
import type { SecretSource } from './secrets.js';
import { resolveApprovals } from './approvals.js';
import { resolveSchedules } from './schedules.js';
import { resolveAuditConfig } from './audit.js';
import { resolveOutboxApprovals } from './outbox-approvals.js';
import { resolveLimits } from './run-gate.js';
import type { RunLimits } from './run-gate.js';
import { resolveBranchPrefix, resolveModeRails } from './rails.js';
import type { AuditConfig, BotApprovalsConfig, BotChiConfig, MattermostBridgeConfig, OutboxApprovalsConfig, ProgressConfig, ScheduleConfig } from './types.js';

/**
 * On-disk bridge config (`MATTERMOST_BRIDGE_CONFIG=/path/to/bridge.json`).
 * Secrets are never inline: each is `{ "env": "NAME" }` or `{ "file": "/path" }`.
 *
 * Every bot has its OWN `daemon` entry. Two bots may name the same daemon
 * account; nothing here assumes they do or do not.
 */
export interface BotFileConfig {
  mattermostUrl?: string;
  mattermostToken: SecretSource;
  botUserId?: string;
  allowedUsers: string[];
  allowedChannels: string[];
  /** Needed with `chi` for any bot that runs Chi. Omit both for an approvals-only bot (just `outboxApprovals`). */
  daemon?: {
    url: string;
    origin?: string;
    requestTimeoutMs?: number;
    auth:
      | { kind: 'session'; username: string; password: SecretSource }
      | { kind: 'bearer'; token: SecretSource };
  };
  chi?: BotChiConfig;
  storePath?: string;
  retentionMs?: number;
  progress?: ProgressConfig;
  /** B3: gate actions behind an approver's reaction. Omitted = no gate (B2). */
  approvals?: BotApprovalsConfig;
  /** B4: scheduled posts (read-only plan-mode Chi runs). Needs `daemon` + `chi`. */
  schedules?: ScheduleConfig[];
  /** B5: ceiling for every Chi run this bot starts: plan | acceptEdits | bypassPermissions. Default plan. */
  maxMode?: string;
  /** B5: branch prefix told to acting runs (`rex/`). Advisory. */
  branchPrefix?: string;
  /** B5: audit options (the log itself is always on). */
  audit?: AuditConfig;
  /** Outbox approvals: cards for the sender's drafts. Optional; `buttons.secret` is a secret source like the others. */
  outboxApprovals?: Omit<OutboxApprovalsConfig, 'buttons'> & {
    buttons?: Omit<NonNullable<OutboxApprovalsConfig['buttons']>, 'secret'> & { secret: SecretSource };
  };
}

export interface BridgeFileConfig {
  mattermostUrl?: string;
  dataDir?: string;
  /** Bridge-wide limits, shared by every bot in the process. */
  limits?: { maxConcurrentRuns?: number };
  bots: Record<string, BotFileConfig>;
}

export function defaultDataDir(): string {
  return process.env.IKENGA_MATTERMOST_DATA_DIR || path.join(os.homedir(), '.ikenga', 'mattermost');
}

function readBridgeFile(file: string): BridgeFileConfig {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BridgeFileConfig;
  } catch (err) {
    throw new Error(`bridge config ${file}: ${(err as Error).message}`);
  }
}

export function loadBridgeConfigs(file: string): MattermostBridgeConfig[] {
  return resolveBridgeConfigs(readBridgeFile(file));
}

/** The per-bot configs and the bridge-wide limits of one config file, read once. */
export function loadBridgeSetup(file: string): { bots: MattermostBridgeConfig[]; limits: RunLimits } {
  const parsed = readBridgeFile(file);
  return { bots: resolveBridgeConfigs(parsed), limits: resolveLimits(parsed.limits) };
}

export function resolveBridgeConfigs(cfg: BridgeFileConfig): MattermostBridgeConfig[] {
  if (Object.keys(cfg.bots ?? {}).length === 0) throw new Error('bridge config: "bots" must name at least one bot');
  resolveLimits(cfg.limits); // refuse a bad limits block at load, whichever way the config arrives
  const dataDir = cfg.dataDir ?? defaultDataDir();

  return Object.entries(cfg.bots).map(([name, bot]) => {
    const where = `bot '${name}'`;
    const mattermostUrl = bot.mattermostUrl ?? cfg.mattermostUrl;
    if (!mattermostUrl) throw new Error(`${where}: mattermostUrl is required`);
    // An approvals-only bot (a dedicated account that posts and reads the Outbox cards and runs nothing else) has neither
    // `daemon` nor `chi`. Any other bot needs both.
    const approvalsOnly = bot.outboxApprovals !== undefined && bot.daemon === undefined && bot.chi === undefined;
    let daemon: MattermostBridgeConfig['daemon'];
    if (!approvalsOnly) {
      if (!bot.daemon?.url) throw new Error(`${where}: daemon.url is required`);
      if (!bot.chi?.engine) throw new Error(`${where}: chi.engine is required`);
      const a = bot.daemon.auth;
      if (!a) throw new Error(`${where}: daemon.auth is required`);
      const auth =
        a.kind === 'session'
          ? {
              kind: 'session' as const,
              username: a.username,
              password: resolveSecret(a.password, `${where} daemon password`),
            }
          : a.kind === 'bearer'
            ? { kind: 'bearer' as const, token: resolveSecret(a.token, `${where} daemon token`) }
            : (() => {
                throw new Error(`${where}: daemon.auth.kind must be 'session' (T1) or 'bearer' (T0)`);
              })();
      if (auth.kind === 'session' && !auth.username) throw new Error(`${where}: daemon.auth.username is required`);
      daemon = { url: bot.daemon.url, auth, origin: bot.daemon.origin, requestTimeoutMs: bot.daemon.requestTimeoutMs };
    } else if (bot.approvals || bot.schedules?.length) {
      throw new Error(`${where}: approvals and schedules need daemon and chi; a bot with only outboxApprovals runs neither`);
    }
    if (bot.approvals) {
      resolveApprovals(bot.approvals, where); // fail at load, naming the bot
      if (bot.chi?.mode) throw new Error(`${where}: chi.mode is ignored under approvals; set approvals.actingMode instead`);
    }

    // B5: the ceiling. Refuses chi.mode / approvals.actingMode above maxMode (default plan) rather than downgrading.
    resolveModeRails(bot, where);
    resolveBranchPrefix(bot.branchPrefix, where);
    resolveAuditConfig(bot.audit, where, bot.allowedChannels ?? []);

    // B4: refuse a bad schedule (cron, channel, duplicate name, unknown field) at load, naming the bot and the schedule.
    resolveSchedules(bot.schedules, where, bot.allowedChannels ?? []);

    // Outbox approvals: resolve the button secret, then refuse a bad block at load, naming the bot.
    let outboxApprovals: OutboxApprovalsConfig | undefined;
    if (bot.outboxApprovals !== undefined) {
      const o = bot.outboxApprovals;
      const b = o && typeof o === 'object' ? o.buttons : undefined;
      outboxApprovals = {
        ...(o as object),
        ...(b && typeof b === 'object' && b.secret !== undefined ? { buttons: { ...b, secret: resolveSecret(b.secret, `${where} outboxApprovals.buttons.secret`) } } : {}),
      } as OutboxApprovalsConfig;
      resolveOutboxApprovals(outboxApprovals, where);
    }

    return {
      name,
      mattermostUrl,
      mattermostToken: resolveSecret(bot.mattermostToken, `${where} mattermost token`),
      botUserId: bot.botUserId,
      allowedUsers: bot.allowedUsers ?? [],
      allowedChannels: bot.allowedChannels ?? [],
      daemon,
      chi: bot.chi,
      dataDir,
      storePath: bot.storePath,
      retentionMs: bot.retentionMs,
      progress: bot.progress,
      approvals: bot.approvals,
      schedules: bot.schedules,
      maxMode: bot.maxMode,
      branchPrefix: bot.branchPrefix,
      audit: bot.audit,
      outboxApprovals,
    };
  });
}
