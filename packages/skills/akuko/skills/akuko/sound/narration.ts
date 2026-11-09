/**
 * akuko — the film's narration block and captions (WP-12).
 *
 * `rebuildNarration()` turns the **approved** voice-over takes into
 * `audio.narration` (Studio's `NarrationBlock`):
 *
 *   - each take is placed at its shot's start on the film's timeline: the sum of
 *     the durations (`duration_s`) of every earlier shot, in shot order;
 *   - its real word timings (shot-relative, from the take's words file) are moved
 *     by that start, so `words[]` are composition-absolute milliseconds;
 *   - the takes are laid on one silent WAV track (`audio/vo/narration.wav`) when
 *     every take is a 16-bit PCM WAV of one format; with other formats (an mp3
 *     the person brought back) the single track cannot be made here and the
 *     block is NOT written (assemble joins audio with its own tools, WP-13),
 *     but captions are still written from the timings;
 *   - `duration_ms` is the film length (all shot durations), `voice_id` the voice
 *     when every take used the same one, `generated_at` the time of the build.
 *
 * Refused, never fudged: a shot with no duration, a take longer than its shot
 * (its words would run into the next shot), a words file that is not valid.
 * Takes recorded without timings contribute audio but no words; they are listed.
 *
 * Captions (WebVTT and SRT, `audio/vo/captions.{vtt,srt}`) are a pure function of
 * the words (`captions.ts`) and are written whenever there are words.
 */

import { createHash } from 'node:crypto';
import type { AkukoProject, Asset, Shot } from '../schema/akuko-project.ts';
import type { WaveOneHost } from '../providers/contract.ts';
import { CAPTION_DEFAULTS, captionsFromWords, formatSrt, formatVtt, type CaptionOptions } from './captions.ts';
import { NO_WORDS_TAG, VOICE_TAG, WORDS_TAG, WordsError, offsetWords, readWordsFile, type NarrationWord, type WordsFile } from './words.ts';
import { isWav, mixWav, parseWav, sameFormat, type Placed, type Wav } from './wav.ts';
import { voAssets } from './plan.ts';

export class NarrationError extends WordsError {
  override name = 'NarrationError';
}

export type ReadFile = (uri: string) => Promise<Uint8Array>;

export interface NarrationDeps {
  host: WaveOneHost;
  /** Reads a stored file by its `file.uri` (on B, from the project folder). */
  readFile: ReadFile;
  now?: () => string;
  captions?: CaptionOptions;
  /** Write the caption files even when nothing changed (otherwise only when the narration changed or no single track exists). */
  forceCaptions?: boolean;
}

/** Start of each shot on the film's timeline, in ms; throws for a shot with no duration. */
export function shotStarts(shots: Shot[]): { starts: Map<string, number>; durations: Map<string, number>; totalMs: number } {
  const starts = new Map<string, number>();
  const durations = new Map<string, number>();
  const missing = shots.filter((s) => s.duration_s === undefined).map((s) => s.id);
  if (missing.length > 0) throw new NarrationError(`These shots have no duration, so voice-over cannot be placed on the timeline: ${missing.join(', ')}.`);
  let t = 0;
  for (const s of shots) {
    const d = Math.round((s.duration_s as number) * 1000);
    starts.set(s.id, t);
    durations.set(s.id, d);
    t += d;
  }
  return { starts, durations, totalMs: t };
}

export type RebuildResult =
  | { status: 'nothing'; reason: string }
  | {
      status: 'built' | 'unchanged';
      /** Words on the film timeline; empty when no approved take has timings. */
      words: number;
      /** Approved takes recorded without word timings: in the audio, but not in the captions. */
      withoutTimings: string[];
      /** Why the single narration track was not made, when it was not. */
      trackSkipped?: string;
      warnings: string[];
      captions?: { vtt: string; srt: string; cues: number };
    };

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The approved takes with a file, in shot order. */
function approvedTakes(p: AkukoProject): Array<{ asset: Asset; shot: Shot }> {
  const order = new Map(p.shots.map((s, i) => [s.id, i]));
  return voAssets(p)
    .filter((a) => a.status === 'approved' && a.file !== undefined)
    .flatMap((a) => { const shot = p.shots.find((s) => s.id === a.owner); return shot ? [{ asset: a, shot }] : []; })
    .sort((x, y) => (order.get(x.shot.id) ?? 0) - (order.get(y.shot.id) ?? 0));
}

