// WP-24c — check-view and units removed from the shot list.
//
// A view shows no Approve control for a pending unit whose row left the sheet
// (default-board@0.3 puts it in a collapsed "Removed from the sheet" group).
// check-view must not demand one, but must still demand one for a live unit.
// The view here is the minimal board with its asset Approve button taken out,
// so "no control" is under the test's control, whatever the project says.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(SKILL, 'scripts', 'check-view.mjs');
const dir = mkdtempSync(join(tmpdir(), 'akuko-cv-removed-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const MARK = "(a.status === 'pending-review' ? '<button type=\"button\" data-akuko-action=\"approve\"";
const noAssetControls = readFileSync(join(SKILL, 'views', '__fixtures__', 'tiny-board.html'), 'utf8').replace(MARK, "(false ? '<button type=\"button\" data-akuko-action=\"approve\"");
const view = join(dir, 'no-asset-controls.html');
writeFileSync(view, noAssetControls);

/** The short-story project with exactly one asset waiting for review, live or removed. */
function project(removed: boolean): string {
  const p = JSON.parse(readFileSync(join(SKILL, 'fixtures', 'the-beating', 'akuko.json'), 'utf8'));
  for (const a of p.assets) a.status = 'approved';
  const a = p.assets[0];
  a.status = 'pending-review';
  if (removed) a.source = { kind: 'sheet', id: 'ZZ-001', removed_at: '2026-11-10T07:00:00Z' };
  const f = join(dir, removed ? 'removed.json' : 'live.json');
  writeFileSync(f, JSON.stringify(p));
  return f;
}

function check(file: string): Promise<{ ok: boolean; codes: string[] }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, view, '--project', file, '--json'], { cwd: SKILL, timeout: 480_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      const r = JSON.parse(stdout)[0] as { ok: boolean; failures: { code: string }[] };
      resolve({ ok: r.ok, codes: r.failures.map((f) => f.code) });
    });
  });
}

describe('check-view and removed units', () => {
  it('the test view really has no asset Approve control', () => {
    assert.notEqual(noAssetControls, readFileSync(join(SKILL, 'views', '__fixtures__', 'tiny-board.html'), 'utf8'));
  });

  it('a removed pending asset needs no Approve control; a live one still does', { timeout: 900_000 }, async () => {
    const [gone, live] = await Promise.all([check(project(true)), check(project(false))]);
    assert.deepEqual(gone, { ok: true, codes: [] }, 'a removed pending asset is not asked for a control');
    assert.equal(live.ok, false);
    assert.ok(live.codes.includes('missing-control'), `a live pending asset with no control fails: ${live.codes.join(',')}`);
  });
});
