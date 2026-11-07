// akuko — sealing and no-network-in-estimate checks for both image providers
// (providers/gemini-image and providers/fal).

import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import type { Job, Provider } from '../contract.ts';
import { SpendGateBypassError, isSealed } from '../../spend/gate.ts';
import { createFakeHost, tinyProject } from '../__fixtures__/fake-host.ts';
import { createGeminiImageProvider } from './index.ts';
import { createFalImageProvider } from '../fal/index.ts';

const DIRS = [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../fal/', import.meta.url))];

function modules(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__fixtures__' && name !== 'node_modules') out.push(...modules(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const job = (provider: string): Job => ({
  id: 'job_s', stage: 'keyframes', kind: 'image', provider, label: 'x',
  items: [{ unit: 'sc1_sh1', prompt: 'p', output: 'keyframe' }],
});

const has = (v: unknown, k: string): boolean => v !== null && (typeof v === 'object' || typeof v === 'function') && k in (v as object);

describe('image providers: only sealed providers expose submit()', () => {
  it('walks every module under providers/gemini-image and providers/fal', async () => {
    const files = DIRS.flatMap(modules);
    assert.ok(files.length >= 3, files.join(','));
    const seen: string[] = [];
    for (const file of files) {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        const candidates: Array<[string, unknown]> = [[name, value]];
        if (value && typeof value === 'object') candidates.push(...Object.entries(value).map(([k, v]): [string, unknown] => [`${name}.${k}`, v]));
        for (const [label, c] of candidates) {
          if (has(c, 'submit') && typeof (c as { submit: unknown }).submit === 'function') {
            seen.push(label);
            assert.ok(isSealed(c as Provider), `${label} exposes an unsealed submit()`);
            await assert.rejects((c as Provider).submit(job('x')), SpendGateBypassError, label);
          }
        }
      }
    }
    // The factories are the only public way in: they return sealed providers, never raw impls.
    assert.deepEqual(seen, [], 'no module exports a provider object directly; they export factories');
  });

  it('the providers the factories build are sealed, and a direct submit() throws', async () => {
    const host = createFakeHost(tinyProject());
    for (const [p, id] of [[createGeminiImageProvider(host, { apiKey: 'k' }), 'gemini-image'], [createFalImageProvider(host, { apiKey: 'k' }), 'fal']] as const) {
      assert.ok(isSealed(p));
      await assert.rejects(p.submit(job(id)), SpendGateBypassError);
    }
  });

  it('estimate() never touches fetch', async () => {
    const real = globalThis.fetch;
    let touched = 0;
    globalThis.fetch = (() => {
      touched++;
      throw new Error('estimate() must not use the network');
    }) as typeof fetch;
    try {
      const host = createFakeHost(tinyProject());
      for (const [p, id] of [[createGeminiImageProvider(host), 'gemini-image'], [createFalImageProvider(host), 'fal']] as const) {
        const cost = await p.estimate(job(id));
        assert.ok(cost.amount > 0);
      }
      assert.equal(touched, 0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
