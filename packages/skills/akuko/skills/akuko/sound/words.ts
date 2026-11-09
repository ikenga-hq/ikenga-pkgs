/**
 * akuko — word timings (WP-12).
 *
 * Word timings are only ever REAL ones: converted from what a TTS provider
 * returned, or read from a file the person supplied. Nothing here estimates,
 * spaces words evenly, or fills a gap. A response or file that cannot be read
 * as timings is an error, and the voice-over is then recorded without timings.
 *
 * Two shapes:
 *   - shot-relative: `WordsFile`, one per voice-over take, milliseconds from the
 *     start of that take's audio.
 *   - composition-absolute: `NarrationWord[]`, milliseconds from the start of the
 *     film (see narration.ts, which offsets shot-relative words by the shot's start).
 */

import type { Audio } from '../schema/akuko-project.ts';

export type NarrationWord = NonNullable<Audio['narration']>['words'][number];

export class WordsError extends Error {
  override name = 'WordsError';
}

export const WORDS_FORMAT = 'akuko-vo-words';

/** What is stored next to a voice-over take: its text, its real word timings and its length. */
export interface WordsFile {
  format: typeof WORDS_FORMAT;
  version: 1;
  unit: string;
  text: string;
  voice_id?: string;
  model?: string;
  /** Length of the take's audio, in ms. */
  duration_ms: number;
  words: NarrationWord[];
}

/** ElevenLabs `alignment`: one entry per character of the text, times in seconds. */
export interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

const ms = (s: number): number => Math.round(s * 1000);

/**
 * Group per-character timings into words (split at whitespace). A word starts at
 * its first character's start time and ends at its last character's end time;
 * punctuation stays attached to the word it touches. Throws when the arrays are
 * missing, differ in length, or contain times that are not finite and non-negative.
 */
export function wordsFromAlignment(a: unknown): NarrationWord[] {
  const al = a as Partial<CharAlignment> | null | undefined;
  if (!al || !Array.isArray(al.characters) || !Array.isArray(al.character_start_times_seconds) || !Array.isArray(al.character_end_times_seconds)) {
    throw new WordsError('the response has no character alignment');
  }
  const n = al.characters.length;
  if (al.character_start_times_seconds.length !== n || al.character_end_times_seconds.length !== n) {
    throw new WordsError('the alignment arrays differ in length');
  }
  const words: NarrationWord[] = [];
  let cur: { text: string; start: number; end: number } | undefined;
  const flush = (): void => {
    if (cur) words.push({ word: cur.text, start_ms: ms(cur.start), end_ms: ms(cur.end) });
    cur = undefined;
  };
  for (let i = 0; i < n; i++) {
    const ch = al.characters[i];
    const s = al.character_start_times_seconds[i];
    const e = al.character_end_times_seconds[i];
    if (typeof ch !== 'string' || typeof s !== 'number' || typeof e !== 'number' || !Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < s) {
      throw new WordsError(`character ${i} has no usable timing`);
    }
    if (/^\s*$/.test(ch)) { flush(); continue; }
    if (cur) { cur.text += ch; cur.end = Math.max(cur.end, e); } else cur = { text: ch, start: s, end: e };
  }
  flush();
  // A token of punctuation only (a standalone dash) belongs to the word before it.
  const merged: NarrationWord[] = [];
  for (const x of words) {
    const prev = merged[merged.length - 1];
    if (prev && /^[\p{P}\p{S}]+$/u.test(x.word)) {
      prev.word = `${prev.word} ${x.word}`;
      prev.end_ms = Math.max(prev.end_ms, x.end_ms);
    } else {
      merged.push(x);
    }
  }
  checkWords(merged);
  return merged;
}

/** Words must be whole milliseconds, start no later than they end, and run in order. */
export function checkWords(words: NarrationWord[]): void {
  let prevStart = 0;
  let prevEnd = 0;
  words.forEach((w, i) => {
    if (typeof w.word !== 'string' || w.word.trim() === '') throw new WordsError(`word ${i} is empty`);
    if (!Number.isInteger(w.start_ms) || !Number.isInteger(w.end_ms) || w.start_ms < 0) throw new WordsError(`word ${i} ("${w.word}") needs whole, non-negative millisecond times`);
    if (w.end_ms < w.start_ms) throw new WordsError(`word ${i} ("${w.word}") ends before it starts`);
    if (w.start_ms < prevStart || w.end_ms < prevEnd) throw new WordsError(`word ${i} ("${w.word}") is out of order`);
    prevStart = w.start_ms;
    prevEnd = w.end_ms;
  });
}

/**
 * Read a words file a person brought back. Accepted: an akuko words file, an object
 * with `words`, or a bare array. Each word is `{word, start_ms, end_ms}` in
 * milliseconds from the start of the audio. Anything else is refused, never guessed at.
 */
export function parseWordsFile(raw: string | Uint8Array, unit: string, text: string): WordsFile {
  let doc: unknown;
  try {
    doc = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch {
    throw new WordsError('the words file is not valid JSON');
  }
  const obj = (Array.isArray(doc) ? { words: doc } : doc) as { words?: unknown; duration_ms?: unknown } | null;
  if (!obj || !Array.isArray(obj.words)) throw new WordsError('the words file needs a "words" list of {word, start_ms, end_ms}');
  const words = obj.words.map((w, i): NarrationWord => {
    const x = w as { word?: unknown; start_ms?: unknown; end_ms?: unknown };
    if (typeof x?.word !== 'string' || typeof x.start_ms !== 'number' || typeof x.end_ms !== 'number') {
      throw new WordsError(`word ${i} needs {word, start_ms, end_ms} in milliseconds`);
    }
    return { word: x.word, start_ms: x.start_ms, end_ms: x.end_ms };
  });
  if (words.length === 0) throw new WordsError('the words file has no words');
  checkWords(words);
  const last = words[words.length - 1]!.end_ms;
  const declared = typeof obj.duration_ms === 'number' && Number.isFinite(obj.duration_ms) ? Math.round(obj.duration_ms) : undefined;
  if (declared !== undefined && declared < last) throw new WordsError(`duration_ms ${declared} ends before the last word (${last} ms)`);
  return { format: WORDS_FORMAT, version: 1, unit, text, duration_ms: declared ?? last, words };
}

/** Read back a words file this package wrote (or `parseWordsFile` accepted). */
export function readWordsFile(raw: Uint8Array): WordsFile {
  const doc = JSON.parse(new TextDecoder().decode(raw)) as Partial<WordsFile>;
  if (doc.format !== WORDS_FORMAT || !Array.isArray(doc.words) || typeof doc.duration_ms !== 'number' || typeof doc.unit !== 'string') {
    throw new WordsError('not an akuko words file');
  }
  checkWords(doc.words);
  return doc as WordsFile;
}

export const serializeWords = (w: WordsFile): Uint8Array => new TextEncoder().encode(`${JSON.stringify(w, null, 2)}\n`);

/** Move shot-relative words onto the film's timeline. */
export const offsetWords = (words: NarrationWord[], startMs: number): NarrationWord[] =>
  words.map((w) => ({ word: w.word, start_ms: w.start_ms + startMs, end_ms: w.end_ms + startMs }));

/** Tag on a voice-over asset naming the file that holds its word timings: `words:<uri>`. */
export const WORDS_TAG = 'words:';
/** Tag on a voice-over asset recorded without timings (captions need them). */
export const NO_WORDS_TAG = 'no-words';
export const VOICE_TAG = 'voice:';

/** Tag on a voice-over asset: the take's length in ms, the larger of its audio and its last word (`len-ms:<n>`). */
export const LEN_TAG = 'len-ms:';
