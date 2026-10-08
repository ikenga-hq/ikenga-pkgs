import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The suite leaves nothing behind. Every other test file is run once, in a child process whose temp directory
 * (`TMPDIR`) is a fresh private one, and when it is done that directory must hold no `mm-*` directory. Counting
 * `/tmp/mm-*` before and after in the shared `/tmp` would also count a concurrent run's directories; a private
 * `TMPDIR` counts exactly this run's.
 */
describe('test hygiene', () => {
  it('a full run of every other test file leaves no mm-* temp directory behind', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here)
      .filter((f) => f.endsWith('.test.ts') && f !== 'hygiene.test.ts')
      .map((f) => path.join(here, f));
    assert.ok(files.length >= 5, 'found the other test files');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mm-hygiene-root-'));
    try {
      const before = readdirSync(tmp).filter((n) => n.startsWith('mm-'));
      assert.deepEqual(before, []);
      const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
        const c = spawn(process.execPath, ['--test', '--import=tsx', ...files], { cwd: path.join(here, '..'), env: { ...process.env, TMPDIR: tmp } });
        let text = '';
        c.stdout.on('data', (d) => (text += d));
        c.stderr.on('data', (d) => (text += d));
        c.on('close', (code) => resolve({ code, text }));
      });
      assert.equal(out.code, 0, out.text.slice(-3000));
      const after = readdirSync(tmp).filter((n) => n.startsWith('mm-'));
      assert.deepEqual(after, [], `leaked ${after.length} temp director${after.length === 1 ? 'y' : 'ies'}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
