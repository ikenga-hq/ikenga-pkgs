/**
 * akuko — decision store for host B (and host C's mirror): `<project>/decisions.jsonl`.
 *
 * One `Decision` per line, as JSON, appended; never rewritten. Who appends:
 *   - a view running as a local file can't write files, so it keeps an
 *     outbox and the person copies it ("Copy decisions for akuko") into
 *     chat; the agent appends those lines as given (views/contract.md §Host B);
 *   - the agent, for an approval the person typed in chat (`view: "chat@1"`);
 *   - `decisions/ikenga.ts`, mirroring what an Ikenga pane published (host C).
 *
 * Cursor: `jsonl:<byte offset>` just after the last complete line read. A
 * line with no trailing newline that doesn't parse is treated as still being
 * written: it is skipped and the cursor stays before it.
 */

import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DecisionSchema, type Decision } from '../schema/akuko-project.ts';

export const DECISIONS_FILE = 'decisions.jsonl';

export interface InvalidRecord {
  /** Where it was: `line 3`, `row dg54…`, `iframe-state[2]`. */
  where: string;
  error: string;
}

export interface StoreRead {
  decisions: Decision[];
  /** Records that are not valid decisions. Shown to the person, never folded. */
  invalid: InvalidRecord[];
  /** Pass back as `since` to read only what arrived after this read. */
  cursor: string;
}

const CURSOR = /^jsonl:(\d+)$/;

/** Parse a `jsonl:<offset>` cursor. Anything else (or nothing) means "from the start". */
export function jsonlOffset(since: string | undefined): number {
  const m = since ? CURSOR.exec(since) : null;
  return m ? Number(m[1]) : 0;
}

const issue = (e: unknown): string => {
  if (e && typeof e === 'object' && 'issues' in e && Array.isArray((e as { issues: unknown[] }).issues)) {
    const first = (e as { issues: { path: (string | number)[]; message: string }[] }).issues[0];
    return first ? `${first.path.join('.') || '(record)'}: ${first.message}` : 'invalid decision';
  }
  return e instanceof Error ? e.message : String(e);
};

/** Validate one record as a Decision. */
export function toDecision(v: unknown): { ok: true; decision: Decision } | { ok: false; error: string } {
  const r = DecisionSchema.safeParse(v);
  return r.success ? { ok: true, decision: r.data } : { ok: false, error: issue(r.error) };
}

/** Parse decisions.jsonl text, starting at a byte offset. */
export function parseJsonl(text: string, since?: string): StoreRead {
  const buf = Buffer.from(text, 'utf8');
  let pos = Math.min(jsonlOffset(since), buf.length);
  const decisions: Decision[] = [];
  const invalid: InvalidRecord[] = [];
  let lineNo = buf.subarray(0, pos).toString('utf8').split('\n').length;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl < 0 ? buf.length : nl;
    const line = buf.subarray(pos, end).toString('utf8').replace(/\r$/, '');
    if (line.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        if (nl < 0) break; // last line still being written
        invalid.push({ where: `line ${lineNo}`, error: `not JSON (${issue(e)})` });
        pos = end + 1;
        lineNo++;
        continue;
      }
      const d = toDecision(parsed);
      if (d.ok) decisions.push(d.decision);
      else invalid.push({ where: `line ${lineNo}`, error: d.error });
    }
    pos = nl < 0 ? buf.length : end + 1;
    lineNo++;
  }
  return { decisions, invalid, cursor: `jsonl:${pos}` };
}

/** One line of decisions.jsonl for a decision (schema key order, newline-terminated). */
export const jsonlLine = (d: Decision): string => `${JSON.stringify(DecisionSchema.parse(d))}\n`;

/** Read `<project>/decisions.jsonl` (a missing file is an empty store). */
export async function readJsonlStore(projectDir: string, since?: string): Promise<StoreRead> {
  const path = join(projectDir, DECISIONS_FILE);
  if (!existsSync(path)) return { decisions: [], invalid: [], cursor: since && CURSOR.test(since) ? since : 'jsonl:0' };
  return parseJsonl(await readFile(path, 'utf8'), since);
}

/**
 * Append decisions not already in the file (by id). Returns the ones written.
 * Lines are appended, never rewritten, so a concurrent reader only ever sees
 * whole lines or a trailing partial one.
 */
export async function appendDecisions(projectDir: string, ds: Decision[]): Promise<Decision[]> {
  const path = join(projectDir, DECISIONS_FILE);
  const have = new Set((existsSync(path) ? parseJsonl(await readFile(path, 'utf8')).decisions : []).map((d) => d.id));
  const out: Decision[] = [];
  for (const d of ds) {
    if (have.has(d.id)) continue;
    have.add(d.id);
    out.push(d);
  }
  if (out.length > 0) {
    let prefix = '';
    if (existsSync(path)) {
      const cur = await readFile(path);
      if (cur.length > 0 && cur[cur.length - 1] !== 0x0a) prefix = '\n';
    }
    await appendFile(path, prefix + out.map(jsonlLine).join(''));
  }
  return out;
}
