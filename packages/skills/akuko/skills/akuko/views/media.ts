/**
 * akuko — the pictures (and intake text) the default board shows on hosts B and C (@0.5).
 *
 * A board opened as a local file, or in the Claude desktop app's browser pane (a `data:` URL), can't load
 * `board/keyframes/sc1_sh1.png` from the project folder. So the publisher embeds a small copy of each picture
 * in the board's project block, as `project._board`:
 *
 *   thumbs  uri → `data:image/…;base64,…`   a thumbnail the page shows wherever it is opened
 *   links   uri → path relative to the page  the full file, for a page that sits next to the project (file:// or http)
 *   texts   uri → text                       intake documents (source, screenplay) to read on the board
 *
 * The content of that block is left out of the conformance hash, so this never changes what was checked.
 *
 * Rules, the same as the sign-off page (`views/signoff.ts`):
 *   - only files under the project folder or its parent (judged after resolving links), with an image
 *     extension (and an image MIME type when the asset records one); never a remote URI, an artifact
 *     `/_blob/` path (the artifact page serves those itself), or a path on another drive;
 *   - a thumbnail is at most `maxThumbBytes` (default 400 KB) and all of them together at most
 *     `maxTotalBytes` of base64 (default 8 MB), so the page stays well under a 16 MB artifact;
 *   - when `ffmpeg` is on PATH a raster picture larger than 96 KB is first shrunk to 640 px wide (JPEG);
 *     without it the file is embedded as it is when it fits, and otherwise only linked (the board then
 *     says "image not available here" where the link can't load);
 *   - an intake text document is embedded up to 256 KB; texts together at most 1 MB.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AkukoProject } from '../schema/akuko-project.ts';

export const DEFAULT_MAX_THUMB_BYTES = 400_000;
export const DEFAULT_MAX_TOTAL_BYTES = 8_000_000;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_TEXT_TOTAL = 1_000_000;
/** Rasters at or under this size are embedded as they are, without shrinking. */
export const SHRINK_ABOVE_BYTES = 96_000;
export const THUMB_WIDTH = 640;

export interface BoardMedia { thumbs: Record<string, string>; links: Record<string, string>; texts: Record<string, string> }
export type MediaHow = 'embedded' | 'shrunk' | 'linked' | 'text' | 'missing' | 'remote' | 'blob' | 'outside' | 'not-an-image' | 'too-large';
export interface MediaItem { unit: string; uri: string; how: MediaHow; bytes?: number; embedded_bytes?: number }
export interface BoardMediaOptions {
  /** `embed` (default): thumbnails plus links; `link`: links only; `none`: nothing. */
  images?: 'embed' | 'link' | 'none';
  maxThumbBytes?: number;
  maxTotalBytes?: number;
  /** Shrink large rasters with ffmpeg when it is on PATH (default true). */
  shrink?: boolean;
  /** The folder the page is written to (links are relative to it). Default `<project>/views`. */
  outDir?: string;
}
export interface BoardMediaResult { media: BoardMedia; items: MediaItem[]; embeddedBytes: number; shrinker: 'ffmpeg' | null }

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif' };
const RASTER = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXT = new Set(['.md', '.txt', '.fountain', '.markdown']);
/** What the board accepts as a link (views/default-board.html#SAFE_REL): plain path segments, `../` allowed in front. */
const SAFE_REL = /^(?:\.\.\/)*(?:[A-Za-z0-9_][A-Za-z0-9 ._()-]*\/)*[A-Za-z0-9_][A-Za-z0-9 ._()-]*$/;

/** Where a project-relative URI is on disk; undefined for a remote one or an artifact blob. */
function onDisk(projectDir: string, uri: string): string | undefined {
  if (/^file:/i.test(uri)) return fileURLToPath(uri);
  if (/^[a-z]:[\\/]/i.test(uri)) return resolve(uri);
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/_blob/')) return undefined;
  return isAbsolute(uri) ? uri : resolve(projectDir, ...uri.split('/'));
}

