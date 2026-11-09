/**
 * Mocked network for the fal video provider tests: a recording `fetch` that
 * answers like fal's queue. No test makes a real call.
 */

import type { FetchLike } from '../../gemini-image/image-common.ts';
import type { MockNet } from '../../gemini-image/__fixtures__/mock-net.ts';

export const MP4_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3]);

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

export interface FalVideoMockOptions {
  status?: () => string;
  failSubmit?: (n: number) => Response | undefined;
  /** Request number (1-based, in submit order) -> error text fal reports when it completes that request. */
  error?: (n: number) => string | undefined;
  /** Request number -> true when its result has no video. */
  noVideo?: (n: number) => boolean;
  /** Request number -> status text for that request (overrides `status`). */
  statusFor?: (n: number) => string | undefined;
  /** Request number -> how reading its result fails: a 5xx, a 4xx or a network error. */
  resultFail?: (n: number) => '5xx' | '4xx' | 'throw' | undefined;
}

export function mockFalVideo(opts: FalVideoMockOptions = {}): MockNet {
  const calls: MockNet['calls'] = [];
  const f: FetchLike = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: u, method, headers: { ...(init?.headers as Record<string, string> | undefined) }, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST') {
      const posts = calls.filter((c) => c.method === 'POST').length;
      const failed = opts.failSubmit?.(posts);
      if (failed) return failed;
      // fal answers with the app (first two path parts), not the full endpoint path
      const app = u.replace('https://queue.fal.run/', '').split('/').slice(0, 2).join('/');
      return json({
        request_id: `req${posts}`,
        status_url: `https://queue.fal.run/${app}/requests/req${posts}/status`,
        response_url: `https://queue.fal.run/${app}/requests/req${posts}`,
      });
    }
    const req = Number(/requests\/req(\d+)/.exec(u)?.[1] ?? 0);
    if (u.endsWith('/status')) {
      const error = opts.error?.(req);
      return json({ status: opts.statusFor?.(req) ?? opts.status?.() ?? 'COMPLETED', ...(error ? { error } : {}) });
    }
    if (u.startsWith('https://queue.fal.run/') && !u.endsWith('/status')) {
      const fail = opts.resultFail?.(req);
      if (fail === 'throw') throw new TypeError('network down');
      if (fail === '5xx') return new Response('bad gateway', { status: 502 });
      if (fail === '4xx') return new Response('gone', { status: 404 });
    }
    if (u.startsWith('https://queue.fal.run/') && opts.noVideo?.(req)) return json({ detail: 'nothing' });
    if (u.startsWith('https://queue.fal.run/')) return json({ video: { url: 'https://v3.fal.media/files/out.mp4', content_type: 'video/mp4' } });
    return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  return { fetch: f, calls };
}
