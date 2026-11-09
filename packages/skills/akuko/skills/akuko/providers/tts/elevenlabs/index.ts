/**
 * ElevenLabs text-to-speech provider (direct API), with word timings.
 *
 * Calls `POST /v1/text-to-speech/{voice_id}/with-timestamps`, which returns the
 * audio (base64) and a per-character alignment. The alignment is grouped into
 * words (`sound/words.ts`) and stored next to the audio as a words file; the
 * audio asset carries a `words:<uri>` tag pointing at it. Timings are the
 * provider's own, never estimated: if a response has no alignment the audio is
 * still recorded (it was paid for) with the `no-words` tag and a message.
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json (per character)
 *   - hosts B and C only: a paid direct API is refused on host A (R-11)
 *   - `estimate()` is arithmetic on config; it never touches the network
 *   - the item's `prompt` IS the narration text, character for character; the
 *     voice id travels as a ref `{role: 'voice', id}`
 *   - output is `wav_24000` (16-bit PCM, no paid-tier requirement), so the
 *     film's narration track can be joined without other tools
 *
 * Results of a submitted job are held for the life of the provider object.
 */

import type { Asset } from '../../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../../config.ts';
import { estimateFromConfig, loadProviderConfig, priceFor, providerConfig, providerKeyEnv } from '../../config.ts';
import type { Cost, Job, JobHandle, JobItem, JobStatus, Provider, WaveOneHost } from '../../contract.ts';
import { jobProblems } from '../../contract.ts';
import { jobTag, planAssetId } from '../../outputs.ts';
import { sealProvider } from '../../../spend/gate.ts';
import { NO_WORDS_TAG, VOICE_TAG, WORDS_FORMAT, WORDS_TAG, WordsError, serializeWords, wordsFromAlignment, type WordsFile } from '../../../sound/words.ts';
import { isWav, parseWav, wavBytes } from '../../../sound/wav.ts';

export const ELEVENLABS_PROVIDER_ID = 'elevenlabs';
const ENDPOINT = 'https://api.elevenlabs.io';
const OUTPUT_FORMAT = 'wav_24000';
const OUTPUT_RATE = 24000;

export type FetchLike = typeof globalThis.fetch;

export interface ElevenLabsOptions {
  config?: AkukoProviderConfig;
  /** The user's key, or a function that returns it. Defaults to the environment variable named by `key_env` in providers/config.json. */
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  endpoint?: string;
  now?: () => string;
}

export class ElevenLabsError extends Error {
  override name = 'ElevenLabsError';
}

interface Held {
  units: Map<string, Asset[]>;
  failures: Map<string, string>;
  notes: Map<string, string>;
  actual: Record<string, number>;
  order: string[];
}

/** The voice a job item asks for. */
export const voiceOf = (item: JobItem): string | undefined => item.refs?.find((r) => r.role === 'voice')?.id;

