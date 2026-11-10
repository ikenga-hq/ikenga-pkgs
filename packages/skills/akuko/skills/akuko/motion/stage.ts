/**
 * akuko — the motion stage's units and its one roll-up (WP-32).
 *
 * The motion stage (stage 5) holds three kinds of unit, planned by two steps:
 *
 *   `<shot>_clip`      a paid clip              (motion/plan.ts)    for a shot that `wantsClip`
 *   `<shot>_lipsync`   a lip-sync video         (lipsync/plan.ts)   for a shot that `wantsLipsync`
 *   `<shot>_linecut`   the line audio it sends  (lipsync/cut.ts)    for the same shots
 *
 * A unit whose shot no longer asks for it (the person changed the treatment, or the spoken line went away) is
 * **idle**: kept, never deleted, shown as idle, and counted nowhere: not by `refreshMotionStage`, not by folding
 * (`decisions/fold.ts`), not in the board's "your move". A unit of a row removed from the sheet is out the same way.
 *
 * `refreshMotionStage(p)` is the one roll-up both steps (and their command lines) use. It counts the active units,
 * plus the units still to be planned (a video shot with no clip yet is work outstanding), and never touches
 * `locked` or writes `approved`.
 *
 * Part scope (`--part P7`): `partOpenness(p, part)` says whether one part may make clips and lip-syncs before the
 * whole film may, from approvals already recorded (never from a stored flag).
 *
 * This module imports only the schema and `treatment.ts`, so `decisions/fold.ts` can use it without a cycle.
 */

import { STAGES, removedAt, type AkukoProject, type Asset, type AudioLine, type Shot, type StageState } from '../schema/akuko-project.ts';
import { wantsClip } from './treatment.ts';

export const MOTION_STAGE = 'motion' as const;
/** Tag on every planned clip asset. */
export const CLIP_TAG = 'clip';
/** Tag on every planned lip-sync asset. */
export const LIPSYNC_TAG = 'lipsync';
/** Tag on the audio cut for a shot's lip-sync (an `akuko-cut` asset, `lipsync/cut.ts`). */
export const CUT_TAG = 'lipsync-audio';

export type MotionUnitKind = 'clip' | 'lipsync' | 'cut';

/** Which motion unit an asset is, if any. */
export function motionUnitKind(a: Asset): MotionUnitKind | undefined {
  if (a.stage !== MOTION_STAGE) return undefined;
  if (a.kind === 'lipsync' && a.tags.includes(LIPSYNC_TAG)) return 'lipsync';
  if (a.tags.includes(CUT_TAG)) return 'cut';
  if (a.kind !== 'lipsync' && a.tags.includes(CLIP_TAG)) return 'clip';
  return undefined;
}

/** The shot's spoken lines, in film order, as `audio.lines` entries. Thought lines are left out (they need nothing). */
export function spokenLines(p: AkukoProject, shot: Shot): AudioLine[] {
  const byId = new Map((p.audio?.lines ?? []).map((l) => [l.id, l]));
  return (shot.lines ?? [])
    .filter((l) => l.kind === 'spoken')
    .map((l) => byId.get(l.id))
    .filter((l): l is AudioLine => l !== undefined && l.kind === 'spoken')
    .sort((a, b) => a.film_in_s - b.film_in_s);
}

/** Does this shot get a `<shot>_lipsync` unit: treatment `lipsync`, or `video` with a spoken line, and a spoken line to sync. */
export function wantsLipsync(p: AkukoProject, shot: Shot): boolean {
  return (shot.treatment === 'lipsync' || shot.treatment === 'video') && spokenLines(p, shot).length > 0;
}

const shotById = (p: AkukoProject, id: string | undefined): Shot | undefined => (id === undefined ? undefined : p.shots.find((s) => s.id === id));

/**
 * A motion unit kept although its shot no longer asks for it: a clip of a shot that is not a video shot, or a
 * lip-sync (and its line cut) of a shot that no longer wants one. Not a motion unit: false.
 */
export function isIdleMotionUnit(p: AkukoProject, a: Asset): boolean {
  const kind = motionUnitKind(a);
  if (kind === undefined) return false;
  const shot = shotById(p, a.owner);
  if (!shot) return true;
  return kind === 'clip' ? !wantsClip(shot) : !wantsLipsync(p, shot);
}

