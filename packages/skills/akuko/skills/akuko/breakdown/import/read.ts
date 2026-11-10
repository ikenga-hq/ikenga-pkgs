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

/** No part of a workbook is unpacked past this size (a zip bomb stops here). */
export const MAX_PART_BYTES = 64 * 1024 * 1024;

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
    const uncomp = u32(buf, o + 24);
    const nameLen = u16(buf, o + 28);
    const extraLen = u16(buf, o + 30);
    const commentLen = u16(buf, o + 32);
    const local = u32(buf, o + 42);
    const name = new TextDecoder().decode(buf.subarray(o + 46, o + 46 + nameLen));
    if (comp === 0xffffffff || uncomp === 0xffffffff || local === 0xffffffff) throw new ReadError(`the zip entry ${name} is a zip64 entry, which is not supported`);
    out.set(name, () => {
      if (u32(buf, local) !== 0x04034b50) throw new ReadError(`the zip entry ${name} is damaged`);
      const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
      const data = buf.subarray(start, start + comp);
      if (method === 0) return data;
      if (method === 8) {
        try {
          return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES });
        } catch (e) {
          throw new ReadError(`the zip entry ${name} could not be unpacked (damaged, or larger than ${MAX_PART_BYTES / 1024 / 1024} MB): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
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

/**
 * A sheet as rows of text: `rows[r - 1][c - 1]` is the cell at row `r`, column `c`; rows can be short.
 * `kinds` runs alongside: `n` marks a number cell, `d` a number cell whose style is a date or time
 * format (Excel stores those as a fraction of a day); a text cell has no mark.
 */
export interface Sheet {
  name: string;
  rows: string[][];
  kinds?: string[][];
}

const utf8 = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

/** A relationship target as a zip path, resolved from the part that holds the rels. */
function resolveTarget(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${fromDir}${target}`.split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

function relsOf(xml: string | undefined, fromDir: string): { id: string; type: string; path: string }[] {
  const out: { id: string; type: string; path: string }[] = [];
  for (const m of (xml ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const type = attr(m[1]!, 'Type');
    const target = attr(m[1]!, 'Target');
    if (id !== undefined && type !== undefined && target !== undefined) out.push({ id, type, path: resolveTarget(fromDir, target) });
  }
  return out;
}

const NAMESPACED = /<[A-Za-z][\w-]*:(?:sheetData|row|c|sheet|si|cellXfs|xf)[\s>/]/;

/** Built-in number formats that show a date or a time (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** True when a custom format code shows a date or time (a d, m, y, h or s outside quotes, brackets and escapes). */
function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '');
  return /[dmyhs]/i.test(bare);
}

/** For each cell style (`s`), whether its number format is a date or time. */
function dateStyles(styles: string | undefined): boolean[] {
  if (styles === undefined) return [];
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = attr(m[1]!, 'numFmtId');
    const code = attr(m[1]!, 'formatCode');
    if (id !== undefined && code !== undefined) custom.set(Number(id), code);
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const out: boolean[] = [];
  for (const m of block.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(attr(m[1]!, 'numFmtId') ?? 0);
    const code = custom.get(id);
    out.push(code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id));
  }
  return out;
}

export function readXlsx(buf: Uint8Array): Sheet[] {
  const zip = readZip(buf);
  const part = (name: string): string | undefined => {
    const f = zip.get(name);
    return f ? utf8(f()) : undefined;
  };
  // the workbook part, from the package rels (the usual path when they are missing)
  const root = relsOf(part('_rels/.rels'), '').find((r) => r.type === `${REL_BASE}officeDocument`);
  const bookPath = root?.path ?? 'xl/workbook.xml';
  const workbook = part(bookPath);
  if (workbook === undefined) throw new ReadError(`${bookPath} is missing (this is not an .xlsx workbook)`);
  if (NAMESPACED.test(workbook)) throw new ReadError('this workbook uses prefixed XML names (<x:sheet>), which are not supported; save it again from Excel or LibreOffice as .xlsx');

  const dir = bookPath.includes('/') ? `${bookPath.slice(0, bookPath.lastIndexOf('/'))}/` : '';
  const rels = relsOf(part(`${dir}_rels/${bookPath.slice(bookPath.lastIndexOf('/') + 1)}.rels`), dir);
  const byId = new Map(rels.map((r) => [r.id, r.path]));
  const sharedPath = rels.find((r) => r.type === `${REL_BASE}sharedStrings`)?.path ?? `${dir}sharedStrings.xml`;
  const stylesPath = rels.find((r) => r.type === `${REL_BASE}styles`)?.path ?? `${dir}styles.xml`;

  const sharedXml = part(sharedPath) ?? '';
  if (NAMESPACED.test(sharedXml)) throw new ReadError('the shared strings use prefixed XML names, which are not supported');
  const shared: string[] = [];
  for (const m of sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(textOf(m[1] ?? ''));
  const isDate = dateStyles(part(stylesPath));

  const sheets: Sheet[] = [];
  let n = 0;
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    n++;
    const name = attr(m[1]!, 'name') ?? `Sheet${n}`;
    const rid = attr(m[1]!, 'r:id');
    const path = (rid !== undefined ? byId.get(rid) : undefined) ?? `${dir}worksheets/sheet${n}.xml`;
    const xml = part(path);
    if (xml === undefined) throw new ReadError(`sheet "${name}" points at ${path}, which is not in the file`);
    if (NAMESPACED.test(xml)) throw new ReadError(`sheet "${name}" uses prefixed XML names (<x:c>), which are not supported; save the file again from Excel or LibreOffice as .xlsx`);
    const { rows, kinds } = readCells(xml, shared, isDate);
    sheets.push({ name, rows, kinds });
  }
  return sheets;
}

function readCells(xml: string, shared: string[], isDate: boolean[]): { rows: string[][]; kinds: string[][] } {
  const rows: string[][] = [];
  const kinds: string[][] = [];
  let nextRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = attr(rm[1]!, 'r');
    const rowIdx = r !== undefined ? Number(r) - 1 : nextRow;
    nextRow = rowIdx + 1;
    const cells: string[] = (rows[rowIdx] ??= []);
    const marks: string[] = (kinds[rowIdx] ??= []);
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1]!, 'r');
      const col = ref !== undefined ? columnIndex(/^[A-Za-z]+/.exec(ref)?.[0] ?? 'A') : nextCol;
      nextCol = col + 1;
      const type = attr(cm[1]!, 't');
      const body = cm[2] ?? '';
      let value = '';
      let kind = '';
      if (type === 'inlineStr') value = textOf(body);
      else {
        const v = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') value = '';
          else if (type === 'str') value = decodeXml(v);
          else {
            value = decodeXml(v);
            const s = attr(cm[1]!, 's');
            kind = s !== undefined && isDate[Number(s)] === true ? 'd' : 'n';
          }
        }
      }
      cells[col] = value;
      marks[col] = kind;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] ??= []);
    const marks = (kinds[i] ??= []);
    for (let c = 0; c < row.length; c++) { row[c] ??= ''; marks[c] ??= ''; }
  }
  return { rows, kinds };
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
    } else if (ch === '"' && field === '') { quoted = true; any = true; }
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
  /** Per cell (xlsx only): "n" a number cell, "d" a date or time cell, empty for text. */
  kinds?: string[];
}

/** A header row and the rows under it. Blank rows are dropped; `row` keeps the original number. */
export interface Table {
  name: string;
  headers: string[];
  rows: TableRow[];
}

export function tableOf(name: string, grid: string[][], kinds?: string[][]): Table {
  const headerAt = grid.findIndex((r) => r !== undefined && r.some((c) => c.trim() !== ''));
  if (headerAt < 0) return { name, headers: [], rows: [] };
  const rows: TableRow[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells && cells.some((c) => c.trim() !== '')) rows.push({ row: i + 1, cells, ...(kinds?.[i] && { kinds: kinds[i] }) });
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
  return s ? tableOf(s.name, s.rows, s.kinds) : undefined;
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
  if (m[1] !== undefined && Number(m[2]) >= 60) return undefined;
  return round6(Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + sec);
}

/** Seconds as `mm:ss.ss` (hours folded into minutes), for messages and tables. */
export function formatFilmTime(s: number): string {
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  const rest = cs - m * 6000;
  return `${String(m).padStart(2, '0')}:${String(Math.floor(rest / 100)).padStart(2, '0')}.${String(rest % 100).padStart(2, '0')}`;
}
