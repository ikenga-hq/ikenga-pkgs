/**
 * A synthetic shot list with the same SHAPE as a real project's (WP-25): a
 * Tokens sheet, a Lighting sheet, a Shot List with ready-made rows, a REF shot,
 * an as-is prompt, a SPLIT note, a gap at the start of a scene, and two lines in
 * one cell; plus a quotes file and a small master WAV. Everything is invented.
 */

import { writeFile } from 'node:fs/promises';
import { makeXlsx, toCsv, type Cell, type SheetData } from './make-xlsx.ts';

export const TOKENS: Cell[][] = [
  ['Token', 'Expands to', 'Type/note'],
  ['ADA-NOW', 'a woman in her sixties, silver braid, green coat', 'Character'],
  ['ADA', 'the same woman at twenty, dark braid, yellow raincoat', 'Character'],
  ['BO', 'a small grey dog with one white ear', 'Character'],
  ['HARBOR', 'a quiet harbour at the water\'s edge', 'Location'],
  ['KITCHEN', 'a narrow kitchen with a tin kettle', 'Location'],
  ['NEGATIVE', 'text, captions, logos, extra fingers', 'Applies to every shot'],
  ['STYLE BLOCK', 'soft film grain, muted palette, 35mm', 'Appended to every shot'],
];

export const LIGHTING: Cell[][] = [
  ['Code', 'Phrase', 'Use for'],
  ['L-DAWN', 'pale dawn light through haze', 'Exteriors'],
  ['L-LAMP', 'warm lamplight, deep shadows', 'Interiors'],
];

export const SHOT_HEADERS: string[] = [
  'Shot ID', 'Scene', 'Core/Ext', 'Raw TC', 'Narration cue', 'Sec (film)', 'Tier', 'Framing', 'Shot prompt (with tokens)', 'Motion',
  'Characters', 'Location', 'Full prompt (auto)', 'Status', 'Version', 'Select file', 'Credits $', 'Approved', 'Notes', 'Film In', 'Film Out',
  'Part', 'Lighting', 'Lip-sync lines', 'Ref moment',
];

type Row = {
  id: string; scene: string; cue?: string; secs?: number; tier?: string; framing?: string; prompt: string; motion?: string;
  chars?: string; loc?: string; status?: string; notes?: string; in: string; out: string; part: string; light?: string; lines?: string; ref?: string;
};

/** One sheet row in the column order of `SHOT_HEADERS`. Column M is a formula with no saved value. */
export function shotRow(r: Row): Cell[] {
  return [
    r.id, r.scene, 'Core', '0:00', r.cue ?? null, r.secs ?? null, r.tier ?? null, r.framing ?? null, r.prompt, r.motion ?? null,
    r.chars ?? null, r.loc ?? null, { formula: `IF(LEFT(I2,1)="(",I2,I2&", "&VLOOKUP(W2,Lighting!A:B,2,0))` }, r.status ?? 'queued', null, null, null, null,
    r.notes ?? null, { inline: r.in }, { inline: r.out }, r.part, r.light ?? null, r.lines ?? null, r.ref ?? null,
  ];
}

export const SHOT_ROWS: Row[] = [
  { id: 'S00-010', scene: 'S00', cue: 'The pier at first light.', secs: 4.5, tier: 'B', framing: 'MS', prompt: '[ADA-NOW] stands at the end of the pier', motion: 'Slow push-in', chars: 'ADA-NOW', loc: 'HARBOR', in: '00:00.00', out: '00:04.50', part: 'Cold open', light: 'L-DAWN' },
  { id: 'S00-020', scene: 'CARD', prompt: '(Title card, white on black)', framing: '—', status: 'n/a', in: '00:04.50', out: '00:07.50', part: 'Cold open' },
  // scene S01 starts after a gap (07.50 to 08.00)
  { id: 'S01-010', scene: 'S01', secs: 4, tier: 'A', framing: 'CU', prompt: '[ADA] and [BO] in the [KITCHEN]', motion: 'Hold', chars: 'ADA, BO', loc: 'KITCHEN', in: '00:08.00', out: '00:12.00', part: 'P1', light: 'L-LAMP', lines: 'Q1 Ada (spoken)' },
  { id: 'S01-020', scene: 'S01', secs: 8.5, tier: 'C', framing: 'Insert', prompt: '(Insert of a tin cup on the sill, used as written)', motion: 'Lateral drift', loc: 'KITCHEN', notes: 'SPLIT', in: '00:12.00', out: '00:20.50', part: 'P1', light: 'L-LAMP', lines: 'Q2 Ada (thought)' },
  { id: 'S01-030', scene: 'S01', secs: 9.5, tier: 'B', framing: 'MS', prompt: '[ADA] hands [BO] a crust', motion: 'Slow pull-back', chars: 'ADA, BO', loc: 'KITCHEN', in: '00:20.50', out: '00:30.00', part: 'P1', light: 'L-LAMP', lines: 'Q3 Bo (spoken); Q4 Ada (thought)' },
  { id: 'P2-CARD', scene: 'CARD', prompt: '(Part card)', status: 'n/a', in: '00:30.00', out: '00:34.00', part: 'P2' },
  { id: 'S02-010', scene: 'S02', secs: 6, tier: 'B', framing: 'WS', prompt: '[ADA] at a window, a reference still', chars: 'ADA', loc: 'KITCHEN', in: '00:34.00', out: '00:40.00', part: 'P2', light: 'REF', ref: 'REF-window' },
  { id: 'CREDITS-010', scene: 'CREDITS', prompt: '(Rolling credits)', status: 'n/a', in: '00:40.00', out: '00:48.00', part: 'Credits' },
];

