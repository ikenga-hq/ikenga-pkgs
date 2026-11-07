/**
 * Pieces shared by the two direct-API image providers (`gemini-image`, `fal`):
 * job checks, reference loading and storing outputs. Holds no model ids and no
 * prices (those live in providers/config.json) and never calls a paid endpoint.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Asset } from '../../schema/akuko-project.ts';
import { findUnit } from '../../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../config.ts';
import { providerConfig } from '../config.ts';
import type { Job, JobItem, JobRef, WaveOneHost } from '../contract.ts';
import { jobProblems } from '../contract.ts';
import { jobTag, planAssetId } from '../outputs.ts';

/** A job the provider cannot run as written. The message says what to change. */
export class ImageJobError extends Error {
  override name = 'ImageJobError';
}

export type FetchLike = typeof globalThis.fetch;

/** Resolve fetch when used, so a replaced `globalThis.fetch` is honoured. */
export const fetchOf = (f: FetchLike | undefined): FetchLike => f ?? ((...a) => globalThis.fetch(...a));

export interface LoadedRef {
  mime: string;
  data: Uint8Array;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};
export const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

/** Reads a reference file's bytes. Hosts with their own storage supply one; the default reads data:, http(s): and local paths. */
export type RefLoader = (uri: string) => Promise<LoadedRef>;

export function defaultRefLoader(f?: FetchLike): RefLoader {
  return async (uri) => {
    if (uri.startsWith('data:')) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
      if (!m) throw new ImageJobError('a reference image has a malformed data: URI');
      const data = m[2] ? Buffer.from(m[3] ?? '', 'base64') : Buffer.from(decodeURIComponent(m[3] ?? ''));
      return { mime: m[1] ?? 'image/png', data: new Uint8Array(data) };
    }
    if (/^https?:\/\//.test(uri)) {
      const res = await fetchOf(f)(uri);
      if (!res.ok) throw new ImageJobError(`could not download reference image ${uri} (HTTP ${res.status})`);
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() || MIME_BY_EXT[uri.split('?')[0]?.split('.').pop()?.toLowerCase() ?? ''] || 'image/png';
      return { mime, data: new Uint8Array(await res.arrayBuffer()) };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !uri.startsWith('file://')) {
      throw new ImageJobError(`reference image ${uri} is not readable from this provider; pass a loadRef option that can read it, or use a file path, data: or https: URI`);
    }
    const path = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
    const data = await readFile(path);
    const mime = MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''];
    if (!mime) throw new ImageJobError(`reference image ${path}: unknown image type`);
    return { mime, data: new Uint8Array(data) };
  };
}

export const toBase64 = (d: Uint8Array): string => Buffer.from(d).toString('base64');

/**
 * Structural checks both providers share, run by `estimate()` and again before
 * any request: job shape, kind, model configured, reference count within the
 * model's documented limit, and every reference reachable by a uri.
 * Over-limit is REFUSED, never silently trimmed (the person picks which
 * references matter).
 */
export function checkImageJob(
  job: Job,
  providerId: string,
  config: AkukoProviderConfig,
  maxRefs: number,
  aspectOk: (ratio: string) => boolean,
  aspectHelp: string,
): void {
  const problems = jobProblems(job);
  if (problems.length) throw new ImageJobError(problems.join('; '));
  if (job.kind !== 'image') throw new ImageJobError(`${providerId} makes images, not ${job.kind}`);
  const entry = providerConfig(config, providerId);
  const model = job.model ?? entry.default_model;
  if (!(model in entry.models)) throw new ImageJobError(`model "${model}" is not configured for ${providerId}`);
  for (const item of job.items) {
    const refs = usableRefs(item);
    if (refs.length > maxRefs) {
      throw new ImageJobError(
        `unit "${item.unit}" has ${refs.length} reference images; ${providerId} (${model}) accepts at most ${maxRefs} per image. Drop ${refs.length - maxRefs} (keep the ones that matter most) and run it again.`,
      );
    }
    if (item.aspect_ratio !== undefined && !aspectOk(item.aspect_ratio)) {
      throw new ImageJobError(`unit "${item.unit}": aspect ratio "${item.aspect_ratio}" is not supported by ${providerId}. ${aspectHelp}`);
    }
  }
}

/** References that have a file to send. A bible entry with no portrait yet has none, and is left out. */
export const usableRefs = (item: JobItem): Array<JobRef & { uri: string }> =>
  (item.refs ?? []).filter((r): r is JobRef & { uri: string } => typeof r.uri === 'string' && r.uri.length > 0);

/** The text that goes with the image: prompt, then camera and things to avoid. */
export function promptText(item: JobItem): string {
  const parts = [item.prompt.trim()];
  if (item.camera) parts.push(`Camera: ${item.camera}.`);
  if (item.negative) parts.push(`Avoid: ${item.negative}.`);
  return parts.join('\n');
}

export const refLabel = (r: JobRef, n: number): string =>
  `Reference image ${n}${r.role ? ` (${r.role})` : ''}${r.note ? `: ${r.note}` : ''}.`;

/**
 * Store one unit's generated images through the host and return them as assets.
 * The first image takes the planned asset id (an empty portrait/plate is filled
 * in place); extras are separate assets owned by the unit and listed first, so
 * the primary image is the one the unit ends up showing.
 */
export async function storeUnitImages(
  host: WaveOneHost,
  job: Pick<Job, 'id' | 'stage'>,
  item: Pick<JobItem, 'unit' | 'output'>,
  providerId: string,
  model: string,
  images: Array<{ mime: string; data: Uint8Array }>,
): Promise<Asset[]> {
  const before = await host.readState();
  const ref = findUnit(before, item.unit);
  const planned = planAssetId(before, item.unit, job.stage);
  const kind = planned.inPlace && ref?.kind === 'asset' ? ref.unit.kind : item.output;
  const out: Asset[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i] as { mime: string; data: Uint8Array };
    const ext = EXT_BY_MIME[img.mime] ?? 'png';
    const primary = i === 0;
    const id = primary ? planned.id : `${planned.id}-v${i + 1}`;
    const stored = await host.storeAsset({
      kind: primary ? kind : item.output,
      filename: `${id}.${ext}`,
      mime: img.mime,
      data: img.data,
      id,
      provider: providerId,
      model,
      tags: [jobTag(job.id), providerId],
      ...(primary && planned.inPlace ? {} : { owner: item.unit }),
    });
    out.push(stored);
  }
  return [...out.slice(1), ...out.slice(0, 1)];
}
