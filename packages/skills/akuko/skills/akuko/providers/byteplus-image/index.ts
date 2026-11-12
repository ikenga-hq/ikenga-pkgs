/**
 * BytePlus ModelArk image provider (direct API): Seedream stills with
 * reference images, for the bible and key frames (the image kinds
 * `gemini-image` and `fal` make).
 *
 * `POST /images/generations` is synchronous: `submit()` returns once the
 * images exist; they are stored through `host.storeAsset()` and handed back
 * by `fetch()` (held for the life of the provider object, like gemini-image).
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json
 *   - hosts A, B and C (host A only through the pasted-key flow, lib/spend.md R-11)
 *   - `estimate()` is arithmetic on config: a flat price per image (input
 *     images are free for every configured model)
 *   - reference images go inline as data URIs; their count is capped per
 *     family (14, or 10 for 5.0 flash) and more is refused, never trimmed
 *   - one image per call (`sequential_image_generation: "disabled"`), asked
 *     back as base64 so nothing is downloaded, with no watermark
 *   - size: an aspect ratio akuko knows becomes a WxH of 3.7 to 4.2 million
 *     pixels (inside every configured family's range); none is "2K"
 */

import type { Asset } from '../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../config.ts';
import { estimateFromConfig, loadProviderConfig, priceFor, providerConfig, providerKeyEnv } from '../config.ts';
import type { Cost, Job, JobHandle, JobItem, JobStatus, Provider, WaveOneHost } from '../contract.ts';
import { sealProvider } from '../../spend/gate.ts';
import type { FetchLike, RefLoader } from '../gemini-image/image-common.ts';
import { ImageJobError, checkImageJob, defaultRefLoader, promptText, refLabel, storeUnitImages, toBase64, usableRefs } from '../gemini-image/image-common.ts';
import { arkCall, arkDataUri } from '../byteplus-video/index.ts';
import { keyReader } from '../video-common.ts';

export const BYTEPLUS_IMAGE_PROVIDER_ID = 'byteplus-image';

/** Reference limit by family (image-generation API page), matched on a fragment of the id. */
const MAX_REFS: Array<{ match: RegExp; refs: number }> = [
  { match: /seedream-5-0-flash-\d/, refs: 10 },
  { match: /seedream-(4-0|4-5|5-0-lite|5-0)-\d/, refs: 14 },
];
export const byteplusImageMaxRefs = (model: string): number | undefined => MAX_REFS.find((x) => x.match.test(model))?.refs;

/** Aspect ratio → WxH, each 3.7 to 4.2 million pixels. */
export const SEEDREAM_SIZES: Readonly<Record<string, string>> = {
  '1:1': '2048x2048',
  '16:9': '2560x1440',
  '9:16': '1440x2560',
  '4:3': '2304x1728',
  '3:4': '1728x2304',
  '3:2': '2496x1664',
  '2:3': '1664x2496',
  '21:9': '2940x1260',
};

export interface ByteplusImageOptions {
  config?: AkukoProviderConfig;
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  loadRef?: RefLoader;
  now?: () => string;
}

interface Held { units: Map<string, Asset[]>; failures: Map<string, string>; actual: Record<string, number>; order: string[] }

interface ImageAnswer {
  data?: Array<{ b64_json?: string; url?: string; error?: { code?: string; message?: string } }>;
  error?: { code?: string; message?: string };
}

export function createByteplusImageProvider(host: WaveOneHost, opts: ByteplusImageOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const entry = providerConfig(config, BYTEPLUS_IMAGE_PROVIDER_ID);
  const loadRef = opts.loadRef ?? defaultRefLoader(opts.fetch);
  const key = keyReader(opts.apiKey, providerKeyEnv(config, BYTEPLUS_IMAGE_PROVIDER_ID), 'BytePlus ModelArk API key');
  const held = new Map<string, Held>();
  const modelOf = (job: Job): string => job.model ?? entry.default_model;

  function check(job: Job): void {
    const model = modelOf(job);
    const refs = byteplusImageMaxRefs(model);
    if (refs === undefined && model in entry.models) throw new ImageJobError(`akuko has no request rules for ${BYTEPLUS_IMAGE_PROVIDER_ID} model "${model}"`);
    checkImageJob(job, BYTEPLUS_IMAGE_PROVIDER_ID, config, refs ?? 0, (r) => r in SEEDREAM_SIZES, `Use one of ${Object.keys(SEEDREAM_SIZES).join(', ')}.`);
  }

  async function generate(model: string, item: JobItem, apiKey: string): Promise<{ mime: string; data: Uint8Array }> {
    const refs = usableRefs(item);
    const images: string[] = [];
    for (const r of refs) {
      const file = await loadRef(r.uri);
      images.push(arkDataUri(file.mime, toBase64(file.data)));
    }
    // Seedream reads the references in order; say which is which in the prompt.
    const labels = refs.map((r, i) => refLabel(r, i + 1)).join(' ');
    const body = {
      model,
      prompt: [labels, promptText(item)].filter(Boolean).join('\n'),
      ...(images.length === 1 ? { image: images[0] } : images.length > 1 ? { image: images } : {}),
      size: item.aspect_ratio ? SEEDREAM_SIZES[item.aspect_ratio] : '2K',
      sequential_image_generation: 'disabled',
      response_format: 'b64_json',
      watermark: false,
      ...(item.seed !== undefined ? { seed: item.seed } : {}),
    };
    const r = await arkCall<ImageAnswer>(opts.fetch, apiKey, '/images/generations', { method: 'POST', body }, 'image generation');
    const first = r.data?.[0];
    if (first?.b64_json) return { mime: 'image/jpeg', data: new Uint8Array(Buffer.from(first.b64_json, 'base64')) };
    const why = first?.error?.message ?? r.error?.message ?? 'no image in the answer';
    throw new ImageJobError(`BytePlus returned no image: ${why}`);
  }

  return sealProvider(
    {
      id: BYTEPLUS_IMAGE_PROVIDER_ID,
      kinds: ['image'],
      hosts: ['A', 'B', 'C'],
      capabilities: { refImages: 14 },

      async estimate(job: Job): Promise<Cost> {
        check(job);
        const cost = estimateFromConfig(config, job);
        return { ...cost, basis: `${cost.basis}; reference images are free for this model` };
      },

      async submit(job: Job): Promise<JobHandle> {
        check(job);
        const model = modelOf(job);
        const unitPrice = priceFor(config, BYTEPLUS_IMAGE_PROVIDER_ID, model).amount;
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
          if (made === 0 && firstError !== undefined) throw firstError;
          if (images.length) {
            state.units.set(item.unit, await storeUnitImages(host, job, item, BYTEPLUS_IMAGE_PROVIDER_ID, model, images));
            state.actual[item.unit] = images.length * unitPrice;
            if (images.length === (item.count ?? 1)) state.failures.delete(item.unit);
          }
        }
        const ref = `arki:${job.id}`;
        held.set(ref, state);
        return {
          job: job.id,
          provider: BYTEPLUS_IMAGE_PROVIDER_ID,
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
        return { state: 'failed', actual: s.actual, message: `no image for ${missing.join(', ')}: ${missing.map((u) => s.failures.get(u) ?? 'unknown error').join('; ')}` };
      },

      async fetch(h: JobHandle): Promise<Asset[]> {
        const s = held.get(h.ref);
        return h.units.flatMap((u) => s?.units.get(u) ?? []);
      },
    },
    { config },
  );
}