export const MASTER_SECONDS = 48;
export const SAMPLE_RATE = 8000;

export const QUOTE_HEADERS: string[] = ['id', 'character', 'kind', 'scene', 'film_in', 'film_out', 'tc_in_24fps', 'tc_out_24fps', 'frame_in', 'frame_out', 'length_s', 'line', 'context', 'clip', 'word_times'];
export const QUOTES: Cell[][] = [
  QUOTE_HEADERS,
  ['Q1', 'Ada', 'spoken', 'S01', '00:08.40', '00:10.20', '', '', '', '', 1.8, 'Put the kettle on.', '', 'Q1_00m08s_Ada.wav', 'Put@8.40 the@8.80 kettle@9.10 on.@9.70'],
  ['Q2', 'Ada', 'thought', 'S01', '00:13.00', '00:15.00', '', '', '', '', 2, 'He never asked.', '', 'Q2_00m13s_Ada.wav', 'He@13.00 never@13.40 asked.@14.10'],
  ['Q3', 'Bo', 'spoken', 'S01', '00:21.00', '00:22.50', '', '', '', '', 1.5, 'Woof, said the dog.', '', 'Q3_00m21s_Bo.wav', 'Woof,@21.00 said@21.60 the@21.90 dog.@22.10'],
  ['Q4', 'Ada', 'thought', 'S01', '00:25.00', '00:27.00', '', '', '', '', 2, 'Quiet now.', '', 'Q4_00m25s_Ada.wav', 'Quiet@25.00 now.@25.80'],
];

export function workbook(rows: Row[] = SHOT_ROWS): SheetData[] {
  return [
    { name: 'Read Me', rows: [['Notes for the team, not data.']] },
    { name: 'Tokens', rows: TOKENS },
    { name: 'Lighting', rows: LIGHTING },
    { name: 'Shot List', rows: [SHOT_HEADERS, ...rows.map(shotRow)] },
    { name: 'Benchmark', rows: [['Date', 'Note']] },
  ];
}

export const xlsx = (rows: Row[] = SHOT_ROWS): Uint8Array => makeXlsx(workbook(rows));

/** The shot sheet as CSV (formula cells are empty in a CSV export of an unsaved value, as in the workbook). */
export const shotCsv = (rows: Row[] = SHOT_ROWS): string => toCsv([SHOT_HEADERS, ...rows.map(shotRow)]);
export const tokensCsv = (): string => toCsv(TOKENS);
export const lightingCsv = (): string => toCsv(LIGHTING);
export const quotesCsv = (): string => toCsv(QUOTES);

/** A silent mono 24-bit WAV (only the header is meaningful; the data chunk is zeros). */
export async function writeWav(path: string, seconds: number, rate = SAMPLE_RATE, opts: { badDataSize?: boolean } = {}): Promise<void> {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 3);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 3, 28); head.writeUInt16LE(3, 32); head.writeUInt16LE(24, 34);
  head.write('data', 36, 'latin1'); head.writeUInt32LE(opts.badDataSize ? 0xffffffff : data.length, 40);
  await writeFile(path, Buffer.concat([head, data]));
}

export type { Row as SheetRow };
