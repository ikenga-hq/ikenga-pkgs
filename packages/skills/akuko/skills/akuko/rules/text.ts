/**
 * akuko — project rules: text matching (WP-26).
 *
 * Pure helpers for `rules.banned` (whole words, any case, with exceptions)
 * and `rules.require` (scoped required text). No I/O.
 *
 * Whole word, Unicode-aware: a match must not touch a letter, digit or
 * combining mark on either side. Everything else (spaces, hyphens,
 * apostrophes, underscores, punctuation, the start or end of the text) is a
 * boundary, so the banned term `gore` matches `Gore-Tex`, `gore.` and
 * `GORE's`, but not `gorey` or `Gorecki`. A multi-word term matches with any
 * run of whitespace between its words.
 */

const WORDCHAR = '[\\p{L}\\p{N}\\p{M}]';
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A whole-word, case-insensitive matcher for `phrase`. */
export function wordPattern(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/).map(escape).join('\\s+');
  return new RegExp(`(?<!${WORDCHAR})${body}(?!${WORDCHAR})`, 'giu');
}

export interface Span { start: number; end: number }

function spans(text: string, phrase: string): Span[] {
  if (phrase.trim() === '') return [];
  const out: Span[] = [];
  for (const m of text.matchAll(wordPattern(phrase))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * Where `term` appears in `text` as a whole word, leaving out every match
 * that lies inside a whole-word match of one of `except` (so `Gore-Tex` in
 * `except` allows that word while `gore` alone stays banned).
 */
export function bannedMatches(text: string, term: string, except: string[] = []): Span[] {
  const allowed = except.flatMap((e) => spans(text, e));
  return spans(text, term).filter((m) => !allowed.some((a) => a.start <= m.start && m.end <= a.end));
}

/** A short window of `text` around a match, for messages: `…an Acme sign by…`. */
export function snippet(text: string, s: Span, pad = 24): string {
  let from = Math.max(0, s.start - pad);
  let to = Math.min(text.length, s.end + pad);
  // Don't cut a word in half at either end.
  while (from > 0 && from < s.start && !/\s/.test(text[from - 1]!)) from++;
  while (to < text.length && to > s.end && !/\s/.test(text[to]!)) to--;
  const flat = (x: string): string => x.replace(/\s+/g, ' ');
  return `${from > 0 ? '…' : ''}${flat(text.slice(from, to))}${to < text.length ? '…' : ''}`;
}

/**
 * Required text is compared case-insensitively, with whitespace runs
 * collapsed and the required text's own trailing full stop ignored (prompt
 * builders drop a closing full stop when they quote a note). It is a
 * substring check, not whole-word: the text is a phrase the person locked.
 */
export function normalizeRequired(s: string): string {
  return s.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

export function containsRequired(text: string | undefined, required: string): boolean {
  if (text === undefined) return false;
  const need = normalizeRequired(required);
  if (need === '') return true;
  return text.toLocaleLowerCase('en').replace(/\s+/g, ' ').includes(need);
}
