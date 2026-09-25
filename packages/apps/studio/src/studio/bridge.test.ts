// com.ikenga.studio · bridge predicate tests (WP-04 live-round fix)
//
//   bun run src/studio/bridge.test.ts   (from packages/apps/studio/)
//
// Plain assert-based script (no bun:test / node:test import) so it typechecks
// under `tsc -p tsconfig.web.json` alongside the rest of `src/`, same rationale
// as lib/canvas-links.test.ts and lib/path.test.ts.
//
// Covers `isHostCallTimeout` — the predicate the Launcher's open-folder flow
// branches on. It is pure, so it is testable without a shell bridge; importing
// bridge.ts has no module-level side effects (every `App` / postMessage touch
// happens inside a function).
//
// The case that matters most here is the LAST one: an abort raised through
// `HostCallOptions.signal` reaches the caller as the same RequestTimeout code
// as a real deadline, because the SDK wraps a non-McpError abort reason in
// `McpError(ErrorCode.RequestTimeout, String(reason))`
// (node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js, the
// `cancel()` closure in `request`). That is WHY Launcher.openFolderFlow keeps
// its own `folderCancelledRef` instead of classifying the error — if this test
// ever starts failing because the SDK grew a distinct abort code, that ref can
// go away.

import assert from 'node:assert/strict';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { isHostCallTimeout } from './bridge';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test('McpError(RequestTimeout) — the host never answered', () => {
  assert.equal(isHostCallTimeout(new McpError(ErrorCode.RequestTimeout, 'Request timed out')), true);
});

test('another McpError code is NOT a timeout', () => {
  assert.equal(isHostCallTimeout(new McpError(ErrorCode.InvalidParams, 'bad args')), false);
  assert.equal(isHostCallTimeout(new McpError(ErrorCode.InternalError, 'host blew up')), false);
});

test('duck-typed {code: -32001} — bundler-duplicated McpError class', () => {
  // The instanceof check fails when two copies of the SDK's types module end
  // up in the bundle; the `.code` fallback is what keeps this working.
  assert.equal(isHostCallTimeout({ code: -32001, message: 'Request timed out' }), true);
  assert.equal(ErrorCode.RequestTimeout, -32001); // pin the constant the fallback hardcodes
});

test('a plain Error is not a timeout', () => {
  assert.equal(isHostCallTimeout(new Error('openFolder failed: EACCES')), false);
});

test('non-object rejections are not timeouts', () => {
  assert.equal(isHostCallTimeout(null), false);
  assert.equal(isHostCallTimeout(undefined), false);
  assert.equal(isHostCallTimeout('Request timed out'), false);
  assert.equal(isHostCallTimeout({ message: 'Request timed out' }), false); // no `code`
});

test('a signal-driven abort is INDISTINGUISHABLE from a real timeout', () => {
  // Exactly what the SDK's `cancel()` does with a non-McpError abort reason.
  const asSdkWrapsIt = new McpError(
    ErrorCode.RequestTimeout,
    String(new Error('open-folder wait cancelled from the Launcher')),
  );
  assert.equal(isHostCallTimeout(asSdkWrapsIt), true);
});

console.log(`\n${passed} passed`);
