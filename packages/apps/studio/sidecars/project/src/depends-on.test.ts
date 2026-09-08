// com.ikenga.studio project sidecar · the depends_on approval gate
//
//   bun run src/depends-on.test.ts   (from sidecars/project/)
//
// Plain assert-based script — same constraint as registry.test.ts.
//
// Mode C's clip cell interpolates between two keyframes produced by two OTHER
// cells. Generation of those keyframes is stochastic: the same plate and mask
// return a usable figure or an empty iron crucible, run to run. So "an output
// exists" carries almost no information about whether it is usable, and a clip
// built from an unreviewed keyframe is a $0.56 job that renders a plausible
// video with no character in it. That happened, for real, before this gate.
//
// The gate lived in a Python helper first. That guarded whoever ran the helper
// and nobody else — `composition.render` reaches RenderRunner.enqueue without
// passing through it. This pins it at the enqueue boundary instead, beside the
// spend gate and the G2 capability check.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type Database } from './db.js';
import { RenderRunner } from './render-runner.js';
import type { Cell } from '@ikenga/studio-schema';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const dir = mkdtempSync(join(tmpdir(), 'studio-depends-test-'));
const db: Database = await openDb(join(dir, 'studio.db'));

function cell(uid: string, approved: boolean, metadata: Record<string, unknown> = {}): Cell {
  return {
    uid, rung: '2_hifi', approved,
    // `.html` resolves to hyperframes — a FREE engine, so these tests exercise
    // the dependency gate without also tripping the spend gate.
    content_path: `cells/${uid}.html`,
    metadata,
  } as unknown as Cell;
}

const cells = new Map<string, Cell>([
  ['kf_start', cell('kf_start', false)],
  ['kf_end', cell('kf_end', false)],
  ['clip', cell('clip', false, { depends_on: ['kf_start', 'kf_end'] })],
  ['orphan', cell('orphan', false, { depends_on: ['nope'] })],
  ['plain', cell('plain', false)],
]);

const runner = new RenderRunner({
  db,
  lookup: {
    projectRoot: () => dir,
    cell: (_p, id) => cells.get(id),
    aspectRatio: () => '16:9',
    resolution: () => ({ w: 1280, h: 720 }),
    projectMetadata: () => ({}),
  },
  writer: () => {},
});

test('a cell with no dependencies enqueues', () => {
  const r = runner.enqueue('p1', 'plain');
  assert.ok(r.ok, JSON.stringify(r));
});

test('a clip is REFUSED while its keyframes are unapproved', () => {
  const r = runner.enqueue('p1', 'clip');
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, 'dependency-not-approved');
  assert.match((r as { message: string }).message, /kf_start/);
  assert.match((r as { message: string }).message, /cannot be overridden/);
});

test('approving only ONE end is not enough', () => {
  cells.set('kf_start', cell('kf_start', true));
  const r = runner.enqueue('p1', 'clip');
  assert.equal(r.ok, false, 'Mode C needs BOTH keyframes; one is a dissolve');
  assert.match((r as { message: string }).message, /kf_end/);
});

test('with both approved, the clip enqueues', () => {
  cells.set('kf_end', cell('kf_end', true));
  const r = runner.enqueue('p1', 'clip');
  assert.ok(r.ok, JSON.stringify(r));
});

test('a dependency that is not in the project is refused, not ignored', () => {
  // Silently skipping an unresolvable dependency would turn a typo in
  // depends_on into "no gate at all" — the failure mode being guarded against.
  const r = runner.enqueue('p1', 'orphan');
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, 'dependency-not-found');
});

test('a refused enqueue writes NO queue row', () => {
  cells.set('kf_start', cell('kf_start', false));
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM render_queue`).get() as { n: number }).n;
  runner.enqueue('p1', 'clip');
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM render_queue`).get() as { n: number }).n;
  assert.equal(after, before, 'a render that must not happen should never become a queued row');
});

console.log(`\n${passed} passed`);

// Exit without closing. A successful enqueue calls kick(), which starts the
// async drain loop; closing the db here races it and the loop reports
// "Cannot use a closed database" AFTER every assertion has already passed —
// noise that reads exactly like a real failure. The temp dir is the OS's
// problem, and process.exit stops the drain where it stands.
try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL still held */ }
process.exit(0);
