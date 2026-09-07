// com.ikenga.studio project sidecar · spend.ts — the paid-render ceiling
//
//   bun run src/spend.test.ts   (from sidecars/project/)
//   bun run test                 (package script)
//
// Plain assert-based script (no bun:test / node:test import) so this
// typechecks cleanly under the shared `tsc -p ../../tsconfig.json` project —
// same constraint as registry.test.ts, see its header.
//
// WP-12 / Plan 16 D-b. The properties under test are the ones that make this
// a gate rather than a report:
//
//   1. a paid call is priced BEFORE it runs, and never at zero
//   2. in-flight work counts against the ceiling (reserve, not just settle)
//   3. a settled entry whose provider reported no cost keeps its estimate
//      — the single most important line, because fal usually reports none
//   4. failed / cancelled work gives its budget back
//   5. the refusal cannot be argued past
//
// Runs against a real bun:sqlite database in a temp dir, through the real
// migrations in db.ts — not a stub — so the CHECK constraints and the
// COALESCE arithmetic are actually exercised.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type Database } from './db.js';
import {
  CEILING_ENV,
  DEFAULT_CEILING_USD,
  estimate,
  isPriced,
  reserve,
  resolveCeiling,
  settle,
  status,
  totals,
  voidByRef,
  voidEntry,
  voidOrphanedReservations,
} from './spend.js';

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const KLING = 'fal-ai/kling-video/o1/image-to-video';
const FLUX_INPAINT = 'fal-ai/flux-lora/inpainting';

// ── ceiling resolution ───────────────────────────────────────────────────

test('no authored ceiling falls back to the built-in default', () => {
  delete process.env[CEILING_ENV];
  const c = resolveCeiling(undefined);
  assert.equal(c.usd, DEFAULT_CEILING_USD);
  assert.equal(c.source, 'default');
});

test('project metadata beats the default', () => {
  delete process.env[CEILING_ENV];
  const c = resolveCeiling({ spend_ceiling_usd: 25 });
  assert.equal(c.usd, 25);
  assert.equal(c.source, 'project');
});

test('env beats project metadata (the operator on the machine wins)', () => {
  process.env[CEILING_ENV] = '5';
  const c = resolveCeiling({ spend_ceiling_usd: 25 });
  assert.equal(c.usd, 5);
  assert.equal(c.source, 'env');
  delete process.env[CEILING_ENV];
});

test('a garbage env value is ignored, NOT read as unbounded', () => {
  process.env[CEILING_ENV] = 'abc';
  const c = resolveCeiling({ spend_ceiling_usd: 25 });
  assert.equal(c.usd, 25);
  assert.equal(c.source, 'project');
  delete process.env[CEILING_ENV];
});

test('a ceiling of zero is honoured — "spend nothing" is a real setting', () => {
  delete process.env[CEILING_ENV];
  const c = resolveCeiling({ spend_ceiling_usd: 0 });
  assert.equal(c.usd, 0);
  assert.equal(c.source, 'project');
});

// ── pricing ──────────────────────────────────────────────────────────────

test('kling O1 prices per video-second at the invoice rate', () => {
  const e = estimate({ kind: 'render', model_id: KLING, durationMs: 5000 });
  assert.equal(e.usd, 0.56); // 5s × $0.112/s
});

test('flux inpaint rounds megapixels UP — 1280x704 (0.90 MP) bills as 1 MP', () => {
  const e = estimate({ kind: 'still', model_id: FLUX_INPAINT, resolution: { w: 1280, h: 704 } });
  assert.equal(e.usd, 0.035);
});

test('…and 1080p bills as 3 MP, triple the 720p rate, not 2.3x', () => {
  const e = estimate({ kind: 'still', model_id: FLUX_INPAINT, resolution: { w: 1920, h: 1080 } });
  assert.equal(e.usd, 0.105);
});

test('wan-vace carries its ~5s per-job minimum', () => {
  const e = estimate({
    kind: 'render',
    model_id: 'fal-ai/wan-vace-14b/inpainting',
    durationMs: 1000,
  });
  assert.equal(e.usd, 0.4); // billed to 5s, not 1s
  assert.match(e.basis, /minimum/);
});

