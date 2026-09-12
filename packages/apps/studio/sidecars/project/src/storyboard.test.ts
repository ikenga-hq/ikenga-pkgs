// com.ikenga.studio project sidecar · storyboard.ts cell-content write-back
//
//   bun run src/storyboard.test.ts   (from sidecars/project/)
//   bun run test                      (package script — runs this + the others)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as registry.test.ts / session.test.ts: this file typechecks under the
// shared `tsc -p ../../tsconfig.json` project, which has no Bun types, while
// still running for real under the bun runtime (this sidecar's actual
// build/run target).
//
// G-48 (WP-32 closer) — the Cell editor's save-on-blur used to write only
// `last_edited` into storyboard.json; the edited HTML lived in an in-memory
// override that died on remount. `storyboard.writeCellContent` is the real
// write-back seam: it persists the FULL html to the cell's `content_path`
// atomically (tmp+rename), and does NOT also touch storyboard.json — so a
// content save is exactly one filesystem write.
//
// This test proves that end to end at the sidecar-RPC level, through the
// REAL project watcher (not a stub): write content → read it back off disk
// via the RPC → see exactly one `cells/changed` notification, not two. Two
// would mean either the content write wasn't atomic (the watcher caught a
// partial write) or writeCellContent is still mutating storyboard.json on
// the side (a second, redundant fs write firing a second event).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listCells, read, readCell, readCellContent, writeCellContent } from './storyboard.js';
import { startWatcher } from './watcher.js';
import { TOPIC_CELLS_CHANGED, type EventEnvelope } from './events.js';

const PROJECT_ID = 'proj-g48-fixture';
const CELL_UID = 'c1';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/** Poll until `events` has at least one entry, or give up after `maxMs`. The
 *  watcher's own 'ready' await plus its debounce window make a fixed sleep
 *  either flaky (too short) or slow (too long) — poll instead. */
async function waitForEvents(events: string[], maxMs: number): Promise<void> {
  const start = Date.now();
  while (events.length === 0 && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
  // One more debounce window's worth of grace so a second (unwanted) emit
  // that lands just after the first has a chance to show up before we count.
  await new Promise((r) => setTimeout(r, 150));
}

async function main(): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), 'studio-g48-'));
  const projectRoot = join(tmp, 'fixture-project');
  const cellDir = join(projectRoot, 'cells', 'hifi', CELL_UID);
  const contentPath = join(cellDir, 'content.html');

  mkdirSync(cellDir, { recursive: true });
  writeFileSync(
    join(projectRoot, 'storyboard.json'),
    JSON.stringify(
      {
        schema_version: 1,
        slug: 'fixture-project',
        title: 'G48 Fixture',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
        archetype_id: 'musicvideo',
        cells: [
          {
            uid: CELL_UID,
            beat_id: 'b.hook',
            rung: '2_hifi',
            index: 0,
            label: 'Hook',
            time: { start: 0, end: 0 },
            frames: { start: 0, end: 0 },
            content_path: 'cells/hifi/c1/content.html',
            rungs: {
              '0_beat_sheet': { status: 'pending' },
              '1_lofi': { status: 'pending' },
              '2_hifi': { status: 'pending' },
            },
            last_edited: '2026-08-01T00:00:00.000Z',
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const events: string[] = [];
  const handle = await startWatcher(PROJECT_ID, projectRoot, {
    debounceMs: 30,
    writer: (line) => events.push(line),
  });

  try {
    const html = '<!doctype html><html><body>edited via save-on-blur</body></html>';

    const writeResult = writeCellContent(projectRoot, CELL_UID, html).result as {
      ok: boolean;
      content_path: string;
      bytes: number;
    };

    test('write_cell_content reports ok + the content_path + byte count', () => {
      assert.equal(writeResult.ok, true);
      assert.equal(writeResult.content_path, 'cells/hifi/c1/content.html');
      assert.equal(writeResult.bytes, Buffer.byteLength(html, 'utf8'));
    });

    test('the FULL edited html landed on disk at content_path (no tmp file left behind)', () => {
      assert.equal(readFileSync(contentPath, 'utf8'), html);
    });

    test('read_cell_content (the RPC the editor reloads through) reads the same html back', () => {
      const readResult = readCellContent(projectRoot, CELL_UID).result as {
        ok: boolean;
        html: string;
        exists: boolean;
      };
      assert.equal(readResult.ok, true);
      assert.equal(readResult.exists, true);
      assert.equal(readResult.html, html);
    });

    await waitForEvents(events, 2000);

    test('exactly one cells/changed notification fired for the save (atomic write, no storyboard.json side-write)', () => {
      assert.equal(events.length, 1, `expected 1 event, got ${events.length}:\n${events.join('\n')}`);
      const env = JSON.parse(events[0]!) as EventEnvelope;
      assert.equal(env.method, 'event');
      assert.equal(env.params.topic, TOPIC_CELLS_CHANGED);
      assert.equal(env.params.projectId, PROJECT_ID);
      const payload = env.params.payload as { cellId: string; kind: string; path: string };
      assert.equal(payload.cellId, CELL_UID);
      assert.equal(payload.kind, 'created');
      assert.ok(payload.path.replace(/\\/g, '/').endsWith('cells/hifi/c1/content.html'));
    });

    // ── WP-32 / g58 — the READS carry the document they parsed ────────────
    //
    // index.ts's `syncOpenProject` needs something to sync FROM on a read, or
    // the exporter and render runner stay on a stale cache after an
    // out-of-band edit (the live export-order bug: the lane re-ordered, the
    // export did not). Every read that already re-reads storyboard.json must
    // hand that parse back — it is free, and it is the whole contract.
    const rotated = JSON.parse(readFileSync(join(projectRoot, 'storyboard.json'), 'utf8')) as {
      cells: Array<{ uid: string; index: number }>;
    };
    rotated.cells[0]!.index = 42;
    writeFileSync(
      join(projectRoot, 'storyboard.json'),
      JSON.stringify(rotated, null, 2) + '\n',
      'utf8',
    );

    test('storyboard.read returns the parsed project for the cache sync, reflecting the disk edit', () => {
      const r = read(projectRoot);
      assert.ok(r.project, 'read() must carry the project it parsed');
      assert.equal(r.project!.cells[0]!.index, 42);
    });

    test('storyboard.list_cells (the FE refetch path that used to skip the sync) carries it too', () => {
      const r = listCells(projectRoot);
      assert.ok(r.project, 'listCells() must carry the project it parsed');
      assert.equal(r.project!.cells[0]!.index, 42);
    });

    test('read_cell and read_cell_content carry it as well — on the hit AND the cell-not-found path', () => {
      const hit = readCell(projectRoot, CELL_UID);
      assert.ok(hit.project);
      assert.equal(hit.project!.cells[0]!.index, 42);

      const miss = readCell(projectRoot, 'no-such-cell');
      assert.equal((miss.result as { ok: boolean }).ok, false);
      assert.ok(miss.project, 'a cell-not-found read still parsed the document — sync from it');

      const content = readCellContent(projectRoot, CELL_UID);
      assert.ok(content.project);
      assert.equal(content.project!.cells[0]!.index, 42);
    });

    console.log(`\n${passed} passed`);
    return 0;
  } finally {
    await handle.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(await main());
