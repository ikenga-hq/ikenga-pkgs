// views/publish.ts: embeds the current akuko.json in the default board and publishes it through the local host.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findJsonBlock, PROJECT_BLOCK } from '../scripts/check-view/hash.mjs';
import { conformedViewIds, isConformedHtml, parseConformedFile, viewHash } from '../decisions/conformed.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { AkukoProjectSchema, type Decision } from '../schema/akuko-project.ts';
import { DEFAULT_BOARD, embedProject, publishBoard, publishBoardWithMedia } from './publish.ts';
import { mediaSummary } from './media.ts';

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
    assert.ok(isConformedHtml(CONFORMED, 'default-board@0.5', html), 'same hash as the recorded board');
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

  it('decisions written by older boards (@0.1, @0.2) still fold against the shipped list', () => {
    const project = AkukoProjectSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    const shot = project.shots.find((s) => s.status === 'pending-review')!;
    const mk = (view: string, id: string) => ({ id, action: 'approve', unit: shot.id, stage: 'sketch', by: 'you', at: '2026-11-09T10:00:00Z', view }) as Decision;
    assert.ok(['0.1', '0.2', '0.3', '0.4', '0.5'].every((v) => conformedViewIds(CONFORMED).has('default-board@' + v)));
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

describe('views/publish.ts: pictures for a local board (@0.5)', () => {
  // a 1×1 PNG
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const withFiles = () => project((p) => {
    const at = (id: string, uri: string, mime = 'image/png') => { p.assets.find((a: any) => a.id === id).file = { uri, mime }; };
    at('char_narrator_portrait', 'bible/characters/char_narrator/refs/portrait.png');
    at('char_oldman_portrait', 'https://images.example.com/x.png');
    at('loc_hallway_plate', '/_blob/df0bf2286219479622863085fab2df4e');
    at('loc_bedroom_plate', 'bible/locations/loc_bedroom/refs/big.png');
    p.assets.push({ id: 'script-screenplay', stage: 'intake', status: 'approved', comments: [], kind: 'other', name: 'Screenplay', tags: [], file: { uri: 'script/screenplay.fountain', mime: 'text/plain' } });
  });
  const write = (dir: string, rel: string, data: Buffer | string) => { const f = join(dir, ...rel.split('/')); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); };

  it('embeds a thumbnail and a link for a local picture, the intake text, and nothing remote; the page is still the conformed board', async () => {
    const dir = withFiles();
    write(dir, 'bible/characters/char_narrator/refs/portrait.png', PNG);
    write(dir, 'bible/locations/loc_bedroom/refs/big.png', Buffer.alloc(500_000, 1));
    write(dir, 'script/screenplay.fountain', 'INT. HALLWAY - NIGHT');
    const r = await publishBoardWithMedia(dir, DEFAULT_BOARD, { shrink: false });
    const html = readFileSync(r.path, 'utf8');
    const b = JSON.parse(block(html))._board;
    assert.equal(b.thumbs['bible/characters/char_narrator/refs/portrait.png'], 'data:image/png;base64,' + PNG.toString('base64'));
    assert.equal(b.links['bible/characters/char_narrator/refs/portrait.png'], '../bible/characters/char_narrator/refs/portrait.png');
    assert.equal(b.thumbs['bible/locations/loc_bedroom/refs/big.png'], undefined, 'over the 400 KB cap: not embedded');
    assert.equal(b.links['bible/locations/loc_bedroom/refs/big.png'], '../bible/locations/loc_bedroom/refs/big.png', 'but linked');
    assert.equal(b.texts['script/screenplay.fountain'], 'INT. HALLWAY - NIGHT');
    assert.ok(!JSON.stringify(b).includes('images.example.com') && !JSON.stringify(b).includes('/_blob/'), 'remote and artifact paths are left to the page');
    const how = Object.fromEntries(r.media.items.map((i) => [i.unit, i.how]));
    assert.deepEqual([how.char_narrator_portrait, how.char_oldman_portrait, how.loc_hallway_plate, how.loc_bedroom_plate, how['script-screenplay']], ['embedded', 'remote', 'blob', 'linked', 'text']);
    assert.ok(isConformedHtml(CONFORMED, 'default-board@0.5', html), 'pictures live in the project block, outside the hash');
    assert.match(mediaSummary(r.media), /^1 picture embedded; 1 linked only/);
  });

  it('never reads a file outside the project folder and its parent, and --images none embeds nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'akuko-media-'));
    dirs.push(root);
    const dir = join(root, 'films', 'mine');
    const p = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    p.assets.find((a: any) => a.id === 'char_narrator_portrait').file = { uri: '../../elsewhere/outside.png', mime: 'image/png' };
    write(dir, 'akuko.json', JSON.stringify(p));
    write(root, 'elsewhere/outside.png', PNG);
    const r = await publishBoardWithMedia(dir, DEFAULT_BOARD, { shrink: false });
    assert.equal(r.media.items.find((i) => i.unit === 'char_narrator_portrait')?.how, 'outside');
    assert.equal(JSON.parse(block(readFileSync(r.path, 'utf8')))._board, undefined);
    const dir2 = withFiles();
    write(dir2, 'bible/characters/char_narrator/refs/portrait.png', PNG);
    const r2 = await publishBoardWithMedia(dir2, DEFAULT_BOARD, { images: 'none' });
    assert.equal(Object.keys(r2.media.media.thumbs).length + Object.keys(r2.media.media.links).length, 0);
  });
});
