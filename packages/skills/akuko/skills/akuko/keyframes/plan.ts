/**
 * akuko — key-frame stage (stage 4): planning, readiness, jobs (WP-22).
 *
 * Review unit: one planned **asset** per shot (`<shot>_keyframe`, kind
 * `keyframe`, stage `keyframes`, owner = the shot). Why an asset and not the
 * shot itself (the sketch board's choice): the providers and the manual
 * `ingest()` record a finished image as an asset unit that moves to
 * `pending-review`. If the shot were the unit as well, one key frame would be
 * two units needing two approvals, and the shot would also leave stage
 * `sketch` (where its approval lives). With the asset as the unit the shot
 * stays approved at `sketch`, the asset is filled in place, and decision
 * folding approves the stage when every key frame is approved.
 *
 *   planKeyframes()   create the planned assets (idempotent)
 *   unitReadiness()   ready / blocked / in flight / in review / approved
 *   buildKeyframeJob() one gate-ready Job (default: the next shot)
 *   beginUnits() / abandonUnits() / repairFileless() / refreshStageState()
 *   stampRefs()       record which reference files (and layout) a take was made from
 *   layoutState()     whether a take was made from the shot's current layout
 *   layoutStepPlan() / parkLayoutSteps()   a key frame made from a layout, in steps
 *
 * Nothing here calls a provider, writes `approved`, or writes the project:
 * every function returns a new project for the caller to write via the host.
 */

import { createHash } from 'node:crypto';
import { STAGES, type AkukoProject, type Asset, type BibleEntry, type LayoutStep, type Shot } from '../schema/akuko-project.ts';
import { jobTag } from '../providers/outputs.ts';
import type { Job, JobItem, JobRef, JobStep } from '../providers/contract.ts';
import { BibleError, LOOKBOOK_NOTE, MAX_REFS, bibleAssets, mergeNegative, projectNegative, requestedChanges, roleOf, type BibleRole } from '../bible/plan.ts';
import { removedAt } from '../decisions/fold.ts';
import { identityPrompt, keyframePrompt, restylePrompt, type KeyframeContext } from './prompts.ts';

export { MAX_REFS };

export const KEYFRAME_STAGE = 'keyframes' as const;
/** Tag every planned key-frame asset carries. */
export const KEYFRAME_TAG = 'keyframe';

export class KeyframeError extends BibleError {
  override name = 'KeyframeError';
}

export const assetIdFor = (shotId: string): string => `${shotId}_keyframe`;
export const isKeyframe = (a: Asset): boolean => a.stage === KEYFRAME_STAGE && a.tags.includes(KEYFRAME_TAG);
export const keyframeAssets = (p: AkukoProject): Asset[] => p.assets.filter(isKeyframe);
/** Key frames still part of the film: those of a shot removed from the sheet are kept for the record and left out (WP-27). */
const liveKeyframes = (p: AkukoProject): Asset[] => keyframeAssets(p).filter((a) => removedAt(p, a) === undefined);

const hasFile = (a: Asset): boolean => a.file !== undefined;
const approvedWithFile = (a: Asset): boolean => a.status === 'approved' && hasFile(a);

// ─────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────

/**
 * Refuse unless the key-frame stage is open: the gating rule (lib/state.md
 * §Stages) is that every earlier stage is approved (intake, breakdown, sketch
 * and bible). Every shot must also be approved.
 */
export function assertOpen(p: AkukoProject): void {
  for (const { id } of STAGES) {
    if (id === KEYFRAME_STAGE) break;
    if (p.stages[id].state !== 'approved') {
      throw new KeyframeError(`The key-frame stage is locked: ${id} is "${p.stages[id].state}". It opens when a person has approved every earlier stage (breakdown, the sketch board, then the bible).`);
    }
  }
  const open = p.shots.filter((s) => s.status !== 'approved' && removedAt(p, s) === undefined);
  if (open.length > 0) throw new KeyframeError(`These shots are not approved yet: ${open.map((s) => s.id).join(', ')}.`);
  if (p.stages.keyframes.state === 'locked') throw new KeyframeError('The key-frame stage is still locked; fold the latest decisions first.');
}

export interface PlanResult { project: AkukoProject; created: string[] }

/** Create the planned asset for every shot that has none. Safe to run again. */
export function planKeyframes(project: AkukoProject, now: string): PlanResult {
  assertOpen(project);
  const p = structuredClone(project);
  const created: string[] = [];
  for (const shot of p.shots) {
    if (removedAt(p, shot) !== undefined) continue;
    const id = assetIdFor(shot.id);
    if (p.assets.some((a) => a.id === id)) continue;
    p.assets.push({
      id,
      stage: KEYFRAME_STAGE,
      status: 'pending',
      comments: [],
      kind: 'keyframe',
      owner: shot.id,
      name: `${shot.id} - key frame`,
      tags: [KEYFRAME_TAG],
      updated_at: now,
    });
    created.push(id);
  }
  if (created.length > 0 && p.stages.keyframes.state === 'not-started') p.stages.keyframes = { state: 'in-progress' };
  return { project: p, created };
}

// ─────────────────────────────────────────────────────────────────────────
// References: which bible images a shot is made from
// ─────────────────────────────────────────────────────────────────────────

type EntryKind = 'character' | 'location' | 'style';
interface EntryAt { kind: EntryKind; entry: BibleEntry }

/** One reference a shot needs: the bible asset, its role in the prompt, and whether the entry lists it in `refs[]`. */
export interface NeededRef { asset: Asset; entry: BibleEntry; kind: EntryKind; synced: boolean }

