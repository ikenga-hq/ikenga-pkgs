/**
 * akuko — motion stage (stage 5, clips): planning, readiness, jobs, the retry cap (WP-10).
 *
 * Review unit: one planned **asset** per shot (`<shot>_clip`, kind `clip`,
 * stage `motion`, owner = the shot), the same shape as the key-frame stage
 * (`keyframes/plan.ts`): the shot and its approved key frame are never touched,
 * the provider fills the clip asset in place, and decision folding approves the
 * stage when every clip is approved.
 *
 *   planMotion()       create the planned clip assets (idempotent)
 *   unitReadiness()    ready / blocked / in flight / in review / approved
 *   paidAttempts()     paid tries on one clip, from the ledger, with the money spent
 *   buildMotionJob()   one gate-ready Job (default: the next shot), refusing at the retry cap
 *   beginUnits() / abandonUnits() / repairFileless() / refreshStageState()
 *
 * The retry cap lives here and not in `spend/` (frozen): a clip's price is per
 * second, so a retry loop is where money goes quickly. Nothing here calls a
 * provider, writes `approved`, or writes the project.
 */

import { createHash } from 'node:crypto';
import { STAGES, type AkukoProject, type Asset, type Shot } from '../schema/akuko-project.ts';
import type { AkukoProviderConfig } from '../providers/config.ts';
import { loadProviderConfig, priceFor, providerConfig } from '../providers/config.ts';
import type { Job, JobItem } from '../providers/contract.ts';
import { AUDIO_SUFFIX, falVideoLimits, snapSeconds } from '../providers/fal-video/index.ts';
import { requestedChanges } from '../bible/plan.ts';
import { jobRan } from '../keyframes/plan.ts';
import { MANUAL_PROVIDER_ID } from '../spend/gate.ts';
import { motionPrompt } from './prompts.ts';

export const MOTION_STAGE = 'motion' as const;
/** Tag every planned clip asset carries. */
export const CLIP_TAG = 'clip';
/** Paid attempts allowed per shot unless the person asks for more. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export class MotionError extends Error {
  override name = 'MotionError';
}

export const assetIdFor = (shotId: string): string => `${shotId}_clip`;
const keyframeIdFor = (shotId: string): string => `${shotId}_keyframe`;
export const isClip = (a: Asset): boolean => a.stage === MOTION_STAGE && a.tags.includes(CLIP_TAG);
export const clipAssets = (p: AkukoProject): Asset[] => p.assets.filter(isClip);

const hasFile = (a: Asset | undefined): boolean => a?.file !== undefined;
const approvedWithFile = (a: Asset | undefined): boolean => a !== undefined && a.status === 'approved' && hasFile(a);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const money = (n: number): string => String(Number(n.toFixed(4)));
const hash8 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);

// ─────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────

/** Refuse unless the motion stage is open: every earlier stage, through the key frames, approved. */
export function assertOpen(p: AkukoProject): void {
  for (const { id } of STAGES) {
    if (id === MOTION_STAGE) break;
    if (p.stages[id].state !== 'approved') {
      throw new MotionError(`The motion stage is locked: ${id} is "${p.stages[id].state}". It opens when a person has approved every earlier stage, through the key frames.`);
    }
  }
  if (p.stages.motion.state === 'locked') throw new MotionError('The motion stage is still locked; fold the latest decisions first.');
}

export interface PlanResult { project: AkukoProject; created: string[] }

/** Create the planned clip asset for every shot that has none. Safe to run again. */
export function planMotion(project: AkukoProject, now: string): PlanResult {
  assertOpen(project);
  const p = structuredClone(project);
  const created: string[] = [];
  for (const shot of p.shots) {
    const id = assetIdFor(shot.id);
    if (p.assets.some((a) => a.id === id)) continue;
    p.assets.push({
      id,
      stage: MOTION_STAGE,
      status: 'pending',
      comments: [],
      kind: 'clip',
      owner: shot.id,
      name: `${shot.id} - clip`,
      tags: [CLIP_TAG],
      updated_at: now,
    });
    created.push(id);
  }
  if (created.length > 0 && p.stages.motion.state === 'not-started') p.stages.motion = { state: 'in-progress' };
  return { project: p, created };
}

