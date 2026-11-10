/**
 * akuko — whole-film estimate (WP-30): the money still to spend, before any of it is spent.
 *
 *   node --experimental-strip-types setup/estimate.ts --project <dir>
 *        [--heroes N] [--lipsync-lines N] [--tries low,likely,high] [--part P7]
 *        [--image-provider <id>] [--image-model <id>] [--video-model <id>] [--json]
 *
 * Free: it reads `akuko.json` and the provider config, and nothing else. No
 * provider is called, nothing is written, no key is read.
 *
 * What it counts, per stage (bible, keyframes, motion clips, lip-sync, sound),
 * per part and for the whole film:
 *   - only work still to be made: a unit whose asset has a file (approved or
 *     waiting for review) is already made and costs nothing more; money already
 *     spent is read from the ledger and shown against the cap, not counted again;
 *   - a low / likely / high range from expected tries per unit (default 1 / 1.5 / 3);
 *     clips and lip-sync are capped by the 3-paid-attempts-per-shot rule, and a
 *     unit that has already used attempts has fewer left;
 *   - prices from `providers/config.json` through `estimateFromConfig`, using the
 *     provider and model the project would run: the image provider for bible and
 *     key frames (from `--image-provider`, else the ledger, else the assets; it
 *     refuses rather than guess a cheaper one), `fal-video` for
 *     clips with the same "cover the shot" length fit the motion stage uses,
 *     `fal-lipsync` through `chooseLipsyncModel` on the line lengths, and
 *     ElevenLabs text-to-speech, which is 0 when `audio.master` is set.
 *
 * Counts come from each shot's `treatment` (see DEFAULT_TREATMENT_BY_TIER).
 * `--heroes N` and `--lipsync-lines N` replace those counts so the person can
 * try "15 heroes, 26 lines". Removed rows (`source.removed_at`) are skipped.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost } from '../hosts/local.ts';
import { removedAt } from '../decisions/fold.ts';
import { bibleEntries, rolesFor, assetIdFor as bibleAssetId } from '../bible/plan.ts';
import { paidAttempts, DEFAULT_MAX_ATTEMPTS } from '../motion/plan.ts';
import { MANUAL_PROVIDER_ID } from '../spend/gate.ts';
import { estimateFromConfig, loadProviderConfig, priceFor, type AkukoProviderConfig } from '../providers/config.ts';
import type { Job, JobItem } from '../providers/contract.ts';
import { falVideoLimits, fitSeconds, FAL_VIDEO_PROVIDER_ID } from '../providers/fal-video/index.ts';
import { FAL_LIPSYNC_PROVIDER_ID, billedSeconds, chooseLipsyncModel, falLipsyncLimits } from '../providers/lipsync/fal/index.ts';
import type { AkukoProject, Asset, AudioLine, Shot, ShotTreatment } from '../schema/akuko-project.ts';
import { DEFAULT_TREATMENT, treatmentOf } from '../motion/treatment.ts';
import { PAD_AFTER_S, PAD_BEFORE_S, lineSpan, secs } from '../lipsync/plan.ts';
import { ledgerSummary } from '../spend/ledger.ts';

// ─────────────────────────────────────────────────────────────────────────
// Rules this estimate assumes
// ─────────────────────────────────────────────────────────────────────────

/**
 * What a shot with no `treatment` means, by tier: WP-27's table and `treatmentOf`, imported (WP-32), so the
 * estimate and the motion stage can never disagree. `estimate.test.ts` still pins the table. No tier and no
 * treatment is today's behaviour (a clip) for a hand-made project; an imported sheet shot with no tier is `still`.
 */
export const DEFAULT_TREATMENT_BY_TIER: Readonly<Record<'A' | 'B' | 'C', ShotTreatment>> = DEFAULT_TREATMENT;
export { treatmentOf };

export const DEFAULT_TRIES: [number, number, number] = [1, 1.5, 3];
export const TTS_PROVIDER = 'elevenlabs';
export const FILM_WIDE = '(film-wide)';
export const NO_PART = '(no part)';

