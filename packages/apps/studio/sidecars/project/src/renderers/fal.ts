/**
 * fal.ai renderer adapter (Stage 1 — network AI video/still engine).
 *
 * First NETWORK `RendererAdapter` for com.ikenga.studio. Unlike the
 * deterministic local engines (hyperframes, excalidraw), this adapter has no
 * on-disk cell content: it drives a fal.ai model from the cell's `prompt`
 * (+ optional anchor image reference) via `@fal-ai/client`, streams queue
 * updates as `render.progress`, then downloads the produced MP4 to the
 * renders directory.
 *
 * ─── Key resolution ───────────────────────────────────────────────────────
 * The fal credential comes from `ctx.vault.get('studio.fal')` (the Stronghold
 * vault surface, wired in-shell) with a `process.env.FAL_KEY` fallback for
 * headless / CI / stdio-driven runs. No key is ever hardcoded.
 *
 * ─── Model ids are CONFIG ──────────────────────────────────────────────────
 * fal model ids drift. They are read from env with cheap documented defaults
 * (see FAL_VIDEO_MODEL_DEFAULT / FAL_IMAGE_MODEL_DEFAULT) and can be
 * per-cell-overridden via `cell.metadata.fal_model` or per-call via
 * `RenderOptions.variant`. VERIFY the defaults against https://fal.ai/models.
 *
 * ─── G14 — output path ─────────────────────────────────────────────────────
 * Lands at `<rendersDir>/fal/<rungDir(cell.rung)>/<uid>.mp4` via the
 * `rungDir()` schema helper (same convention as hyperframes/excalidraw).
 *
 * ─── Cancellation ──────────────────────────────────────────────────────────
 * The simple `fal.subscribe` API exposes no request handle, so cancel is
 * best-effort: we race the subscribe promise against `ctx.signal`; on abort we
 * stop waiting and surface a `cancelled`-tagged error (the queue tags the
 * record 'cancelled' rather than 'failed'). The in-flight fal job may still
 * complete server-side — we simply do not download its output.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { fal } from '@fal-ai/client';

import {
  rungDir,
  type AspectRatio,
  type Cell,
  type RenderRecord,
} from '@ikenga/studio-schema';

import { readProject } from '../storyboard-fs.js';
import type {
  Diagnostic,
  PreviewURL,
  RenderContext,
  RenderOptions,
  RendererAdapter,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

// Cheap text/image-to-video default. VERIFY against https://fal.ai/models —
// model ids drift; override via FAL_VIDEO_MODEL or cell.metadata.fal_model.
const FAL_VIDEO_MODEL_DEFAULT = 'fal-ai/ltx-video';

// Cheap stills default. VERIFY against https://fal.ai/models — override via
// FAL_IMAGE_MODEL.
const FAL_IMAGE_MODEL_DEFAULT = 'fal-ai/flux/schnell';

// Anchor kinds that carry a usable image reference for image-to-video /
// character-location continuity.
const IMAGE_ANCHOR_KINDS = new Set(['image', 'character', 'location']);

// Generous — these are video files, not API calls — but bounded so a stalled
// CDN can't hang the single-worker render queue with no render.cancel escape.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/** Read the fal key from the vault, falling back to FAL_KEY env. */
async function resolveKey(ctx: RenderContext): Promise<string | undefined> {
  let fromVault: string | undefined;
  try {
    // Vault key follows the studio.<adapter> convention (veo/kling/runway).
    fromVault = await ctx.vault.get('studio.fal');
  } catch {
    fromVault = undefined;
  }
  return fromVault ?? process.env.FAL_KEY;
}

