/**
 * Provider config: the only place model ids and prices live (plan R-2).
 *
 * `config.json` sits next to this file. Every model carries a price and a
 * `last_verified` date; `staleModels()` is what `doctor` reports. Entries
 * marked `example: true` are placeholders: `priceFor()` refuses them unless
 * the caller opts in (tests only), so an illustrative number can never feed
 * a real spend decision.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Cost, Job } from './contract.ts';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'last_verified must be a YYYY-MM-DD date');

export const PriceUnitSchema = z.enum(['job', 'image', 'second', 'call', 'character']);
export type PriceUnit = z.infer<typeof PriceUnitSchema>;

export const ModelConfigSchema = z.object({
  price: z.object({ amount: z.number().nonnegative().finite(), per: PriceUnitSchema }).strict(),
  last_verified: DateSchema,
  source: z.string().min(1).describe('Where the price came from (pricing page, invoice) or why it is a placeholder.'),
}).strict();
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ProviderConfigSchema = z.object({
  label: z.string().min(1),
  billing: z.enum(['free', 'direct-api', 'connected-mcp']),
  example: z.boolean().default(false),
  key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'key_env must be an environment variable name').optional()
    .describe('Environment variable that holds the key for this provider. The one place the name lives: providers, setup and doctor all read it.'),
  default_model: z.string().min(1),
  models: z.record(ModelConfigSchema),
}).strict().superRefine((p, ctx) => {
  if (!(p.default_model in p.models)) {
    ctx.addIssue({ code: 'custom', message: `default_model "${p.default_model}" is not in models` });
  }
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const AkukoProviderConfigSchema = z.object({
  format: z.literal('akuko-provider-config'),
  version: z.literal(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  stale_after_days: z.number().int().positive(),
  notes: z.string().optional(),
  providers: z.record(ProviderConfigSchema),
}).strict();
export type AkukoProviderConfig = z.infer<typeof AkukoProviderConfigSchema>;

export const CONFIG_URL = new URL('./config.json', import.meta.url);

/** Parse and validate a config document. Throws with the Zod message when invalid. */
export function parseProviderConfig(doc: unknown): AkukoProviderConfig {
  return AkukoProviderConfigSchema.parse(doc);
}

let cached: AkukoProviderConfig | undefined;

/** The committed `providers/config.json`, validated once per process. */
export function loadProviderConfig(): AkukoProviderConfig {
  cached ??= parseProviderConfig(JSON.parse(readFileSync(CONFIG_URL, 'utf8')));
  return cached;
}

export class ProviderConfigError extends Error {
  override name = 'ProviderConfigError';
}

export function providerConfig(config: AkukoProviderConfig, providerId: string): ProviderConfig {
  const entry = config.providers[providerId];
  if (!entry) throw new ProviderConfigError(`provider "${providerId}" has no entry in providers/config.json`);
  return entry;
}

/** The env var a provider's key is read from, when the config names one. */
export function providerKeyEnv(config: AkukoProviderConfig, providerId: string): string | undefined {
  return config.providers[providerId]?.key_env;
}

export interface ResolvedPrice {
  provider: string;
  model: string;
  amount: number;
  per: PriceUnit;
  currency: string;
  last_verified: string;
}

/**
 * The price of one model (the provider default when `modelId` is absent).
 * Refuses `example` entries unless `allowExamples` is set.
 */
export function priceFor(
  config: AkukoProviderConfig,
  providerId: string,
  modelId?: string,
  opts: { allowExamples?: boolean } = {},
): ResolvedPrice {
  const entry = providerConfig(config, providerId);
  if (entry.example && !opts.allowExamples) {
    throw new ProviderConfigError(`provider "${providerId}" is an example entry with a placeholder price; it cannot be priced for real use`);
  }
  const model = modelId ?? entry.default_model;
  const m = entry.models[model];
  if (!m) throw new ProviderConfigError(`model "${model}" is not configured for provider "${providerId}"`);
  return { provider: providerId, model, amount: m.price.amount, per: m.price.per, currency: config.currency, last_verified: m.last_verified };
}

export interface StaleModel {
  provider: string;
  model: string;
  last_verified: string;
  age_days: number;
}

/** Models whose price is older than `stale_after_days` on `today` (YYYY-MM-DD). For `doctor`. */
export function staleModels(config: AkukoProviderConfig, today: string): StaleModel[] {
  const now = Date.parse(`${today}T00:00:00Z`);
  const out: StaleModel[] = [];
  for (const [provider, entry] of Object.entries(config.providers)) {
    for (const [model, m] of Object.entries(entry.models)) {
      const age = Math.floor((now - Date.parse(`${m.last_verified}T00:00:00Z`)) / 86_400_000);
      if (age > config.stale_after_days) out.push({ provider, model, last_verified: m.last_verified, age_days: age });
    }
  }
  return out;
}

/**
 * Price a job from config: the default estimate for any provider whose cost
 * is a flat rate. Quantities: `job` → the whole job; `image` / `call` →
 * `count` per unit; `second` → `duration_s × count`; `character` → prompt
 * length × count. Never calls a provider.
 */
export function estimateFromConfig(
  config: AkukoProviderConfig,
  job: Job,
  opts: { allowExamples?: boolean } = {},
): Cost {
  const price = priceFor(config, job.provider, job.model, opts);
  const per_unit: Record<string, number> = {};
  const n = job.items.length;
  for (const item of job.items) {
    const count = item.count ?? 1;
    let qty: number;
    switch (price.per) {
      case 'job': qty = 1 / n; break;
      case 'image':
      case 'call': qty = count; break;
      case 'second':
        if (item.duration_s === undefined) throw new ProviderConfigError(`unit "${item.unit}" has no duration_s; ${job.provider} prices by the second`);
        qty = item.duration_s * count;
        break;
      case 'character': qty = item.prompt.length * count; break;
    }
    per_unit[item.unit] = price.amount * qty;
  }
  const amount = Object.values(per_unit).reduce((a, b) => a + b, 0);
  return {
    amount,
    currency: price.currency,
    per_unit,
    model: price.model,
    basis: `${price.amount} ${price.currency}/${price.per} × ${n} unit${n === 1 ? '' : 's'} (${job.provider} ${price.model}, price verified ${price.last_verified})`,
    last_verified: price.last_verified,
  };
}
