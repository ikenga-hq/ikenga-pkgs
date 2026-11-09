/**
 * A small DTD validator for the tests (WP-23), enough to check FCPXML against Apple's own
 * `FCPXMLv1_8.dtd` without `xmllint` (which Windows does not have): parameter entities, element
 * content models (sequence, choice, `? * +`, EMPTY, #PCDATA), attribute lists (CDATA, ID, IDREF,
 * enumerations, #REQUIRED, #FIXED), ID uniqueness and IDREF resolution.
 *
 * Apple's DTD is not stored in this repo (it is Apple's file). A test that needs it reads the path from
 * `AKUKO_FCPXML_DTD` and is skipped when that is not set.
 */

import type { XmlNode } from './xml.ts';

interface AttDef { type: string; mode: 'required' | 'implied' | 'fixed' | 'default'; value?: string }

export interface Dtd {
  elements: Map<string, { model: string }>;
  attrs: Map<string, Map<string, AttDef>>;
}

export function parseDtd(src: string): Dtd {
  let text = src.replace(/<!--[\s\S]*?-->/g, ' ');
  const ents = new Map<string, string>();
  for (const m of text.matchAll(/<!ENTITY\s+%\s+([\w.-]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g)) ents.set(m[1]!, m[2] ?? m[3] ?? '');
  text = text.replace(/<!ENTITY[\s\S]*?>/g, ' ');
  for (let n = 0; n < 20 && /%[\w.-]+;/.test(text); n++) {
    text = text.replace(/%([\w.-]+);/g, (m, name: string) => ents.get(name) ?? m);
  }
  const elements = new Map<string, { model: string }>();
  for (const m of text.matchAll(/<!ELEMENT\s+([\w.-]+)\s+([\s\S]*?)>/g)) elements.set(m[1]!, { model: m[2]!.trim() });
  const attrs = new Map<string, Map<string, AttDef>>();
  for (const m of text.matchAll(/<!ATTLIST\s+([\w.-]+)\s+([\s\S]*?)>/g)) {
    const map = attrs.get(m[1]!) ?? new Map<string, AttDef>();
    attrs.set(m[1]!, map);
    const re = /([\w.:-]+)\s+(\([^)]*\)|[A-Z]+)\s+(#REQUIRED|#IMPLIED|#FIXED\s+(?:"[^"]*"|'[^']*')|"[^"]*"|'[^']*')/g;
    for (const a of m[2]!.matchAll(re)) {
      const d = a[3]!;
      const q = (s: string): string => s.slice(1, -1);
      const def: AttDef = d === '#REQUIRED' ? { type: a[2]!, mode: 'required' } : d === '#IMPLIED' ? { type: a[2]!, mode: 'implied' } : d.startsWith('#FIXED') ? { type: a[2]!, mode: 'fixed', value: q(d.replace(/^#FIXED\s+/, '')) } : { type: a[2]!, mode: 'default', value: q(d) };
      map.set(a[1]!, def);
    }
  }
  return { elements, attrs };
}

/** Compile a content model into a regex over child names, each followed by a space. */
function modelRegex(model: string): RegExp | 'EMPTY' | 'ANY' | 'TEXT' {
  if (model === 'EMPTY') return 'EMPTY';
  if (model === 'ANY') return 'ANY';
  if (model.includes('#PCDATA')) return 'TEXT';
  let i = 0;
  const ws = (): void => {
    while (/\s/.test(model[i] ?? '')) i++;
  };
  const quant = (s: string): string => {
    const q = model[i];
    if (q === '?' || q === '*' || q === '+') {
      i++;
      return `(?:${s})${q}`;
    }
    return s;
  };
  const unit = (): string => {
    ws();
    if (model[i] === '(') {
      i++;
      const parts: string[] = [];
      let sep = '';
      for (;;) {
        parts.push(unit());
        ws();
        const c = model[i];
        if (c === ')') {
          i++;
          break;
        }
        if (c !== ',' && c !== '|') throw new Error(`bad content model ${model}`);
        sep = c;
        i++;
      }
      return quant(`(?:${parts.join(sep === '|' ? '|' : '')})`);
    }
    const m = /^[\w.-]+/.exec(model.slice(i));
    if (!m) throw new Error(`bad content model ${model}`);
    i += m[0].length;
    return quant(`(?:${m[0]} )`);
  };
  const re = unit();
  return new RegExp(`^${re}$`);
}

export function validate(root: XmlNode, dtd: Dtd): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const refs: Array<{ el: string; attr: string; id: string }> = [];
  const cache = new Map<string, ReturnType<typeof modelRegex>>();
  const visit = (n: XmlNode, path: string): void => {
    const here = `${path}/${n.name}`;
    const decl = dtd.elements.get(n.name);
    if (!decl) {
      errors.push(`${here}: <${n.name}> is not in the DTD`);
      return;
    }
    const defs = dtd.attrs.get(n.name) ?? new Map<string, AttDef>();
    for (const [a, v] of Object.entries(n.attrs)) {
      const d = defs.get(a);
      if (!d) {
        errors.push(`${here}: attribute ${a} is not declared`);
        continue;
      }
      if (d.type.startsWith('(') && !d.type.slice(1, -1).split('|').map((x) => x.trim()).includes(v)) errors.push(`${here}: ${a}="${v}" is not one of ${d.type}`);
      if (d.mode === 'fixed' && d.value !== v) errors.push(`${here}: ${a} must be "${d.value}"`);
      if (d.type === 'ID') {
        if (ids.has(v)) errors.push(`${here}: duplicate ID ${v}`);
        ids.add(v);
      }
      if (d.type === 'IDREF') refs.push({ el: here, attr: a, id: v });
    }
    for (const [a, d] of defs) if (d.mode === 'required' && !(a in n.attrs)) errors.push(`${here}: required attribute ${a} is missing`);
    let m = cache.get(n.name);
    if (m === undefined) {
      m = modelRegex(decl.model);
      cache.set(n.name, m);
    }
    const kids = n.children.map((c) => `${c.name} `).join('');
    if (m === 'EMPTY' && n.children.length > 0) errors.push(`${here}: must be empty`);
    else if (m instanceof RegExp && !m.test(kids)) errors.push(`${here}: children "${kids.trim()}" do not fit ${decl.model}`);
    for (const c of n.children) visit(c, here);
  };
  visit(root, '');
  for (const r of refs) if (!ids.has(r.id)) errors.push(`${r.el}: ${r.attr}="${r.id}" refers to nothing`);
  return errors;
}
