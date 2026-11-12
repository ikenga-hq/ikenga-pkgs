/**
 * Pieces shared by the direct video providers that run a remote job per clip
 * (`gemini-video`, `kling-video`, `byteplus-video`): the job checks, the
 * start frame, the handle, the poll roll-up and storing the clip. Holds no
 * model ids and no prices (those live in providers/config.json) and never
 * calls a paid endpoint on its own: each provider supplies the three calls
 * (`enqueue`, `status`, `download`), and `submit()` is still reachable only
 * through the spend gate (`sealProvider`).
 *
 * Semantics are the fal-video ones (`providers/fal-video/index.ts`), so the
 * motion stage treats every video provider the same:
 *   - one clip per unit, exactly one start frame, a length the model makes
 *     (refused otherwise, with the allowed lengths);
 *   - a handle carries each unit's remote id, so `poll()` / `fetch()` work from
 *     the handle and the key alone (a later session can collect);
 *   - a status read that fails with a 5xx or a network error leaves the clip
 *     running (the provider may already have billed it); a 4xx or a failed
 *     task is final;
 *   - a batch that partly fails reports `done` with the missing clips settled
 *     at 0, so the made ones are recorded and the others stay draft.
 */

import type { Asset } from '../schema/akuko-project.ts';
import { findUnit } from '../schema/akuko-project.ts';
import type { AkukoProviderConfig } from './config.ts';
import { estimateFromConfig, providerConfig } from './config.ts';
import type { Cost, Job, JobHandle, JobItem, JobRef, JobStatus, Provider, ProviderCapabilities, WaveOneHost } from './contract.ts';
import { jobProblems } from './contract.ts';
import { jobTag, planAssetId } from './outputs.ts';
import { sealProvider } from '../spend/gate.ts';
import type { FetchLike, LoadedRef, RefLoader } from './gemini-image/image-common.ts';
import { secondsText } from './fal-video/index.ts';

/** A video provider's failure. `transient`: trying again later may work (5xx, network), so the clip must not be written off. */
export class VideoProviderError extends Error {
  override name = 'VideoProviderError';
  transient = false;
  constructor(message: string, opts: { transient?: boolean } = {}) {
    super(message);
    this.transient = opts.transient === true;
  }
}

export const transientError = (m: string): VideoProviderError => new VideoProviderError(m, { transient: true });

/** Every whole second from `min` to `max`. */
export const wholeSeconds = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i);

/** Suffix meaning "same request, native sound on" (its own price in config). */
export const AUDIO_VARIANT = 'audio';

/**
 * A configured model id is `<remote model>#<variant>#...`: the part before the
 * first `#` is sent as the model, the variants (a resolution, a mode, `audio`)
 * become request fields. A different id is a different job hash, so a variant
 * change always needs a fresh approval.
 */
export function splitVariants(model: string): { base: string; variants: string[]; audio: boolean } {
  const [base = '', ...variants] = model.split('#');
  return { base, variants, audio: variants.includes(AUDIO_VARIANT) };
}

export interface ClipLimits {
  /** Clip lengths the model makes, ascending, in seconds. */
  allowedSeconds: number[];
}

/** Refs with role `start-frame` and a file. */
export const startFrames = (item: JobItem): Array<JobRef & { uri: string }> =>
  (item.refs ?? []).filter((r): r is JobRef & { uri: string } => r.role === 'start-frame' && typeof r.uri === 'string' && r.uri.length > 0);

/** The key: the option, else the environment variable config names. Throws (nothing sent) when absent. */
export function keyReader(
  opt: string | (() => string | undefined) | undefined,
  env: string | undefined,
  what: string,
): () => string {
  return () => {
    const k = typeof opt === 'function' ? opt() : (opt ?? (env ? process.env[env] : undefined));
    if (!k) throw new VideoProviderError(`No ${what}: set ${env ?? 'the variable named by key_env in providers/config.json'} (or pass it as an option). Nothing was sent.`);
    return k;
  };
}

/** Read a JSON body; a body that cannot be read is transient (the request may still have worked). */
export async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw transientError(`${what}: the answer could not be read (HTTP ${res.status}: ${text.slice(0, 120)})`);
  }
}

