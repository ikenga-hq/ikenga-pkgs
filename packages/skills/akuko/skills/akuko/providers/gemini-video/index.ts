/**
 * Google video provider (direct API, the Gemini API): image-to-video clips
 * with Gemini Omni Flash.
 *
 * Veo was the Gemini API's video model until Google shut its last preview ids
 * down on 2026-10-22 and named Gemini Omni Flash as the replacement
 * (providers/config.json cites the deprecations page). Omni Flash is called
 * through the same Interactions endpoint as `gemini-image`, with the same
 * `GEMINI_API_KEY`.
 *
 * One request per unit: the approved key frame goes in as the start frame
 * (`video_config.task: image_to_video`), the motion prompt as the text, and
 * the clip comes back as a Files API uri (`delivery: "uri"`), which is polled
 * until it is ACTIVE and then downloaded. The handle keeps each unit's file
 * name, so a later session can collect with only the key.
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json
 *   - hosts A, B and C (host A only through the pasted-key flow, lib/spend.md R-11)
 *   - `estimate()` is arithmetic on config (price per second x seconds)
 *   - lengths 3 to 15 whole seconds; aspect 16:9 or 9:16 (others refused)
 *   - the model makes sound and the docs give no switch, so every configured
 *     id carries `#audio` (the price is the same, and the person is told)
 *   - the key is sent only to generativelanguage.googleapis.com; a download
 *     redirect is followed without it
 */

import type { AkukoProviderConfig } from '../config.ts';
import { loadProviderConfig, providerKeyEnv } from '../config.ts';
import type { JobItem, Provider, WaveOneHost } from '../contract.ts';
import type { FetchLike, RefLoader } from '../gemini-image/image-common.ts';
import { defaultRefLoader, fetchOf, promptText, toBase64 } from '../gemini-image/image-common.ts';
import {
  VideoProviderError,
  createAsyncVideoProvider,
  keyReader,
  loadStartFrame,
  readJson,
  splitVariants,
  transientError,
  wholeSeconds,
  type ClipLimits,
} from '../video-common.ts';

export const GEMINI_VIDEO_PROVIDER_ID = 'gemini-video';
const API = 'https://generativelanguage.googleapis.com';
const API_REVISION = '2026-05-20';
const RESOLUTIONS = ['360p', '720p', '1080p', '4k'];
const ASPECTS = ['16:9', '9:16'];

/** Request rules by model family (matched on a fragment, never a full id: ids stay in config.json). */
export function geminiVideoLimits(model: string): (ClipLimits & { resolution: string }) | undefined {
  const { base, variants } = splitVariants(model);
  if (!/^gemini-omni-\d/.test(base)) return undefined;
  const resolution = variants.find((v) => RESOLUTIONS.includes(v));
  if (!resolution) return undefined;
  return { allowedSeconds: wholeSeconds(3, 15), resolution };
}

export interface GeminiVideoOptions {
  config?: AkukoProviderConfig;
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  loadRef?: RefLoader;
  now?: () => string;
}

const fileName = (uri: string): string => {
  const m = /\/v1beta\/(files\/[^/:?]+)/.exec(uri);
  if (!m || !uri.startsWith(`${API}/`)) throw new VideoProviderError('Gemini returned an unexpected file uri; refusing to send the key to it');
  return m[1] as string;
};

