// com.ikenga.studio project sidecar · registry.ts gates
//
//   bun run src/registry.test.ts   (from sidecars/project/)
//   bun run test                    (package script)
//
// Plain assert-based script (no bun:test / node:test import) so this
// typechecks cleanly under the shared `tsc -p ../../tsconfig.json` project
// (sidecars/project has no node_modules of its own — see package.json — so
// it can't privately carry `@types/bun`) while still running as a real
// test via the bun runtime, which is already this sidecar's build/run
// target (build.sh bundles with `bun build`).
//
// WP-32 DoD 8 — auto-resolution consent guard. `resolveEngineWithRequest`'s
// auto branch (requested undefined/'auto') must never silently land on a
// `requires_network: true` adapter: fal is metered and vault-keyed, so
// "auto" cannot be read as consent to spend money. An explicit engine pick
// (`requested: 'fal'`) must still pass through untouched — that IS consent.

import assert from 'node:assert/strict';

import { EngineResolutionError, resolveEngine, resolveEngineWithRequest } from './registry.js';

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function assertRejects(
  fn: () => unknown,
  expectedCode: EngineResolutionError['code'],
): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof EngineResolutionError, 'expected an EngineResolutionError');
    assert.equal((e as EngineResolutionError).code, expectedCode);
    return;
  }
  throw new Error('expected function to throw, but it returned normally');
}

// -- resolveEngine (content-path resolution, no consent gate) --------------

test('extension-less content_path still resolves to fal in isolation', () => {
  // resolveEngine() itself is unchanged by the WP-32 guard — it answers
  // "what does this content_path map to", not "is this consented". The
  // gate lives one level up, in resolveEngineWithRequest's auto branch.
  assert.equal(resolveEngine(''), 'fal');
});

test('.html still resolves to hyperframes (network-free, unaffected)', () => {
  assert.equal(resolveEngine('cell.html'), 'hyperframes');
});

// -- resolveEngineWithRequest — WP-32 DoD 8 consent guard -------------------

test('extension-less content_path + auto (undefined) is rejected', () => {
  assertRejects(
    () => resolveEngineWithRequest('', undefined),
    'network-engine-requires-explicit-renderer',
  );
});

test('extension-less content_path + engine:"auto" (explicit auto) is also rejected', () => {
  assertRejects(
    () => resolveEngineWithRequest('', 'auto'),
    'network-engine-requires-explicit-renderer',
  );
});

test('extension-less content_path + explicit engine:"fal" is consent and passes', () => {
  assert.equal(resolveEngineWithRequest('', 'fal'), 'fal');
});

test('.html content_path + auto still resolves normally (requires_network:false, unguarded)', () => {
  assert.equal(resolveEngineWithRequest('cell.html', undefined), 'hyperframes');
});

test('.excalidraw content_path + auto still resolves normally (requires_network:false, unguarded)', () => {
  assert.equal(resolveEngineWithRequest('board.excalidraw', undefined), 'excalidraw');
});

test('.tsx content_path resolves to remotion (requires_network:false, unguarded)', () => {
  assert.equal(resolveEngine('scene.tsx'), 'remotion');
  assert.equal(resolveEngineWithRequest('scene.tsx', undefined), 'remotion');
  assert.equal(resolveEngineWithRequest('scene.tsx', 'remotion'), 'remotion');
});

test('an unrecognized extension is still rejected as unresolvable, not routed to fal', () => {
  assertRejects(() => resolveEngineWithRequest('cell.json', undefined), 'unresolvable-engine');
});

console.log(`\n${passed} passed`);

