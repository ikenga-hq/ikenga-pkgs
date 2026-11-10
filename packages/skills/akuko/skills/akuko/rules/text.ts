/**
 * akuko — project rules: text matching (WP-26).
 *
 * Pure helpers for `rules.banned` (whole words, any case, with exceptions)
 * and `rules.require` (scoped required text). No I/O.
 *
 * **Normalised first.** Text, terms and exceptions all go through `foldText()`:
 * Unicode NFKC (fullwidth letters become ASCII, composed and decomposed accents
 * compare equal, a no-break space becomes a space), invisible characters
 * removed (`\p{Default_Ignorable_Code_Point}`: zero-width spaces and joiners,
 * soft hyphens, the combining grapheme joiner, variation selectors, Hangul
 * fillers), every dash
 * (`\p{Pd}`: en dash, em dash, …) becomes `-`, then full case folding (`ß` and
 * `SS` compare equal, `İ` folds to `i`). Messages quote the folded text.
 *
 * **Whole word.** A match must not touch a letter, digit or combining mark on
 * either side. Everything else (spaces, hyphens, apostrophes, underscores,
 * punctuation, the start or end of the text) is a boundary, so the banned
 * term `gore` matches `Gore-Tex`, `gore.` and `GORE's`, but not `gorey`. A
 * multi-word term matches with any run of whitespace, dashes or underscores
 * between its words (`kelvo dyne` matches `Kelvo–Dyne`).
 *
 * **Known limits.** Accents still count (`cafe` does not match `café`).
 * Plural and other inflected forms are separate words: list each one as its
 * own term (`zorbex`, `zorbexes`). Look-alike letters from other scripts (a
 * Cyrillic `о` inside a Latin word) are not mapped, and HTML entities are not
 * decoded: prompts are plain text.
 */

const WORDCHAR = '[\\p{L}\\p{N}\\p{M}]';
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The comparison form of any text (see the header). Lengths may change: match and quote on the folded text only. */
export function foldText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Pd}/gu, '-')
    .toUpperCase()
    .toLowerCase()
    .replace(/i̇/g, 'i')      // İ → i̇ → i
    .normalize('NFC');
}

/** A whole-word matcher for `phrase`, which must already be folded. */
export function wordPattern(phrase: string): RegExp {
  const body = phrase.trim().split(/[\s\p{Pd}_]+/u).filter(Boolean).map(escape).join('[\\s\\p{Pd}_]+');
  return new RegExp(`(?<!${WORDCHAR})${body}(?!${WORDCHAR})`, 'gu');
}

export interface Span { start: number; end: number }

function spans(folded: string, phrase: string): Span[] {
  const p = foldText(phrase);
  if (p.trim() === '') return [];
  const out: Span[] = [];
  for (const m of folded.matchAll(wordPattern(p))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

export interface BannedHit {
  /** The folded text the spans and the snippet refer to. */
  folded: string;
  spans: Span[];
}

/**
 * Where `term` appears in `text` as a whole word, leaving out every match
 * that lies inside a whole-word match of one of `except` (so `Gore-Tex` in
 * `except` allows that word while `gore` alone stays banned). Spans are on
 * `foldText(text)`.
 */
export function bannedHits(text: string, term: string, except: string[] = []): BannedHit {
  const folded = foldText(text);
  const allowed = except.flatMap((e) => spans(folded, e));
  return { folded, spans: spans(folded, term).filter((m) => !allowed.some((a) => a.start <= m.start && m.end <= a.end)) };
}

/** Just the spans (on the folded text). */
export const bannedMatches = (text: string, term: string, except: string[] = []): Span[] => bannedHits(text, term, except).spans;

/** A short window of `text` (folded) around a match, for messages: `…an acme sign by…`. */
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
 * Required text is compared on folded text (above), with whitespace runs
 * collapsed and the required text's own trailing full stop ignored (prompt
 * builders drop a closing full stop when they quote a note). It is a
 * substring check, not whole-word: the text is a phrase the person locked.
 */
export function normalizeRequired(s: string): string {
  return foldText(s).replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

export function containsRequired(text: string | undefined, required: string): boolean {
  if (text === undefined) return false;
  const need = normalizeRequired(required);
  if (need === '') return true;
  return foldText(text).replace(/\s+/g, ' ').includes(need);
}
