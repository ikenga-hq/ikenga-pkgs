// com.ikenga.studio project sidecar · project identity is path-canonical
//
//   bun run src/project-identity.test.ts   (from sidecars/project/)
//
// Plain assert-based script — same constraint as registry.test.ts.
//
// WP-12's spend ceiling is enforced per project_id, and project_id was keyed on
// the raw path string handed to project.open. So the SAME directory opened as
// `C:/x/y` and `C:\x\y` produced two project ids, two ledgers, and two $25
// ceilings. Observed for real on 2026-09-08: one Forge directory, $1.127 under
// one id and $0.672 under another, with the gate seeing only whichever it
// happened to open.
//
// A ceiling you can reset by changing a slash is not a ceiling.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { samePath } from './paths.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const BS = String.fromCharCode(92);

test('separator spelling does not change identity', () => {
  const fwd = 'C:/Users/x/Documents/proj';
  assert.equal(samePath(fwd, fwd.split('/').join(BS)), true);
});

test('a trailing separator does not change identity', () => {
  assert.equal(samePath('/home/x/proj', '/home/x/proj/'), true);
});

test('a redundant segment does not change identity', () => {
  assert.equal(samePath('/home/x/proj', '/home/x/./sub/../proj'), true);
});

test('genuinely different directories stay different', () => {
  assert.equal(samePath('/home/x/proj-a', '/home/x/proj-b'), false);
});

test('a sibling whose name is a prefix is not the same directory', () => {
  // Guards against a naive startsWith/normalise that would fold `proj` and
  // `proj2` together and merge two films' ledgers.
  assert.equal(samePath('/home/x/proj', '/home/x/proj2'), false);
});

test('resolve() is what canonicalises — the property the fix relies on', () => {
  // If this ever stops holding, identity silently fragments again.
  const a = resolve('C:/Users/x/proj');
  const b = resolve('C:/Users/x/proj/');
  assert.equal(a, b);
});

if (process.platform === 'win32') {
  test('case does not change identity on Windows (case-insensitive FS)', () => {
    assert.equal(samePath('C:/Users/X/Proj', 'c:/users/x/proj'), true);
  });
} else {
  test('case DOES change identity off Windows (case-sensitive FS)', () => {
    assert.equal(samePath('/home/X/Proj', '/home/x/proj'), false);
  });
}

console.log(`\n${passed} passed`);
