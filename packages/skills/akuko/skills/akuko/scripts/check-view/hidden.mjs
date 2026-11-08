// When is something "shown"? (R2 money never hidden, R3 summary visible, R5 readability floor.)
// jsdom does no layout, so these read the cascaded styles and catch every
// common way of hiding text without removing it (G-VIEW review C6).

const WIDTH = 1440;
const HEIGHT = 900;
const KEYWORD_PX = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48, smaller: 13, larger: 19 };

/** A CSS length in px (at a 1440×900 viewport, 16px root), or null when it can't be known (var(), calc(), inherit…). */
export function cssPx(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '') return null;
  if (v in KEYWORD_PX) return KEYWORD_PX[v];
  const m = /^(-?[\d.]+)(px|pt|pc|em|rem|%|vw|vh|vmin|vmax|ch|ex|cm|mm|in|q)?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case undefined: return n === 0 ? 0 : null;
    case 'px': return n;
    case 'pt': return (n * 4) / 3;
    case 'pc': return n * 16;
    case 'em': case 'rem': return n * 16;
    case 'ch': case 'ex': return n * 8;
    case '%': return (n * 16) / 100;
    case 'vw': return (n * WIDTH) / 100;
    case 'vh': return (n * HEIGHT) / 100;
    case 'vmin': return (n * HEIGHT) / 100;
    case 'vmax': return (n * WIDTH) / 100;
    case 'cm': return (n * 96) / 2.54;
    case 'mm': return (n * 96) / 25.4;
    case 'q': return (n * 96) / 101.6;
    case 'in': return n * 96;
    default: return null;
  }
}

/** The font size a `font:` shorthand sets, e.g. "italic 600 10px/1.2 Inter" → "10px". */
function shorthandSize(value) {
  for (const tok of String(value).trim().split(/\s+/)) {
    const size = tok.split('/')[0];
    if (cssPx(size) !== null && !/^\d+$/.test(size)) return size; // a bare number here is a weight (600), not a size
    if (size === '0') return size;
  }
  return null;
}

/**
 * Replace each `var(--name[, fallback])` in a CSS value (G-VIEW hardening F4:
 * jsdom leaves var() unresolved). `lookup(name)` returns the custom
 * property's value, or null when it is not declared (then the fallback, if
 * any, is used). Nested references resolve to a small depth; whatever still
 * can't be resolved is left as written.
 */