test('an unpriced model is NOT free — it takes the conservative fallback', () => {
  const e = estimate({ kind: 'still', model_id: 'fal-ai/some-model-we-never-priced' });
  assert.ok(e.usd > 0, 'an unpriced model must never estimate at zero');
  assert.match(e.basis, /fallback/);
  assert.equal(isPriced('fal-ai/some-model-we-never-priced'), false);
  assert.equal(isPriced(KLING), true);
});

// ── ledger ───────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'studio-spend-test-'));
const db: Database = await openDb(join(dir, 'studio.db'));
const P = 'proj-forge';
const META = { spend_ceiling_usd: 25 };

test('a fresh project has committed nothing', () => {
  delete process.env[CEILING_ENV];
  const t = totals(db, P);
  assert.deepEqual(t, { settled_usd: 0, reserved_usd: 0, committed_usd: 0 });
});

test('a reservation counts against the ceiling IMMEDIATELY, before it settles', () => {
  const r = reserve(db, {
    projectId: P,
    refId: 'rec-1',
    kind: 'render',
    engine: 'fal',
    model_id: KLING,
    projectMetadata: META,
    durationMs: 5000,
  });
  assert.ok(r.ok);
  assert.equal(r.estimate_usd, 0.56);
  assert.equal(r.ceiling_usd, 25);
  assert.equal(r.ceiling_source, 'project');
  const t = totals(db, P);
  assert.equal(t.reserved_usd, 0.56);
  assert.equal(t.settled_usd, 0);
  assert.equal(t.committed_usd, 0.56, 'in-flight work must be visible to the ceiling');
});

test('settling with no provider cost KEEPS the estimate — it does not collapse to zero', () => {
  const before = totals(db, P);
  const entryId = (
    reserve(db, {
      projectId: P,
      refId: 'rec-2',
      kind: 'render',
      engine: 'fal',
      model_id: KLING,
      projectMetadata: META,
      durationMs: 5000,
    }) as { ok: true; entryId: string }
  ).entryId;
  settle(db, entryId, undefined); // fal reported nothing — the usual case
  const after = totals(db, P);
  assert.equal(after.settled_usd, 0.56, 'a settled entry with no reported cost holds its estimate');
  assert.equal(
    after.committed_usd,
    before.committed_usd + 0.56,
    'settling must not reduce committed spend',
  );
});

test('a real provider cost reconciles the entry to the invoice', () => {
  const entryId = (
    reserve(db, {
      projectId: P,
      refId: 'rec-3',
      kind: 'still',
      engine: 'fal',
      model_id: FLUX_INPAINT,
      projectMetadata: META,
      resolution: { w: 1280, h: 704 },
    }) as { ok: true; entryId: string }
  ).entryId;
  const before = totals(db, P).committed_usd;
  settle(db, entryId, 0.02); // cheaper than the 0.035 estimate
  const after = totals(db, P).committed_usd;
  assert.equal(Math.round((after - before) * 1e4) / 1e4, -0.015);
});

test('failed work gives its budget back', () => {
  const before = totals(db, P).committed_usd;
  const entryId = (
    reserve(db, {
      projectId: P,
      refId: 'rec-4',
      kind: 'render',
      engine: 'fal',
      model_id: KLING,
      projectMetadata: META,
      durationMs: 10000,
    }) as { ok: true; entryId: string }
  ).entryId;
  assert.equal(totals(db, P).committed_usd, Math.round((before + 1.12) * 1e4) / 1e4);
  voidEntry(db, entryId);
  assert.equal(totals(db, P).committed_usd, before);
});

test('voiding by ref releases a cancelled queued row that never reached the worker', () => {
  const before = totals(db, P).committed_usd;
  reserve(db, {
    projectId: P,
    refId: 'rec-5',
    kind: 'render',
    engine: 'fal',
    model_id: KLING,
    projectMetadata: META,
    durationMs: 5000,
  });
  assert.notEqual(totals(db, P).committed_usd, before);
  assert.equal(voidByRef(db, 'rec-5'), 1);
  assert.equal(totals(db, P).committed_usd, before);
});

