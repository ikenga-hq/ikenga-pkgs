/**
 * akuko — doctor: project and provider-config checks (WP-08).
 *
 * Pure functions over an `AkukoProject` and the provider config, so they run
 * the same on every host (the chat reads the project through the host
 * adapter; `cli.ts` reads `akuko.json` from disk). Nothing here changes a
 * project: doctor reports, the person decides.
 */

import type { AkukoProject, LedgerEntry } from '../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../../providers/config.ts';
import { staleModels } from '../../providers/config.ts';

export type FindingLevel = 'warn' | 'info';

export interface Finding {
  level: FindingLevel;
  code:
    | 'no-budget'
    | 'currency-mismatch'
    | 'orphan-reservation'
    | 'stale-model'
    | 'example-in-use'
    | 'example-present'
    | 'unknown-provider'
    // project rules (WP-26, rules-checks.ts)
    | 'rules-invalid'
    | 'rules-required-empty'
    | 'rules-allowed-missing'
    | 'rules-setup';
  message: string;
  /** What the person can do about it. Doctor never does it for them. */
  fix?: string;
}

/** A `submitted` ledger entry older than this is treated as possibly orphaned. */
export const ORPHAN_AFTER_MINUTES = 60;

export const SETUP_FIX = 'Run `/akuko setup` and give a budget cap.';

export const ORPHAN_FIX =
  'Check the provider dashboard. If the job finished, re-run the action that started it: it collects the result and settles the entry. ' +
  'If the job never ran or was abandoned, tell akuko to mark the entry cancelled (this frees the reserved money). ' +
  'akuko never clears a reservation on its own; only a person says a job is gone.';

/**
 * Orphan = a ledger entry still `submitted` that either has no matching
 * approved pending spend (nothing authorised it, or the approval was
 * removed), or was submitted more than `afterMinutes` ago (the job is probably
 * not coming back). It still counts against the cap until a person settles it.
 */
export function orphanReservations(
  p: AkukoProject,
  now: string,
  afterMinutes: number = ORPHAN_AFTER_MINUTES,
): Array<{ entry: LedgerEntry; reason: string }> {
  const out: Array<{ entry: LedgerEntry; reason: string }> = [];
  const t = Date.parse(now);
  for (const entry of p.ledger) {
    if (entry.status !== 'submitted') continue;
    const approved = p.pending_spend.some((s) => s.id === entry.job && s.status === 'approved');
    const ageMin = Math.floor((t - Date.parse(entry.ts)) / 60_000);
    if (!approved) out.push({ entry, reason: 'no approved pending spend matches it' });
    else if (ageMin > afterMinutes) out.push({ entry, reason: `submitted ${ageMin} minutes ago and never settled` });
  }
  return out;
}

export interface CheckOptions {
  /** ISO timestamp for "now". */
  now: string;
  orphanAfterMinutes?: number;
}

/** Provider-config drift: stale prices. Needs no project. */
export function configFindings(config: AkukoProviderConfig, now: string): Finding[] {
  const out: Finding[] = [];
  for (const s of staleModels(config, now.slice(0, 10))) {
    if (config.providers[s.provider]?.billing === 'free') continue; // a price of zero cannot drift
    out.push({
      level: 'warn',
      code: 'stale-model',
      message: `Price for ${s.provider} / ${s.model} was last verified ${s.last_verified} (${s.age_days} days ago; limit ${config.stale_after_days}).`,
      fix: 'Check the provider pricing page and update providers/config.json, including last_verified.',
    });
  }
  return out;
}

export function checkProject(p: AkukoProject, config: AkukoProviderConfig, opts: CheckOptions): Finding[] {
  const findings: Finding[] = [];
  const cur = config.currency;

  if (!p.budget) {
    findings.push({
      level: 'warn',
      code: 'no-budget',
      message: 'No budget cap is recorded: every paid job will be refused.',
      fix: SETUP_FIX,
    });
  } else if (p.budget.currency !== cur) {
    findings.push({
      level: 'warn',
      code: 'currency-mismatch',
      message: `Budget is in ${p.budget.currency} but providers are priced in ${cur}: the spend gate refuses paid jobs.`,
      fix: 'Run `/akuko setup` again to record the cap in the provider currency.',
    });
  }

  for (const { entry, reason } of orphanReservations(p, opts.now, opts.orphanAfterMinutes)) {
    const reserved = entry.estimate !== undefined ? ` (${entry.estimate} ${p.budget?.currency ?? cur} reserved)` : '';
    findings.push({
      level: 'warn',
      code: 'orphan-reservation',
      message: `Ledger entry "${entry.id ?? entry.unit}" is still submitted${reserved}: ${reason}.`,
      fix: ORPHAN_FIX,
    });
  }

  findings.push(...configFindings(config, opts.now));

  const used = new Set<string>([...p.pending_spend.map((s) => s.provider), ...p.ledger.map((e) => e.provider)]);
  for (const [id, entry] of Object.entries(config.providers)) {
    if (!entry.example) continue;
    if (used.has(id)) {
      findings.push({
        level: 'warn',
        code: 'example-in-use',
        message: `Example provider "${id}" (placeholder price) is referenced by this project. Example entries exist for tests only.`,
        fix: 'Use a real provider, or the manual provider, for this work.',
      });
    } else {
      findings.push({
        level: 'info',
        code: 'example-present',
        message: `providers/config.json still lists the example entry "${id}". The gate refuses it outside tests.`,
      });
    }
  }

  for (const id of [...new Set(p.pending_spend.map((s) => s.provider))]) {
    if (!(id in config.providers)) {
      findings.push({
        level: 'warn',
        code: 'unknown-provider',
        message: `A pending spend names provider "${id}", which is not in providers/config.json: it cannot be priced or run.`,
        fix: 'Decline or re-quote the pending spend with a configured provider.',
      });
    }
  }

  return findings;
}

export function formatFinding(f: Finding): string {
  const tag = f.level === 'warn' ? 'WARN' : 'info';
  return `  [${tag}] ${f.message}${f.fix ? `\n         fix: ${f.fix}` : ''}`;
}
