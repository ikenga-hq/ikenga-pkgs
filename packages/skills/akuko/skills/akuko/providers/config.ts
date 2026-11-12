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

/**
 * A model akuko knows how to call but whose price the provider does not
 * publish per unit (or that akuko could not verify). It is listed so people
 * can see it exists, and it is never runnable: `priceFor()` refuses it with
 * "price unverified", so the gate can never price, approve or send it.
 */
export const UnverifiedModelSchema = z.object({
  last_checked: DateSchema,
  source: z.string().min(1).describe('What was read, where, and why no price could be taken from it.'),
}).strict();
export type UnverifiedModel = z.infer<typeof UnverifiedModelSchema>;

/** Where a provider's API lives, for the no-cost reachability probe (`scripts/probe.ts`) and for claude.ai's network settings. */
export const NetworkSchema = z.object({
  probe: z.string().url().startsWith('https://').describe('An https URL that costs nothing and needs no key (any HTTP answer, even 401, proves the host is reachable).'),
  domains: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/i, 'a domain name, optionally starting with *.')).min(1)
    .describe('Every domain akuko contacts for this provider: the API host, then download hosts. Allow these in claude.ai (Settings, code execution network access).'),
  note: z.string().optional().describe('What is not verified about the domains (e.g. a download host the provider does not document).'),
}).strict();
export type ProviderNetwork = z.infer<typeof NetworkSchema>;

export const ProviderConfigSchema = z.object({
  label: z.string().min(1),
  billing: z.enum(['free', 'direct-api', 'connected-mcp']),
  example: z.boolean().default(false),
  key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'key_env must be an environment variable name').optional()
    .describe('Environment variable that holds the key for this provider. The one place the name lives: providers, setup and doctor all read it.'),
  secret_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'secret_env must be an environment variable name').optional()
    .describe('A second variable the provider needs with key_env (e.g. a secret key that signs a token). Both must be set.'),
  network: NetworkSchema.optional(),
  default_model: z.string().min(1),
  models: z.record(ModelConfigSchema),
  unverified_models: z.record(UnverifiedModelSchema).optional()
    .describe('Models akuko can call but cannot price (no published per-unit price). Never runnable: priceFor() refuses them.'),
}).strict().superRefine((p, ctx) => {
  if (!(p.default_model in p.models)) {
    ctx.addIssue({ code: 'custom', message: `default_model "${p.default_model}" is not in models` });
  }
  for (const id of Object.keys(p.unverified_models ?? {})) {
    if (id in p.models) ctx.addIssue({ code: 'custom', message: `model "${id}" is both priced and listed as price unverified` });
  }
  if (p.secret_env !== undefined && p.key_env === undefined) ctx.addIssue({ code: 'custom', message: 'secret_env needs key_env' });
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

/** Every env var a provider needs (key_env, then secret_env when set). Names only. */
export function providerKeyEnvs(config: AkukoProviderConfig, providerId: string): string[] {
  const p = config.providers[providerId];
  return [p?.key_env, p?.secret_env].filter((x): x is string => typeof x === 'string');
}

/** The provider's network entry (probe url and domains), when config has one. */
export function providerNetwork(config: AkukoProviderConfig, providerId: string): ProviderNetwork | undefined {
  return config.providers[providerId]?.network;
}

/** Models listed as "price unverified" for a provider (never runnable). */
export function unverifiedModels(config: AkukoProviderConfig, providerId: string): Record<string, UnverifiedModel> {
  return config.providers[providerId]?.unverified_models ?? {};
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
  const unverified = entry.unverified_models?.[model];
  if (unverified) {
    throw new ProviderConfigError(
      `model "${model}" of "${providerId}" is listed as price unverified: the provider publishes no per-unit price akuko could check (checked ${unverified.last_checked}; see unverified_models in providers/config.json). It cannot be estimated, approved or run; pick a priced model.`,
    );
  }
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
