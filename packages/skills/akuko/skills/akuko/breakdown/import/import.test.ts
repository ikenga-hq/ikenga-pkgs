// WP-25 — the shot-list importer, on a SYNTHETIC workbook of the shape a real project has.
//
// The workbook is a real .xlsx zip written by `fixtures/sheet-import/make-xlsx.ts`
// (formula cells with no saved value, shared and inline strings), and the same
// data as CSV. Nothing here comes from a real project.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lightingCsv, QUOTE_HEADERS, quotesCsv, SHOT_ROWS, shotCsv, tokensCsv, workbook, writeWav, xlsx, MASTER_SECONDS, SAMPLE_RATE, type SheetRow } from '../../fixtures/sheet-import/synthetic.ts';
import { makeXlsx } from '../../fixtures/sheet-import/make-xlsx.ts';
import { AkukoProjectSchema, ShotSchema, type AkukoProject } from '../../schema/akuko-project.ts';
import { checkIntegrity } from '../../schema/integrity.ts';
import { createProject } from '../intake.ts';
import { run } from '../cli.ts';
import { lintShots, lintSheetIdsInScript, hasErrors } from '../lint.ts';
import {
  cardResolver, clipResolver, describeMaster, formatFilmTime, formatSummary, importSheet, ImportError, loadCsvTable, loadSheet, parseCsv, parseFilmTime,
  readWavHeader, readXlsx, resolveMapping, sheetTable, tableOf, type ImportInput,
} from './index.ts';

const T0 = () => new Date('2026-11-10T09:00:00Z');
const T1 = () => new Date('2026-11-10T10:00:00Z');
const tmp = () => mkdtemp(join(tmpdir(), 'akuko-import-'));
const fresh = (): AkukoProject => createProject({ title: 'Synthetic', now: T0 });
const asFile = async (dir: string, name: string, data: Uint8Array | string): Promise<string> => {
  const p = join(dir, name);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, data);
  return p;
};

/** The tables of the default workbook, read back through the real reader. */
async function inputFrom(rows: SheetRow[] = SHOT_ROWS, extra: Partial<ImportInput> = {}): Promise<ImportInput> {
  const dir = await tmp();
  const file = await asFile(dir, 'sheet.xlsx', xlsx(rows));
  const files = await loadSheet(file, resolveMapping(undefined));
  return { ...files, cardFile: (id) => `cards/${id}.png`, ...extra };
}

describe('reading', () => {
  it('reads sheets, shared and inline strings, entities, and keeps a formula with no value empty', () => {
    const sheets = readXlsx(makeXlsx([
      { name: 'A & B', rows: [['h1', 'h2', 'h3'], ['x < y', { inline: '  keep ' }, { formula: '1+1' }], [null, 7, 'tail']] },
      { name: 'Second', rows: [['only']] },
    ]));
    assert.deepEqual(sheets.map((s) => s.name), ['A & B', 'Second']);
    assert.deepEqual(sheets[0]!.rows[1], ['x < y', '  keep ', '']);
    assert.deepEqual(sheets[0]!.rows[2], ['', '7', 'tail']);
  });

  it('finds a sheet by name and a column by header, ignoring case and spacing', () => {
    const wb = readXlsx(xlsx());
    const t = sheetTable(wb, 'shot list')!;
    assert.equal(t.rows.length, SHOT_ROWS.length);
    assert.equal(t.rows[0]!.row, 2);
    assert.equal(wb.length, 5);
  });

  it('parses CSV with quotes, doubled quotes, newlines inside a field and a BOM', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n'), [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
    assert.throws(() => parseCsv('"open'), /unclosed/);
  });

  it('parses film times', () => {
    assert.equal(parseFilmTime('18:31.98'), 1111.98);
    assert.equal(parseFilmTime('00:04.50'), 4.5);
    assert.equal(parseFilmTime('1:02:03.5'), 3723.5);
    assert.equal(parseFilmTime('12.5'), 12.5);
    assert.equal(parseFilmTime('0:75.00'), undefined);
    assert.equal(parseFilmTime('soon'), undefined);
    assert.equal(formatFilmTime(1111.98), '18:31.98');
  });

  it('refuses a file that is not a workbook', () => {
    assert.throws(() => readXlsx(new Uint8Array([1, 2, 3, 4])), /not a zip/);
  });
});

