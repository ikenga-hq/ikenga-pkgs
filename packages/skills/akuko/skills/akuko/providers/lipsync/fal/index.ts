/**
 * fal lip-sync provider (direct API, fal's queue).
 *
 * One request per unit (the unit is `<shot>_lipsync`). A job item carries
 *   - an AUDIO segment: a ref with role "audio" (the spoken line, already cut
 *     to the shot), and
 *   - ONE picture: a ref with role "start-frame" (a still: image + audio mode)
 *     or role "source-video" (an approved clip: video + audio mode).
 * `duration_s` is the length of that segment in seconds; it is what is
 * checked against the model's limits and what is billed.
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json
 *   - hosts B and C only: a paid direct API is refused on host A (R-11)
 *   - `estimate()` is arithmetic on config (price per second x the segment's
 *     seconds, rounded up to the model's billing step); no network
 *   - files go in the way fal and fal-video send refs: an https url is passed
 *     through, anything else is read and sent as a data: uri
 *   - the key is sent only to queue.fal.run
 *
 * Which model: a job names one, or the default for its mode applies
 * (`defaultLipsyncModel`): image mode uses `default_model` from config; video
 * mode uses the first video-mode model in config order. A fallback is chosen
 * by naming another configured model.
 *
 * Per-family request rules live in `LIMITS`, matched on a fragment of the
 * endpoint id, never on a full model id (ids stay in config.json). A model id
 * may end in `#<resolution>` for endpoints priced per resolution.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Asset } from '../../../schema/akuko-project.ts';
import { findUnit } from '../../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../../config.ts';
import { estimateFromConfig, loadProviderConfig, providerConfig, providerKeyEnv } from '../../config.ts';
import type { Cost, Job, JobHandle, JobItem, JobStatus, Provider, WaveOneHost } from '../../contract.ts';
import { jobProblems } from '../../contract.ts';
import { jobTag, planAssetId } from '../../outputs.ts';
import { sealProvider } from '../../../spend/gate.ts';
import type { FetchLike, RefLoader } from '../../gemini-image/image-common.ts';
import { defaultRefLoader, fetchOf, toBase64 } from '../../gemini-image/image-common.ts';

export const FAL_LIPSYNC_PROVIDER_ID = 'fal-lipsync';
const QUEUE = 'https://queue.fal.run';
const MB = 1024 * 1024;

export class FalLipsyncError extends Error {
  override name = 'FalLipsyncError';
  /** True when trying again later may work (a 5xx or a network error): fal may already have billed it. */
  transient = false;
}

export type LipsyncMode = 'image' | 'video';

export interface LipsyncLimits {
  mode: LipsyncMode;
  /** Request field that carries the picture (still or clip). */
  pictureField: 'image_url' | 'video_url';
  /** Segment length limits in seconds. Absent = fal's page states none. */
  minSeconds?: number;
  maxSeconds?: number;
  /** Billing rounds the segment up to a multiple of this many seconds. */
  billingStep?: number;
  /** File size limits in bytes, checked after the file is read. */
  maxAudioBytes?: number;
  maxVideoBytes?: number;
  /** Fixed extra body fields. */
  fixed?: Record<string, unknown>;
  /** When set, the model id must end in `#<value>` and the value is sent under this field name. */
  resolutionField?: string;
}

/** First match wins. Matched on a fragment of the endpoint id (see config.json). */
const LIMITS: Array<{ match: RegExp; limits: LipsyncLimits }> = [
  // fal's page: audio at least 5 s. akuko also stops at 15 s: above that fal bills a 1.2x multiplier, which config cannot express.
  { match: /h3-max\/lip-sync\/image-to-video/, limits: { mode: 'image', pictureField: 'image_url', minSeconds: 5, maxSeconds: 15, fixed: { resolution: '768P' } } },
  { match: /veed\/fabric/, limits: { mode: 'image', pictureField: 'image_url', resolutionField: 'resolution' } },
  { match: /kling-video\/lipsync\/audio-to-video/, limits: { mode: 'video', pictureField: 'video_url', minSeconds: 2, maxSeconds: 10, billingStep: 5, maxAudioBytes: 5 * MB, maxVideoBytes: 100 * MB } },
  { match: /veed\/lipsync/, limits: { mode: 'video', pictureField: 'video_url' } },
];

/** The endpoint id and the resolution suffix (`#480p`), if any, of a configured model id. */
export const splitModel = (model: string): { endpoint: string; resolution?: string } => {
  const i = model.indexOf('#');
  return i < 0 ? { endpoint: model } : { endpoint: model.slice(0, i), resolution: model.slice(i + 1) };
};

