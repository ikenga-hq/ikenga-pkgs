import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSecret } from './secrets.js';
import type { SecretSource } from './secrets.js';
import { resolveApprovals } from './approvals.js';
import { resolveSchedules } from './schedules.js';
import { resolveAuditConfig } from './audit.js';
import { resolveBranchPrefix, resolveModeRails } from './rails.js';
import type { AuditConfig, BotApprovalsConfig, BotChiConfig, MattermostBridgeConfig, ProgressConfig, ScheduleConfig } from './types.js';

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
  daemon: {
    url: string;
    origin?: string;
    requestTimeoutMs?: number;
    auth:
      | { kind: 'session'; username: string; password: SecretSource }
      | { kind: 'bearer'; token: SecretSource };
  };
  chi: BotChiConfig;
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
}

export interface BridgeFileConfig {
  mattermostUrl?: string;
  dataDir?: string;
  bots: Record<string, BotFileConfig>;
}

export function defaultDataDir(): string {
  return process.env.IKENGA_MATTERMOST_DATA_DIR || path.join(os.homedir(), '.ikenga', 'mattermost');
}

export function loadBridgeConfigs(file: string): MattermostBridgeConfig[] {
  let parsed: BridgeFileConfig;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as BridgeFileConfig;
  } catch (err) {
    throw new Error(`bridge config ${file}: ${(err as Error).message}`);
  }
  return resolveBridgeConfigs(parsed);
}

export function resolveBridgeConfigs(cfg: BridgeFileConfig): MattermostBridgeConfig[] {
  const names = Object.keys(cfg.bots ?? {});
  if (names.length === 0) throw new Error('bridge config: "bots" must name at least one bot');
  const dataDir = cfg.dataDir ?? defaultDataDir();

  return names.map((name) => {
    const bot = (cfg.bots as Record<string, BotFileConfig>)[name] as BotFileConfig;
    const where = `bot '${name}'`;
    const mattermostUrl = bot.mattermostUrl ?? cfg.mattermostUrl;
    if (!mattermostUrl) throw new Error(`${where}: mattermostUrl is required`);
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
    if (bot.approvals) {
      resolveApprovals(bot.approvals, where); // fail at load, naming the bot
      if (bot.chi.mode) throw new Error(`${where}: chi.mode is ignored under approvals; set approvals.actingMode instead`);
    }

    // B5: the ceiling. Refuses chi.mode / approvals.actingMode above maxMode (default plan) rather than downgrading.
    resolveModeRails(bot, where);
    resolveBranchPrefix(bot.branchPrefix, where);
    resolveAuditConfig(bot.audit, where, bot.allowedChannels ?? []);

    // B4: refuse a bad schedule (cron, channel, duplicate name, unknown field) at load, naming the bot and the schedule.
    resolveSchedules(bot.schedules, where, bot.allowedChannels ?? []);

    return {
      name,
      mattermostUrl,
      mattermostToken: resolveSecret(bot.mattermostToken, `${where} mattermost token`),
      botUserId: bot.botUserId,
      allowedUsers: bot.allowedUsers ?? [],
      allowedChannels: bot.allowedChannels ?? [],
      daemon: {
        url: bot.daemon.url,
        auth,
        origin: bot.daemon.origin,
        requestTimeoutMs: bot.daemon.requestTimeoutMs,
      },
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
    };
  });
}