export const ESTIMATE_STAGES = ['bible', 'keyframes', 'motion', 'lipsync', 'sound'] as const;
export type EstimateStage = (typeof ESTIMATE_STAGES)[number];

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface EstimateOptions {
  /** One part only (e.g. `P7`). Film-wide work (the bible) is left out of a part view. */
  part?: string;
  /** Replace the number of video-treated shots. */
  heroes?: number;
  /** Replace the number of spoken lines that get lip-sync. */
  lipsyncLines?: number;
  /** Expected tries per unit: low, likely, high. */
  tries?: [number, number, number];
  imageProvider?: string;
  imageModel?: string;
  videoModel?: string;
  /** Paid attempts allowed per clip / lip-sync shot. Default 3. */
  maxAttempts?: number;
  config?: AkukoProviderConfig;
}

export interface Range { low: number; likely: number; high: number }

export interface StageTotals extends Range {
  /** Units still to make. */
  units: number;
  /** Units already made (a file exists): excluded. */
  done: number;
}

export interface PartRow extends Range {
  part: string;
  byStage: Record<EstimateStage, Range & { units: number }>;
}

export interface Estimate {
  project: string;
  currency: string;
  scope: { part: string | null; heroes: number | null; lipsyncLines: number | null };
  tries: { low: number; likely: number; high: number; cap: number };
  stages: Record<EstimateStage, StageTotals>;
  parts: PartRow[];
  total: Range;
  budget: { cap: number; spent: number; sunk: number; reserved: number; remaining: number } | null;
  /** Prices used, one line each. */
  prices: { lines: string[]; source: { images: string; video: string } };
  /** Shot counts by treatment, in scope, removed rows excluded. */
  treatments: Record<string, number>;
  warnings: string[];
  notes: string[];
}