/** Resolve a unique output path under `rendersDir/fal/<rungDir>/`. */
function resolveOutputPath(cell: Cell, ctx: RenderContext, kind: FalOutputKind = 'video'): string {
  const dir = join(ctx.rendersDir, 'fal', rungDir(cell.rung));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // The extension is decided BEFORE the call, from the resolved kind — not
  // sniffed from the response afterwards. By the time a response arrives the
  // job has billed, so an output path that only becomes correct in hindsight
  // is not a recovery, it is a receipt.
  const ext = kind === 'still' ? 'png' : 'mp4';
  const base = join(dir, `${cell.uid}.${ext}`);
  if (!existsSync(base)) return base;
  const suffix = randomUUID().slice(0, 8);
  return join(dir, `${cell.uid}.${suffix}.${ext}`);
}

/**
 * What a cell's fal render PRODUCES — a moving clip, or a single frame.
 *
 * Mode C needs both from this one adapter. A shot is three fal calls: two FLUX
 * inpaints that paint the character into the start and end plates, then one
 * Kling O1 that interpolates between the two frames those produced. Before
 * this existed the adapter could only do the third — it resolved a video model,
 * called `extractVideoUrl` on the response and wrote `<cell>.mp4` — so a cell
 * pointed at `fal-ai/flux-lora/inpainting` would call the endpoint, BILL, get
 * back `images[0].url`, and then fail extracting a video url from it.
 *
 * Resolution order is explicit-first because guessing from a model id is how
 * you get a wrong answer that costs money:
 *   1. `cell.metadata.fal_output` — 'still' | 'video', always wins
 *   2. inferred from the resolved model id (the patterns below)
 *   3. 'video' — the prior behaviour, so existing cells are unaffected
 */
export type FalOutputKind = 'still' | 'video';

/** Endpoint families that return an image rather than a clip. */
const STILL_MODEL_PATTERNS = [
  /\/inpainting(\/|$)/,
  /\/fill(\/|$)/,
  /\/edit(\/|$)/,
  /^fal-ai\/flux(-|\/)/,
  /seedream/,
];

function inferKind(model: string): FalOutputKind {
  // A model that names an explicit video endpoint is video regardless of family
  // — `fal-ai/flux-...-to-video` must not be caught by the flux pattern.
  if (/(^|\/)(image|video|text)-to-video(\/|$)/.test(model)) return 'video';
  return STILL_MODEL_PATTERNS.some((re) => re.test(model)) ? 'still' : 'video';
}

/**
 * Resolve BOTH the model id and what it produces, in one place.
 *
 * Single entry point on purpose: the spend gate prices a render before
 * dispatch (spend.ts, via RenderRunner.enqueue) and the adapter dispatches it.
 * If those two resolved the model differently, the ledger would bill one
 * endpoint and the invoice would show another — so both call this.
 */
export function resolveFalModel(
  cell: Cell,
  opts: RenderOptions,
  flags?: { hasImage?: boolean },
): { model: string; kind: FalOutputKind } {
  const meta = cell.metadata as Record<string, unknown> | undefined;
  const declared = meta?.fal_output;
  const explicit: FalOutputKind | undefined =
    declared === 'still' || declared === 'video' ? declared : undefined;

  // A still never wants the image-to-video auto-switch, and its default model
  // is the image default rather than the video one.
  if (explicit === 'still') {
    const override = opts.variant || (typeof meta?.fal_model === 'string' ? meta.fal_model : '')
      || process.env.FAL_IMAGE_MODEL || '';
    const raw = override || FAL_IMAGE_MODEL_DEFAULT;
    return { model: raw.includes('/') ? raw : `fal-ai/${raw}`, kind: 'still' };
  }

  const model = resolveVideoModel(cell, opts, flags);
  return { model, kind: explicit ?? inferKind(model) };
}

/**
 * Resolve the video model id (call override → cell metadata → env → default).
 *
 * Exported so the spend gate (spend.ts, via RenderRunner.enqueue) can price a
 * render BEFORE dispatching it. The gate calls this without `flags` — it only
 * needs the pricing tier, and the i2v/t2v suffix does not change the rate —
 * so the two call sites can never disagree about which model is being billed.
 */