// ─────────────────────────────────────────────────────────────────────────
// Readiness
// ─────────────────────────────────────────────────────────────────────────

export type ReadinessState = 'approved' | 'in-review' | 'in-flight' | 'ready' | 'blocked';
export interface Readiness { state: ReadinessState; waiting: string[] }

const shotOf = (p: AkukoProject, a: Asset): Shot => {
  const s = p.shots.find((x) => x.id === a.owner);
  if (!s) throw new MotionError(`clip "${a.id}" has no shot; plan the clips again.`);
  return s;
};

const inFlight = (p: AkukoProject, a: Asset): boolean => p.ledger.some((e) => e.unit === a.id && e.status === 'submitted');

export function unitReadiness(p: AkukoProject, a: Asset): Readiness {
  if (approvedWithFile(a)) return { state: 'approved', waiting: [] };
  if (hasFile(a) && a.status === 'pending-review') return { state: 'in-review', waiting: [] };
  if (inFlight(p, a)) return { state: 'in-flight', waiting: [] };
  const kf = p.assets.find((x) => x.id === keyframeIdFor(shotOf(p, a).id));
  if (!approvedWithFile(kf)) return { state: 'blocked', waiting: [keyframeIdFor(a.owner ?? '')] };
  return { state: 'ready', waiting: [] };
}

// ─────────────────────────────────────────────────────────────────────────
// The retry cap
// ─────────────────────────────────────────────────────────────────────────

export interface Attempts { count: number; spent: number }

/**
 * Paid attempts on one clip so far: ledger entries for it that finished
 * (`done`) or failed, from a paid provider. Money a failed call cost counts
 * too, so a loop of failures hits the cap like a loop of bad takes. Manual
 * takes are free to akuko and are not counted. `spent` is what they cost
 * (the reported actual, else the estimate).
 */
export function paidAttempts(p: AkukoProject, unit: string): Attempts {
  let count = 0;
  let spent = 0;
  for (const e of p.ledger) {
    if (e.unit !== unit || e.provider === MANUAL_PROVIDER_ID) continue;
    if (e.status !== 'done' && e.status !== 'failed') continue;
    count++;
    spent += e.actual ?? e.estimate ?? 0;
  }
  return { count, spent };
}

/** Throw when `unit` has used up its paid attempts. The message names the count and the money, and says the person can raise it. */
export function assertAttemptsLeft(p: AkukoProject, unit: string, max: number): void {
  const { count, spent } = paidAttempts(p, unit);
  if (count >= max) {
    const cur = p.budget?.currency ?? '';
    throw new MotionError(
      `${unit} has had ${plural(count, 'paid attempt')} and ${money(spent)} ${cur} has gone on it; the limit is ${max} per shot. ` +
      `Stop here and tell the person. If they decide to try again they must say so in their own words; then run step again with --max-attempts ${max + 1}.`,
    );
  }
}

export interface StatusRow {
  shot: string;
  asset: string;
  status: Asset['status'];
  state: ReadinessState;
  waiting: string[];
  attempts: number;
  spent: number;
}

