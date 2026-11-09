/**
 * Gemini image provider (direct API, "Nano Banana" family).
 *
 * Reference-aware stills: a shot's bible references (character, location,
 * style) are sent with the prompt so the model keeps them consistent. Calls
 * Google's Interactions endpoint synchronously, so `submit()` returns once the
 * images exist; they are stored through `host.storeAsset()` and handed back by
 * `fetch()`.
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json
 *   - hosts B and C only: a paid direct API is refused on host A (R-11)
 *   - `estimate()` is arithmetic on config; it never touches the network
 *   - output size is fixed at 1K (the configured price is the 1K price) and a
 *     unit's references are capped at the documented 14 per image; more is
 *     refused with a message, never trimmed
 *   - the estimate covers image output only; reference images are also billed
 *     as input tokens (a few hundredths of a cent each), noted in `basis`
 *
 * Results of a submitted job are held for the life of the provider object; a
 * handle opened in a later session reports that plainly (follow-up: persist).
 */

import type { Asset } from '../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../config.ts';
import { estimateFromConfig, loadProviderConfig, priceFor, providerConfig, providerKeyEnv } from '../config.ts';
import type { Cost, Job, JobHandle, JobItem, JobStatus, Provider, WaveOneHost } from '../contract.ts';
import { sealProvider } from '../../spend/gate.ts';
import type { FetchLike, RefLoader } from './image-common.ts';
import {
  checkImageJob,
  defaultRefLoader,
  fetchOf,
  promptText,
  refLabel,
  storeUnitImages,
  usableRefs,
  toBase64,
} from './image-common.ts';

export const GEMINI_PROVIDER_ID = 'gemini-image';
/** Documented ceiling on reference images per call for every configured Gemini image model. */
export const GEMINI_MAX_REFS = 14;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
/**
 * Output format requested from the Interactions endpoint (`response_format.mime_type`).
 * The live API rejected `image/png` for gemini-nano-banana-2.1 with HTTP 400 (only
 * `image/jpeg` is accepted there, found in the 2026-11-09 paid check, A-5), and the
 * image-generation docs show `image/jpeg` in their `response_format` examples without
 * listing per-model formats: https://ai.google.dev/gemini-api/docs/image-generation
 * (now served from https://aistudio.google.com/docs/image-generation). JPEG is
 * therefore requested for every configured model; image-common.ts stores it as .jpg.
 */
export const GEMINI_OUTPUT_MIME = 'image/jpeg';

export interface GeminiImageOptions {
  config?: AkukoProviderConfig;
  /** The user's key, or a function that returns it. Defaults to the environment variable named by `key_env` in providers/config.json. */
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  loadRef?: RefLoader;
  endpoint?: string;
  apiRevision?: string;
  now?: () => string;
}

interface Held {
  units: Map<string, Asset[]>;
  failures: Map<string, string>;
  actual: Record<string, number>;
  order: string[];
}

const aspectOk = (r: string): boolean => /^\d{1,2}:\d{1,2}$/.test(r);

export class GeminiImageError extends Error {
  override name = 'GeminiImageError';
}

/** Pull the generated image (and any text, for refusals) out of an Interactions response. */
export function parseInteraction(body: unknown): { mime: string; data: Uint8Array } {
  const b = body as { status?: string; steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; mime_type?: string; text?: string }> }> };
  if (b?.status === 'failed' || b?.status === 'cancelled') throw new GeminiImageError(`Gemini returned status "${b.status}"`);
  const texts: string[] = [];
  let found: { mime: string; data: Uint8Array } | undefined;
  for (const step of b?.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content ?? []) {
      if (c.type === 'image' && c.data) found = { mime: c.mime_type ?? 'image/png', data: new Uint8Array(Buffer.from(c.data, 'base64')) };
      else if (c.type === 'text' && c.text) texts.push(c.text);
    }
  }
  if (found) return found;
  throw new GeminiImageError(`Gemini returned no image${texts.length ? `: ${texts.join(' ').slice(0, 300)}` : ''}`);
}

