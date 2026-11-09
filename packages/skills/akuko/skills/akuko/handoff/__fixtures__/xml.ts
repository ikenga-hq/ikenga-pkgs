/**
 * A small XML reader for the tests (WP-23): elements, attributes, comments, the XML declaration and
 * DOCTYPE. FCPXML written by akuko has no text content, so none is kept. Rejects anything malformed
 * (unclosed or mismatched tags, a bad attribute, a bare `&`), which is the point.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
    const v = ENTITIES[e];
    if (v === undefined) throw new Error(`unknown entity ${m}`);
    return v;
  });

export function parseXml(text: string): XmlNode {
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`XML error at ${i}: ${msg}`);
  };
  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const after = (marker: string): number => {
    const at = text.indexOf(marker, i);
    if (at < 0) fail(`unterminated ${marker}`);
    return at + marker.length;
  };
  const misc = (): void => {
    for (;;) {
      skipWs();
      if (text.startsWith('<?', i)) i = after('?>');
      else if (text.startsWith('<!--', i)) i = after('-->');
      else if (text.startsWith('<!DOCTYPE', i)) i = after('>');
      else return;
    }
  };
  const element = (): XmlNode => {
    if (text[i] !== '<') fail('expected <');
    i++;
    const nm = /^[A-Za-z_][\w.:-]*/.exec(text.slice(i));
    if (!nm) return fail('bad element name');
    const node: XmlNode = { name: nm[0], attrs: {}, children: [] };
    i += nm[0].length;
    for (;;) {
      skipWs();
      if (text.startsWith('/>', i)) {
        i += 2;
        return node;
      }
      if (text[i] === '>') {
        i++;
        break;
      }
      const am = /^([A-Za-z_][\w.:-]*)\s*=\s*"([^"<]*)"/.exec(text.slice(i));
      if (!am) return fail(`bad attribute in <${node.name}>`);
      if (am[1]! in node.attrs) fail(`duplicate attribute ${am[1]}`);
      node.attrs[am[1]!] = unescape(am[2]!);
      i += am[0].length;
    }
    for (;;) {
      const lt = text.indexOf('<', i);
      if (lt < 0) return fail(`<${node.name}> is never closed`);
      const between = text.slice(i, lt);
      if (between.trim() !== '') fail(`unexpected text in <${node.name}>`);
      i = lt;
      if (text.startsWith('</', i)) {
        const close = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(text.slice(i));
        if (!close || close[1] !== node.name) return fail(`</${close?.[1] ?? '?'}> closes <${node.name}>`);
        i += close[0].length;
        return node;
      }
      if (text.startsWith('<!--', i)) {
        i = after('-->');
        continue;
      }
      node.children.push(element());
    }
  };
  misc();
  const root = element();
  misc();
  if (i !== text.length) fail('content after the root element');
  return root;
}

export const find = (n: XmlNode, name: string): XmlNode[] => n.children.filter((c) => c.name === name);
export const walk = (n: XmlNode, fn: (x: XmlNode, parent?: XmlNode) => void, parent?: XmlNode): void => {
  fn(n, parent);
  for (const c of n.children) walk(c, fn, n);
};
