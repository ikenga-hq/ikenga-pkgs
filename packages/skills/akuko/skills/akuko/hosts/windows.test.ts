// akuko — Windows file-system behaviour of the local host (Wave 3
// second-opinion review, findings 5 and 6), and the line endings a Windows
// checkout gets (finding 7). The assertions hold on every OS; on Windows they
// exercise the real failure (a rename over an open file is refused there).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LocalHost, renameWithRetry, writeFileAtomic } from './local.ts';
import { safeBasename } from './shared.ts';

const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'akuko-win-')); tmp.push(d); return d; };
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('writeFileAtomic: the target is open in another program (finding 5)', () => {
  it('waits for a handle that is released, then replaces the file', async () => {
    const dir = tmpDir();
    const target = join(dir, 'akuko.json');
    writeFileSync(target, 'old\n');
    const fd = openSync(target, 'r'); // on Windows this alone makes rename() fail with EPERM
    const release = setTimeout(() => closeSync(fd), 150);
    try {
      await writeFileAtomic(target, 'new\n');
    } finally {
      clearTimeout(release);
      try { closeSync(fd); } catch { /* already closed */ }
    }
    assert.equal(readFileSync(target, 'utf8'), 'new\n');
    assert.deepEqual(leftovers(dir), []);
  });

  it('a handle that stays open: fails clearly, leaves the file as it was and no temp file', { skip: process.platform !== 'win32' && 'Windows only: elsewhere rename over an open file succeeds' }, async () => {
    const dir = tmpDir();
    const target = join(dir, 'akuko.json');
    writeFileSync(target, 'old\n');
    const fd = openSync(target, 'r');
    try {
      await assert.rejects(writeFileAtomic(target, 'new\n', { backoff: [5, 5] }), /could not replace .*akuko\.json: another program has it open \((EPERM|EBUSY|EACCES)\)/);
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(target, 'utf8'), 'old\n');
    assert.deepEqual(leftovers(dir), []);
  });

  it('retries EPERM, EBUSY and EACCES with a bounded backoff, then names the file and the code', async () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      let calls = 0;
      await assert.rejects(
        renameWithRetry('a.tmp', 'akuko.json', { backoff: [1, 1, 1], rename: async () => { calls++; throw errno(code); } }),
        (e: NodeJS.ErrnoException) => e.code === code && e.message.includes(`could not replace akuko.json: another program has it open (${code})`),
      );
      assert.equal(calls, 4, `${code}: one try plus one per wait`);
    }
    let n = 0;
    await renameWithRetry('a.tmp', 'b', { backoff: [1, 1, 1], rename: async () => { if (++n < 3) throw errno('EBUSY'); } });
    assert.equal(n, 3, 'succeeds as soon as the target is free');
  });

  it('any other error is thrown at once', async () => {
    let calls = 0;
    await assert.rejects(renameWithRetry('a', 'b', { rename: async () => { calls++; throw errno('ENOSPC'); } }), /ENOSPC/);
    assert.equal(calls, 1);
  });
});

describe('safeBasename: Windows device names and trailing dots (finding 6)', () => {
  it('a device name as the stem, any case, any extension, gets a "_"', () => {
    const cases: [string, string][] = [
      ['con.png', 'con_.png'], ['CON', 'CON_'], ['aux.svg', 'aux_.svg'], ['Nul.json', 'Nul_.json'], ['prn', 'prn_'],
      ['com1.png', 'com1_.png'], ['COM9', 'COM9_'], ['lpt1.tar.gz', 'lpt1_.tar.gz'], ['LPT9.txt', 'LPT9_.txt'], ['com0.png', 'com0_.png'],
      ['refs/aux.svg', 'aux_.svg'], ['C:\\x\\nul.png', 'nul_.png'],
    ];
    for (const [input, want] of cases) assert.equal(safeBasename(input), want, input);
  });

  it('names that only look like one are kept', () => {
    for (const ok of ['console.png', 'conx.png', 'auxiliary.svg', 'com10.png', 'lpt.png', 'nullable.json', 'icon.png', 'a.con', 'my-aux.svg']) {
      assert.equal(safeBasename(ok), ok, ok);
    }
  });

  it('trailing dots go (Windows drops them, so the file would not match its uri); empty becomes "asset"', () => {
    assert.equal(safeBasename('clip.'), 'clip');
    assert.equal(safeBasename('a..'), 'a');
    assert.equal(safeBasename('take 1 .'), 'take-1-');
    assert.equal(safeBasename('...'), 'asset');
    assert.equal(safeBasename('con.'), 'con_');
  });

  it('storeAsset and publishView write the safe name', async () => {
    const dir = tmpDir();
    const host = new LocalHost({ projectDir: dir });
    const a = await host.storeAsset({ kind: 'other', filename: 'aux.svg', mime: 'image/svg+xml', data: new Uint8Array([60, 115, 118, 103, 47, 62]) });
    assert.equal(a.file?.uri, 'refs/aux_.svg');
    assert.equal(a.id, 'aux_');
    assert.ok(existsSync(join(dir, 'refs', 'aux_.svg')));
    const v = await host.publishView({ name: 'con', html: '<!doctype html><title>x</title><p>read only</p>' });
    assert.equal(v.path, join(dir, 'views', 'con_.html'));
  });
});

describe('line endings a Windows checkout gets (finding 7)', () => {
  // `core.autocrlf=true` (the Windows default) turns LF into CRLF on checkout
  // unless .gitattributes says otherwise. bash cannot run a CRLF doctor.sh, and
  // a CRLF copy of a shipped view no longer matches its conformance hash, so
  // publishView refuses akuko's own board.
  const pkg = fileURLToPath(new URL('../../..', import.meta.url));
  const inGit = (() => { try { execFileSync('git', ['-C', pkg, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); return true; } catch { return false; } })();

  it('every text file in the package checks out LF, whatever core.autocrlf is', { skip: !inGit && 'not a git checkout' }, () => {
    const files = ['skills/akuko/scripts/doctor.sh', 'skills/akuko/views/default-board.html', 'skills/akuko/views/conformed.json', 'skills/akuko/scripts/check-view.mjs', 'skills/akuko/SKILL.md'];
    const out = execFileSync('git', ['-C', pkg, 'check-attr', 'eol', '--', ...files], { encoding: 'utf8' });
    for (const f of files) assert.match(out, new RegExp(`${f.replace(/[.]/g, '\\.')}: eol: lf`), f);
  });
});
