// decisions/cli.ts: the conformed-views list always includes the skill's
// shipped list, and a missing --conformed file is a clear warning, not a crash
// (G-VIEW review C7).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConformedFile } from './conformed.ts';
import { conformedFrom } from './cli.ts';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const FX = join(SKILL, 'decisions', '__fixtures__');
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

describe('decisions/cli.ts conformed views', () => {
  const shipped = loadConformedFile(join(SKILL, 'views', 'conformed.json')).views;

  it('always includes the shipped list, plus the files given', () => {
    const w: string[] = [];
    const got = conformedFrom([join(FX, 'conformed.json')], undefined, w);
    assert.deepEqual(got.map((v) => v.view), [...shipped.map((v) => v.view), 'default-board@0.1']);
    assert.deepEqual(w, []);
  });

  it('a missing --conformed file is an empty list with a warning', () => {
    const w: string[] = [];
    const got = conformedFrom([join(FX, 'nope.json')], undefined, w);
    assert.deepEqual(got, shipped);
    assert.match(w[0] ?? '', /not found: treated as an empty list/);
  });

  it('a malformed file is a clear error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-cli-'));
    tmp.push(dir);
    writeFileSync(join(dir, 'bad.json'), '{"views": []}');
    assert.throws(() => conformedFrom([join(dir, 'bad.json')], undefined, []), /conformed-views file .*bad\.json: akuko: not a conformed-views file/);
  });

  it('fold-file with a missing --conformed runs, warns, and rejects the board approvals', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-cli-'));
    tmp.push(dir);
    const out = join(dir, 'folded.json');
    const stdout = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(SKILL, 'decisions', 'cli.ts'), 'fold-file',
      '--project', join(SKILL, 'fixtures', 'the-beating', 'akuko.json'), '--rows', join(FX, 'artifact-db-list.json'), '--conformed', join(dir, 'missing.json'), '--out', out],
      { timeout: 55_000 }, (e, o) => (e ? reject(e) : resolve(o))));
    const r = JSON.parse(stdout) as { warnings: string[]; report: { rejected: { code: string }[] } };
    assert.equal(r.warnings.length, 1);
    assert.ok(r.report.rejected.some((x) => x.code === 'view-not-conformed'));
    assert.ok(JSON.parse(readFileSync(out, 'utf8')).format === 'akuko');
  });
});