function entriesOf(p: AkukoProject, shot: Shot): EntryAt[] {
  const all: EntryAt[] = [
    ...p.bible.characters.map((entry) => ({ kind: 'character' as const, entry })),
    ...p.bible.locations.map((entry) => ({ kind: 'location' as const, entry })),
    ...p.bible.styles.map((entry) => ({ kind: 'style' as const, entry })),
  ];
  const named = all.filter((e) => shot.refs.includes(e.entry.id));
  // A shot that names no style gets the film's look: every style entry.
  const hasStyle = named.some((e) => e.kind === 'style');
  return hasStyle ? named : [...named, ...all.filter((e) => e.kind === 'style')];
}

const ROLE_ORDER: Record<EntryKind, number> = { character: 0, location: 1, style: 2 };

/**
 * The bible images a shot must be generated against: each character's
 * turnaround (their portrait if they have no turnaround), each location's
 * plate, and the lookbook. Taken from the entries' `refs[]` (what `syncRefs()`
 * set from approved images) with the asset itself checked too. An image that
 * is planned but not in `refs[]` still comes back, `synced: false`, so the
 * caller can say what is missing.
 *
 * A lookbook is attached only when a location plate is: a lookbook is a
 * picture of some place, and with no plate to say where the shot is, the model
 * paints the lookbook's room, objects and people into it. A shot with no plate
 * gets its look as text only (and so does not wait for the lookbook image).
 *
 * A shot with a layout in mode `two-step` is made in steps (`layoutStepPlan`):
 * the blockout is restyled from words alone, then each character is put on
 * model from their image. So it needs only the characters' images; its plate
 * and lookbook are not attached (with them the model copies the picture and
 * ignores the blockout) and it does not wait for them. In mode `attach` (the
 * default) and `off` it needs what a shot without a layout needs.
 */
export function neededRefs(p: AkukoProject, shot: Shot, mode: LayoutMode = layoutModeOf(shot)): NeededRef[] {
  const out = pickedRefs(p, shot);
  if (mode === 'two-step') return out.filter((r) => r.kind === 'character');
  return out.some((r) => r.kind === 'location') ? out : out.filter((r) => r.kind !== 'style');
}

/**
 * How a key frame uses its shot's layout (actions/keyframes.md §Layout modes):
 *   attach    the layout attached first with the other references; one generation (the default: what a layout always did)
 *   two-step  restyle the layout alone, then each character on model; 1 + characters generations
 *   off       the layout is ignored for this job
 */
export type LayoutMode = 'attach' | 'two-step' | 'off';
export const LAYOUT_MODES: readonly LayoutMode[] = ['attach', 'two-step', 'off'];
/** The mode a shot's key frame uses: the job's `--layout-mode`, else the shot's `layout.mode`, else attach (only meaningful when it has a layout). */
export function layoutModeOf(shot: Shot, override?: LayoutMode): LayoutMode {
  return override ?? shot.layout?.mode ?? 'attach';
}
/** Generations one take of the shot's key frame costs in `mode`. */
export function layoutGenerations(p: AkukoProject, shot: Shot, mode: LayoutMode = layoutModeOf(shot)): number {
  return shot.layout && mode === 'two-step' ? layoutStepPlan(p, shot).length : 1;
}

function pickedRefs(p: AkukoProject, shot: Shot): NeededRef[] {
  const out: NeededRef[] = [];
  const mine = bibleAssets(p);
  for (const { kind, entry } of entriesOf(p, shot)) {
    const owned = mine.filter((a) => a.owner === entry.id);
    const byRole = (r: BibleRole): Asset | undefined => owned.find((a) => roleOf(a) === r);
    const pick = kind === 'character' ? byRole('turnaround') ?? byRole('portrait') : kind === 'location' ? byRole('plate') : byRole('lookbook');
    if (pick) out.push({ asset: pick, entry, kind, synced: entry.refs.includes(pick.id) });
  }
  return out.sort((a, b) => ROLE_ORDER[a.kind] - ROLE_ORDER[b.kind]);
}

/** The style entries a shot is made in: those its `refs[]` names, or every style entry when it names none. */
export const shotStyles = (p: AkukoProject, shot: Shot): BibleEntry[] => entriesOf(p, shot).filter((e) => e.kind === 'style').map((e) => e.entry);

/**
 * The key frame a shot is a picture of (`shot.source_frame`), when it has one:
 * the asset, or why it cannot be used. A chain is fine (C shows B which shows
 * A); a loop never becomes ready.
 */
export function sourceFrameOf(p: AkukoProject, shot: Shot): { shot: string; asset?: Asset; problem?: string } | undefined {
  const id = shot.source_frame;
  if (id === undefined) return undefined;
  const src = p.shots.find((s) => s.id === id);
  if (!src || removedAt(p, src) !== undefined) return { shot: id, problem: `${id} (source frame: no such shot)` };
  // Follow the chain from the source; coming back to a shot already seen is a loop.
  const seen = new Set([shot.id, src.id]);
  for (let next = src.source_frame; next !== undefined; next = p.shots.find((s) => s.id === next)?.source_frame) {
    if (seen.has(next)) return { shot: id, problem: `${id} (source frames loop back to ${next})` };
    seen.add(next);
  }
  const asset = p.assets.find((a) => a.id === assetIdFor(id) && isKeyframe(a));
  return asset ? { shot: id, asset } : { shot: id, problem: `${assetIdFor(id)} (source frame not planned)` };
}

// ─────────────────────────────────────────────────────────────────────────
// Layout: a 3D-blockout render that fixes positions (shot.layout)
// ─────────────────────────────────────────────────────────────────────────

