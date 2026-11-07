/**
 * akuko — provider contract (gate G-ADAPTER).
 *
 * One shape for every generator akuko can drive: paid HTTP APIs, paid tools on
 * a connected MCP server, and the no-key manual provider. A provider never
 * spends on its own: `submit()` is reachable only through the spend gate
 * (`spend/gate.ts`), which seals every provider (`sealProvider`) so a direct
 * call throws `SpendGateBypassError`.
 *
 *   estimate(job) → Cost      pure; feeds the gate; must not call a paid endpoint
 *   submit(job)   → JobHandle  only via gate.run(), after estimate + approval + cap
 *   poll(handle)  → JobStatus
 *   fetch(handle) → Asset[]    files go through host.storeAsset()
 *
 * Model ids and prices are never written in code: they live in
 * `providers/config.json` (read through `providers/config.ts`).
 *
 * See `lib/providers.md` (authoring a provider) and `lib/spend.md` (the gate).
 */

import type {
  AkukoProject,
  Asset,
  AssetKind,
  ProviderKind,
  StageId,
} from '../schema/akuko-project.ts';

// ─────────────────────────────────────────────────────────────────────────
// Wave-1 host subset (mock contract 4)
// ─────────────────────────────────────────────────────────────────────────

// Mirrors hosts/types.ts WaveOneHost (WP-02); re-point the import once both are on main.
export interface AssetInput {
  kind: AssetKind;
  filename: string;        // suggested basename, e.g. 'sc1_sh2-keyframe.png'
  mime: string;
  data: Uint8Array;        // bytes; never written into akuko.json
  id?: string;             // host assigns one if absent
  owner?: string; name?: string; provider?: string; model?: string; tags?: string[];
}
export interface WaveOneHost {
  readState(): Promise<AkukoProject>;
  writeState(p: AkukoProject): Promise<void>;
  storeAsset(a: AssetInput): Promise<Asset>;
}

// ─────────────────────────────────────────────────────────────────────────
// Provider identity
// ─────────────────────────────────────────────────────────────────────────

/** Where the skill runs: A claude-artifact · B local · C ikenga. */
export type HostLevel = 'A' | 'B' | 'C';
export const HOST_LEVELS: readonly HostLevel[] = ['A', 'B', 'C'];

export type { ProviderKind };
export const PROVIDER_KINDS: readonly ProviderKind[] = ['image', 'video', 'audio', 'layout'];

/**
 * How a provider is paid for. Read from `config.json`, never declared by the
 * provider itself (the gate trusts the config, not the code it gates).
 *   free           costs akuko nothing (manual provider)
 *   direct-api     akuko calls a paid HTTP API with the user's key; refused on host A in v0.x (R-11)
 *   connected-mcp  a paid generation tool on a connected MCP server; needs the confirmation line (R-11)
 */
export type ProviderBilling = 'free' | 'direct-api' | 'connected-mcp';
export const PROVIDER_BILLING: readonly ProviderBilling[] = ['free', 'direct-api', 'connected-mcp'];
export const isPaid = (b: ProviderBilling): boolean => b !== 'free';

export interface ProviderCapabilities {
  refImages?: number;      // reference images the model accepts per call
  maxSeconds?: number;     // longest clip per call
  nativeAudio?: boolean;   // video model generates sound
  i2v?: boolean;           // image-to-video
}

// ─────────────────────────────────────────────────────────────────────────
// Job, Cost, JobHandle, JobStatus
// ─────────────────────────────────────────────────────────────────────────

/** A reference the generator must stay consistent with (bible entry or asset). */
export interface JobRef {
  id: string;              // bible entry id or asset id
  uri?: string;            // where the file is, when known (asset.file.uri)
  role?: string;           // e.g. 'character', 'location', 'style', 'start-frame'
  note?: string;
}

/** One unit's part of a job: what to make for that shot / bible entry / asset. */
export interface JobItem {
  unit: string;            // unit id the output belongs to
  prompt: string;
  output: AssetKind;       // asset kind produced, e.g. 'keyframe', 'clip', 'vo'
  refs?: JobRef[];
  count?: number;          // outputs wanted for this unit (default 1)
  duration_s?: number;     // video / audio length
  aspect_ratio?: string;   // e.g. '16:9'
  seed?: number;
  negative?: string;       // things to avoid
  camera?: string;         // free-text camera note
}

/**
 * One request to one provider. For a paid provider `id` is the
 * `pending_spend` id the person approves; the gate creates that entry on the
 * first `run()` / `quote()`.
 */
export interface Job {
  id: string;
  stage: StageId;
  kind: ProviderKind;
  provider: string;        // provider id, e.g. 'manual'
  model?: string;          // model id from config.json; provider default when absent
  label: string;           // human summary, shown at the gate
  items: JobItem[];        // ≥ 1, one per unit, unit ids unique
}

