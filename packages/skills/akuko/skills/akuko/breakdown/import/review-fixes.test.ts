// WP-25 review fixes: sturdier reading, Excel-typed times, what a re-import does to approved and removed units.
// Synthetic data only.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { makeXlsx, zip, type Cell } from '../../fixtures/sheet-import/make-xlsx.ts';
import { SHOT_ROWS, SHOT_HEADERS, shotRow, workbook, xlsx, type SheetRow } from '../../fixtures/sheet-import/synthetic.ts';
import { type AkukoProject } from '../../schema/akuko-project.ts';
import { createProject } from '../intake.ts';
import { importSheet, loadSheet, parseCsv, parseFilmTime, readXlsx, resolveMapping, ReadError, type ImportInput } from './index.ts';

const T0 = () => new Date('2026-11-10T09:00:00Z');
const T1 = () => new Date('2026-11-10T10:00:00Z');
const fresh = (): AkukoProject => createProject({ title: 'Synthetic', now: T0 });
const enc = (s: string) => new TextEncoder().encode(s);

async function inputFrom(rows: SheetRow[] = SHOT_ROWS, extra: Partial<ImportInput> = {}): Promise<ImportInput> {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-fix-'));
  const file = join(dir, 'sheet.xlsx');
  await writeFile(file, xlsx(rows));
  return { ...(await loadSheet(file, resolveMapping(undefined))), cardFile: (id) => `cards/${id}.png`, ...extra };
}

