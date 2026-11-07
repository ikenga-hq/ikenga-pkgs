/**
 * akuko — cost ledger.
 *
 * Pure functions over an `AkukoProject`; none of them touch a host. Each
 * returns a new project rather than editing the one passed in.
 *
 * The ledger rule (see `lib/spend.md`): one entry per unit per paid provider
 * call. The gate opens an entry as `submitted` (carrying the estimate) before
 * the provider is called, and the same entry — matched by `id` — is updated in
 * place to `done` (with `actual`), `failed` or `cancelled`. Entries are never
 * deleted and their ids are never reused, so a retry opens a new entry with
 * the next attempt number. `budget.spent` is always recomputed from the
 * entries, never adjusted by hand.
 */

import type { AkukoProject, LedgerEntry } from '../schema/akuko-project.ts';

/** Tolerance for comparing sums of money amounts held as floats. */
export const MONEY_EPSILON = 1e-9;

/** Sum of `actual` over done entries — what `budget.spent` must equal. */
export function spentFromLedger(p: AkukoProject): number {
  return p.ledger.reduce((sum, e) => (e.status === 'done' ? sum + (e.actual ?? 0) : sum), 0);
}

/** Sum of `estimate` over entries still `submitted`: money in flight, not yet settled. */
export function reservedFromLedger(p: AkukoProject): number {
  return p.ledger.reduce((sum, e) => (e.status === 'submitted' ? sum + (e.estimate ?? 0) : sum), 0);
}

export interface LedgerSummary {
  cap: number | null;            // null until setup records one
  currency: string | null;
  spent: number;                 // settled (done)
  reserved: number;              // submitted, at estimate
  remaining: number | null;      // cap − spent − reserved; null without a cap
  entries: LedgerEntry[];        // newest first
}

/** What the board shows for money. */
export function ledgerSummary(p: AkukoProject): LedgerSummary {
  const spent = spentFromLedger(p);
  const reserved = reservedFromLedger(p);
  return {
    cap: p.budget?.cap ?? null,
    currency: p.budget?.currency ?? null,
    spent,
    reserved,
    remaining: p.budget ? p.budget.cap - spent - reserved : null,
    entries: [...p.ledger].reverse(),
  };
}

/** Money still free under the cap (cap − spent − reserved), or null without a budget. */
export function remainingBudget(p: AkukoProject): number | null {
  return ledgerSummary(p).remaining;
}

/** Recompute `budget.spent` from the ledger. A project without a budget is returned as is. */
export function withSpentRecomputed(p: AkukoProject): AkukoProject {
  if (!p.budget) return p;
  return { ...p, budget: { ...p.budget, spent: spentFromLedger(p) } };
}

/** Ledger entries opened for one job (any status). */
export const entriesForJob = (p: AkukoProject, jobId: string): LedgerEntry[] =>
  p.ledger.filter((e) => e.job === jobId);

/** `<job>.<unit>.<attempt>` — stable across the submitted → done update, unique across retries. */
export function nextLedgerId(p: AkukoProject, prefix: string): string {
  const taken = new Set(p.ledger.map((e) => e.id).filter((id): id is string => id !== undefined));
  let n = 1;
  while (taken.has(`${prefix}.${n}`)) n++;
  return `${prefix}.${n}`;
}

export interface OpenEntry {
  unit: string;
  estimate: number;
}

/**
 * Open one `submitted` entry per unit for a job. Returns the new project and
 * the entry ids, in the order given.
 */
export function openEntries(
  p: AkukoProject,
  args: { job: string; provider: string; model?: string; ts: string; units: OpenEntry[] },
): { project: AkukoProject; ids: string[] } {
  let ledger = [...p.ledger];
  const ids: string[] = [];
  for (const u of args.units) {
    const id = nextLedgerId({ ...p, ledger }, `${args.job}.${u.unit}`);
    ids.push(id);
    const entry: LedgerEntry = {
      id,
      ts: args.ts,
      provider: args.provider,
      unit: u.unit,
      job: args.job,
      estimate: u.estimate,
      status: 'submitted',
      ...(args.model !== undefined ? { model: args.model } : {}),
    };
    ledger = [...ledger, entry];
  }
  return { project: { ...p, ledger }, ids };
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

/**
 * Settle one entry in place: `submitted` → `done` / `failed` / `cancelled`.
 * A done entry with no reported `actual` settles at its estimate (the honest
 * figure to plan against). Settling an entry that is already settled throws.
 */
export function settleEntry(
  p: AkukoProject,
  id: string,
  outcome: { status: 'done' | 'failed' | 'cancelled'; actual?: number; ts?: string },
): AkukoProject {
  const i = p.ledger.findIndex((e) => e.id === id);
  const entry = p.ledger[i];
  if (!entry) throw new LedgerError(`no ledger entry "${id}"`);
  if (entry.status !== 'submitted') throw new LedgerError(`ledger entry "${id}" is already ${entry.status}`);
  if (outcome.actual !== undefined && (!Number.isFinite(outcome.actual) || outcome.actual < 0)) {
    throw new LedgerError(`actual ${outcome.actual} is not a non-negative amount`);
  }
  const settled: LedgerEntry = { ...entry, status: outcome.status, ...(outcome.ts ? { ts: outcome.ts } : {}) };
  if (outcome.status === 'done') settled.actual = outcome.actual ?? entry.estimate ?? 0;
  else if (outcome.actual !== undefined) settled.actual = outcome.actual;
  const ledger = p.ledger.map((e, k) => (k === i ? settled : e));
  return withSpentRecomputed({ ...p, ledger });
}

/**
 * Record spend that already happened outside akuko (e.g. credits used on a
 * tool the person ran by hand, reported at ingest). Needs a budget: the
 * caller decides what to do when there is none.
 */
export function recordDone(
  p: AkukoProject,
  args: { provider: string; model?: string; unit: string; actual: number; ts: string; prefix: string },
): AkukoProject {
  if (!p.budget) throw new LedgerError('no budget is set; spend cannot be recorded until setup records a cap');
  if (!Number.isFinite(args.actual) || args.actual < 0) throw new LedgerError(`actual ${args.actual} is not a non-negative amount`);
  const entry: LedgerEntry = {
    id: nextLedgerId(p, args.prefix),
    ts: args.ts,
    provider: args.provider,
    unit: args.unit,
    actual: args.actual,
    status: 'done',
    ...(args.model !== undefined ? { model: args.model } : {}),
  };
  return withSpentRecomputed({ ...p, ledger: [...p.ledger, entry] });
}
