// The three decision stores, against recorded fixtures: decisions.jsonl (B,
// and C's mirror), artifact-DB rows (A), iyke iframe-state events (C).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHAT_VIEW, conformedViewIds, isConformedHtml, loadConformedFile, parseConformedFile, viewHash } from './conformed.ts';
import { parseArtifactRows, readArtifactDbStore, rowsFromResult } from './artifact-db.ts';
import { IFRAME_STATE_KEY, parseIframeState, readIkengaStore } from './ikenga.ts';
import { appendDecisions, DECISIONS_FILE, jsonlLine, parseJsonl, readJsonlStore } from './jsonl.ts';

const FX = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const read = (f: string) => readFileSync(join(FX, f), 'utf8');
const ids = (ds: { id: string }[]) => ds.map((d) => d.id).sort();
const ALL = ids(parseJsonl(read('decisions.jsonl')).decisions);

const tmp: string[] = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'akuko-dec-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const D = { id: '307820e6-1823-4a86-9b98-7a5e68ce1d4d', action: 'approve', unit: 'sc2_sh4', stage: 'sketch', by: 'you', at: '2026-11-07T10:00:00Z', view: 'default-board@0.1' };

describe('jsonl store (host B; host C mirror)', () => {
  it('reads every recorded decision', () => {
    const r = parseJsonl(read('decisions.jsonl'));
    assert.equal(r.decisions.length, 10);
    assert.deepEqual(r.invalid, []);
    assert.equal(r.cursor, `jsonl:${Buffer.byteLength(read('decisions.jsonl'))}`);
  });

  it('reports bad lines with their line number and keeps going', () => {
    const r = parseJsonl(`${JSON.stringify(D)}\nnot json\n{"id":"x","action":"approve"}\n\n${JSON.stringify({ ...D, id: '2ec96544-372a-4a31-9b6d-1780d32876ff' })}\n`);
    assert.equal(r.decisions.length, 2);
    assert.deepEqual(r.invalid.map((x) => x.where), ['line 2', 'line 3']);
  });

  it('a half-written last line is left for next time; the cursor stops before it', () => {
    const full = `${JSON.stringify(D)}\n`;
    const r = parseJsonl(`${full}{"id":"2ec9`);
    assert.equal(r.decisions.length, 1);
    assert.deepEqual(r.invalid, []);
    assert.equal(r.cursor, `jsonl:${Buffer.byteLength(full)}`);
  });

  it('`since` reads only what came after the cursor', () => {
    const text = read('decisions.jsonl');
    const first = parseJsonl(text.split('\n').slice(0, 4).join('\n') + '\n');
    const rest = parseJsonl(text, first.cursor);
    assert.equal(first.decisions.length + rest.decisions.length, 10);
    assert.deepEqual(ids([...first.decisions, ...rest.decisions]), ALL);
    assert.equal(parseJsonl(text, 'not-a-cursor').decisions.length, 10, 'an unknown cursor reads from the start');
  });

  it('appendDecisions adds only new ids, as whole lines; a missing file is an empty store', async () => {
    const dir = tmpDir();
    assert.deepEqual((await readJsonlStore(dir)).decisions, []);
    const ds = parseJsonl(read('decisions.jsonl')).decisions;
    assert.equal((await appendDecisions(dir, ds.slice(0, 3))).length, 3);
    assert.equal((await appendDecisions(dir, ds)).length, 7);
    assert.equal((await appendDecisions(dir, ds)).length, 0);
    const text = readFileSync(join(dir, DECISIONS_FILE), 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.deepEqual(ids((await readJsonlStore(dir)).decisions), ALL);
    assert.equal(jsonlLine(ds[0]!), `${JSON.stringify(ds[0])}\n`);
  });

  it('appending after a torn last line starts a new line', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, DECISIONS_FILE), `${JSON.stringify(D)}\n{"torn":`);
    await appendDecisions(dir, [{ ...D, id: '2ec96544-372a-4a31-9b6d-1780d32876ff' } as never]);
    const r = await readJsonlStore(dir);
    assert.equal(r.decisions.length, 2);
    assert.equal(r.invalid.length, 1);
  });
});

