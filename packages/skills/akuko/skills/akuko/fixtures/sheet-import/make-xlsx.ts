/**
 * A minimal `.xlsx` writer for tests (WP-25): a real zip with the parts a
 * workbook needs (`[Content_Types].xml`, `xl/workbook.xml`, its rels, shared
 * strings, one sheet per table). Strings go through the shared-string table,
 * except cells given as `{ inline }`; a `{ formula }` cell has a formula and no
 * saved value (as openpyxl writes it); numbers are stored as numbers.
 * Synthetic: used to build stand-ins for a real sheet, never to copy one.
 */

import { deflateRawSync } from 'node:zlib';

export type Cell = string | number | { inline: string } | { formula: string } | { time: number; custom?: boolean } | null;
export interface SheetData { name: string; rows: Cell[][] }

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colLetters(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zip(files: { name: string; data: Uint8Array; store?: boolean }[], descriptor = false): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data);
    const body = f.store ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(descriptor ? 8 : 0, 6); local.writeUInt16LE(f.store ? 0 : 8, 8);
    if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); }
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    let extra = 0;
    if (descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4); d.writeUInt32LE(body.length, 8); d.writeUInt32LE(raw.length, 12);
      parts.push(d);
      extra = d.length;
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(descriptor ? 8 : 0, 8); c.writeUInt16LE(f.store ? 0 : 8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length + extra;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

/** `descriptor`: write every zip entry with a data descriptor (sizes after the data), as streaming writers do. */
export function makeXlsx(sheets: SheetData[], opts: { descriptor?: boolean } = {}): Uint8Array {
  const strings: string[] = [];
  const sst = (s: string): number => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  const enc = (s: string) => new TextEncoder().encode(s);
  const sheetXml = (sh: SheetData): string => {
    const rows = sh.rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = `${colLetters(c)}${r + 1}`;
        if (v === null || v === '') return '';
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        if (typeof v === 'string') return `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
        if ('time' in v) return `<c r="${ref}" s="${v.custom ? 2 : 1}"><v>${v.time}</v></c>`;
        if ('inline' in v) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v.inline)}</t></is></c>`;
        return `<c r="${ref}"><f>${xml(v.formula)}</f></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };
  const sheetFiles = sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(sh)) }));
  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join('')}</sst>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="mm:ss.00"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="21" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>';
  return zip([
    { name: '[Content_Types].xml', data: enc('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), store: true },
    { name: '_rels/.rels', data: enc('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: enc(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc(rels) },
    { name: 'xl/sharedStrings.xml', data: enc(sharedXml) },
    { name: 'xl/styles.xml', data: enc(styles) },
    ...sheetFiles,
  ], opts.descriptor === true);
}

/** Rows as CSV text (quotes where needed). */
export function toCsv(rows: Cell[][]): string {
  const q = (v: Cell): string => {
    const s = v === null ? '' : typeof v === 'object' ? ('inline' in v ? v.inline : '') : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(q).join(',')).join('\n')}\n`;
}