/** A shot's part: its own, else its scene's. */
export function shotPart(p: AkukoProject, s: Shot): string | undefined {
  return s.part ?? (s.scene === undefined ? undefined : p.scenes.find((x) => x.id === s.scene)?.part);
}

/** Every part a live shot belongs to, in film order of its first shot. */
export function partsOf(p: AkukoProject): string[] {
  const out: string[] = [];
  const shots = p.shots.filter((s) => removedAt(p, s) === undefined).map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.film?.in_s ?? Infinity) - (b.s.film?.in_s ?? Infinity) || a.i - b.i);
  for (const { s } of shots) {
    const part = shotPart(p, s);
    if (part !== undefined && !out.includes(part)) out.push(part);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// The roll-up
// ─────────────────────────────────────────────────────────────────────────

export interface MotionRollup {
  /** Live motion units whose shot still asks for them: what the stage waits on. */
  active: Asset[];
  /** Live motion units kept although their shot no longer asks for them. Counted nowhere. */
  idle: Asset[];
  /** Units a live shot asks for that are not planned yet (`<shot>_clip`, `<shot>_lipsync`): work outstanding. */
  unplanned: string[];
}

/** The motion stage's units, sorted into active, idle and still to be planned. Removed rows are left out. */
export function motionRollup(p: AkukoProject): MotionRollup {
  const active: Asset[] = [];
  const idle: Asset[] = [];
  for (const a of p.assets) {
    if (motionUnitKind(a) === undefined || removedAt(p, a) !== undefined) continue;
    (isIdleMotionUnit(p, a) ? idle : active).push(a);
  }
  const ids = new Set(p.assets.map((a) => a.id));
  const unplanned: string[] = [];
  for (const s of p.shots) {
    if (removedAt(p, s) !== undefined) continue;
    if (wantsClip(s) && !ids.has(`${s.id}_clip`)) unplanned.push(`${s.id}_clip`);
    if (wantsLipsync(p, s) && !ids.has(`${s.id}_lipsync`)) unplanned.push(`${s.id}_lipsync`);
  }
  return { active, idle, unplanned };
}

const approvedWithFile = (a: Asset): boolean => a.status === 'approved' && a.file !== undefined;
const TODO: ReadonlySet<Asset['status']> = new Set(['pending', 'draft', 'needs-rework']);

/**
 * Keep `stages.motion.state` honest after motion units moved: the one roll-up for clips and lip-sync (WP-32).
 *
 * Counts the active clips, the active lip-syncs and the line cuts they need, and the units still to be planned.
 * Never idle units, never removed rows. Never touches `locked` (a part being piloted does not open the stage:
 * lib/state.md §Stages) and never sets `approved` (only folding does, from a person's decisions).
 *
 *   something to make, and a spend approval awaited for it   → `waiting-spend`
 *   something to make                                         → `in-progress`
 *   nothing to make (everything made waits for a person, or
 *   there is nothing at all to make: every shot is a still)   → `in-review`
 *   `approved`, and still nothing to make or review           → stays `approved`
 */
export function refreshMotionStage(project: AkukoProject): AkukoProject {
  const rec = project.stages.motion;
  if (rec.state === 'locked') return project;
  const { active, unplanned } = motionRollup(project);
  if (rec.state === 'approved' && unplanned.length === 0 && active.every(approvedWithFile)) return project;
  const todo = active.filter((a) => TODO.has(a.status));
  let state: StageState;
  if (todo.length > 0 || unplanned.length > 0) {
    const ids = new Set(todo.map((a) => a.id));
    const waiting = project.pending_spend.some((j) => j.stage === MOTION_STAGE && j.status === 'awaiting-approval' && j.units.some((u) => ids.has(u)));
    state = waiting ? 'waiting-spend' : 'in-progress';
  } else {
    state = 'in-review';
  }
  if (state === rec.state) return project;
  return { ...project, stages: { ...project.stages, motion: { state } } };
}

// ─────────────────────────────────────────────────────────────────────────
// Part scope
// ─────────────────────────────────────────────────────────────────────────

export interface PartOpenness {
  part: string;
  open: boolean;
  /** The part's live shots, in film order. */
  shots: Shot[];
  /** Stages before the bible that are not approved project-wide (`intake is "in-review"`). */
  stages: string[];
  /** Live shots in the part whose key frame is not approved with a file. */
  keyframes: string[];
  /** Bible entries those shots name (`refs`, `lighting`) that are not approved, or have a bible image that is not. */
  bible: string[];
}

const keyframeOf = (p: AkukoProject, shotId: string): Asset | undefined => p.assets.find((a) => a.id === `${shotId}_keyframe`);

/**
 * Whether one part may make clips and lip-syncs before the whole film may, derived only from approvals already
 * recorded (nothing is stored, nothing is implied). A part is open when:
 *   - every stage before the bible (intake, breakdown, sketch) is approved project-wide;
 *   - every live shot in the part has an approved key frame (with its file);
 *   - every bible entry those shots name (`refs[]` and `lighting`) is approved, and so is every live bible image
 *     it owns; a shot whose `refs[]` names no style is made against every style (the film's look, as key frames
 *     are: `keyframes/plan.ts#entriesOf`), so then every live style entry and its images must be approved too.
 */
export function partOpenness(p: AkukoProject, part: string): PartOpenness {
  const shots = p.shots
    .filter((s) => removedAt(p, s) === undefined && shotPart(p, s) === part)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.film?.in_s ?? Infinity) - (b.s.film?.in_s ?? Infinity) || a.i - b.i)
    .map((x) => x.s);
  const stages: string[] = [];
  for (const { id } of STAGES) {
    if (id === 'bible') break;
    if (p.stages[id].state !== 'approved') stages.push(`${id} is "${p.stages[id].state}"`);
  }
  const keyframes = shots.filter((s) => { const k = keyframeOf(p, s.id); return k === undefined || !approvedWithFile(k); }).map((s) => s.id);
  const entries = new Map([...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((e) => [e.id, e]));
  const named: string[] = [];
  const styleIds = p.bible.styles.filter((e) => removedAt(p, e) === undefined).map((e) => e.id);
  for (const s of shots) {
    const ids = [...(s.refs ?? []), ...(s.lighting ? [s.lighting] : [])];
    // A shot whose `refs[]` names no style is generated against the film's look: every style entry. This mirrors
    // `keyframes/plan.ts#entriesOf` (not imported: keyframes/plan imports decisions/fold, which imports this module).
    if (!(s.refs ?? []).some((id) => p.bible.styles.some((e) => e.id === id))) ids.push(...styleIds);
    for (const id of ids) if (entries.has(id) && !named.includes(id)) named.push(id);
  }
  const bible = named.filter((id) => {
    const e = entries.get(id)!;
    if (removedAt(p, e) !== undefined) return false;
    if (e.status !== 'approved') return true;
    return p.assets.some((a) => a.owner === id && a.stage === 'bible' && removedAt(p, a) === undefined && !approvedWithFile(a));
  });
  return { part, open: shots.length > 0 && stages.length === 0 && keyframes.length === 0 && bible.length === 0, shots, stages, keyframes, bible };
}

const firstFew = (ids: string[], n = 3): string => (ids.length > n ? `${ids.slice(0, n).join(', ')}, …` : ids.join(', '));
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Why a part is not open, as counts plus the first few ids. Empty when it is open. */
export function partRefusal(o: PartOpenness, parts: string[] = []): string {
  if (o.open) return '';
  if (o.shots.length === 0) return `No live shot is in part "${o.part}". Parts in this project: ${parts.join(', ') || 'none'}.`;
  const why: string[] = [...o.stages];
  if (o.keyframes.length) why.push(`${count(o.keyframes.length, 'key frame', 'key frames')} not approved (${firstFew(o.keyframes)})`);
  if (o.bible.length) why.push(`${count(o.bible.length, 'bible entry', 'bible entries')} not approved (${firstFew(o.bible)})`);
  return `${o.part} is not open for motion: ${why.join(', ')}. A part opens once a person has approved its own key frames and the bible entries they use; nothing is approved for you.`;
}

/** The part's live shot ids, for filtering a scoped run. */
export const partShotIds = (o: PartOpenness): Set<string> => new Set(o.shots.map((s) => s.id));