export function createElevenLabsProvider(host: WaveOneHost, opts: ElevenLabsOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const endpoint = opts.endpoint ?? ENDPOINT;
  const doFetch: FetchLike = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  const held = new Map<string, Held>();
  const keyEnv = providerKeyEnv(config, ELEVENLABS_PROVIDER_ID);

  const key = (): string => {
    const k = typeof opts.apiKey === 'function' ? opts.apiKey() : (opts.apiKey ?? (keyEnv ? process.env[keyEnv] : undefined));
    if (!k) throw new ElevenLabsError(`No ElevenLabs API key: set ${keyEnv ?? 'the key variable named by key_env in providers/config.json'} (or pass apiKey). Nothing was sent.`);
    return k;
  };

  const check = (job: Job): void => {
    const problems = jobProblems(job);
    if (problems.length) throw new ElevenLabsError(problems.join('; '));
    if (job.kind !== 'audio') throw new ElevenLabsError(`${ELEVENLABS_PROVIDER_ID} makes audio, not ${job.kind}`);
    const entry = providerConfig(config, ELEVENLABS_PROVIDER_ID);
    const model = job.model ?? entry.default_model;
    if (!(model in entry.models)) throw new ElevenLabsError(`model "${model}" is not configured for ${ELEVENLABS_PROVIDER_ID}`);
    for (const item of job.items) {
      if (item.output !== 'vo') throw new ElevenLabsError(`unit "${item.unit}": ${ELEVENLABS_PROVIDER_ID} makes voice-over ("vo"), not ${item.output}`);
      if ((item.count ?? 1) !== 1) throw new ElevenLabsError(`unit "${item.unit}": one take per unit (count must be 1)`);
      if (item.prompt.trim() === '') throw new ElevenLabsError(`unit "${item.unit}" has no text to speak`);
      if (!voiceOf(item)) throw new ElevenLabsError(`unit "${item.unit}" names no voice: pass a voice id (list yours at GET /v2/voices).`);
    }
  };

  async function speak(model: string, item: JobItem, apiKey: string): Promise<{ audio: Uint8Array; words?: WordsFile['words']; wordsError?: string }> {
    const voice = voiceOf(item)!;
    const url = `${endpoint}/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.prompt, model_id: model }),
    });
    const text = await res.text();
    let body: { audio_base64?: unknown; alignment?: unknown; detail?: unknown } | undefined;
    try { body = JSON.parse(text) as typeof body; } catch { body = undefined; }
    if (!res.ok) {
      const d = body?.detail;
      const msg = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: { msg?: string }) => x?.msg ?? '').filter(Boolean).join('; ') : (d as { message?: string } | undefined)?.message ?? text.slice(0, 200);
      throw new ElevenLabsError(`ElevenLabs HTTP ${res.status}: ${msg}`);
    }
    if (typeof body?.audio_base64 !== 'string' || body.audio_base64 === '') throw new ElevenLabsError('ElevenLabs returned no audio');
    const raw = new Uint8Array(Buffer.from(body.audio_base64, 'base64'));
    const audio = isWav(raw) ? raw : wavBytes(raw, OUTPUT_RATE); // raw PCM gets a WAV header
    try {
      return { audio, words: wordsFromAlignment(body.alignment) };
    } catch (err) {
      return { audio, wordsError: err instanceof WordsError ? err.message : String(err) };
    }
  }

  return sealProvider(
    {
      id: ELEVENLABS_PROVIDER_ID,
      kinds: ['audio'],
      hosts: ['B', 'C'],
      capabilities: {},

      async estimate(job: Job): Promise<Cost> {
        check(job);
        const cost = estimateFromConfig(config, job);
        const chars = job.items.reduce((n, i) => n + i.prompt.length, 0);
        const price = priceFor(config, ELEVENLABS_PROVIDER_ID, job.model);
        return { ...cost, basis: `${chars} characters × ${price.amount} ${price.currency}/character (${ELEVENLABS_PROVIDER_ID} ${price.model}, price verified ${price.last_verified})` };
      },

      async submit(job: Job): Promise<JobHandle> {
        check(job);
        const model = job.model ?? providerConfig(config, ELEVENLABS_PROVIDER_ID).default_model;
        const perChar = priceFor(config, ELEVENLABS_PROVIDER_ID, model).amount;
        const apiKey = key();
        const state: Held = { units: new Map(), failures: new Map(), notes: new Map(), actual: {}, order: job.items.map((i) => i.unit) };
        let made = 0;
        for (const item of job.items) {
          let r: Awaited<ReturnType<typeof speak>>;
          try {
            r = await speak(model, item, apiKey);
          } catch (err) {
            state.failures.set(item.unit, err instanceof Error ? err.message : String(err));
            // Nothing made yet and the first call failed: stop before sending more (a bad key, a bad voice).
            if (made === 0) throw err;
            continue;
          }
          made++;
          const before = await host.readState();
          const planned = planAssetId(before, item.unit, job.stage);
          const voice = voiceOf(item)!;
          let durationMs: number;
          try { durationMs = parseWav(r.audio).durationMs; } catch { durationMs = r.words?.at(-1)?.end_ms ?? 0; }
          const tags = [jobTag(job.id), ELEVENLABS_PROVIDER_ID, `${VOICE_TAG}${voice}`];
          if (r.words) {
            const file: WordsFile = { format: WORDS_FORMAT, version: 1, unit: item.unit, text: item.prompt, voice_id: voice, model, duration_ms: durationMs, words: r.words };
            const wordsAsset = await host.storeAsset({
              kind: 'vo',
              filename: `${planned.id}-words.json`,
              mime: 'application/json',
              data: serializeWords(file),
              provider: ELEVENLABS_PROVIDER_ID,
              model,
              tags: [jobTag(job.id), 'words-file'],
              owner: item.unit,
            });
            tags.push(`${WORDS_TAG}${wordsAsset.file?.uri ?? ''}`);
          } else {
            tags.push(NO_WORDS_TAG);
            state.notes.set(item.unit, `no word timings came back (${r.wordsError ?? 'no alignment'}); captions need timings`);
          }
          const stored = await host.storeAsset({
            kind: 'vo',
            filename: `${planned.id}.wav`,
            mime: 'audio/wav',
            data: r.audio,
            id: planned.id,
            provider: ELEVENLABS_PROVIDER_ID,
            model,
            tags,
            ...(planned.inPlace ? {} : { owner: item.unit }),
          });
          state.units.set(item.unit, [stored]);
          state.actual[item.unit] = item.prompt.length * perChar;
        }
        const ref = `elevenlabs:${job.id}`;
        held.set(ref, state);
        return {
          job: job.id,
          provider: ELEVENLABS_PROVIDER_ID,
          ref,
          stage: job.stage,
          units: state.order,
          submitted_at: (opts.now ?? (() => new Date().toISOString()))(),
          ledger: [],
        };
      },

      async poll(h: JobHandle): Promise<JobStatus> {
        const s = held.get(h.ref);
        if (!s) return { state: 'failed', message: 'This job was submitted in an earlier session and its results are no longer held. Check the project assets for files tagged with the job id.' };
        const missing = h.units.filter((u) => !s.units.has(u));
        const notes = [...s.notes].map(([u, n]) => `${u}: ${n}`).join('; ');
        if (missing.length === 0) return { state: 'done', progress: 1, actual: s.actual, ...(notes ? { message: notes } : {}) };
        return { state: 'failed', actual: s.actual, message: `no audio for ${missing.join(', ')}: ${missing.map((u) => s.failures.get(u) ?? 'unknown error').join('; ')}` };
      },

      async fetch(h: JobHandle): Promise<Asset[]> {
        const s = held.get(h.ref);
        return h.units.flatMap((u) => s?.units.get(u) ?? []);
      },
    },
    { config },
  );
}
