/**
 * fal lip-sync provider (direct API, fal's queue).
 *
 * One request per unit (the unit is `<shot>_lipsync`). A job item carries
 *   - an AUDIO segment: a ref with role "audio" (the spoken line, a WAV file
 *     already cut to the shot), and
 *   - ONE picture: a ref with role "start-frame" (a still: image + audio mode)
 *     or role "source-video" (an approved clip: video + audio mode).
 *
 * Job contract (WP-28b builds jobs to this; see lib/providers.md):
 *   - the audio ref and, in video mode, the source-video ref each carry their
 *     length in `note`: `seconds=<n>` (`secondsNote(n)`); image mode may leave
 *     the audio note out and use `duration_s`
 *   - `duration_s` is the BILLING BASIS in seconds, before the model rounds it:
 *     image mode = audio seconds; video mode = the source clip's seconds, or for
 *     a model that bills output seconds, the longer of clip and audio
 *   - the provider measures the real files, refuses a declared length that is
 *     off by more than 0.05 s and any length outside the model's limits, and
 *     prices what it measured (never less than declared)
 *
 *   - sealed with `sealProvider()`: `submit()` only runs inside `gate.run()`
 *   - model ids and prices live only in providers/config.json
 *   - hosts B and C only: a paid direct API is refused on host A (R-11)
 *   - `estimate()` is arithmetic on config; it reads local files (to measure
 *     them) but makes no network call, except to download an `https:` audio
 *     ref it must measure
 *   - EVERYTHING is checked before the first request: paths, sizes, lengths,
 *     limits for every unit. A bad unit 2 is refused before unit 1 is queued.
 *   - files are confined to `projectDir` plus the caller's `allowRoots`
 *   - the key is sent only to queue.fal.run
 *
 * Which model: a job names one, or each unit gets the first configured model
 * of its mode (`default_model` first, then config order) whose limits admit its
 * measured audio (and clip) length: `chooseLipsyncModel`.
 *
 * Per-family request rules live in `LIMITS`, matched on a fragment of the
 * endpoint id, never on a full model id. A model id may end in `#<resolution>`
 * for endpoints priced per resolution.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Asset } from '../../../schema/akuko-project.ts';
import { findUnit } from '../../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../../config.ts';
import { estimateFromConfig, loadProviderConfig, providerConfig, providerKeyEnv } from '../../config.ts';
import type { Cost, Job, JobHandle, JobItem, JobRef, JobStatus, Provider, WaveOneHost } from '../../contract.ts';
import { jobProblems } from '../../contract.ts';
import { jobTag, planAssetId } from '../../outputs.ts';
import { sealProvider } from '../../../spend/gate.ts';
import type { FetchLike } from '../../gemini-image/image-common.ts';
import { fetchOf, toBase64 } from '../../gemini-image/image-common.ts';
import { parseWav } from '../../../sound/wav.ts';
import { probeMp4 } from '../../../handoff/probe.ts';

export const FAL_LIPSYNC_PROVIDER_ID = 'fal-lipsync';
const QUEUE = 'https://queue.fal.run';
const MB = 1024 * 1024;
/** Declared and measured lengths may differ by this much. */
export const LENGTH_TOLERANCE_S = 0.05;
/** Default cap on a file sent inline as a data: URI. fal's docs call data URIs not recommended above a few KB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 4 * MB;

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
  /** The spoken line's length limits, seconds. Absent = fal's page states none. */
  audioMinS?: number;
  audioMaxS?: number;
  maxAudioBytes?: number;
  /** The source clip's length limits (video mode), seconds. */
  clipMinS?: number;
  clipMaxS?: number;
  maxVideoBytes?: number;
  /** Video mode: the model bills the longer of clip and audio (output seconds) instead of the clip's seconds. */
  billsLonger?: boolean;
  /** Billed seconds never go below this. */
  minBilledS?: number;
  /** Billing rounds up to a multiple of this many seconds. */
  billingStep?: number;
  /** Fixed extra body fields. */
  fixed?: Record<string, unknown>;
  /** When set, the model id must end in `#<value>` and the value is sent under this field name. */
  resolutionField?: string;
}

