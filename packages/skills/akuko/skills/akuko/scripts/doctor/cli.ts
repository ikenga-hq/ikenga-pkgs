/**
 * akuko — doctor, node half. Called by `scripts/doctor.sh`.
 *
 *   node --experimental-strip-types scripts/doctor/cli.ts [project-dir | akuko.json] [--now ISO] [--probe]
 *
 * `--probe` also checks that each keyed provider's API host is reachable
 * (`scripts/probe.ts`: one keyless GET each, nothing billed). Without it,
 * doctor makes no network call.
 *
 * Prints which provider keys are set (names only, never values), the provider
 * config drift, and, when a project is found, its budget / ledger checks and
 * its rules status (WP-26: present or required, allowed files missing on disk).
 * Exit 0 even with warnings (they are advice); exit 1 only when `akuko.json`
 * exists but is not a valid project.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AkukoProjectSchema } from '../../schema/akuko-project.ts';
import { loadProviderConfig } from '../../providers/config.ts';
import { keyPresence } from '../../setup/setup.ts';
import { checkProject, configFindings, formatFinding, type Finding } from './project-checks.ts';
import { rulesReport } from './rules-checks.ts';
import { formatProbe, probeProvider, probeableProviders, readConfig } from '../probe.ts';

/** Where to check that a key can actually buy images (no network call is made). */
export const BILLING_HINT: Record<string, string> = {
  'gemini-image': 'Gemini image models need a paid tier: on the free tier they answer HTTP 429. Check billing / tier at https://ai.google.dev/gemini-api/docs/billing',
  fal: 'fal bills per image from your account balance. Check it at https://fal.ai/dashboard/usage-billing/billing',
  'gemini-video': 'Gemini Omni Flash video needs a paid tier on the key\'s project (https://ai.google.dev/gemini-api/docs/billing). Veo is no longer on the Gemini API.',
  'kling-video': 'Kling\'s API draws on a prepaid resource package or balance bought in the Kling developer console (error 1102 means it is used up).',
  'byteplus-video': 'BytePlus ModelArk bills your BytePlus balance; each Seedance model must be activated in the ModelArk console (ap-southeast-1) first. Seedance 2.5 asks for a balance above USD 30.',
  'byteplus-image': 'BytePlus ModelArk bills your BytePlus balance; each Seedream model must be activated in the ModelArk console (ap-southeast-1) first.',
};

/** `--probe`: is each keyed provider's API host reachable from here? One keyless GET each. */
export async function probeAll(out: (line: string) => void = console.log, fetchFn?: typeof globalThis.fetch): Promise<void> {
  const config = readConfig();
  out('network (keyless probe, nothing billed):');
  for (const id of probeableProviders(config)) {
    for (const l of formatProbe(await probeProvider(id, { config, ...(fetchFn ? { fetch: fetchFn } : {}) }))) out(l);
  }
}

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
  const config0 = loadProviderConfig();
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
  for (const [id, p] of Object.entries(config0.providers)) {
    const unpriced = Object.keys(p.unverified_models ?? {});
    if (unpriced.length) out(`  ${id.padEnd(22)} price unverified, not runnable: ${unpriced.join(', ')}`);
  }

  if (Object.values(keys).some((k) => k.present)) {
    out('  note: a key being set does not prove the account can buy images (doctor makes no network call).');
    for (const id of ids) if (keys[id]?.present && BILLING_HINT[id]) out(`    ${id}: ${BILLING_HINT[id]}`);
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
    const rules = rulesReport(parsed.data, dirname(file));
    out(`  ${rules.summary}${rules.allowed ? `; ${rules.missing} of ${rules.allowed} allowed file${rules.allowed === 1 ? '' : 's'} not found on disk` : ''}`);
    findings = [...checkProject(parsed.data, config, { now }), ...rules.findings];
  }

  if (findings.length === 0) out('  no findings');
  for (const f of findings) out(formatFinding(f));
  return 0;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/doctor/cli.ts')) {
  const argv = process.argv.slice(2);
  process.exitCode = run(argv);
  if (argv.includes('--probe')) await probeAll();
}