export function resolveVideoModel(
  cell: Cell,
  opts: RenderOptions,
  flags?: { hasImage?: boolean },
): string {
  const fromMeta = (cell.metadata as Record<string, unknown> | undefined)?.fal_model;
  const override =
    opts.variant ||
    (typeof fromMeta === 'string' ? fromMeta : '') ||
    process.env.FAL_VIDEO_MODEL ||
    '';
  // The Canvas picker uses friendly short names (ltx-video, flux, …); fal's
  // API requires the full <owner>/<app> id. Pass through anything already
  // owner-qualified, otherwise prefix the default owner so e.g. "ltx-video"
  // resolves to "fal-ai/ltx-video".
  const raw = override || FAL_VIDEO_MODEL_DEFAULT;
  const qualified = raw.includes('/') ? raw : `fal-ai/${raw}`;
  // Image-to-video: a text-to-video endpoint ignores `image_url` (silent drift
  // — the plate stops anchoring the output) or 422s. Auto-switch to the i2v
  // sibling (`fal-ai/ltx-video/image-to-video`) ONLY when no override was
  // supplied (we fell through to the default) AND an anchor image is present.
  // An explicit override is honored verbatim — even if its value happens to
  // equal the default id — so a caller can force t2v with an image by pinning
  // the model; if you want i2v with a custom base, pass the i2v endpoint id.
  const fromDefault = override.length === 0;
  if (flags?.hasImage && fromDefault) {
    return `${FAL_VIDEO_MODEL_DEFAULT}/image-to-video`;
  }
  return qualified;
}

/** Extract a negative prompt from the cell's open metadata bag, if present. */
function readNegativePrompt(cell: Cell): string | undefined {
  const meta = cell.metadata as Record<string, unknown> | undefined;
  const neg = meta?.negative ?? meta?.negative_prompt;
  return typeof neg === 'string' && neg.trim().length > 0 ? neg : undefined;
}

/** Video output url from a fal result payload (model-shape tolerant). */
function extractVideoUrl(data: unknown): string | undefined {
  const d = data as
    | { video?: { url?: string }; videos?: Array<{ url?: string }> }
    | undefined;
  return d?.video?.url ?? d?.videos?.[0]?.url;
}

/** Still-image output url from a fal result payload (model-shape tolerant). */
function extractImageUrl(data: unknown): string | undefined {
  const d = data as
    | { images?: Array<{ url?: string }>; image?: { url?: string } }
    | undefined;
  return d?.images?.[0]?.url ?? d?.image?.url;
}

/** Best-effort spend extraction — fal rarely returns a cost field. */
function extractCost(res: unknown): number | undefined {
  const r = res as
    | { data?: { cost?: unknown }; metrics?: { cost?: unknown } }
    | undefined;
  const c = r?.data?.cost ?? r?.metrics?.cost;
  return typeof c === 'number' ? c : undefined;
}

/**
 * Download a remote url to `outPath`, streaming straight to disk (no
 * whole-file buffering). Aborts via the render's own `ctx.signal` (so
 * `render.cancel` actually stops a stalled download) OR a generous fixed
 * timeout — whichever fires first. Throws on a non-OK response, on abort, or
 * on timeout.
 */
