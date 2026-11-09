/**
 * Mocked network for the fal video provider tests: a recording `fetch` that
 * answers like fal's queue. No test makes a real call.
 */

import type { FetchLike } from '../../gemini-image/image-common.ts';
import type { MockNet } from '../../gemini-image/__fixtures__/mock-net.ts';

export const MP4_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3]);

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

export function mockFalVideo(opts: { status?: () => string; failSubmit?: (n: number) => Response | undefined } = {}): MockNet {
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
    if (u.endsWith('/status')) return json({ status: opts.status?.() ?? 'COMPLETED' });
    if (u.startsWith('https://queue.fal.run/')) return json({ video: { url: 'https://v3.fal.media/files/out.mp4', content_type: 'video/mp4' } });
    return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  return { fetch: f, calls };
}
