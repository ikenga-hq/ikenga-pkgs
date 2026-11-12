/**
 * fal video provider (direct API, fal's queue): image-to-video clips.
 *
 * One request per unit: the approved key frame goes in as the start frame, the
 * motion prompt as the text, and a clip comes back. Same REST queue as the fal
 * image provider, so a job's handle (request ids and status/result urls)
 * survives a restart: `poll()` and `fetch()` need only the handle and the key.
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json
 *   - hosts B and C only: a paid direct API is refused on host A (R-11)
 *   - `estimate()` is arithmetic on config (price per second x the clip's
 *     seconds); it never touches the network
 *   - each model makes clips of set lengths: Kling 5 or 10 s, Seedance 2.0 any
 *     whole second from 4 to 15, Seedance 2.5 from 4 to 30. A job that asks for
 *     another length is REFUSED with the allowed lengths; the motion stage rounds
 *     up to an allowed length first and says so (`motion/plan.ts`), and every
 *     billed second is priced (per second x the clip's seconds)
 *   - a model id may carry a resolution variant (`#720p`): same endpoint, sent
 *     as the request's resolution, with its own price in config. Seedance needs
 *     one; akuko never sends "auto" for a length or a resolution
 *   - sound is OFF unless the model id carries the `#audio` variant, which has
 *     its own (higher) price in config. akuko strips the suffix before calling
 *     fal. A different model id is a different job hash, so asking for audio
 *     needs a fresh approval.
 *   - the key is sent only to queue.fal.run
 *
 * Rules per model family live in `LIMITS` (matched on a fragment of the id,
 * never on a full model id: ids stay in config.json).
 */

import type { Asset } from '../../schema/akuko-project.ts';
import { findUnit } from '../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../config.ts';
import { estimateFromConfig, loadProviderConfig, providerConfig, providerKeyEnv } from '../config.ts';
import type { Cost, Job, JobHandle, JobItem, JobStatus, Provider, WaveOneHost } from '../contract.ts';
import { jobProblems } from '../contract.ts';
import { jobTag, planAssetId } from '../outputs.ts';
import { sealProvider } from '../../spend/gate.ts';
import type { FetchLike, RefLoader } from '../gemini-image/image-common.ts';
import { defaultRefLoader, fetchOf, promptText, toBase64 } from '../gemini-image/image-common.ts';

export const FAL_VIDEO_PROVIDER_ID = 'fal-video';
const QUEUE = 'https://queue.fal.run';
/** Suffix on a model id in config.json meaning "same endpoint, native sound on". */
export const AUDIO_SUFFIX = '#audio';
/** A resolution variant on a model id in config.json: `<endpoint>#720p` (before any `#audio`). */
const RESOLUTION_SUFFIX = /#(\d{3,4}p)$/;

export class FalVideoError extends Error {
  override name = 'FalVideoError';
  /** True when trying again later may work (a 5xx or a network error), so the clip must not be written off: fal may already have billed it. */
  transient = false;
}

// ─────────────────────────────────────────────────────────────────────────
// Model limits
// ─────────────────────────────────────────────────────────────────────────

export interface VideoLimits {
  /** Clip lengths the endpoint accepts, ascending, in seconds. */
  allowedSeconds: number[];
  /** Name of the request field that carries the start frame. */
  imageField: string;
  /** Name of the boolean field that turns native sound on or off; absent when the endpoint has none (it is silent). */
  audioField?: string;
  /** Name of the field that carries the resolution; set when the endpoint needs one (the model id then names it, `#720p`). */
  resolutionField?: string;
}

/** Every whole second from `min` to `max`. */
const wholeSeconds = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i);

