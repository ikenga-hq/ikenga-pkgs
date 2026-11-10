/**
 * akuko — project rules: where a reference file came from (WP-26).
 *
 * Every reference a job would send is either **generated** (akuko made it
 * through a paid provider and the ledger shows it) or **external** (anything
 * else: a photo the person supplied, a file brought back by hand for a manual
 * job, a file on a web server). An external file may be uploaded only when
 * its content hash is in `rules.uploads.allow` (`check.ts`).
 *
 * ## "Generated", precisely
 *
 * A ref is generated when it resolves to an asset in `assets[]` and all of:
 *
 * 1. **Same asset, same file.** `ref.id` is the asset's id and, when the ref
 *    carries a `uri`, it is the asset's `file.uri` (a ref can't borrow a
 *    generated asset's id while pointing at another file).
 * 2. **Made, not supplied.** The asset's kind is not `reference` (a picture
 *    the person supplied) or `card` (finished material).
 * 3. **By a paid provider job.** It has a `provider` other than `manual`, and
 *    a `job:<id>` tag (`providers/outputs.ts` `jobTag`) such that the ledger
 *    has an entry with that `job`, the same `provider`, status `done`, and
 *    `unit` equal to the asset's id or its owner (the unit it was made for).
 *    The gate writes that entry only in `collect()`, after the provider
 *    returned the file. A manual ingest is never generated, whatever the
 *    ledger says: the person made that file somewhere akuko didn't see.
 * 4. **Unchanged.** When the asset's `file.hash` is a sha256 (what the local
 *    host records in `storeAsset`) and the file is readable, the bytes on disk
 *    must still hash to it. A swapped file is refused as `generated-changed`.
 * 5. **Verified, for a never-from-photo entry.** A generated ref that is a
 *    reference for a `never_from_photo` entry must also have a sha256
 *    `file.hash` that the bytes on disk match (`verified`); without one it is
 *    treated as unverifiable and refused (`check.ts`).
 *
 * ## Slices (for WP-28b)
 *
 * A time-slice cut by akuko from an allowed file (a line cut from the master
 * WAV) is a new file with a new hash. Its provenance lives in the project
 * state, never in the job: the cutter records the slice as an **asset** with
 *
 *     provider: "akuko-cut"                                      (SLICE_PROVIDER)
 *     tags:     ["slice-of:sha256:<64 hex of the SOURCE>@<in_s>-<out_s>"]   (sliceTag())
 *     file:     { uri, hash: <sha256 of the slice> }             (the local host records it)
 *
 * and the job's ref names that asset (`ref.id` = the asset id, `ref.uri` its
 * `file.uri`). The guard accepts the slice when all of:
 * - the source hash is in `rules.uploads.allow` with `slices: true` (that
 *   entry's `for` then applies);
 * - the slice's bytes are audio or video by content (RIFF/WAVE, ID3 or an
 *   MPEG frame, an MP4/MOV `ftyp` box, FLAC, Ogg, WebM/Matroska), whatever
 *   the file's extension;
 * - the slice has a sha256 `file.hash` (the cutter must record one) and its
 *   bytes match it;
 * - `0 ≤ in_s < out_s`, and the source's length is known and `out_s` is
 *   within it: `audio.master.duration_s` when its `sha256` is the source
 *   hash, else the WAV header of a project file with that hash. An unknown
 *   length is refused;
 * - a WAV slice's own length is within `SLICE_LENGTH_TOLERANCE_S` (0.5 s) of
 *   `out_s − in_s`. Other formats' lengths are not measured (known limit).
 *
 * Nothing in the job (`ref.note` or any other field) can make a file a slice.
 */

import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRef } from '../providers/contract.ts';
import { jobTag } from '../providers/outputs.ts';
import type { AkukoProject, Asset } from '../schema/akuko-project.ts';

export const MANUAL_PROVIDER = 'manual';
const SHA256 = /^[0-9a-f]{64}$/;
const JOB_TAG = jobTag('');

// ─────────────────────────────────────────────────────────────────────────
// Generated or not
// ─────────────────────────────────────────────────────────────────────────

