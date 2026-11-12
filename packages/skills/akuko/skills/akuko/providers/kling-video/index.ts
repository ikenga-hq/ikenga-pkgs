/**
 * Kling video provider (direct API, Kling's own developer API): image-to-video.
 *
 * One task per unit on `POST /v1/videos/image2video`: the approved key frame
 * is the `image` (raw base64), the motion prompt the `prompt`; the task is
 * polled on `GET /v1/videos/image2video/<task_id>` until `succeed`, and the
 * clip is downloaded from `task_result.videos[0].url`.
 *
 * Auth is Kling's access key + secret key: an HS256 JWT (iss = access key,
 * exp = now + 30 min, nbf = now - 5 s) minted per request and sent as a
 * Bearer token (`KLING_ACCESS_KEY`, `KLING_SECRET_KEY`; names in config).
 * The secret never leaves the process; only the signed token is sent, and
 * only to the API host.
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json; a configured id
 *     is `<model_name>#<mode>[#audio]` (mode std = 720P, pro = 1080P)
 *   - hosts A, B and C (host A only through the pasted-key flow, lib/spend.md R-11)
 *   - lengths per family (Kling's capability map): 2.5 Turbo and 2.6 make 5 or
 *     10 s, 3.0 makes 3 to 15 s; a start frame must be PNG or JPEG (Kling
 *     takes no other type)
 *   - Kling bills a prepaid package or balance: error 1102 says it is used up
 *
 * Lip-sync: Kling's lip-sync is a two-step API (identify-face, then
 * advanced-lip-sync) that takes a video only as a public URL or a
 * Kling-made video id, so it does not fit akuko's lip-sync step (local
 * clips and stills). It is not wired; see lib/providers.md.
 */

import { createHmac } from 'node:crypto';
import type { AkukoProviderConfig } from '../config.ts';
import { loadProviderConfig, providerConfig } from '../config.ts';
import type { JobItem, Provider, WaveOneHost } from '../contract.ts';
import type { FetchLike, RefLoader } from '../gemini-image/image-common.ts';
import { defaultRefLoader, fetchOf, toBase64 } from '../gemini-image/image-common.ts';
import {
  VideoProviderError,
  createAsyncVideoProvider,
  downloadBytes,
  keyReader,
  loadStartFrame,
  readJson,
  splitVariants,
  transientError,
  wholeSeconds,
  type ClipLimits,
} from '../video-common.ts';

export const KLING_VIDEO_PROVIDER_ID = 'kling-video';
export const KLING_API = 'https://api-singapore.klingai.com';
const MODES = ['std', 'pro'];
const MAX_TEXT = 2500;

/** First match wins. Matched on a fragment of model_name (ids stay in config.json). */
const FAMILIES: Array<{ match: RegExp; seconds: number[]; audio: boolean }> = [
  { match: /^kling-v2-5-turbo$/, seconds: [5, 10], audio: false },
  { match: /^kling-v2-6$/, seconds: [5, 10], audio: false },
  { match: /^kling-v3$/, seconds: wholeSeconds(3, 15), audio: true },
];

export function klingVideoLimits(model: string): (ClipLimits & { modelName: string; mode: string; audio: boolean }) | undefined {
  const { base, variants, audio } = splitVariants(model);
  const fam = FAMILIES.find((x) => x.match.test(base));
  const mode = variants.find((v) => MODES.includes(v));
  if (!fam || !mode || (audio && !fam.audio)) return undefined;
  return { allowedSeconds: fam.seconds, modelName: base, mode, audio };
}

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

/** Kling's HS256 token (authentication docs, ak-sk tab). Exported for tests. */
export function klingToken(accessKey: string, secretKey: string, nowS: number = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: accessKey, exp: nowS + 1800, nbf: nowS - 5 }));
  const sig = createHmac('sha256', secretKey).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export interface KlingVideoOptions {
  config?: AkukoProviderConfig;
  accessKey?: string | (() => string | undefined);
  secretKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  loadRef?: RefLoader;
  now?: () => string;
  /** Clock in seconds for the token, for tests. */
  nowS?: () => number;
}

interface KlingAnswer {
  code?: number;
  message?: string;
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: { videos?: Array<{ url?: string; duration?: string }> };
  };
}

/** Kling's codes (error-codes page): 1000-1004 auth, 1100-1103 account, 1200-1203 request, 1300-1304 policy / limits, 5000+ server. */
function klingError(status: number, a: KlingAnswer | undefined, what: string): VideoProviderError {
  const code = a?.code;
  const hint = code === 1102 ? ' (the prepaid resource package is used up or expired: buy or renew one in the Kling developer console)'
    : code !== undefined && code >= 1000 && code <= 1004 ? ' (the access key / secret key pair was refused)'
      : code === 1301 ? ' (Kling\'s content safety check refused it; change the prompt or the frame)'
        : '';
  const transient = status >= 500 || code === 1302 || code === 1303 || (code !== undefined && code >= 5000);
  return new VideoProviderError(`Kling ${what} HTTP ${status}${code !== undefined ? ` code ${code}` : ''}: ${a?.message ?? 'no message'}${hint}`, { transient });
}

