// com.ikenga.studio · Composition format helpers — banner count derivation (G-106)
//
//   bun run src/studio/views/composition/format.test.ts   (from packages/apps/studio/)
//
// Plain assert-based script (no bun:test / node:test import) so it typechecks
// under `tsc -p tsconfig.web.json` alongside the rest of `src/`, same pattern
// as `lib/canvas-links.test.ts`. Everything under test is a pure function.
//
// G-106 (live-found 2026-09-12, `plans/studio/verify/2026-09-12-wp32-live/`):
// the Composition "N / M rendered" banner was built on `recordByUid`, which
// picks the BEST-EVER status per cell (done > running > queued > failed) —
// exactly right for the filmstrip poster / byte-playback (they want the best
// mp4 on hand, even a stale one), exactly wrong for a banner labelled
// "rendered": a cell that failed after once succeeding still counted as
// rendered, and the banner could never show a failure at all. These tests
// pin `latestRecordByUid` (recency-only, every status) and `renderCounts`
// (the banner's actual derivation) against that regression, and pin that
// `recordByUid` itself is UNCHANGED — the filmstrip/poster pick keeps its
// best-ever-status semantic.

import assert from 'node:assert/strict';

import type { RenderRecord } from '../../mcp-types';
import { latestRecordByUid, recordByUid, renderCounts } from './format';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Minimal RenderRecord fixture — only the fields these helpers read, cast the
 *  same way `canvas-model.ts`'s `buildNewLaneCell` casts its own fixtures. */
function rec(
  cellUid: string,
  status: RenderRecord['status'],
  opts: { id?: string; startedAt?: string; finishedAt?: string } = {},
): RenderRecord {
  return {
    id: opts.id ?? `${cellUid}-${status}-${opts.finishedAt ?? opts.startedAt ?? 'x'}`,
    cell_uid: cellUid,
    engine: 'hyperframes',
    status,
    ...(opts.startedAt ? { started_at: opts.startedAt } : {}),
    ...(opts.finishedAt ? { finished_at: opts.finishedAt } : {}),
  } as unknown as RenderRecord;
}

// ── latestRecordByUid ────────────────────────────────────────────────────

test('latestRecordByUid: a later failed record beats an earlier done one (the G-106 regression)', () => {
  const records = [
    rec('cellA', 'done', { finishedAt: '2026-09-12T10:00:00.000Z' }),
    rec('cellA', 'failed', { finishedAt: '2026-09-12T10:05:00.000Z' }),
  ];
  const latest = latestRecordByUid(records);
  assert.equal(latest.cellA.status, 'failed');

  // recordByUid (unchanged, best-ever-status) still reports the OLD done
  // record for the exact same input — the contrast the fix is about.
  const best = recordByUid(records);
  assert.equal(best.cellA.status, 'done');
});

test('latestRecordByUid: an earlier failed record loses to a later done one', () => {
  const records = [
    rec('cellA', 'failed', { finishedAt: '2026-09-12T10:00:00.000Z' }),
    rec('cellA', 'done', { finishedAt: '2026-09-12T10:05:00.000Z' }),
  ];
  assert.equal(latestRecordByUid(records).cellA.status, 'done');
});

test('latestRecordByUid: falls back to started_at when finished_at is absent (a running/queued row)', () => {
  const records = [
    rec('cellA', 'done', { finishedAt: '2026-09-12T10:00:00.000Z' }),
    rec('cellA', 'running', { startedAt: '2026-09-12T10:05:00.000Z' }),
  ];
  assert.equal(latestRecordByUid(records).cellA.status, 'running');
});

test('latestRecordByUid: ties (or unparseable timestamps) resolve to the later list position', () => {
  const records = [
    rec('cellA', 'done', { id: 'first' }),
    rec('cellA', 'failed', { id: 'second' }),
  ];
  assert.equal(latestRecordByUid(records).cellA.id, 'second');
});

test('latestRecordByUid: ignores records with no cell_uid', () => {
  const bad = { id: 'x', status: 'done' } as unknown as RenderRecord;
  const good = rec('cellA', 'failed', { finishedAt: '2026-09-12T10:00:00.000Z' });
  assert.deepEqual(latestRecordByUid([bad, good]), { cellA: good });
});

test('latestRecordByUid: independent per cell', () => {
  const records = [
    rec('cellA', 'done', { finishedAt: '2026-09-12T10:00:00.000Z' }),
    rec('cellB', 'failed', { finishedAt: '2026-09-12T09:00:00.000Z' }),
  ];
  const latest = latestRecordByUid(records);
  assert.equal(latest.cellA.status, 'done');
  assert.equal(latest.cellB.status, 'failed');
});

// ── renderCounts (the banner's actual derivation) ────────────────────────

test('renderCounts: a cell that failed after once succeeding counts as failed, not rendered', () => {
  const records = [
    rec('cellA', 'done', { finishedAt: '2026-09-12T10:00:00.000Z' }),
    rec('cellA', 'failed', { finishedAt: '2026-09-12T10:05:00.000Z' }),
  ];
  const clips = [{ uid: 'cellA' }];
  const counts = renderCounts(clips, latestRecordByUid(records));
  assert.deepEqual(counts, { rendered: 0, failed: 1, total: 1 });
});

test('renderCounts: shows a non-zero failed count alongside a rendered count (the live-found disagreement)', () => {
  // The exact live shape from g49/dom-t+30s.txt: 1 done, 1 running, 1 queued,
  // 1 failed, 1 with no record at all yet (falls back to clip.status).
  const records = [
    rec('done1', 'done', { finishedAt: '2026-09-12T10:00:00.000Z' }),
    rec('running1', 'running', { startedAt: '2026-09-12T10:00:00.000Z' }),
    rec('queued1', 'queued'),
    rec('failed1', 'failed', { finishedAt: '2026-09-12T10:00:00.000Z' }),
  ];
  const clips = [
    { uid: 'done1' },
    { uid: 'running1' },
    { uid: 'queued1' },
    { uid: 'failed1' },
    { uid: 'norecord1', status: 'queued' as const },
  ];
  const counts = renderCounts(clips, latestRecordByUid(records));
  assert.deepEqual(counts, { rendered: 1, failed: 1, total: 5 });
});

test('renderCounts: falls back to clip.status only when the cell has no render record at all', () => {
  const clips = [{ uid: 'cellA', status: 'done' as const }, { uid: 'cellB', status: 'failed' as const }];
  const counts = renderCounts(clips, {});
  assert.deepEqual(counts, { rendered: 1, failed: 1, total: 2 });
});

test('renderCounts: fully rendered when every cell\'s latest attempt is done', () => {
  const records = [
    rec('a', 'done', { finishedAt: '2026-09-12T10:00:00.000Z' }),
    rec('b', 'done', { finishedAt: '2026-09-12T10:00:00.000Z' }),
  ];
  const clips = [{ uid: 'a' }, { uid: 'b' }];
  const counts = renderCounts(clips, latestRecordByUid(records));
  assert.deepEqual(counts, { rendered: 2, failed: 0, total: 2 });
});

console.log(`\n${passed} passed`);