/** The job id that generated `a` (see the header), or undefined when it is external. */
export function generatingJob(p: AkukoProject, a: Asset): string | undefined {
  if (a.kind === 'reference' || a.kind === 'card') return undefined;
  if (!a.provider || a.provider === MANUAL_PROVIDER) return undefined;
  for (const t of a.tags) {
    if (!t.startsWith(JOB_TAG)) continue;
    const job = t.slice(JOB_TAG.length);
    const done = p.ledger.some((e) =>
      e.job === job && e.status === 'done' && e.provider === a.provider && (e.unit === a.id || (a.owner !== undefined && e.unit === a.owner)));
    if (done) return job;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Files and hashes
// ─────────────────────────────────────────────────────────────────────────

export type Located =
  | { kind: 'path'; path: string }
  | { kind: 'data'; data: Buffer }
  | { kind: 'remote'; uri: string };   // http(s), mem://, any other scheme: can't be hashed here

/** Where a uri points, relative uris against the project folder (they may go up out of it). */
export function locate(uri: string, projectDir?: string): Located {
  if (uri.startsWith('data:')) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
    const body = m?.[3] ?? '';
    return { kind: 'data', data: m?.[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body)) };
  }
  if (uri.startsWith('file://')) return { kind: 'path', path: fileURLToPath(uri) };
  // A Windows drive path (C:\…) is a path, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) return { kind: 'remote', uri };
  if (isAbsolute(uri)) return { kind: 'path', path: uri };
  return { kind: 'path', path: resolve(projectDir ?? '.', uri) };
}

/** Hashes already computed, keyed by path + size + mtime, so a 211-shot check hashes each file once. */
export type HashCache = Map<string, string>;
export const newHashCache = (): HashCache => new Map();

export const sha256Bytes = (d: Uint8Array): string => createHash('sha256').update(d).digest('hex');

/** sha256 of a file, streamed (a master WAV can be hundreds of MB). */
export async function sha256File(path: string, cache?: HashCache): Promise<string> {
  const st = statSync(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const h = createHash('sha256');
  await new Promise<void>((ok, fail) => {
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => ok()).on('error', fail);
  });
  const hex = h.digest('hex');
  cache?.set(key, hex);
  return hex;
}

