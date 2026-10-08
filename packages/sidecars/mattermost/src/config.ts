import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSecret } from './secrets.js';
import type { SecretSource } from './secrets.js';
import type { BotChiConfig, MattermostBridgeConfig, ProgressConfig } from './types.js';

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
    };
  });
}