/** What a job will cost, in the config currency. Produced by `estimate()`. */
export interface Cost {
  amount: number;                      // total; non-negative, finite
  currency: string;                    // ISO 4217
  per_unit: Record<string, number>;    // unit id → share of `amount`; sums to `amount`
  model?: string;
  basis: string;                       // how it was worked out, e.g. "3 × 0.05 USD/image (config, verified 2026-11-07)"
  last_verified?: string;              // config date of the price used
}

/** What a person must do for a job to progress (the manual provider's prompt package). */
export interface Handoff {
  kind: 'prompt-package';
  body: unknown;                        // provider-specific; JSON-serialisable
  text: string;                         // the same, rendered for a person
}

/** Returned by `submit()`. JSON-serialisable, so it can outlive a session. */
export interface JobHandle {
  job: string;                          // Job.id
  provider: string;
  ref: string;                          // provider's own id for the request
  stage: StageId;
  units: string[];
  submitted_at: string;                 // ISO timestamp
  ledger: string[];                     // ledger entry ids the gate opened (empty for free jobs)
  handoff?: Handoff;
}

export type JobState = 'queued' | 'running' | 'waiting-for-input' | 'done' | 'failed' | 'cancelled';
export const JOB_STATES: readonly JobState[] = ['queued', 'running', 'waiting-for-input', 'done', 'failed', 'cancelled'];
export const isTerminal = (s: JobState): boolean => s === 'done' || s === 'failed' || s === 'cancelled';

export interface JobStatus {
  state: JobState;
  message?: string;
  progress?: number;                    // 0–1 when known
  actual?: Record<string, number>;      // unit id → what it actually cost, when the provider reports it
}

// ─────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────

/** What a provider author writes. `sealProvider()` (spend/gate.ts) turns it into a `Provider`. */
export interface ProviderImpl {
  id: string;                           // 'gemini-image', 'fal', 'canva', 'manual', …
  kinds: ProviderKind[];
  hosts: HostLevel[];                   // where it can run
  capabilities: ProviderCapabilities;
  estimate(job: Job): Promise<Cost>;    // feeds the spend gate; must not call paid endpoints
  submit(job: Job): Promise<JobHandle>;
  poll(h: JobHandle): Promise<JobStatus>;
  fetch(h: JobHandle): Promise<Asset[]>; // written via host.storeAsset()
}

/** A sealed provider: `billing` comes from config.json; `submit` only works inside gate.run(). */
export interface Provider extends ProviderImpl {
  readonly billing: ProviderBilling;
}

// ─────────────────────────────────────────────────────────────────────────
// Job helpers
// ─────────────────────────────────────────────────────────────────────────

export const jobUnits = (job: Job): string[] => job.items.map((i) => i.unit);

/** Structural problems with a job; empty when it is well-formed. */
export function jobProblems(job: Job): string[] {
  const out: string[] = [];
  if (!job.id) out.push('job.id is empty');
  if (!job.provider) out.push('job.provider is empty');
  if (!PROVIDER_KINDS.includes(job.kind)) out.push(`job.kind "${String(job.kind)}" is not a provider kind`);
  if (job.items.length === 0) out.push('job has no items');
  const seen = new Set<string>();
  for (const item of job.items) {
    if (seen.has(item.unit)) out.push(`unit "${item.unit}" appears twice in the job`);
    seen.add(item.unit);
    if (item.count !== undefined && (!Number.isInteger(item.count) || item.count < 1)) {
      out.push(`unit "${item.unit}": count must be a whole number ≥ 1`);
    }
  }
  return out;
}

/** Problems with an estimate for a job; empty when it is usable by the gate. */
export function costProblems(job: Job, cost: Cost): string[] {
  const out: string[] = [];
  if (!Number.isFinite(cost.amount) || cost.amount < 0) out.push(`estimate ${cost.amount} is not a non-negative amount`);
  if (!/^[A-Z]{3}$/.test(cost.currency)) out.push(`currency "${cost.currency}" is not an ISO 4217 code`);
  const units = new Set(jobUnits(job));
  let sum = 0;
  for (const [unit, amount] of Object.entries(cost.per_unit)) {
    if (!units.has(unit)) out.push(`per_unit names "${unit}", which is not in the job`);
    if (!Number.isFinite(amount) || amount < 0) out.push(`per_unit["${unit}"] is not a non-negative amount`);
    sum += amount;
  }
  for (const unit of units) if (!(unit in cost.per_unit)) out.push(`per_unit is missing "${unit}"`);
  if (Math.abs(sum - cost.amount) > 1e-9) out.push(`per_unit sums to ${sum}, not ${cost.amount}`);
  return out;
}
