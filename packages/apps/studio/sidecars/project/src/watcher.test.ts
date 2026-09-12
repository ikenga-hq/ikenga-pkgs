// com.ikenga.studio project sidecar · out-of-band storyboard.json edits keep
// the open-project cache coherent (WP-32 / g58)
//
//   bun run src/watcher.test.ts   (from sidecars/project/)
//   bun run test                   (package script — runs this + the others)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as storyboard.test.ts / chrome.test.ts: typechecks under the shared
// `tsc -p ../../tsconfig.json` project (no Bun types) while running for real
// under the bun runtime.
//
// ── What the live round found (verify/2026-09-12-wp32-live/g58) ────────────
// `Cell.index` was rotated directly in a live project's storyboard.json. The
// lane re-ordered in the UI within ~3 s (WP-26's disk-edit push working as
// designed) — and an export two and a half minutes later cut the OLD order,
// silently. Cause: the exporter and the render runner read the sidecar's
// in-memory open-project record (`open.get(id).project`), which was refreshed
// only by the twelve *mutating* RPC cases. `storyboard.list_cells` — the FE's
// refetch path — re-read the file but never synced the cache, and the FS
// watcher emitted `cells/changed` without re-hydrating anything. So a disk
// edit updated every disk-going reader and no cache-going reader.
//
// Two halves are proven here:
//
//   PART A (unit) — watcher.ts now calls `onProjectDocChanged` exactly when
//   storyboard.json itself changed, once per flush, BEFORE the cells/changed
//   emits, and a throwing hook cannot cost us the emits.
//
//   PART B (end-to-end) — a REAL sidecar child process, a real project on
//   disk, a real out-of-band write. The probe is `composition.validate`,
//   which resolves its cell through `ProjectLookup.cell` — i.e. the CACHE,
//   the same reader the exporter and the render runner use. A cell that
//   exists only after the out-of-band write must become visible to it with
//   no mutating RPC in between. Before the fix this probe returns
//   `cell-not-found` forever (that is exactly the export-order bug, minus the
//   ffmpeg); the negative control below is that same call before the write.
//   `composition.validate` proves cell MEMBERSHIP, not ordering, and the
//   live symptom was an export that cut the OLD ORDER — so Part B then runs
//   `export.davinci_timeline`, which reads `open.get(id).project` and writes
//   one spine element per cell in the cached document's order. That FCPXML is
//   the only assertion here that can see a re-hydration which restored the
//   wrong order (`storyboard.read` cannot: it re-parses the file).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startWatcher, PROJECT_DOC_CELL_ID } from './watcher.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_ENTRY = join(HERE, 'index.ts');

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

interface CellFixture {
  uid: string;
  index: number;
  rungDirName?: string;
}

