/**
 * akuko — decision store for host C (Ikenga), mirrored to `decisions.jsonl`.
 *
 * What the G-HOST manual check found (C4(b), C5): `art.state` is iframe
 * localStorage the agent can't read, and `art.publishState` is undefined in
 * an Ikenga pane. So a view posts the raw bridge message
 *
 *   window.parent.postMessage({ __iyke: true, kind: 'state',
 *     payload: { key: 'akuko.decisions', value: [ ...every decision this page holds ] } }, '*')
 *
 * The shell keeps the LATEST value per key per mounted pane, so the page
 * always posts its whole list (its local outbox), on every decision and on
 * load. The agent reads it with `iyke iframe-state <pane>` and, because a
 * pane reload clears that state, mirrors every decision it sees into
 * `<project>/decisions.jsonl` before folding. The mirror is the durable
 * store; the iframe state is only the transport.
 *
 * `parseIframeState()` accepts what `iyke iframe-state` prints: one
 * `{generation, state: {...}}` object, an array of them, or a wrapper with
 * `iframes` / `entries`; prose around the JSON is tolerated.
 */

import type { Decision } from '../schema/akuko-project.ts';
import { appendDecisions, readJsonlStore, toDecision, type InvalidRecord, type StoreRead } from './jsonl.ts';

export const IFRAME_STATE_KEY = 'akuko.decisions';

function sliceJson(text: string): unknown {
  const s = text.trim();
  const starts = ['{', '['].map((c) => s.indexOf(c)).filter((i) => i >= 0);
  if (starts.length === 0) throw new Error('akuko: no JSON in the iframe-state output');
  const start = Math.min(...starts);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  return JSON.parse(s.slice(start, end + 1));
}

function states(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.flatMap(states);
  if (!v || typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  if (o.state && typeof o.state === 'object' && !Array.isArray(o.state)) return [o.state as Record<string, unknown>];
  for (const k of ['iframes', 'entries', 'panes', 'items']) if (Array.isArray(o[k])) return states(o[k]);
  if (IFRAME_STATE_KEY in o) return [o];
  return [];
}

/** Decisions published under `akuko.decisions` in `iyke iframe-state` output. */
export function parseIframeState(output: string | unknown): { decisions: Decision[]; invalid: InvalidRecord[] } {
  const v = typeof output === 'string' ? sliceJson(output) : output;
  const decisions: Decision[] = [];
  const invalid: InvalidRecord[] = [];
  let n = 0;
  for (const st of states(v)) {
    let value = st[IFRAME_STATE_KEY];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        invalid.push({ where: `iframe-state ${IFRAME_STATE_KEY}`, error: 'value is not JSON' });
        continue;
      }
    }
    for (const rec of Array.isArray(value) ? value : [value]) {
      const d = toDecision(rec);
      if (d.ok) decisions.push(d.decision);
      else invalid.push({ where: `iframe-state[${n}]`, error: d.error });
      n++;
    }
  }
  return { decisions, invalid };
}

export interface IkengaStoreOptions {
  projectDir: string;
  /** Output of `iyke iframe-state <pane>` (omit when the pane is closed: the mirror alone is read). */
  iframeState?: string | unknown;
  /** A `jsonl:<offset>` cursor into the mirror. */
  since?: string;
}

/**
 * Mirror what the pane published into decisions.jsonl (new ids only), then
 * read the mirror. Decisions are deduplicated by id across both.
 */
export async function readIkengaStore(opts: IkengaStoreOptions): Promise<StoreRead & { mirrored: Decision[] }> {
  let mirrored: Decision[] = [];
  const invalid: InvalidRecord[] = [];
  if (opts.iframeState !== undefined && opts.iframeState !== '') {
    const live = parseIframeState(opts.iframeState);
    invalid.push(...live.invalid);
    mirrored = await appendDecisions(opts.projectDir, live.decisions);
  }
  const read = await readJsonlStore(opts.projectDir, opts.since);
  const seen = new Set<string>();
  const decisions = read.decisions.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  return { decisions, invalid: [...invalid, ...read.invalid], cursor: read.cursor, mirrored };
}