export function createKlingVideoProvider(host: WaveOneHost, opts: KlingVideoOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const entry = providerConfig(config, KLING_VIDEO_PROVIDER_ID);
  const loadRef = opts.loadRef ?? defaultRefLoader(opts.fetch);
  const f = fetchOf(opts.fetch);
  const access = keyReader(opts.accessKey, entry.key_env, 'Kling access key');
  const secret = keyReader(opts.secretKey, entry.secret_env, 'Kling secret key');
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${klingToken(access(), secret(), (opts.nowS ?? (() => Math.floor(Date.now() / 1000)))())}`,
    'Content-Type': 'application/json',
  });

  async function call(url: string, init: RequestInit, what: string): Promise<NonNullable<KlingAnswer['data']>> {
    let res: Response;
    try {
      res = await f(url, init);
    } catch (err) {
      throw transientError(`could not reach Kling (${err instanceof Error ? err.message : String(err)})`);
    }
    const a = await readJson<KlingAnswer>(res, `Kling ${what}`).catch((err: unknown) => {
      if (!res.ok) throw klingError(res.status, undefined, what);
      throw err;
    });
    if (!res.ok || (a.code !== undefined && a.code !== 0)) throw klingError(res.status, a, what);
    if (!a.data) throw new VideoProviderError(`Kling ${what}: the answer has no data`);
    return a.data;
  }

  return createAsyncVideoProvider({
    id: KLING_VIDEO_PROVIDER_ID,
    refPrefix: 'kling:',
    config,
    host,
    ...(opts.now ? { now: opts.now } : {}),
    capabilities: { i2v: true, maxSeconds: 15, nativeAudio: true, refImages: 1 },
    limits: klingVideoLimits,
    checkItem(_model, item: JobItem) {
      if (item.prompt.length > MAX_TEXT) throw new VideoProviderError(`unit "${item.unit}": Kling takes a prompt of at most ${MAX_TEXT} characters (this one has ${item.prompt.length}).`);
      if ((item.negative ?? '').length > MAX_TEXT) throw new VideoProviderError(`unit "${item.unit}": Kling takes things-to-avoid of at most ${MAX_TEXT} characters.`);
    },
    basisNote: (_job, model) => `mode ${klingVideoLimits(model)?.mode ?? '?'}; billed from your prepaid Kling package or balance`,
    ensureKey: () => { access(); secret(); },

    async enqueue(model, item) {
      const l = klingVideoLimits(model) as NonNullable<ReturnType<typeof klingVideoLimits>>;
      const frame = await loadStartFrame(item, loadRef);
      if (frame.mime !== 'image/png' && frame.mime !== 'image/jpeg') {
        throw new VideoProviderError(`unit "${item.unit}": Kling takes a PNG or JPEG start frame, not ${frame.mime}`);
      }
      const body = {
        model_name: l.modelName,
        image: toBase64(frame.data), // raw base64, no data: prefix (Kling's docs)
        prompt: item.prompt.trim(),
        ...(item.negative?.trim() ? { negative_prompt: item.negative.trim() } : {}),
        duration: String(item.duration_s),
        mode: l.mode,
        sound: l.audio ? 'on' : 'off',
      };
      const d = await call(`${KLING_API}/v1/videos/image2video`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, 'create');
      if (!d.task_id) throw new VideoProviderError('Kling returned no task id');
      return { remote: d.task_id };
    },

    async status(e) {
      if (!/^[A-Za-z0-9_-]+$/.test(e.remote)) throw new VideoProviderError('this handle has an unexpected Kling task id');
      const d = await call(`${KLING_API}/v1/videos/image2video/${e.remote}`, { headers: headers() }, 'status');
      if (d.task_status === 'succeed') {
        const url = d.task_result?.videos?.[0]?.url;
        if (!url) return { state: 'failed', message: 'Kling finished but returned no video' };
        return { state: 'done', output: url };
      }
      if (d.task_status === 'failed') return { state: 'failed', message: d.task_status_msg ?? 'Kling could not make the clip' };
      if (d.task_status === 'submitted' || d.task_status === 'processing') return { state: 'running' };
      return { state: 'failed', message: `unexpected Kling status ${String(d.task_status)}` };
    },

    async download(e, output) {
      return { data: await downloadBytes(f, output, e.unit) };
    },
  });
}
