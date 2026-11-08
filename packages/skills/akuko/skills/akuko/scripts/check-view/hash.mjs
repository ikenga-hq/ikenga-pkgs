// The conformance hash (views/contract.md §8): sha256 of a view's HTML with
// the content of its project data block removed, so one checked page
// conforms whatever project it is published with, and any other change
// breaks it. Plain JS so check-view runs without a TypeScript step;
// decisions/conformed.ts re-exports it, so check-view --record,
// isConformedHtml() and every host's publishView gate use this one function,
// and check-view injects its fixture through the same block finder.

import { createHash } from 'node:crypto';

/** Id of the `<script type="application/json">` block the publisher writes (views/contract.md §1). */
export const PROJECT_BLOCK = 'akuko-project';
/** The data blocks whose content the hash leaves out. */
export const DATA_BLOCKS = [PROJECT_BLOCK];

/** The HTML with every comment blanked to spaces (same length), so a tag quoted in a comment never matches. */
export const blankComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

const attr = (attrs, name) => {
  // a real attribute: not part of another name (data-id, aria-id)
  const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
};

/** JSON text safe to put inside a data block: every "<" written as \u003c (same JSON value). */
export const escapeJsonForScript = (text) => String(text).replace(/</g, '\\u003c');

/**
 * Find the JSON data block `<script type="application/json" id="<id>">`, the
 * way a browser ends it: at the first `</script` (any case, whatever
 * follows). Fail closed (G-VIEW review 07a2 C1):
 *   - 'none'  no script opener carries this id;
 *   - 'bad'   more than one opener carries it (one may be a decoy inside an
 *             attribute, a <textarea>, a <noscript> or CDATA), the opener is
 *             not type="application/json", or the content is not empty or
 *             JSON, or holds `<!--` or any raw `<`;
 *   - 'ok'    exactly one, with {start, end} of its content in `html`.
 */
export function findJsonBlock(html, id, { json = true } = {}) {
  const src = String(html);
  const blanked = blankComments(src);
  const openers = [];
  for (const m of blanked.matchAll(/<script\b([^>]*)>/gi)) if (attr(m[1], 'id') === id) openers.push(m);
  if (openers.length === 0) return { status: 'none' };
  if (openers.length > 1) return { status: 'bad', reason: `${openers.length} <script> tags carry id="${id}"; a page has exactly one` };
  const m = openers[0];
  const type = (attr(m[1], 'type') ?? '').trim().toLowerCase();
  if (type !== 'application/json') return { status: 'bad', reason: `the <script id="${id}"> block is not type="application/json"` };
  const start = m.index + m[0].length;
  const close = blanked.slice(start).search(/<\/script/i);
  if (close < 0) return { status: 'bad', reason: `the <script id="${id}"> block is never closed` };
  const end = start + close;
  const content = src.slice(start, end);
  if (/<!--/.test(content)) return { status: 'bad', reason: `the <script id="${id}"> block holds "<!--"` };
  // A raw "<" lets the block sit inside a <textarea>/<noscript> or be rewritten
  // at run time into markup; publishers write it as \u003c (see escapeJsonForScript).
  if (content.includes('<')) return { status: 'bad', reason: `the <script id="${id}"> block holds a raw "<" (write it as \\u003c)` };
  if (json && content.trim() !== '') {
    try { JSON.parse(content); } catch { return { status: 'bad', reason: `the <script id="${id}"> block is not JSON` }; }
  }
  return { status: 'ok', start, end };
}

/** The HTML as hashed: the project block's content removed. A missing or bad block leaves the raw page (fail closed). */
export function conformanceText(html) {
  let out = String(html);
  for (const id of DATA_BLOCKS) {
    const b = findJsonBlock(out, id);
    if (b.status === 'ok') out = out.slice(0, b.start) + out.slice(b.end);
  }
  return out;
}

/** sha256 (hex) of conformanceText(html): what check-view records and the publish gate compares. */
export function conformanceHash(html) {
  return createHash('sha256').update(conformanceText(html), 'utf8').digest('hex');
}