/** The id a shot's layout goes by in a job's refs (it is not an asset). */
export const layoutRefId = (shotId: string): string => `${shotId}_layout`;
/** Stamp on a take made from a layout: `layout:<first 16 hex of its sha256>`. */
const LAYOUT_STAMP = 'layout:';
/** The short form of a layout's sha256 that stamps and recorded steps carry. */
export const layoutKey = (sha256: string): string => sha256.slice(0, 16);
const layoutStamp = (sha256: string): string => `${LAYOUT_STAMP}${layoutKey(sha256)}`;

/** The layout's note in mode two-step (step 1, where it is the only picture). */
export const LAYOUT_NOTE = "a plain untextured 3D blockout render from this shot's camera, the only picture for this step: restyle it into the finished frame, keeping the camera, the composition and the position and size of every wall, object and figure exactly";
/** The layout's note in mode attach (attached first with the other references). */
export const LAYOUT_ATTACH_NOTE = "a plain untextured 3D blockout render from this shot's camera: keep the camera angle, the composition and the position and size of every object and figure exactly; take no colour, material, lighting or style from it; its grey or blue box figures are stand-ins for the named characters";
/** Stamp on a take made in mode two-step. */
const TWO_STEP_STAMP = 'layout-mode:two-step';
/** Whether a take was made from its layout in two steps (its stamp), for the audit. */
export const madeInSteps = (a: Asset): boolean => a.tags.includes(TWO_STEP_STAMP);

/** One generation of a key frame made from its layout: restyle the blockout, or put one character on model. */
export interface LayoutStepPlan {
  step: 'restyle' | 'identity';
  /** identity: the character and the image it is put on model from (turnaround, portrait if none). */
  character?: NeededRef;
  /** Short name for people: `restyle`, `identity MARA`. */
  name: string;
}

/**
 * The steps a shot's key frame is made in when it has a layout: step 1
 * restyles the blockout (the layout is its only picture), then one step per
 * character in frame with an approved image (turnaround, portrait if none),
 * each an edit of the step before with that character's image. No character
 * image: the restyle is the take. Empty without a layout.
 */
export function layoutStepPlan(p: AkukoProject, shot: Shot): LayoutStepPlan[] {
  if (!shot.layout) return [];
  const chars = neededRefs(p, shot, 'two-step');
  return [{ step: 'restyle', name: 'restyle' }, ...chars.map((n) => ({ step: 'identity' as const, character: n, name: `identity ${n.entry.name}` }))];
}

/** The job id of step `i` (0-based) of `total` for a take whose job id is `base`: the last step is `base` itself, the earlier ones `<base>_s<i+1>`. */
export const layoutStepJobId = (base: string, i: number, total: number): string => (i === total - 1 ? base : `${base}_s${i + 1}`);
const STEP_JOB = /^(.+)_s(\d+)$/;
/** The id a recorded earlier step goes by in a job's refs (not an asset): `<key frame>_step<n>`, 1-based. */
export const layoutStepRefId = (assetId: string, n: number): string => `${assetId}_step${n}`;

/** How many steps of the take `base` are already made and recorded on `a` (they must be the first ones, in order, from the current layout). */
export function layoutStepsDone(p: AkukoProject, a: Asset, base: string, total: number): number {
  const shot = p.shots.find((s) => s.id === a.owner);
  if (!shot?.layout) return 0;
  const key = layoutKey(shot.layout.sha256);
  const rec = a.layout_steps ?? [];
  let n = 0;
  while (n < total - 1 && rec[n] !== undefined && rec[n]!.layout === key && rec[n]!.job === layoutStepJobId(base, n, total)) n++;
  return n;
}

/**
 * After a paid step job before the last was collected, the gate has filled the
 * key frame with that step's file and moved it to review. It is not a take:
 * record it in `layout_steps`, clear the file and put the key frame back to
 * `draft`, so the next step can run and nobody is asked to review it. A step
 * is recognised by its job tag `job:<base>_s<n>` on a key frame that has no
 * `job:<base>` tag yet (the last step's). Safe to run again; never writes `approved`.
 */
export function parkLayoutSteps(project: AkukoProject, ts: string): { project: AkukoProject; parked: string[] } {
  let p = project;
  const parked: string[] = [];
  for (const a of liveKeyframes(project)) {
    if (!a.file) continue;
    const inProgress = new Map<string, number>();
    for (const t of a.tags) {
      if (!t.startsWith('job:')) continue;
      const m = STEP_JOB.exec(t.slice(4));
      if (!m || a.tags.includes(jobTag(m[1]!))) continue;
      inProgress.set(m[1]!, Math.max(inProgress.get(m[1]!) ?? 0, Number(m[2])));
    }
    for (const [base, n] of inProgress) {
      const job = `${base}_s${n}`;
      if ((a.layout_steps ?? []).some((s) => s.job === job)) continue;
      const shot = p.shots.find((s) => s.id === a.owner);
      const made = a.tags.find((t) => t.startsWith(LAYOUT_STAMP))?.slice(LAYOUT_STAMP.length) ?? (shot?.layout ? layoutKey(shot.layout.sha256) : undefined);
      if (!made || !/^[0-9a-f]{16}$/.test(made)) continue;
      const plan = shot ? layoutStepPlan(p, shot)[n - 1] : undefined;
      const step: LayoutStep = {
        step: plan?.step ?? (n === 1 ? 'restyle' : 'identity'),
        ...(plan?.character ? { for: plan.character.entry.id } : {}),
        uri: a.file.uri,
        ...(a.file.hash !== undefined ? { hash: a.file.hash } : {}),
        job,
        layout: made,
        at: ts,
      };
      p = structuredClone(p);
      const x = p.assets.find((y) => y.id === a.id)!;
      // Keep the steps of this take that come before it; anything else is from an earlier take or layout.
      const keep = (x.layout_steps ?? []).filter((s, i) => i < n - 1 && s.job === `${base}_s${i + 1}`);
      x.layout_steps = [...keep, step];
      delete x.file;
      x.status = 'draft';
      x.by_stage = { ...(x.by_stage ?? {}), [KEYFRAME_STAGE]: { status: 'draft' } };
      x.updated_at = ts;
      parked.push(`${a.id} step ${n}`);
      break;
    }
  }
  return { project: p, parked };
}

