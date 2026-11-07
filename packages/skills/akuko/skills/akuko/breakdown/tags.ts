/**
 * akuko — shot tags in the script, and shot id allocation.
 *
 * A tag is a Fountain note, `[[sc3_sh2]]`, appended to the end of the
 * paragraph a shot came from. Notes are invisible to a reader of the script
 * and visible to a parser, so the script line and the shot stay linked.
 * Several shots may come from one paragraph: the tags sit side by side.
 *
 * Rules lifted from `studio-breakdown`:
 *   - write a tag only when the paragraph is a confident match for the shot;
 *     an unmatched shot stays untagged and is reported, never guessed;
 *   - never move or overwrite a tag that is already there — if it disagrees
 *     with the match, report a conflict and leave the text alone;
 *   - re-running is a no-op for shots that are already tagged correctly.
 */

import { parseFountain, normalize, type Block, type FountainDoc } from './fountain.ts';

export const TAG = /\[\[(sc\d+_sh\d+[A-Z]?)\]\]/g;

export interface TagRef {
  shotId: string;
  /** 0-based line the tag is on. */
  line: number;
  /** Index of the block holding that line, or -1 if between blocks. */
  block: number;
}

/** Every shot tag in the text, in document order. */
export function readTags(text: string | FountainDoc, opts: { prose?: boolean } = {}): TagRef[] {
  const doc = typeof text === 'string' ? parseFountain(text, opts) : text;
  const out: TagRef[] = [];
  doc.lines.forEach((line, n) => {
    for (const m of line.matchAll(TAG)) {
      const block = doc.blocks.find((b) => n >= b.startLine && n <= b.endLine);
      out.push({ shotId: m[1]!, line: n, block: block?.index ?? -1 });
    }
  });
  return out;
}

/** The script with every shot tag removed. */
export function stripTags(text: string): string {
  return text.replace(/[ \t]*\[\[sc\d+_sh\d+[A-Z]?\]\]/g, '');
}

// ── ids ─────────────────────────────────────────────────────────────────

const SHOT_ID = /^sc(\d+)_sh(\d+)([A-Z]?)$/;

export function sceneIdFor(n: number): string {
  return `sc${n}`;
}

export function sceneNumberOf(sceneId: string | undefined): number | undefined {
  const m = /^sc(\d+)$/.exec(sceneId ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Next free `sc<N>_sh<M>` in scene N: one past the highest M already used. Never reuses a number. */
export function allocateShotId(existing: Iterable<string>, sceneN: number): string {
  let max = 0;
  for (const id of existing) {
    const m = SHOT_ID.exec(id);
    if (m && Number(m[1]) === sceneN) max = Math.max(max, Number(m[2]));
  }
  return `sc${sceneN}_sh${max + 1}`;
}

/**
 * Id for a shot inserted after an existing one: `sc3_sh2` -> `sc3_sh2A`, then
 * `sc3_sh2B`, so later shots keep their numbers and their tags.
 */
export function insertedShotId(afterId: string, existing: Iterable<string>): string {
  const m = SHOT_ID.exec(afterId);
  if (!m) throw new Error(`akuko: "${afterId}" is not a canonical shot id`);
  const taken = new Set(existing);
  for (let c = 65; c <= 90; c++) {
    const id = `sc${m[1]}_sh${m[2]}${String.fromCharCode(c)}`;
    if (!taken.has(id)) return id;
  }
  throw new Error(`akuko: no free insert suffix after ${afterId}`);
}

// ── placing a shot in the script ────────────────────────────────────────

export interface Placement {
  shotId: string;
  /** Scene number from the shot's scene id; narrows the search. */
  scene?: number;
  /** The script text the shot covers. */
  scriptLine?: string;
}

export type Located =
  | { ok: true; block: Block }
  | { ok: false; reason: string };

const MIN_MATCH = 8;

/**
 * Find the one block a shot came from. A match is a block whose text contains
 * the shot's `script_line` (or the other way round), compared after removing
 * notes, emphasis marks and typographic quote differences. Zero or several
 * candidates mean "not confident": no block is returned.
 */
export function locateBlock(doc: FountainDoc, p: Pick<Placement, 'scene' | 'scriptLine'>): Located {
  const needle = normalize(p.scriptLine ?? '');
  if (needle.length < MIN_MATCH) return { ok: false, reason: 'the shot has no script line to match' };
  const pool = doc.blocks.filter(
    (b) => b.kind !== 'title' && b.kind !== 'section' && (p.scene === undefined || doc.scenes.length === 0 || b.scene === p.scene),
  );
  const hits = pool.filter((b) => {
    const t = normalize(b.text);
    return t.length >= MIN_MATCH && (t.includes(needle) || needle.includes(t));
  });
  if (hits.length === 1) return { ok: true, block: hits[0]! };
  if (hits.length === 0) return { ok: false, reason: "no paragraph contains the shot's script line" };
  return { ok: false, reason: `${hits.length} paragraphs match the shot's script line; ambiguous` };
}

export interface TagResult {
  text: string;
  /** Tags added by this call. */
  tagged: string[];
  /** Shots whose tag was already on the right paragraph. */
  alreadyTagged: string[];
  /** Shots left untagged because no single paragraph matched. */
  unplaced: { shotId: string; reason: string }[];
  /** Shots already tagged on a different paragraph than the match; nothing was changed for them. */
  conflicts: { shotId: string; line: number; matchedLine: number }[];
}

/**
 * Insert a `[[shot id]]` note for each placement. Pure: returns the new text.
 * Idempotent: running it again on its own output changes nothing.
 */
export function insertTags(text: string, placements: Placement[], opts: { prose?: boolean } = {}): TagResult {
  const doc = parseFountain(text, opts);
  const existing = readTags(doc);
  const lines = [...doc.lines];
  const res: TagResult = { text, tagged: [], alreadyTagged: [], unplaced: [], conflicts: [] };
  // block index -> ids appended in this call, in placement order
  const pending = new Map<number, string[]>();

  for (const p of placements) {
    const found = locateBlock(doc, p);
    const prior = existing.filter((t) => t.shotId === p.shotId);
    if (!found.ok) {
      // A tag already there is not undone just because it could not be re-matched.
      if (prior.length > 0) res.alreadyTagged.push(p.shotId);
      else res.unplaced.push({ shotId: p.shotId, reason: found.reason });
      continue;
    }
    if (prior.length > 0) {
      if (prior.some((t) => t.block === found.block.index)) res.alreadyTagged.push(p.shotId);
      else res.conflicts.push({ shotId: p.shotId, line: prior[0]!.line + 1, matchedLine: found.block.startLine + 1 });
      continue;
    }
    const list = pending.get(found.block.index) ?? [];
    list.push(p.shotId);
    pending.set(found.block.index, list);
    res.tagged.push(p.shotId);
  }

  for (const [bi, ids] of pending) {
    const b = doc.blocks[bi]!;
    lines[b.endLine] = `${lines[b.endLine]!.replace(/\s+$/, '')} ${ids.map((id) => `[[${id}]]`).join(' ')}`;
  }
  res.text = lines.join(doc.eol);
  return res;
}