export function createGeminiImageProvider(host: WaveOneHost, opts: GeminiImageOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const loadRef = opts.loadRef ?? defaultRefLoader(opts.fetch);
  const endpoint = opts.endpoint ?? ENDPOINT;
  const revision = opts.apiRevision ?? API_REVISION;
  const held = new Map<string, Held>();

  const keyEnv = providerKeyEnv(config, GEMINI_PROVIDER_ID);
  const key = (): string => {
    const k = typeof opts.apiKey === 'function' ? opts.apiKey() : (opts.apiKey ?? (keyEnv ? process.env[keyEnv] : undefined));
    if (!k) throw new GeminiImageError(`No Gemini API key: set ${keyEnv ?? 'the key variable named by key_env in providers/config.json'} (or pass apiKey). Nothing was sent.`);
    return k;
  };

  const check = (job: Job): void =>
    checkImageJob(job, GEMINI_PROVIDER_ID, config, GEMINI_MAX_REFS, aspectOk, 'Use a ratio like 16:9, 1:1 or 9:16.');

  async function generate(model: string, item: JobItem, apiKey: string): Promise<{ mime: string; data: Uint8Array }> {
    const input: unknown[] = [];
    for (const [i, r] of usableRefs(item).entries()) {
      const file = await loadRef(r.uri);
      input.push({ type: 'text', text: refLabel(r, i + 1) });
      input.push({ type: 'image', mime_type: file.mime, data: toBase64(file.data) });
    }
    input.push({ type: 'text', text: promptText(item) });
    const res = await fetchOf(opts.fetch)(endpoint, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', 'Api-Revision': revision },
      body: JSON.stringify({
        model,
        input,
        store: false,
        response_format: {
          type: 'image',
          mime_type: GEMINI_OUTPUT_MIME,
          image_size: '1K',
          ...(item.aspect_ratio ? { aspect_ratio: item.aspect_ratio } : {}),
        },
      }),
    });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200);
      const hint = res.status === 429
        ? ' (usually the free tier or billing not active for the project this key belongs to, or a rate limit: image models need a paid Gemini API account, see https://ai.google.dev/gemini-api/docs/billing)'
        : '';
      throw new GeminiImageError(`Gemini HTTP ${res.status}: ${msg}${hint}`);
    }
    return parseInteraction(body);
  }

  return sealProvider(
    {
      id: GEMINI_PROVIDER_ID,
      kinds: ['image'],
      hosts: ['B', 'C'],
      capabilities: { refImages: GEMINI_MAX_REFS },

      async estimate(job: Job): Promise<Cost> {
        check(job);
        const cost = estimateFromConfig(config, job);
        return { ...cost, basis: `${cost.basis}; 1K image output only, reference images are billed separately as input tokens` };
      },

      async submit(job: Job): Promise<JobHandle> {
        check(job);
        const model = job.model ?? providerConfig(config, GEMINI_PROVIDER_ID).default_model;
        const unitPrice = priceFor(config, GEMINI_PROVIDER_ID, model).amount;
        const apiKey = key();
        const state: Held = { units: new Map(), failures: new Map(), actual: {}, order: job.items.map((i) => i.unit) };
        let firstError: unknown;
        let made = 0;
        for (const item of job.items) {
          const images: Array<{ mime: string; data: Uint8Array }> = [];
          for (let n = 0; n < (item.count ?? 1); n++) {
            try {
              images.push(await generate(model, item, apiKey));
              made++;
            } catch (err) {
              firstError ??= err;
              state.failures.set(item.unit, err instanceof Error ? err.message : String(err));
              break;
            }
          }
          // Nothing has been made yet and the first call failed: stop before sending more (a bad key, a refused ref).
          if (made === 0 && firstError !== undefined) throw firstError;
          if (images.length) {
            state.units.set(item.unit, await storeUnitImages(host, job, item, GEMINI_PROVIDER_ID, model, images));
            state.actual[item.unit] = images.length * unitPrice;
            if (images.length === (item.count ?? 1)) state.failures.delete(item.unit);
          }
        }
        const ref = `gemini:${job.id}`;
        held.set(ref, state);
        return {
          job: job.id,
          provider: GEMINI_PROVIDER_ID,
          ref,
          stage: job.stage,
          units: state.order,
          submitted_at: (opts.now ?? (() => new Date().toISOString()))(),
          ledger: [],
        };
      },

      async poll(h: JobHandle): Promise<JobStatus> {
        const s = held.get(h.ref);
        if (!s) return { state: 'failed', message: 'This job was submitted in an earlier session and its results are no longer held. Check the project assets for files tagged with the job id.' };
        const missing = h.units.filter((u) => !s.units.has(u));
        if (missing.length === 0) return { state: 'done', progress: 1, actual: s.actual };
        return {
          state: 'failed',
          actual: s.actual,
          message: `no image for ${missing.join(', ')}: ${missing.map((u) => s.failures.get(u) ?? 'unknown error').join('; ')}`,
        };
      },

      async fetch(h: JobHandle): Promise<Asset[]> {
        const s = held.get(h.ref);
        return h.units.flatMap((u) => s?.units.get(u) ?? []);
      },
    },
    { config },
  );
}
