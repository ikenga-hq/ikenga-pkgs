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

function sizesIn(decls) {
  const out = [];
  for (const m of decls.matchAll(/font-size\s*:\s*([^;}"'!<>]+)/gi)) {
    const px = cssPx(m[1]);
    if (px !== null && px < 12) out.push(m[1].trim());
  }
  for (const m of decls.matchAll(/(?<![-\w])font\s*:\s*([^;}"'!<>]+)/gi)) {
    const size = shorthandSize(m[1]);
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
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (!isSvgRule(m[1])) out.push(...sizesIn(m[2]));
  out.push(...sizesIn(rest));
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

const prop = (cs, name) => cs.getPropertyValue(name) || cs[name.replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] || '';

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
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e.hidden) return 'hidden attribute';
    if (e.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    if (e.hasAttribute('inert')) return 'inert';
    if (e.tagName === 'DETAILS' && !e.open && e !== el && !el.closest('summary')) return 'inside a closed <details>';
    const cs = w.getComputedStyle(e);
    if (cs.display === 'none') return 'display: none';
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility: hidden';
    const op = Number.parseFloat(cs.opacity);
    if (Number.isFinite(op) && op < 0.05) return `opacity: ${cs.opacity}`;
    const pos = cs.position;
    const w1 = cssPx(cs.width), h1 = cssPx(cs.height);
    if ((pos === 'absolute' || pos === 'fixed') && ((w1 !== null && w1 <= 1) || (h1 !== null && h1 <= 1) || clipHides(cs.clip))) return 'visually hidden';
    if (pos === 'absolute' || pos === 'fixed' || pos === 'relative') {
      for (const side of ['left', 'top', 'right', 'bottom']) {
        const px = cssPx(prop(cs, side));
        if (px !== null && px <= -999) return `off-screen (${side}: ${prop(cs, side)})`;
      }
    }
    const indent = cssPx(prop(cs, 'text-indent'));
    if (indent !== null && indent <= -999) return `off-screen (text-indent: ${prop(cs, 'text-indent')})`;
    if (clipHides(prop(cs, 'clip-path'))) return `clip-path: ${prop(cs, 'clip-path')}`;
    if (scaledToZero(prop(cs, 'transform'))) return `transform: ${prop(cs, 'transform')}`;
    const overflow = `${prop(cs, 'overflow')} ${prop(cs, 'overflow-x')} ${prop(cs, 'overflow-y')}`;
    if (/hidden|clip/.test(overflow)) {
      for (const dim of ['height', 'max-height', 'width', 'max-width']) {
        const px = cssPx(prop(cs, dim));
        if (px !== null && px <= 0.5) return `${dim}: ${prop(cs, dim)} with overflow hidden`;
      }
    }
    const fs = cssPx(prop(cs, 'font-size'));
    if (fs !== null && fs < 1) return `font-size: ${prop(cs, 'font-size')}`;
    if (!colourSettled) {
      const c = prop(cs, 'color');
      if (c && c !== 'inherit' && c !== 'currentcolor') {
        colourSettled = true;
        if (isTransparent(c)) return `transparent text (color: ${c})`;
      }
    }
  }
  return null;
}
