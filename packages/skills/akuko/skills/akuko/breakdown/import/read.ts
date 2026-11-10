/**
 * akuko — read a shot list (WP-25): `.xlsx` and `.csv`, no dependency.
 *
 * An `.xlsx` is a zip of XML parts. This reads the zip's central directory,
 * inflates the parts with `node:zlib`, and parses just what a table needs:
 * `workbook.xml` (sheet names), its rels, `sharedStrings.xml` and each sheet's
 * cells. Formula cells keep their **saved value**; a file written by a library
 * that saves none (openpyxl) gives an empty cell, and the importer rebuilds the
 * value from the other columns. Rich text is flattened; styles, merges, dates
 * and number formats are ignored (a number is kept as the text the file holds).
 */

import { inflateRawSync } from 'node:zlib';

export class ReadError extends Error {
  override name = 'ReadError';
}

// ── zip ──────────────────────────────────────────────────────────────────

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Entries of a zip, by name, read from its central directory. */
export function readZip(buf: Uint8Array): Map<string, () => Uint8Array> {
  let eocd = -1;
  for (let o = buf.length - 22; o >= Math.max(0, buf.length - 22 - 65535); o--) {
    if (u32(buf, o) === 0x06054b50) { eocd = o; break; }
  }
  if (eocd < 0) throw new ReadError('not a zip file (this is not an .xlsx)');
  const count = u16(buf, eocd + 10);
  let o = u32(buf, eocd + 16);
  if (count === 0xffff || o === 0xffffffff) throw new ReadError('zip64 workbooks are not supported');
  const out = new Map<string, () => Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (u32(buf, o) !== 0x02014b50) throw new ReadError('the zip directory is damaged');
    const method = u16(buf, o + 10);
    const comp = u32(buf, o + 20);
    const nameLen = u16(buf, o + 28);
    const extraLen = u16(buf, o + 30);
    const commentLen = u16(buf, o + 32);
    const local = u32(buf, o + 42);
    const name = new TextDecoder().decode(buf.subarray(o + 46, o + 46 + nameLen));
    out.set(name, () => {
      if (u32(buf, local) !== 0x04034b50) throw new ReadError(`the zip entry ${name} is damaged`);
      const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
      const data = buf.subarray(start, start + comp);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new ReadError(`the zip entry ${name} uses compression method ${method}, which is not supported`);
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── xml helpers ──────────────────────────────────────────────────────────

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITY[e] ?? m;
  });
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]!) : undefined;
};

/** The text of every `<t>` in a fragment, skipping phonetic runs. */
function textOf(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) s += decodeXml(m[1] ?? '');
  return s;
}

/** `A` is 0, `AA` is 26. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ── workbook ─────────────────────────────────────────────────────────────

/** A sheet as rows of text: `rows[r - 1][c - 1]` is the cell at row `r`, column `c`; rows can be short. */
export interface Sheet {
  name: string;
  rows: string[][];
}

const utf8 = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);

