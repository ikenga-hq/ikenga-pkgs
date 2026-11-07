/**
 * fal image provider (direct API, fal's queue).
 *
 * Reference-aware stills through fal's hosted models. With references the
 * model's `/edit` endpoint is used (it takes `image_urls`); without, the plain
 * text-to-image endpoint. Lifted in shape from Studio's fal renderer
 * (`packages/apps/studio/sidecars/project/src/renderers/fal.ts`), but over the
 * REST queue so a job's handle (request ids and status/result urls) survives a
 * restart: `poll()` and `fetch()` need only the handle and the key.
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json
 *   - hosts B and C only: a paid direct API is refused on host A (R-11)
 *   - `estimate()` is arithmetic on config; it never touches the network
 *   - output size is fixed at the model's 1K default, so the flat per-image
 *     price applies; references per image are capped at 14 (fal's documented
 *     total) and more is refused with a message, never trimmed
 *   - the key is sent only to queue.fal.run
 *
 * Image-only: fal's video models are WP-08's. Models priced per megapixel are
 * not configured yet (the config has no per-megapixel unit): follow-up.
 */

import type { Asset, AssetKind } from '../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../config.ts';
import { estimateFromConfig, loadProviderConfig, providerConfig } from '../config.ts';
import type { Cost, Job, JobHandle, JobItem, JobStatus, Provider, WaveOneHost } from '../contract.ts';
import { sealProvider } from '../../spend/gate.ts';
import type { FetchLike, RefLoader } from '../gemini-image/image-common.ts';
import {
  checkImageJob,
  defaultRefLoader,
  fetchOf,
  promptText,
  refLabel,
  storeUnitImages,
  usableRefs,
  toBase64,
} from '../gemini-image/image-common.ts';

export const FAL_PROVIDER_ID = 'fal';
/** fal documents a 14-reference total for the nano-banana edit endpoint. */
export const FAL_MAX_REFS = 14;
const QUEUE = 'https://queue.fal.run';
const ASPECTS = ['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8'];

export interface FalImageOptions {
  config?: AkukoProviderConfig;
  /** The user's key, or a function that returns it. Defaults to the FAL_KEY environment variable. */
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  loadRef?: RefLoader;
  now?: () => string;
}

export class FalImageError extends Error {
  override name = 'FalImageError';
}

/** One queued request, kept inside the (JSON) handle ref. */
interface QueuedUnit {
  unit: string;
  request_id?: string;
  status_url?: string;
  response_url?: string;
  output?: AssetKind;
  model?: string;
  error?: string;
}

const decodeRef = (ref: string): QueuedUnit[] => {
  try {
    const v = JSON.parse(ref.replace(/^fal:/, ''));
    if (Array.isArray(v)) return v as QueuedUnit[];
  } catch { /* falls through */ }
  throw new FalImageError('this handle was not made by the fal provider');
};

/** The key goes only to fal's queue host. */
function queueUrl(u: string | undefined): string {
  if (!u || !u.startsWith(`${QUEUE}/`)) throw new FalImageError('fal returned an unexpected status url; refusing to send the key to it');
  return u;
}