/** First match wins. Matched on a fragment of the endpoint id (see config.json). */
const LIMITS: Array<{ match: RegExp; limits: LipsyncLimits }> = [
  // fal's page: audio at least 5 s. akuko also stops at 15 s: above that fal bills a 1.2x multiplier, which config cannot express.
  { match: /h3-max\/lip-sync\/image-to-video/, limits: { mode: 'image', pictureField: 'image_url', audioMinS: 5, audioMaxS: 15, fixed: { resolution: '768P' } } },
  // fal does not say whether fabric bills audio or output seconds, nor a minimum; priced at max(audio, 1 s).
  { match: /veed\/fabric/, limits: { mode: 'image', pictureField: 'image_url', minBilledS: 1, resolutionField: 'resolution' } },
  // Kling bills the INPUT VIDEO's seconds (rounded up to 5 s); its 2-10 s limit is the video's. Audio has its own limits.
  { match: /kling-video\/lipsync\/audio-to-video/, limits: { mode: 'video', pictureField: 'video_url', clipMinS: 2, clipMaxS: 10, audioMinS: 2, audioMaxS: 60, billingStep: 5, maxAudioBytes: 5 * MB, maxVideoBytes: 100 * MB } },
  // veed lipsync v2 bills OUTPUT seconds: the longer of the clip and the audio.
  { match: /veed\/lipsync/, limits: { mode: 'video', pictureField: 'video_url', billsLonger: true } },
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

const inRange = (v: number, min?: number, max?: number): boolean =>
  (min === undefined || v >= min - LENGTH_TOLERANCE_S) && (max === undefined || v <= max + LENGTH_TOLERANCE_S);

/**
 * The model a unit of this mode runs when the job names none: the first
 * configured model of the mode (`default_model` first, then config order)
 * whose limits admit the measured audio length, and in video mode the clip
 * length. With the shipped config a still with a line of 5-15 s gets h3-max
 * (768P) and a shorter or longer line gets fabric (480p); a clip within 2-10 s
 * with audio of 2-60 s gets Kling, else veed lipsync. Undefined when none fits.
 */
export function chooseLipsyncModel(config: AkukoProviderConfig, mode: LipsyncMode, audioS: number, clipS?: number): string | undefined {
  const entry = providerConfig(config, FAL_LIPSYNC_PROVIDER_ID);
  const ordered = [entry.default_model, ...Object.keys(entry.models).filter((m) => m !== entry.default_model)];
  return ordered.find((m) => {
    const l = falLipsyncLimits(m);
    return l?.mode === mode && inRange(audioS, l.audioMinS, l.audioMaxS) && (mode === 'image' || clipS === undefined || inRange(clipS, l.clipMinS, l.clipMaxS));
  });
}

/** The ref note that declares a length: `seconds=<n>`. */
export const secondsNote = (n: number): string => `seconds=${n}`;
const declared = (r: JobRef | undefined): number | undefined => {
  const m = /(?:^|[\s;,])seconds=(\d+(?:\.\d+)?)(?:$|[\s;,])/.exec(r?.note ?? '');
  return m ? Number(m[1]) : undefined;
};

/** The picture refs (role start-frame or source-video) and audio refs of an item. */
const refsOf = (item: JobItem) => {
  const has = (role: string) => (item.refs ?? []).filter((r) => r.role === role && typeof r.uri === 'string' && r.uri.length > 0);
  return { frame: has('start-frame'), video: has('source-video'), audio: has('audio') };
};

const modeOf = (item: JobItem): LipsyncMode | undefined => {
  const r = refsOf(item);
  return r.frame.length === 1 && r.video.length === 0 ? 'image' : r.video.length === 1 && r.frame.length === 0 ? 'video' : undefined;
};

/** Seconds billed: the basis (never below the model's floor), rounded up to the model's step. */
export const billedSeconds = (basis: number, l: Pick<LipsyncLimits, 'minBilledS' | 'billingStep'> = {}): number => {
  const s = Math.max(basis, l.minBilledS ?? 0);
  return l.billingStep ? Math.ceil(s / l.billingStep - 1e-9) * l.billingStep : s;
};

// ─────────────────────────────────────────────────────────────────────────

const EXT: Record<'audio' | 'video' | 'image', Record<string, string>> = {
  audio: { '.wav': 'audio/wav' },
  video: { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v' },
  image: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' },
};
const WAV_MIMES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

export interface FalLipsyncOptions {
  /** The project folder. Required: files are read only from inside it (and `allowRoots`). */
  projectDir: string;
  /**
   * Extra folders files may be read from. Only the caller passes these, after the
   * person has confirmed each one; nothing in a job, a ref or akuko.json can add one.
   */
  allowRoots?: string[];
  /** Largest file sent inline as a data: URI, in bytes. Default 4 MB. */
  maxUploadBytes?: number;
  config?: AkukoProviderConfig;
  /** The user's key, or a function that returns it. Defaults to the environment variable named by `key_env` in providers/config.json. */
  apiKey?: string | (() => string | undefined);
  fetch?: FetchLike;
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

/** Where one ref's bytes come from, decided and checked before any request. */
type Source =
  | { kind: 'url'; url: string }
  | { kind: 'data'; uri: string }
  | { kind: 'file'; path: string; mime: string };

interface Prepared {
  item: JobItem;
  model: string;
  picture: Source;
  audio: Source;
  audioS: number;
  clipS?: number;
  /** Seconds the provider prices, after rounding. */
  billedS: number;
}

export function createFalLipsyncProvider(host: WaveOneHost, opts: FalLipsyncOptions): Provider {
  if (!opts.projectDir) throw new FalLipsyncError('fal-lipsync needs projectDir: files are read only from inside the project folder');
  const config = opts.config ?? loadProviderConfig();
  const maxUpload = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
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

  const overCap = (what: string, bytes: number, cap: number, why = 'data: URI cap'): FalLipsyncError =>
    new FalLipsyncError(`${what} is ${(bytes / MB).toFixed(1)} MB, over the ${(cap / MB).toFixed(1)} MB ${why}. akuko sends files inline (not through fal's CDN upload, which is a follow-up); use a shorter or smaller file.`);

  // ── file access: confined, extension-checked, size-checked ───────────

  let rootsCache: string[] | undefined;
  async function roots(): Promise<string[]> {
    if (rootsCache) return rootsCache;
    const out: string[] = [];
    for (const r of [opts.projectDir, ...(opts.allowRoots ?? [])]) {
      try {
        out.push(await realpath(resolve(r)));
      } catch {
        if (r === opts.projectDir) throw new FalLipsyncError(`projectDir ${r} does not exist`);
      }
    }
    return (rootsCache = out);
  }
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const inside = (root: string, p: string): boolean => {
    const rel = relative(norm(root), norm(p));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };

  /** The real path of a local ref, refused unless it is inside the project folder or an allowed root. */
  async function localPath(uri: string): Promise<string> {
    let p: string;
    try {
      p = uri.startsWith('file://') ? fileURLToPath(uri) : isAbsolute(uri) ? uri : resolve(opts.projectDir, uri);
    } catch {
      throw new FalLipsyncError(`${uri} is not a usable file path`);
    }
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      throw new FalLipsyncError(`file not found: ${uri}`);
    }
    if (!(await roots()).some((r) => inside(r, real))) {
      throw new FalLipsyncError(`${uri} is outside the project folder and the allowed roots; only files inside them can be read or sent`);
    }
    return real;
  }

  /** Resolve one ref: checks the place, the type and the size without reading the file; measures nothing. */
  async function source(uri: string, role: 'audio' | 'video' | 'image', what: string): Promise<{ src: Source; size?: number }> {
    if (/^http:\/\//i.test(uri)) throw new FalLipsyncError(`${what}: plain http: is refused; use https: or a project file`);
    if (/^https:\/\//i.test(uri)) {
      if (role === 'video') throw new FalLipsyncError(`${what}: a clip at an https: address cannot be measured here; use a file in the project folder`);
      return { src: { kind: 'url', url: uri } };
    }
    if (uri.startsWith('data:')) {
      if (role === 'video') throw new FalLipsyncError(`${what}: a clip cannot be given as a data: URI (its length is read from the file); use a file in the project folder`);
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
      if (!m) throw new FalLipsyncError(`${what} has a malformed data: URI`);
      const mime = (m[1] ?? '').toLowerCase();
      if (role === 'audio' ? !WAV_MIMES.has(mime) : !mime.startsWith('image/')) throw new FalLipsyncError(`${what}: data: URI type ${mime} is not allowed${role === 'audio' ? ' (WAV only)' : ''}`);
      const size = m[2] ? Math.floor(((m[3] ?? '').length * 3) / 4) : (m[3] ?? '').length;
      if (size > maxUpload) throw overCap(what, size, maxUpload);
      return { src: { kind: 'data', uri }, size };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !uri.startsWith('file://')) throw new FalLipsyncError(`${what}: ${uri.split('://')[0]}: addresses are not readable`);
    const path = await localPath(uri);
    const mime = EXT[role][extname(path).toLowerCase()];
    if (!mime) {
      throw new FalLipsyncError(`${what}: ${extname(path) || 'a file with no extension'} is not an allowed ${role} type (${Object.keys(EXT[role]).join(', ')}${role === 'audio' ? '; convert other audio to WAV first' : ''})`);
    }
    const size = (await stat(path)).size;
    if (size > maxUpload) throw overCap(what, size, maxUpload);
    return { src: { kind: 'file', path, mime }, size };
  }

  /** The audio's real length in seconds. WAV only. */
  async function measureAudio(src: Source, what: string): Promise<{ seconds: number; bytes: number }> {
    let bytes: Uint8Array;
    if (src.kind === 'file') bytes = new Uint8Array(await readFile(src.path));
    else if (src.kind === 'data') bytes = new Uint8Array(Buffer.from(src.uri.slice(src.uri.indexOf(',') + 1), 'base64'));
    else {
      const res = await fetchOf(opts.fetch)(src.url);
      if (!res.ok) throw new FalLipsyncError(`${what}: could not download it to measure it (HTTP ${res.status})`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    try {
      const w = parseWav(bytes);
      if (w.frames === 0) throw new FalLipsyncError(`${what} has no audio in it`);
      return { seconds: w.frames / w.sampleRate, bytes: bytes.byteLength };
    } catch (err) {
      if (err instanceof FalLipsyncError) throw err;
      throw new FalLipsyncError(`${what}: ${err instanceof Error ? err.message : String(err)}. Only WAV audio is accepted; convert other formats first`);
    }
  }

  /** The clip's real length in seconds, read from the file's header (never loaded whole). */
  async function measureClip(src: Source, what: string): Promise<number> {
    if (src.kind !== 'file') throw new FalLipsyncError(`${what}: the clip must be a file in the project folder`);
    const p = await probeMp4(src.path).catch(() => ({} as { durationS?: number }));
    if (p.durationS === undefined || !(p.durationS > 0)) throw new FalLipsyncError(`${what}: could not read the clip's length (mp4 / mov only)`);
    return p.durationS;
  }

  const sameLength = (what: string, declaredS: number, measuredS: number): void => {
    if (Math.abs(declaredS - measuredS) > LENGTH_TOLERANCE_S) {
      throw new FalLipsyncError(`${what}: declared ${declaredS} s but the file is ${measuredS.toFixed(2)} s (more than ${LENGTH_TOLERANCE_S} s apart). Nothing was sent; rebuild the job from the real file.`);
    }
  };

  /**
   * Check one unit completely: shape, files, real lengths, the model and its
   * limits. Reads local files, never sends anything to fal.
   */
  async function prepare(job: Job, item: JobItem): Promise<Prepared> {
    const u = `unit "${item.unit}"`;
    if ((item.count ?? 1) !== 1) throw new FalLipsyncError(`${u}: one video per unit; ask for one count`);
    const r = refsOf(item);
    if (r.audio.length !== 1) throw new FalLipsyncError(`${u} needs exactly one audio segment (a ref with role "audio" and a file)`);
    const mode = modeOf(item);
    if (mode === undefined) throw new FalLipsyncError(`${u} needs exactly one picture: a ref with role "start-frame" (a still) or "source-video" (a clip), not both`);
    if (item.duration_s === undefined || !(item.duration_s > 0)) throw new FalLipsyncError(`${u} has no duration_s (the billing basis in seconds)`);
    const audioRef = r.audio[0] as JobRef;
    const picRef = (mode === 'image' ? r.frame : r.video)[0] as JobRef;

    const aSrc = await source(audioRef.uri as string, 'audio', `${u} audio`);
    const pSrc = await source(picRef.uri as string, mode === 'image' ? 'image' : 'video', `${u} ${mode === 'image' ? 'still' : 'clip'}`);
    const audio = await measureAudio(aSrc.src, `${u} audio`);
    const audioDeclared = declared(audioRef) ?? (mode === 'image' ? item.duration_s : undefined);
    if (audioDeclared === undefined) throw new FalLipsyncError(`${u}: the audio ref needs a note "${secondsNote(0)}" with its length`);
    sameLength(`${u} audio`, audioDeclared, audio.seconds);

    let clipS: number | undefined;
    if (mode === 'video') {
      const clipDeclared = declared(picRef);
      if (clipDeclared === undefined) throw new FalLipsyncError(`${u}: the source-video ref needs a note "${secondsNote(0)}" with its length`);
      clipS = await measureClip(pSrc.src, `${u} clip`);
      sameLength(`${u} clip`, clipDeclared, clipS);
    }
    // Model: named by the job, or the first whose limits admit what was measured.
    const model = job.model ?? chooseLipsyncModel(config, mode, audio.seconds, clipS);
    if (!model) throw new FalLipsyncError(`${u}: no configured ${mode}-mode model takes a ${audio.seconds.toFixed(1)} s line${clipS !== undefined ? ` on a ${clipS.toFixed(1)} s clip` : ''}`);
    if (!(model in entry.models)) throw new FalLipsyncError(`model "${model}" is not configured for ${FAL_LIPSYNC_PROVIDER_ID}`);
    const l = falLipsyncLimits(model);
    if (!l) throw new FalLipsyncError(`akuko has no request rules for model "${model}"; it is not used rather than guessed`);
    if (l.mode !== mode) {
      throw new FalLipsyncError(`${u} gives ${mode === 'image' ? 'a still' : 'a video'} but ${model} takes ${l.mode === 'image' ? 'a still' : 'a video'} plus audio; name a ${mode}-mode model`);
    }
    if (!inRange(audio.seconds, l.audioMinS, l.audioMaxS)) {
      throw new FalLipsyncError(`${u}: ${model} takes audio of ${l.audioMinS ?? 0}-${l.audioMaxS ?? 'any'} s, not ${audio.seconds.toFixed(2)} s; split the line or name another model`);
    }
    if (l.maxAudioBytes !== undefined && audio.bytes > l.maxAudioBytes) throw overCap(`${u} audio`, audio.bytes, l.maxAudioBytes, 'limit of this model');
    if (clipS !== undefined && !inRange(clipS, l.clipMinS, l.clipMaxS)) {
      throw new FalLipsyncError(`${u}: ${model} takes a clip of ${l.clipMinS ?? 0}-${l.clipMaxS ?? 'any'} s, not ${clipS.toFixed(2)} s`);
    }
    if (l.maxVideoBytes !== undefined && (pSrc.size ?? 0) > l.maxVideoBytes) throw overCap(`${u} clip`, pSrc.size ?? 0, l.maxVideoBytes, 'limit of this model');

    // The billing basis the job must declare, checked against what was measured.
    const basis = mode === 'image' ? audio.seconds : l.billsLonger ? Math.max(clipS as number, audio.seconds) : (clipS as number);
    const basisDeclared = mode === 'image' ? audioDeclared : l.billsLonger ? Math.max(declared(picRef) as number, audioDeclared) : (declared(picRef) as number);
    if (Math.abs(item.duration_s - basisDeclared) > LENGTH_TOLERANCE_S) {
      throw new FalLipsyncError(`${u}: duration_s is ${item.duration_s} s but ${model} bills ${mode === 'image' ? 'the audio' : l.billsLonger ? 'the longer of clip and audio' : 'the source clip'}, ${basisDeclared} s`);
    }
    return { item, model, picture: pSrc.src, audio: aSrc.src, audioS: audio.seconds, ...(clipS !== undefined ? { clipS } : {}), billedS: billedSeconds(Math.max(item.duration_s, basis), l) };
  }

  /** Every unit checked, in order. Throws on the first problem, before anything is sent. */
  async function prepareAll(job: Job): Promise<Prepared[]> {
    const problems = jobProblems(job);
    if (problems.length) throw new FalLipsyncError(problems.join('; '));
    if (job.kind !== 'video') throw new FalLipsyncError(`${FAL_LIPSYNC_PROVIDER_ID} makes video, not ${job.kind}`);
    const out: Prepared[] = [];
    for (const item of job.items) out.push(await prepare(job, item));
    return out;
  }

  async function field(src: Source): Promise<string> {
    if (src.kind === 'url') return src.url;
    if (src.kind === 'data') return src.uri;
    return `data:${src.mime};base64,${toBase64(new Uint8Array(await readFile(src.path)))}`;
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

  async function enqueue(p: Prepared): Promise<QueuedUnit> {
    const l = falLipsyncLimits(p.model) as NonNullable<ReturnType<typeof falLipsyncLimits>>;
    const body: Record<string, unknown> = {
      [l.pictureField]: await field(p.picture),
      audio_url: await field(p.audio),
      ...(l.fixed ?? {}),
      ...(l.resolutionField && l.resolution ? { [l.resolutionField]: l.resolution } : {}),
    };
    const res = await fetchOf(opts.fetch)(`${QUEUE}/${l.endpoint}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new FalLipsyncError(`fal HTTP ${res.status}: ${text.slice(0, 200)}`);
    const q = JSON.parse(text) as { request_id?: string; status_url?: string; response_url?: string };
    return {
      unit: p.item.unit,
      model: p.model,
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
      capabilities: { i2v: true, maxSeconds: 60, refImages: 1 },

      async estimate(job: Job): Promise<Cost> {
        const prepared = await prepareAll(job);
        const per_unit: Record<string, number> = {};
        const parts: string[] = [];
        let currency = config.currency;
        let verified: string | undefined;
        for (const p of prepared) {
          // Price what the unit bills, with its own model: the measured basis, rounded up to the model's step.
          const c = estimateFromConfig(config, { ...job, model: p.model, items: [{ ...p.item, duration_s: p.billedS }] });
          per_unit[p.item.unit] = c.amount;
          currency = c.currency;
          if (c.last_verified && (!verified || c.last_verified < verified)) verified = c.last_verified;
          const clip = p.clipS !== undefined ? `clip ${p.clipS.toFixed(2)} s, ` : '';
          parts.push(`${p.item.unit} ${p.model} ${p.billedS} s billed (${clip}audio ${p.audioS.toFixed(2)} s)`);
        }
        const models = [...new Set(prepared.map((p) => p.model))];
        const amount = Object.values(per_unit).reduce((a, b) => a + b, 0);
        return {
          amount,
          currency,
          per_unit,
          ...(models.length === 1 ? { model: models[0] as string } : {}),
          basis: `${parts.join('; ')} (config prices per second${verified ? `, verified ${verified}` : ''})`,
          ...(verified ? { last_verified: verified } : {}),
        };
      },

      async submit(job: Job): Promise<JobHandle> {
        // Every unit is fully checked here, before the first request goes out.
        const prepared = await prepareAll(job);
        key();
        const queued: QueuedUnit[] = [];
        for (const p of prepared) {
          try {
            queued.push(await enqueue(p));
          } catch (err) {
            // Nothing queued yet: stop before sending more (a bad key, a refused file).
            if (queued.length === 0) throw err;
            queued.push({ unit: p.item.unit, error: err instanceof Error ? err.message : String(err) });
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
