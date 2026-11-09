// WP-12 — word timings, captions and the WAV helper: pure functions, no host.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CAPTION_DEFAULTS, captionsFromNarration, captionsFromWords, formatSrt, formatVtt } from './captions.ts';
import { WORDS_FORMAT, WordsError, offsetWords, parseWordsFile, readWordsFile, serializeWords, wordsFromAlignment, type NarrationWord } from './words.ts';
import { WavError, mixWav, parseWav, wavBytes } from './wav.ts';
import { alignmentFor, silentWav } from './__fixtures__/audio.ts';

const w = (word: string, s: number, e: number): NarrationWord => ({ word, start_ms: s, end_ms: e });

describe('words from a provider alignment', () => {
  it('groups characters into words at whitespace; punctuation stays attached; times are whole ms', () => {
    const words = wordsFromAlignment(alignmentFor('Oh, so gently!', 40));
    assert.deepEqual(words, [w('Oh,', 0, 120), w('so', 160, 240), w('gently!', 280, 560)]);
  });

  it('rounds seconds to the nearest millisecond', () => {
    const words = wordsFromAlignment({ characters: ['a', ' ', 'b'], character_start_times_seconds: [0.0004, 0.1, 0.1236], character_end_times_seconds: [0.1, 0.1236, 0.2] });
    assert.deepEqual(words, [w('a', 0, 100), w('b', 124, 200)]);
  });

  it('refuses a missing alignment, mismatched arrays and unusable times (no guessing)', () => {
    assert.throws(() => wordsFromAlignment(null), WordsError);
    assert.throws(() => wordsFromAlignment({ characters: ['a'], character_start_times_seconds: [], character_end_times_seconds: [0.1] }), /differ in length/);
    assert.throws(() => wordsFromAlignment({ characters: ['a'], character_start_times_seconds: [0.2], character_end_times_seconds: [0.1] }), /no usable timing/);
    assert.throws(() => wordsFromAlignment({ characters: ['a', ' ', 'b'], character_start_times_seconds: [0.5, 0.6, 0.1], character_end_times_seconds: [0.6, 0.7, 0.2] }), /out of order/);
  });
});

describe('words file a person brings back', () => {
  const text = 'Hello there.';
  it('accepts an object with words, a bare list, or an akuko words file', () => {
    const list = [w('Hello', 0, 400), w('there.', 450, 900)];
    for (const doc of [{ words: list }, list, { format: WORDS_FORMAT, words: list, duration_ms: 1000 }]) {
      const f = parseWordsFile(JSON.stringify(doc), 'sc1_sh1_vo', text);
      assert.deepEqual(f.words, list);
      assert.equal(f.duration_ms, Array.isArray(doc) || !('duration_ms' in doc) ? 900 : 1000);
    }
  });

  it('refuses text that is not timings: wrong shape, seconds as strings, no words, out of order, length shorter than the words', () => {
    assert.throws(() => parseWordsFile('nope', 'u', text), /not valid JSON/);
    assert.throws(() => parseWordsFile('{"words":[{"word":"a","start_ms":"0","end_ms":1}]}', 'u', text), /milliseconds/);
    assert.throws(() => parseWordsFile('{"words":[]}', 'u', text), /no words/);
    assert.throws(() => parseWordsFile(JSON.stringify([w('b', 500, 600), w('a', 0, 100)]), 'u', text), /out of order/);
    assert.throws(() => parseWordsFile(JSON.stringify({ words: [w('a', 0, 900)], duration_ms: 500 }), 'u', text), /ends before the last word/);
  });

  it('round-trips through the stored form and offsets onto the film timeline', () => {
    const f = parseWordsFile(JSON.stringify([w('a', 10, 20), w('b', 30, 40)]), 'u', 'a b');
    assert.deepEqual(readWordsFile(serializeWords(f)), f);
    assert.deepEqual(offsetWords(f.words, 1000), [w('a', 1010, 1020), w('b', 1030, 1040)]);
    assert.throws(() => readWordsFile(new TextEncoder().encode('{"format":"other"}')), /not an akuko words file/);
  });
});