export function createFalImageProvider(host: WaveOneHost, opts: FalImageOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const loadRef = opts.loadRef ?? defaultRefLoader(opts.fetch);
  const stored = new Map<string, Asset[]>();

  const key = (): string => {
    const k = typeof opts.apiKey === 'function' ? opts.apiKey() : (opts.apiKey ?? process.env.FAL_KEY);
    if (!k) throw new FalImageError('No fal API key: set FAL_KEY (or pass apiKey). Nothing was sent.');
    return k;
  };
  const headers = (json: boolean): Record<string, string> => ({
    Authorization: `Key ${key()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  const check = (job: Job): void =>
    checkImageJob(job, FAL_PROVIDER_ID, config, FAL_MAX_REFS, (r) => ASPECTS.includes(r), `Use one of ${ASPECTS.join(', ')}.`);

  async function enqueue(model: string, item: JobItem): Promise<QueuedUnit> {
    const refs = usableRefs(item);
    const body: Record<string, unknown> = {
      prompt: promptText(item),
      num_images: item.count ?? 1,
      resolution: '1K',
      output_format: 'png',
      ...(item.aspect_ratio ? { aspect_ratio: item.aspect_ratio } : {}),
    };
    if (refs.length) {
      const urls: string[] = [];
      for (const r of refs) {
        const uri = r.uri;
        if (/^https:\/\//.test(uri)) urls.push(uri);
        else {
          const f = await loadRef(uri);
          urls.push(`data:${f.mime};base64,${toBase64(f.data)}`);
        }
      }
      body.image_urls = urls;
      body.prompt = `${refs.map((r, i) => refLabel(r, i + 1)).join(' ')}\n${body.prompt as string}`;
    }
    const res = await fetchOf(opts.fetch)(`${QUEUE}/${model}${refs.length ? '/edit' : ''}`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new FalImageError(`fal HTTP ${res.status}: ${text.slice(0, 200)}`);
    const q = JSON.parse(text) as { request_id?: string; status_url?: string; response_url?: string };
    return {
      unit: item.unit,
      output: item.output,
      model,
      ...(q.request_id !== undefined ? { request_id: q.request_id } : {}),
      status_url: queueUrl(q.status_url),
      response_url: queueUrl(q.response_url),
    };
  }

  return sealProvider(
    {
      id: FAL_PROVIDER_ID,
      kinds: ['image'],
      hosts: ['B', 'C'],
      capabilities: { refImages: FAL_MAX_REFS },

      async estimate(job: Job): Promise<Cost> {
        check(job);
        const cost = estimateFromConfig(config, job);
        return { ...cost, basis: `${cost.basis}; flat per image at the 1K default size` };
      },

      async submit(job: Job): Promise<JobHandle> {
        check(job);
        const model = job.model ?? providerConfig(config, FAL_PROVIDER_ID).default_model;
        key();
        const queued: QueuedUnit[] = [];
        for (const item of job.items) {
          try {
            queued.push(await enqueue(model, item));
          } catch (err) {
            // Nothing queued yet: stop before sending more (a bad key, a refused ref).
            if (queued.length === 0) throw err;
            queued.push({ unit: item.unit, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return {
          job: job.id,
          provider: FAL_PROVIDER_ID,
          ref: `fal:${JSON.stringify(queued)}`,
          stage: job.stage,
          units: job.items.map((i) => i.unit),
          submitted_at: (opts.now ?? (() => new Date().toISOString()))(),
          ledger: [],
        };
      },

      async poll(h: JobHandle): Promise<JobStatus> {
        const entries = decodeRef(h.ref);
        const errors: string[] = entries.filter((e) => e.error).map((e) => `${e.unit}: ${e.error}`);
        const failedAtSubmit = new Set(errors);
        let done = 0;
        let live = 0;
        for (const e of entries) {
          if (e.error) continue;
          live++;
          const res = await fetchOf(opts.fetch)(queueUrl(e.status_url), { headers: headers(false) });
          if (!res.ok) throw new FalImageError(`fal status HTTP ${res.status} for ${e.unit}`);
          const s = (await res.json()) as { status?: string; error?: string };
          if (s.status === 'COMPLETED') {
            if (s.error) errors.push(`${e.unit}: ${s.error}`);
            else done++;
          } else if (s.status !== 'IN_QUEUE' && s.status !== 'IN_PROGRESS') {
            errors.push(`${e.unit}: unexpected status ${String(s.status)}`);
          }
        }
        const running = live - done - errors.filter((m) => !failedAtSubmit.has(m)).length;
        if (running > 0) return { state: 'running', progress: live ? done / live : 0, message: `${done} of ${live} images ready` };
        if (errors.length) return { state: 'failed', message: errors.join('; ') };
        return { state: 'done', progress: 1 };
      },

      async fetch(h: JobHandle): Promise<Asset[]> {
        const cached = stored.get(h.ref);
        if (cached) return cached;
        const out: Asset[] = [];
        for (const e of decodeRef(h.ref)) {
          if (e.error) continue;
          const res = await fetchOf(opts.fetch)(queueUrl(e.response_url), { headers: headers(false) });
          if (!res.ok) throw new FalImageError(`fal result HTTP ${res.status} for ${e.unit}`);
          const r = (await res.json()) as { images?: Array<{ url?: string; content_type?: string }> };
          const images: Array<{ mime: string; data: Uint8Array }> = [];
          for (const img of r.images ?? []) {
            if (!img.url) continue;
            const dl = await fetchOf(opts.fetch)(img.url);
            if (!dl.ok) throw new FalImageError(`could not download the image for ${e.unit} (HTTP ${dl.status})`);
            images.push({ mime: img.content_type ?? (dl.headers.get('content-type') ?? 'image/png'), data: new Uint8Array(await dl.arrayBuffer()) });
          }
          if (!images.length) throw new FalImageError(`fal returned no image for ${e.unit}`);
          const item = { unit: e.unit, output: e.output ?? 'keyframe' };
          out.push(...(await storeUnitImages(host, { id: h.job, stage: h.stage }, item, FAL_PROVIDER_ID, e.model ?? providerConfig(config, FAL_PROVIDER_ID).default_model, images)));
        }
        stored.set(h.ref, out);
        return out;
      },
    },
    { config },
  );
}
