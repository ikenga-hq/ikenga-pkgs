/**
 * akuko — captions from word timings (WP-12). Pure: no clock, no files, no host.
 *
 * `captionsFromNarration(audio.narration)` groups the film's word timings into
 * readable cues. A cue starts at its first word's `start_ms` and ends at its last
 * word's `end_ms`, so cue times always equal word times. Nothing is added or moved.
 *
 * A new cue begins when adding the next word would break any of:
 *   - at most `maxChars` characters in the cue (default 42, one comfortable line);
 *   - at most `maxDurationMs` from the cue's start to the word's end (default 5000);
 *   - a silence of `maxGapMs` or more before the word (default 1000, a real pause);
 * and always after a word that ends a sentence (`.`, `!`, `?`, `…`), so a cue never
 * carries the end of one sentence and the start of the next.
 * A single word longer than `maxChars` still gets a cue of its own.
 */

import type { Audio } from '../schema/akuko-project.ts';
import type { NarrationWord } from './words.ts';

export interface CaptionOptions {
  maxChars?: number;
  maxDurationMs?: number;
  maxGapMs?: number;
}

export const CAPTION_DEFAULTS = { maxChars: 42, maxDurationMs: 5000, maxGapMs: 1000 } as const;

export interface Cue {
  /** 1-based. */
  index: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

export function captionsFromWords(words: NarrationWord[], opts: CaptionOptions = {}): Cue[] {
  const maxChars = opts.maxChars ?? CAPTION_DEFAULTS.maxChars;
  const maxDur = opts.maxDurationMs ?? CAPTION_DEFAULTS.maxDurationMs;
  const maxGap = opts.maxGapMs ?? CAPTION_DEFAULTS.maxGapMs;
  const cues: Cue[] = [];
  let cur: { start: number; end: number; parts: string[]; chars: number } | undefined;
  const close = (): void => {
    if (cur) cues.push({ index: cues.length + 1, start_ms: cur.start, end_ms: cur.end, text: cur.parts.join(' ') });
    cur = undefined;
  };
  for (const w of words) {
    if (cur) {
      const chars = cur.chars + 1 + w.word.length;
      if (chars > maxChars || w.end_ms - cur.start > maxDur || w.start_ms - cur.end >= maxGap) close();
    }
    if (!cur) cur = { start: w.start_ms, end: w.end_ms, parts: [w.word], chars: w.word.length };
    else { cur.parts.push(w.word); cur.chars += 1 + w.word.length; cur.end = Math.max(cur.end, w.end_ms); }
    if (SENTENCE_END.test(w.word)) close();
  }
  close();
  return cues;
}

export const captionsFromNarration = (n: NonNullable<Audio['narration']>, opts: CaptionOptions = {}): Cue[] =>
  captionsFromWords(n.words, opts);

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
function clock(msv: number, sep: '.' | ','): string {
  const h = Math.floor(msv / 3_600_000);
  const m = Math.floor((msv % 3_600_000) / 60_000);
  const s = Math.floor((msv % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(msv % 1000, 3)}`;
}

export const formatVtt = (cues: Cue[]): string =>
  `WEBVTT\n\n${cues.map((c) => `${c.index}\n${clock(c.start_ms, '.')} --> ${clock(c.end_ms, '.')}\n${c.text}\n`).join('\n')}`;

export const formatSrt = (cues: Cue[]): string =>
  cues.map((c) => `${c.index}\n${clock(c.start_ms, ',')} --> ${clock(c.end_ms, ',')}\n${c.text}\n`).join('\n');