async function downloadTo(url: string, outPath: string, signal?: AbortSignal): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(url, { signal: fetchSignal });
  if (!res.ok) {
    throw new Error(`[fal] download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  if (!res.body) {
    throw new Error(`[fal] download response had no body for ${url}`);
  }
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Readable.fromWeb bridges the fetch body's web ReadableStream to a node
  // stream so pipeline() gets proper backpressure + write-error propagation
  // (a sync writeFileSync(buf) can't back-pressure a slow disk either).
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(outPath));
}

/** Result of resolving a cell's image reference: a fetchable url, or why not. */
interface ImageRef {
  url: string | undefined;
  /** Set when an anchor was present but its file could not be uploaded — the
   * render falls back to text-only, and the caller surfaces this cause. */
  uploadError?: string;
}

/**
 * Resolve the cell's first image/character/location anchor to a fetchable
 * url. `http(s)` uris pass through; local files are uploaded to fal storage
 * (fal.config must already be applied) so the model can fetch them. Returns
 * `{ url: undefined }` when no usable anchor exists — a text-only render is
 * valid. An upload failure is returned as `{ uploadError }` (NOT swallowed)
 * so the render record + progress log explain the text-only fallback.
 */
async function resolveImageRefUrl(cell: Cell, ctx: RenderContext): Promise<ImageRef> {
  if (!cell.anchors || cell.anchors.length === 0) return { url: undefined };

  let anchors: Array<{ id: string; kind: string; asset?: { uri?: string; mime?: string } }>;
  try {
    anchors = readProject(ctx.projectRoot).anchors as typeof anchors;
  } catch {
    return { url: undefined };
  }
  const byId = new Map(anchors.map((a) => [a.id, a]));

  // If a usable anchor is found but its file can't be resolved/uploaded, we
  // keep trying the remaining anchors; this holds the last reason so a
  // fully-text-only outcome still explains WHY (rather than looking like the
  // cell never had an anchor).
  let fallbackError: string | undefined;

  for (const id of cell.anchors) {
    const a = byId.get(id);
    if (!a || !IMAGE_ANCHOR_KINDS.has(a.kind)) continue;
    const uri = a.asset?.uri;
    if (!uri) continue;
    if (/^https?:\/\//i.test(uri)) return { url: uri };

    // Local file — resolve to an absolute path and upload for a fetchable url.
    // An anchor's AssetRef.uri is the assets-relative id (e.g. 'images/x.png'),
    // which lives under `<projectRoot>/assets/` per the assets.ts convention
    // (resolveAsset prepends `assets/`). Try that first; fall back to a
    // project-root-relative path for absolute-style refs.
    let abs: string;
    if (uri.startsWith('file://')) abs = fileURLToPath(uri);
    else if (isAbsolute(uri)) abs = uri;
    else {
      const underAssets = resolve(ctx.projectRoot, 'assets', uri);
      abs = existsSync(underAssets) ? underAssets : resolve(ctx.projectRoot, uri);
    }
    if (!existsSync(abs)) {
      // Missing on disk — same silent-drift class as an upload failure. Record
      // the reason and try the remaining anchors before falling back.
      fallbackError = `anchor ${a.id} (${a.kind}) reference file not found on disk (${uri})`;
      continue;
    }
    try {
      const bytes = readFileSync(abs);
      const blob = new Blob([bytes], { type: a.asset?.mime ?? 'application/octet-stream' });
      return { url: await fal.storage.upload(blob) };
    } catch (e) {
      // Upload failed — do NOT swallow: surface the cause so the caller can log
      // why this image-to-video render fell back to text-only (a silent
      // downgrade on a money-spending op hides a broken reference plate).
      return {
        url: undefined,
        uploadError: `anchor ${a.id} (${a.kind}) upload failed: ${(e as Error).message}`,
      };
    }
  }
  return { url: undefined, uploadError: fallbackError };
}

/**
 * Upload one project-local file and return a fetchable url. `http(s)` passes
 * through untouched. Shares the path-resolution convention with
 * `resolveImageRefUrl`: an assets-relative id first, then project-root
 * relative, then absolute / `file://`.
 */
async function uploadLocalRef(uri: string, ctx: RenderContext): Promise<string> {
  if (/^https?:\/\//i.test(uri)) return uri;

  let abs: string;
  if (uri.startsWith('file://')) abs = fileURLToPath(uri);
  else if (isAbsolute(uri)) abs = uri;
  else {
    const underAssets = resolve(ctx.projectRoot, 'assets', uri);
    abs = existsSync(underAssets) ? underAssets : resolve(ctx.projectRoot, uri);
  }
  if (!existsSync(abs)) {
    throw new Error(`fal_upload reference not found on disk: ${uri}`);
  }
  const ext = abs.toLowerCase().split('.').pop() ?? '';
  const mime =
    ext === 'png' ? 'image/png'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'mp4' ? 'video/mp4'
    : 'application/octet-stream';
  return fal.storage.upload(new Blob([readFileSync(abs)], { type: mime }));
}

/**
 * Resolve `metadata.fal_upload` — a map of *input field name* → *project-local
 * path* — into a map of field name → fetchable url.
 *
 * **Why this exists.** `metadata.fal_input` already lets a cell pass verbatim
 * fields to any fal endpoint, which is what keeps this adapter model-agnostic
 * as endpoint shapes drift. But verbatim only works for values that are
 * already URLs, and the whole Blender-authored workflow produces LOCAL files:
 * a rendered plate, a mask derived from a stand-in, a keyframe. `fal_upload`
 * closes that gap without the adapter having to know what any particular
 * endpoint's fields mean.
 *
 * That generality is deliberate — it makes every shape we proved reachable
 * from a cell with no further adapter work:
 *
 *   inpaint          { image_url: <plate>, mask_url: <mask> }
 *   first+last frame { start_image_url: <first>, end_image_url: <last> }
 *   video inpaint    { video_url: <slate>, mask_video_url: <mask slate> }
 *
 * Uploads run in parallel; a single failure fails the render rather than
 * silently downgrading, because these fields are load-bearing (a mask that
 * quietly goes missing produces a plausible-looking wrong shot, and this lane
 * spends real money per attempt).
 */
async function resolveUploadMap(
  cell: Cell,
  ctx: RenderContext,
): Promise<Record<string, string>> {
  const spec = (cell.metadata as Record<string, unknown> | undefined)?.fal_upload;
  if (!spec || typeof spec !== 'object') return {};

  const entries = Object.entries(spec as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0,
  );
  const urls = await Promise.all(entries.map(([, uri]) => uploadLocalRef(uri, ctx)));
  return Object.fromEntries(entries.map(([field], i) => [field, urls[i]!]));
}

/**
 * Read `metadata.fal_loras` — the identity mechanism.
 *
 * A character LoRA is the only thing that reliably holds one person across
 * shots; a fixed seed does not (it controls noise, not subject, so a changed
 * conditioning image re-invents the character). LoRAs are family-bound: a FLUX
 * LoRA applies to FLUX endpoints only, and most video endpoints accept none —
 * which is why the working pipeline puts the LoRA in the *keyframes* and lets
 * a video model interpolate between them.
 */
export function readLoras(cell: Cell): Array<Record<string, unknown>> | undefined {
  const raw = (cell.metadata as Record<string, unknown> | undefined)?.fal_loras;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object');
}

/**
 * Build the fal model input. Field names are model-dependent and drift; these
 * are the common fal video-model fields. Unknown fields a given model doesn't
 * accept are ignored server-side / surfaced as a validation error the caller
 * sees as a failed render.
 */
export function buildVideoInput(args: {
  cell: Cell;
  imageUrl?: string;
  aspect?: AspectRatio;
  /** Field → url from `metadata.fal_upload`, already uploaded. */
  uploads?: Record<string, string>;
  /** 'still' suppresses the anchor image_url — see below. */
  kind?: FalOutputKind;
}): Record<string, unknown> {
  const { cell, imageUrl, aspect, uploads, kind = 'video' } = args;
  const input: Record<string, unknown> = { prompt: cell.prompt };
  const negative = readNegativePrompt(cell);
  if (negative) input.negative_prompt = negative;
  // The anchor's image_url conditions a video render. On an INPAINT it would
  // collide with `fal_upload`'s own image_url (the plate) — and uploads land
  // last, so the plate would win silently while the anchor did nothing. Leaving
  // it off makes the plate the only thing that can occupy that field.
  if (imageUrl && kind !== 'still') input.image_url = imageUrl;
  if (typeof cell.seed === 'number') input.seed = cell.seed;
  // aspect_ratio is honored by text-to-video models but REJECTED by the
  // image-to-video sibling (which derives framing from the image), so only set
  // it for text-to-video renders. A cell can still force the field verbatim via
  // metadata.fal_input if a specific i2v model needs it.
  // Stills derive their framing from the plate they are painting into, so an
  // aspect_ratio here is at best ignored and at worst a 422.
  if (!imageUrl && aspect && kind !== 'still') input.aspect_ratio = aspect;
  // Model-specific extras (aspect_ratio / duration / num_frames / start_image_url …)
  // differ per fal model and a *hard 422* on an unaccepted field is common — e.g.
  // `fal-ai/ltx-video/image-to-video` rejects both aspect_ratio and duration (it
  // derives framing from the image). So the default input stays lean
  // (prompt + image_url + negative + seed); a cell opts a specific model's extra
  // fields in verbatim via `metadata.fal_input`.
  const extra = (cell.metadata as Record<string, unknown> | undefined)?.fal_input;
  if (extra && typeof extra === 'object') {
    Object.assign(input, extra as Record<string, unknown>);
  }

  // Identity, then uploaded refs. Uploads land LAST so a resolved local file
  // always wins over a same-named literal in `fal_input` — otherwise a stale
  // hand-written url would silently shadow the plate the pipeline just
  // rendered, which is the worst kind of wrong: it renders, it costs money,
  // and it looks plausible.
  const loras = readLoras(cell);
  if (loras) input.loras = loras;
  if (uploads) Object.assign(input, uploads);

  return input;
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export const falAdapter: RendererAdapter = {
  id: 'fal',

  capabilities: {
    still: true,
    video: true,
    interactive: false,
    range: false,
    combine: false,
    aspect_ratios: ['16:9', '9:16', '1:1'],
    max_duration_ms: null,
    supported_codecs: ['h264'],
    requires_network: true,
  },

  async validate(cell, ctx) {
    const diags: Diagnostic[] = [];

    if (!cell.prompt || cell.prompt.trim().length === 0) {
      diags.push({
        severity: 'error',
        code: 'prompt-empty',
        message: 'fal requires a non-empty prompt',
        path: 'prompt',
      });
    }

    const key = await resolveKey(ctx);
    if (!key) {
      diags.push({
        severity: 'warning',
        code: 'fal-key-missing',
        message:
          'No fal key available (vault `studio.fal` / FAL_KEY unset) — render will fail until a key is provided',
      });
    }

    return diags;
  },

  async preview(cell, _ctx) {
    // Cheap, no real generation (G — previews must not spend). A neutral
    // poster placeholder; the real frame only exists after render().
    void cell;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
      '<rect width="100%" height="100%" fill="#1b1714"/>' +
      '<text x="50%" y="50%" fill="#c9bfb4" font-family="sans-serif" font-size="16" ' +
      'text-anchor="middle" dominant-baseline="middle">AI video (fal)</text></svg>';
    const url: PreviewURL = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    return url;
  },

  async render(cell, opts, ctx) {
    const recordId = randomUUID();
    const startedAt = nowIso();
    const startedAtMs = Date.now();

    const key = await resolveKey(ctx);
    if (!key) {
      throw new Error(
        '[fal] studio.fal not set — provide it via the vault (`studio.fal`) or the FAL_KEY env var',
      );
    }
    // NOTE: fal.config mutates global SDK state. Safe today because the render
    // queue drains serially (one render at a time), but under future concurrency
    // this would need per-call credentials (e.g. a scoped client) to avoid
    // clobbering an in-flight job's key.
    fal.config({ credentials: key });

    const aspect: AspectRatio = opts.aspect_ratio ?? ctx.aspectRatio;
    const imageRef = await resolveImageRefUrl(cell, ctx);
    const imageUrl = imageRef.url;
    if (imageRef.uploadError) {
      // Don't abort — a text-only render is valid — but make the fallback loud
      // so progress + the record explain why an anchor-driven render didn't use
      // the reference plate. recordId is in scope (declared at the top of render).
      ctx.emit({
        type: 'render.progress',
        payload: {
          recordId,
          cellId: cell.uid,
          engine: 'fal',
          progress: null,
          message: `[fal] ${imageRef.uploadError}; falling back to text-only`,
        },
      });
    }
    // Blender-authored refs (plate / mask / first + last keyframe / slate).
    // Unlike the anchor image above, a failure here is FATAL: these fields are
    // load-bearing, and a render that quietly proceeds without its mask or its
    // end keyframe produces a plausible-looking wrong shot at full cost.
    const uploads = await resolveUploadMap(cell, ctx);

    // Resolve the model AFTER the image ref so image-to-video can switch to the
    // i2v sibling endpoint (see resolveVideoModel).
    const { model, kind } = resolveFalModel(cell, opts, { hasImage: !!imageUrl });
    const input = buildVideoInput({ cell, imageUrl, aspect, uploads, kind });

    const outPath = resolveOutputPath(cell, ctx, kind);

    // Never submit a fal job after the signal already aborted. The simple
    // subscribe API submits (and bills) server-side on call, and ctx.signal is
    // not threaded into the SDK's HTTP request, so without this guard a cancel
    // that lands during the awaits above would still spend money. Checked
    // BEFORE the abort-listener setup below so we never create an abort promise
    // that would later reject with no consumer (an unhandledRejection).
    if (ctx.signal.aborted) {
      throw Object.assign(new Error('[fal] render aborted before submit'), {
        cancelled: true,
      });
    }

    let lastMessage = '';
    const emitProgress = (message: string): void => {
      // De-dupe on message content to avoid a flood of identical lines.
      if (message === lastMessage) return;
      lastMessage = message;
      ctx.emit({
        type: 'render.progress',
        payload: {
          recordId,
          cellId: cell.uid,
          engine: 'fal',
          progress: null,
          message,
        },
      });
    };

    // Cancellation: race the subscribe against ctx.signal (best-effort — the
    // simple subscribe API exposes no server-side cancel handle). The guard
    // above already handled the pre-abort case, so the signal is not yet
    // aborted here — just attach the listener (no microtask dance needed).
    let abortReject: ((e: Error) => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    const onAbort = () => {
      abortReject?.(Object.assign(new Error('[fal] render aborted via ctx.signal'), {
        cancelled: true,
      }));
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    let res: Awaited<ReturnType<typeof fal.subscribe>>;
    try {
      const subscribePromise = fal.subscribe(model, {
        input,
        logs: true,
        onQueueUpdate: (update) => {
          const u = update as {
            status?: string;
            logs?: Array<{ message?: string }>;
          };
          if (u.status === 'IN_PROGRESS' || u.status === 'IN_QUEUE') {
            const last = u.logs?.filter((l) => !!l?.message).pop();
            emitProgress(last?.message ?? u.status);
          }
        },
      });
      res = await Promise.race([subscribePromise, abortPromise]);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }

    if (ctx.signal.aborted) {
      throw Object.assign(new Error('[fal] render aborted via ctx.signal'), {
        cancelled: true,
      });
    }

    // A still model returns `images[0].url`; a video model returns `video.url`.
    // Pulling the wrong one out is not a soft failure — the job has already
    // billed by this point — so the error names which kind was expected.
    const mediaUrl = kind === 'still' ? extractImageUrl(res.data) : extractVideoUrl(res.data);
    if (!mediaUrl) {
      throw new Error(
        `[fal] model ${model} returned no ${kind === 'still' ? 'image' : 'video'} url ` +
          `(resolved kind: ${kind}; data keys: ${Object.keys(
            (res.data as Record<string, unknown>) ?? {},
          ).join(', ') || 'none'}). ` +
          `If this model produces the other kind, set cell.metadata.fal_output.`,
      );
    }

    await downloadTo(mediaUrl, outPath, ctx.signal);
    if (!existsSync(outPath) || statSync(outPath).size === 0) {
      throw new Error(`[fal] downloaded output missing or empty at ${outPath}`);
    }

    const finishedAt = nowIso();
    const finishedAtMs = Date.now();
    const cost = extractCost(res);
    const requestId = (res as { requestId?: string }).requestId;

    const record: RenderRecord = {
      id: recordId,
      cell_uid: cell.uid,
      engine: 'fal',
      model_id: model,
      engine_version: undefined,
      variant: opts.variant ?? 'default',
      status: 'done',
      output: { uri: outPath, mime: kind === 'still' ? 'image/png' : 'video/mp4' },
      // Pass the real cost through unchanged (undefined when fal returns none —
      // the common case for video models). Forcing a 0 here made the Ledger
      // display every fal render as free despite real credit spend.
      cost_estimate: cost,
      cost_actual: cost,
      started_at: startedAt,
      finished_at: finishedAt,
      metadata: {
        model,
        aspect_ratio: aspect,
        seed: cell.seed,
        image_ref: imageUrl,
        request_id: requestId,
        elapsed_ms: finishedAtMs - startedAtMs,
        ...(imageRef.uploadError ? { image_ref_error: imageRef.uploadError } : {}),
        // Which Blender-authored refs and which identity LoRA produced this
        // shot. Recorded by FIELD NAME (source paths, not the throwaway upload
        // urls) so a render is reconstructable months later — a fal storage url
        // expires, `renders/blender/hifi/shot-01_first.png` does not.
        ...(Object.keys(uploads).length
          ? { fal_uploads: (cell.metadata as Record<string, unknown>)?.fal_upload }
          : {}),
        ...(readLoras(cell) ? { loras: readLoras(cell) } : {}),
      },
    };
    return record;
  },
};

/**
 * Standalone still generator — runs FAL_IMAGE_MODEL and downloads the image
 * to `outPath`. Imported by Stage 3 (anchor plates) to mint reference stills.
 * Independent of the RendererAdapter surface so it can be called without a
 * full RenderContext.
 */
export async function generateStill(
  opts: {
    prompt: string;
    model?: string;
    seed?: number;
    aspect?: AspectRatio;
    keyGetter: () => Promise<string | undefined>;
  },
  outPath: string,
): Promise<{ uri: string; model_id: string; cost?: number }> {
  const key = (await opts.keyGetter()) ?? process.env.FAL_KEY;
  if (!key) {
    throw new Error(
      '[fal] studio.fal not set — provide it via keyGetter (vault `studio.fal`) or the FAL_KEY env var',
    );
  }
  // NOTE: fal.config mutates global SDK state. Safe today because generateStill
  // is called from the serial anchor-generation path (one at a time); under
  // concurrency this would need a scoped client to avoid key clobbering.
  fal.config({ credentials: key });

  const model = opts.model || process.env.FAL_IMAGE_MODEL || FAL_IMAGE_MODEL_DEFAULT;

  const input: Record<string, unknown> = { prompt: opts.prompt };
  if (typeof opts.seed === 'number') input.seed = opts.seed;
  if (opts.aspect) input.aspect_ratio = opts.aspect;

  const res = await fal.subscribe(model, { input, logs: false });
  const url = extractImageUrl(res.data);
  if (!url) {
    throw new Error(`[fal] image model ${model} returned no image url`);
  }
  await downloadTo(url, outPath);
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    throw new Error(`[fal] downloaded still missing or empty at ${outPath}`);
  }
  return { uri: outPath, model_id: model, cost: extractCost(res) };
}

export default falAdapter;