/** What a configured fal lip-sync model needs; undefined when akuko has no rules for it (it is then refused, not guessed). */
export function falLipsyncLimits(model: string): (LipsyncLimits & { endpoint: string; resolution?: string }) | undefined {
  const { endpoint, resolution } = splitModel(model);
  const hit = LIMITS.find((l) => l.match.test(endpoint));
  if (!hit) return undefined;
  if (hit.limits.resolutionField && !resolution) return undefined;
  return { ...hit.limits, endpoint, ...(resolution !== undefined ? { resolution } : {}) };
}

/** The model a job of this mode uses when it names none; undefined when config has none for the mode. */
export function defaultLipsyncModel(config: AkukoProviderConfig, mode: LipsyncMode): string | undefined {
  const entry = providerConfig(config, FAL_LIPSYNC_PROVIDER_ID);
  if (falLipsyncLimits(entry.default_model)?.mode === mode) return entry.default_model;
  return Object.keys(entry.models).find((m) => falLipsyncLimits(m)?.mode === mode);
}

/** The picture refs (role start-frame or source-video) and audio refs of an item. */
const refsOf = (item: JobItem) => {
  const has = (role: string) => (item.refs ?? []).filter((r) => r.role === role && typeof r.uri === 'string' && r.uri.length > 0);
  return { frame: has('start-frame'), video: has('source-video'), audio: has('audio') };
};

const modeOf = (item: JobItem): LipsyncMode | undefined => {
  const r = refsOf(item);
  return r.frame.length === 1 && r.video.length === 0 ? 'image' : r.video.length === 1 && r.frame.length === 0 ? 'video' : undefined;
};

/** Seconds billed for a segment: rounded up to the model's billing step. */
export const billedSeconds = (seconds: number, step?: number): number => (step ? Math.ceil(seconds / step) * step : seconds);

// ─────────────────────────────────────────────────────────────────────────

const MEDIA_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
};

/**
 * Reads a ref file: data: and https: uris go through the shared loader; a path
 * (inside `baseDir` when given) is read here, because the shared loader knows
 * image types only and these refs are also audio and video.
 */
export function mediaRefLoader(f?: FetchLike, baseDir?: string): RefLoader {
  const shared = defaultRefLoader(f);
  return async (uri) => {
    if (uri.startsWith('data:') || /^https?:\/\//.test(uri)) return shared(uri);
    let path = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
    if (baseDir !== undefined && !uri.startsWith('file://') && !isAbsolute(uri)) {
      const abs = resolve(baseDir, uri);
      const rel = relative(resolve(baseDir), abs);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new FalLipsyncError(`${uri} is outside the project folder; only files inside it can be sent`);
      path = abs;
    }
    const mime = MEDIA_MIME[path.split('.').pop()?.toLowerCase() ?? ''];
    if (!mime) throw new FalLipsyncError(`${path}: unknown audio, video or image type`);
    return { mime, data: new Uint8Array(await readFile(path)) };
  };
}

export interface FalLipsyncOptions {
  config?: AkukoProviderConfig;
  /** The user's key, or a function that returns it. Defaults to the environment variable named by `key_env` in providers/config.json. */
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
  /** Reads a ref file (hosts with their own storage supply one). */
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
    const v = JSON.parse(ref.replace(/^fall:/, ''));
    if (Array.isArray(v)) return v as QueuedUnit[];
  } catch { /* falls through */ }
  throw new FalLipsyncError('this handle was not made by the fal-lipsync provider');
};

function queueUrl(u: string | undefined): string {
  if (!u || !u.startsWith(`${QUEUE}/`)) throw new FalLipsyncError('fal returned an unexpected status url; refusing to send the key to it');
  return u;
}

