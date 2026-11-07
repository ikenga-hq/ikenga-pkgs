/**
 * Mocked network for the image-provider tests: a recording `fetch` that answers
 * like Gemini's Interactions endpoint and fal's queue. No test makes a real call.
 */

import type { FetchLike } from '../image-common.ts';

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
export const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');
export const REF_URI = `data:image/png;base64,${PNG_B64}`;

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockNet {
  fetch: FetchLike;
  calls: Recorded[];
}

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function record(calls: Recorded[], url: unknown, init: RequestInit | undefined): Recorded {
  const r: Recorded = {
    url: String(url),
    method: init?.method ?? 'GET',
    headers: { ...(init?.headers as Record<string, string> | undefined) },
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  calls.push(r);
  return r;
}

export function mockGemini(opts: { fail?: (n: number) => Response | undefined } = {}): MockNet {
  const calls: Recorded[] = [];
  const f: FetchLike = async (url, init) => {
    record(calls, url, init);
    const failed = opts.fail?.(calls.length);
    if (failed) return failed;
    return json({
      id: `v1_${calls.length}`,
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }, { type: 'image', mime_type: 'image/png', data: PNG_B64 }] }],
    });
  };
  return { fetch: f, calls };
}

export function mockFal(opts: { status?: () => string } = {}): MockNet {
  const calls: Recorded[] = [];
  const f: FetchLike = async (url, init) => {
    const r = record(calls, url, init);
    const u = r.url;
    if (r.method === 'POST') {
      const n = calls.filter((c) => c.method === 'POST').length;
      const app = u.replace('https://queue.fal.run/', '').split('/').slice(0, 2).join('/');
      return json({
        request_id: `req${n}`,
        status_url: `https://queue.fal.run/${app}/requests/req${n}/status`,
        response_url: `https://queue.fal.run/${app}/requests/req${n}`,
      });
    }
    if (u.endsWith('/status')) return json({ status: opts.status?.() ?? 'COMPLETED' });
    if (u.startsWith('https://queue.fal.run/')) {
      return json({ images: [{ url: 'https://v3.fal.media/files/out.png', content_type: 'image/png' }] });
    }
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  return { fetch: f, calls };
}