describe('artifact-DB store (host A)', () => {
  it('parses a recorded ArtifactData list of the decisions collection', () => {
    const r = parseArtifactRows(read('artifact-db-list.json'));
    assert.deepEqual(ids(r.decisions), ALL);
    assert.deepEqual(r.invalid, []);
    assert.equal(r.cursor, 'db:2026-11-07T10:09:00.693340Z');
  });

  it('a row written with add() (its own row id) is read by the decision id in data', () => {
    const rows = rowsFromResult(read('artifact-db-list.json'));
    const added = rows.find((x) => x.id === 'dg54snl36ulb16eig8hp')!;
    assert.equal((added.data as { id: string }).id, '2ec96544-372a-4a31-9b6d-1780d32876ff');
  });

  it('accepts the result wrapped, as a JSON string with prose around it, or with data as a string', () => {
    const rows = JSON.parse(read('artifact-db-list.json'));
    for (const v of [{ documents: rows }, { items: rows }, `Found ${rows.length} documents:\n${JSON.stringify(rows)}`]) {
      assert.deepEqual(ids(parseArtifactRows(v).decisions), ALL);
    }
    const stringy = rows.map((x: { data: unknown }) => ({ ...x, data: JSON.stringify(x.data) }));
    assert.deepEqual(ids(parseArtifactRows(stringy).decisions), ALL);
    assert.throws(() => rowsFromResult({ nope: 1 }), /not an ArtifactData list result/);
  });

  it('the A4 manual-check row ({action: note, text: hello}) is reported invalid, not folded', () => {
    const r = parseArtifactRows([{ id: 'dg54snl36ulb16eig8hp', data: { action: 'note', text: 'hello' }, version: 1, updatedAt: '2026-11-07T11:00:08.427836Z' }]);
    assert.equal(r.decisions.length, 0);
    assert.equal(r.invalid[0]?.where, 'row dg54snl36ulb16eig8hp');
  });

  it('`since` returns rows updated at or after the cursor', () => {
    const r = parseArtifactRows(read('artifact-db-list.json'), 'db:2026-11-07T10:05:00.130662Z');
    assert.equal(r.decisions.length, 5);
  });

  it('readArtifactDbStore lists the `decisions` collection', async () => {
    const asked: string[] = [];
    const r = await readArtifactDbStore(async (c) => { asked.push(c); return JSON.parse(read('artifact-db-list.json')); });
    assert.deepEqual(asked, ['decisions']);
    assert.equal(r.decisions.length, 10);
  });
});

describe('ikenga store (host C): iframe-state, mirrored to decisions.jsonl', () => {
  it('parses recorded `iyke iframe-state` output (prose around the JSON, nested iframes)', () => {
    const r = parseIframeState(read('iframe-state.txt'));
    assert.deepEqual(ids(r.decisions), ALL);
  });

  it('accepts the C4(b) shape, a JSON-string value, and several iframes', () => {
    const one = { generation: 1, state: { [IFRAME_STATE_KEY]: [D] } };
    assert.equal(parseIframeState(one).decisions.length, 1);
    assert.equal(parseIframeState({ generation: 1, state: { [IFRAME_STATE_KEY]: JSON.stringify([D]) } }).decisions.length, 1);
    assert.equal(parseIframeState([one, { generation: 2, state: {} }]).decisions.length, 1);
    assert.equal(parseIframeState({ generation: 0, state: {} }).decisions.length, 0);
    const bad = parseIframeState({ generation: 1, state: { [IFRAME_STATE_KEY]: [{ action: 'note', text: 'hello' }] } });
    assert.equal(bad.invalid.length, 1, 'the C4(b) test value is not a full decision');
  });

  it('mirrors new decisions into decisions.jsonl and returns the union, without duplicates', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, DECISIONS_FILE), read('ikenga-mirror.jsonl'));
    const r = await readIkengaStore({ projectDir: dir, iframeState: read('iframe-state.txt') });
    assert.deepEqual(ids(r.decisions), ALL);
    assert.equal(r.mirrored.length, 6, 'four were already mirrored');
  });

  it('after a pane reload (iframe state gone) the mirror still has every decision', async () => {
    const dir = tmpDir();
    await readIkengaStore({ projectDir: dir, iframeState: read('iframe-state.txt') });
    const reloaded = await readIkengaStore({ projectDir: dir, iframeState: JSON.stringify({ generation: 1, state: {} }) });
    assert.deepEqual(ids(reloaded.decisions), ALL);
    const closed = await readIkengaStore({ projectDir: dir });
    assert.deepEqual(ids(closed.decisions), ALL);
  });
});

describe('conformed views', () => {
  it('loads the list; chat@1 is always accepted; a missing file is empty', () => {
    const f = loadConformedFile(join(FX, 'conformed.json'));
    assert.deepEqual([...conformedViewIds(f)].sort(), [CHAT_VIEW, 'default-board@0.1'].sort());
    assert.deepEqual(loadConformedFile(join(FX, 'nope.json')).views, []);
    assert.deepEqual([...conformedViewIds(undefined)], [CHAT_VIEW]);
  });

  it('rejects malformed lists', () => {
    assert.throws(() => parseConformedFile({ views: [] }));
    assert.throws(() => parseConformedFile({ format: 'akuko-conformed-views', version: 1, views: [{ view: 'no-version' }] }));
    assert.throws(() => parseConformedFile({ format: 'akuko-conformed-views', version: 1, views: [{ view: 'a@1', sha256: 'short' }] }));
  });

  it('isConformedHtml matches the exact HTML only', () => {
    const html = '<!doctype html><title>x</title>';
    const list = [{ view: 'x@1', sha256: viewHash(html) }];
    assert.equal(isConformedHtml(list, 'x@1', html), true);
    assert.equal(isConformedHtml(list, 'x@1', `${html} `), false);
    assert.equal(isConformedHtml(list, 'x@2', html), false);
  });
});
