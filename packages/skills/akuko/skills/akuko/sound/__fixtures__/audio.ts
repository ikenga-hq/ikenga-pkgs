/**
 * Test data for the sound stage: tiny silent WAVs and a mocked ElevenLabs
 * `with-timestamps` response. The per-character times here are TEST DATA standing
 * in for what the provider returns; no code under test produces timings.
 */

import { wavBytes } from '../wav.ts';
import type { FetchLike } from '../../providers/tts/elevenlabs/index.ts';

export const RATE = 24000;

/** `ms` of silence as a 16-bit mono WAV. */
export const silentWav = (ms: number, rate = RATE): Uint8Array => wavBytes(new Uint8Array(Math.round((ms / 1000) * rate) * 2), rate);

/** Character alignment where character i starts at i*perCharMs (test data). */
export function alignmentFor(text: string, perCharMs = 50): { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } {
  const chars = [...text];
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => (i * perCharMs) / 1000),
    character_end_times_seconds: chars.map((_, i) => ((i + 1) * perCharMs) / 1000),
  };
}

export interface Recorded { url: string; method: string; headers: Record<string, string>; body: { text: string; model_id: string } }
export interface MockEleven {
  fetch: FetchLike;
  calls: Recorded[];
}

/** A recording `fetch` answering like ElevenLabs' with-timestamps endpoint. */
export function mockElevenLabs(opts: { perCharMs?: number; noAlignment?: boolean; fail?: (n: number) => Response | undefined; wavMs?: (text: string) => number } = {}): MockEleven {
  const calls: Recorded[] = [];
  const f: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Recorded['body'];
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string> | undefined) }, body });
    const failed = opts.fail?.(calls.length);
    if (failed) return failed;
    const perChar = opts.perCharMs ?? 50;
    const ms = opts.wavMs ? opts.wavMs(body.text) : [...body.text].length * perChar;
    const doc = {
      audio_base64: Buffer.from(silentWav(ms)).toString('base64'),
      alignment: opts.noAlignment ? null : alignmentFor(body.text, perChar),
      normalized_alignment: null,
    };
    return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: f, calls };
}