/** Rebuild `audio.narration` and the caption files from the approved takes. Re-run after any voice-over is approved or sent back. */
export async function rebuildNarration(deps: NarrationDeps): Promise<RebuildResult> {
  const { host, readFile } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const p = await host.readState();
  const takes = approvedTakes(p);
  if (takes.length === 0) {
    if (p.audio.narration) {
      // Every take was un-approved: the block no longer describes approved audio.
      await host.writeState({ ...p, audio: { ...p.audio, narration: null } });
      return { status: 'nothing', reason: 'No voice-over is approved any more, so audio.narration was cleared.' };
    }
    return { status: 'nothing', reason: 'No voice-over is approved yet.' };
  }

  const { starts, durations, totalMs } = shotStarts(p.shots);
  const warnings: string[] = [];
  const words: NarrationWord[] = [];
  const withoutTimings: string[] = [];
  const wavs: Placed[] = [];
  let allWav = true;
  const voices = new Set<string>();

  for (const { asset, shot } of takes) {
    const start = starts.get(shot.id) as number;
    const slot = durations.get(shot.id) as number;
    const bytes = await readFile(asset.file!.uri);
    const wordsUri = asset.tags.find((t) => t.startsWith(WORDS_TAG))?.slice(WORDS_TAG.length);
    let wf: WordsFile | undefined;
    if (wordsUri) {
      try { wf = readWordsFile(await readFile(wordsUri)); } catch (err) { throw new NarrationError(`${asset.id}: its words file (${wordsUri}) cannot be read: ${err instanceof Error ? err.message : String(err)}`); }
    } else if (!asset.tags.includes(NO_WORDS_TAG)) {
      warnings.push(`${asset.id} has no words file; treated as recorded without timings.`);
    }
    if (!wf) withoutTimings.push(asset.id);

    let length: number | undefined = wf?.duration_ms;
    if (isWav(bytes)) {
      try {
        const wav: Wav = parseWav(bytes);
        length = wav.durationMs;
        wavs.push({ startMs: start, wav });
      } catch { allWav = false; }
    } else {
      allWav = false;
    }
    if (length !== undefined && length > slot) {
      throw new NarrationError(`${asset.id} runs ${(length / 1000).toFixed(2)}s but ${shot.id} lasts ${(slot / 1000).toFixed(2)}s. Shorten the line, ask for a faster read, or lengthen the shot; the words would run into the next shot.`);
    }
    if (length === undefined) warnings.push(`${asset.id}: its length is unknown, so it could not be checked against ${shot.id}'s ${(slot / 1000).toFixed(2)}s.`);
    if (wf) words.push(...offsetWords(wf.words, start));
    const voice = asset.tags.find((t) => t.startsWith(VOICE_TAG))?.slice(VOICE_TAG.length);
    if (voice) voices.add(voice);
  }

  // Words never go backwards across shots (each take fits its slot); assert it rather than trust it.
  for (let i = 1; i < words.length; i++) {
    if (words[i]!.start_ms < words[i - 1]!.start_ms || words[i]!.end_ms < words[i - 1]!.end_ms) throw new NarrationError('word timings are out of order after placing the takes');
  }

  // The single track, when every take can share one WAV.
  let trackSkipped: string | undefined;
  let next: AkukoProject = p;
  if (!allWav) trackSkipped = 'not every approved take is a 16-bit PCM WAV, so one narration track cannot be made here; assemble (WP-13) joins the files with its own tools';
  else if (!sameFormat(wavs.map((w) => w.wav))) trackSkipped = 'the approved takes differ in sample rate or channels, so one narration track cannot be made here';
  if (!trackSkipped) {
    const track = mixWav(wavs, totalMs);
    const hash = sha(track);
    const old = p.audio.narration;
    const same = old?.audio.hash === hash && old.words.length === words.length && JSON.stringify(old.words) === JSON.stringify(words);
    if (same) {
      next = p;
    } else {
      const stored = old?.audio.hash === hash
        ? old.audio
        : await (async () => {
            const a = await host.storeAsset({ kind: 'vo', filename: 'narration.wav', mime: 'audio/wav', data: track, tags: ['narration-track'] });
            return { uri: a.file?.uri ?? '', mime: 'audio/wav', hash, duration_ms: Math.max(totalMs, parseWav(track).durationMs) };
          })();
      next = {
        ...p,
        audio: {
          ...p.audio,
          narration: {
            audio: stored,
            words,
            ...(voices.size === 1 ? { voice_id: [...voices][0] as string } : {}),
            duration_ms: Math.max(totalMs, stored.duration_ms ?? 0),
            generated_at: now(),
          },
        },
      };
      if (voices.size > 1) warnings.push('the takes use more than one voice, so audio.narration.voice_id is left unset');
    }
  } else if (p.audio.narration) {
    // A stale block built from takes that are no longer all approved must not stay.
    next = { ...p, audio: { ...p.audio, narration: null } };
  }
  const changed = next !== p;
  if (changed) await host.writeState(next);

  let captions: { vtt: string; srt: string; cues: number } | undefined;
  if (words.length > 0 && (changed || trackSkipped !== undefined || deps.forceCaptions)) {
    const cues = captionsFromWords(words, deps.captions ?? {});
    const vtt = await host.storeAsset({ kind: 'vo', filename: 'captions.vtt', mime: 'text/vtt', data: new TextEncoder().encode(formatVtt(cues)), tags: ['captions'] });
    const srt = await host.storeAsset({ kind: 'vo', filename: 'captions.srt', mime: 'application/x-subrip', data: new TextEncoder().encode(formatSrt(cues)), tags: ['captions'] });
    captions = { vtt: vtt.file?.uri ?? '', srt: srt.file?.uri ?? '', cues: cues.length };
  }
  return {
    status: changed ? 'built' : 'unchanged',
    words: words.length,
    withoutTimings,
    ...(trackSkipped ? { trackSkipped } : {}),
    warnings,
    ...(captions ? { captions } : {}),
  };
}

export { CAPTION_DEFAULTS };
