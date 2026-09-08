// com.ikenga.studio project sidecar · fal.ts renderer adapter
//
//   bun run src/renderers/fal.test.ts   (from sidecars/project/)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as blender.test.ts / registry.test.ts: this file typechecks under the shared
// `tsc -p ../../tsconfig.json` project, which has no Bun types, while still
// running for real under the bun runtime.
//
// Covers the pure input-shaping helpers, which is where the Blender-authored
// workflow is actually wired in. Nothing here touches the network or needs a
// fal key.

import assert from 'node:assert/strict';

import { buildVideoInput, readLoras, resolveKey, falAdapter } from './fal.js';
import type { Cell } from '@ikenga/studio-schema';
import type { RenderContext } from './types.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/** Minimal Cell shaped just enough for the pure builders. */
function cellWith(metadata: Record<string, unknown>, extra: Partial<Cell> = {}): Cell {
  return {
    uid: 'c1',
    prompt: 'a woman blacksmith at the anvil',
    metadata,
    ...extra,
  } as unknown as Cell;
}

async function main(): Promise<number> {
  console.log('\nfal.ts — input shaping\n');

  // ── metadata.fal_loras → input.loras ───────────────────────────────────
  test('readLoras: returns the configured loras', () => {
    const loras = readLoras(cellWith({ fal_loras: [{ path: 'https://x/l.safetensors', scale: 1 }] }));
    assert.equal(loras?.length, 1);
    assert.equal((loras![0] as Record<string, unknown>).path, 'https://x/l.safetensors');
  });

  test('readLoras: absent / empty / non-array all yield undefined', () => {
    assert.equal(readLoras(cellWith({})), undefined);
    assert.equal(readLoras(cellWith({ fal_loras: [] })), undefined);
    assert.equal(readLoras(cellWith({ fal_loras: 'nope' })), undefined);
  });

  test('readLoras: drops non-object entries rather than passing junk to the API', () => {
    const loras = readLoras(cellWith({ fal_loras: [{ path: 'a' }, null, 'b', 7] }));
    assert.equal(loras?.length, 1);
  });

  test('buildVideoInput: loras are attached when configured, absent when not', () => {
    const withLora = buildVideoInput({
      cell: cellWith({ fal_loras: [{ path: 'https://x/l.safetensors', scale: 1 }] }),
    });
    assert.ok(Array.isArray(withLora.loras));
    assert.ok(!('loras' in buildVideoInput({ cell: cellWith({}) })));
  });

  // ── metadata.fal_upload → uploaded refs merged into input ──────────────
  // This is what makes the Blender-authored shapes reachable from a cell:
  // inpaint (image_url + mask_url), first+last frame (start/end_image_url),
  // video inpaint (video_url + mask_video_url).
  test('buildVideoInput: uploaded refs are merged into the model input', () => {
    const input = buildVideoInput({
      cell: cellWith({}),
      uploads: { start_image_url: 'https://fal/a.png', end_image_url: 'https://fal/b.png' },
    });
    assert.equal(input.start_image_url, 'https://fal/a.png');
    assert.equal(input.end_image_url, 'https://fal/b.png');
  });

  test('buildVideoInput: uploads WIN over a same-named fal_input literal', () => {
    // Precedence is load-bearing: a stale hand-written url must never shadow
    // the plate the pipeline just rendered. That failure renders, costs money,
    // and looks plausible — the worst kind.
    const input = buildVideoInput({
      cell: cellWith({ fal_input: { image_url: 'https://stale/old.png', duration: '5' } }),
      uploads: { image_url: 'https://fal/fresh.png' },
    });
    assert.equal(input.image_url, 'https://fal/fresh.png');
    assert.equal(input.duration, '5', 'unrelated fal_input fields still pass through');
  });

  test('buildVideoInput: no uploads leaves the input untouched', () => {
    const input = buildVideoInput({ cell: cellWith({ fal_input: { duration: '5' } }) });
    assert.equal(input.duration, '5');
    assert.ok(!('mask_url' in input));
  });

  // ── existing contract, pinned so the additions cannot regress it ───────
  test('buildVideoInput: prompt and seed thread through', () => {
    const input = buildVideoInput({ cell: cellWith({}, { seed: 44821 }) });
    assert.equal(input.prompt, 'a woman blacksmith at the anvil');
    assert.equal(input.seed, 44821);
  });

  test('buildVideoInput: aspect_ratio only for text-to-video, never with an image', () => {
    // The i2v sibling endpoints 422 on aspect_ratio — they derive framing from
    // the image. Pinned because the uploads change touches this same builder.
    assert.equal(buildVideoInput({ cell: cellWith({}), aspect: '16:9' }).aspect_ratio, '16:9');
    assert.ok(
      !('aspect_ratio' in buildVideoInput({
        cell: cellWith({}),
        imageUrl: 'https://x/i.png',
        aspect: '16:9',
      })),
    );
  });

  test('buildVideoInput: negative prompt is read from either metadata spelling', () => {
    assert.equal(buildVideoInput({ cell: cellWith({ negative: 'blurry' }) }).negative_prompt, 'blurry');
    assert.equal(
      buildVideoInput({ cell: cellWith({ negative_prompt: 'washed out' }) }).negative_prompt,
      'washed out',
    );
  });

  // ── WP-17: Stronghold vault key resolution ────────────────────────────
  await testAsync('resolveKey: resolves studio.fal from ctx.vault.get when present', async () => {
    const origEnv = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    try {
      const mockCtx = {
        vault: { get: async (k: string) => (k === 'studio.fal' ? 'key-from-vault' : undefined) },
      } as unknown as RenderContext;
      const key = await resolveKey(mockCtx);
      assert.equal(key, 'key-from-vault');
    } finally {
      if (origEnv !== undefined) process.env.FAL_KEY = origEnv;
    }
  });

  await testAsync('resolveKey: falls back to FAL_KEY env when vault returns undefined', async () => {
    const origEnv = process.env.FAL_KEY;
    process.env.FAL_KEY = 'key-from-env';
    try {
      const mockCtx = {
        vault: { get: async () => undefined },
      } as unknown as RenderContext;
      const key = await resolveKey(mockCtx);
      assert.equal(key, 'key-from-env');
    } finally {
      if (origEnv !== undefined) process.env.FAL_KEY = origEnv;
      else delete process.env.FAL_KEY;
    }
  });

  await testAsync('resolveKey: handles vault throwing by falling back to env', async () => {
    const origEnv = process.env.FAL_KEY;
    process.env.FAL_KEY = 'key-from-env';
    try {
      const mockCtx = {
        vault: {
          get: async () => {
            throw new Error('vault-locked');
          },
        },
      } as unknown as RenderContext;
      const key = await resolveKey(mockCtx);
      assert.equal(key, 'key-from-env');
    } finally {
      if (origEnv !== undefined) process.env.FAL_KEY = origEnv;
      else delete process.env.FAL_KEY;
    }
  });

  await testAsync('falAdapter.validate: surfaces fal-key-missing warning when no key in vault or env', async () => {
    const origEnv = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    try {
      const mockCtx = {
        aspectRatio: '16:9',
        vault: { get: async () => undefined },
      } as unknown as RenderContext;
      const diags = await falAdapter.validate(cellWith({}), mockCtx);
      assert.ok(diags.some((d) => d.code === 'fal-key-missing'));
    } finally {
      if (origEnv !== undefined) process.env.FAL_KEY = origEnv;
    }
  });

  await testAsync('falAdapter.validate: clears fal-key-missing warning when vault supplies key', async () => {
    const origEnv = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    try {
      const mockCtx = {
        aspectRatio: '16:9',
        vault: { get: async (k: string) => (k === 'studio.fal' ? 'key-from-vault' : undefined) },
      } as unknown as RenderContext;
      const diags = await falAdapter.validate(cellWith({}), mockCtx);
      assert.ok(!diags.some((d) => d.code === 'fal-key-missing'));
    } finally {
      if (origEnv !== undefined) process.env.FAL_KEY = origEnv;
    }
  });

  console.log(`\n${passed} passed`);
  return 0;
}

main().then((code) => process.exit(code));