/** The same, synchronously and in 1 MiB chunks (for doctor, which is synchronous). */
export function sha256FileSync(path: string, cache?: HashCache): string {
  const st = statSync(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const h = createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(path, 'r');
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  const hex = h.digest('hex');
  cache?.set(key, hex);
  return hex;
}

export type Hashed =
  | { ok: true; sha256: string; where: string }
  | { ok: false; reason: 'missing' | 'remote' | 'unreadable'; where: string; detail?: string };

export async function hashUri(uri: string, projectDir: string | undefined, cache?: HashCache): Promise<Hashed> {
  const loc = locate(uri, projectDir);
  if (loc.kind === 'data') return { ok: true, sha256: sha256Bytes(loc.data), where: 'an inline data: uri' };
  if (loc.kind === 'remote') return { ok: false, reason: 'remote', where: uri };
  if (!existsSync(loc.path)) return { ok: false, reason: 'missing', where: uri };
  try {
    return { ok: true, sha256: await sha256File(loc.path, cache), where: uri };
  } catch (err) {
    return { ok: false, reason: 'unreadable', where: uri, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The first `n` bytes of a located file (or inline data), and its size. */
function headOf(loc: Located, n = 65536): { head: Uint8Array; size: number } | undefined {
  if (loc.kind === 'data') return { head: loc.data.subarray(0, n), size: loc.data.length };
  if (loc.kind !== 'path' || !existsSync(loc.path)) return undefined;
  try {
    const size = statSync(loc.path).size;
    const buf = Buffer.alloc(Math.min(n, size));
    const fd = openSync(loc.path, 'r');
    try { readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
    return { head: buf, size };
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Slice provenance
// ─────────────────────────────────────────────────────────────────────────

/** The provider id the cutter records on a slice asset (WP-28b). */
export const SLICE_PROVIDER = 'akuko-cut';

export interface SliceOf { sha256: string; in_s: number; out_s: number }

const SLICE_TAG = /^slice-of:sha256:([0-9a-f]{64})@(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;

/** The tag the cutter puts on a slice asset: `slice-of:sha256:<source hex>@<in_s>-<out_s>`. */
export function sliceTag(sha256: string, in_s: number, out_s: number): string {
  if (!SHA256.test(sha256)) throw new Error('sliceTag: sha256 must be 64 lowercase hex characters');
  if (!(Number.isFinite(in_s) && Number.isFinite(out_s) && in_s >= 0 && out_s > in_s)) throw new Error('sliceTag: need 0 <= in_s < out_s');
  return `slice-of:sha256:${sha256}@${in_s}-${out_s}`;
}

export function parseSliceTag(tag: string): SliceOf | undefined {
  const m = SLICE_TAG.exec(tag);
  return m ? { sha256: m[1]!, in_s: Number(m[2]), out_s: Number(m[3]) } : undefined;
}

/** The slice provenance akuko's cutter recorded on an asset, if any. */
export function sliceOf(a: Asset | undefined): SliceOf | undefined {
  if (!a || a.provider !== SLICE_PROVIDER || a.kind === 'card') return undefined;
  for (const t of a.tags) {
    const s = parseSliceTag(t);
    if (s) return s;
  }
  return undefined;
}

const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

/** ISO-BMFF major brands that are audio or video. Image brands (`heic`, `heix`, `mif1`, `msf1`, `avif`) and unknown ones are refused. */
const FTYP_AV = new Set(['isom', 'iso2', 'mp41', 'mp42', 'M4A ', 'M4V ', 'qt  ', 'avc1', 'dash']);

/** How far a WAV slice's own length may differ from `out_s - in_s` (the cutter adds a little lead-in and tail). */
export const SLICE_LENGTH_TOLERANCE_S = 0.5;

/** What a file's first bytes say it is, among the media a slice can be. */
export function mediaKind(head: Uint8Array): 'wav' | 'mp3' | 'mp4' | 'flac' | 'ogg' | 'matroska' | undefined {
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav';
  if (head.length >= 3 && ascii(head, 0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3';
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') return FTYP_AV.has(ascii(head, 8, 4)) ? 'mp4' : undefined;
  if (head.length >= 4 && ascii(head, 0, 4) === 'fLaC') return 'flac';
  if (head.length >= 4 && ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'matroska';
  return undefined;
}

const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** A WAV's length in seconds from its header (first bytes + file size); undefined if it can't tell. Any sample format. */
export function wavSeconds(head: Uint8Array, fileSize: number): number | undefined {
  if (mediaKind(head) !== 'wav') return undefined;
  let byteRate: number | undefined;
  for (let o = 12; o + 8 <= head.length;) {
    const id = ascii(head, o, 4);
    const size = u32(head, o + 4);
    const body = o + 8;
    if (id === 'fmt ' && body + 12 <= head.length) byteRate = u32(head, body + 8);
    else if (id === 'data') {
      if (!byteRate) return undefined;
      const bytes = size === 0 || size === 0xffffffff || body + size > fileSize ? fileSize - body : size;
      return bytes / byteRate;
    }
    o = body + size + (size % 2);
  }
  return undefined;
}

export interface RefContext { projectDir?: string | undefined; cache?: HashCache | undefined }

/** The source's length in seconds, when the project knows it (see the header). */
async function sourceSeconds(p: AkukoProject, sha256: string, ctx: RefContext): Promise<number | undefined> {
  const m = p.audio?.master;
  if (m?.sha256 === sha256) return m.duration_s;
  const uris = [m?.uri, ...(p.audio?.lines ?? []).map((l) => l.clip_uri), ...p.assets.filter((a) => a.kind !== 'card').map((a) => a.file?.uri)];
  for (const uri of new Set(uris.filter((u): u is string => u !== undefined))) {
    const h = await hashUri(uri, ctx.projectDir, ctx.cache);
    if (!h.ok || h.sha256 !== sha256) continue;
    const hd = headOf(locate(uri, ctx.projectDir));
    const secs = hd ? wavSeconds(hd.head, hd.size) : undefined;
    if (secs !== undefined) return secs;
    if (m && uri === m.uri) return m.duration_s;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// One ref
// ─────────────────────────────────────────────────────────────────────────

export type RefOrigin =
  /** `verified`: the asset has a sha256 `file.hash` and the bytes on disk match it. */
  | { kind: 'generated'; asset: Asset; job: string; verified: boolean }
  | { kind: 'generated-changed'; asset: Asset; job: string; uri: string; expected: string; actual: string }
  /** `slice`: the asset is a slice akuko's cutter recorded; `sliceProblem` says why it can't count as one. */
  | { kind: 'external'; uri: string; sha256: string; asset?: Asset; slice?: SliceOf; sliceProblem?: string }
  | { kind: 'unverifiable'; uri: string; reason: 'missing' | 'remote' | 'unreadable'; asset?: Asset; detail?: string }
  | { kind: 'no-file' };                 // nothing to upload, e.g. a provider voice id

/** The asset a ref stands for, when its id (and uri, if it has one) match. */
export function refAsset(p: AkukoProject, ref: Pick<JobRef, 'id' | 'uri'>): Asset | undefined {
  const a = p.assets.find((x) => x.id === ref.id);
  if (!a) return undefined;
  if (ref.uri !== undefined && a.file?.uri !== ref.uri) return undefined;
  return a;
}

/** Why a recorded slice can't count as one (fail closed: anything that can't be checked is refused). */
async function sliceProblem(p: AkukoProject, asset: Asset, slice: SliceOf, uri: string, sha256: string, ctx: RefContext): Promise<string | undefined> {
  const hd = headOf(locate(uri, ctx.projectDir));
  const kind = hd ? mediaKind(hd.head) : undefined;
  if (!hd || kind === undefined) return 'its content is not audio or video';
  const recorded = asset.file?.hash;
  if (recorded === undefined || !SHA256.test(recorded)) return 'the cutter recorded no sha256 for it (file.hash)';
  if (recorded !== sha256) return 'the file has changed since the cutter recorded it';
  if (!(slice.in_s >= 0 && slice.out_s > slice.in_s)) return `its range ${slice.in_s}-${slice.out_s} s is not a span`;
  const secs = await sourceSeconds(p, slice.sha256, ctx);
  if (secs === undefined) return `the length of its source (sha256 ${slice.sha256.slice(0, 12)}…) is unknown: audio.master.sha256 is not that hash and no project file with it is a readable WAV`;
  if (slice.out_s > secs + 1e-6) return `its range ends at ${slice.out_s} s, past the end of its source (${Number(secs.toFixed(3))} s)`;
  if (kind === 'wav') {
    const own = wavSeconds(hd.head, hd.size);
    const want = slice.out_s - slice.in_s;
    if (own === undefined) return 'its WAV header cannot be read, so its length cannot be checked';
    if (Math.abs(own - want) > SLICE_LENGTH_TOLERANCE_S) return `it is ${Number(own.toFixed(3))} s long, but its range ${slice.in_s}-${slice.out_s} s is ${Number(want.toFixed(3))} s`;
  }
  return undefined;
}

export async function classifyRef(p: AkukoProject, ref: Pick<JobRef, 'id' | 'uri'>, ctx: RefContext): Promise<RefOrigin> {
  const asset = refAsset(p, ref);
  const uri = ref.uri ?? asset?.file?.uri;
  if (uri === undefined) return { kind: 'no-file' };

  const job = asset ? generatingJob(p, asset) : undefined;
  if (asset && job !== undefined) {
    const recorded = asset.file?.hash;
    if (recorded !== undefined && SHA256.test(recorded)) {
      const h = await hashUri(uri, ctx.projectDir, ctx.cache);
      if (h.ok && h.sha256 !== recorded) return { kind: 'generated-changed', asset, job, uri, expected: recorded, actual: h.sha256 };
      return { kind: 'generated', asset, job, verified: h.ok };
    }
    return { kind: 'generated', asset, job, verified: false };
  }

  const h = await hashUri(uri, ctx.projectDir, ctx.cache);
  if (!h.ok) return { kind: 'unverifiable', uri, reason: h.reason, ...(asset ? { asset } : {}), ...(h.detail ? { detail: h.detail } : {}) };
  const slice = sliceOf(asset);
  if (!asset || !slice) return { kind: 'external', uri, sha256: h.sha256, ...(asset ? { asset } : {}) };
  const problem = await sliceProblem(p, asset, slice, uri, h.sha256, ctx);
  return { kind: 'external', uri, sha256: h.sha256, asset, slice, ...(problem ? { sliceProblem: problem } : {}) };
}
