/**
 * akuko — spend gate (G-ADAPTER).
 *
 * Every provider call that can cost money goes through `gate.run(job)`. The
 * structural guarantee is in two parts:
 *
 *   1. `sealProvider()` wraps a provider so its `submit()` throws
 *      `SpendGateBypassError` unless it is handed a one-shot ticket — a frozen
 *      copy of the job that only `gate.run()` mints, and only after the checks
 *      below. The ticket set and the minting function are private to this
 *      module.
 *   2. `gate.run()` is the only code that calls `submit()` (a test scans every
 *      non-test source file for `.submit(` to keep it that way).
 *
 * Before minting a ticket, `run()` always calls `provider.estimate(job)` and,
 * for a paid provider (billing ≠ free in config.json), requires:
 *   - a recorded budget cap (`akuko.json.budget`; null → refused, pointing to setup);
 *   - a `pending_spend` entry for the job with status `approved`, for the same
 *     provider, stage and units;
 *   - the fresh estimate ≤ the approved bound (`approved_max`, else the
 *     approved estimate) and ≤ cap − spent − reserved;
 *   - no earlier attempt of the job still in flight or done;
 *   - on host A, no paid direct API (R-11).
 * Free providers (the manual provider) skip the money checks but still go
 * through `estimate()` and the ticket.
 *
 * Full rules: `lib/spend.md`.
 */

import type { AkukoProject, Asset, Budget, PendingSpend } from '../schema/akuko-project.ts';
import { findUnit } from '../schema/akuko-project.ts';
import type {
  Cost,
  HostLevel,
  Job,
  JobHandle,
  JobStatus,
  Provider,
  ProviderBilling,
  ProviderImpl,
  WaveOneHost,
} from '../providers/contract.ts';
import { costProblems, isPaid, isTerminal, jobProblems, jobUnits } from '../providers/contract.ts';
import type { AkukoProviderConfig } from '../providers/config.ts';
import { loadProviderConfig, providerConfig } from '../providers/config.ts';
import { assertValidProject, recordOutput } from '../providers/outputs.ts';
import {
  MONEY_EPSILON,
  entriesForJob,
  ledgerSummary,
  openEntries,
  remainingBudget,
  settleEntry,
} from './ledger.ts';

// ─────────────────────────────────────────────────────────────────────────
// Sealing
// ─────────────────────────────────────────────────────────────────────────

export class SpendGateBypassError extends Error {
  override name = 'SpendGateBypassError';
}

/** Providers made by `sealProvider()`. The gate accepts no others. */
const sealed = new WeakSet<Provider>();
/** One-shot tickets: frozen job copies minted by `run()` for exactly one submit. */
const tickets = new WeakSet<Job>();

function mintTicket(job: Job): Job {
  const ticket = Object.freeze(structuredClone(job));
  tickets.add(ticket);
  return ticket;
}

export interface SealOptions {
  /** Config to read billing from. Defaults to the committed providers/config.json. */
  config?: AkukoProviderConfig;
}

/**
 * Turn a provider implementation into a `Provider` the gate will run.
 * `billing` is read from config.json (an entry is required). The returned
 * `submit()` refuses any job that is not a ticket minted by `gate.run()`.
 */
export function sealProvider(impl: ProviderImpl, opts: SealOptions = {}): Provider {
  const billing: ProviderBilling = providerConfig(opts.config ?? loadProviderConfig(), impl.id).billing;
  const provider: Provider = Object.freeze({
    id: impl.id,
    kinds: Object.freeze([...impl.kinds]) as Provider['kinds'],
    hosts: Object.freeze([...impl.hosts]) as Provider['hosts'],
    capabilities: Object.freeze({ ...impl.capabilities }),
    billing,
    estimate: (job: Job) => impl.estimate(job),
    submit: async (job: Job): Promise<JobHandle> => {
      if (!tickets.has(job)) {
        throw new SpendGateBypassError(
          `${impl.id}.submit() was called outside the spend gate. Run the job through gate.run(), which estimates it and checks the budget and approval first.`,
        );
      }
      tickets.delete(job);
      return impl.submit(job);
    },
    poll: (h: JobHandle) => impl.poll(h),
    fetch: (h: JobHandle) => impl.fetch(h),
  });
  sealed.add(provider);
  return provider;
}

