/**
 * Mocked networks for the direct video and image providers added with
 * gemini-video, kling-video, byteplus-video and byteplus-image: recording
 * `fetch`es that answer like each provider's documented API (the shapes
 * cited in providers/config.json). No test makes a real call.
 */

import type { FetchLike } from '../gemini-image/image-common.ts';
import type { MockNet, Recorded } from '../gemini-image/__fixtures__/mock-net.ts';
import { PNG_B64 } from '../gemini-image/__fixtures__/mock-net.ts';
import { MP4_BYTES } from '../fal-video/__fixtures__/mock-net.ts';

export { MP4_BYTES };

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function recorder(calls: Recorded[]) {
  return (url: unknown, init: RequestInit | undefined): Recorded => {
    const r: Recorded = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(r);
    return r;
  };
}

export interface DirectMockOptions {
  /** Request number of a create call (1-based) -> a Response that replaces the normal answer. */
  failCreate?: (n: number) => Response | undefined;
  /** Task / file number -> status text the provider reports (default: done). */
  statusFor?: (n: number) => string | undefined;
  /** Task number -> failure message (with a failed status). */
  errorFor?: (n: number) => string | undefined;
  /** Status reads fail with a 5xx for this task number. */
  statusFail?: (n: number) => boolean;
}

const posts = (calls: Recorded[]): number => calls.filter((c) => c.method === 'POST').length;
const DOWNLOAD = 'https://cdn.example-video.test/out.mp4';

/** Gemini Interactions (video, delivery uri) + Files API status and download (with one redirect). */
export function mockGeminiVideo(opts: DirectMockOptions & { inline?: boolean } = {}): MockNet {
  const calls: Recorded[] = [];
  const rec = recorder(calls);
  const f: FetchLike = async (url, init) => {
    const r = rec(url, init);
    if (r.method === 'POST' && r.url.endsWith('/v1beta/interactions')) {
      const n = posts(calls);
      const failed = opts.failCreate?.(n);
      if (failed) return failed;
      const content = opts.inline
        ? [{ type: 'video', mime_type: 'video/mp4', data: Buffer.from(MP4_BYTES).toString('base64') }]
        : [{ type: 'video', mime_type: 'video/mp4', uri: `https://generativelanguage.googleapis.com/v1beta/files/vid${n}:download?alt=media` }];
      return json({ id: `int${n}`, object: 'interaction', status: 'completed', steps: [{ type: 'model_output', content }] });
    }
    const file = /\/v1beta\/files\/vid(\d+)(:download)?/.exec(r.url);
    if (file && !file[2]) {
      const n = Number(file[1]);
      if (opts.statusFail?.(n)) return new Response('unavailable', { status: 503 });
      const st = opts.statusFor?.(n) ?? 'ACTIVE';
      return json({ name: `files/vid${n}`, state: st, ...(st === 'FAILED' ? { error: { message: opts.errorFor?.(n) ?? 'failed' } } : {}) });
    }
    if (file && file[2]) return new Response(null, { status: 302, headers: { location: DOWNLOAD } });
    if (r.url === DOWNLOAD) return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
    return new Response('not mocked', { status: 599 });
  };
  return { fetch: f, calls };
}

/** Kling's legacy image2video create + query, and the CDN download. */
export function mockKling(opts: DirectMockOptions = {}): MockNet {
  const calls: Recorded[] = [];
  const rec = recorder(calls);
  const f: FetchLike = async (url, init) => {
    const r = rec(url, init);
    if (r.method === 'POST' && r.url === 'https://api-singapore.klingai.com/v1/videos/image2video') {
      const n = posts(calls);
      const failed = opts.failCreate?.(n);
      if (failed) return failed;
      return json({ code: 0, message: 'SUCCEED', request_id: `r${n}`, data: { task_id: `task${n}`, task_status: 'submitted' } });
    }
    const q = /\/v1\/videos\/image2video\/task(\d+)$/.exec(r.url);
    if (q) {
      const n = Number(q[1]);
      if (opts.statusFail?.(n)) return json({ code: 5000, message: 'server error' }, 500);
      const st = opts.statusFor?.(n) ?? 'succeed';
      return json({
        code: 0,
        message: 'SUCCEED',
        data: {
          task_id: `task${n}`,
          task_status: st,
          ...(st === 'failed' ? { task_status_msg: opts.errorFor?.(n) ?? 'risk control' } : {}),
          ...(st === 'succeed' ? { task_result: { videos: [{ id: `v${n}`, url: DOWNLOAD, duration: '5' }] } } : {}),
        },
      });
    }
    if (r.url === DOWNLOAD) return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
    return new Response('not mocked', { status: 599 });
  };
  return { fetch: f, calls };
}

/** BytePlus ModelArk: video tasks and image generations. */
export function mockArk(opts: DirectMockOptions & { noImage?: boolean } = {}): MockNet {
  const calls: Recorded[] = [];
  const rec = recorder(calls);
  const BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';
  const f: FetchLike = async (url, init) => {
    const r = rec(url, init);
    if (r.method === 'POST' && r.url === `${BASE}/contents/generations/tasks`) {
      const n = posts(calls);
      const failed = opts.failCreate?.(n);
      if (failed) return failed;
      return json({ id: `cgt-${n}` });
    }
    const t = /\/contents\/generations\/tasks\/cgt-(\d+)$/.exec(r.url);
    if (t) {
      const n = Number(t[1]);
      if (opts.statusFail?.(n)) return json({ error: { code: 'ServerOverloaded', message: 'busy' } }, 503);
      const st = opts.statusFor?.(n) ?? 'succeeded';
      return json({
        id: `cgt-${n}`,
        status: st,
        ...(st === 'succeeded' ? { content: { video_url: DOWNLOAD }, usage: { completion_tokens: 108680 } } : {}),
        error: st === 'failed' ? { code: 'OutputVideoSensitiveContentDetected', message: opts.errorFor?.(n) ?? 'blocked' } : null,
      });
    }
    if (r.method === 'POST' && r.url === `${BASE}/images/generations`) {
      const n = posts(calls);
      const failed = opts.failCreate?.(n);
      if (failed) return failed;
      if (opts.noImage) return json({ data: [{ error: { code: 'OutputImageSensitiveContentDetected', message: 'blocked' } }], usage: { generated_images: 0 } });
      return json({ model: 'm', created: 1, data: [{ b64_json: PNG_B64, size: '2560x1440' }], usage: { generated_images: 1 } });
    }
    if (r.url === DOWNLOAD) return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
    return new Response('not mocked', { status: 599 });
  };
  return { fetch: f, calls };
}
