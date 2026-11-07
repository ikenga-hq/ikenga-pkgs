/**
 * akuko — the conformed-views list (R-12 provenance, WP-07a).
 *
 * A view "conforms" once `scripts/check-view.mjs` has passed it. The check
 * records `{view, sha256, checked_at, checker}` (`--record <file>`), where
 * `view` is the exact `Decision.view` string the page writes
 * (`<manifest id>@<manifest version>`) and `sha256` is the hash of the HTML it
 * checked. Folding accepts `approve`, `approve-spend` and `undo` decisions
 * only from a `view` on this list (plus the built-in chat source below);
 * publishing a decision-writing view needs its hash on the list.
 *
 * Where the list lives (the frozen schema has no slot for it):
 *   B / C   <project>/views/conformed.json, plus the skill's own
 *           views/conformed.json (shipped views such as the default board)
 *   A       the board artifact's DB doc `akuko/conformed` (same JSON), which
 *           only the owner can write (views/contract.md §Host A)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const CONFORMED_FORMAT = 'akuko-conformed-views' as const;

/**
 * Approvals typed by the person in chat and written down by the agent
 * (`text` quotes the reply, e.g. `approve 0.36 USD`). Built in so a project
 * without a published board can still approve a spend from chat, which is
 * what the spend gate's confirmation line asks for. See views/contract.md
 * §Provenance for the limits of this source.
 */
export const CHAT_VIEW = 'chat@1' as const;

export interface ConformedView {
  view: string;
  sha256?: string;
  checked_at?: string;
  checker?: string;
}

export interface ConformedFile {
  format: typeof CONFORMED_FORMAT;
  version: 1;
  views: ConformedView[];
}

export type ConformedInput = Iterable<ConformedView | string> | ConformedFile | undefined;

const isFile = (v: unknown): v is ConformedFile =>
  typeof v === 'object' && v !== null && (v as { format?: unknown }).format === CONFORMED_FORMAT && Array.isArray((v as { views?: unknown }).views);

/** Validate a parsed conformed-views document. Throws on anything else. */
export function parseConformedFile(v: unknown): ConformedFile {
  if (!isFile(v)) throw new Error(`akuko: not a conformed-views file (expected format "${CONFORMED_FORMAT}")`);
  for (const [i, e] of v.views.entries()) {
    if (typeof e !== 'object' || e === null || typeof e.view !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(e.view)) {
      throw new Error(`akuko: conformed view ${i} needs a "view" of the form <id>@<version>`);
    }
    if (e.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`akuko: conformed view ${e.view} has a malformed sha256`);
  }
  return v;
}

/** Read a conformed-views file; a missing file is an empty list. */
export function loadConformedFile(path: string): ConformedFile {
  if (!existsSync(path)) return { format: CONFORMED_FORMAT, version: 1, views: [] };
  return parseConformedFile(JSON.parse(readFileSync(path, 'utf8')));
}

/** The set of `Decision.view` strings folding accepts approvals from. Always includes the chat source. */
export function conformedViewIds(input: ConformedInput): Set<string> {
  const out = new Set<string>([CHAT_VIEW]);
  if (input === undefined) return out;
  const list: Iterable<ConformedView | string> = isFile(input) ? input.views : input;
  for (const e of list) out.add(typeof e === 'string' ? e : e.view);
  return out;
}

/** sha256 of a view's HTML exactly as published (what check-view records). */
export const viewHash = (html: string): string => createHash('sha256').update(html, 'utf8').digest('hex');

/** Is this exact HTML recorded as conformed under `view`? Use before publishing a view that writes decisions. */
export function isConformedHtml(input: ConformedInput, view: string, html: string): boolean {
  if (input === undefined) return false;
  const list: Iterable<ConformedView | string> = isFile(input) ? input.views : input;
  const h = viewHash(html);
  for (const e of list) if (typeof e !== 'string' && e.view === view && e.sha256 === h) return true;
  return false;
}
