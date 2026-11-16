/**
 * akuko — the allowance gate (B-10): generations that cost the person a
 * connected service's plan allowance, not money.
 *
 * On claude.ai a connector such as Canva makes images and video against the
 * person's own monthly AI allowance. That is not money akuko can price, and
 * akuko cannot see how much of it is left, but it is still the person's to
 * spend: on 2026-11-11 one run used a whole month's Canva allowance (21 images)
 * with no warning. So every wave of such generations waits for the person's
 * explicit OK of that wave, like a paid job, and every generation is recorded in
 * the ledger with zero money and a units count. Rules in prose: lib/spend.md
 * §Allowance. Pure functions; nothing here calls a service.
 */

import type { AkukoProject, LedgerEntry } from '../schema/akuko-project.ts';
import { nextLedgerId } from './ledger.ts';

export interface AllowanceWave {
  /** What the wave makes, e.g. "Key frames for scene 1". */
  label: string;
  /** The service whose allowance it uses, lower-case: `canva`. */
  service: string;
  /** The service's own name for the person: "Canva". Defaults to the service id. */
  serviceLabel?: string;
  /** The tool or model, e.g. `generate-image`. */
  tool?: string;
  /** One row per unit: how many generations it takes (default 1). */
  units: { unit: string; count?: number }[];
}

const count = (w: AllowanceWave): number => w.units.reduce((n, u) => n + (u.count ?? 1), 0);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Generations recorded against `service` so far (done entries; a failed call may still have used some, so it counts too when it says so). */
export function allowanceUsed(p: Pick<AkukoProject, 'ledger'>, service: string): number {
  return p.ledger.reduce((n, e) => (e.allowance?.service === service && e.status !== 'cancelled' && e.status !== 'submitted' ? n + e.allowance.units : n), 0);
}

/** The person's cap for `service` in this project, if they set one (`budget.allowance_caps`). */
export const allowanceCap = (p: Pick<AkukoProject, 'budget'>, service: string): number | undefined => p.budget?.allowance_caps?.[service];

/** The exact reply that approves one wave: `approve <n> <service> generations`. */
export const allowanceReply = (w: AllowanceWave): string => `approve ${plural(count(w), `${w.service} generation`)}`;

/** True only for the exact reply words (first word any case), as for a money approval. */
export function isAllowanceApproval(text: string, w: AllowanceWave): boolean {
  const said = text.trim();
  return said.slice(0, 7).toLowerCase() + said.slice(7) === allowanceReply(w);
}

/** Why the wave may not run, or null. Only the person's own cap can refuse it: akuko cannot see the service's balance. */
export function allowanceRefusal(p: Pick<AkukoProject, 'budget' | 'ledger'>, w: AllowanceWave): string | null {
  if (w.units.length === 0) return 'the wave has no units.';
  const cap = allowanceCap(p, w.service);
  if (cap === undefined) return null;
  const used = allowanceUsed(p, w.service);
  const n = count(w);
  if (used + n <= cap) return null;
  return `${plural(n, 'generation')} would take ${w.serviceLabel ?? w.service} use in this project to ${used + n}, over your cap of ${cap} (${used} used). Make fewer, or raise the cap with /akuko setup.`;
}

/**
 * The line shown before every wave, the allowance twin of `confirmationLine()`:
 *
 *   Allowance check — Key frames for scene 1: 3 generations with Canva (generate-image). They use your Canva
 *   plan's AI allowance, not money; akuko can't see how much of it is left. Used through akuko in this project: 21
 *   (cap 30, 6 left after this). Reply "approve 3 canva generations" to run it; anything else stops it.
 */
export function allowanceLine(p: Pick<AkukoProject, 'budget' | 'ledger'>, w: AllowanceWave): string {
  const name = w.serviceLabel ?? w.service;
  const n = count(w);
  const used = allowanceUsed(p, w.service);
  const cap = allowanceCap(p, w.service);
  const head = `Allowance check — ${w.label}: ${plural(n, 'generation')} with ${name}${w.tool ? ` (${w.tool})` : ''}. They use your ${name} plan's AI allowance, not money; akuko can't see how much of it is left.`;
  const tally = `Used through akuko in this project: ${used}${cap !== undefined ? ` (cap ${cap}, ${cap - used - n} left after this)` : ''}.`;
  const refusal = allowanceRefusal(p, w);
  if (refusal) return `${head} ${tally} Not run: ${refusal}`;
  return `${head} ${tally} Reply "${allowanceReply(w)}" to run it; anything else stops it.`;
}

/**
 * The done allowance entry that a file brought back for `units` (the unit, or the planned asset id) was made by: one
 * of `service`, status `done`, already linked to `job`, else the latest one not linked to any job. Its index in the
 * ledger, or -1. Used by `ingest --via <service>` and `rules/cli.ts adopt-allowance`.
 */
export function allowanceEntryFor(p: Pick<AkukoProject, 'ledger'>, service: string, units: string[], job: string): number {
  const fits = (e: LedgerEntry): boolean => e.status === 'done' && e.allowance?.service === service && units.includes(e.unit);
  const linked = p.ledger.findIndex((e) => fits(e) && e.allowance?.job === job);
  if (linked !== -1) return linked;
  for (let i = p.ledger.length - 1; i >= 0; i--) {
    const e = p.ledger[i]!;
    if (fits(e) && e.allowance?.job === undefined) return i;
  }
  return -1;
}

/** The project with ledger entry `index` linked to `job` (its `allowance.job`). Returns a new project. */
export function linkAllowance(p: AkukoProject, index: number, job: string): AkukoProject {
  const e = p.ledger[index];
  if (!e?.allowance) throw new Error(`ledger entry ${index} is not an allowance entry`);
  if (e.allowance.job === job) return p;
  const ledger = p.ledger.map((x, i) => (i === index ? { ...x, allowance: { ...x.allowance!, job } } : x));
  return { ...p, ledger };
}

/**
 * Record what a wave used: one ledger entry per unit, zero money, `allowance.units` generations. `status: 'failed'`
 * records a call that made nothing (it still counts as used when the service charged for it: pass the units it used).
 * Returns a new project; the input is not changed.
 */
export function recordAllowance(
  p: AkukoProject,
  r: { service: string; tool?: string; ts: string; job?: string; units: { unit: string; count?: number; status?: 'done' | 'failed' }[] },
): AkukoProject {
  let ledger = [...p.ledger];
  for (const u of r.units) {
    const n = u.count ?? 1;
    const entry: LedgerEntry = {
      id: nextLedgerId({ ...p, ledger }, `allow_${r.service}.${u.unit}`),
      ts: r.ts,
      provider: r.service,
      ...(r.tool !== undefined ? { model: r.tool } : {}),
      unit: u.unit,
      estimate: 0,
      actual: 0,
      status: u.status ?? 'done',
      allowance: { service: r.service, units: n, ...(r.job !== undefined ? { job: r.job } : {}) },
    };
    ledger = [...ledger, entry];
  }
  return { ...p, ledger };
}