/** First match wins. Matched on a fragment of the endpoint id (see config.json for the ids). */
const LIMITS: Array<{ match: RegExp; limits: VideoLimits }> = [
  { match: /kling-video\/v2\.5/, limits: { allowedSeconds: [5, 10], imageField: 'image_url' } },
  { match: /kling-video\/v2\.6/, limits: { allowedSeconds: [5, 10], imageField: 'start_image_url', audioField: 'generate_audio' } },
  // Seedance on fal (read 2026-11-12, see config.json): duration "4".."15" (2.0, 2.0 fast) or "4".."30" (2.5), resolution required here.
  { match: /seedance-2\.5\//, limits: { allowedSeconds: wholeSeconds(4, 30), imageField: 'image_url', audioField: 'generate_audio', resolutionField: 'resolution' } },
  { match: /seedance-2\.0\//, limits: { allowedSeconds: wholeSeconds(4, 15), imageField: 'image_url', audioField: 'generate_audio', resolutionField: 'resolution' } },
];

/** The endpoint id, whether sound is on, and the resolution variant if any, from a configured model id. */
export function splitModel(model: string): { endpoint: string; audio: boolean; resolution?: string } {
  const audio = model.endsWith(AUDIO_SUFFIX);
  let endpoint = audio ? model.slice(0, -AUDIO_SUFFIX.length) : model;
  const res = RESOLUTION_SUFFIX.exec(endpoint);
  if (res) endpoint = endpoint.slice(0, res.index);
  return { endpoint, audio, ...(res ? { resolution: res[1]! } : {}) };
}

/**
 * What a configured fal video model can do; undefined when akuko has no rules for it (it is then refused, not
 * guessed). An endpoint that needs a resolution has none unless the id names one, and a resolution on an endpoint
 * that takes none is not sent anywhere: both are refused the same way.
 */
export function falVideoLimits(model: string): (VideoLimits & { audio: boolean; endpoint: string; resolution?: string }) | undefined {
  const { endpoint, audio, resolution } = splitModel(model);
  const hit = LIMITS.find((l) => l.match.test(endpoint));
  if (!hit) return undefined;
  if ((hit.limits.resolutionField !== undefined) !== (resolution !== undefined)) return undefined;
  return { ...hit.limits, audio, endpoint, ...(resolution !== undefined ? { resolution } : {}) };
}

/**
 * The allowed length nearest to `wanted`; a tie goes to the shorter (cheaper)
 * one. Also says whether it had to change the length.
 */
export function snapSeconds(wanted: number, allowed: number[]): { seconds: number; changed: boolean } {
  let best = allowed[0] as number;
  for (const s of allowed) if (Math.abs(s - wanted) < Math.abs(best - wanted)) best = s;
  return { seconds: best, changed: best !== wanted };
}

/** "5 or 10", or "4 to 15" for a run of whole seconds. */
export function secondsText(allowed: number[]): string {
  const sorted = [...allowed].sort((a, b) => a - b);
  const run = sorted.length > 2 && sorted.every((s, i) => i === 0 || s === sorted[i - 1]! + 1);
  return run ? `${sorted[0]} to ${sorted[sorted.length - 1]}` : sorted.join(' or ');
}

export type Fit = 'cover' | 'nearest';

/**
 * The clip length for a shot of `wanted` seconds. `cover` (the default): the
 * shortest allowed length that is at least the shot, so the clip is never
 * shorter than the shot (a short clip cannot be stretched in the editor, a long
 * one is trimmed); if the shot is longer than anything the model makes, the
 * longest, and `capped` says so. `nearest`: the closest length, ties shorter
 * (saves money, may be shorter than the shot).
 */
export function fitSeconds(wanted: number, allowed: number[], fit: Fit = 'cover'): { seconds: number; changed: boolean; capped: boolean } {
  if (fit === 'nearest') return { ...snapSeconds(wanted, allowed), capped: wanted > Math.max(...allowed) };
  const sorted = [...allowed].sort((a, b) => a - b);
  const cover = sorted.find((x) => x >= wanted);
  const seconds = cover ?? (sorted[sorted.length - 1] as number);
  return { seconds, changed: seconds !== wanted, capped: cover === undefined };
}

// ─────────────────────────────────────────────────────────────────────────

export interface FalVideoOptions {
  config?: AkukoProviderConfig;
  /** The user's key, or a function that returns it. Defaults to the environment variable named by `key_env` in providers/config.json. */
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  /** Reads the start-frame file (hosts with their own storage supply one). */
  loadRef?: RefLoader;
  now?: () => string;
}

interface QueuedUnit {
  unit: string;
  request_id?: string;
  status_url?: string;
  response_url?: string;
  model?: string;
  error?: string;
}

const decodeRef = (ref: string): QueuedUnit[] => {
  try {
    const v = JSON.parse(ref.replace(/^falv:/, ''));
    if (Array.isArray(v)) return v as QueuedUnit[];
  } catch { /* falls through */ }
  throw new FalVideoError('this handle was not made by the fal-video provider');
};

function queueUrl(u: string | undefined): string {
  if (!u || !u.startsWith(`${QUEUE}/`)) throw new FalVideoError('fal returned an unexpected status url; refusing to send the key to it');
  return u;
}

const startFrame = (item: JobItem) => (item.refs ?? []).filter((r) => r.role === 'start-frame' && typeof r.uri === 'string' && r.uri.length > 0);

export function createFalVideoProvider(host: WaveOneHost, opts: FalVideoOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const loadRef = opts.loadRef ?? defaultRefLoader(opts.fetch);
  const stored = new Map<string, Asset[]>();
  /** response_url -> video url, read once the queue says COMPLETED (so a bad result fails the poll, not the fetch). */
  const videoUrls = new Map<string, string>();
  /** Units whose result was bad when polled; `fetch` leaves them out. */
  const bad = new Set<string>();
  const entry = providerConfig(config, FAL_VIDEO_PROVIDER_ID);

  const keyEnv = providerKeyEnv(config, FAL_VIDEO_PROVIDER_ID);
  const key = (): string => {
    const k = typeof opts.apiKey === 'function' ? opts.apiKey() : (opts.apiKey ?? (keyEnv ? process.env[keyEnv] : undefined));
    if (!k) throw new FalVideoError(`No fal API key: set ${keyEnv ?? 'the key variable named by key_env in providers/config.json'} (or pass apiKey). Nothing was sent.`);
    return k;
  };
  const headers = (json: boolean): Record<string, string> => ({
    Authorization: `Key ${key()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  const modelOf = (job: Job): string => job.model ?? entry.default_model;

  /** Job shape and limits, run by `estimate()` and again before any request. */
  function check(job: Job): void {
    const problems = jobProblems(job);
    if (problems.length) throw new FalVideoError(problems.join('; '));
    if (job.kind !== 'video') throw new FalVideoError(`${FAL_VIDEO_PROVIDER_ID} makes video, not ${job.kind}`);
    const model = modelOf(job);
    if (!(model in entry.models)) throw new FalVideoError(`model "${model}" is not configured for ${FAL_VIDEO_PROVIDER_ID}`);
    const limits = falVideoLimits(model);
    if (!limits) throw new FalVideoError(`akuko has no request rules for model "${model}"; it is not used rather than guessed`);
    for (const item of job.items) {
      if ((item.count ?? 1) !== 1) throw new FalVideoError(`unit "${item.unit}": one clip per unit; ask for one count`);
      if (startFrame(item).length !== 1) throw new FalVideoError(`unit "${item.unit}" needs exactly one start frame (a ref with role "start-frame" and a file)`);
      if (item.duration_s === undefined) throw new FalVideoError(`unit "${item.unit}" has no duration_s`);
      if (!limits.allowedSeconds.includes(item.duration_s)) {
        throw new FalVideoError(`unit "${item.unit}": ${model} makes clips of ${secondsText(limits.allowedSeconds)} seconds, not ${item.duration_s}.`);
      }
    }
  }

  async function readVideoUrl(e: QueuedUnit): Promise<string> {
    const at = queueUrl(e.response_url);
    const hit = videoUrls.get(at);
    if (hit) return hit;
    const transient = (m: string): FalVideoError => Object.assign(new FalVideoError(m), { transient: true });
    let res: Response;
    try {
      res = await fetchOf(opts.fetch)(at, { headers: headers(false) });
    } catch (err) {
      throw transient(`could not reach fal for the result (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status >= 500) throw transient(`fal result HTTP ${res.status}`);
    if (!res.ok) throw new FalVideoError(`fal result HTTP ${res.status}`);
    let r: { video?: { url?: string } };
    try {
      r = (await res.json()) as { video?: { url?: string } };
    } catch (err) {
      throw transient(`fal's result could not be read (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!r.video?.url) throw new FalVideoError('fal returned no video');
    videoUrls.set(at, r.video.url);
    return r.video.url;
  }

  async function enqueue(model: string, item: JobItem): Promise<QueuedUnit> {
    const limits = falVideoLimits(model) as NonNullable<ReturnType<typeof falVideoLimits>>;
    const frame = startFrame(item)[0] as { uri: string };
    let image = frame.uri;
    if (!/^https:\/\//.test(image)) {
      const f = await loadRef(frame.uri);
      image = `data:${f.mime};base64,${toBase64(f.data)}`;
    }
    const body: Record<string, unknown> = {
      prompt: promptText(item),
      [limits.imageField]: image,
      duration: String(item.duration_s),
      ...(limits.audioField ? { [limits.audioField]: limits.audio } : {}),
      ...(limits.resolutionField && limits.resolution ? { [limits.resolutionField]: limits.resolution } : {}),
    };
    const res = await fetchOf(opts.fetch)(`${QUEUE}/${limits.endpoint}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new FalVideoError(`fal HTTP ${res.status}: ${text.slice(0, 200)}`);
    const q = JSON.parse(text) as { request_id?: string; status_url?: string; response_url?: string };
    return {
      unit: item.unit,
      model,
      ...(q.request_id !== undefined ? { request_id: q.request_id } : {}),
      status_url: queueUrl(q.status_url),
      response_url: queueUrl(q.response_url),
    };
  }

  return sealProvider(
    {
      id: FAL_VIDEO_PROVIDER_ID,
      kinds: ['video'],
      hosts: ['B', 'C'],
      capabilities: { i2v: true, maxSeconds: Math.max(...LIMITS.flatMap((l) => l.limits.allowedSeconds)), nativeAudio: true, refImages: 1 },

      async estimate(job: Job): Promise<Cost> {
        check(job);
        const cost = estimateFromConfig(config, job);
        const sound = splitModel(modelOf(job)).audio ? 'sound on' : 'sound off';
        return { ...cost, basis: `${cost.basis}; ${job.items.map((i) => `${i.unit} ${i.duration_s} s`).join(', ')}; ${sound}` };
      },

      async submit(job: Job): Promise<JobHandle> {
        check(job);
        const model = modelOf(job);
        key();
        const queued: QueuedUnit[] = [];
        for (const item of job.items) {
          try {
            queued.push(await enqueue(model, item));
          } catch (err) {
            // Nothing queued yet: stop before sending more (a bad key, a refused frame).
            if (queued.length === 0) throw err;
            queued.push({ unit: item.unit, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return {
          job: job.id,
          provider: FAL_VIDEO_PROVIDER_ID,
          ref: `falv:${JSON.stringify(queued)}`,
          stage: job.stage,
          units: job.items.map((i) => i.unit),
          submitted_at: (opts.now ?? (() => new Date().toISOString()))(),
          ledger: [],
        };
      },

      async poll(h: JobHandle): Promise<JobStatus> {
        const entries = decodeRef(h.ref);
        const errors: string[] = entries.filter((e) => e.error).map((e) => `${e.unit}: ${e.error}`);
        const atSubmit = errors.length;
        let done = 0;
        let live = 0;
        for (const e of entries) {
          if (e.error) continue;
          live++;
          const res = await fetchOf(opts.fetch)(queueUrl(e.status_url), { headers: headers(false) });
          if (!res.ok) throw new FalVideoError(`fal status HTTP ${res.status} for ${e.unit}`);
          const s = (await res.json()) as { status?: string; error?: string };
          if (s.status === 'COMPLETED') {
            if (s.error) {
              bad.add(e.unit);
              errors.push(`${e.unit}: ${s.error}`);
            } else {
              try {
                await readVideoUrl(e);
                done++;
              } catch (err) {
                // A 5xx or a network error may pass: fal has finished (and billed) the clip, so leave it running and
                // let a later collect try again. Only a 4xx or a result with no video is final.
                if (!(err instanceof FalVideoError && err.transient)) {
                  bad.add(e.unit);
                  errors.push(`${e.unit}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          } else if (s.status !== 'IN_QUEUE' && s.status !== 'IN_PROGRESS') {
            bad.add(e.unit);
            errors.push(`${e.unit}: unexpected status ${String(s.status)}`);
          }
        }
        const running = live - done - (errors.length - atSubmit);
        if (running > 0) return { state: 'running', progress: live ? done / live : 0, message: `${done} of ${live} clips ready` };
        if (errors.length && done === 0) return { state: 'failed', message: errors.join('; ') };
        if (errors.length) {
          // Some clips are made and billed, some are not. Report done so the made ones are fetched and recorded
          // (a failed status would discard them); the others settle at 0 (fal bills only finished clips) and stay
          // draft, so running step again makes a NEW job for them with its own approval.
          const missing = entries.map((e) => e.unit).filter((u) => errors.some((m) => m.startsWith(`${u}: `)));
          return { state: 'done', progress: 1, message: `${missing.length} of ${entries.length} clips failed: ${errors.join('; ')}`, actual: Object.fromEntries(missing.map((u) => [u, 0])) };
        }
        return { state: 'done', progress: 1 };
      },

      async fetch(h: JobHandle): Promise<Asset[]> {
        const cached = stored.get(h.ref);
        if (cached) return cached;
        const out: Asset[] = [];
        for (const e of decodeRef(h.ref)) {
          if (e.error || bad.has(e.unit)) continue;
          const videoUrl = await readVideoUrl(e).catch((err: unknown) => { throw new FalVideoError(`${err instanceof Error ? err.message : String(err)} for ${e.unit}`); });
          const dl = await fetchOf(opts.fetch)(videoUrl);
          if (!dl.ok) throw new FalVideoError(`could not download the clip for ${e.unit} (HTTP ${dl.status})`);
          const data = new Uint8Array(await dl.arrayBuffer());
          if (data.byteLength === 0) throw new FalVideoError(`the clip for ${e.unit} came back empty`);

          const before = await host.readState();
          const ref = findUnit(before, e.unit);
          const planned = planAssetId(before, e.unit, h.stage);
          const kind = planned.inPlace && ref?.kind === 'asset' ? ref.unit.kind : 'clip';
          out.push(await host.storeAsset({
            kind,
            filename: `${planned.id}.mp4`,
            mime: 'video/mp4',
            data,
            id: planned.id,
            provider: FAL_VIDEO_PROVIDER_ID,
            model: e.model ?? entry.default_model,
            tags: [jobTag(h.job), FAL_VIDEO_PROVIDER_ID],
            ...(planned.inPlace ? {} : { owner: e.unit }),
          }));
        }
        stored.set(h.ref, out);
        return out;
      },
    },
    { config },
  );
}