export class EstimateError extends Error {
  override name = 'EstimateError';
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const micro = (n: number): number => Math.round(n * 1e6) / 1e6;
const money = (n: number): string => String(Number(n.toFixed(4)));
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const zero = (): Range => ({ low: 0, likely: 0, high: 0 });
const add = (a: Range, b: Range): Range => ({ low: micro(a.low + b.low), likely: micro(a.likely + b.likely), high: micro(a.high + b.high) });

const shotSeconds = (s: Shot): number | undefined => {
  if (s.duration_s !== undefined && s.duration_s > 0) return s.duration_s;
  if (s.film) return s.film.out_s - s.film.in_s;
  return undefined;
};

const partOf = (p: AkukoProject, s: Shot): string => s.part ?? p.scenes.find((x) => x.id === s.scene)?.part ?? NO_PART;

/** A unit's asset is already made: it has a file and is not waiting on a change request. */
const made = (a: Asset | undefined): boolean => a?.file !== undefined && (a.status === 'approved' || a.status === 'pending-review');

/** Expected paid tries of one unit: `t`, but never more than the attempts it has left under the cap. Capped stages only. */
const cappedTries = (p: AkukoProject, unit: string, t: number, cap: number): number => Math.max(0, Math.min(t, cap - paidAttempts(p, unit).count));

interface Priced { unit: string; part: string; stage: EstimateStage; cost: number; capped: boolean }

/** Price one job of `items` and return each unit's cost. A configuration problem becomes a warning, not a crash. */
function priceJob(
  config: AkukoProviderConfig, provider: string, model: string | undefined, stage: EstimateStage,
  items: JobItem[], warnings: string[],
): Record<string, number> {
  if (items.length === 0) return {};
  const job: Job = { id: `estimate_${stage}`, stage: stage === 'lipsync' ? 'motion' : stage, kind: stage === 'sound' ? 'audio' : stage === 'motion' || stage === 'lipsync' ? 'video' : 'image', provider, ...(model !== undefined ? { model } : {}), label: `estimate ${stage}`, items };
  try {
    return estimateFromConfig(config, job).per_unit;
  } catch (e) {
    warnings.push(`${stage}: ${plural(items.length, 'unit')} not priced (${e instanceof Error ? e.message : String(e)}).`);
    return {};
  }
}

interface Chosen { provider: string; model?: string; source: string }

/**
 * The image provider and model bible and key-frame work runs on. Never a default:
 * a guess cheaper than the real provider hides an overrun.
 * Order: --image-provider; else the most recent paid (non-manual) ledger entry on a bible or
 * key-frame unit; else the provider of the most recent bible or key-frame asset; else refuse.
 */
export function inferImageProvider(p: AkukoProject, o: Pick<EstimateOptions, 'imageProvider' | 'imageModel'>): Chosen {
  if (o.imageProvider !== undefined) return { provider: o.imageProvider, ...(o.imageModel !== undefined ? { model: o.imageModel } : {}), source: 'from --image-provider' };
  const byId = new Map(p.assets.map((a) => [a.id, a]));
  const isImageUnit = (id: string): boolean => { const a = byId.get(id); return a ? a.stage === 'bible' || a.stage === 'keyframes' : id.endsWith('_keyframe'); };
  for (let i = p.ledger.length - 1; i >= 0; i--) {
    const e = p.ledger[i]!;
    if (e.provider === MANUAL_PROVIDER_ID || !isImageUnit(e.unit)) continue;
    const model = o.imageModel ?? e.model;
    return { provider: e.provider, ...(model !== undefined ? { model } : {}), source: 'from the ledger (the most recent paid bible or key-frame call)' };
  }
  let best: Asset | undefined;
  for (const a of p.assets) {
    if ((a.stage !== 'bible' && a.stage !== 'keyframes') || a.provider === undefined || a.provider === MANUAL_PROVIDER_ID) continue;
    if (best === undefined || (a.updated_at ?? '') >= (best.updated_at ?? '')) best = a;
  }
  if (best?.provider !== undefined) {
    const model = o.imageModel ?? best.model;
    return { provider: best.provider, ...(model !== undefined ? { model } : {}), source: `from the assets (${best.id} was made by it)` };
  }
  throw new EstimateError('Cannot tell which image provider this project uses: nothing paid has run for the bible or key frames yet. Pass --image-provider <id> (for example gemini-image or fal) so the estimate prices the provider you will really use; akuko will not guess a cheaper one.');
}

/** The video model clips run on: --video-model, else the ledger or assets of a fal-video clip, else the config default (said so). */
function inferVideoModel(p: AkukoProject, config: AkukoProviderConfig, flag: string | undefined): { model: string | undefined; source: string } {
  if (flag !== undefined) return { model: flag, source: 'from --video-model' };
  const isClip = (id: string): boolean => { const a = p.assets.find((x) => x.id === id); return a ? a.stage === 'motion' && a.kind === 'clip' : id.endsWith('_clip'); };
  for (let i = p.ledger.length - 1; i >= 0; i--) {
    const e = p.ledger[i]!;
    if (e.provider === FAL_VIDEO_PROVIDER_ID && e.model !== undefined && isClip(e.unit)) return { model: e.model, source: 'from the ledger (the most recent paid clip)' };
  }
  const a = [...p.assets].reverse().find((x) => x.kind === 'clip' && x.provider === FAL_VIDEO_PROVIDER_ID && x.model !== undefined);
  if (a?.model !== undefined) return { model: a.model, source: `from the assets (${a.id})` };
  let model: string | undefined;
  try { model = priceFor(config, FAL_VIDEO_PROVIDER_ID).model; } catch { /* reported when priced */ }
  return { model, source: 'the config default (no clip has been made yet; pass --video-model to change it)' };
}

const priceLine = (config: AkukoProviderConfig, provider: string, model?: string): string | undefined => {
  try {
    const r = priceFor(config, provider, model);
    return `${provider} ${r.model}: ${money(r.amount)} ${r.currency}/${r.per} (verified ${r.last_verified})`;
  } catch { return undefined; }
};

// ─────────────────────────────────────────────────────────────────────────
// The estimate
// ─────────────────────────────────────────────────────────────────────────

export function estimateFilm(project: AkukoProject, o: EstimateOptions = {}): Estimate {
  const config = o.config ?? loadProviderConfig();
  const tries = o.tries ?? DEFAULT_TRIES;
  const cap = o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const warnings: string[] = [];
  const notes: string[] = [];
  const prices: string[] = [];
  const source = { images: '', video: '' };
  const priced: Priced[] = [];
  const doneCount: Record<EstimateStage, number> = { bible: 0, keyframes: 0, motion: 0, lipsync: 0, sound: 0 };
  const assetById = new Map(project.assets.map((a) => [a.id, a]));

  // Shots in scope, in film order (array order among equals), removed rows out.
  const live = project.shots.filter((s) => removedAt(project, s) === undefined);
  const ordered = [...live].sort((a, b) => (a.film?.in_s ?? Infinity) - (b.film?.in_s ?? Infinity));
  const inScope = (s: Shot): boolean => o.part === undefined || partOf(project, s) === o.part;
  const shots = ordered.filter(inScope);
  if (o.part !== undefined && shots.length === 0) {
    const known = [...new Set(live.map((s) => partOf(project, s)))].join(', ');
    throw new EstimateError(`No shots in part "${o.part}". Parts in this project: ${known || 'none'}.`);
  }
  const shotById = new Map(live.map((s) => [s.id, s]));

  const treatments: Record<string, number> = {};
  for (const s of shots) {
    const t = treatmentOf(s) ?? 'untiered (clip, as today)';
    treatments[t] = (treatments[t] ?? 0) + 1;
  }

  // ── bible: film-wide ────────────────────────────────────────────────
  const image = inferImageProvider(project, o);
  const imageProvider = image.provider;
  const imageModel = image.model;
  source.images = `${imageProvider}${imageModel ? ' ' + imageModel : ''} ${image.source}`;
  const imgLine = priceLine(config, imageProvider, imageModel);
  prices.push(imgLine ? `images: ${imgLine} [${image.source}]` : `images: ${source.images}`);
  if (o.part === undefined) {
    const items: JobItem[] = [];
    for (const { kind, entry } of bibleEntries(project)) {
      if (removedAt(project, entry) !== undefined) continue;
      for (const role of rolesFor(kind, entry)) {
        const id = bibleAssetId(entry.id, role);
        if (made(assetById.get(id))) { doneCount.bible++; continue; }
        items.push({ unit: id, prompt: '', output: 'portrait', count: 1 });
      }
    }
    const costs = priceJob(config, imageProvider, imageModel, 'bible', items, warnings);
    for (const it of items) priced.push({ unit: it.unit, part: FILM_WIDE, stage: 'bible', cost: costs[it.unit] ?? 0, capped: false });
  } else {
    notes.push(`Part view: the bible is film-wide and is left out. Run without --part for it.`);
  }

  // ── key frames: one per shot ────────────────────────────────────────
  {
    const items: JobItem[] = [];
    const partOfUnit = new Map<string, string>();
    for (const s of shots) {
      const id = `${s.id}_keyframe`;
      if (made(assetById.get(id))) { doneCount.keyframes++; continue; }
      items.push({ unit: id, prompt: '', output: 'keyframe', count: 1 });
      partOfUnit.set(id, partOf(project, s));
    }
    const costs = priceJob(config, imageProvider, imageModel, 'keyframes', items, warnings);
    for (const it of items) priced.push({ unit: it.unit, part: partOfUnit.get(it.unit)!, stage: 'keyframes', cost: costs[it.unit] ?? 0, capped: false });
  }

  // ── motion clips: shots that get video ──────────────────────────────
  const videoProvider = FAL_VIDEO_PROVIDER_ID;
  const video = inferVideoModel(project, config, o.videoModel);
  const videoModel = video.model;
  source.video = `${videoProvider}${videoModel ? ' ' + videoModel : ''} ${video.source}`;
  const vLine = priceLine(config, videoProvider, videoModel);
  if (vLine) prices.push(`clips: ${vLine} [${video.source}]`);
  const explicitVideo = (s: Shot): boolean => s.treatment === 'video';
  let videoShots: Shot[];
  {
    const eligible = shots.filter((s) => { const t = treatmentOf(s); return t === 'video' || t === undefined || (o.heroes !== undefined && t !== 'lipsync'); });
    if (o.heroes === undefined) {
      videoShots = eligible.filter((s) => { const t = treatmentOf(s); return t === 'video' || t === undefined; });
    } else {
      const rank = (s: Shot): number => (explicitVideo(s) ? 0 : s.tier === 'A' ? 1 : s.tier === 'B' ? 2 : s.tier === undefined ? 3 : 4);
      const ranked = [...eligible].sort((a, b) => rank(a) - rank(b)); // sort is stable: film order kept within a rank
      videoShots = ranked.slice(0, o.heroes);
      if (videoShots.length < o.heroes) warnings.push(`--heroes ${o.heroes}: only ${plural(videoShots.length, 'shot')} in scope can take a clip, so ${videoShots.length} is what is priced.`);
    }
  }
  {
    const items: JobItem[] = [];
    const meta = new Map<string, { part: string; capped: boolean }>();
    const limits = videoModel !== undefined ? falVideoLimits(videoModel) : undefined;
    if (videoModel !== undefined && !limits && videoShots.length > 0) warnings.push(`motion: akuko has no request rules for ${videoProvider} model "${videoModel}"; clips are priced at the shot length.`);
    for (const s of videoShots) {
      const id = `${s.id}_clip`;
      if (made(assetById.get(id))) { doneCount.motion++; continue; }
      const want = shotSeconds(s);
      if (want === undefined) { warnings.push(`${id}: the shot has no duration, so its clip is not priced.`); continue; }
      const fit = limits ? fitSeconds(want, limits.allowedSeconds, 'cover') : undefined;
      const used = fit ? fit.seconds : want;
      // A shot longer than the model's longest clip needs several clips; price them all.
      const clips = fit?.capped ? Math.ceil(want / used - 1e-9) : 1;
      if (clips > 1) warnings.push(`${s.id}: ${money(want)} s needs ${clips} clips of ${used} s (${videoModel}); consider a still-move instead.`);
      if (paidAttempts(project, id).count >= cap) { warnings.push(`${id} has used its ${cap} paid attempts; it is not priced (the person must ask for more).`); continue; }
      items.push({ unit: id, prompt: '', output: 'clip', count: clips, duration_s: used });
      meta.set(id, { part: partOf(project, s), capped: true });
    }
    const costs = priceJob(config, videoProvider, videoModel, 'motion', items, warnings);
    for (const it of items) priced.push({ unit: it.unit, part: meta.get(it.unit)!.part, stage: 'motion', cost: costs[it.unit] ?? 0, capped: true });
  }

  // ── lip-sync: spoken lines ──────────────────────────────────────────
  {
    const lines = (project.audio?.lines ?? []).filter((l) => l.kind === 'spoken');
    const shotOfLine = (l: AudioLine): Shot | undefined => {
      const linked = live.find((s) => (s.lines ?? []).some((x) => x.id === l.id));
      if (linked) return linked;
      const mid = (l.film_in_s + l.film_out_s) / 2;
      return live.find((s) => s.film !== undefined && s.film.in_s <= mid && mid < s.film.out_s);
    };
    interface L { line: AudioLine; shot: Shot | undefined; part: string }
    const universe: L[] = lines
      .map((line) => ({ line, shot: shotOfLine(line) }))
      .map((x) => ({ ...x, part: x.shot ? partOf(project, x.shot) : NO_PART }))
      .filter((x) => (x.shot ? removedAt(project, x.shot) === undefined : true))
      .filter((x) => (o.part === undefined ? true : x.part === o.part));
    universe.sort((a, b) => a.line.film_in_s - b.line.film_in_s);

    const asked = (x: L): boolean => x.shot?.treatment === 'lipsync' || x.shot?.treatment === 'video';
    const rank = (x: L): number => (x.shot?.treatment === 'lipsync' ? 0 : x.shot?.treatment === 'video' ? 1 : x.shot?.tier === 'A' ? 2 : 3);
    let chosen: L[];
    if (o.lipsyncLines === undefined) {
      chosen = universe.filter(asked);
      const flagged = universe.filter((x) => !asked(x) && x.shot?.tier === 'A' && treatmentOf(x.shot) !== 'video');
      if (flagged.length > 0) notes.push(`${plural(flagged.length, 'tier-A shot')} with a spoken line could be lip-synced; they are not priced until a person asks for it (use --lipsync-lines).`);
    } else {
      chosen = [...universe].sort((a, b) => rank(a) - rank(b)).slice(0, o.lipsyncLines);
      if (chosen.length < o.lipsyncLines) warnings.push(`--lipsync-lines ${o.lipsyncLines}: only ${plural(chosen.length, 'spoken line')} in scope, so ${chosen.length} is what is priced.`);
    }
    chosen.sort((a, b) => a.line.film_in_s - b.line.film_in_s);

    // One lip-sync per shot, as the lip-sync step makes them: its chosen lines become ONE span, cut by the step's own
    // rule (`lipsync/plan.ts#lineSpan`: the pads, clamped to the shot and the master). A line no shot carries is
    // priced on its own, by the same rule.
    const groups = new Map<string, { unit: string; shot: Shot | undefined; lines: AudioLine[]; part: string }>();
    for (const x of chosen) {
      const key = x.shot ? `${x.shot.id}_lipsync` : x.line.id;
      const g = groups.get(key) ?? groups.set(key, { unit: key, shot: x.shot, lines: [], part: x.part }).get(key)!;
      g.lines.push(x.line);
    }
    const master = project.audio?.master;
    const byModel = new Map<string, JobItem[]>();
    const meta = new Map<string, string>();
    for (const g of groups.values()) {
      const ids = g.lines.map((l) => l.id).join(', ');
      if (g.shot && made(assetById.get(g.unit))) { doneCount.lipsync++; continue; }
      if (g.shot && paidAttempts(project, g.unit).count >= cap) { warnings.push(`${g.unit} has used its ${cap} paid attempts; its line${g.lines.length === 1 ? '' : 's'} ${ids} ${g.lines.length === 1 ? 'is' : 'are'} not priced.`); continue; }
      const span = lineSpan(g.lines, g.shot?.film, master);
      if (!span) { warnings.push(`${g.unit} (line${g.lines.length === 1 ? '' : 's'} ${ids}): the lines fall outside the shot's film time, so there is nothing to cut; not priced.`); continue; }
      const audioS = secs(span.out_s - span.in_s);
      const model = chooseLipsyncModel(config, 'image', audioS);
      if (model === undefined) { warnings.push(`${g.unit} (${money(audioS)} s): no lip-sync model admits that length, so it is not priced.`); continue; }
      const billed = billedSeconds(audioS, falLipsyncLimits(model) ?? {});
      (byModel.get(model) ?? byModel.set(model, []).get(model)!).push({ unit: g.unit, prompt: '', output: 'lipsync', count: 1, duration_s: billed });
      meta.set(g.unit, g.part);
    }
    for (const [model, items] of byModel) {
      const l = priceLine(config, FAL_LIPSYNC_PROVIDER_ID, model);
      if (l) prices.push(`lip-sync: ${l}`);
      const costs = priceJob(config, FAL_LIPSYNC_PROVIDER_ID, model, 'lipsync', items, warnings);
      for (const it of items) priced.push({ unit: it.unit, part: meta.get(it.unit)!, stage: 'lipsync', cost: costs[it.unit] ?? 0, capped: true });
    }
    notes.push(`Lip-sync is priced per shot (image mode), on one span covering its spoken lines: ${PAD_BEFORE_S} s before the first and ${PAD_AFTER_S} s after the last, kept inside the shot${master ? ' and the master' : ''}, the same rule the lip-sync step cuts by (lipsync/plan.ts). A line no shot carries is priced on its own.`);
  }

  // ── sound: text-to-speech ───────────────────────────────────────────
  {
    const items: JobItem[] = [];
    const meta = new Map<string, string>();
    const masterSet = project.audio?.master !== undefined;
    for (const s of shots) {
      const id = `${s.id}_vo`;
      const a = assetById.get(id);
      const text = (s.narration ?? '').trim() !== '' ? (s.narration as string).trim() : a?.tags.includes('text:script_line') ? (s.script_line ?? '').trim() : '';
      if (text === '') continue;
      if (made(a)) { doneCount.sound++; continue; }
      if (masterSet) continue;
      items.push({ unit: id, prompt: text, output: 'vo', count: 1 });
      meta.set(id, partOf(project, s));
    }
    if (masterSet) notes.push('Sound: narration comes from audio.master, so text-to-speech costs 0.');
    else {
      const l = priceLine(config, TTS_PROVIDER);
      if (l) prices.push(`voice-over: ${l}`);
      const costs = priceJob(config, TTS_PROVIDER, undefined, 'sound', items, warnings);
      for (const it of items) priced.push({ unit: it.unit, part: meta.get(it.unit)!, stage: 'sound', cost: costs[it.unit] ?? 0, capped: false });
    }
  }

  // ── fold units into stages and parts ────────────────────────────────
  const [tLow, tLikely, tHigh] = tries;
  const stages = Object.fromEntries(ESTIMATE_STAGES.map((st) => [st, { ...zero(), units: 0, done: doneCount[st] }])) as Record<EstimateStage, StageTotals>;
  const partRows = new Map<string, PartRow>();
  const rowFor = (part: string): PartRow => {
    let r = partRows.get(part);
    if (!r) {
      r = { part, ...zero(), byStage: Object.fromEntries(ESTIMATE_STAGES.map((st) => [st, { ...zero(), units: 0 }])) as PartRow['byStage'] };
      partRows.set(part, r);
    }
    return r;
  };
  for (const u of priced) {
    const unitId = u.unit.split('#')[0]!;
    const t = (n: number): number => (u.capped ? cappedTries(project, unitId, n, cap) : n);
    const r: Range = { low: u.cost * t(tLow), likely: u.cost * t(tLikely), high: u.cost * t(tHigh) };
    const st = stages[u.stage];
    st.units++;
    Object.assign(st, add(st, r));
    const pr = rowFor(u.part);
    pr.byStage[u.stage].units++;
    Object.assign(pr.byStage[u.stage], add(pr.byStage[u.stage], r));
    Object.assign(pr, add(pr, r));
  }
  // Part order: first appearance in the film, film-wide last.
  const order = [...new Set(shots.map((s) => partOf(project, s)))];
  const parts = [...partRows.values()].sort((a, b) => {
    const ia = a.part === FILM_WIDE ? 1e9 : order.indexOf(a.part);
    const ib = b.part === FILM_WIDE ? 1e9 : order.indexOf(b.part);
    return ia - ib;
  });
  const total = ESTIMATE_STAGES.reduce((acc, st) => add(acc, stages[st]), zero());

  // ── against the budget ──────────────────────────────────────────────
  const sum = ledgerSummary(project);
  const budget = project.budget === null || sum.remaining === null
    ? null
    : { cap: project.budget.cap, spent: sum.spent, sunk: micro(sum.sunk), reserved: micro(sum.reserved), remaining: micro(sum.remaining) };
  if (budget === null) {
    warnings.push('No budget is set, so no paid step can run. Run /akuko setup to set a cap.');
  } else {
    for (const k of ['low', 'likely', 'high'] as const) {
      if (total[k] > budget.remaining + 1e-9) {
        warnings.push(`Over budget at the ${k} estimate: ${money(total[k])} ${project.budget!.currency} needed, ${money(budget.remaining)} left under the ${money(budget.cap)} cap (${money(micro(total[k] - budget.remaining))} short).`);
      }
    }
  }
  notes.push('Music and sound effects are not priced.');
  if (tHigh > cap) notes.push(`Clips and lip-sync are capped at ${cap} paid attempts per shot, so their high estimate counts at most ${cap} tries.`);

  return {
    project: project.project.title,
    currency: project.budget?.currency ?? config.currency,
    scope: { part: o.part ?? null, heroes: o.heroes ?? null, lipsyncLines: o.lipsyncLines ?? null },
    tries: { low: tLow, likely: tLikely, high: tHigh, cap },
    stages,
    parts,
    total,
    budget,
    prices: { lines: prices, source },
    treatments,
    warnings,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Plain output
// ─────────────────────────────────────────────────────────────────────────

const pad = (s: string, n: number): string => s.padEnd(n);
const num = (n: number): string => money(n).padStart(9);

export function formatEstimate(e: Estimate): string {
  const cur = e.currency;
  const out: string[] = [];
  out.push(`Whole-film estimate: ${e.project}  (${e.scope.part ? `part ${e.scope.part}` : 'whole film'}; amounts in ${cur}; nothing is spent by this)`);
  for (const w of e.warnings.filter((x) => x.startsWith('Over budget'))) out.push(`!! ${w}`);
  const ov = [e.scope.heroes !== null ? `${e.scope.heroes} clips` : '', e.scope.lipsyncLines !== null ? `${e.scope.lipsyncLines} lip-sync lines` : ''].filter(Boolean);
  if (ov.length) out.push(`Counts set by you: ${ov.join(', ')}.`);
  out.push(`Expected tries per unit: low ${e.tries.low}, likely ${e.tries.likely}, high ${e.tries.high}.`);
  out.push(`Shots by treatment: ${Object.entries(e.treatments).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  out.push('Made = units already made (a file exists, approved or waiting for review); they are left out of the money.');
  out.push('');
  out.push(`${pad('Stage', 12)}${'To make'.padStart(8)}${'Made'.padStart(6)}${'Low'.padStart(10)}${'Likely'.padStart(10)}${'High'.padStart(10)}`);
  for (const st of ESTIMATE_STAGES) {
    const s = e.stages[st];
    out.push(`${pad(st, 12)}${String(s.units).padStart(8)}${String(s.done).padStart(6)}${num(s.low).padStart(10)}${num(s.likely).padStart(10)}${num(s.high).padStart(10)}`);
  }
  out.push(`${pad('Total', 12)}${''.padStart(14)}${num(e.total.low).padStart(10)}${num(e.total.likely).padStart(10)}${num(e.total.high).padStart(10)}`);
  out.push('');
  out.push(`${pad('Part', 14)}${'Low'.padStart(10)}${'Likely'.padStart(10)}${'High'.padStart(10)}   by stage (likely)`);
  for (const r of e.parts) {
    const by = ESTIMATE_STAGES.filter((st) => r.byStage[st].units > 0).map((st) => `${st} ${money(r.byStage[st].likely)}`).join(', ');
    out.push(`${pad(r.part, 14)}${num(r.low).padStart(10)}${num(r.likely).padStart(10)}${num(r.high).padStart(10)}   ${by}`);
  }
  out.push('');
  if (e.budget) {
    const b = e.budget;
    out.push(`Budget: cap ${money(b.cap)}, spent ${money(b.spent)}, failed or cancelled ${money(b.sunk)}, in flight ${money(b.reserved)}; ${money(b.remaining)} left.`);
    for (const k of ['low', 'likely', 'high'] as const) out.push(`  after the ${k} estimate: ${money(micro(b.remaining - e.total[k]))} ${b.remaining - e.total[k] < -1e-9 ? '(OVER the cap)' : 'left'}`);
  } else out.push('Budget: none set.');
  if (e.prices.lines.length) { out.push(''); out.push('Prices used:'); for (const p of e.prices.lines) out.push(`  ${p}`); }
  if (e.warnings.length) { out.push(''); out.push('Warnings:'); for (const w of e.warnings) out.push(`  - ${w}`); }
  if (e.notes.length) { out.push(''); out.push('Notes:'); for (const n of e.notes) out.push(`  - ${n}`); }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

export interface CliResult { code: number; out: string }

function parseFlags(argv: string[]): Map<string, string | true> {
  const opt = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opt.set(a.slice(2), next); i++; } else opt.set(a.slice(2), true);
  }
  return opt;
}
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
function count(name: string, v: string | true | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) throw new EstimateError(`--${name} must be a whole number of 0 or more.`);
  return n;
}

export async function run(argv: string[]): Promise<CliResult> {
  try {
    const opt = parseFlags(argv);
    const dir = str(opt.get('project'));
    if (!dir) return { code: 2, out: 'akuko: --project <dir> is required.' };
    const triesRaw = str(opt.get('tries'));
    let tries: [number, number, number] | undefined;
    if (triesRaw !== undefined) {
      const parts = triesRaw.split(',').map((x) => Number(x.trim()));
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) throw new EstimateError('--tries takes three positive numbers: low,likely,high (for example 1,1.5,3).');
      tries = [parts[0]!, parts[1]!, parts[2]!];
    }
    const heroes = count('heroes', opt.get('heroes'));
    const lines = count('lipsync-lines', opt.get('lipsync-lines'));
    const part = str(opt.get('part'));
    const imageProvider = str(opt.get('image-provider'));
    const imageModel = str(opt.get('image-model'));
    const videoModel = str(opt.get('video-model'));
    const project = await createLocalHost({ projectDir: resolve(dir) }).readState();
    const e = estimateFilm(project, {
      ...(part !== undefined ? { part } : {}),
      ...(heroes !== undefined ? { heroes } : {}),
      ...(lines !== undefined ? { lipsyncLines: lines } : {}),
      ...(tries ? { tries } : {}),
      ...(imageProvider !== undefined ? { imageProvider } : {}),
      ...(imageModel !== undefined ? { imageModel } : {}),
      ...(videoModel !== undefined ? { videoModel } : {}),
    });
    return { code: 0, out: opt.has('json') ? JSON.stringify(e, null, 2) : formatEstimate(e) };
  } catch (err) {
    if (err instanceof EstimateError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