export function substituteVars(value, lookup, depth = 0) {
  const v = String(value ?? '');
  if (depth > 8 || !/var\(/i.test(v)) return v;
  let out = '';
  let i = 0;
  for (;;) {
    const at = v.toLowerCase().indexOf('var(', i);
    if (at < 0) { out += v.slice(i); break; }
    out += v.slice(i, at);
    let j = at + 4;
    for (let level = 1; j < v.length && level > 0; j++) { if (v[j] === '(') level++; else if (v[j] === ')') level--; }
    const inner = v.slice(at + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    const got = /^--[\w-]+$/.test(name) ? lookup(name) : null;
    const use = got !== null && got !== undefined && String(got).trim() !== '' ? String(got).trim() : fallback;
    out += use === null ? v.slice(at, j) : substituteVars(use, lookup, depth + 1);
    i = j;
  }
  return out;
}

/** Every custom property declared in some CSS text (`--name: value`): name → its values, in source order. */
export function cssVars(text) {
  const out = new Map();
  for (const m of String(text).matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;}"'<>]+)/g)) {
    const list = out.get(m[1]) ?? [];
    list.push(m[2].trim());
    out.set(m[1], list);
  }
  return out;
}

/**
 * A static lookup over cssVars() for the readability floor: a token is judged
 * by the smallest text size it is ever given (any rule, any media query), so a
 * tiny value can't hide behind a normal one. Not a cascade, on purpose.
 */
function smallestLookup(vars) {
  const resolve = (name, seen) => {
    const list = vars.get(name);
    if (!list || list.length === 0 || seen.has(name)) return null;
    const next = new Set([...seen, name]);
    let best = null, bestPx = Infinity;
    for (const raw of list) {
      const px = cssPx(substituteVars(raw, (n) => resolve(n, next)));
      if (px !== null && px < bestPx) { best = raw; bestPx = px; }
    }
    return best ?? list[list.length - 1];
  };
  return (name) => resolve(name, new Set());
}

function sizesIn(decls, lookup = () => null) {
  const out = [];
  for (const m of decls.matchAll(/(?<![\w-])font-size\s*:\s*([^;}"'!<>]+)/gi)) {
    const px = cssPx(substituteVars(m[1], lookup).trim());
    if (px !== null && px < 12) out.push(m[1].trim());
  }
  for (const m of decls.matchAll(/(?<![-\w])font\s*:\s*([^;}"'!<>]+)/gi)) {
    const size = shorthandSize(substituteVars(m[1], lookup));
    const px = size === null ? null : cssPx(size);
    if (px !== null && px < 12) out.push(`font: ${m[1].trim()}`);
  }
  return out;
}

/**
 * Text sizes under the 12px floor in the page's style sheets, inline styles
 * and style strings in scripts. Rules for SVG text (selectors naming svg,
 * text or tspan, or a class the page puts on an <svg>) are skipped: their
 * sizes are viewBox units, scaled with the drawing.
 */
export function smallText(css, rest, html) {
  const svgClasses = new Set();
  for (const m of html.matchAll(/<svg\b[^>]*\bclass=\\?["']([^"'\\]+)/gi)) for (const c of m[1].split(/\s+/)) if (c) svgClasses.add(c);
  const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isSvgRule = (sel) => /(^|[\s>+~,(])(svg|text|tspan|textPath)\b/i.test(sel) || [...svgClasses].some((c) => new RegExp(`\\.${escape(c)}(?![\\w-])`).test(sel));
  // Custom properties (F4): `font-size: var(--x)` is judged by what --x is set to.
  const lookup = smallestLookup(cssVars(`${css}\n${rest}`));
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (!isSvgRule(m[1])) out.push(...sizesIn(m[2], lookup));
  out.push(...sizesIn(rest, lookup));
  return out;
}

const isTransparent = (c) => {
  const v = String(c ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (v === 'transparent') return true;
  let m = /^(?:rgba|hsla|rgb|hsl)\((.*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[,/]/);
    if (parts.length === 4) {
      const a = parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
      return Number.isFinite(a) && a < 0.05;
    }
    return false;
  }
  m = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(v);
  if (m) return m[1].length === 4 ? m[1][3] === '0' : m[1].slice(6) === '00' || parseInt(m[1].slice(6), 16) < 13;
  return false;
};

/** [r, g, b, a] (0–255, alpha 0–1) for #rgb[a], #rrggbb[aa] and rgb()/rgba(), else null. */
function parseColour(c) {
  const v = String(c ?? '').trim().toLowerCase().replace(/s+/g, ' ');
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    const h = m[1].length <= 4 ? [...m[1]].map((x) => x + x).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
  }
  m = /^rgba?(([^)]*))$/.exec(v);
  if (!m) return null;
  const p = m[1].split(/[s,/]+/).filter(Boolean);
  if (p.length < 3 || p.slice(0, 3).some((x) => !Number.isFinite(Number.parseFloat(x)))) return null;
  const ch = (x) => (x.endsWith('%') ? (Number.parseFloat(x) * 255) / 100 : Number.parseFloat(x));
  const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? Number.parseFloat(p[3]) / 100 : Number.parseFloat(p[3]);
  return [ch(p[0]), ch(p[1]), ch(p[2]), Number.isFinite(a) ? a : 1];
}

/** WCAG contrast ratio of two opaque colours. */
function contrast(a, b) {
  const lum = ([r, g, b2]) => [r, g, b2].map((x) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s2, c, i) => s2 + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** A translate() that moves the element off-screen (≤ −999px either way), as the off-screen offsets above. */
function translatedAway(t) {
  const s2 = String(t).trim().toLowerCase();
  for (const m of s2.matchAll(/translate(?:3d|x|y)?(([^)]*))/g)) for (const part of m[1].split(',')) { const px = cssPx(part.trim()); if (px !== null && px <= -999) return true; }
  return false;
}

const rawProp = (cs, name) => cs.getPropertyValue(name) || cs[name.replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] || '';
// jsdom cascades and inherits custom properties, but leaves var() unresolved
// in every other property: substitute from the element's computed custom
// properties before reading a length, colour or keyword (F4).
const prop = (cs, name) => substituteVars(rawProp(cs, name), (n) => cs.getPropertyValue(n) || null).trim();

function clipHides(v) {
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'none' || s === 'auto') return false;
  const inset = /^inset\(([^)]*)\)/.exec(s);
  if (inset) {
    const vals = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/).map((x) => (x.endsWith('%') ? Number(x.slice(0, -1)) : null));
    const [t, r = t, b = t, l = r] = vals;
    return [t, b].every((x) => x !== null) && t + b >= 100 || [l, r].every((x) => x !== null) && l + r >= 100;
  }
  if (/^(circle|ellipse)\(\s*0(px|%)?[\s)]/.test(s)) return true;
  return /^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s);
}

function scaledToZero(t) {
  const s = String(t).trim().toLowerCase();
  if (!s || s === 'none') return false;
  if (/scale[xy3d]?\(\s*0(\.0+)?\s*[,)]/.test(s) || /scale\(\s*[^,)]+,\s*0(\.0+)?\s*\)/.test(s)) return true;
  const m = /^matrix\(([^)]*)\)$/.exec(s);
  if (m) {
    const [a, b, c, d] = m[1].split(',').map(Number);
    return a * d - b * c === 0;
  }
  return false;
}

/** Why an element is not shown to the person, or null when it is. */
export function hiddenReason(w, el) {
  let colourSettled = false;
  let ink = null; // the text colour, once settled
  let ground = null; // the first opaque background behind the text
  let alpha = 1; // opacity compounds down the tree
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e.hidden) return 'hidden attribute';
    if (e.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    if (e.hasAttribute('inert')) return 'inert';
    if (e.tagName === 'DETAILS' && !e.open && e !== el && !el.closest('summary')) return 'inside a closed <details>';
    const cs = w.getComputedStyle(e);
    if (prop(cs, 'display') === 'none') return 'display: none';
    const vis = prop(cs, 'visibility');
    if (vis === 'hidden' || vis === 'collapse') return 'visibility: hidden';
    if (prop(cs, 'content-visibility') === 'hidden') return 'content-visibility: hidden'; // F5: its contents are skipped
    const opacity = prop(cs, 'opacity');
    const op = Number.parseFloat(opacity);
    if (Number.isFinite(op) && op < 0.05) return `opacity: ${opacity}`;
    const filter = prop(cs, 'filter');
    for (const m of filter.matchAll(/opacity(s*([d.]+)(%?)s*)/gi)) {
      const f2 = Number(m[1]) / (m[2] ? 100 : 1);
      if (Number.isFinite(f2)) { if (f2 < 0.05) return `filter: ${filter}`; alpha *= f2; }
    }
    if (Number.isFinite(op)) alpha *= op;
    if (alpha < 0.05) return `opacity compounds to ${alpha.toFixed(3)} down the tree`;
    const pos = prop(cs, 'position');
    const w1 = cssPx(prop(cs, 'width')), h1 = cssPx(prop(cs, 'height'));
    if ((pos === 'absolute' || pos === 'fixed') && ((w1 !== null && w1 <= 1) || (h1 !== null && h1 <= 1) || clipHides(prop(cs, 'clip')))) return 'visually hidden';
    if (pos === 'absolute' || pos === 'fixed' || pos === 'relative') {
      for (const side of ['left', 'top', 'right', 'bottom']) {
        const px = cssPx(prop(cs, side));
        if (px !== null && px <= -999) return `off-screen (${side}: ${prop(cs, side)})`;
      }
    }
    for (const side of ['margin-left', 'margin-top']) {
      const px = cssPx(prop(cs, side));
      if (px !== null && px <= -999) return `off-screen (${side}: ${prop(cs, side)})`;
    }
    if (translatedAway(prop(cs, 'transform')) || translatedAway(prop(cs, 'translate'))) return `off-screen (transform: ${prop(cs, 'transform') || prop(cs, 'translate')})`;
    const indent = cssPx(prop(cs, 'text-indent'));
    if (indent !== null && indent <= -999) return `off-screen (text-indent: ${prop(cs, 'text-indent')})`;
    if (clipHides(prop(cs, 'clip-path'))) return `clip-path: ${prop(cs, 'clip-path')}`;
    if (scaledToZero(prop(cs, 'transform'))) return `transform: ${prop(cs, 'transform')}`;
    const overflow = `${prop(cs, 'overflow')} ${prop(cs, 'overflow-x')} ${prop(cs, 'overflow-y')}`;
    if (/hidden|clip/.test(overflow)) {
      for (const dim of ['height', 'max-height', 'width', 'max-width']) {
        const px = cssPx(prop(cs, dim));
        if (px !== null && px < 8) return `${dim}: ${prop(cs, dim)} with overflow hidden`; // no line of text fits
      }
    }
    const fs = cssPx(prop(cs, 'font-size'));
    if (fs !== null && fs < 1) return `font-size: ${prop(cs, 'font-size')}`;
    if (!colourSettled) {
      const c = prop(cs, 'color');
      if (c && c !== 'inherit' && c !== 'currentcolor') {
        colourSettled = true;
        if (isTransparent(c)) return `transparent text (color: ${c})`;
        ink = parseColour(c);
      }
    }
    if (!ground) {
      const bg = parseColour(prop(cs, 'background-color'));
      if (bg && bg[3] >= 0.95) ground = bg;
    }
  }
  // Text the colour of what is behind it (contrast under 1.5:1, far below the 4.5:1 floor) is not shown.
  if (ink && ground && ink[3] >= 0.95 && contrast(ink, ground) < 1.5) return `text the colour of its background (contrast ${contrast(ink, ground).toFixed(2)}:1)`;
  return null;
}
