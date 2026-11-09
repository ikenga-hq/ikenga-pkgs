// views/publish.ts: embeds the current akuko.json in the default board and publishes it through the local host.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findJsonBlock, PROJECT_BLOCK } from '../scripts/check-view/hash.mjs';
import { conformedViewIds, isConformedHtml, parseConformedFile, viewHash } from '../decisions/conformed.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { AkukoProjectSchema, type Decision } from '../schema/akuko-project.ts';
import { DEFAULT_BOARD, embedProject, publishBoard } from './publish.ts';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(SKILL, 'fixtures', 'the-beating', 'akuko.json');
const CONFORMED = parseConformedFile(JSON.parse(readFileSync(join(SKILL, 'views', 'conformed.json'), 'utf8')));
const dirs: string[] = [];
const project = (mutate?: (p: any) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'akuko-publish-'));
  dirs.push(dir);
  const p = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  mutate?.(p);
  writeFileSync(join(dir, 'akuko.json'), JSON.stringify(p, null, 2));
  return dir;
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const block = (html: string) => {
  const b = findJsonBlock(html, PROJECT_BLOCK);
  assert.equal(b.status, 'ok');
  return html.slice((b as any).start, (b as any).end);
};

describe('views/publish.ts', () => {
  it('embeds the project, escaped, and the published page is still the conformed board', async () => {
    const dir = project((p) => { p.project.title = 'A <b>bold</b> </script> film'; });
    const path = await publishBoard(dir);
    assert.equal(path, join(dir, 'views', 'default-board.html'));
    const html = readFileSync(path, 'utf8');
    const raw = block(html);
    assert.ok(!raw.includes('<'), 'every < is written as \\u003c');
    const embedded = JSON.parse(raw);
    assert.equal(embedded.project.title, 'A <b>bold</b> </script> film');
    assert.equal(embedded._sample, undefined, 'no longer a sample');
    assert.ok(isConformedHtml(CONFORMED, 'default-board@0.2', html), 'same hash as the recorded board');
    assert.equal(viewHash(html), viewHash(readFileSync(DEFAULT_BOARD, 'utf8')));
  });

  it('the command line prints the path and exits 0; a missing folder or argument fails', async () => {
    const dir = project();
    const run = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(process.execPath, ['--experimental-strip-types', join(SKILL, 'views', 'publish.ts'), ...args], { cwd: SKILL }, (e, out, err) => resolve({ code: e ? ((e as any).code as number) : 0, out, err }));
    });
    const ok = await run(['--project', dir]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.out.trim(), join(dir, 'views', 'default-board.html'));
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['--project', join(dir, 'nope')])).code, 1);
  });

  it('decisions written by an older board (@0.1) still fold against the shipped list', () => {
    const project = AkukoProjectSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    const shot = project.shots.find((s) => s.status === 'pending-review')!;
    const mk = (view: string, id: string) => ({ id, action: 'approve', unit: shot.id, stage: 'sketch', by: 'you', at: '2026-11-09T10:00:00Z', view }) as Decision;
    assert.ok(conformedViewIds(CONFORMED).has('default-board@0.1') && conformedViewIds(CONFORMED).has('default-board@0.2'));
    for (const [view, id] of [['default-board@0.1', '11111111-1111-4111-8111-111111111111'], ['default-board@0.2', '22222222-2222-4222-8222-222222222222']] as const) {
      const { report } = foldDecisions(structuredClone(project), [mk(view, id)], { conformed: CONFORMED });
      assert.equal(report.rejected.length, 0, `${view} rejected: ${JSON.stringify(report.rejected)}`);
      assert.equal(report.applied.length, 1, view);
    }
  });

  it('refuses a board with no project block', () => {
    assert.throws(() => embedProject('<html></html>', {}), /no usable <script id="akuko-project"> block/);
  });

  it('run over its own output replaces the block, never duplicates it', async () => {
    const dir = project();
    const html = readFileSync(await publishBoard(dir), 'utf8');
    const again = embedProject(html, { format: 'akuko' });
    assert.equal(JSON.parse(block(again)).format, 'akuko');
    assert.equal(again.split('<script type="application/json" id="akuko-project">').length, 2);
  });
});
