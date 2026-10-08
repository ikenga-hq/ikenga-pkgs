import { readFileSync } from 'node:fs';
import { auditFiles, auditPath, parseSince, readAudit, verifyAudit } from './audit.js';
import { defaultDataDir } from './config.js';

export interface AuditCliArgs {
  bot: string;
  since?: string;
  verify: boolean;
}

export interface AuditCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => number;
}

/**
 * `--audit <bot> [--since <time>] [--verify]`. Reads only the audit file(s); it reads the bridge config as plain JSON
 * for `dataDir` and the bot's `audit.path`, so it needs no secrets and never contacts Mattermost or the daemon.
 * Prints each retained record as one JSON line (oldest first), or with `--verify` checks the hash chain.
 * Returns the exit code: 0 ok, 1 chain broken, 2 usage.
 */
export function runAuditCli(configFile: string | undefined, args: AuditCliArgs, io: AuditCliIo): number {
  if (!configFile) {
    io.err('error: --audit needs MATTERMOST_BRIDGE_CONFIG');
    return 2;
  }
  let cfg: { dataDir?: string; bots?: Record<string, { audit?: { path?: string } }> };
  try {
    cfg = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (err) {
    io.err(`error: cannot read bridge config ${configFile}: ${(err as Error).message}`);
    return 2;
  }
  const bots = cfg.bots ?? {};
  if (!Object.prototype.hasOwnProperty.call(bots, args.bot)) {
    io.err(`error: --audit: no bot '${args.bot}'; bots: ${Object.keys(bots).join(', ') || '(none)'}`);
    return 2;
  }
  let since: number | undefined;
  if (args.since !== undefined) {
    try {
      since = parseSince(args.since, io.now?.());
    } catch (err) {
      io.err(`error: ${(err as Error).message}`);
      return 2;
    }
  }
  const file = auditPath(cfg.dataDir ?? defaultDataDir(), args.bot, bots[args.bot]?.audit?.path);

  if (args.verify) {
    const files = auditFiles(file);
    if (files.length === 0) {
      io.err(`no audit log yet for '${args.bot}' (${file})`);
      return 0;
    }
    const r = verifyAudit(file);
    if (r.ok) {
      const crash = (r.recovered ?? []).map((x) => `recovered after crash at ${x.file}:${x.line}`).join('; ');
      io.out(`${args.bot}: chain ok, ${r.records} records in ${files.length} file${files.length === 1 ? '' : 's'}${crash ? ` (${crash}: a half-written line was sealed, not tampering)` : ''}`);
      return 0;
    }
    io.out(`${args.bot}: chain BROKEN at ${r.brokenAt?.file}:${r.brokenAt?.line} (${r.brokenAt?.reason}) after ${r.records} good records`);
    return 1;
  }

  const lines = readAudit(file);
  if (lines.length === 0) io.err(`no audit records for '${args.bot}' (${file})`);
  for (const l of lines) {
    if (!l.rec) {
      io.err(`skipped an unreadable line at ${l.file}:${l.line}`);
      continue;
    }
    if (since !== undefined && Date.parse(l.rec.ts) < since) continue;
    io.out(l.text);
  }
  return 0;
}
