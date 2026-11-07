/**
 * akuko — doctor, node half. Called by `scripts/doctor.sh`.
 *
 *   node --experimental-strip-types scripts/doctor/cli.ts [project-dir | akuko.json] [--now ISO]
 *
 * Prints which provider keys are set (names only, never values), the provider
 * config drift, and, when a project is found, its budget / ledger checks.
 * Exit 0 even with warnings (they are advice); exit 1 only when `akuko.json`
 * exists but is not a valid project.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AkukoProjectSchema } from '../../schema/akuko-project.ts';
import { loadProviderConfig } from '../../providers/config.ts';
import { keyPresence } from '../../setup/setup.ts';
import { checkProject, configFindings, formatFinding, type Finding } from './project-checks.ts';

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function projectFile(target: string): string | null {
  if (!existsSync(target)) return null;
  const file = statSync(target).isDirectory() ? join(target, 'akuko.json') : target;
  return existsSync(file) ? file : null;
}

export function run(args: string[], out: (line: string) => void = console.log): number {
  const now = argValue(args, '--now') ?? new Date().toISOString();
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--now');
  const target = positional[0] ?? process.cwd();
  const config = loadProviderConfig();

  out('provider keys (names only):');
  const keys = keyPresence(config, process.env);
  const ids = Object.keys(keys);
  if (ids.length === 0) out('  none needed yet: only the manual provider and example entries are configured');
  for (const id of ids) {
    const k = keys[id];
    if (k) out(`  ${id.padEnd(22)} ${k.env}: ${k.present ? 'set' : 'not set (optional until you use that provider)'}`);
  }

  if (configFindings(config, now).length === 0) out(`provider config: all model prices verified within ${config.stale_after_days} days`);

  const file = projectFile(target);
  let findings: Finding[] = [];
  if (!file) {
    out('project: no akuko.json here (run `/akuko intake` or `/akuko setup`)');
    findings = configFindings(config, now);
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      out(`project: ${file} is not valid JSON (${(err as Error).message})`);
      return 1;
    }
    const parsed = AkukoProjectSchema.safeParse(raw);
    if (!parsed.success) {
      out(`project: ${file} is not a valid akuko project:`);
      for (const issue of parsed.error.issues.slice(0, 5)) out(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      return 1;
    }
    out(`project: ${parsed.data.project.title} (${file})`);
    findings = checkProject(parsed.data, config, { now });
  }

  if (findings.length === 0) out('  no findings');
  for (const f of findings) out(formatFinding(f));
  return 0;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/doctor/cli.ts')) {
  process.exitCode = run(process.argv.slice(2));
}
