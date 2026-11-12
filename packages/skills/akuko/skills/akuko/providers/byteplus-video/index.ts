/**
 * BytePlus ModelArk video provider (direct API): Seedance image-to-video.
 *
 * One task per unit on `POST /contents/generations/tasks`: the prompt as a
 * text item, the approved key frame as an `image_url` item with role
 * `first_frame` (a data URI), and the length, resolution and sound as
 * top-level fields. The task is polled on `GET /contents/generations/tasks/<id>`
 * until `succeeded`, and the clip is downloaded from `content.video_url`
 * (valid 24 hours, so collect the same day).
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json; a configured id
 *     is `<model id>#<resolution>[#audio]`
 *   - hosts A, B and C (host A only through the pasted-key flow, lib/spend.md R-11)
 *   - lengths per family (BytePlus's create-task page): Seedance 2.5 makes 4 to
 *     30 s, Seedance 2.0 (and fast, mini) and 1.5 pro 4 to 15 / 4 to 12 s.
 *     akuko never sends -1 ("model picks the length") and always sends ratio
 *     "adaptive" (the frame's own shape), the one value every family takes for
 *     a first-frame task
 *   - the key goes only to ark.ap-southeast.bytepluses.com; the clip's own url
 *     is downloaded without it
 */

import type { AkukoProviderConfig } from '../config.ts';
import { loadProviderConfig, providerKeyEnv } from '../config.ts';
import type { Provider, WaveOneHost } from '../contract.ts';
import type { FetchLike, RefLoader } from '../gemini-image/image-common.ts';
import { defaultRefLoader, fetchOf, promptText, toBase64 } from '../gemini-image/image-common.ts';
import {
  VideoProviderError,
  createAsyncVideoProvider,
  downloadBytes,
  keyReader,
  loadStartFrame,
  splitVariants,
  wholeSeconds,
  readJson,
  transientError,
  type ClipLimits,
} from '../video-common.ts';

// ── ModelArk calls (also used by byteplus-image) ─────────────────────────

export const ARK_API = 'https://ark.ap-southeast.bytepluses.com/api/v3';

interface ArkError { error?: { code?: string; message?: string } }

/** ModelArk error codes (error-codes page): AuthenticationError 401, ModelNotOpen 404, InvalidParameter / SensitiveContentDetected 400, rate and quota limits 429, AccountOverdueError 403. */
export function arkError(status: number, body: ArkError | undefined, what: string): VideoProviderError {
  const code = body?.error?.code ?? '';
  const hint = code === 'ModelNotOpen' ? ' (activate this model in the ModelArk console first)'
    : code === 'AuthenticationError' ? ' (the API key was refused)'
      : code === 'AccountOverdueError' ? ' (the BytePlus account is overdue: top it up in the console)'
        : code.startsWith('SensitiveContentDetected') ? ' (BytePlus\'s content check refused it; change the prompt or the reference)'
          : '';
  const transient = status >= 500 || /^(RateLimitExceeded|ServerOverloaded|RequestBurstTooFast|InflightBatchsizeExceeded)/.test(code) || code === 'ModelAccountRpmRateLimitExceeded' || code === 'ModelAccountTpmRateLimitExceeded';
  return new VideoProviderError(`BytePlus ${what} HTTP ${status}${code ? ` ${code}` : ''}: ${body?.error?.message ?? 'no message'}${hint}`, { transient });
}

