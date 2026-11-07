/**
 * A spy paid provider for gate tests. Priced from a test config (never the
 * committed one), it logs every estimate/submit so a test can prove the order
 * of calls and that `submit` never ran on a refused path.
 */

import type { HostLevel, Job, JobHandle, Provider, ProviderBilling, WaveOneHost } from '../../providers/contract.ts';
import type { AkukoProviderConfig } from '../../providers/config.ts';
import { estimateFromConfig, parseProviderConfig } from '../../providers/config.ts';
import { sealProvider } from '../gate.ts';

export const FAKE_PAID_ID = 'fake-paid';
export const FAKE_PRICE = 0.05; // per image, test-only

export function testConfig(billing: ProviderBilling = 'direct-api'): AkukoProviderConfig {
  return parseProviderConfig({
    format: 'akuko-provider-config',
    version: 1,
    currency: 'USD',
    stale_after_days: 30,
    providers: {
      [FAKE_PAID_ID]: {
        label: 'Fake paid (tests)',
        billing,
        example: true,
        default_model: 'fake-model',
        models: { 'fake-model': { price: { amount: FAKE_PRICE, per: 'image' }, last_verified: '2026-11-07', source: 'test fixture' } },
      },
    },
  });
}

export interface FakePaid {
  provider: Provider;
  log: string[];
  /** Make the next submit throw. */
  failNextSubmit(): void;
  /** Override what estimate returns (e.g. to simulate a price rise). */
  setMultiplier(m: number): void;
  /** Report this actual cost per unit when the job finishes. */
  setActual(a: Record<string, number> | undefined): void;
  /** Make poll report this terminal state instead of done. */
  setOutcome(s: 'done' | 'failed' | 'cancelled'): void;
}

export function createFakePaid(
  host: WaveOneHost,
  opts: { billing?: ProviderBilling; hosts?: HostLevel[] } = {},
): FakePaid {
  const billing = opts.billing ?? 'direct-api';
  const config = testConfig(billing);
  const log: string[] = [];
  let failNext = false;
  let multiplier = 1;
  let actual: Record<string, number> | undefined;
  let outcome: 'done' | 'failed' | 'cancelled' = 'done';
  const provider = sealProvider(
    {
      id: FAKE_PAID_ID,
      kinds: ['image'],
      // R-11: a paid direct API does not run on host A, so by default it does not declare it.
      hosts: opts.hosts ?? (billing === 'direct-api' ? ['B', 'C'] : ['A', 'B', 'C']),
      capabilities: { refImages: 2 },
      async estimate(job: Job) {
        log.push(`estimate:${job.id}`);
        const c = estimateFromConfig(config, job, { allowExamples: true });
        const per_unit = Object.fromEntries(Object.entries(c.per_unit).map(([k, v]) => [k, v * multiplier]));
        return { ...c, per_unit, amount: c.amount * multiplier };
      },
      async submit(job: Job): Promise<JobHandle> {
        log.push(`submit:${job.id}`);
        if (failNext) {
          failNext = false;
          throw new Error('provider rejected the request');
        }
        return {
          job: job.id,
          provider: FAKE_PAID_ID,
          ref: `remote-${job.id}`,
          stage: job.stage,
          units: job.items.map((i) => i.unit),
          submitted_at: '2026-11-07T10:00:00Z',
          ledger: [],
        };
      },
      async poll() {
        return outcome === 'done' ? { state: 'done' as const, ...(actual ? { actual } : {}) } : { state: outcome };
      },
      async fetch(h: JobHandle) {
        const out = [];
        for (const unit of h.units) {
          out.push(await host.storeAsset({
            kind: 'keyframe',
            filename: `${unit}-${h.stage}.png`,
            mime: 'image/png',
            data: new Uint8Array([1, 2, 3]),
            id: `${unit}-${h.stage}`,
            owner: unit,
            provider: FAKE_PAID_ID,
            model: 'fake-model',
          }));
        }
        return out;
      },
    },
    { config },
  );
  return {
    provider,
    log,
    failNextSubmit: () => { failNext = true; },
    setMultiplier: (m) => { multiplier = m; },
    setActual: (a) => { actual = a; },
    setOutcome: (s) => { outcome = s; },
  };
}
