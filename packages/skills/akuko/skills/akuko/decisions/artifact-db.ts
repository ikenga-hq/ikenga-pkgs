/**
 * akuko — decision store for host A: the board artifact's database (claude.ai).
 *
 * Row layout (views/contract.md §Host A):
 *   doc   akuko/project        the AkukoProject; only the owner (the agent's
 *                              user) writes it, with `if_version` (compare-and-swap)
 *   doc   akuko/conformed      the conformed-views list (decisions/conformed.ts)
 *   coll  decisions            ONE ROW PER DECISION; the page writes
 *                              `db.collection("decisions").doc(d.id).set(d)`
 *                              (an `add()` row with its own id is accepted too).
 *                              Rows are never updated: an undo is a new row.
 * One row per decision keeps every document small (the per-document size
 * limit is unverified) and makes concurrent reviewers safe: nobody writes
 * the same document twice.
 *
 * The agent reads the collection with the ArtifactData tool (`list` or
 * `query` on `decisions`; load the tool with ToolSearch first — it is often
 * deferred, and its name can differ between chats). This module parses what
 * that tool returns: rows shaped `{id, data, version, updatedAt}`, as an
 * array or wrapped in an object (`documents`, `items`, `rows`, `results`).
 *
 * Cursor: `db:<updatedAt>` of the newest row read. Rows with `updatedAt` at or
 * after it are returned again next time (folding drops repeats by id), so a
 * row written in the same instant is never missed.
 */

import type { InvalidRecord, StoreRead } from './jsonl.ts';
import { toDecision } from './jsonl.ts';
import type { Decision } from '../schema/akuko-project.ts';

export const DECISIONS_COLLECTION = 'decisions';

export interface ArtifactRow {
  id: string;
  data: unknown;
  version?: number;
  updatedAt?: string;
}

const CURSOR = /^db:(.+)$/;

/** Pull the row list out of an ArtifactData list / query result (or a JSON string of one). */
export function rowsFromResult(result: unknown): ArtifactRow[] {
  let v = result;
  if (typeof v === 'string') {
    const s = v.trim();
    const start = Math.min(...['[', '{'].map((c) => s.indexOf(c)).filter((i) => i >= 0));
    v = JSON.parse(Number.isFinite(start) ? s.slice(start) : s);
  }
  if (Array.isArray(v)) return v as ArtifactRow[];
  if (v && typeof v === 'object') {
    for (const k of ['documents', 'items', 'rows', 'results', 'docs']) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner as ArtifactRow[];
    }
  }
  throw new Error('akuko: not an ArtifactData list result (expected an array of {id, data, version, updatedAt})');
}

/** Parse decision rows. `since` is a `db:<updatedAt>` cursor. */
export function parseArtifactRows(result: unknown, since?: string): StoreRead {
  const rows = rowsFromResult(result);
  const m = since ? CURSOR.exec(since) : null;
  const from = m ? Date.parse(m[1]!) : Number.NEGATIVE_INFINITY;
  const decisions: Decision[] = [];
  const invalid: InvalidRecord[] = [];
  let newest: string | undefined = m ? m[1] : undefined;
  for (const [i, row] of rows.entries()) {
    const where = `row ${row && typeof row === 'object' && typeof row.id === 'string' ? row.id : `#${i}`}`;
    if (!row || typeof row !== 'object' || !('data' in row)) {
      invalid.push({ where, error: 'not a {id, data} row' });
      continue;
    }
    const at = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : Number.NaN;
    if (Number.isFinite(at) && at < from) continue;
    if (typeof row.updatedAt === 'string' && Number.isFinite(at) && (newest === undefined || at > Date.parse(newest))) newest = row.updatedAt;
    let data = row.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        invalid.push({ where, error: 'data is not JSON' });
        continue;
      }
    }
    const d = toDecision(data);
    if (d.ok) decisions.push(d.decision);
    else invalid.push({ where, error: d.error });
  }
  return { decisions, invalid, cursor: newest ? `db:${newest}` : 'db:' + new Date(0).toISOString() };
}

/** What the host-A adapter needs to read the store: an ArtifactData `list` of a collection. */
export type ListCollection = (collection: string) => Promise<unknown>;

export async function readArtifactDbStore(list: ListCollection, since?: string): Promise<StoreRead> {
  return parseArtifactRows(await list(DECISIONS_COLLECTION), since);
}