export function motionStatus(p: AkukoProject): StatusRow[] {
  return clipAssets(p).map((a) => {
    const r = unitReadiness(p, a);
    const t = paidAttempts(p, a.id);
    return { shot: a.owner ?? '', asset: a.id, status: a.status, state: r.state, waiting: r.waiting, attempts: t.count, spent: t.spent };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────

export interface JobIdParts {
  units: string[];
  provider?: string;
  model?: string;
  /** Seconds per unit: a different length is a different price, so a different job. */
  seconds?: Record<string, number>;
  audio?: boolean;
}

/**
 * Deterministic id: `job_mo_<hash of units + provider + model + seconds + sound>_r<n>`.
 * A person's approval binds to one provider, model, length and sound choice, so
 * changing any of them is a new job with a fresh approval. A regeneration after
 * a send-back is the next `r<n>`.
 */
export function motionJobId(p: AkukoProject, o: JobIdParts): string {
  const secs = [...o.units].sort().map((u) => `${u}=${o.seconds?.[u] ?? ''}`).join('|');
  const base = `job_mo_${hash8([[...o.units].sort().join('|'), o.provider ?? '', o.model ?? '', secs, o.audio ? 'audio' : 'silent'].join('#'))}`;
  let n = 1;
  while (jobRan(p, `${base}_r${n}`)) n++;
  return `${base}_r${n}`;
}

export interface BuildOptions {
  provider: string;
  model?: string;
  /** Clip asset ids to make. Default: the next ready shot, alone. */
  units?: string[];
  /** Make every ready clip of this scene in one job. */
  scene?: string;
  /** Ask for native sound where the model has it. Default off. */
  audio?: boolean;
  /** Paid attempts allowed per shot. Default 3; raise only when the person asked in their own words. */
  maxAttempts?: number;
  config?: AkukoProviderConfig;
}

export interface Skipped { unit: string; reason: string }
export interface BuiltJob {
  job: Job;
  units: string[];
  skipped: Skipped[];
  /** Things the person should hear: a length changed to what the model can make, sound off. */
  notes: string[];
}

interface Limits { allowedSeconds: number[] }
/** What a video provider can make. Unknown providers (and the manual one) have no limit akuko knows about. */
function limitsFor(provider: string, model: string): Limits | undefined {
  if (provider === 'fal-video') return falVideoLimits(model);
  return undefined;
}

/** Resolve the model, applying the sound choice. Sound is a separate model id in config (its own price). */
function resolveModel(config: AkukoProviderConfig, o: BuildOptions): { model: string | undefined; audio: boolean } {
  const entry = providerConfig(config, o.provider);
  if (o.provider === MANUAL_PROVIDER_ID) return { model: o.model, audio: o.audio === true };
  const base = o.model ?? entry.default_model;
  if (!(base in entry.models)) throw new MotionError(`model "${base}" is not configured for ${o.provider}.`);
  if (o.audio && !base.endsWith(AUDIO_SUFFIX)) {
    const loud = `${base}${AUDIO_SUFFIX}`;
    if (!(loud in entry.models)) throw new MotionError(`${base} has no sound option in config, so sound cannot be asked for with it. Clips are silent; sound is made in the sound stage.`);
    return { model: loud, audio: true };
  }
  return { model: base, audio: base.endsWith(AUDIO_SUFFIX) };
}

/**
 * Build one job. It never submits anything: hand the result to `gate.run()`.
 * By default one shot, the next that is ready, so each approval binds to the
 * amount for that one clip. A shot with no approved key frame is blocked. A
 * shot at the retry cap is refused (or skipped, in a batch).
 */
export function buildMotionJob(p: AkukoProject, o: BuildOptions): BuiltJob {
  assertOpen(p);
  const config = o.config ?? loadProviderConfig();
  const max = o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(max) || max < 1) throw new MotionError('--max-attempts must be a whole number of 1 or more.');
  const all = clipAssets(p);
  const byId = new Map(all.map((a) => [a.id, a]));

  let candidates: Asset[];
  if (o.units) {
    candidates = o.units.map((id) => {
      const a = byId.get(id);
      if (!a) throw new MotionError(`"${id}" is not a planned clip; run plan first.`);
      const r = unitReadiness(p, a);
      if (r.state !== 'ready') throw new MotionError(`${id} cannot be made now (${r.state}${r.waiting.length ? `; its key frame is not approved: ${r.waiting.join(', ')}` : ''}).`);
      return a;
    });
  } else {
    candidates = all.filter((a) => unitReadiness(p, a).state === 'ready' && (o.scene === undefined || shotOf(p, a).scene === o.scene));
  }
  if (candidates.length === 0) {
    const stuck = motionStatus(p).filter((r) => r.state === 'blocked').map((r) => `${r.asset} (waiting for the approved key frame ${r.waiting.join(', ')})`);
    throw new MotionError(stuck.length ? `Nothing can be made yet: ${stuck.join('; ')}.` : 'Nothing is waiting to be made.');
  }
  if (new Set(candidates.map((a) => a.id)).size !== candidates.length) throw new MotionError('a unit was listed twice');

  const { model, audio } = resolveModel(config, o);
  const limits = limitsFor(o.provider, model ?? '');
  if (o.provider !== MANUAL_PROVIDER_ID && model !== undefined && !limits) {
    throw new MotionError(`akuko has no request rules for ${o.provider} model "${model}".`);
  }

  const notes: string[] = [];
  const seconds: Record<string, number> = {};
  const buildItem = (a: Asset): JobItem => {
    assertAttemptsLeft(p, a.id, max);
    const shot = shotOf(p, a);
    const want = shot.duration_s;
    if (want === undefined || !(want > 0)) {
      throw new MotionError(`shot ${shot.id} has no duration; set one on the shot (motion does not guess a length).`);
    }
    let used = want;
    if (limits) {
      const s = snapSeconds(want, limits.allowedSeconds);
      used = s.seconds;
      if (s.changed) notes.push(`${a.id}: the shot runs ${want} s but ${o.provider} makes ${limits.allowedSeconds.join(' or ')} s clips, so this clip is ${used} s${used < want ? ' (shorter than the shot; trim or extend in assemble)' : ''}.`);
    }
    seconds[a.id] = used;
    const kf = p.assets.find((x) => x.id === keyframeIdFor(shot.id)) as Asset;
    const asked = (a.status === 'needs-rework' || a.status === 'draft') ? requestedChanges(a) : '';
    return {
      unit: a.id,
      prompt: motionPrompt({ shot, seconds: used, audio }, asked),
      output: 'clip',
      aspect_ratio: p.project.aspect_ratio,
      duration_s: used,
      count: 1,
      ...(shot.seed !== undefined ? { seed: shot.seed } : {}),
      refs: [{ id: kf.id, uri: kf.file!.uri, role: 'start-frame', note: 'the approved key frame: the first frame of the clip' }],
    };
  };

  // Explicit units: the person named them, so an unbuildable one is an error. Otherwise a clip that
  // cannot be built is skipped and reported and the next ready one is tried.
  const items: JobItem[] = [];
  const skipped: Skipped[] = [];
  for (const a of candidates) {
    if (o.units) { items.push(buildItem(a)); continue; }
    try {
      items.push(buildItem(a));
    } catch (e) {
      skipped.push({ unit: a.id, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (o.scene === undefined) break; // default: one shot
  }
  if (items.length === 0) throw new MotionError(`No ready clip could be made: ${skipped.map((x) => `${x.unit}: ${x.reason}`).join(' ')}`);
  const built = new Set(items.map((i) => i.unit));
  const chosen = candidates.filter((a) => built.has(a.id));
  const units = chosen.map((a) => a.id);
  // Only notes for the clips that were built.
  const keptNotes = notes.filter((n) => units.some((u) => n.startsWith(`${u}:`)));
  if (!audio) keptNotes.push('Sound is off: the clip is silent. Sound is made in the sound stage; say if you want the model to make it (it costs more).');

  const unitSeconds = Object.fromEntries(units.map((u) => [u, seconds[u] as number]));
  const job: Job = {
    id: motionJobId(p, { units, provider: o.provider, model: model ?? '', seconds: unitSeconds, audio }),
    stage: MOTION_STAGE,
    kind: 'video',
    provider: o.provider,
    ...(model !== undefined ? { model } : {}),
    label: labelFor(config, o.provider, model, chosen, unitSeconds),
    items,
  };
  return { job, units, skipped, notes: keptNotes };
}

/** The job label the spend line shows: the per-second arithmetic for each clip. */
function labelFor(config: AkukoProviderConfig, provider: string, model: string | undefined, chosen: Asset[], seconds: Record<string, number>): string {
  const shots = chosen.map((a) => a.owner).join(', ');
  const head = `Clips: ${plural(chosen.length, 'shot')} (${shots})`;
  if (provider === MANUAL_PROVIDER_ID) return head;
  const price = priceFor(config, provider, model);
  if (price.per !== 'second') return head;
  const parts = chosen.map((a) => `${a.owner} ${seconds[a.id]} s x ${money(price.amount)} ${price.currency}/s = ${money((seconds[a.id] as number) * price.amount)}`);
  return `${head}: ${parts.join('; ')}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Status moves an action may make
// ─────────────────────────────────────────────────────────────────────────

/**
 * Before a run: `pending → draft`. A clip a person sent back (`needs-rework`)
 * becomes `draft` with its old file cleared so the new take fills the same
 * asset; the old file stays where it was stored and the "Revised:" comment
 * says where.
 */
export function beginUnits(project: AkukoProject, ids: string[], ts: string): AkukoProject {
  const p = structuredClone(project);
  for (const id of ids) {
    const a = p.assets.find((x) => x.id === id);
    if (!a) throw new MotionError(`unknown asset "${id}"`);
    if (a.status === 'pending') {
      a.status = 'draft';
    } else if (a.status === 'needs-rework') {
      const prev = a.file?.uri;
      delete a.file;
      a.status = 'draft';
      a.comments.push({ ts, stage: MOTION_STAGE, author: 'agent', text: `Revised: regenerating after the requested changes${prev ? `; the previous take stays at ${prev}` : ''}` });
    } else {
      continue;
    }
    a.by_stage = { ...(a.by_stage ?? {}), [MOTION_STAGE]: { status: 'draft' } };
    a.updated_at = ts;
  }
  return p;
}

/** A run was not accepted: put units `beginUnits` just moved back exactly as they were. */
export function abandonUnits(current: AkukoProject, before: AkukoProject, ids: string[]): AkukoProject {
  const p = structuredClone(current);
  for (const id of ids) {
    const i = p.assets.findIndex((x) => x.id === id);
    const old = before.assets.find((x) => x.id === id);
    const now = p.assets[i];
    if (i >= 0 && old && now && now.status === 'draft' && !hasFile(now)) p.assets[i] = structuredClone(old);
  }
  return p;
}

/**
 * A clip that is `approved` or `pending-review` must have a file. If one has
 * none (an undo restored a status after a revision cleared the file), set it
 * back to `pending`. Allowed only because no clip exists. Never writes `approved`.
 */
export function repairFileless(project: AkukoProject, ts: string): { project: AkukoProject; repaired: string[] } {
  const p = structuredClone(project);
  const repaired: string[] = [];
  for (const a of clipAssets(p)) {
    if ((a.status === 'approved' || a.status === 'pending-review') && !hasFile(a)) {
      a.status = 'pending';
      a.by_stage = { ...(a.by_stage ?? {}), [MOTION_STAGE]: { status: 'pending' } };
      a.comments.push({ ts, stage: MOTION_STAGE, author: 'agent', text: 'Revised: restored without a clip; needs generating' });
      a.updated_at = ts;
      repaired.push(a.id);
    }
  }
  return { project: p, repaired };
}

/** Keep `stages.motion.state` honest after the units moved. Never touches `locked`, and never sets `approved`. */
export function refreshStageState(project: AkukoProject): AkukoProject {
  const rec = project.stages.motion;
  if (rec.state === 'locked') return project;
  const units = clipAssets(project);
  if (units.length === 0) return project;
  if (rec.state === 'approved' && units.every(approvedWithFile)) return project;
  const todo = units.filter((a) => a.status === 'pending' || a.status === 'draft' || a.status === 'needs-rework');
  let state: typeof rec.state;
  if (todo.length > 0) {
    const ids = new Set(todo.map((a) => a.id));
    const waiting = project.pending_spend.some((j) => j.stage === MOTION_STAGE && j.status === 'awaiting-approval' && j.units.some((u) => ids.has(u)));
    state = waiting ? 'waiting-spend' : 'in-progress';
  } else {
    state = 'in-review';
  }
  if (state === rec.state) return project;
  return { ...project, stages: { ...project.stages, motion: { state } } };
}