/** Download a finished clip. No key is sent (the output url is the provider's signed or public link). */
export async function downloadBytes(fetchFn: FetchLike, url: string, unit: string): Promise<Uint8Array> {
  if (!/^https:\/\//.test(url)) throw new VideoProviderError(`the clip url for ${unit} is not https; refusing to download it`);
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw transientError(`could not download the clip for ${unit} (${err instanceof Error ? err.message : String(err)}; on claude.ai, allow the host of ${new URL(url).host} in the network settings)`);
  }
  if (res.status >= 500) throw transientError(`could not download the clip for ${unit} (HTTP ${res.status})`);
  if (!res.ok) throw new VideoProviderError(`could not download the clip for ${unit} (HTTP ${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength === 0) throw new VideoProviderError(`the clip for ${unit} came back empty`);
  return data;
}

/** One unit of a submitted job, as kept in the handle (JSON). `extra` is provider-specific (e.g. a file name). */
export interface QueuedClip {
  unit: string;
  model: string;
  remote?: string;
  extra?: Record<string, string>;
  error?: string;
}

export type ClipStatus =
  | { state: 'running'; progress?: number }
  | { state: 'done'; output: string }
  | { state: 'failed'; message: string };

export interface AsyncVideoSpec {
  id: string;
  /** Handle ref prefix, e.g. `kling:`. */
  refPrefix: string;
  config: AkukoProviderConfig;
  host: WaveOneHost;
  capabilities: ProviderCapabilities;
  now?: () => string;
  /** Request rules for a configured model; undefined = akuko has none (refused, never guessed). */
  limits(model: string): ClipLimits | undefined;
  /** Extra per-item checks (aspect ratio, image type). Throw a VideoProviderError to refuse. */
  checkItem?(model: string, item: JobItem): void;
  /** Extra words for the estimate's basis. */
  basisNote?(job: Job, model: string): string;
  /** Throws when the key is missing (called before anything is sent). */
  ensureKey(): void;
  /** Start one clip; returns the provider's id for it. */
  enqueue(model: string, item: JobItem): Promise<{ remote: string; extra?: Record<string, string> }>;
  /** Where one clip stands. Throw a transient VideoProviderError to leave it running. */
  status(e: QueuedClip & { remote: string }): Promise<ClipStatus>;
  /** The clip's bytes, from what `status` returned as `output`. */
  download(e: QueuedClip & { remote: string }, output: string): Promise<{ data: Uint8Array; mime?: string }>;
}

const live = (e: QueuedClip): e is QueuedClip & { remote: string } => !e.error && typeof e.remote === 'string';

/** Build a sealed provider from the three calls. Hosts A, B and C (host A only through the pasted-key flow, which the gate enforces). */
export function createAsyncVideoProvider(spec: AsyncVideoSpec): Provider {
  const { config, host } = spec;
  const entry = providerConfig(config, spec.id);
  const outputs = new Map<string, string>(); // `${ref}|${unit}` -> output, once the clip is done
  const bad = new Set<string>();
  const stored = new Map<string, Asset[]>();
  const modelOf = (job: Job): string => job.model ?? entry.default_model;

  const decode = (ref: string): QueuedClip[] => {
    if (ref.startsWith(spec.refPrefix)) {
      try {
        const v = JSON.parse(ref.slice(spec.refPrefix.length));
        if (Array.isArray(v)) return v as QueuedClip[];
      } catch { /* falls through */ }
    }
    throw new VideoProviderError(`this handle was not made by the ${spec.id} provider`);
  };

  function check(job: Job): { model: string; limits: ClipLimits } {
    const problems = jobProblems(job);
    if (problems.length) throw new VideoProviderError(problems.join('; '));
    if (job.kind !== 'video') throw new VideoProviderError(`${spec.id} makes video, not ${job.kind}`);
    const model = modelOf(job);
    // An unverified model is refused by estimateFromConfig with "price unverified"; say the same here first.
    if (!(model in entry.models) && !(model in (entry.unverified_models ?? {}))) throw new VideoProviderError(`model "${model}" is not configured for ${spec.id}`);
    const limits = spec.limits(model);
    if (!limits) throw new VideoProviderError(`akuko has no request rules for ${spec.id} model "${model}"; it is not used rather than guessed`);
    for (const item of job.items) {
      if ((item.count ?? 1) !== 1) throw new VideoProviderError(`unit "${item.unit}": one clip per unit; ask for one count`);
      if (startFrames(item).length !== 1) throw new VideoProviderError(`unit "${item.unit}" needs exactly one start frame (a ref with role "start-frame" and a file)`);
      if (item.duration_s === undefined) throw new VideoProviderError(`unit "${item.unit}" has no duration_s`);
      if (!limits.allowedSeconds.includes(item.duration_s)) {
        throw new VideoProviderError(`unit "${item.unit}": ${model} makes clips of ${secondsText(limits.allowedSeconds)} seconds, not ${item.duration_s}.`);
      }
      spec.checkItem?.(model, item);
    }
    return { model, limits };
  }

  async function settle(ref: string, e: QueuedClip & { remote: string }): Promise<'done' | 'running' | { failed: string }> {
    const k = `${ref}|${e.unit}`;
    if (outputs.has(k)) return 'done';
    if (bad.has(k)) return { failed: 'failed earlier' };
    let s: ClipStatus;
    try {
      s = await spec.status(e);
    } catch (err) {
      if (err instanceof VideoProviderError && err.transient) return 'running';
      bad.add(k);
      return { failed: err instanceof Error ? err.message : String(err) };
    }
    if (s.state === 'running') return 'running';
    if (s.state === 'failed') { bad.add(k); return { failed: s.message }; }
    outputs.set(k, s.output);
    return 'done';
  }

  return sealProvider(
    {
      id: spec.id,
      kinds: ['video'],
      hosts: ['A', 'B', 'C'],
      capabilities: spec.capabilities,

      async estimate(job: Job): Promise<Cost> {
        const { model } = check(job);
        const cost = estimateFromConfig(config, job);
        const sound = splitVariants(model).audio ? 'sound on' : 'sound off';
        const note = spec.basisNote?.(job, model);
        return { ...cost, basis: `${cost.basis}; ${job.items.map((i) => `${i.unit} ${i.duration_s} s`).join(', ')}; ${sound}${note ? `; ${note}` : ''}` };
      },

      async submit(job: Job): Promise<JobHandle> {
        const { model } = check(job);
        spec.ensureKey();
        const queued: QueuedClip[] = [];
        for (const item of job.items) {
          try {
            const q = await spec.enqueue(model, item);
            queued.push({ unit: item.unit, model, remote: q.remote, ...(q.extra ? { extra: q.extra } : {}) });
          } catch (err) {
            // Nothing started yet: stop before sending more (a bad key, a refused frame).
            if (queued.length === 0) throw err;
            queued.push({ unit: item.unit, model, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return {
          job: job.id,
          provider: spec.id,
          ref: `${spec.refPrefix}${JSON.stringify(queued)}`,
          stage: job.stage,
          units: job.items.map((i) => i.unit),
          submitted_at: (spec.now ?? (() => new Date().toISOString()))(),
          ledger: [],
        };
      },

      async poll(h: JobHandle): Promise<JobStatus> {
        const entries = decode(h.ref);
        const errors: string[] = entries.filter((e) => e.error).map((e) => `${e.unit}: ${e.error}`);
        let done = 0;
        let running = 0;
        for (const e of entries) {
          if (!live(e)) continue;
          const r = await settle(h.ref, e);
          if (r === 'done') done++;
          else if (r === 'running') running++;
          else errors.push(`${e.unit}: ${r.failed}`);
        }
        const total = entries.filter(live).length;
        if (running > 0) return { state: 'running', progress: total ? done / total : 0, message: `${done} of ${total} clips ready` };
        if (errors.length && done === 0) return { state: 'failed', message: errors.join('; ') };
        if (errors.length) {
          const missing = entries.map((e) => e.unit).filter((u) => errors.some((m) => m.startsWith(`${u}: `)));
          return { state: 'done', progress: 1, message: `${missing.length} of ${entries.length} clips failed: ${errors.join('; ')}`, actual: Object.fromEntries(missing.map((u) => [u, 0])) };
        }
        return { state: 'done', progress: 1 };
      },

      async fetch(h: JobHandle): Promise<Asset[]> {
        const cached = stored.get(h.ref);
        if (cached) return cached;
        const out: Asset[] = [];
        for (const e of decode(h.ref)) {
          if (!live(e)) continue;
          const k = `${h.ref}|${e.unit}`;
          if (bad.has(k)) continue;
          if (!outputs.has(k) && (await settle(h.ref, e)) !== 'done') continue;
          const { data, mime } = await spec.download(e, outputs.get(k) as string);
          const before = await host.readState();
          const ref = findUnit(before, e.unit);
          const planned = planAssetId(before, e.unit, h.stage);
          const kind = planned.inPlace && ref?.kind === 'asset' ? ref.unit.kind : 'clip';
          out.push(await host.storeAsset({
            kind,
            filename: `${planned.id}.mp4`,
            mime: mime ?? 'video/mp4',
            data,
            id: planned.id,
            provider: spec.id,
            model: e.model,
            tags: [jobTag(h.job), spec.id],
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

/** Load a unit's start frame (bytes and mime) through the provider's ref loader. */
export async function loadStartFrame(item: JobItem, loadRef: RefLoader): Promise<LoadedRef> {
  return loadRef((startFrames(item)[0] as { uri: string }).uri);
}
