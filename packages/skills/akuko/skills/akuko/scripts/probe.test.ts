// akuko — network probe (scripts/probe.ts). fetch is mocked: nothing here touches the network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatProbe, probeProvider, probeableProviders, readConfig, run } from './probe.ts';

const config = readConfig();

describe('network probe', () => {
  it('has a keyless https probe and the domains for every paid, real provider', () => {
    const ids = probeableProviders(config);
    for (const id of ['fal', 'fal-video', 'fal-lipsync', 'gemini-image', 'gemini-video', 'elevenlabs', 'kling-video', 'byteplus-video', 'byteplus-image']) {
      assert.ok(ids.includes(id), id);
      const n = config.providers[id]!.network!;
      assert.match(n.probe, /^https:\/\//);
      assert.equal(new URL(n.probe).host, n.domains[0], `${id}: the probe hits the first domain listed`);
    }
    assert.ok(!ids.includes('manual'));
  });

  it('sends a GET with no key, no body and no redirect followed; any HTTP answer (even 401) is reachable', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const r = await probeProvider('byteplus-video', {
      config,
      fetch: async (u, init) => { seen.push({ url: String(u), ...(init ? { init } : {}) }); return new Response('{"error":{"code":"AuthenticationError"}}', { status: 401 }); },
    });
    assert.equal(r.reachable, true);
    assert.equal(r.status, 401);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.init?.method, 'GET');
    assert.equal(seen[0]!.init?.body, undefined);
    assert.equal(seen[0]!.init?.redirect, 'manual');
    const h = seen[0]!.init?.headers as Record<string, string>;
    assert.deepEqual(Object.keys(h), ['User-Agent'], 'no Authorization or key header');
    assert.match(seen[0]!.url, /\/tasks\/akuko-probe$/, 'a GET of a task that does not exist: never a create call');
  });

  it('a network error or timeout is blocked, and says which domains to allow on claude.ai', async () => {
    const r = await probeProvider('kling-video', { config, fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
    assert.equal(r.reachable, false);
    assert.equal(r.reason, 'ENOTFOUND');
    const text = formatProbe(r).join('\n');
    assert.match(text, /BLOCKED/);
    assert.match(text, /api-singapore\.klingai\.com/);
    assert.match(text, /claude\.ai/);
  });

  it('a proxy refusal page is blocked, not reachable', async () => {
    const r = await probeProvider('gemini-video', { config, fetch: async () => new Response('Host not allowed by egress policy', { status: 403 }) });
    assert.equal(r.reachable, false);
  });

  it('the command exits 0 when all are reachable, 1 when one is blocked, 2 on bad input', async () => {
    const lines: string[] = [];
    assert.equal(await run(['fal', 'gemini-image'], { config, fetch: async () => new Response('', { status: 404 }), out: (l) => lines.push(l) }), 0);
    assert.equal(await run(['--all'], { config, fetch: async (u) => { if (String(u).includes('klingai')) throw new TypeError('blocked'); return new Response('', { status: 401 }); }, out: () => {} }), 1);
    assert.equal(await run([], { config, out: () => {} }), 2);
    assert.equal(await run(['manual'], { config, out: () => {} }), 2);
    assert.ok(lines.some((l) => /reachable/.test(l)));
  });
});
