// com.ikenga.studio project sidecar · remotion.test.ts
//
//   bun run src/renderers/remotion.test.ts   (from sidecars/project/)
//   bun run test                             (package script)
//
// Plain assert-based script (no bun:test / node:test import) for clean typechecking
// under shared tsc.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProgressLine,
  prepareEntrypoint,
  remotionAdapter,
  resolveOutputPath,
  stripAnsi,
} from './remotion.js';

let passed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
  const res = fn();
  if (res && typeof res.then === 'function') {
    res
      .then(() => {
        passed += 1;
        console.log(`  ok - ${name}`);
      })
      .catch((err) => {
        console.error(`  FAIL - ${name}:`, err);
        process.exit(1);
      });
  } else {
    passed += 1;
    console.log(`  ok - ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Adapter metadata & capabilities
// ─────────────────────────────────────────────────────────────────────────

test('adapter id is remotion and capabilities match spec', () => {
  assert.equal(remotionAdapter.id, 'remotion');
  assert.equal(remotionAdapter.capabilities.still, true);
  assert.equal(remotionAdapter.capabilities.video, true);
  assert.equal(remotionAdapter.capabilities.requires_network, false);
  assert.ok(remotionAdapter.capabilities.aspect_ratios.includes('16:9'));
  assert.ok(remotionAdapter.capabilities.aspect_ratios.includes('9:16'));
  assert.ok(remotionAdapter.capabilities.aspect_ratios.includes('1:1'));
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Progress parsing & ANSI stripping
// ─────────────────────────────────────────────────────────────────────────

test('stripAnsi removes terminal escape codes', () => {
  const colored = '\x1B[32mRendered\x1B[0m \x1B[1mframes\x1B[0m 50/100';
  assert.equal(stripAnsi(colored), 'Rendered frames 50/100');
});

test('parseProgressLine handles frame progress patterns', () => {
  const res1 = parseProgressLine('Rendering frames ... 30/120');
  assert.deepEqual(res1, { frame: 30, total: 120 });

  const res2 = parseProgressLine('Rendered frames 120/120 (100%)');
  assert.deepEqual(res2, { frame: 120, total: 120 });

  const res3 = parseProgressLine('Encoding video ... 60/120');
  assert.deepEqual(res3, { frame: 60, total: 120 });

  const res4 = parseProgressLine('Muxing video: 120/120');
  assert.deepEqual(res4, { frame: 120, total: 120 });

  const res5 = parseProgressLine('  45/120 frames remaining');
  assert.deepEqual(res5, { frame: 45, total: 120 });
});

test('parseProgressLine handles bundling percentage patterns', () => {
  const res1 = parseProgressLine('Bundling code ... 45%');
  assert.ok(res1 && 'pct' in res1 && Math.abs(res1.pct - 0.45) < 0.001);

  const res2 = parseProgressLine('Bundled code 100%');
  assert.ok(res2 && 'pct' in res2 && Math.abs(res2.pct - 1.0) < 0.001);

  const res3 = parseProgressLine('Progress: 75%');
  assert.ok(res3 && 'pct' in res3 && Math.abs(res3.pct - 0.75) < 0.001);
});

test('parseProgressLine returns null for non-progress lines', () => {
  assert.equal(parseProgressLine(''), null);
  assert.equal(parseProgressLine('Remotion CLI v4.0.0'), null);
  assert.equal(parseProgressLine('Starting browser engine...'), null);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Output path resolution
// ─────────────────────────────────────────────────────────────────────────

test('resolveOutputPath lands in rungDir/uid.mp4', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'studio-test-renders-'));
  try {
    const dummyCell = {
      uid: 'c_test_01',
      project_id: 'test-proj',
      name: 'Scene 1',
      index: 0,
      rung: '1_lofi',
      content_path: 'scenes/s1.tsx',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ctx = {
      projectRoot: tmpDir,
      rendersDir: join(tmpDir, 'renders'),
      aspectRatio: '16:9',
      vault: { get: async () => undefined },
    };

    const outPath = resolveOutputPath(dummyCell as never, ctx as never);
    // Should be in <rendersDir>/remotion/lofi/c_test_01.mp4
    assert.ok(outPath.includes(join('renders', 'remotion', 'lofi', 'c_test_01.mp4')));

    // HiFi rung ('2_hifi') -> hifi
    const finalCell = { ...dummyCell, uid: 'c_test_final', rung: '2_hifi' };
    const finalOutPath = resolveOutputPath(finalCell as never, ctx as never);
    assert.ok(finalOutPath.includes(join('renders', 'remotion', 'hifi', 'c_test_final.mp4')));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Cell validation diagnostics
// ─────────────────────────────────────────────────────────────────────────

test('validate surfaces content-missing for absent file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'studio-test-val-'));
  try {
    const cell = {
      uid: 'c_missing',
      project_id: 'test-proj',
      name: 'Missing',
      index: 0,
      rung: '1_lofi',
      content_path: 'does-not-exist.tsx',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ctx = {
      projectRoot: tmpDir,
      rendersDir: join(tmpDir, 'renders'),
      aspectRatio: '16:9',
      vault: { get: async () => undefined },
    };

    const diags = await remotionAdapter.validate(cell as never, ctx as never);
    assert.ok(diags.some((d) => d.code === 'content-missing'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validate surfaces unsupported-content-type for non-tsx', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'studio-test-val-'));
  try {
    const filePath = join(tmpDir, 'test.py');
    writeFileSync(filePath, 'print("hello")', 'utf8');

    const cell = {
      uid: 'c_py',
      project_id: 'test-proj',
      name: 'Python',
      index: 0,
      rung: '1_lofi',
      content_path: 'test.py',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ctx = {
      projectRoot: tmpDir,
      rendersDir: join(tmpDir, 'renders'),
      aspectRatio: '16:9',
      vault: { get: async () => undefined },
    };

    const diags = await remotionAdapter.validate(cell as never, ctx as never);
    assert.ok(diags.some((d) => d.code === 'unsupported-content-type'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validate surfaces content-empty for 0-byte file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'studio-test-val-'));
  try {
    const filePath = join(tmpDir, 'empty.tsx');
    writeFileSync(filePath, '', 'utf8');

    const cell = {
      uid: 'c_empty',
      project_id: 'test-proj',
      name: 'Empty',
      index: 0,
      rung: '1_lofi',
      content_path: 'empty.tsx',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ctx = {
      projectRoot: tmpDir,
      rendersDir: join(tmpDir, 'renders'),
      aspectRatio: '16:9',
      vault: { get: async () => undefined },
    };

    const diags = await remotionAdapter.validate(cell as never, ctx as never);
    assert.ok(diags.some((d) => d.code === 'content-empty'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validate passes cleanly for non-empty .tsx file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'studio-test-val-'));
  try {
    const filePath = join(tmpDir, 'valid.tsx');
    writeFileSync(filePath, 'export const MyComp = () => <div>Hello</div>;', 'utf8');

    const cell = {
      uid: 'c_valid',
      project_id: 'test-proj',
      name: 'Valid',
      index: 0,
      rung: '1_lofi',
      content_path: 'valid.tsx',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ctx = {
      projectRoot: tmpDir,
      rendersDir: join(tmpDir, 'renders'),
      aspectRatio: '16:9',
      vault: { get: async () => undefined },
    };

    const diags = await remotionAdapter.validate(cell as never, ctx as never);
    assert.equal(diags.length, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Entrypoint preparation
// ─────────────────────────────────────────────────────────────────────────

test('prepareEntrypoint preserves existing registerRoot', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'studio-test-entry-'));
  try {
    const filePath = join(tmpDir, 'rooted.tsx');
    writeFileSync(filePath, 'import { registerRoot } from "remotion"; registerRoot(() => null);', 'utf8');

    const cell = {
      uid: 'c_rooted',
      project_id: 'test-proj',
      name: 'Rooted',
      index: 0,
      rung: '1_lofi',
      content_path: 'rooted.tsx',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ctx = {
      projectRoot: tmpDir,
      rendersDir: join(tmpDir, 'renders'),
      aspectRatio: '16:9',
      vault: { get: async () => undefined },
    };

    const res = prepareEntrypoint(cell as never, ctx as never, { durationInFrames: 90, fps: 30, width: 1920, height: 1080 });
    assert.equal(res.isTemp, false);
    assert.equal(res.entryPath, filePath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('prepareEntrypoint generates dynamic wrapper when registerRoot is absent', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'studio-test-entry-'));
  let tempDirToClean: string | undefined;
  try {
    const filePath = join(tmpDir, 'component.tsx');
    writeFileSync(filePath, 'export default function MyComp() { return null; }', 'utf8');

    const cell = {
      uid: 'c_comp',
      project_id: 'test-proj',
      name: 'Comp',
      index: 0,
      rung: '1_lofi',
      content_path: 'component.tsx',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ctx = {
      projectRoot: tmpDir,
      rendersDir: join(tmpDir, 'renders'),
      aspectRatio: '16:9',
      vault: { get: async () => undefined },
    };

    const res = prepareEntrypoint(cell as never, ctx as never, { durationInFrames: 90, fps: 30, width: 1920, height: 1080 });
    assert.equal(res.isTemp, true);
    assert.ok(res.entryPath.endsWith('entry.tsx'));
    tempDirToClean = res.tempDir;
  } finally {
    if (tempDirToClean) rmSync(tempDirToClean, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