/** Where a key frame made from its layout stands, for `status`: how many steps are recorded for the current layout, and how many it takes. */
export function layoutProgress(p: AkukoProject, a: Asset): { mode: LayoutMode; done: number; total: number; names: string[] } | undefined {
  const shot = p.shots.find((s) => s.id === a.owner);
  if (!shot?.layout) return undefined;
  const mode = layoutModeOf(shot);
  if (mode !== 'two-step') return { mode, done: 0, total: 1, names: [] };
  const plan = layoutStepPlan(p, shot);
  const key = layoutKey(shot.layout.sha256);
  const rec = (a.layout_steps ?? []).filter((s) => s.layout === key);
  return { mode, done: Math.min(rec.length, plan.length - 1), total: plan.length, names: plan.map((s) => s.name) };
}

/**
 * Whether a key frame's take was made from its shot's layout:
 *   none      the shot has no layout and the take was made without one
 *   pending   the shot has a layout and there is no take to judge yet (the next take uses it)
 *   used      the take was made from the current layout
 *   not-used  the take was made without a layout; the shot has one now
 *   changed   the take was made from a layout that has since been replaced or removed
 * Reporting only, like superseded references: a person alone sends a frame back.
 */
export type LayoutState = 'none' | 'pending' | 'used' | 'not-used' | 'changed';

export function layoutState(p: AkukoProject, a: Asset): LayoutState {
  const shot = p.shots.find((s) => s.id === a.owner);
  const want = shot?.layout ? layoutStamp(shot.layout.sha256) : undefined;
  const made = a.tags.find((t) => t.startsWith(LAYOUT_STAMP));
  const judged = hasFile(a) && a.status !== 'needs-rework' && a.status !== 'draft';
  if (!judged) return want ? 'pending' : 'none';
  if (made === undefined) return want ? 'not-used' : 'none';
  return made === want ? 'used' : 'changed';
}

/** Ids a key frame is waiting for: bible images not approved with a file, or not yet in the entry's `refs[]`, and its source frame until a person approved it. */
function waitingFor(p: AkukoProject, shot: Shot): string[] {
  const out = neededRefs(p, shot).filter((r) => !approvedWithFile(r.asset) || !r.synced).map((r) => r.asset.id);
  const src = sourceFrameOf(p, shot);
  if (src?.problem) out.push(src.problem);
  else if (src?.asset && !approvedWithFile(src.asset)) out.push(src.asset.id);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Readiness
// ─────────────────────────────────────────────────────────────────────────

export type ReadinessState = 'approved' | 'in-review' | 'in-flight' | 'ready' | 'blocked';
export interface Readiness { state: ReadinessState; waiting: string[] }

const shotOf = (p: AkukoProject, a: Asset): Shot => {
  const s = p.shots.find((x) => x.id === a.owner);
  if (!s) throw new KeyframeError(`key frame "${a.id}" has no shot; plan the key frames again.`);
  return s;
};

// A host-A reservation not yet sent (`reserved`) is not in flight: the send phase must pick the same unit.
const inFlight = (p: AkukoProject, a: Asset): boolean => p.ledger.some((e) => e.unit === a.id && e.status === 'submitted' && e.reserved !== true);

export function unitReadiness(p: AkukoProject, a: Asset): Readiness {
  if (approvedWithFile(a)) return { state: 'approved', waiting: [] };
  if (hasFile(a) && a.status === 'pending-review') return { state: 'in-review', waiting: [] };
  if (inFlight(p, a)) return { state: 'in-flight', waiting: [] };
  const waiting = waitingFor(p, shotOf(p, a));
  if (waiting.length > 0) return { state: 'blocked', waiting };
  return { state: 'ready', waiting: [] };
}

export interface StatusRow {
  shot: string;
  asset: string;
  status: Asset['status'];
  state: ReadinessState;
  waiting: string[];
  /** References this take was made from that have since been sent back or replaced (`<shot>_layout` for a changed layout). */
  superseded: string[];
  layout: LayoutState;
}

/** Short fingerprint of a file; identical to the bible stage's, so its stamps and ours agree. */
const hash8 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);
const fingerprint = (a: Asset): string => hash8(`${a.file?.uri ?? ''}|${a.file?.hash ?? ''}`);
const FROM = 'from:';

/**
 * Ids of the bible images a produced key frame was made from that are no
 * longer what it was made from: sent back, no longer approved, or replaced.
 * Reporting only; a person alone sends a key frame back.
 */
export function supersededRefs(p: AkukoProject, a: Asset): string[] {
  if (!hasFile(a) || a.status === 'needs-rework' || a.status === 'draft') return [];
  const out: string[] = [];
  for (const t of a.tags) {
    const m = /^from:(.+)@([0-9a-f]{8})$/.exec(t);
    if (!m) continue;
    const dep = p.assets.find((x) => x.id === m[1]);
    if (!dep || !approvedWithFile(dep) || fingerprint(dep) !== m[2]) out.push(m[1]!);
  }
  if (layoutState(p, a) === 'changed') out.push(layoutRefId(a.owner ?? ''));
  return out;
}