describe('captions', () => {
  const sentence = (text: string, per = 50, at = 0): NarrationWord[] => offsetWords(wordsFromAlignment(alignmentFor(text, per)), at);

  it('cue times are exactly the first word start and last word end', () => {
    const words = sentence('And every night, about midnight.', 50, 12000);
    const cues = captionsFromWords(words);
    assert.equal(cues.length, 1);
    assert.equal(cues[0]!.start_ms, words[0]!.start_ms);
    assert.equal(cues[0]!.end_ms, words.at(-1)!.end_ms);
    assert.equal(cues[0]!.text, 'And every night, about midnight.');
  });

  it('breaks at the character limit, the duration limit, a long pause, and after a sentence end', () => {
    const long = sentence('one two three four five six seven eight nine ten eleven twelve');
    const byChars = captionsFromWords(long);
    assert.ok(byChars.length > 1 && byChars.every((c) => c.text.length <= CAPTION_DEFAULTS.maxChars));
    assert.equal(byChars.map((c) => c.text).join(' '), 'one two three four five six seven eight nine ten eleven twelve');

    const slow = [w('a', 0, 2000), w('b', 2000, 4000), w('c', 4000, 6000)];
    assert.equal(captionsFromWords(slow).length, 2, 'cue never lasts past 5s');
    assert.equal(captionsFromWords(slow, { maxDurationMs: 60000 }).length, 1);

    const gap = [w('a', 0, 100), w('b', 1500, 1600)];
    assert.equal(captionsFromWords(gap).length, 2, 'a pause of a second or more starts a new cue');

    const two = [w('Done.', 0, 100), w('Next', 110, 200)];
    assert.deepEqual(captionsFromWords(two).map((c) => c.text), ['Done.', 'Next']);
  });

  it('a word longer than the limit still gets a cue; no words, no cues', () => {
    assert.deepEqual(captionsFromWords([w('x'.repeat(60), 0, 10)]).map((c) => c.text.length), [60]);
    assert.deepEqual(captionsFromWords([]), []);
  });

  it('formats WebVTT and SRT with the right separators and numbering', () => {
    const cues = captionsFromNarration({ audio: { uri: 'u' }, words: [w('Hi.', 3_723_004, 3_724_000), w('There', 3_725_500, 3_726_000)], duration_ms: 4_000_000, generated_at: 'x' });
    assert.equal(formatVtt(cues), 'WEBVTT\n\n1\n01:02:03.004 --> 01:02:04.000\nHi.\n\n2\n01:02:05.500 --> 01:02:06.000\nThere\n');
    assert.equal(formatSrt(cues), '1\n01:02:03,004 --> 01:02:04,000\nHi.\n\n2\n01:02:05,500 --> 01:02:06,000\nThere\n');
  });
});

describe('wav', () => {
  it('writes and reads 16-bit PCM and reports the exact length', () => {
    const wav = parseWav(silentWav(1500));
    assert.equal(wav.sampleRate, 24000);
    assert.equal(wav.channels, 1);
    assert.equal(wav.durationMs, 1500);
  });

  it('places clips at their start on one silent track and refuses overlaps and mixed formats', () => {
    const a = parseWav(silentWav(1000));
    const b = parseWav(silentWav(500));
    const track = parseWav(mixWav([{ startMs: 0, wav: a }, { startMs: 3000, wav: b }], 5000));
    assert.equal(track.durationMs, 5000);
    assert.throws(() => mixWav([{ startMs: 0, wav: a }, { startMs: 500, wav: b }], 2000), /overlap/);
    assert.throws(() => mixWav([{ startMs: 0, wav: a }, { startMs: 2000, wav: parseWav(silentWav(100, 16000)) }], 3000), /differ/);
    assert.throws(() => parseWav(new Uint8Array(20)), WavError);
    assert.equal(parseWav(wavBytes(new Uint8Array(48000), 24000)).durationMs, 1000);
  });

  it('puts the samples at the right place', () => {
    const pcm = new Uint8Array(24 * 2 * 10).fill(7); // 10 ms of non-zero audio at 24 kHz
    const track = parseWav(mixWav([{ startMs: 20, wav: parseWav(wavBytes(pcm, 24000)) }], 40));
    const at = (ms: number): number => track.pcm[Math.round((ms * 24000) / 1000) * 2]!;
    assert.equal(at(19), 0);
    assert.equal(at(20), 7);
    assert.equal(at(29), 7);
    assert.equal(at(30), 0);
  });
});

describe('punctuation-only tokens', () => {
  it('a standalone dash joins the word before it; one at the very start stays', () => {
    const words = wordsFromAlignment(alignmentFor('wait — then go', 40));
    assert.deepEqual(words.map((x) => x.word), ['wait —', 'then', 'go']);
    assert.deepEqual(words[0], { word: 'wait —', start_ms: 0, end_ms: 240 });
    assert.deepEqual(wordsFromAlignment(alignmentFor('— go', 40)).map((x) => x.word), ['—', 'go']);
    assert.deepEqual(captionsFromWords(words).map((c) => c.text), ['wait — then go']);
  });
});