test('a void cannot un-count money already settled', () => {
  const entryId = (
    reserve(db, {
      projectId: P,
      refId: 'rec-6',
      kind: 'still',
      engine: 'fal',
      model_id: FLUX_INPAINT,
      projectMetadata: META,
      resolution: { w: 1280, h: 704 },
    }) as { ok: true; entryId: string }
  ).entryId;
  settle(db, entryId, 0.035);
  const after = totals(db, P).committed_usd;
  voidEntry(db, entryId); // late void — must be a no-op
  assert.equal(totals(db, P).committed_usd, after);
});

test('the ceiling actually refuses, and the refusal explains itself', () => {
  const tight = { spend_ceiling_usd: 0.01 };
  const r = reserve(db, {
    projectId: 'proj-tight',
    refId: 'rec-x',
    kind: 'render',
    engine: 'fal',
    model_id: KLING,
    projectMetadata: tight,
    durationMs: 5000,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, 'spend-ceiling-exceeded');
  const msg = (r as { message: string }).message;
  assert.match(msg, /cannot be overridden/);
  assert.match(msg, new RegExp(CEILING_ENV));
  assert.match(msg, /spend_ceiling_usd/);
  // A refused call must leave NO ledger row — otherwise a loop of refusals
  // would silently inflate committed spend.
  assert.equal(totals(db, 'proj-tight').committed_usd, 0);
});

test('a batch is priced as a batch — shot N sees shots 1..N-1 already reserved', () => {
  const meta = { spend_ceiling_usd: 1.5 };
  const proj = 'proj-batch';
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 10; i++) {
    const r = reserve(db, {
      projectId: proj,
      refId: `batch-${i}`,
      kind: 'render',
      engine: 'fal',
      model_id: KLING,
      projectMetadata: meta,
      durationMs: 5000, // $0.56 each
    });
    if (r.ok) accepted += 1;
    else refused += 1;
  }
  // $0.56 × 2 = $1.12 fits under $1.50; the third would reach $1.68.
  assert.equal(accepted, 2);
  assert.equal(refused, 8);
  assert.equal(totals(db, proj).committed_usd, 1.12);
});

test('crash recovery voids reservations for rows that will be requeued', () => {
  const proj = 'proj-crash';
  db.prepare(
    `INSERT INTO render_queue (record_id, project_id, cell_id, engine, options, status, created_at)
     VALUES ('crash-1', ?, 'cell-1', 'fal', '{}', 'running', ?)`,
  ).run(proj, Date.now());
  reserve(db, {
    projectId: proj,
    refId: 'crash-1',
    kind: 'render',
    engine: 'fal',
    model_id: KLING,
    projectMetadata: META,
    durationMs: 5000,
  });
  assert.equal(totals(db, proj).committed_usd, 0.56);
  assert.equal(voidOrphanedReservations(db), 1);
  assert.equal(
    totals(db, proj).committed_usd,
    0,
    'a requeued render re-reserves; the stale entry must not double-count forever',
  );
});

test('status reports the ceiling, its source, and what is left', () => {
  delete process.env[CEILING_ENV];
  const s = status(db, P, META);
  assert.equal(s.ceiling_usd, 25);
  assert.equal(s.ceiling_source, 'project');
  assert.equal(s.committed_usd, s.settled_usd + s.reserved_usd);
  assert.equal(s.remaining_usd, Math.round((25 - s.committed_usd) * 1e4) / 1e4);
  assert.ok(s.entries.length > 0);
  assert.ok(s.entries.every((e) => e.project_id === P));
  // Every entry carries its derivation, so a refusal is auditable after the fact.
  assert.ok(s.entries.every((e) => typeof e.basis === 'string' && e.basis.length > 0));
});

db.close();
// Best-effort. On Windows the WAL/SHM sidecar files can still be held briefly
// after close(), and an EBUSY here would fail a suite whose assertions all
// passed — the temp dir is the OS's problem, not the test's.
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* leave it for the OS */
}

console.log(`\n${passed} passed`);
