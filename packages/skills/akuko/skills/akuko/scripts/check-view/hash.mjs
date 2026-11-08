// The conformance hash (views/contract.md §8): sha256 of a view's HTML with
// the data block(s) a publisher fills emptied, so one checked page conforms
// whatever project it is published with, and any other change breaks it.
// Plain JS so check-view runs without a TypeScript step; decisions/conformed.ts
// re-exports it, so check-view --record, isConformedHtml() and every host's
// publishView gate use this one function.

import { createHash } from 'node:crypto';

/** Ids of the `<script type="application/json">` blocks the publisher writes (views/contract.md §1). */
export const DATA_BLOCKS = ['akuko-project'];

/** The HTML as hashed: each data block's content emptied (the first real one per id; HTML comments are never matched). */
export function conformanceText(html) {
  let out = String(html);
  for (const id of DATA_BLOCKS) {
    // Find the block in a copy with every comment blanked (same length), then splice the original.
    const blanked = out.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    const m = new RegExp(`(<script\\b[^>]*\\bid=["']${id}["'][^>]*>)([\\s\\S]*?)</script>`, 'i').exec(blanked);
    if (!m) continue;
    const start = m.index + m[1].length;
    out = out.slice(0, start) + out.slice(start + m[2].length);
  }
  return out;
}

/** sha256 (hex) of conformanceText(html): what check-view records and the publish gate compares. */
export function conformanceHash(html) {
  return createHash('sha256').update(conformanceText(html), 'utf8').digest('hex');
}
