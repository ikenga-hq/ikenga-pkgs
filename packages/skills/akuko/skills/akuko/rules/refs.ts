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
 *
 * ## Slices (for WP-28b)
 *
 * A time-slice cut by akuko from an allowed file (a line cut from the master
 * WAV) is a new file with a new hash. The cutter records where it came from
 * in the ref's `note`, with the token `sliceNote()` builds:
 *
 *     slice-of=sha256:<64 hex of the SOURCE file>@<in_s>-<out_s>
 *
 * (`@<in>-<out>` is optional, seconds on the source). The guard accepts the
 * slice when the source hash is allowed with `slices: true`, and applies that
 * entry's `for`. The token is honoured only on audio or video files, so a
 * picture can't claim it. `providers/contract.ts` is unchanged: `note` is an
 * existing free-text field.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRef } from '../providers/contract.ts';
import { jobTag } from '../providers/outputs.ts';
import type { AkukoProject, Asset } from '../schema/akuko-project.ts';

export const MANUAL_PROVIDER = 'manual';
const SHA256 = /^[0-9a-f]{64}$/;
const JOB_TAG = jobTag('');

// ─────────────────────────────────────────────────────────────────────────
// Slice provenance
// ─────────────────────────────────────────────────────────────────────────

export interface SliceOf { sha256: string; in_s?: number; out_s?: number }

const SLICE_RE = /(?:^|\s)slice-of=sha256:([0-9a-f]{64})(?:@(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?))?(?=\s|$|[;,.])/;

/** The token a slice's `ref.note` carries: `slice-of=sha256:<hex>[@<in>-<out>]`. */
export function sliceNote(sha256: string, in_s?: number, out_s?: number): string {
  if (!SHA256.test(sha256)) throw new Error('sliceNote: sha256 must be 64 lowercase hex characters');
  return `slice-of=sha256:${sha256}${in_s !== undefined && out_s !== undefined ? `@${in_s}-${out_s}` : ''}`;
}

export function parseSliceNote(note: string | undefined): SliceOf | undefined {
  if (!note) return undefined;
  const m = SLICE_RE.exec(note);
  if (!m) return undefined;
  return { sha256: m[1]!, ...(m[2] !== undefined && m[3] !== undefined ? { in_s: Number(m[2]), out_s: Number(m[3]) } : {}) };
}

const TIME_MEDIA = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|mp4|mov|webm|mkv)$/i;
/** Only audio and video files can be time-slices. */
export const canBeSlice = (uri: string): boolean => TIME_MEDIA.test(uri.split(/[?#]/)[0] ?? '');

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

// ─────────────────────────────────────────────────────────────────────────
// One ref
// ─────────────────────────────────────────────────────────────────────────

export type RefOrigin =
  | { kind: 'generated'; asset: Asset; job: string }
  | { kind: 'generated-changed'; asset: Asset; job: string; uri: string; expected: string; actual: string }
  | { kind: 'external'; uri: string; sha256: string; asset?: Asset; slice?: SliceOf }
  | { kind: 'unverifiable'; uri: string; reason: 'missing' | 'remote' | 'unreadable'; asset?: Asset; detail?: string }
  | { kind: 'no-file' };                 // nothing to upload, e.g. a provider voice id

/** The asset a ref stands for, when its id (and uri, if it has one) match. */
export function refAsset(p: AkukoProject, ref: Pick<JobRef, 'id' | 'uri'>): Asset | undefined {
  const a = p.assets.find((x) => x.id === ref.id);
  if (!a) return undefined;
  if (ref.uri !== undefined && a.file?.uri !== ref.uri) return undefined;
  return a;
}

export async function classifyRef(
  p: AkukoProject,
  ref: Pick<JobRef, 'id' | 'uri' | 'note'>,
  ctx: { projectDir?: string | undefined; cache?: HashCache | undefined },
): Promise<RefOrigin> {
  const asset = refAsset(p, ref);
  const uri = ref.uri ?? asset?.file?.uri;
  if (uri === undefined) return { kind: 'no-file' };

  const job = asset ? generatingJob(p, asset) : undefined;
  if (asset && job !== undefined) {
    const recorded = asset.file?.hash;
    if (recorded !== undefined && SHA256.test(recorded)) {
      const h = await hashUri(uri, ctx.projectDir, ctx.cache);
      if (h.ok && h.sha256 !== recorded) return { kind: 'generated-changed', asset, job, uri, expected: recorded, actual: h.sha256 };
    }
    return { kind: 'generated', asset, job };
  }

  const h = await hashUri(uri, ctx.projectDir, ctx.cache);
  if (!h.ok) return { kind: 'unverifiable', uri, reason: h.reason, ...(asset ? { asset } : {}), ...(h.detail ? { detail: h.detail } : {}) };
  const slice = canBeSlice(uri) ? parseSliceNote(ref.note) : undefined;
  return { kind: 'external', uri, sha256: h.sha256, ...(asset ? { asset } : {}), ...(slice ? { slice } : {}) };
}