/** One JSON call to ModelArk with the key as a Bearer token. The key goes only to ARK_API. */
export async function arkCall<T>(fetchFn: FetchLike | undefined, key: string, path: string, init: { method?: string; body?: unknown }, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchOf(fetchFn)(`${ARK_API}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw transientError(`could not reach BytePlus (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) {
    let body: ArkError | undefined;
    try { body = (await res.json()) as ArkError; } catch { body = undefined; }
    throw arkError(res.status, body, what);
  }
  return readJson<T>(res, `BytePlus ${what}`);
}

/** A data URI the way ModelArk wants it: `data:image/<lowercase fmt>;base64,<data>`. */
export const arkDataUri = (mime: string, b64: string): string => `data:${mime.toLowerCase()};base64,${b64}`;

// ── Seedance ─────────────────────────────────────────────────────────────

export const BYTEPLUS_VIDEO_PROVIDER_ID = 'byteplus-video';

/** First match wins; matched on a fragment of the model id. `resolutions` = what the family makes. */
const FAMILIES: Array<{ match: RegExp; seconds: number[]; resolutions: string[] }> = [
  { match: /seedance-2-5-\d/, seconds: wholeSeconds(4, 30), resolutions: ['480p', '720p', '1080p'] },
  { match: /seedance-2-0-(fast|mini)-\d/, seconds: wholeSeconds(4, 15), resolutions: ['480p', '720p'] },
  { match: /seedance-2-0-\d/, seconds: wholeSeconds(4, 15), resolutions: ['480p', '720p', '1080p'] },
  { match: /seedance-1-5-pro-\d/, seconds: wholeSeconds(4, 12), resolutions: ['480p', '720p', '1080p'] },
];

export function byteplusVideoLimits(model: string): (ClipLimits & { modelId: string; resolution: string; audio: boolean }) | undefined {
  const { base, variants, audio } = splitVariants(model);
  const fam = FAMILIES.find((x) => x.match.test(base));
  if (!fam) return undefined;
  const resolution = variants.find((v) => fam.resolutions.includes(v));
  if (!resolution) return undefined;
  return { allowedSeconds: fam.seconds, modelId: base, resolution, audio };
}

export interface ByteplusVideoOptions {
  config?: AkukoProviderConfig;
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  loadRef?: RefLoader;
  now?: () => string;
}

interface TaskAnswer {
  id?: string;
  status?: string;
  content?: { video_url?: string };
  error?: { code?: string; message?: string } | null;
}

export function createByteplusVideoProvider(host: WaveOneHost, opts: ByteplusVideoOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const loadRef = opts.loadRef ?? defaultRefLoader(opts.fetch);
  const key = keyReader(opts.apiKey, providerKeyEnv(config, BYTEPLUS_VIDEO_PROVIDER_ID), 'BytePlus ModelArk API key');

  return createAsyncVideoProvider({
    id: BYTEPLUS_VIDEO_PROVIDER_ID,
    refPrefix: 'arkv:',
    config,
    host,
    ...(opts.now ? { now: opts.now } : {}),
    capabilities: { i2v: true, maxSeconds: 30, nativeAudio: true, refImages: 1 },
    limits: byteplusVideoLimits,
    basisNote: (_job, model) => `${byteplusVideoLimits(model)?.resolution ?? '?'}, priced at the largest frame BytePlus lists for it`,
    ensureKey: () => { key(); },

    async enqueue(model, item) {
      const l = byteplusVideoLimits(model) as NonNullable<ReturnType<typeof byteplusVideoLimits>>;
      const frame = await loadStartFrame(item, loadRef);
      const body = {
        model: l.modelId,
        content: [
          { type: 'text', text: promptText(item) },
          { type: 'image_url', image_url: { url: arkDataUri(frame.mime, toBase64(frame.data)) }, role: 'first_frame' },
        ],
        resolution: l.resolution,
        ratio: 'adaptive',
        duration: item.duration_s,
        generate_audio: l.audio,
        watermark: false,
        ...(item.seed !== undefined ? { seed: item.seed } : {}),
      };
      const r = await arkCall<TaskAnswer>(opts.fetch, key(), '/contents/generations/tasks', { method: 'POST', body }, 'create task');
      if (!r.id) throw new VideoProviderError('BytePlus returned no task id');
      return { remote: r.id };
    },

    async status(e) {
      if (!/^[A-Za-z0-9_-]+$/.test(e.remote)) throw new VideoProviderError('this handle has an unexpected BytePlus task id');
      const r = await arkCall<TaskAnswer>(opts.fetch, key(), `/contents/generations/tasks/${e.remote}`, {}, 'task status');
      if (r.status === 'succeeded') {
        const url = r.content?.video_url;
        return url ? { state: 'done', output: url } : { state: 'failed', message: 'BytePlus finished but returned no video' };
      }
      if (r.status === 'queued' || r.status === 'running') return { state: 'running' };
      const why = r.error?.message ? `${r.error.code ? `${r.error.code}: ` : ''}${r.error.message}` : `the task ${String(r.status)}`;
      return { state: 'failed', message: why };
    },

    async download(e, output) {
      return { data: await downloadBytes(fetchOf(opts.fetch), output, e.unit) };
    },
  });
}