export function keyframeStatus(p: AkukoProject): StatusRow[] {
  return liveKeyframes(p).map((a) => {
    const r = unitReadiness(p, a);
    return { shot: a.owner ?? '', asset: a.id, status: a.status, state: r.state, waiting: r.waiting, superseded: supersededRefs(p, a), layout: layoutState(p, a) };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────

/** A job has run once any output carries its tag or any ledger entry is in flight or done. */
export function jobRan(p: AkukoProject, id: string): boolean {
  // A host-A reservation not yet sent (`reserved`) has not run: the send phase must build the same job id.
  return p.ledger.some((e) => e.job === id && ((e.status === 'submitted' && e.reserved !== true) || e.status === 'done')) || p.assets.some((a) => a.tags.includes(jobTag(id)));
}

/** Deterministic id: `job_kf_<hash of units + provider + model>_r<n>`. A regeneration after a send-back is the next `r<n>` with its own approval. */
export function keyframeJobId(p: AkukoProject, units: string[], provider = '', model = '', layout = ''): string {
  // Provider and model are part of the id: a person's approval binds to one provider and model, so changing either is a new job with a fresh approval.
  // A key frame made from a layout also hashes the layout's key, so a new layout starts its steps afresh.
  const base = `job_kf_${hash8([[...units].sort().join('|'), provider, model, ...(layout ? [layout] : [])].join('#'))}`;
  let n = 1;
  while (jobRan(p, `${base}_r${n}`)) n++;
  return `${base}_r${n}`;
}

export interface BuildOptions {
  provider: string;
  model?: string;
  /** Key-frame asset ids to generate. Default: the next ready shot, alone. */
  units?: string[];
  /** Generate every ready key frame of this scene in one job. */
  scene?: string;
  /** How a shot's layout is used in this job; default each shot's `layout.mode`, else attach. */
  layoutMode?: LayoutMode;
}

/** A ready key frame that could not be built, and why. */
export interface Skipped { unit: string; reason: string }
/** A key frame made from its layout by a paid provider: one job per step, run in order (`keyframes/run.ts`). */
export interface LayoutChain {
  unit: string;
  /** The take's job id: the last step's. */
  base: string;
  total: number;
  /** Steps already made and recorded on the key frame. */
  done: number;
  /** The steps still to run, the next first. A later identity step has no ref to the earlier step's file yet (it does not exist); it is priced without it and rebuilt when its turn comes. */
  steps: Array<{ index: number; name: string; job: Job }>;
}
export interface BuiltJob { job: Job; units: string[]; refs: Record<string, string[]>; skipped: Skipped[]; chain?: LayoutChain }

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

const REF_NOTE: Record<EntryKind, (name: string, role: BibleRole) => string> = {
  character: (name, role) => role === 'turnaround'
    ? `the approved turnaround sheet of ${name}: keep face, hair, build and clothing exactly; ignore the sheet's layout and labels`
    : `the approved portrait of ${name}: keep face, hair, build and clothing exactly`,
  location: (name) => `the approved plate of ${name}: keep the place, its layout and props`,
  style: () => LOOKBOOK_NOTE,
};

/**
 * Build one job. It never submits anything: hand the result to `gate.run()`.
 * By default one shot, the next one that is ready, so each approval binds to
 * the amount for that one frame. Refuses a key frame whose references are not
 * approved with a file. The sketch panel is an SVG, which neither image
 * provider accepts as a reference, so the composition goes in as text (see
 * `blockingText`) and no sketch file is attached.
 */
export function buildKeyframeJob(p: AkukoProject, o: BuildOptions): BuiltJob {
  assertOpen(p);
  const all = liveKeyframes(p);
  const byId = new Map(all.map((a) => [a.id, a]));
  let chosen: Asset[];
  if (o.units) {
    chosen = o.units.map((id) => {
      const a = byId.get(id);
      if (!a) throw new KeyframeError(`"${id}" is not a planned key frame; run plan first.`);
      const r = unitReadiness(p, a);
      if (r.state !== 'ready') throw new KeyframeError(`${id} cannot be generated now (${r.state}${r.waiting.length ? `; its bible references are not approved: ${r.waiting.join(', ')}` : ''}).`);
      return a;
    });
  } else {
    const ready = all.filter((a) => unitReadiness(p, a).state === 'ready' && (o.scene === undefined || shotOf(p, a).scene === o.scene));
    chosen = ready; // the loop below stops after the first buildable one unless a scene was asked for
  }
  if (chosen.length === 0) {
    const stuck = keyframeStatus(p).filter((r) => r.state === 'blocked').map((r) => `${r.asset} (waiting for ${r.waiting.join(', ')})`);
    throw new KeyframeError(stuck.length ? `Nothing can be generated yet: ${stuck.join('; ')}.` : 'Nothing is waiting to be generated.');
  }
  if (new Set(chosen.map((a) => a.id)).size !== chosen.length) throw new KeyframeError('a unit was listed twice');

  const filmNegative = projectNegative(p);
  const refsOut: Record<string, string[]> = {};
  const contextOf = (shot: Shot, needed: NeededRef[], src?: { shot: string; asset?: Asset }): KeyframeContext => {
    const scene = p.scenes.find((s) => s.id === shot.scene);
    const named = entriesOf(p, shot);
    return {
      shot,
      aspect: p.project.aspect_ratio,
      scene: scene ? [scene.heading, scene.summary].filter(Boolean).join(' - ') : '',
      styles: shotStyles(p, shot),
      lookbook: needed.some((n) => n.kind === 'style'),
      ...(src?.asset ? { source: src.shot } : {}),
      characters: needed.filter((n) => n.kind === 'character').map((n) => n.entry),
      // With a layout the plate is not attached, but the place is still described in words.
      location: needed.find((n) => n.kind === 'location')?.entry ?? (shot.layout ? named.find((e) => e.kind === 'location')?.entry : undefined),
      unreferenced: named.filter((e) => e.kind === 'character' && !needed.some((n) => n.entry.id === e.entry.id)).map((e) => e.entry),
    };
  };
  const askedOf = (a: Asset): string => {
    const changes = requestedChanges(a);
    return (a.status === 'needs-rework' || a.status === 'draft') && changes !== '' ? changes : '';
  };
  const charRef = (n: NeededRef): JobRef => ({ id: n.asset.id, uri: n.asset.file!.uri, role: n.kind, note: REF_NOTE[n.kind](n.entry.name, roleOf(n.asset)) });

  /** The generations of a key frame made from its layout (see `layoutStepPlan`), as job steps. `prev(i)` is the ref to step i's result (1-based), when it exists. */
  const layoutSteps = (a: Asset, prev: (i: number) => JobRef | undefined): JobStep[] => {
    const shot = shotOf(p, a);
    const plan = layoutStepPlan(p, shot);
    const ctx = contextOf(shot, neededRefs(p, shot, 'two-step'));
    const asked = askedOf(a);
    const negative = mergeNegative(shot.negative, filmNegative);
    return plan.map((s, i): JobStep => {
      if (s.step === 'restyle') {
        return { name: s.name, prompt: restylePrompt(ctx, asked), refs: [{ id: layoutRefId(shot.id), uri: shot.layout!.uri, role: 'layout', note: LAYOUT_NOTE }], ...(negative ? { negative } : {}), ...(shot.seed !== undefined ? { seed: shot.seed } : {}) };
      }
      const n = s.character!;
      const before = prev(i) ?? { id: layoutStepRefId(a.id, i), role: 'previous-step', note: `the result of step ${i} (${plan[i - 1]!.name}): keep it exactly; this step changes only ${n.entry.name}` };
      return {
        name: s.name,
        prompt: identityPrompt({ shot, name: n.entry.name, image: roleOf(n.asset) === 'turnaround' ? 'turnaround' : 'portrait', alone: plan.length === 2, asked }),
        refs: [before, charRef(n)],
        ...(negative ? { negative } : {}),
      };
    });
  };
  const recordedRef = (a: Asset, i: number): JobRef | undefined => {
    const r = a.layout_steps?.[i - 1];
    return r ? { id: layoutStepRefId(a.id, i), uri: r.uri, role: 'previous-step', note: `the result of step ${i} (${r.step}${r.for ? ` ${r.for}` : ''}): keep everything in it exactly` } : undefined;
  };
  const itemOf = (a: Asset, s: JobStep): JobItem => ({
    unit: a.id,
    prompt: s.prompt,
    output: 'keyframe',
    aspect_ratio: p.project.aspect_ratio,
    count: 1,
    ...(s.negative ? { negative: s.negative } : {}),
    ...(s.seed !== undefined ? { seed: s.seed } : {}),
    ...(s.refs?.length ? { refs: s.refs } : {}),
  });
  /** Manual provider: one item that carries every step, for the person to run in order. */
  const manualLayoutItem = (a: Asset): JobItem => {
    const steps = layoutSteps(a, () => undefined);
    const all = steps.flatMap((s) => s.refs ?? []).filter((r) => r.uri !== undefined);
    refsOut[a.id] = all.map((r) => r.id);
    return { ...itemOf(a, steps[0]!), ...(all.length ? { refs: all } : {}), ...(steps.length > 1 ? { steps } : {}) };
  };
  let chain: LayoutChain | undefined;
  const layoutChain = (a: Asset): JobItem => {
    const shot = shotOf(p, a);
    const plan = layoutStepPlan(p, shot);
    const total = plan.length;
    const base = keyframeJobId(p, [a.id], o.provider, o.model ?? '', layoutKey(shot.layout!.sha256));
    const done = layoutStepsDone(p, a, base, total);
    const steps = layoutSteps(a, (i) => (i <= done ? recordedRef(a, i) : undefined));
    const out: LayoutChain['steps'] = [];
    for (let i = done; i < total; i++) {
      const s = steps[i]!;
      // A later step's earlier-step ref does not exist yet: price it without that ref; it is rebuilt when it runs.
      const item = i === done ? itemOf(a, s) : itemOf(a, { ...s, refs: (s.refs ?? []).filter((r) => r.uri !== undefined) });
      out.push({ index: i, name: s.name, job: {
        id: layoutStepJobId(base, i, total),
        stage: KEYFRAME_STAGE,
        kind: 'image',
        provider: o.provider,
        ...(o.model !== undefined ? { model: o.model } : {}),
        label: `Key frames: 1 shot (${shot.id}), step ${i + 1} of ${total} from its layout: ${s.name}`,
        items: [item],
      } });
    }
    chain = { unit: a.id, base, total, done, steps: out };
    refsOut[a.id] = (out[0]!.job.items[0]!.refs ?? []).map((r) => r.id);
    return out[0]!.job.items[0]!;
  };
  const isManual = o.provider === 'manual';
  const modeOf = (a: Asset): LayoutMode | undefined => { const s = shotOf(p, a); return s.layout ? layoutModeOf(s, o.layoutMode) : undefined; };
  const buildItem = (a: Asset): JobItem => {
    const shot = shotOf(p, a);
    const mode = modeOf(a);
    if (mode === 'two-step') return isManual ? manualLayoutItem(a) : layoutChain(a);
    const needed = neededRefs(p, shot, mode ?? 'attach');
    // A --layout-mode that differs from the shot's own can need an image readiness did not wait for.
    const unready = needed.filter((n) => !approvedWithFile(n.asset));
    if (unready.length) throw new KeyframeError(`${a.id} in layout mode ${mode} needs ${unready.map((n) => n.asset.id).join(', ')}, which ${unready.length === 1 ? 'is' : 'are'} not approved with a file yet.`);
    // Mode attach: the layout goes first; it fixes where everything is, and every image after it is for identity and look.
    const attach = mode === 'attach';
    const layoutRef: JobRef[] = attach ? [{ id: layoutRefId(shot.id), uri: shot.layout!.uri, role: 'layout', note: LAYOUT_ATTACH_NOTE }] : [];
    const refs: JobRef[] = [...layoutRef, ...needed.map((n) => ({
      id: n.asset.id,
      uri: n.asset.file!.uri,
      role: n.kind,
      note: attach && n.kind === 'location' ? `${REF_NOTE.location(n.entry.name, roleOf(n.asset))}; with a layout attached, for the look of the place only (surfaces, materials, colour, light): where things are comes from the layout` : REF_NOTE[n.kind](n.entry.name, roleOf(n.asset)),
    }))];
    // The key frame this shot is a picture of (readiness has checked it is approved with a file).
    const src = sourceFrameOf(p, shot);
    if (src?.asset?.file) refs.push({ id: src.asset.id, uri: src.asset.file.uri, role: 'frame', note: `the approved key frame of shot ${src.shot}: this shot shows that same picture; keep its people, clothes, colours and composition` });
    // Pictures the person supplied for this shot.
    for (const x of p.assets) {
      if (x.kind === 'reference' && x.owner === shot.id && hasFile(x)) refs.push({ id: x.id, uri: x.file!.uri, role: 'reference', note: 'supplied by the person' });
    }
    if (refs.length > MAX_REFS) {
      throw new KeyframeError(`${a.id} would send ${refs.length} reference images; the image providers accept at most ${MAX_REFS}. Remove some supplied references.`);
    }
    const ctx = { ...contextOf(shot, needed, src), ...(attach ? { layout: true } : {}) };
    const asked = askedOf(a);
    refsOut[a.id] = refs.map((r) => r.id);
    // The shot's own negative and the film's (the house style's "Negative prompt:"), so a term added to either reaches the frame.
    const negative = mergeNegative(shot.negative, filmNegative);
    return {
      unit: a.id,
      prompt: keyframePrompt(ctx, asked),
      output: 'keyframe',
      aspect_ratio: p.project.aspect_ratio,
      count: 1,
      ...(negative ? { negative } : {}),
      ...(shot.seed !== undefined ? { seed: shot.seed } : {}),
      ...(refs.length ? { refs } : {}),
    };
  };

  // Explicit units: the person named them, so an unbuildable one is an error. Otherwise a frame that
  // cannot be built is skipped and reported, and the next ready frame is tried (a batch builds what it can).
  // A key frame made from its layout by a paid provider runs in steps, one job each, so it is always a job of its own.
  const stepped = (a: Asset): boolean => !isManual && modeOf(a) === 'two-step';
  if (o.units && chosen.length > 1 && chosen.some(stepped)) {
    throw new KeyframeError(`${chosen.filter(stepped).map((a) => a.id).join(', ')} ${chosen.filter(stepped).length === 1 ? 'is' : 'are'} made from a layout in steps, one job each; generate ${chosen.filter(stepped).length === 1 ? 'it' : 'each'} on its own (--units <one id>).`);
  }
  const items: JobItem[] = [];
  const skipped: Skipped[] = [];
  for (const a of chosen) {
    if (o.units) { items.push(buildItem(a)); continue; }
    if (items.length > 0 && stepped(a)) {
      skipped.push({ unit: a.id, reason: `made from its layout in steps, so it runs as a job of its own; run step --units ${a.id}` });
      continue;
    }
    try {
      items.push(buildItem(a));
    } catch (e) {
      skipped.push({ unit: a.id, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (o.scene === undefined || stepped(a)) break; // default: one shot
  }
  if (items.length === 0) {
    throw new KeyframeError(`No ready key frame could be built: ${skipped.map((x) => `${x.unit}: ${x.reason}`).join(' ')}`);
  }
  const built = new Set(items.map((i) => i.unit));
  chosen = chosen.filter((a) => built.has(a.id));

  const units = chosen.map((a) => a.id);
  if (chain) return { job: chain.steps[0]!.job, units, refs: refsOut, skipped, chain };
  // One manual key frame made from its layout: its id carries the layout too, like the paid steps.
  const lay = isManual && chosen.length === 1 && modeOf(chosen[0]!) === 'two-step' ? shotOf(p, chosen[0]!).layout : undefined;
  // Say how each layout is used, and what it costs in generations, wherever the label is shown (the spend and allowance lines).
  const withLayout = chosen.filter((a) => modeOf(a) !== undefined);
  const gens = items.reduce((n, i) => n + (i.steps?.length ?? 1), 0);
  const layoutNote = withLayout.length
    ? `; layout ${[...new Set(withLayout.map((a) => modeOf(a)))].join('/')}${withLayout.length < chosen.length ? ` for ${withLayout.map((a) => a.owner).join(', ')}` : ''}, ${plural(gens, 'generation')}`
    : '';
  const job: Job = {
    id: keyframeJobId(p, units, o.provider, o.model ?? '', lay ? layoutKey(lay.sha256) : ''),
    stage: KEYFRAME_STAGE,
    kind: 'image',
    provider: o.provider,
    ...(o.model !== undefined ? { model: o.model } : {}),
    label: `Key frames: ${plural(units.length, 'shot')} (${chosen.map((a) => a.owner).join(', ')})${layoutNote}`,
    items,
  };
  return { job, units, refs: refsOut, skipped };
}

/**
 * Record, on each unit of a job, which bible files (and source key frame) it is generated from
 * (`from:<ref id>@<fingerprint>` tags, the same format the bible stage uses), and the layout
 * it was given (`layout:<sha256 prefix>`, from the shot's layout when the job sent it).
 * Replaces any earlier stamp, so it always describes the latest take.
 */
export function stampRefs(project: AkukoProject, job: Job): AkukoProject {
  const p = structuredClone(project);
  for (const item of job.items) {
    const a = p.assets.find((x) => x.id === item.unit);
    if (!a) continue;
    const stamps = (item.refs ?? [])
      .map((r) => p.assets.find((x) => x.id === r.id))
      .filter((r): r is Asset => r !== undefined && (r.stage === 'bible' || isKeyframe(r)) && hasFile(r))
      .map((r) => `${FROM}${r.id}@${fingerprint(r)}`);
    const shot = p.shots.find((s) => s.id === a.owner);
    const refs = item.refs ?? [];
    // A later step of a key frame made from its layout edits the step before: it keeps that step's stamps and adds its own.
    const later = refs.some((r) => r.id.startsWith(`${a.id}_step`));
    const key = shot?.layout ? layoutKey(shot.layout.sha256) : undefined;
    const sentLayout = shot?.layout !== undefined && (refs.some((r) => r.id === layoutRefId(shot.id) && r.uri === shot.layout!.uri)
      || (later && (a.layout_steps ?? []).some((s) => s.layout === key)));
    if (sentLayout) stamps.push(layoutStamp(shot!.layout!.sha256));
    // Made in two steps: the restyle (the layout its only ref), a later step, or a manual item that carries the steps.
    const twoStep = sentLayout && (later || item.steps !== undefined || (refs.length === 1 && refs[0]!.id === layoutRefId(shot!.id)));
    if (twoStep) stamps.push(TWO_STEP_STAMP);
    const kept = later ? a.tags.filter((t) => t.startsWith(FROM) && !stamps.includes(t)) : [];
    a.tags = [...a.tags.filter((t) => !t.startsWith(FROM) && !t.startsWith(LAYOUT_STAMP) && t !== TWO_STEP_STAMP), ...kept, ...stamps];
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// Status moves an action may make
// ─────────────────────────────────────────────────────────────────────────

/**
 * Before a run: `pending → draft`. A key frame a person sent back
 * (`needs-rework`) becomes `draft` with its old file cleared so the new take
 * fills the same asset; the old file stays where it was stored and the
 * "Revised:" comment says where. Units already `draft` are left alone.
 */
export function beginUnits(project: AkukoProject, ids: string[], ts: string): AkukoProject {
  const p = structuredClone(project);
  for (const id of ids) {
    const a = p.assets.find((x) => x.id === id);
    if (!a) throw new KeyframeError(`unknown asset "${id}"`);
    if (a.status === 'pending') {
      a.status = 'draft';
    } else if (a.status === 'needs-rework') {
      const prev = a.file?.uri;
      delete a.file;
      delete a.layout_steps; // a new take from a layout starts again at step 1 (the files stay where they were stored)
      a.status = 'draft';
      a.comments.push({ ts, stage: KEYFRAME_STAGE, author: 'agent', text: `Revised: regenerating after the requested changes${prev ? `; the previous take stays at ${prev}` : ''}` });
    } else {
      continue;
    }
    a.by_stage = { ...(a.by_stage ?? {}), [KEYFRAME_STAGE]: { status: 'draft' } };
    a.updated_at = ts;
  }
  return p;
}

/**
 * A run was not accepted (the gate refused, or the provider failed before
 * anything landed): put units that `beginUnits` just moved back exactly as
 * they were. Only a unit still `draft` with no file is touched.
 */
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
 * A key frame that is `approved` or `pending-review` must have a file. If one
 * has none (an undo restored a status after a revision cleared the file), set
 * it back to `pending` with a comment. A code-side move allowed only because
 * there is no image: nothing a person approved still exists. Never writes `approved`.
 */
export function repairFileless(project: AkukoProject, ts: string): { project: AkukoProject; repaired: string[] } {
  const p = structuredClone(project);
  const repaired: string[] = [];
  for (const a of liveKeyframes(p)) {
    if ((a.status === 'approved' || a.status === 'pending-review') && !hasFile(a)) {
      a.status = 'pending';
      a.by_stage = { ...(a.by_stage ?? {}), [KEYFRAME_STAGE]: { status: 'pending' } };
      a.comments.push({ ts, stage: KEYFRAME_STAGE, author: 'agent', text: 'Revised: restored without an image; needs generating' });
      a.updated_at = ts;
      repaired.push(a.id);
    }
  }
  return { project: p, repaired };
}

/** Keep `stages.keyframes.state` honest after the units moved. Never touches `locked`, and never sets `approved`. */
export function refreshStageState(project: AkukoProject): AkukoProject {
  const rec = project.stages.keyframes;
  if (rec.state === 'locked') return project;
  const units = liveKeyframes(project);
  if (units.length === 0) return project;
  if (rec.state === 'approved' && units.every(approvedWithFile)) return project;
  const todo = units.filter((a) => a.status === 'pending' || a.status === 'draft' || a.status === 'needs-rework');
  let state: typeof rec.state;
  if (todo.length > 0) {
    const ids = new Set(todo.map((a) => a.id));
    const waiting = project.pending_spend.some((j) => j.stage === KEYFRAME_STAGE && j.status === 'awaiting-approval' && j.units.some((u) => ids.has(u)));
    state = waiting ? 'waiting-spend' : 'in-progress';
  } else {
    state = 'in-review';
  }
  if (state === rec.state) return project;
  return { ...project, stages: { ...project.stages, keyframes: { state } } };
}