function projectDoc(cells: CellFixture[]): string {
  return (
    JSON.stringify(
      {
        schema_version: 1,
        slug: 'g58-fixture',
        title: 'G58 Cache Coherence Fixture',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        archetype_id: 'musicvideo',
        aspect_ratio: '16:9',
        cells: cells.map((c) => ({
          uid: c.uid,
          beat_id: 'b.hook',
          rung: '2_hifi',
          index: c.index,
          label: c.uid,
          time: { start: 0, end: 0 },
          frames: { start: 0, end: 0 },
          content_path: `cells/hifi/${c.uid}/index.html`,
          rungs: {
            '0_beat_sheet': { status: 'pending' },
            '1_lofi': { status: 'pending' },
            '2_hifi': { status: 'pending' },
          },
          last_edited: '2026-09-01T00:00:00.000Z',
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/** Write a project skeleton with `cells` at `root` (cell HTML included). */
function seedProject(root: string, cells: CellFixture[]): void {
  for (const sub of ['cells', 'anchors', 'blocks', 'archetypes', 'renders', 'exports']) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  for (const c of cells) {
    const dir = join(root, 'cells', 'hifi', c.uid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html data-width="1920" data-height="1080"><body><div>x</div></body></html>',
      'utf8',
    );
  }
  writeFileSync(join(root, 'storyboard.json'), projectDoc(cells), 'utf8');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns true, or give up after `maxMs`. */
async function until(fn: () => boolean, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

// ─────────────────────────────────────────────────────────────────────────
// PART A — the watcher hook
// ─────────────────────────────────────────────────────────────────────────

async function partA(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'studio-g58-watcher-'));
  const root = join(tmp, 'fixture-project');
  mkdirSync(root, { recursive: true });
  seedProject(root, [{ uid: 'c1', index: 0 }]);

  const events: string[] = [];
  const hookCalls: string[] = [];
  const handle = await startWatcher('proj-g58', root, {
    debounceMs: 30,
    writer: (line) => events.push(line),
    onProjectDocChanged: (p) => hookCalls.push(p),
  });

  try {
    // ── storyboard.json edited out of band ────────────────────────────────
    writeFileSync(join(root, 'storyboard.json'), projectDoc([{ uid: 'c1', index: 7 }]), 'utf8');
    await until(() => hookCalls.length > 0, 3000);
    await sleep(150); // one more debounce window: catch a second, unwanted call

    test('onProjectDocChanged fires for an out-of-band storyboard.json write', () => {
      assert.equal(hookCalls.length, 1, `expected 1 hook call, got ${hookCalls.length}`);
      assert.ok(
        hookCalls[0]!.replace(/\\/g, '/').endsWith('storyboard.json'),
        `hook got the wrong path: ${hookCalls[0]}`,
      );
    });

    test('the cells/changed emit still went out alongside it (the hook does not swallow events)', () => {
      assert.ok(events.length >= 1, 'expected at least one cells/changed line');
      const payloads = events.map((e) => JSON.parse(e) as { params: { payload: { cellId: string } } });
      assert.ok(
        payloads.some((p) => p.params.payload.cellId === PROJECT_DOC_CELL_ID),
        `no ${PROJECT_DOC_CELL_ID} emit in:\n${events.join('\n')}`,
      );
    });

    // ── a cells/** change must NOT trigger a project re-read ──────────────
    hookCalls.length = 0;
    events.length = 0;
    writeFileSync(join(root, 'cells', 'hifi', 'c1', 'index.html'), '<!doctype html><body>e</body>', 'utf8');
    await until(() => events.length > 0, 3000);
    await sleep(150);

    test('a cell-content change does NOT fire onProjectDocChanged (no pointless re-read/re-validate)', () => {
      assert.ok(events.length >= 1, 'expected the content change to still emit');
      assert.equal(hookCalls.length, 0, `hook fired ${hookCalls.length}× for a cells/** change`);
    });
  } finally {
    await handle.close();
  }

  // ── a throwing hook must not cost us the emit ──────────────────────────
  const root2 = join(tmp, 'fixture-project-2');
  mkdirSync(root2, { recursive: true });
  seedProject(root2, [{ uid: 'c1', index: 0 }]);
  const events2: string[] = [];
  const handle2 = await startWatcher('proj-g58-b', root2, {
    debounceMs: 30,
    writer: (line) => events2.push(line),
    onProjectDocChanged: () => {
      throw new Error('deliberate hook failure');
    },
  });
  try {
    writeFileSync(join(root2, 'storyboard.json'), projectDoc([{ uid: 'c1', index: 3 }]), 'utf8');
    await until(() => events2.length > 0, 3000);
    await testAsync('a throwing onProjectDocChanged still lets cells/changed through', async () => {
      assert.ok(events2.length >= 1, 'a hook throw suppressed the notification');
    });
  } finally {
    await handle2.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PART B — end-to-end through a real sidecar process
// ─────────────────────────────────────────────────────────────────────────

async function partB(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'studio-g58-e2e-'));
  const root = join(tmp, 'wp32-cache-project');
  const pkgData = join(tmp, 'pkg-data');
  mkdirSync(root, { recursive: true });
  mkdirSync(pkgData, { recursive: true });
  seedProject(root, [{ uid: 'c1', index: 0 }]);

  const child = spawn('bun', ['run', SIDECAR_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IKENGA_PKG_DATA: pkgData,
      STUDIO_TRUST_STUB: '1',
    },
  });

  const stderrLines: string[] = [];
  child.stderr!.on('data', (b: Buffer) => {
    stderrLines.push(b.toString('utf8'));
    if (stderrLines.length > 200) stderrLines.shift();
  });

  const rl = createInterface({ input: child.stdout! });
  const waiters = new Map<number, (v: Record<string, unknown>) => void>();
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // not a JSON-RPC line (shouldn't happen on stdout, but be safe)
    }
    const id = parsed.id as number | undefined;
    if (id === undefined) return; // an event notification — not our business here
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      waiter(parsed);
    }
  });

  let nextId = 1;
  function send(method: string, params?: unknown, timeoutMs = 20000): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        rejectPromise(
          new Error(`timed out waiting for ${method}\nsidecar stderr:\n${stderrLines.join('')}`),
        );
      }, timeoutMs);
      waiters.set(id, (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** The cache-going probe: composition.validate resolves its cell through
   *  ProjectLookup.cell — the exporter/render-runner's reader, not the disk. */
  async function validateViaCache(
    projectId: string,
    cellId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const resp = await send('composition.validate', { projectId, cellId });
    return (resp.result ?? {}) as { ok: boolean; error?: string };
  }

  try {
    const openResp = await send('project.open', { path: root });
    const openResult = openResp.result as { ok: boolean; projectId?: string; error?: string };
    assert.equal(
      openResult.ok,
      true,
      `project.open failed: ${JSON.stringify(openResult)}\nsidecar stderr:\n${stderrLines.join('')}`,
    );
    const projectId = openResult.projectId!;
    passed += 1;
    console.log('  ok - project.open succeeded against the fixture project');

    // ── negative control ──────────────────────────────────────────────────
    const before = await validateViaCache(projectId, 'c2');
    test('negative control: the not-yet-existing cell is invisible to the cache reader', () => {
      assert.equal(before.ok, false);
      assert.equal(before.error, 'cell-not-found');
    });

    // ── the out-of-band edit: c2 appended, c1 re-indexed, no RPC involved ──
    const c2Dir = join(root, 'cells', 'hifi', 'c2');
    mkdirSync(c2Dir, { recursive: true });
    writeFileSync(
      join(c2Dir, 'index.html'),
      '<!doctype html><html data-width="1920" data-height="1080"><body><div>c2</div></body></html>',
      'utf8',
    );
    writeFileSync(
      join(root, 'storyboard.json'),
      projectDoc([
        { uid: 'c2', index: 0 },
        { uid: 'c1', index: 1 },
      ]),
      'utf8',
    );

    let after: { ok: boolean; error?: string } = { ok: false };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      after = await validateViaCache(projectId, 'c2');
      if (after.ok) break;
      await sleep(100);
    }

    test('the watcher re-hydrated the cache: the disk-only cell is now visible to the exporter/render-runner reader', () => {
      assert.equal(
        after.ok,
        true,
        `cache never caught up with the out-of-band write: ${JSON.stringify(after)}\n` +
          `sidecar stderr:\n${stderrLines.join('')}`,
      );
    });

    // ── disk-going sanity check (NOT a cache assertion) ───────────────────
    // storyboard.read re-parses the file, so this passes with or without the
    // cache sync — it is here only to prove the fixture write itself landed.
    // The cache-going order assertion is the next test.
    const readResp = await send('storyboard.read', { projectId });
    const readResult = readResp.result as {
      ok: boolean;
      project: { cells: Array<{ uid: string; index: number }> };
    };
    test('the document on DISK carries the new lane order (fixture sanity — a fresh parse, not the cache)', () => {
      assert.equal(readResult.ok, true);
      const byUid = new Map(readResult.project.cells.map((c) => [c.uid, c.index]));
      assert.equal(byUid.get('c2'), 0);
      assert.equal(byUid.get('c1'), 1);
    });

    // ── the ORDER the EXPORTER would cut, read through the cache ──────────
    // This is the actual g58 symptom: the lane re-ordered in the UI while an
    // export 2.5 min later cut the OLD order. `export.davinci_timeline`
    // (index.ts) reads `open.get(projectId).project` directly and emits one
    // spine element per cell in the cached document's order, so the FCPXML it
    // writes IS the cache's cell order. With the syncOpenProject/watcher
    // wiring reverted, the cached document still has c1 only and c2 never
    // appears at all.
    const xmlPath = join(tmp, 'g58-order.fcpxml');
    const exportResp = await send('export.davinci_timeline', {
      projectId,
      outputPath: xmlPath,
      enableBeatSync: false,
    });
    const exportResult = exportResp.result as { ok: boolean; outputPath?: string; error?: string };
    const xml = exportResult.ok && existsSync(xmlPath) ? readFileSync(xmlPath, 'utf8') : '';
    test('the exporter cuts the NEW order (cache-going reader: c2 before c1 in the timeline)', () => {
      assert.equal(
        exportResult.ok,
        true,
        `export.davinci_timeline failed: ${JSON.stringify(exportResult)}\n` +
          `sidecar stderr:\n${stderrLines.join('')}`,
      );
      // Unrendered cells become <gap name="Gap <uid>"> in the spine; a
      // rendered one would be an <asset-clip name="<uid>">. Either way the
      // uid appears once, in cell order — match the name attribute rather
      // than a bare substring so nothing else in the document can satisfy it.
      const spineIndexOf = (uid: string): number => {
        const m = new RegExp(`name="(?:Gap )?${uid}"`).exec(xml);
        return m ? m.index : -1;
      };
      const iC2 = spineIndexOf('c2');
      const iC1 = spineIndexOf('c1');
      assert.ok(iC2 >= 0, `c2 missing from the exported timeline — stale cache:\n${xml}`);
      assert.ok(iC1 >= 0, `c1 missing from the exported timeline:\n${xml}`);
      assert.ok(iC2 < iC1, `exporter cut the OLD order (c1 before c2):\n${xml}`);
    });

    // ── an unparseable document must not blank the cache ──────────────────
    writeFileSync(join(root, 'storyboard.json'), '{ this is not json', 'utf8');
    await sleep(1200); // let the watcher fire + the re-read fail
    const afterGarbage = await validateViaCache(projectId, 'c2');
    test('a half-written / invalid storyboard.json leaves the last good document in the cache', () => {
      assert.equal(
        afterGarbage.ok,
        true,
        `invalid document blanked the cache: ${JSON.stringify(afterGarbage)}`,
      );
    });
  } finally {
    rl.close();
    // Let the child actually exit before deleting the tree: on Windows its
    // chokidar handles keep the project dir busy (EBUSY on rm) for a beat
    // after kill(). Cleanup is best-effort — the temp dir is disposable and a
    // leftover must never fail an otherwise-passing suite.
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    await Promise.race([exited, sleep(2000)]);
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
}

async function main(): Promise<number> {
  await partA();
  await partB();
  console.log(`\n${passed} passed`);
  return 0;
}

process.exit(await main());
