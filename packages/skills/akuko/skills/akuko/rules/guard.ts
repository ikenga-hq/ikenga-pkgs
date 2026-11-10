/**
 * akuko — the project rules guard (WP-26, R9-4).
 *
 *   const gate = guardGate(createSpendGate({ host, providers, level, now }), reader, { projectDir, providers });
 *   const gate = guardedGate({ host, providers, level, now, reader, projectDir });   // the same, in one call
 *
 * Any code that hands a gate to a stage's `run.ts` (the CLIs, and TypeScript
 * callers on host A with the `ClaudeArtifactHost`) builds it this way, never
 * with a bare `createSpendGate`.
 *
 * Wraps a spend gate from the outside (`spend/**` is frozen). `quote()` and
 * `run()` first check the job against the project's `rules` (`check.ts`);
 * a breach comes back as an ordinary refusal, with its own code, and the
 * wrapped gate is never called: nothing is priced, reserved, written or sent.
 * `collect()` passes straight through (a job that was submitted already passed).
 *
 * The callers (`bible|keyframes|motion|sound/run.ts`) treat any refusal from
 * `quote()` or `run()` the same way: they stop and report `code` and
 * `message`, before reading the cost. The refusal codes below are not in the
 * frozen gate's `RefusalCode` union, so they are cast at this one boundary;
 * every caller carries the code on as a plain string.
 *
 * Give the guard its own project reader (a second host on the same folder),
 * not the gate's host: the local host compares each write against its own
 * last read, and an extra read on the shared host would move that mark.
 */

import { loadProviderConfig } from '../providers/config.ts';
import type { Cost, Job, Provider, ProviderBilling } from '../providers/contract.ts';
import { jobUnits } from '../providers/contract.ts';
import { createSpendGate, type QuoteResult, type Refusal, type RunResult, type SpendGate, type SpendGateOptions } from '../spend/gate.ts';
import type { AkukoProject } from '../schema/akuko-project.ts';
import { type Breach, checkJob, formatBreach, isPaidJob } from './check.ts';
import { newHashCache, type HashCache } from './refs.ts';

/** A job broke a project rule. */
export const RULES_BREACH = 'rules-breach';
/** `rules.required` is set and the rules are empty, or the rules are invalid. */
export const RULES_MISSING = 'rules-missing';
export type RulesRefusalCode = typeof RULES_BREACH | typeof RULES_MISSING;

export interface RulesRefusal {
  code: RulesRefusalCode;
  message: string;
  breaches: Breach[];
}

export const isRulesRefusal = (r: { code: string } | undefined): boolean => r?.code === RULES_BREACH || r?.code === RULES_MISSING;

export const PREFLIGHT_POINTER = 'Run `node --experimental-strip-types rules/cli.ts check --project <dir>` to list every breach in the project before any spend.';

export type ProjectSource = AkukoProject | { readState(): Promise<AkukoProject> };

export interface GuardOptions {
  /** The project folder, for reading reference files named by relative uris. */
  projectDir?: string;
  /** The same sealed providers the gate has, for their billing (paid jobs get the reference checks). */
  providers?: Provider[];
  /** Reused across calls so each file is hashed once per guard. */
  cache?: HashCache;
}

export interface GuardedGate extends SpendGate {
  /** The check alone: the refusal `quote()` / `run()` would give, or null. */
  check(job: Job): Promise<RulesRefusal | null>;
}

const read = async (src: ProjectSource): Promise<AkukoProject> =>
  'readState' in src && typeof src.readState === 'function' ? src.readState() : (src as AkukoProject);

export function refusalMessage(breaches: Breach[], job: Job): string {
  const head = `The project rules refuse job ${job.id}; nothing was priced, sent or spent.`;
  return [head, ...breaches.map((b) => `- ${formatBreach(b)}`), PREFLIGHT_POINTER].join('\n');
}

export function guardGate(gate: SpendGate, project: ProjectSource, opts: GuardOptions = {}): GuardedGate {
  const cache = opts.cache ?? newHashCache();

  async function check(job: Job): Promise<RulesRefusal | null> {
    const p = await read(project);
    const r = await checkJob(p, job, { projectDir: opts.projectDir, providers: opts.providers, cache });
    if (r.outcome === 'ok') return null;
    return { code: r.outcome === 'rules-missing' ? RULES_MISSING : RULES_BREACH, message: refusalMessage(r.breaches, job), breaches: r.breaches };
  }

  // The frozen gate types `Refusal.code` as its own union; ours is a separate code by design.
  const asRefusal = (r: RulesRefusal): Refusal => r as unknown as Refusal;

  /** A quote that never reached the gate: priced at nothing, and saying why. */
  function refusedQuote(job: Job, r: RulesRefusal): QuoteResult {
    const paid = isPaidJob(job, opts.providers);
    const billing: ProviderBilling = opts.providers?.find((x) => x.id === job.provider)?.billing ?? (paid ? 'direct-api' : 'free');
    const cost: Cost = {
      amount: 0,
      currency: loadProviderConfig().currency,
      per_unit: Object.fromEntries(jobUnits(job).map((u) => [u, 0])),
      basis: 'not priced: refused by the project rules before the spend gate',
    };
    return { cost, billing, paid, refusal: asRefusal(r) };
  }

  return {
    check,
    // The job is copied first, so what was checked is exactly what the gate gets (the caller can't change it in between).
    async quote(input: Job): Promise<QuoteResult> {
      const job = structuredClone(input);
      const r = await check(job);
      return r ? refusedQuote(job, r) : gate.quote(job);
    },
    async run(input: Job): Promise<RunResult> {
      const job = structuredClone(input);
      const r = await check(job);
      return r ? { status: 'refused', refusal: asRefusal(r) } : gate.run(job);
    },
    collect: (handle) => gate.collect(handle),
  };
}

export interface GuardedGateOptions extends SpendGateOptions {
  /** Where the guard reads the project. Default: the gate's own host (fine for the artifact host; on B and C pass a second local host on the same folder). */
  reader?: ProjectSource;
  projectDir?: string;
  cache?: HashCache;
}

/** A spend gate with the rules guard in front of it: `createSpendGate(o)` wrapped by `guardGate`. */
export function guardedGate(o: GuardedGateOptions): GuardedGate {
  const { reader, projectDir, cache, ...gateOpts } = o;
  return guardGate(createSpendGate(gateOpts), reader ?? gateOpts.host, {
    providers: gateOpts.providers,
    ...(projectDir !== undefined ? { projectDir } : {}),
    ...(cache !== undefined ? { cache } : {}),
  });
}