export function createGeminiVideoProvider(host: WaveOneHost, opts: GeminiVideoOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const loadRef = opts.loadRef ?? defaultRefLoader(opts.fetch);
  const f = fetchOf(opts.fetch);
  const key = keyReader(opts.apiKey, providerKeyEnv(config, GEMINI_VIDEO_PROVIDER_ID), 'Gemini API key');
  const headers = (json: boolean): Record<string, string> => ({ 'x-goog-api-key': key(), 'Api-Revision': API_REVISION, ...(json ? { 'Content-Type': 'application/json' } : {}) });
  /** Clips that came back inline (small files): held for this provider object only. */
  const inline = new Map<string, Uint8Array>();

  async function httpError(res: Response, what: string): Promise<VideoProviderError> {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 200);
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep the text */ }
    const hint = res.status === 429 ? ' (a rate limit, or the key\'s project has no paid tier: video needs billing, https://ai.google.dev/gemini-api/docs/billing)' : '';
    return new VideoProviderError(`Gemini ${what} HTTP ${res.status}: ${msg}${hint}`, { transient: res.status >= 500 });
  }

  return createAsyncVideoProvider({
    id: GEMINI_VIDEO_PROVIDER_ID,
    refPrefix: 'gvid:',
    config,
    host,
    ...(opts.now ? { now: opts.now } : {}),
    capabilities: { i2v: true, maxSeconds: 15, nativeAudio: true, refImages: 1 },
    limits: geminiVideoLimits,
    checkItem(_model, item: JobItem) {
      if (item.aspect_ratio !== undefined && !ASPECTS.includes(item.aspect_ratio)) {
        throw new VideoProviderError(`unit "${item.unit}": ${GEMINI_VIDEO_PROVIDER_ID} makes ${ASPECTS.join(' or ')} clips, not ${item.aspect_ratio}.`);
      }
    },
    basisNote: () => 'the start frame is also billed as input tokens (not in this figure)',
    ensureKey: () => { key(); },

    async enqueue(model, item) {
      const limits = geminiVideoLimits(model) as NonNullable<ReturnType<typeof geminiVideoLimits>>;
      const frame = await loadStartFrame(item, loadRef);
      const body = {
        model: splitVariants(model).base,
        input: [
          { type: 'image', data: toBase64(frame.data), mime_type: frame.mime },
          { type: 'text', text: promptText(item) },
        ],
        store: false,
        background: false,
        stream: false,
        response_format: {
          type: 'video',
          duration: `${item.duration_s}s`,
          resolution: limits.resolution,
          aspect_ratio: item.aspect_ratio ?? '16:9',
          delivery: 'uri',
        },
        generation_config: { video_config: { task: 'image_to_video' } },
      };
      const res = await f(`${API}/v1beta/interactions`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
      if (!res.ok) throw await httpError(res, 'generate');
      const r = await readJson<{ id?: string; status?: string; steps?: Array<{ type?: string; content?: Array<{ type?: string; uri?: string; data?: string; mime_type?: string; text?: string }> }> }>(res, 'Gemini generate');
      if (r.status === 'failed' || r.status === 'cancelled') throw new VideoProviderError(`Gemini returned status "${r.status}"`);
      const texts: string[] = [];
      for (const step of r.steps ?? []) {
        if (step.type !== 'model_output') continue;
        for (const c of step.content ?? []) {
          if (c.type === 'video' && c.uri) return { remote: fileName(c.uri) };
          if (c.type === 'video' && c.data) {
            const id = `inline:${r.id ?? item.unit}`;
            inline.set(id, new Uint8Array(Buffer.from(c.data, 'base64')));
            return { remote: id };
          }
          if (c.type === 'text' && c.text) texts.push(c.text);
        }
      }
      throw new VideoProviderError(`Gemini returned no video${texts.length ? `: ${texts.join(' ').slice(0, 300)}` : ''}`);
    },

    async status(e) {
      if (e.remote.startsWith('inline:')) {
        return inline.has(e.remote) ? { state: 'done', output: e.remote } : { state: 'failed', message: 'the clip came back inline in an earlier session and is no longer held' };
      }
      let res: Response;
      try {
        res = await f(`${API}/v1beta/${e.remote}`, { headers: headers(false) });
      } catch (err) {
        throw transientError(`could not reach Gemini for ${e.unit} (${err instanceof Error ? err.message : String(err)})`);
      }
      if (!res.ok) throw await httpError(res, 'file status');
      const s = await readJson<{ state?: string; error?: { message?: string } }>(res, 'Gemini file status');
      if (s.state === 'ACTIVE') return { state: 'done', output: e.remote };
      if (s.state === 'FAILED') return { state: 'failed', message: s.error?.message ?? 'Gemini could not make the clip' };
      return { state: 'running' };
    },

    async download(e, output) {
      const held = inline.get(output);
      if (held) return { data: held };
      const url = `${API}/v1beta/${output}:download?alt=media`;
      let res: Response;
      try {
        res = await f(url, { headers: headers(false), redirect: 'manual' });
        // A redirect goes to storage outside the API host: follow it without the key.
        if (res.status >= 300 && res.status < 400) {
          const to = res.headers.get('location');
          if (!to || !/^https:\/\//.test(to)) throw new VideoProviderError(`Gemini redirected the download for ${e.unit} to an unusable location`);
          res = await f(to);
        }
      } catch (err) {
        if (err instanceof VideoProviderError) throw err;
        throw transientError(`could not download the clip for ${e.unit} (${err instanceof Error ? err.message : String(err)})`);
      }
      if (res.status >= 500) throw transientError(`could not download the clip for ${e.unit} (HTTP ${res.status})`);
      if (!res.ok) throw new VideoProviderError(`could not download the clip for ${e.unit} (HTTP ${res.status})`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.byteLength === 0) throw new VideoProviderError(`the clip for ${e.unit} came back empty`);
      return { data };
    },
  });
}
