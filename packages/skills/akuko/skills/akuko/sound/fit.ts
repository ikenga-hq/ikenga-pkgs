/**
 * akuko — does a voice-over take fit its shot? (WP-12)
 *
 * A take longer than its shot cannot be placed on the film's timeline (its words
 * would run into the next shot). akuko never changes a shot's length or the text:
 * it tells the person as soon as the take comes back, as an agent comment on the
 * `<shot>_vo` asset ("Audio runs 8.4 s; the shot is 6 s") and in the command output,
 * so they see it at review. `sync` skips such a take with a named warning (narration.ts).
 *
 * A take's length is the tag `len-ms:<n>`: the larger of its audio and its last word
 * (set by the provider, `ingest` and `words`). Without the tag the length is unknown
 * and nothing is said.
 */

import type { AkukoProject, Asset } from '../schema/akuko-project.ts';
import { LEN_TAG } from './words.ts';

export const OVERRUN_PREFIX = 'Audio runs ';

/** Seconds for a person: rounded up to 2 decimals, no trailing zeros (8.4, 6, 6.01). */
export const fmtSeconds = (ms: number): string => String(Math.ceil(ms / 10) / 100);

export const takeLength = (a: Asset): number | undefined => {
  const t = a.tags.find((x) => x.startsWith(LEN_TAG));
  const n = t === undefined ? NaN : Number(t.slice(LEN_TAG.length));
  return Number.isFinite(n) ? n : undefined;
};

export const overrunText = (takeMs: number, slotMs: number): string => `${OVERRUN_PREFIX}${fmtSeconds(takeMs)} s; the shot is ${fmtSeconds(slotMs)} s`;

/**
 * Bring each voice-over's overrun comment in line with its current take: one
 * agent comment "Audio runs … s; the shot is … s" while the take overruns, none
 * otherwise. Only this stage's own agent comments (that prefix) are touched, never a
 * person's. Returns the notes that are current, one per overrunning take.
 */
export function annotateOverruns(project: AkukoProject, ts: string, ids?: string[]): { project: AkukoProject; notes: string[] } {
  const notes: string[] = [];
  const assets = project.assets.map((a): Asset => {
    if (a.stage !== 'sound' || a.kind !== 'vo' || (ids && !ids.includes(a.id))) return a;
    const shot = project.shots.find((s) => s.id === a.owner);
    const len = a.file ? takeLength(a) : undefined;
    const slot = shot?.duration_s !== undefined ? Math.round(shot.duration_s * 1000) : undefined;
    const text = len !== undefined && slot !== undefined && len > slot ? overrunText(len, slot) : undefined;
    const mine = (c: Asset['comments'][number]): boolean => c.author === 'agent' && c.text.startsWith(OVERRUN_PREFIX);
    const has = a.comments.filter(mine);
    if (text) notes.push(`${a.id}: ${text}. Shorten the line, pick a faster voice or model, or lengthen the shot in breakdown; akuko changes neither.`);
    if (has.length === (text ? 1 : 0) && (!text || has[0]!.text === text)) return a;
    return {
      ...a,
      comments: [...a.comments.filter((c) => !mine(c)), ...(text ? [{ ts, stage: 'sound' as const, author: 'agent', text }] : [])],
      updated_at: ts,
    };
  });
  const changed = assets.some((a, i) => a !== project.assets[i]);
  return { project: changed ? { ...project, assets } : project, notes };
}