export function readXlsx(buf: Uint8Array): Sheet[] {
  const zip = readZip(buf);
  const part = (name: string): string | undefined => {
    const f = zip.get(name);
    return f ? utf8(f()) : undefined;
  };
  const workbook = part('xl/workbook.xml');
  if (workbook === undefined) throw new ReadError('xl/workbook.xml is missing (this is not an .xlsx workbook)');

  const rels = new Map<string, string>();
  for (const m of (part('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id !== undefined && target !== undefined) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const shared: string[] = [];
  for (const m of (part('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(textOf(m[1] ?? ''));

  const sheets: Sheet[] = [];
  let n = 0;
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    n++;
    const name = attr(m[1]!, 'name') ?? `Sheet${n}`;
    const rid = attr(m[1]!, 'r:id');
    const path = (rid !== undefined ? rels.get(rid) : undefined) ?? `xl/worksheets/sheet${n}.xml`;
    const xml = part(path);
    if (xml === undefined) throw new ReadError(`sheet "${name}" points at ${path}, which is not in the file`);
    sheets.push({ name, rows: readCells(xml, shared) });
  }
  return sheets;
}

function readCells(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let nextRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = attr(rm[1]!, 'r');
    const rowIdx = r !== undefined ? Number(r) - 1 : nextRow;
    nextRow = rowIdx + 1;
    const cells: string[] = (rows[rowIdx] ??= []);
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1]!, 'r');
      const col = ref !== undefined ? columnIndex(/^[A-Za-z]+/.exec(ref)?.[0] ?? 'A') : nextCol;
      nextCol = col + 1;
      const type = attr(cm[1]!, 't');
      const body = cm[2] ?? '';
      let value = '';
      if (type === 'inlineStr') value = textOf(body);
      else {
        const v = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') value = '';
          else value = decodeXml(v);
        }
      }
      cells[col] = value;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] ??= []);
    for (let c = 0; c < row.length; c++) row[c] ??= '';
  }
  return rows;
}

// ── csv ──────────────────────────────────────────────────────────────────

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let any = false;
  const endRow = () => {
    if (any || row.length > 0 || field !== '') { row.push(field); rows.push(row); }
    row = []; field = ''; any = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') { quoted = true; any = true; }
    else if (ch === ',') { row.push(field); field = ''; any = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (quoted) throw new ReadError('the CSV has an unclosed quote');
  endRow();
  return rows;
}

// ── tables ───────────────────────────────────────────────────────────────

export interface TableRow {
  /** 1-based row in the file (CSV line or spreadsheet row). */
  row: number;
  cells: string[];
}

/** A header row and the rows under it. Blank rows are dropped; `row` keeps the original number. */
export interface Table {
  name: string;
  headers: string[];
  rows: TableRow[];
}

export function tableOf(name: string, grid: string[][]): Table {
  const headerAt = grid.findIndex((r) => r !== undefined && r.some((c) => c.trim() !== ''));
  if (headerAt < 0) return { name, headers: [], rows: [] };
  const rows: TableRow[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells && cells.some((c) => c.trim() !== '')) rows.push({ row: i + 1, cells });
  }
  return { name, headers: grid[headerAt]!.map((h) => h.trim()), rows };
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Index of the column a mapping names: exact (case and spacing aside), else a header that starts with it. -1 when none. */
export function columnOf(t: Table, names: string | string[] | undefined): number {
  if (names === undefined) return -1;
  const want = (Array.isArray(names) ? names : [names]).map(norm);
  const heads = t.headers.map(norm);
  for (const w of want) { const i = heads.indexOf(w); if (i >= 0) return i; }
  for (const w of want) { const i = heads.findIndex((h) => h !== '' && h.startsWith(w)); if (i >= 0) return i; }
  return -1;
}

/** A table by sheet name (case-insensitive) out of a workbook. */
export function sheetTable(sheets: Sheet[], name: string): Table | undefined {
  const s = sheets.find((x) => norm(x.name) === norm(name));
  return s ? tableOf(s.name, s.rows) : undefined;
}

// ── film time ────────────────────────────────────────────────────────────

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** `mm:ss.ss`, `h:mm:ss.ss`, or plain seconds, to seconds (to a microsecond). `undefined` for anything else. */
export function parseFilmTime(s: string): number | undefined {
  const t = s.trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return round6(Number(t));
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return undefined;
  const sec = Number(m[3]);
  if (sec >= 60) return undefined;
  return round6(Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + sec);
}

/** Seconds as `mm:ss.ss` (hours folded into minutes), for messages and tables. */
export function formatFilmTime(s: number): string {
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  const rest = cs - m * 6000;
  return `${String(m).padStart(2, '0')}:${String(Math.floor(rest / 100)).padStart(2, '0')}.${String(rest % 100).padStart(2, '0')}`;
}