describe('reading, harder cases', () => {
  it('reads zip entries written with data descriptors, and stored entries', () => {
    const plain = readXlsx(makeXlsx(workbook()));
    const streamed = readXlsx(makeXlsx(workbook(), { descriptor: true }));
    assert.deepEqual(streamed, plain);
    assert.equal(streamed.length, 5);
  });

  it('refuses a zip64 entry, a prefixed-XML sheet, and a part that unpacks past the limit', () => {
    // a central-directory entry whose sizes are 0xffffffff
    const good = Buffer.from(makeXlsx([{ name: 'A', rows: [['x']] }]));
    const at = good.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    good.writeUInt32LE(0xffffffff, at + 20);
    assert.throws(() => readXlsx(good), /zip64/);

    const prefixed = zip([
      { name: 'xl/workbook.xml', data: enc('<workbook xmlns:r="x"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc('<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/s.xml"/></Relationships>') },
      { name: 'xl/worksheets/s.xml', data: enc('<x:worksheet><x:sheetData><x:row r="1"><x:c r="A1"/></x:row></x:sheetData></x:worksheet>') },
    ]);
    assert.throws(() => readXlsx(prefixed), (e: Error) => e instanceof ReadError && /prefixed XML/.test(e.message));

    const bomb = Buffer.concat([Buffer.alloc(70 * 1024 * 1024)]);
    const big = zip([
      { name: 'xl/workbook.xml', data: bomb },
    ]);
    assert.throws(() => readXlsx(big), /could not be unpacked/);
    void deflateRawSync;
  });

  it('finds the workbook, shared strings and sheets through the rels, wherever they sit', () => {
    const wb = zip([
      { name: '_rels/.rels', data: enc('<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/docs/book.xml"/></Relationships>') },
      { name: 'docs/book.xml', data: enc('<workbook xmlns:r="x"><sheets><sheet name="Moved" sheetId="1" r:id="rId9"/></sheets></workbook>') },
      { name: 'docs/_rels/book.xml.rels', data: enc('<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="data/one.xml"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="../strings/all.xml"/></Relationships>') },
      { name: 'strings/all.xml', data: enc('<sst><si><t>hello</t></si></sst>') },
      { name: 'docs/data/one.xml', data: enc('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>') },
    ]);
    const sheets = readXlsx(wb);
    assert.deepEqual(sheets.map((s) => [s.name, s.rows[0]![0]]), [['Moved', 'hello']]);
  });

  it('keeps a stray quote inside an unquoted CSV field', () => {
    assert.deepEqual(parseCsv('a,5" wide,"q,1"\n'), [['a', '5" wide', 'q,1']]);
    assert.throws(() => parseCsv('a,"open'), /unclosed/);
  });

  it('refuses minutes of 60 or more when an hour part is present', () => {
    assert.equal(parseFilmTime('1:75:00'), undefined);
    assert.equal(parseFilmTime('1:05:00'), 3900);
    assert.equal(parseFilmTime('75:00'), 4500); // no hour part: minutes may pass 59
  });
});

describe('film times typed by Excel', () => {
  const rowsWith = (inCell: Cell, outCell: Cell): Cell[][] => {
    const row = shotRow(SHOT_ROWS[0]!);
    const iIn = SHOT_HEADERS.indexOf('Film In');
    const iOut = SHOT_HEADERS.indexOf('Film Out');
    row[iIn] = inCell;
    row[iOut] = outCell;
    return [SHOT_HEADERS, row];
  };
  const read = async (grid: Cell[][]): Promise<ImportInput> => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-fix-'));
    const file = join(dir, 'sheet.xlsx');
    await writeFile(file, makeXlsx([{ name: 'Shot List', rows: grid }]));
    return { ...(await loadSheet(file, resolveMapping(undefined))), cardFile: () => 'c.png' };
  };

  it('scales a time-formatted number cell (a fraction of a day) to seconds', async () => {
    // 90 s and 150 s as fractions of a day, in a built-in time format and in a custom m:ss format
    const input = await read(rowsWith({ time: 90 / 86400 }, { time: 150 / 86400, custom: true }));
    const r = importSheet(fresh(), input, { now: T0 });
    assert.deepEqual(r.project.shots[0]!.film, { in_s: 90, out_s: 150 });
    assert.equal(r.project.shots[0]!.duration_s, 60);
  });

  it('refuses a plain number cell instead of reading it as seconds, and says why', async () => {
    const r = importSheet(fresh(), await read(rowsWith(12, 15.5)), { now: T0 });
    assert.equal(r.project.shots.length, 0);
    assert.match(r.summary.skipped[0]!, /film in "12" is a number cell: Excel keeps times as fractions of a day/);
  });

  it('still reads text times, and numbers in a CSV', async () => {
    const r = importSheet(fresh(), await read(rowsWith({ inline: '00:01.50' }, { inline: '00:03.00' })), { now: T0 });
    assert.deepEqual(r.project.shots[0]!.film, { in_s: 1.5, out_s: 3 });
  });
});

describe('re-import and approvals', () => {
  const approve = (p: AkukoProject, ...ids: string[]): void => {
    for (const s of p.shots) if (ids.includes(s.id)) { s.status = 'approved'; s.by_stage!.breakdown!.status = 'approved'; }
    for (const a of p.assets) if (ids.includes(a.id)) { a.status = 'approved'; a.by_stage!.export!.status = 'approved'; }
  };

  it('sends an approved shot back to review, with a note, when its prompt, negative, film time or refs change; never approves anything', async () => {
    const first = importSheet(fresh(), await inputFrom(), { now: T0 });
    const p = structuredClone(first.project);
    p.stages.intake = { state: 'approved' };
    p.stages.breakdown = { state: 'approved' };
    approve(p, 'S00-010', 'S01-010', 'S01-030', 'S02-010');
    // S00-010: new film out; S01-010: another character (refs); S01-030: only its notes change; S02-010: untouched
    const rows = SHOT_ROWS.map((x) => (x.id === 'S00-010' ? { ...x, out: '00:04.40', secs: 4.4 } : x.id === 'S01-010' ? { ...x, chars: 'ADA' } : x.id === 'S01-030' ? { ...x, notes: 'a new note' } : x));
    const r = importSheet(p, await inputFrom(rows), { now: T1 });
    const by = new Map(r.project.shots.map((s) => [s.id, s]));
    assert.equal(by.get('S00-010')!.status, 'pending-review');
    assert.match(by.get('S00-010')!.comments.at(-1)!.text, /Re-imported: film changed/);
    assert.equal(by.get('S01-010')!.status, 'pending-review');
    assert.match(by.get('S01-010')!.comments.at(-1)!.text, /refs/);
    assert.equal(by.get('S01-010')!.comments.at(-1)!.author, 'agent');
    assert.equal(by.get('S01-030')!.status, 'approved'); // notes are not a substance change
    assert.equal(by.get('S02-010')!.status, 'approved');
    assert.equal(by.get('S00-010')!.by_stage!.breakdown!.status, 'pending-review');
    assert.equal(r.project.stages.breakdown.state, 'in-review'); // an approved stage with a unit back in review is open again
    assert.equal(r.project.current_stage, 'breakdown');
    assert.deepEqual(r.summary.changed.filter((c) => c.approved).map((c) => c.id), ['S00-010', 'S01-010']);
    // the first import approved nothing, and nothing was approved by this one
    assert.equal(first.project.shots.filter((s) => s.status === 'approved').length, 0);
    assert.equal(r.project.shots.filter((s) => s.status === 'approved').length, 2);
  });

  it('does the same for an approved card whose time or file changed', async () => {
    const first = importSheet(fresh(), await inputFrom(), { now: T0 });
    const p = structuredClone(first.project);
    approve(p, 'card_P2-CARD', 'card_S00-020');
    const rows = SHOT_ROWS.map((x) => (x.id === 'P2-CARD' ? { ...x, out: '00:35.00' } : x));
    const r = importSheet(p, await inputFrom(rows), { now: T1 });
    const by = new Map(r.project.assets.map((a) => [a.id, a]));
    assert.equal(by.get('card_P2-CARD')!.status, 'pending-review');
    assert.match(by.get('card_P2-CARD')!.comments.at(-1)!.text, /film/);
    assert.equal(by.get('card_S00-020')!.status, 'approved');
  });

  it('a removed card is not counted, drops to pending unless approved, and is live again when it returns', async () => {
    const first = importSheet(fresh(), await inputFrom(), { now: T0 });
    const p = structuredClone(first.project);
    approve(p, 'card_S00-020');
    const without = SHOT_ROWS.filter((x) => x.id !== 'P2-CARD' && x.id !== 'S00-020' && x.id !== 'S01-020');
    const r = importSheet(p, await inputFrom(without), { now: T1 });
    const by = new Map(r.project.assets.map((a) => [a.id, a]));
    assert.equal(r.summary.counts.cards, 1);
    assert.equal(r.summary.counts.shots, 4);
    assert.equal(by.get('card_P2-CARD')!.status, 'pending');
    assert.equal(by.get('card_P2-CARD')!.by_stage!.export!.status, 'pending');
    assert.ok(by.get('card_P2-CARD')!.source!.removed_at);
    assert.equal(by.get('card_S00-020')!.status, 'approved'); // a person approved it: left alone
    assert.ok(by.get('card_S00-020')!.source!.removed_at);
    assert.equal(r.project.shots.find((s) => s.id === 'S01-020')!.status, 'pending');
    const back = importSheet(r.project, await inputFrom(), { now: T1 });
    const again = new Map(back.project.assets.map((a) => [a.id, a]));
    assert.equal(again.get('card_P2-CARD')!.status, 'pending-review');
    assert.equal(again.get('card_P2-CARD')!.source!.removed_at, undefined);
    assert.equal(back.project.shots.find((s) => s.id === 'S01-020')!.status, 'pending-review');
    assert.equal(back.summary.counts.cards, 3);
  });

  it('a later import moves the breakdown into review once intake has been approved', async () => {
    const first = importSheet(fresh(), await inputFrom(), { now: T0 });
    assert.equal(first.project.stages.breakdown.state, 'locked');
    // a person approves intake; decision folding then unlocks breakdown as "not-started"
    const p = structuredClone(first.project);
    p.stages.intake = { state: 'approved' };
    p.stages.breakdown = { state: 'not-started' };
    p.current_stage = 'breakdown';
    const r = importSheet(p, await inputFrom(), { now: T1 });
    assert.equal(r.project.stages.breakdown.state, 'in-review');
    assert.equal(r.project.current_stage, 'breakdown');
    // in-review and approved are left alone
    const q = structuredClone(r.project);
    q.stages.breakdown = { state: 'approved' };
    assert.equal(importSheet(q, await inputFrom(), { now: T1 }).project.stages.breakdown.state, 'approved');
  });
});

describe('refs and the master hash', () => {
  it('gives an as-is shot and a REF shot no house-style ref, and an as-is shot no lighting ref either', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const by = new Map(r.project.shots.map((s) => [s.id, s]));
    assert.deepEqual(by.get('S01-020')!.refs, ['KITCHEN']);
    assert.equal(by.get('S01-020')!.lighting, 'L-LAMP'); // the sheet's code is kept as data
    assert.ok(!by.get('S02-010')!.refs.includes('house-style'));
    assert.ok(by.get('S01-010')!.refs.includes('house-style'));
  });

  it('keeps an earlier sha256 when the master is unchanged, and clears it with a warning when it changed', async () => {
    const master = { uri: '../film.wav', duration_s: 48, sample_rate: 8000, start_tc: '00:00:00:00' };
    const hash = 'a'.repeat(64);
    const first = importSheet(fresh(), await inputFrom(SHOT_ROWS, { master: { ...master, sha256: hash } }), { now: T0 });
    assert.equal(first.project.audio.master!.sha256, hash);
    const same = importSheet(first.project, await inputFrom(SHOT_ROWS, { master }), { now: T1 });
    assert.equal(same.project.audio.master!.sha256, hash);
    assert.deepEqual(same.warnings.filter((w) => /sha256/.test(w)), []);
    const changed = importSheet(first.project, await inputFrom(SHOT_ROWS, { master: { ...master, duration_s: 49 } }), { now: T1 });
    assert.equal(changed.project.audio.master!.sha256, undefined);
    assert.ok(changed.warnings.some((w) => /earlier sha256 was cleared/.test(w)));
  });
});

void mkdir;
