// com.ikenga.studio · path helper tests (WP-04 live-round fix)
//
//   bun run src/studio/lib/path.test.ts   (from packages/apps/studio/)
//
// Plain assert-based script (no bun:test / node:test import) so it typechecks
// under `tsc -p tsconfig.web.json` alongside the rest of `src/`, same rationale
// as canvas-links.test.ts.

import assert from 'node:assert/strict';

import { basename } from './path';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test('posix path', () => {
  assert.equal(basename('/home/nedjamez/Projects/wp32-verify'), 'wp32-verify');
});

test('posix path, trailing slash', () => {
  assert.equal(basename('/home/nedjamez/Projects/wp32-verify/'), 'wp32-verify');
});

test('windows path — the exact bug this fixes', () => {
  // Launcher.tsx used to do `path.split('/').pop()`, which never splits this
  // and returns the whole string instead of the leaf folder.
  assert.equal(basename('C:\\Users\\nedJamez\\Projects\\wp32-verify'), 'wp32-verify');
});

test('windows path, trailing backslash', () => {
  assert.equal(basename('C:\\Users\\nedJamez\\Projects\\wp32-verify\\'), 'wp32-verify');
});

test('windows path one level under the drive root', () => {
  assert.equal(basename('C:\\Projects'), 'Projects');
});

test('windows drive root has no leaf segment', () => {
  // Picking a whole drive in the folder dialog used to yield the project name
  // "C:" (trim removes the separator, leaving a bare drive designator with no
  // `/` or `\` to split on). Callers rely on '' to fall back to 'project'.
  assert.equal(basename('C:\\'), '');
  assert.equal(basename('C:'), '');
  assert.equal(basename('c:/'), '');
  assert.equal(basename('Z:\\\\'), '');
});

test('drive-relative-looking input is left alone (not a root)', () => {
  // Not produced by the picker, but must not be mistaken for a drive root.
  assert.equal(basename('C:folder'), 'C:folder');
});

test('UNC share root keeps the share name', () => {
  assert.equal(basename('\\\\server\\share'), 'share');
  assert.equal(basename('\\\\server\\share\\wp32-verify'), 'wp32-verify');
});

test('mixed separators (tolerated, never produced by Windows itself)', () => {
  assert.equal(basename('C:/Users/nedJamez\\Projects/wp32-verify'), 'wp32-verify');
});

test('single segment, no separator', () => {
  assert.equal(basename('wp32-verify'), 'wp32-verify');
});

test('empty string', () => {
  assert.equal(basename(''), '');
});

test('separator-only input', () => {
  assert.equal(basename('///'), '');
  assert.equal(basename('\\\\\\'), '');
});

console.log(`\n${passed} passed`);