export const isSealed = (p: Provider): boolean => sealed.has(p);

// ─────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────

export const SETUP_POINTER =
  'No budget cap is recorded for this project. Run `/akuko setup` to set one — no paid generation runs until it does.';

export type RefusalCode =
  | 'invalid-job'
  | 'unknown-provider'
  | 'unsealed-provider'
  | 'kind-not-supported'
  | 'host-not-supported'
  | 'paid-direct-on-host-a'
  | 'invalid-estimate'
  | 'no-budget'
  | 'currency-mismatch'
  | 'unknown-job'
  | 'not-approved'
  | 'declined'
  | 'approval-mismatch'
  | 'already-submitted'
  | 'over-approved'
  | 'over-cap';

export interface Refusal {
  code: RefusalCode;
  message: string;
}

const refuse = (code: RefusalCode, message: string): Refusal => ({ code, message });

/** Thrown by `quote()` for a job it cannot price (bad job, unknown provider, bad estimate). */
export class SpendGateError extends Error {
  override name = 'SpendGateError';
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

const money = (n: number): string => String(Number(n.toFixed(4)));

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * Can a pending spend be approved right now? For decision folding (WP-07a):
 * an `approve-spend` decision folds to `status: 'approved'` only when this
 * returns null. Checks the budget exists and the approved bound
 * (`approved_max`, else the estimate) fits in cap − spent − reserved.
 */
export function canApprove(p: AkukoProject, jobId: string): Refusal | null {
  if (!p.budget) return refuse('no-budget', SETUP_POINTER);
  const entry = p.pending_spend.find((j) => j.id === jobId);
  if (!entry) return refuse('unknown-job', `no pending spend "${jobId}"`);
  const bound = entry.approved_max ?? entry.estimate;
  const left = remainingBudget(p) ?? 0;
  if (bound > left + MONEY_EPSILON) {
    return refuse(
      'over-cap',
      `"${entry.label}" may cost up to ${money(bound)} ${p.budget.currency} but only ${money(left)} is left of the ${money(p.budget.cap)} cap. Raise the cap in setup or trim the job.`,
    );
  }
  return null;
}

/** Money checks for a paid job against its pending entry. `null` = clear to submit. */
function checkPaid(p: AkukoProject, job: Job, cost: Cost, budget: Budget, entry: PendingSpend): Refusal | null {
  const cur = budget.currency;
  if (entry.status === 'declined') return refuse('declined', `"${entry.label}" was declined; quote it again if you want to ask afresh.`);
  if (entry.status !== 'approved') {
    return refuse('not-approved', `"${entry.label}" (${money(entry.estimate)} ${cur}) is waiting for your approval on the board.`);
  }
  if (entry.provider !== job.provider || entry.stage !== job.stage || !sameSet(entry.units, jobUnits(job))) {
    return refuse('approval-mismatch', `the approval for "${entry.id}" was for a different provider, stage or set of units; quote the job again.`);
  }
  const live = entriesForJob(p, job.id).filter((e) => e.status === 'submitted' || e.status === 'done');
  if (live.length > 0) return refuse('already-submitted', `"${entry.id}" has already been submitted (${live.length} ledger entr${live.length === 1 ? 'y' : 'ies'}).`);
  const bound = entry.approved_max ?? entry.estimate;
  if (cost.amount > bound + MONEY_EPSILON) {
    return refuse('over-approved', `the estimate is now ${money(cost.amount)} ${cur}, above the ${money(bound)} ${cur} you approved; it needs approving again.`);
  }
  const left = remainingBudget(p) ?? 0;
  if (cost.amount > left + MONEY_EPSILON) {
    return refuse('over-cap', `the estimate ${money(cost.amount)} ${cur} is more than the ${money(left)} ${cur} left of the ${money(budget.cap)} ${cur} cap.`);
  }
  return null;
}

/**
 * The line a person must answer before a paid generation runs where the gate
 * cannot (R-11: a connected-MCP tool on host A). Also returned by the gate on
 * every paid quote, so all hosts show the same words.
 */
export function confirmationLine(p: AkukoProject, job: Job, cost: Cost, providerLabel = job.provider): string {
  const s = ledgerSummary(p);
  const cur = p.budget?.currency ?? cost.currency;
  const n = job.items.length;
  const head = `Spend check — ${job.label}: ${providerLabel}${cost.model ? ` (${cost.model})` : ''}, ${n} unit${n === 1 ? '' : 's'}, estimate ${money(cost.amount)} ${cur}.`;
  if (s.cap === null) return `${head} ${SETUP_POINTER}`;
  const after = (s.remaining ?? 0) - cost.amount;
  return `${head} Budget ${money(s.cap)} ${cur}: spent ${money(s.spent)}, in flight ${money(s.reserved)}, left after this ${money(after)}. Reply "approve ${money(cost.amount)} ${cur}" to run it; anything else stops it.`;
}

// ─────────────────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────────────────

export interface SpendGateOptions {
  host: WaveOneHost;
  providers: Provider[];
  /** Host level. Defaults to `akuko.json.host.level`, then to 'A' (the strictest). */
  level?: HostLevel;
  /** Clock, for tests. */
  now?: () => string;
}

export interface QuoteResult {
  cost: Cost;
  billing: ProviderBilling;
  paid: boolean;
  pending?: PendingSpend;        // the pending_spend entry, for paid jobs with a budget
  confirmation?: string;         // for paid jobs
  refusal?: Refusal;             // why it could not run now (for paid jobs: no budget, over cap…)
}

export type RunResult =
  | { status: 'submitted'; handle: JobHandle; cost: Cost; confirmation?: string }
  | { status: 'awaiting-approval'; pending: PendingSpend; cost: Cost; confirmation: string }
  | { status: 'refused'; refusal: Refusal; cost?: Cost }
  | { status: 'failed'; error: string; cost: Cost };

export interface CollectResult {
  status: JobStatus;
  assets: Asset[];               // recorded in akuko.json (empty until done)
}

export interface SpendGate {
  /** Estimate a job and, for a paid job, write/refresh its pending_spend entry. Never submits. */
  quote(job: Job): Promise<QuoteResult>;
  /** Estimate, check, then submit — the only way any provider's submit() runs. */
  run(job: Job): Promise<RunResult>;
  /** Poll a submitted job; when it finishes, record its outputs and settle its ledger entries. */
  collect(handle: JobHandle): Promise<CollectResult>;
}

export function createSpendGate(opts: SpendGateOptions): SpendGate {
  const { host } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const registry = new Map<string, Provider>();
  for (const p of opts.providers) {
    if (!sealed.has(p)) throw new SpendGateBypassError(`provider "${p.id}" is not sealed; build it with sealProvider()`);
    registry.set(p.id, p);
  }

  /** Checks that need no estimate. */
  function precheck(p: AkukoProject, job: Job): { provider: Provider } | { refusal: Refusal } {
    const problems = jobProblems(job);
    if (problems.length) return { refusal: refuse('invalid-job', problems.join('; ')) };
    const provider = registry.get(job.provider);
    if (!provider) return { refusal: refuse('unknown-provider', `no provider "${job.provider}" is registered with the gate`) };
    if (!provider.kinds.includes(job.kind)) {
      return { refusal: refuse('kind-not-supported', `${provider.id} does not make ${job.kind}`) };
    }
    const level = opts.level ?? p.host?.level ?? 'A';
    if (!provider.hosts.includes(level)) {
      return { refusal: refuse('host-not-supported', `${provider.id} cannot run on host ${level}`) };
    }
    if (level === 'A' && provider.billing === 'direct-api') {
      return {
        refusal: refuse(
          'paid-direct-on-host-a',
          `${provider.id} is a paid direct API; in v0.x host A uses only the manual provider and connected MCPs. Use the manual provider, or run this stage locally.`,
        ),
      };
    }
    for (const unit of jobUnits(job)) {
      if (!findUnit(p, unit)) return { refusal: refuse('invalid-job', `unknown unit "${unit}"`) };
    }
    if (findUnit(p, job.id)) return { refusal: refuse('invalid-job', `job id "${job.id}" is already a unit id`) };
    return { provider };
  }

  async function estimate(provider: Provider, job: Job): Promise<{ cost: Cost } | { refusal: Refusal }> {
    const cost = await provider.estimate(job);
    const problems = costProblems(job, cost);
    if (!isPaid(provider.billing) && cost.amount > 0) problems.push(`free provider ${provider.id} estimated ${cost.amount}`);
    if (problems.length) return { refusal: refuse('invalid-estimate', problems.join('; ')) };
    return { cost };
  }

  function pendingFor(job: Job, cost: Cost): PendingSpend {
    const model = cost.model ?? job.model;
    return {
      id: job.id,
      stage: job.stage,
      label: job.label,
      units: jobUnits(job),
      provider: job.provider,
      kind: job.kind,
      estimate: cost.amount,
      status: 'awaiting-approval',
      created_at: now(),
      ...(model !== undefined ? { model } : {}),
    };
  }

  /**
   * Write or refresh the pending entry for a paid job. An approval stops
   * covering a job whose estimate rose above the approved bound: the entry
   * goes back to awaiting-approval with the new estimate.
   */
  async function upsertPending(p: AkukoProject, job: Job, cost: Cost): Promise<{ project: AkukoProject; pending: PendingSpend }> {
    const existing = p.pending_spend.find((j) => j.id === job.id);
    let pending: PendingSpend;
    if (!existing) {
      pending = pendingFor(job, cost);
    } else if (existing.status === 'awaiting-approval' && Math.abs(existing.estimate - cost.amount) > MONEY_EPSILON) {
      pending = { ...existing, estimate: cost.amount };
    } else if (existing.status === 'approved' && cost.amount > (existing.approved_max ?? existing.estimate) + MONEY_EPSILON) {
      const { approved_max: _m, decision: _d, ...rest } = existing;
      pending = { ...rest, estimate: cost.amount, status: 'awaiting-approval' };
    } else {
      return { project: p, pending: existing };
    }
    const project = assertValidProject({
      ...p,
      pending_spend: existing ? p.pending_spend.map((j) => (j.id === job.id ? pending : j)) : [...p.pending_spend, pending],
    });
    await host.writeState(project);
    return { project, pending };
  }

  async function quote(job: Job): Promise<QuoteResult> {
    const p = await host.readState();
    const pre = precheck(p, job);
    if ('refusal' in pre) {
      // A job the gate cannot even price is a caller error; a host refusal still gets a price.
      const provider = registry.get(job.provider);
      const unpriceable: RefusalCode[] = ['invalid-job', 'unknown-provider', 'kind-not-supported'];
      if (!provider || unpriceable.includes(pre.refusal.code)) throw new SpendGateError(pre.refusal);
      const est = await estimate(provider, job);
      if ('refusal' in est) throw new SpendGateError(est.refusal);
      return { cost: est.cost, billing: provider.billing, paid: isPaid(provider.billing), refusal: pre.refusal };
    }
    const { provider } = pre;
    const est = await estimate(provider, job);
    if ('refusal' in est) throw new SpendGateError(est.refusal);
    const { cost } = est;
    if (!isPaid(provider.billing)) return { cost, billing: provider.billing, paid: false };
    const confirmation = confirmationLine(p, job, cost, provider.id);
    if (!p.budget) return { cost, billing: provider.billing, paid: true, confirmation, refusal: refuse('no-budget', SETUP_POINTER) };
    if (p.budget.currency !== cost.currency) {
      return { cost, billing: provider.billing, paid: true, confirmation, refusal: refuse('currency-mismatch', `estimate is in ${cost.currency}, the budget in ${p.budget.currency}`) };
    }
    const { project, pending } = await upsertPending(p, job, cost);
    const refusal = checkPaid(project, job, cost, p.budget, pending) ?? undefined;
    return { cost, billing: provider.billing, paid: true, pending, confirmation, ...(refusal ? { refusal } : {}) };
  }

  async function run(job: Job): Promise<RunResult> {
    let p = await host.readState();
    const pre = precheck(p, job);
    if ('refusal' in pre) return { status: 'refused', refusal: pre.refusal };
    const { provider } = pre;

    // 1. Always estimate first.
    const est = await estimate(provider, job);
    if ('refusal' in est) return { status: 'refused', refusal: est.refusal };
    const { cost } = est;

    let ledgerIds: string[] = [];
    let confirmation: string | undefined;

    if (isPaid(provider.billing)) {
      // 2. A recorded cap, in the estimate's currency.
      if (!p.budget) return { status: 'refused', refusal: refuse('no-budget', SETUP_POINTER), cost };
      if (p.budget.currency !== cost.currency) {
        return { status: 'refused', refusal: refuse('currency-mismatch', `estimate is in ${cost.currency}, the budget in ${p.budget.currency}`), cost };
      }
      confirmation = confirmationLine(p, job, cost, provider.id);

      // 3. An approved pending entry; create one (awaiting approval) if missing.
      const entry = p.pending_spend.find((j) => j.id === job.id);
      if (!entry) {
        const { pending } = await upsertPending(p, job, cost);
        return { status: 'awaiting-approval', pending, cost, confirmation };
      }

      // 4. Approval, bound and cap.
      const refusal = checkPaid(p, job, cost, p.budget, entry);
      if (refusal) return { status: 'refused', refusal, cost };

      // 5. Reserve: open ledger entries before the provider is called.
      const opened = openEntries(p, {
        job: job.id,
        provider: provider.id,
        ts: now(),
        units: jobUnits(job).map((unit) => ({ unit, estimate: cost.per_unit[unit] ?? 0 })),
        ...(cost.model !== undefined ? { model: cost.model } : {}),
      });
      p = assertValidProject(opened.project);
      ledgerIds = opened.ids;
      await host.writeState(p);
    }

    // 6. Submit with a one-shot ticket.
    let handle: JobHandle;
    try {
      handle = await provider.submit(mintTicket(job));
    } catch (err) {
      if (ledgerIds.length) {
        let q = await host.readState();
        for (const id of ledgerIds) q = settleEntry(q, id, { status: 'failed', ts: now() });
        await host.writeState(assertValidProject(q));
      }
      return { status: 'failed', error: err instanceof Error ? err.message : String(err), cost };
    }
    handle = { ...handle, ledger: ledgerIds };
    return { status: 'submitted', handle, cost, ...(confirmation ? { confirmation } : {}) };
  }

  async function collect(handle: JobHandle): Promise<CollectResult> {
    const provider = registry.get(handle.provider);
    if (!provider) throw new Error(`no provider "${handle.provider}" is registered with the gate`);
    const status = await provider.poll(handle);
    if (!isTerminal(status.state)) return { status, assets: [] };

    const fetched = status.state === 'done' ? await provider.fetch(handle) : [];
    let p = await host.readState();
    const ts = now();
    const recorded: Asset[] = [];
    for (const asset of fetched) {
      const unit = handle.units.includes(asset.id) ? asset.id : asset.owner;
      if (unit === undefined || !handle.units.includes(unit)) {
        throw new Error(`${provider.id} returned asset "${asset.id}" for a unit outside the job`);
      }
      p = recordOutput(p, {
        asset,
        unit,
        stage: handle.stage,
        job: handle.job,
        provider: provider.id,
        ts,
        ...(asset.model !== undefined ? { model: asset.model } : {}),
      });
      const stored = p.assets.find((a) => a.id === asset.id);
      if (stored) recorded.push(stored);
    }
    const outcome = status.state === 'done' ? 'done' : status.state === 'failed' ? 'failed' : 'cancelled';
    for (const id of handle.ledger) {
      const entry = p.ledger.find((e) => e.id === id);
      if (!entry || entry.status !== 'submitted') continue;
      const actual = status.actual?.[entry.unit];
      p = settleEntry(p, id, { status: outcome, ts, ...(actual !== undefined ? { actual } : {}) });
    }
    await host.writeState(assertValidProject(p));
    return { status, assets: recorded };
  }

  return { quote, run, collect };
}
