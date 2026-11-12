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
 *   stampRefs()       record which reference files a take was made from
 *
 * Nothing here calls a provider, writes `approved`, or writes the project:
 * every function returns a new project for the caller to write via the host.
 */

import { createHash } from 'node:crypto';
import { STAGES, type AkukoProject, type Asset, type BibleEntry, type Shot } from '../schema/akuko-project.ts';
import { jobTag } from '../providers/outputs.ts';
import type { Job, JobItem, JobRef } from '../providers/contract.ts';
import { BibleError, MAX_REFS, bibleAssets, requestedChanges, roleOf, type BibleRole } from '../bible/plan.ts';
import { removedAt } from '../decisions/fold.ts';
import { keyframePrompt, type KeyframeContext } from './prompts.ts';

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
 */
export function neededRefs(p: AkukoProject, shot: Shot): NeededRef[] {
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

/** Ids a key frame is waiting for: bible images not approved with a file, or not yet in the entry's `refs[]`. */
function waitingFor(p: AkukoProject, shot: Shot): string[] {
  return neededRefs(p, shot).filter((r) => !approvedWithFile(r.asset) || !r.synced).map((r) => r.asset.id);
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
  /** References this take was made from that have since been sent back or replaced. */
  superseded: string[];
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
  return out;
}

export function keyframeStatus(p: AkukoProject): StatusRow[] {
  return liveKeyframes(p).map((a) => {
    const r = unitReadiness(p, a);
    return { shot: a.owner ?? '', asset: a.id, status: a.status, state: r.state, waiting: r.waiting, superseded: supersededRefs(p, a) };
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
export function keyframeJobId(p: AkukoProject, units: string[], provider = '', model = ''): string {
  // Provider and model are part of the id: a person's approval binds to one provider and model, so changing either is a new job with a fresh approval.
  const base = `job_kf_${hash8([[...units].sort().join('|'), provider, model].join('#'))}`;
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
}

/** A ready key frame that could not be built, and why. */
export interface Skipped { unit: string; reason: string }
export interface BuiltJob { job: Job; units: string[]; refs: Record<string, string[]>; skipped: Skipped[] }

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The film's written look, from the style entries. */
const lookText = (p: AkukoProject): string =>
  p.bible.styles.map((s) => [s.name + (s.description ? `: ${s.description}` : ''), ...s.notes].join('. ').replace(/\.\.+/g, '.')).join(' | ');

const REF_NOTE: Record<EntryKind, (name: string, role: BibleRole) => string> = {
  character: (name, role) => role === 'turnaround'
    ? `the approved turnaround sheet of ${name}: keep face, hair, build and clothing exactly; ignore the sheet's layout and labels`
    : `the approved portrait of ${name}: keep face, hair, build and clothing exactly`,
  location: (name) => `the approved plate of ${name}: keep the place, its layout and props`,
  style: () => 'the approved lookbook: match its light, palette and grain',
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

  const look = lookText(p);
  const refsOut: Record<string, string[]> = {};
  const buildItem = (a: Asset): JobItem => {
    const shot = shotOf(p, a);
    const needed = neededRefs(p, shot);
    const refs: JobRef[] = needed.map((n) => ({
      id: n.asset.id,
      uri: n.asset.file!.uri,
      role: n.kind,
      note: REF_NOTE[n.kind](n.entry.name, roleOf(n.asset)),
    }));
    // Pictures the person supplied for this shot.
    for (const x of p.assets) {
      if (x.kind === 'reference' && x.owner === shot.id && hasFile(x)) refs.push({ id: x.id, uri: x.file!.uri, role: 'reference', note: 'supplied by the person' });
    }
    if (refs.length > MAX_REFS) {
      throw new KeyframeError(`${a.id} would send ${refs.length} reference images; the image providers accept at most ${MAX_REFS}. Remove some supplied references.`);
    }
    const scene = p.scenes.find((s) => s.id === shot.scene);
    const ctx: KeyframeContext = {
      shot,
      aspect: p.project.aspect_ratio,
      scene: scene ? [scene.heading, scene.summary].filter(Boolean).join(' - ') : '',
      look,
      characters: needed.filter((n) => n.kind === 'character').map((n) => n.entry),
      location: needed.find((n) => n.kind === 'location')?.entry,
      unreferenced: entriesOf(p, shot).filter((e) => e.kind === 'character' && !needed.some((n) => n.entry.id === e.entry.id)).map((e) => e.entry),
    };
    const changes = requestedChanges(a);
    const asked = (a.status === 'needs-rework' || a.status === 'draft') && changes !== '' ? changes : '';
    refsOut[a.id] = refs.map((r) => r.id);
    return {
      unit: a.id,
      prompt: keyframePrompt(ctx, asked),
      output: 'keyframe',
      aspect_ratio: p.project.aspect_ratio,
      count: 1,
      ...(shot.negative?.trim() ? { negative: shot.negative } : {}),
      ...(shot.seed !== undefined ? { seed: shot.seed } : {}),
      ...(refs.length ? { refs } : {}),
    };
  };

  // Explicit units: the person named them, so an unbuildable one is an error. Otherwise a frame that
  // cannot be built is skipped and reported, and the next ready frame is tried (a batch builds what it can).
  const items: JobItem[] = [];
  const skipped: Skipped[] = [];
  for (const a of chosen) {
    if (o.units) { items.push(buildItem(a)); continue; }
    try {
      items.push(buildItem(a));
    } catch (e) {
      skipped.push({ unit: a.id, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (o.scene === undefined) break; // default: one shot
  }
  if (items.length === 0) {
    throw new KeyframeError(`No ready key frame could be built: ${skipped.map((x) => `${x.unit}: ${x.reason}`).join(' ')}`);
  }
  const built = new Set(items.map((i) => i.unit));
  chosen = chosen.filter((a) => built.has(a.id));

  const units = chosen.map((a) => a.id);
  const job: Job = {
    id: keyframeJobId(p, units, o.provider, o.model ?? ''),
    stage: KEYFRAME_STAGE,
    kind: 'image',
    provider: o.provider,
    ...(o.model !== undefined ? { model: o.model } : {}),
    label: `Key frames: ${plural(units.length, 'shot')} (${chosen.map((a) => a.owner).join(', ')})`,
    items,
  };
  return { job, units, refs: refsOut, skipped };
}

/**
 * Record, on each unit of a job, which bible files it is generated from
 * (`from:<ref id>@<fingerprint>` tags, the same format the bible stage uses).
 * Replaces any earlier stamp, so it always describes the latest take.
 */
export function stampRefs(project: AkukoProject, job: Job): AkukoProject {
  const p = structuredClone(project);
  for (const item of job.items) {
    const a = p.assets.find((x) => x.id === item.unit);
    if (!a) continue;
    const stamps = (item.refs ?? [])
      .map((r) => p.assets.find((x) => x.id === r.id))
      .filter((r): r is Asset => r !== undefined && r.stage === 'bible' && hasFile(r))
      .map((r) => `${FROM}${r.id}@${fingerprint(r)}`);
    a.tags = [...a.tags.filter((t) => !t.startsWith(FROM)), ...stamps];
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
