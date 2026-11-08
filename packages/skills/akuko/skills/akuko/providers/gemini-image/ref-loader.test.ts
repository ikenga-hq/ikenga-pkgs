// Reference loading resolves project-relative uris against the project folder, not the process cwd.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { defaultRefLoader } from './image-common.ts';
import { PNG_B64, PNG_BYTES, REF_URI } from './__fixtures__/mock-net.ts';

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-ref-'));
  await mkdir(join(dir, 'bible', 'style'), { recursive: true });
  await writeFile(join(dir, 'bible', 'style', 'look.png'), PNG_BYTES);
  await writeFile(join(dir, '..', `akuko-ref-outside.png`), PNG_BYTES);
  return dir;
}

describe('defaultRefLoader with a project folder', () => {
  it('reads a relative uri from the project folder whatever the cwd is', async () => {
    const dir = await project();
    const elsewhere = await mkdtemp(join(tmpdir(), 'akuko-cwd-'));
    const before = process.cwd();
    try {
      process.chdir(elsewhere);
      const got = await defaultRefLoader(undefined, dir)('bible/style/look.png');
      assert.equal(got.mime, 'image/png');
      assert.deepEqual([...got.data], [...PNG_BYTES]);
      await assert.rejects(defaultRefLoader()('bible/style/look.png'), { code: 'ENOENT' }, 'without a base the cwd is used, as before');
    } finally {
      process.chdir(before);
    }
  });

  it('refuses a uri that escapes the project folder', async () => {
    const dir = await project();
    const load = defaultRefLoader(undefined, dir);
    // ../akuko-ref-outside.png exists next to the project folder; it must still be refused
    await assert.rejects(load('../akuko-ref-outside.png'), /outside the project folder/);
    await assert.rejects(load('bible/../../akuko-ref-outside.png'), /outside the project folder/);
  });

  it('absolute, file:, data: and https: uris behave as before', async () => {
    const dir = await project();
    const abs = join(dir, 'bible', 'style', 'look.png');
    const other = await mkdtemp(join(tmpdir(), 'akuko-base-'));
    const load = defaultRefLoader(async () => new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }), other);
    assert.equal((await load(resolve(abs))).data.length, PNG_BYTES.length);
    assert.equal((await load(pathToFileURL(abs).href)).data.length, PNG_BYTES.length);
    assert.equal(Buffer.from((await load(REF_URI)).data).toString('base64'), PNG_B64);
    assert.equal((await load('https://example.test/a.png')).mime, 'image/png');
  });
});