describe('the import', () => {
  it('rebuilds each prompt: tokens, then lighting, then the house style; a REF shot skips the style; "(" is used as written', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const by = new Map(r.project.shots.map((s) => [s.id, s]));
    assert.equal(
      by.get('S00-010')!.prompt,
      'a woman in her sixties, silver braid, green coat stands at the end of the pier, pale dawn light through haze, soft film grain, muted palette, 35mm',
    );
    assert.equal(by.get('S01-010')!.prompt, 'the same woman at twenty, dark braid, yellow raincoat and a small grey dog with one white ear in the a narrow kitchen with a tin kettle, warm lamplight, deep shadows, soft film grain, muted palette, 35mm');
    // as written: no expansion, no lighting, no style
    assert.equal(by.get('S01-020')!.prompt, '(Insert of a tin cup on the sill, used as written)');
    // reference shot: the lighting code REF has no phrase and no house style is added
    assert.equal(by.get('S02-010')!.prompt, 'the same woman at twenty, dark braid, yellow raincoat at a window, a reference still');
    assert.ok(by.get('S02-010')!.refs.every((x) => x !== 'house-style'));
    assert.ok(by.get('S02-010')!.notes?.includes('Ref moment: REF-window'));
    assert.equal(by.get('S02-010')!.lighting, undefined);
    // the negative comes from the Tokens sheet, on every shot
    for (const s of r.project.shots) assert.equal(s.negative, 'text, captions, logos, extra fingers');
  });

  it('writes the bible with the token as the id, every entry pending and sourced', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const b = r.project.bible;
    assert.deepEqual(b.characters.map((e) => e.id), ['ADA-NOW', 'ADA', 'BO']);
    assert.deepEqual(b.locations.map((e) => e.id), ['HARBOR', 'KITCHEN']);
    assert.deepEqual(b.styles.map((e) => e.id), ['L-DAWN', 'L-LAMP', 'house-style']);
    assert.equal(b.styles[0]!.description, 'pale dawn light through haze');
    assert.equal(b.styles[2]!.description, 'soft film grain, muted palette, 35mm');
    for (const e of [...b.characters, ...b.locations, ...b.styles]) {
      assert.equal(e.status, 'pending-review');
      assert.equal(e.source?.kind, 'sheet');
    }
    assert.equal(b.characters[0]!.source!.id, 'ADA-NOW');
  });

  it('gives shot refs as characters, then the location, then the styles', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const by = new Map(r.project.shots.map((s) => [s.id, s]));
    assert.deepEqual(by.get('S01-010')!.refs, ['ADA', 'BO', 'KITCHEN', 'L-LAMP', 'house-style']);
    assert.deepEqual(by.get('S01-020')!.refs, ['KITCHEN', 'L-LAMP', 'house-style']);
  });

  it('writes scenes with parts, and shots with part, lighting, tier, framing, motion, film time and source', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    assert.deepEqual(r.project.scenes.map((s) => [s.id, s.part, s.source!.id]), [['S00', 'Cold-open', 'S00'], ['S01', 'P1', 'S01'], ['S02', 'P2', 'S02']]);
    const s = r.project.shots.find((x) => x.id === 'S01-010')!;
    assert.equal(s.scene, 'S01');
    assert.equal(s.part, 'P1');
    assert.equal(s.lighting, 'L-LAMP');
    assert.equal(s.tier, 'A');
    assert.equal(s.framing, 'CU');
    assert.equal(s.shot_type, 'cu');
    assert.equal(s.motion_note, 'Hold');
    assert.deepEqual(s.film, { in_s: 8, out_s: 12 });
    assert.equal(s.duration_s, 4);
    assert.deepEqual(s.source, { kind: 'sheet', id: 'S01-010', row: 4 });
    assert.equal(s.script_line, undefined);
    assert.equal(r.project.shots[0]!.script_line, 'The pier at first light.');
    assert.equal(s.treatment, undefined); // not this package's job
    assert.equal(r.project.shots.find((x) => x.id === 'S01-020')!.notes, 'SPLIT');
  });

  it('keeps the gap at the start of a scene (the film times are not snapped)', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const first = r.project.shots.find((x) => x.id === 'S01-010')!;
    const prevEnd = r.project.assets.find((a) => a.id === 'card_S00-020')!.film!.out_s;
    assert.equal(first.film!.in_s - prevEnd, 0.5);
  });

  it('turns ready-made rows into card assets with a relative file, and never approves one', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const cards = r.project.assets.filter((a) => a.kind === 'card');
    assert.deepEqual(cards.map((c) => c.id), ['card_S00-020', 'card_P2-CARD', 'card_CREDITS-010']);
    const c = cards[1]!;
    assert.equal(c.stage, 'export');
    assert.equal(c.status, 'pending-review');
    assert.deepEqual(c.film, { in_s: 30, out_s: 34 });
    assert.deepEqual(c.file, { uri: 'cards/P2-CARD.png', mime: 'image/png' });
    assert.deepEqual(c.source, { kind: 'sheet', id: 'P2-CARD', row: 7 });
    assert.equal(r.project.shots.some((s) => s.id.includes('CARD') || s.id.includes('CREDITS')), false);
    assert.ok(![...r.project.shots, ...r.project.assets, ...r.project.bible.characters, ...r.project.bible.locations, ...r.project.bible.styles].some((u) => u.status === 'approved'));
  });

  it('leaves out a ready-made row whose file is not found, and says so', async () => {
    const r = importSheet(fresh(), await inputFrom(SHOT_ROWS, { cardFile: (id) => (id === 'P2-CARD' ? 'cards/p2.png' : undefined) }), { now: T0 });
    assert.deepEqual(r.project.assets.filter((a) => a.kind === 'card').map((c) => c.id), ['card_P2-CARD']);
    assert.equal(r.summary.skipped.filter((x) => /no file was found/.test(x)).length, 2);
    assert.deepEqual(r.integrity, []);
  });

  it('is consistent: the schema parses and integrity is clean', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    assert.deepEqual(r.integrity, []);
    assert.deepEqual(checkIntegrity(AkukoProjectSchema.parse(r.project)), []);
    assert.equal(r.summary.counts.shots, 5);
    assert.equal(r.summary.counts.cards, 3);
    assert.equal(r.summary.counts.scenes, 3);
  });

  it('puts intake in review with the sheet to approve, and keeps breakdown locked until a person approves intake', async () => {
    const r = importSheet(fresh(), await inputFrom(SHOT_ROWS, { sheetFile: { uri: '../sheet.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, filmScript: { uri: '../script.md' } }), { now: T0 });
    assert.equal(r.project.stages.intake.state, 'in-review');
    assert.equal(r.project.stages.breakdown.state, 'locked');
    assert.deepEqual(r.project.assets.filter((a) => a.stage === 'intake').map((a) => [a.id, a.status]), [['script-source', 'pending-review'], ['script-sheet', 'pending-review']]);
    assert.equal(r.project.script.source, '../script.md');
    assert.equal(r.project.script.screenplay, undefined);
    // an intake a person already approved lets the breakdown open for review
    const p = fresh();
    p.stages.intake = { state: 'approved' };
    p.stages.breakdown = { state: 'not-started' };
    const r2 = importSheet(p, await inputFrom(), { now: T0 });
    assert.equal(r2.project.stages.breakdown.state, 'in-review');
    assert.equal(r2.project.current_stage, 'breakdown');
  });

  it('refuses a project that already has shots from a breakdown', async () => {
    const p = fresh();
    p.shots.push(ShotSchema.parse({ id: 'sc1_sh1', stage: 'breakdown', status: 'pending-review' }));
    assert.throws(() => importSheet(p, { shots: tableOf('x', [['Shot ID']]) }), ImportError);
  });

  it('names the missing columns and the headers it found', async () => {
    const t = tableOf('Shots', [['Name', 'Start'], ['a', '00:01.00']]);
    assert.throws(() => importSheet(fresh(), { shots: t }), (e: Error) => /no column for: id/.test(e.message) && /Name \| Start/.test(e.message));
  });

  it('skips a row it cannot use and reports it', async () => {
    const rows: SheetRow[] = [
      ...SHOT_ROWS,
      { id: 'S09-010', scene: 'S09', prompt: 'bad times', in: '00:30.00', out: '00:20.00', part: 'P3' },
      { id: 'S09_020', scene: 'S09', prompt: 'underscore id', in: '00:50.00', out: '00:51.00', part: 'P3' },
      { id: 'S01-010', scene: 'S01', prompt: 'duplicate id', in: '00:50.00', out: '00:51.00', part: 'P3' },
    ];
    const r = importSheet(fresh(), await inputFrom(rows), { now: T0 });
    assert.equal(r.summary.skipped.length, 3);
    assert.equal(r.project.shots.length, 5);
  });
});

describe('mapping', () => {
  it('finds columns by header name, wherever they are, and honours a mapping override', async () => {
    const reordered = (rows: string[][]): string[][] => rows.map((r) => [...r].reverse());
    const sheets = workbook();
    const shotSheet = sheets.find((s) => s.name === 'Shot List')!;
    const grid = reordered(shotSheet.rows.map((r) => r.map((c) => (c === null ? '' : typeof c === 'object' ? ('inline' in c ? c.inline : '') : String(c)))));
    grid[0] = grid[0]!.map((h) => (h === 'Shot ID' ? 'Id' : h));
    const input: ImportInput = {
      shots: tableOf('Shots', grid),
      tokens: tableOf('Tokens', [['Token', 'Expands to', 'Type/note'], ['ADA-NOW', 'x', 'c'], ['HARBOR', 'y', 'Location']]),
      mapping: resolveMapping({ shot: { id: 'Id' }, partIds: { 'Cold open': 'P0' } }),
      cardFile: () => 'c.png',
    };
    const r = importSheet(fresh(), input, { now: T0 });
    assert.equal(r.project.shots.length, 5);
    assert.equal(r.project.shots[0]!.part, 'P0');
    assert.throws(() => resolveMapping({ nope: 1 } as never), /unknown key/);
  });
});

describe('lines', () => {
  async function withLines(rows: SheetRow[] = SHOT_ROWS): Promise<{ r: ReturnType<typeof importSheet>; dir: string }> {
    const dir = await tmp();
    const q = await asFile(dir, 'Lip-Sync/quotes.csv', quotesCsv());
    await asFile(dir, 'Lip-Sync/Clips/Q1_00m08s_Ada.wav', 'x');
    const input = await inputFrom(rows, { lines: await loadCsvTable(q), clipUri: clipResolver(join(dir, 'akuko'), q) });
    return { r: importSheet(fresh(), input, { now: T0 }), dir };
  }

  it('reads lines with their words, links them to shots by film time, and handles two lines in one cell', async () => {
    const { r } = await withLines();
    const lines = r.project.audio.lines!;
    assert.deepEqual(lines.map((l) => [l.id, l.kind, l.character]), [['Q1', 'spoken', 'Ada'], ['Q2', 'thought', 'Ada'], ['Q3', 'spoken', 'Bo'], ['Q4', 'thought', 'Ada']]);
    assert.deepEqual(lines[0]!.words, [{ w: 'Put', t_s: 8.4 }, { w: 'the', t_s: 8.8 }, { w: 'kettle', t_s: 9.1 }, { w: 'on.', t_s: 9.7 }]);
    assert.equal(lines[0]!.film_in_s, 8.4);
    assert.equal(lines[0]!.text, 'Put the kettle on.');
    const by = new Map(r.project.shots.map((s) => [s.id, s]));
    assert.deepEqual(by.get('S01-010')!.lines, [{ id: 'Q1', kind: 'spoken' }]);
    assert.deepEqual(by.get('S01-020')!.lines, [{ id: 'Q2', kind: 'thought' }]);
    assert.deepEqual(by.get('S01-030')!.lines, [{ id: 'Q3', kind: 'spoken' }, { id: 'Q4', kind: 'thought' }]);
    assert.equal(r.summary.counts.lines, 4);
    assert.equal(r.warnings.filter((w) => /differ/.test(w)).length, 0);
    assert.deepEqual(r.integrity, []);
  });

  it('gives a line to the shot it starts in (a cut mid-line), or to the shot it overlaps most when it starts in a gap', async () => {
    const q = (id: string, a: string, b: string): string[] => [id, 'Ada', 'spoken', 'S01', a, b, '', '', '', '', '1', 'x', '', '', ''];
    const lines = tableOf('q', [QUOTE_HEADERS, q('QA', '00:11.50', '00:13.00'), q('QB', '00:07.60', '00:08.30'), q('QC', '00:03.00', '00:03.40')]);
    const r = importSheet(fresh(), await inputFrom(SHOT_ROWS, { lines }), { now: T0 });
    const by = new Map(r.project.shots.map((s) => [s.id, s.lines?.map((l) => l.id)]));
    assert.deepEqual(by.get('S01-010'), ['QB', 'QA']);
    assert.equal(by.get('S01-020'), undefined);
    assert.deepEqual(by.get('S00-010'), ['QC']);
  });

  it('records the clip as a path relative to the project, and says when one is missing', async () => {
    const { r } = await withLines();
    const lines = r.project.audio.lines!;
    assert.match(lines[0]!.clip_uri!, /^\.\.\/Lip-Sync\/Clips\/Q1_00m08s_Ada\.wav$/);
    assert.equal(lines[1]!.clip_uri, undefined);
    assert.ok(r.warnings.some((w) => /Q2_00m13s_Ada\.wav.*not found/.test(w)));
  });

  it('warns when the sheet column and the film times disagree', async () => {
    const rows = SHOT_ROWS.map((x) => (x.id === 'S01-030' ? { ...x, lines: 'Q3 Bo (spoken)' } : x.id === 'S01-010' ? { ...x, lines: 'Q9 Ada (spoken)' } : x));
    const { r } = await withLines(rows);
    assert.ok(r.warnings.some((w) => /^S01-030: lines by film time \[Q3, Q4\] differ from the sheet's column \[Q3\]/.test(w)));
    assert.ok(r.warnings.some((w) => /^S01-010: column .* names Q9, which is not in the lines file/.test(w)));
  });
});

describe('the master', () => {
  it('reads the length and rate from the WAV header, relative to the project', async () => {
    const dir = await tmp();
    const wav = join(dir, 'Audio', 'film.wav');
    await mkdir(join(dir, 'Audio'));
    await writeWav(wav, MASTER_SECONDS);
    const h = await readWavHeader(wav);
    assert.equal(h.sampleRate, SAMPLE_RATE);
    assert.equal(h.bits, 24);
    assert.equal(h.durationS, MASTER_SECONDS);
    const m = await describeMaster(join(dir, 'akuko'), wav, {});
    assert.deepEqual(m, { uri: '../Audio/film.wav', duration_s: 48, sample_rate: 8000, start_tc: '00:00:00:00' });
    const hashed = await describeMaster(join(dir, 'akuko'), wav, { hash: true, startTc: '01:00:00:00' });
    assert.match(hashed.sha256!, /^[0-9a-f]{64}$/);
    assert.equal(hashed.start_tc, '01:00:00:00');
  });

  it('takes the rest of the file when the data size is unset', async () => {
    const dir = await tmp();
    const wav = join(dir, 'a.wav');
    await writeWav(wav, 2, 8000, { badDataSize: true });
    assert.equal((await readWavHeader(wav)).durationS, 2);
    await writeFile(wav, 'not a wav at all');
    await assert.rejects(readWavHeader(wav), /not a WAV/);
  });

  it('sets audio.master and project.fps (default 24), and every film time must lie on the master', async () => {
    const master = { uri: '../film.wav', duration_s: MASTER_SECONDS, sample_rate: 8000, start_tc: '00:00:00:00' };
    const r = importSheet(fresh(), await inputFrom(SHOT_ROWS, { master }), { now: T0 });
    assert.deepEqual(r.project.audio.master, master);
    assert.equal(r.project.project.fps, '24');
    assert.deepEqual(r.integrity, []);
    const short = importSheet(fresh(), await inputFrom(SHOT_ROWS, { master: { ...master, duration_s: 20 }, fps: '25' }), { now: T0 });
    assert.equal(short.project.project.fps, '25');
    assert.ok(short.integrity.some((i) => /past the end of the master/.test(i.message)));
  });
});

describe('re-import', () => {
  const clone = <T>(x: T): T => structuredClone(x);

  it('changes nothing the second time', async () => {
    const first = importSheet(fresh(), await inputFrom(), { now: T0 });
    const again = importSheet(first.project, await inputFrom(), { now: T1 });
    assert.deepEqual(again.project, first.project);
    assert.equal(again.summary.changed.length + again.summary.added.length + again.summary.removed.length, 0);
    assert.equal(again.summary.firstImport, false);
  });

  it('updates a changed row, flags a row that left the sheet, and never touches status, approvals or other assets', async () => {
    const first = importSheet(fresh(), await inputFrom(), { now: T0 });
    const p = clone(first.project);
    // work that happened after the first import
    const shot = p.shots.find((s) => s.id === 'S01-030')!;
    shot.status = 'approved';
    shot.comments.push({ ts: '2026-11-10T09:30:00.000Z', stage: 'breakdown', author: 'you', text: 'Good.' });
    shot.treatment = 'still-move';
    p.assets.push({ id: 'S01-030_keyframe', stage: 'keyframes', status: 'approved', comments: [], kind: 'keyframe', owner: 'S01-030', tags: [] });
    p.assets.find((a) => a.id === 'card_P2-CARD')!.status = 'approved';

    // the sheet moves on: S01-030 gets new words and a new end, S01-020 is gone, a new shot arrives
    const rows = SHOT_ROWS.filter((x) => x.id !== 'S01-020').map((x) => (x.id === 'S01-030' ? { ...x, prompt: '[ADA] hands [BO] a warm crust', out: '00:29.00', secs: 8.5 } : x));
    rows.splice(3, 0, { id: 'S01-025', scene: 'S01', prompt: '[BO] looks up', tier: 'C', in: '00:12.00', out: '00:20.50', part: 'P1', light: 'L-LAMP', chars: 'BO', loc: 'KITCHEN' });
    const r = importSheet(p, await inputFrom(rows), { now: T1 });

    assert.deepEqual(r.integrity, []);
    assert.deepEqual(r.summary.added.map((c) => c.id), ['S01-025']);
    assert.deepEqual(r.summary.removed.map((c) => c.id), ['S01-020']);
    const changed = r.summary.changed.find((c) => c.id === 'S01-030')!;
    assert.ok(changed.fields!.includes('prompt') && changed.fields!.includes('film') && changed.fields!.includes('duration_s'));
    assert.equal(changed.approved, true);

    const by = new Map(r.project.shots.map((s) => [s.id, s]));
    const s30 = by.get('S01-030')!;
    assert.match(s30.prompt!, /a warm crust/);
    assert.deepEqual(s30.film, { in_s: 20.5, out_s: 29 });
    assert.equal(s30.duration_s, 8.5);
    assert.equal(s30.status, 'approved');
    assert.equal(s30.comments.length, 1);
    assert.equal(s30.treatment, 'still-move');
    assert.equal(s30.updated_at, T1().toISOString());
    // untouched: the shot nobody changed keeps its stamp
    assert.equal(by.get('S01-010')!.updated_at, T0().toISOString());
    // the removed row is kept, flagged, and off the clock; nothing is deleted
    const gone = by.get('S01-020')!;
    assert.equal(gone.source!.removed_at, T1().toISOString());
    assert.equal(gone.film, undefined);
    assert.equal(gone.status, 'pending-review');
    // other assets and the card's approval stand
    assert.equal(r.project.assets.find((a) => a.id === 'S01-030_keyframe')!.status, 'approved');
    assert.equal(r.project.assets.find((a) => a.id === 'card_P2-CARD')!.status, 'approved');
    // the new shot sits in sheet order; the removed one goes to the end
    assert.deepEqual(r.project.shots.map((s) => s.id), ['S00-010', 'S01-010', 'S01-025', 'S01-030', 'S02-010', 'S01-020']);
    assert.equal(r.summary.counts.shots, 5);
    assert.ok(formatSummary(r).includes('left the sheet'));
    assert.match(formatSummary(r), /S01-030 \(.*prompt/);

    // and when the row comes back it is live again
    const back = importSheet(r.project, await inputFrom(), { now: T1 });
    assert.equal(back.project.shots.find((s) => s.id === 'S01-020')!.source!.removed_at, undefined);
    assert.deepEqual(back.project.shots.find((s) => s.id === 'S01-020')!.film, { in_s: 12, out_s: 20.5 });
  });

  it('flags a card that left the sheet but keeps its film time and file', async () => {
    const first = importSheet(fresh(), await inputFrom(), { now: T0 });
    const r = importSheet(first.project, await inputFrom(SHOT_ROWS.filter((x) => x.id !== 'P2-CARD')), { now: T1 });
    const card = r.project.assets.find((a) => a.id === 'card_P2-CARD')!;
    assert.equal(card.source!.removed_at, T1().toISOString());
    assert.ok(card.film && card.file);
    assert.deepEqual(r.integrity, []);
  });

  it('does not overwrite a card file that is already set, and leaves lines alone when no quotes file is given', async () => {
    const dir = await tmp();
    const q = await asFile(dir, 'q.csv', quotesCsv());
    const first = importSheet(fresh(), await inputFrom(SHOT_ROWS, { lines: await loadCsvTable(q) }), { now: T0 });
    const p = clone(first.project);
    p.assets.find((a) => a.id === 'card_P2-CARD')!.file = { uri: 'mine.png', mime: 'image/png' };
    const r = importSheet(p, await inputFrom(), { now: T1 });
    assert.equal(r.project.assets.find((a) => a.id === 'card_P2-CARD')!.file!.uri, 'mine.png');
    assert.equal(r.project.audio.lines!.length, 4);
    assert.deepEqual(r.project.shots.find((s) => s.id === 'S01-030')!.lines, [{ id: 'Q3', kind: 'spoken' }, { id: 'Q4', kind: 'thought' }]);
  });
});

describe('lint in imported mode', () => {
  it('has no 10 s cap, no 5 s floor and no canonical-id warning; a SPLIT note is a warning', async () => {
    const rows = [...SHOT_ROWS];
    rows.push({ id: 'S03-010', scene: 'S03', prompt: '[ADA] waits', in: '00:48.00', out: '01:55.00', part: 'P3', notes: 'SPLIT?' }, { id: 'S03-020', scene: 'S03', prompt: '[ADA] leaves', in: '01:55.00', out: '01:55.40', part: 'P3' });
    const r = importSheet(fresh(), await inputFrom(rows), { now: T0 });
    const rules = r.lint.map((i) => `${i.severity}:${i.rule}:${i.shot}`);
    assert.ok(!rules.some((x) => /duration-too-long|duration-short|id-not-canonical/.test(x)));
    assert.ok(rules.includes('warning:split-note:S03-010'));
    assert.ok(rules.includes('warning:split-note:S01-020'));
    assert.equal(hasErrors(r.lint), false);
    // a project made by breakdown still gets the old rules
    const p = AkukoProjectSchema.parse({ ...fresh(), shots: [{ id: 'sc1_sh1', stage: 'breakdown', status: 'pending-review', scene: 'sc1', duration_s: 12, action: 'x', refs: [] }] });
    assert.ok(lintShots(p).some((i) => i.rule === 'duration-too-long'));
  });

  it('warns when a shot starts before the previous scene ended', async () => {
    const rows = SHOT_ROWS.map((x) => (x.id === 'S02-010' ? { ...x, in: '00:20.00', out: '00:24.00', secs: 4 } : x));
    const r = importSheet(fresh(), await inputFrom(rows), { now: T0 });
    assert.ok(r.lint.some((i) => i.rule === 'film-order' && i.shot === 'S02-010'));
  });

  it('checks that each sheet id is named in the film script', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const script = 'Scene one: `S00-010` the pier. Then `S01-010`, `S01-020` and S01-030.\nBut S02-0100 is a different id.';
    const missing = lintSheetIdsInScript(r.project, script).map((i) => i.shot);
    assert.deepEqual(missing, ['S02-010']);
    const via = importSheet(fresh(), await inputFrom(SHOT_ROWS, { filmScript: { uri: 's.md', text: script } }), { now: T0 });
    assert.ok(via.lint.some((i) => i.rule === 'sheet-id-not-in-script' && i.shot === 'S02-010'));
  });
});

describe('csv', () => {
  it('gives the same project as the workbook', async () => {
    const dir = await tmp();
    const sheet = await asFile(dir, 'shots.csv', shotCsv());
    const files = await loadSheet(sheet, resolveMapping(undefined), {
      tokensCsv: await asFile(dir, 'tokens.csv', tokensCsv()),
      lightingCsv: await asFile(dir, 'lighting.csv', lightingCsv()),
    });
    const fromCsv = importSheet(fresh(), { ...files, cardFile: (id) => `cards/${id}.png` }, { now: T0 });
    const fromXlsx = importSheet(fresh(), await inputFrom(), { now: T0 });
    assert.deepEqual(fromCsv.project, fromXlsx.project);
    assert.deepEqual(fromCsv.integrity, []);
  });

  it('warns when there are no tokens, and uses the prompts as written', async () => {
    const dir = await tmp();
    const files = await loadSheet(await asFile(dir, 'shots.csv', shotCsv()), resolveMapping(undefined));
    const r = importSheet(fresh(), { ...files, cardFile: () => 'c.png' }, { now: T0 });
    assert.ok(r.warnings[0]!.startsWith('no Tokens table'));
    assert.equal(r.project.shots[0]!.prompt, '[ADA-NOW] stands at the end of the pier');
    assert.deepEqual(r.integrity, []);
  });
});

describe('finding the ready-made files', () => {
  it('matches by sheet id, by the id\'s word part when unique, and by an explicit mapping', async () => {
    const dir = await tmp();
    await asFile(dir, 'Cards/P2-CARD_title.png', 'x');
    await asFile(dir, 'Cards/Film_Rolling-Credits_24fps.mp4', 'x');
    await asFile(dir, 'Cards/opening.png', 'x');
    const proj = join(dir, 'akuko');
    const find = cardResolver(proj, join(dir, 'Cards'), { 'S00-020': 'opening.png' });
    assert.equal(find('P2-CARD'), '../Cards/P2-CARD_title.png');
    assert.equal(find('CREDITS-010'), '../Cards/Film_Rolling-Credits_24fps.mp4');
    assert.equal(find('S00-020'), '../Cards/opening.png');
    assert.equal(find('P9-CARD'), undefined);
  });
});

describe('the command line', () => {
  async function setup(): Promise<{ dir: string; project: string; args: string[] }> {
    const dir = await tmp();
    const sheet = await asFile(dir, 'sheet.xlsx', xlsx());
    const quotes = await asFile(dir, 'Audio/quotes.csv', quotesCsv());
    const script = await asFile(dir, 'script.md', 'Shots: `S00-010`, `S01-010`, `S01-020`, `S01-030`, `S02-010`.');
    const wav = join(dir, 'Audio', 'film.wav');
    await writeWav(wav, MASTER_SECONDS);
    await asFile(dir, 'Cards/P2-CARD.png', 'x');
    await asFile(dir, 'Cards/Credits.mp4', 'x');
    await asFile(dir, 'Cards/title.png', 'x');
    const project = join(dir, 'akuko');
    const args = ['import', '--project', project, '--sheet', sheet, '--lines', quotes, '--film-script', script, '--master', wav, '--cards-dir', join(dir, 'Cards'), '--title', 'Synthetic'];
    return { dir, project, args };
  }

  it('--dry-run reports and writes nothing', async () => {
    const { project, args } = await setup();
    const r = await run([...args, '--dry-run', '--mapping', await asFile(project, '../map.json', JSON.stringify({ cards: { files: { 'S00-020': 'title.png' } } }))], T0);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^Dry run, nothing written\. Imported: 5 shots, 3 cards, 3 scenes, 4 lines \(3 shots carry a line\)/);
    assert.match(r.out, /Parts: Cold-open 1 \(00:00\.00-00:04\.50\); P1 3 \(00:08\.00-00:30\.00\); P2 1/);
    assert.match(r.out, /Integrity: clean\./);
    assert.match(r.out, /Lint: 0 errors, 1 warnings\./);
    assert.equal(existsSync(join(project, 'akuko.json')), false);
  });

  it('writes the project, then a second run changes nothing', async () => {
    const { project, args } = await setup();
    const first = await run(args, T0);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Wrote .*akuko\.json\. Every unit is waiting for review; nothing is approved\./);
    const written = JSON.parse(await readFile(join(project, 'akuko.json'), 'utf8')) as AkukoProject;
    assert.equal(written.audio.master!.uri, '../Audio/film.wav');
    assert.equal(written.project.fps, '24');
    assert.equal(written.script.source, '../script.md');
    assert.equal(written.assets.filter((a) => a.kind === 'card').length, 2); // S00-020 has no file here: left out and reported
    assert.match(first.out, /S00-020\): a ready-made row, but no file was found/);
    const before = await readFile(join(project, 'akuko.json'), 'utf8');
    const second = await run(args, T1);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /Re-imported: .*\nDiff: 0 added, 0 changed, 0 left the sheet \(kept, flagged\), \d+ unchanged\./);
    assert.equal(await readFile(join(project, 'akuko.json'), 'utf8'), before);
  });

  it('lint on an imported project checks the sheet ids against the film script', async () => {
    const { project, args } = await setup();
    await run(args, T0);
    const r = await run(['lint', '--project', project], T0);
    assert.equal(r.code, 0);
    assert.match(r.out, /Lint passed|warning/);
    assert.doesNotMatch(r.out, /tag/i);
  });

  it('refuses an integrity problem and writes nothing', async () => {
    const { project, args } = await setup();
    const short = join(project, '..', 'short.wav');
    await writeWav(short, 10);
    const r = await run([...args.slice(0, args.indexOf('--master')), '--master', short, ...args.slice(args.indexOf('--master') + 2)], T0);
    assert.equal(r.code, 1);
    assert.match(r.out, /past the end of the master/);
    assert.match(r.out, /Nothing written\./);
    assert.equal(existsSync(join(project, 'akuko.json')), false);
  });

  it('the import route completes intake without script/source.md', async () => {
    const dir = await tmp();
    const project = join(dir, 'p');
    assert.equal((await run(['new', '--project', project, '--title', 'T'], T0)).code, 0);
    const r = await run(['intake', '--project', project, '--route', 'import', '--sheet', join(dir, 'sheet.xlsx')], T0);
    assert.equal(r.code, 0, r.out);
    const p = JSON.parse(await readFile(join(project, 'akuko.json'), 'utf8')) as AkukoProject;
    assert.equal(p.stages.intake.state, 'in-review');
    assert.deepEqual(p.assets.map((a) => a.id), ['script-sheet']);
    assert.equal(p.script.source, undefined);
    // the old routes still need their files
    const bad = await run(['intake', '--project', project, '--route', 'direct'], T0);
    assert.equal(bad.code, 1);
  });
});

describe('a second look at the output', () => {
  it('formats a first-import summary with counts', async () => {
    const r = importSheet(fresh(), await inputFrom(), { now: T0 });
    const text = formatSummary(r, { dryRun: true });
    assert.match(text, /^Dry run, nothing written\. Imported: 5 shots, 3 cards, 3 scenes, 0 lines \(0 shots carry a line\); bible: 3 characters, 2 locations, 3 styles\./);
  });
});