export function createFalLipsyncProvider(host: WaveOneHost, opts: FalLipsyncOptions = {}): Provider {
  const config = opts.config ?? loadProviderConfig();
  const loadRef = opts.loadRef ?? mediaRefLoader(opts.fetch);
  const stored = new Map<string, Asset[]>();
  const videoUrls = new Map<string, string>();
  const bad = new Set<string>();
  const entry = providerConfig(config, FAL_LIPSYNC_PROVIDER_ID);

  const keyEnv = providerKeyEnv(config, FAL_LIPSYNC_PROVIDER_ID);
  const key = (): string => {
    const k = typeof opts.apiKey === 'function' ? opts.apiKey() : (opts.apiKey ?? (keyEnv ? process.env[keyEnv] : undefined));
    if (!k) throw new FalLipsyncError(`No fal API key: set ${keyEnv ?? 'the key variable named by key_env in providers/config.json'} (or pass apiKey). Nothing was sent.`);
    return k;
  };
  const headers = (json: boolean): Record<string, string> => ({
    Authorization: `Key ${key()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  /** The model a job runs: the one it names, else the default for its mode. Throws on mixed or missing modes. */
  function modelOf(job: Job): string {
    if (job.model !== undefined) return job.model;
    const modes = new Set(job.items.map(modeOf));
    const mode = [...modes][0];
    if (modes.size !== 1 || mode === undefined) {
      throw new FalLipsyncError('every unit needs exactly one picture (a "start-frame" still or a "source-video" clip), and all units in a job must be the same kind');
    }
    const m = defaultLipsyncModel(config, mode);
    if (!m) throw new FalLipsyncError(`config.json has no ${mode} lip-sync model for ${FAL_LIPSYNC_PROVIDER_ID}`);
    return m;
  }

  /** Job shape and limits, run by `estimate()` and again before any request. */
  function check(job: Job): void {
    const problems = jobProblems(job);
    if (problems.length) throw new FalLipsyncError(problems.join('; '));
    if (job.kind !== 'video') throw new FalLipsyncError(`${FAL_LIPSYNC_PROVIDER_ID} makes video, not ${job.kind}`);
    const model = modelOf(job);
    if (!(model in entry.models)) throw new FalLipsyncError(`model "${model}" is not configured for ${FAL_LIPSYNC_PROVIDER_ID}`);
    const limits = falLipsyncLimits(model);
    if (!limits) throw new FalLipsyncError(`akuko has no request rules for model "${model}"; it is not used rather than guessed`);
    for (const item of job.items) {
      if ((item.count ?? 1) !== 1) throw new FalLipsyncError(`unit "${item.unit}": one video per unit; ask for one count`);
      const r = refsOf(item);
      if (r.audio.length !== 1) throw new FalLipsyncError(`unit "${item.unit}" needs exactly one audio segment (a ref with role "audio" and a file)`);
      const m = modeOf(item);
      if (m === undefined) throw new FalLipsyncError(`unit "${item.unit}" needs exactly one picture: a ref with role "start-frame" (a still) or "source-video" (a clip), not both`);
      if (m !== limits.mode) {
        throw new FalLipsyncError(`unit "${item.unit}" gives ${m === 'image' ? 'a still' : 'a video'} but ${model} takes ${limits.mode === 'image' ? 'a still' : 'a video'} plus audio; name a ${m}-mode model`);
      }
      const s = item.duration_s;
      if (s === undefined) throw new FalLipsyncError(`unit "${item.unit}" has no duration_s`);
      if (limits.minSeconds !== undefined && s < limits.minSeconds) throw new FalLipsyncError(`unit "${item.unit}": ${model} needs at least ${limits.minSeconds} s of audio, not ${s} s`);
      if (limits.maxSeconds !== undefined && s > limits.maxSeconds) throw new FalLipsyncError(`unit "${item.unit}": ${model} takes at most ${limits.maxSeconds} s, not ${s} s; split the line or pick another model`);
    }
  }

  async function fileField(uri: string, kind: string, maxBytes?: number): Promise<string> {
    if (/^https:\/\//.test(uri)) return uri;
    const f = await loadRef(uri);
    if (maxBytes !== undefined && f.data.byteLength > maxBytes) {
      throw new FalLipsyncError(`the ${kind} file is ${(f.data.byteLength / MB).toFixed(1)} MB; this model takes at most ${maxBytes / MB} MB`);
    }
    return `data:${f.mime};base64,${toBase64(f.data)}`;
  }

  async function readVideoUrl(e: QueuedUnit): Promise<string> {
    const at = queueUrl(e.response_url);
    const hit = videoUrls.get(at);
    if (hit) return hit;
    const transient = (m: string): FalLipsyncError => Object.assign(new FalLipsyncError(m), { transient: true });
    let res: Response;
    try {
      res = await fetchOf(opts.fetch)(at, { headers: headers(false) });
    } catch (err) {
      throw transient(`could not reach fal for the result (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status >= 500) throw transient(`fal result HTTP ${res.status}`);
    if (!res.ok) throw new FalLipsyncError(`fal result HTTP ${res.status}`);
    let r: { video?: { url?: string } };
    try {
      r = (await res.json()) as { video?: { url?: string } };
    } catch (err) {
      throw transient(`fal's result could not be read (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!r.video?.url) throw new FalLipsyncError('fal returned no video');
    videoUrls.set(at, r.video.url);
    return r.video.url;
  }

  async function enqueue(model: string, item: JobItem): Promise<QueuedUnit> {
    const limits = falLipsyncLimits(model) as NonNullable<ReturnType<typeof falLipsyncLimits>>;
    const r = refsOf(item);
    const picture = (limits.mode === 'image' ? r.frame : r.video)[0] as { uri: string };
    const audio = r.audio[0] as { uri: string };
    const body: Record<string, unknown> = {
      [limits.pictureField]: await fileField(picture.uri, limits.mode, limits.mode === 'video' ? limits.maxVideoBytes : undefined),
      audio_url: await fileField(audio.uri, 'audio', limits.maxAudioBytes),
      ...(limits.fixed ?? {}),
      ...(limits.resolutionField && limits.resolution ? { [limits.resolutionField]: limits.resolution } : {}),
    };
    const res = await fetchOf(opts.fetch)(`${QUEUE}/${limits.endpoint}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new FalLipsyncError(`fal HTTP ${res.status}: ${text.slice(0, 200)}`);
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
      id: FAL_LIPSYNC_PROVIDER_ID,
      kinds: ['video'],
      hosts: ['B', 'C'],
      capabilities: { i2v: true, maxSeconds: 15, refImages: 1 },

      async estimate(job: Job): Promise<Cost> {
        check(job);
        const model = modelOf(job);
        const step = (falLipsyncLimits(model) as LipsyncLimits).billingStep;
        // Price what fal bills: the segment rounded up to the model's step.
        const billed: Job = { ...job, model, items: job.items.map((i) => ({ ...i, duration_s: billedSeconds(i.duration_s as number, step) })) };
        const cost = estimateFromConfig(config, billed);
        const parts = billed.items.map((i, n) => {
          const asked = job.items[n]?.duration_s;
          return `${i.unit} ${i.duration_s} s${i.duration_s !== asked ? ` (for ${asked} s)` : ''}`;
        });
        return { ...cost, basis: `${cost.basis}; ${parts.join(', ')}${step ? `; billed in ${step} s steps` : ''}` };
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
            // Nothing queued yet: stop before sending more (a bad key, a refused file).
            if (queued.length === 0) throw err;
            queued.push({ unit: item.unit, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return {
          job: job.id,
          provider: FAL_LIPSYNC_PROVIDER_ID,
          ref: `fall:${JSON.stringify(queued)}`,
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
          if (!res.ok) throw new FalLipsyncError(`fal status HTTP ${res.status} for ${e.unit}`);
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
                // A 5xx or network error may pass: leave it running for a later collect. Only a 4xx or no video is final.
                if (!(err instanceof FalLipsyncError && err.transient)) {
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
        if (running > 0) return { state: 'running', progress: live ? done / live : 0, message: `${done} of ${live} videos ready` };
        if (errors.length && done === 0) return { state: 'failed', message: errors.join('; ') };
        if (errors.length) {
          // Some are made and billed, some are not: report done so the made ones are recorded; the others settle at 0.
          const missing = entries.map((e) => e.unit).filter((u) => errors.some((m) => m.startsWith(`${u}: `)));
          return { state: 'done', progress: 1, message: `${missing.length} of ${entries.length} videos failed: ${errors.join('; ')}`, actual: Object.fromEntries(missing.map((u) => [u, 0])) };
        }
        return { state: 'done', progress: 1 };
      },

      async fetch(h: JobHandle): Promise<Asset[]> {
        const cached = stored.get(h.ref);
        if (cached) return cached;
        const out: Asset[] = [];
        for (const e of decodeRef(h.ref)) {
          if (e.error || bad.has(e.unit)) continue;
          const videoUrl = await readVideoUrl(e).catch((err: unknown) => { throw new FalLipsyncError(`${err instanceof Error ? err.message : String(err)} for ${e.unit}`); });
          const dl = await fetchOf(opts.fetch)(videoUrl);
          if (!dl.ok) throw new FalLipsyncError(`could not download the video for ${e.unit} (HTTP ${dl.status})`);
          const data = new Uint8Array(await dl.arrayBuffer());
          if (data.byteLength === 0) throw new FalLipsyncError(`the video for ${e.unit} came back empty`);

          const before = await host.readState();
          const ref = findUnit(before, e.unit);
          const planned = planAssetId(before, e.unit, h.stage);
          const kind = planned.inPlace && ref?.kind === 'asset' ? ref.unit.kind : 'lipsync';
          out.push(await host.storeAsset({
            kind,
            filename: `${planned.id}.mp4`,
            mime: 'video/mp4',
            data,
            id: planned.id,
            provider: FAL_LIPSYNC_PROVIDER_ID,
            model: e.model ?? entry.default_model,
            tags: [jobTag(h.job), FAL_LIPSYNC_PROVIDER_ID],
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