let ffmpegSeen: boolean | undefined;
function hasFfmpeg(): boolean {
  if (ffmpegSeen === undefined) {
    try { ffmpegSeen = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000, windowsHide: true }).status === 0; } catch { ffmpegSeen = false; }
  }
  return ffmpegSeen;
}
/** A JPEG at most THUMB_WIDTH wide, or undefined when ffmpeg can't make one. */
function shrink(path: string): Buffer | undefined {
  try {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale='min(${THUMB_WIDTH},iw)':-2`, '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
      { maxBuffer: 32 * 1024 * 1024, timeout: 30_000, windowsHide: true });
    return r.status === 0 && r.stdout && r.stdout.length > 0 ? r.stdout : undefined;
  } catch { return undefined; }
}

const isTextDoc = (mime: string | undefined, uri: string) => (mime ? /^text\//.test(mime) : TEXT_EXT.has(extname(uri).toLowerCase()));

/** Collect the board's pictures and intake texts for `project`, read from `projectDir`. */
export function buildBoardMedia(project: AkukoProject, projectDir: string, opts: BoardMediaOptions = {}): BoardMediaResult {
  const o = { images: opts.images ?? 'embed', maxThumbBytes: opts.maxThumbBytes ?? DEFAULT_MAX_THUMB_BYTES, maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, shrink: opts.shrink ?? true };
  const outDir = opts.outDir ?? resolve(projectDir, 'views');
  const media: BoardMedia = { thumbs: {}, links: {}, texts: {} };
  const items: MediaItem[] = [];
  const roots = [projectDir, dirname(resolve(projectDir))].map((r) => { try { return realpathSync(r); } catch { return resolve(r); } });
  const inside = (real: string) => roots.some((r) => { const rel = relative(r, real); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); });
  let used = 0, textUsed = 0;
  const shrinker = o.shrink && o.images === 'embed' && hasFfmpeg() ? 'ffmpeg' as const : null;
  const seen = new Set<string>();

  for (const a of project.assets) {
    const uri = a.file?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const mime = a.file?.mime;
    const text = a.stage === 'intake' && isTextDoc(mime, uri);
    if (uri.startsWith('/_blob/')) { items.push({ unit: a.id, uri, how: 'blob' }); continue; }
    const path = onDisk(projectDir, uri);
    if (!path) { items.push({ unit: a.id, uri, how: 'remote' }); continue; }
    if (!existsSync(path)) { items.push({ unit: a.id, uri, how: 'missing' }); continue; }
    const real = realpathSync(path);
    if (!inside(real)) { items.push({ unit: a.id, uri, how: 'outside' }); continue; }
    const bytes = statSync(real).size;
    if (text) {
      if (bytes > MAX_TEXT_BYTES || textUsed + bytes > MAX_TEXT_TOTAL) { items.push({ unit: a.id, uri, how: 'too-large', bytes }); continue; }
      media.texts[uri] = readFileSync(real, 'utf8');
      textUsed += bytes;
      items.push({ unit: a.id, uri, how: 'text', bytes });
      continue;
    }
    const ext = extname(real).toLowerCase();
    const type = IMAGE_MIME[ext] !== undefined && (mime === undefined || mime.startsWith('image/')) ? IMAGE_MIME[ext] : undefined;
    if (!type) { items.push({ unit: a.id, uri, how: 'not-an-image', bytes }); continue; }
    if (o.images === 'none') continue;
    const rel = relative(outDir, path).split(sep).join('/');
    const link = !isAbsolute(rel) && !/^[a-z]:/i.test(rel) && SAFE_REL.test(rel) ? rel : undefined;
    if (link) media.links[uri] = link;
    let how: MediaHow = link ? 'linked' : 'outside';
    let embedded = 0;
    if (o.images === 'embed') {
      let data: Buffer | undefined, t = type, shrunk = false;
      if (shrinker && RASTER.has(ext) && bytes > SHRINK_ABOVE_BYTES) { data = shrink(real); if (data) { t = 'image/jpeg'; shrunk = true; } }
      if (!data && bytes <= o.maxThumbBytes) data = readFileSync(real);
      if (data && data.length <= o.maxThumbBytes) {
        const uriData = `data:${t};base64,${data.toString('base64')}`;
        if (used + uriData.length <= o.maxTotalBytes) {
          media.thumbs[uri] = uriData;
          used += uriData.length;
          embedded = uriData.length;
          how = shrunk ? 'shrunk' : 'embedded';
        }
      }
      if (!embedded && !link) how = 'too-large';
    }
    items.push({ unit: a.id, uri, how, bytes, ...(embedded ? { embedded_bytes: embedded } : {}) });
  }
  return { media, items, embeddedBytes: used, shrinker };
}

/** One line for the person: how the pictures went into the board. */
export function mediaSummary(r: BoardMediaResult): string {
  const n = (h: MediaHow) => r.items.filter((i) => i.how === h).length;
  const parts = [
    n('embedded') + n('shrunk') ? `${n('embedded') + n('shrunk')} ${n('embedded') + n('shrunk') === 1 ? 'picture' : 'pictures'} embedded${n('shrunk') ? ` (${n('shrunk')} shrunk with ffmpeg)` : ''}` : '',
    n('linked') ? `${n('linked')} linked only (too large to embed: they show when the page is opened next to the project)` : '',
    n('text') ? `${n('text')} intake ${n('text') === 1 ? 'document' : 'documents'} embedded` : '',
    n('missing') ? `${n('missing')} missing` : '',
    n('outside') + n('too-large') ? `${n('outside') + n('too-large')} not shown (outside the project or too large)` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join('; ')}; ${(r.embeddedBytes / 1e6).toFixed(1)} MB embedded` : 'no pictures to embed';
}
