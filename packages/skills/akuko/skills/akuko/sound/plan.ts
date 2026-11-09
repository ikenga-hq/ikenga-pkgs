/**
 * akuko — sound stage (stage 6): voice-over planning, readiness, jobs (WP-12).
 *
 * Review unit: one planned **asset** per shot that has narration text
 * (`<shot>_vo`, kind `vo`, stage `sound`, owner = the shot), the same shape as
 * the key-frame stage: the shot stays approved at `sketch`, the provider or the
 * manual `ingest()` fills the asset in place, and folding approves the stage
 * when every sound unit (voice-over, music, sfx) is approved.
 *
 * Opening rule (differs from lib/state.md §Stages' strict order, see §6 sound):
 * sound opens once **keyframes** is approved, not motion. Shot durations are set
 * by then, and a voice-over only needs a duration slot, not a clip. `assertOpen`
 * checks exactly that and `planSound` unlocks the stage.
 *
 * Narration text is never invented. It comes from `shot.narration`, or from
 * `shot.script_line` only when the person asked for it by name (`scriptLines`
 * on `planSound`, recorded as the `text:script_line` tag on that unit). A shot
 * with no text has no unit.
 *
 * Nothing here calls a provider, writes `approved`, or writes the project:
 * every function returns a new project for the caller to write via the host.
 */

import { createHash } from 'node:crypto';
import { STAGES, type AkukoProject, type Asset, type Shot } from '../schema/akuko-project.ts';
import type { Job, JobItem } from '../providers/contract.ts';
import { MANUAL_PROVIDER_ID } from '../spend/gate.ts';
import { jobTag } from '../providers/outputs.ts';
import { NO_WORDS_TAG, VOICE_TAG, WORDS_TAG } from './words.ts';

export const SOUND_STAGE = 'sound' as const;
export const VO_TAG = 'vo';
export const SCRIPT_LINE_TAG = 'text:script_line';
const TEXT_HASH = 'text-hash:';

export class SoundError extends Error {
  override name = 'SoundError';
}

export const assetIdFor = (shotId: string): string => `${shotId}_vo`;
export const isVo = (a: Asset): boolean => a.stage === SOUND_STAGE && a.kind === 'vo' && a.tags.includes(VO_TAG);
export const voAssets = (p: AkukoProject): Asset[] => p.assets.filter(isVo);
/** Every unit the sound stage holds: voice-over, music and sfx. */
export const soundUnits = (p: AkukoProject): Asset[] => p.assets.filter((a) => a.stage === SOUND_STAGE && (a.kind === 'vo' || a.kind === 'music' || a.kind === 'sfx'));

const hasFile = (a: Asset): boolean => a.file !== undefined;
const approvedWithFile = (a: Asset): boolean => a.status === 'approved' && hasFile(a);
const hash8 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);
const blank = (s: string | null | undefined): boolean => (s ?? '').trim() === '';

// ─────────────────────────────────────────────────────────────────────────
// Opening rule
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sound opens when every stage up to and including keyframes is approved and
 * every shot is approved (motion need not be). Throws naming what is waiting.
 */
export function assertOpen(p: AkukoProject): void {
  for (const { id } of STAGES) {
    if (p.stages[id].state !== 'approved') {
      throw new SoundError(`The sound stage is locked: ${id} is "${p.stages[id].state}". It opens when a person has approved every stage up to key frames (motion is not needed first).`);
    }
    if (id === 'keyframes') break;
  }
  const open = p.shots.filter((s) => s.status !== 'approved');
  if (open.length > 0) throw new SoundError(`These shots are not approved yet: ${open.map((s) => s.id).join(', ')}.`);
}

// ─────────────────────────────────────────────────────────────────────────
// Text: where narration comes from
// ─────────────────────────────────────────────────────────────────────────

export interface UnitText { text: string; source: 'narration' | 'script_line' }

/** The text a voice-over unit speaks. `narration` always wins; the script line only for a unit the person confirmed. */
export function textFor(shot: Shot, asset?: Asset): UnitText | undefined {
  if (!blank(shot.narration)) return { text: (shot.narration as string).trim(), source: 'narration' };
  if (asset?.tags.includes(SCRIPT_LINE_TAG) && !blank(shot.script_line)) return { text: (shot.script_line as string).trim(), source: 'script_line' };
  return undefined;
}

export interface Proposal { shot: string; script_line: string }
export interface PlanResult { project: AkukoProject; created: string[]; proposals: Proposal[]; noText: string[] }
export interface PlanOptions {
  /** Shot ids whose script line the person confirmed as the narration, or `'all'`. Only for shots with no narration of their own. */
  scriptLines?: string[] | 'all';
}

/**
 * Create the planned voice-over asset for every shot that has narration text
 * (or whose script line the person confirmed). Shots with only a script line
 * come back as `proposals` for the person to confirm; shots with neither are
 * `noText`. Unlocks the sound stage. Safe to run again.
 */
export function planSound(project: AkukoProject, now: string, o: PlanOptions = {}): PlanResult {
  assertOpen(project);
  const p = structuredClone(project);
  const created: string[] = [];
  const proposals: Proposal[] = [];
  const noText: string[] = [];
  const confirmed = (id: string): boolean => o.scriptLines === 'all' || (Array.isArray(o.scriptLines) && o.scriptLines.includes(id));
  if (Array.isArray(o.scriptLines)) {
    const unknown = o.scriptLines.filter((id) => !p.shots.some((s) => s.id === id));
    if (unknown.length) throw new SoundError(`unknown shot${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  }
  for (const shot of p.shots) {
    const id = assetIdFor(shot.id);
    const existing = p.assets.find((a) => a.id === id);
    const fromScript = blank(shot.narration) && !blank(shot.script_line) && confirmed(shot.id);
    if (existing) {
      // A later, explicit confirmation can still turn on the script line for a unit that has none.
      if (fromScript && !existing.tags.includes(SCRIPT_LINE_TAG)) { existing.tags.push(SCRIPT_LINE_TAG); existing.updated_at = now; }
      continue;
    }
    if (!blank(shot.narration) || fromScript) {
      p.assets.push({
        id,
        stage: SOUND_STAGE,
        status: 'pending',
        comments: [],
        kind: 'vo',
        owner: shot.id,
        name: `${shot.id} - voice-over`,
        tags: fromScript ? [VO_TAG, SCRIPT_LINE_TAG] : [VO_TAG],
        updated_at: now,
      });
      created.push(id);
    } else if (!blank(shot.script_line)) {
      proposals.push({ shot: shot.id, script_line: (shot.script_line as string).trim() });
    } else {
      noText.push(shot.id);
    }
  }
  if (p.stages.sound.state === 'locked') p.stages.sound = { state: 'not-started' };
  if (created.length > 0 && p.stages.sound.state === 'not-started') p.stages.sound = { state: 'in-progress' };
  return { project: p, created, proposals, noText };
}

// ─────────────────────────────────────────────────────────────────────────
// Readiness
// ─────────────────────────────────────────────────────────────────────────

export type ReadinessState = 'approved' | 'in-review' | 'in-flight' | 'ready' | 'blocked';
export interface Readiness { state: ReadinessState; waiting: string[] }

const shotOf = (p: AkukoProject, a: Asset): Shot => {
  const s = p.shots.find((x) => x.id === a.owner);
  if (!s) throw new SoundError(`voice-over "${a.id}" has no shot; plan the sound stage again.`);
  return s;
};

const inFlight = (p: AkukoProject, a: Asset): boolean => p.ledger.some((e) => e.unit === a.id && e.status === 'submitted');

export function unitReadiness(p: AkukoProject, a: Asset): Readiness {
  if (approvedWithFile(a)) return { state: 'approved', waiting: [] };
  if (hasFile(a) && a.status === 'pending-review') return { state: 'in-review', waiting: [] };
  if (inFlight(p, a)) return { state: 'in-flight', waiting: [] };
  if (!textFor(shotOf(p, a), a)) return { state: 'blocked', waiting: ['text'] };
  return { state: 'ready', waiting: [] };
}

export interface StatusRow {
  shot: string;
  asset: string;
  status: Asset['status'];
  state: ReadinessState;
  waiting: string[];
  /** The take was made from text that has since changed. */
  textChanged: boolean;
  /** The take has no word timings (captions need them). */
  noWords: boolean;
}

/** True when a produced take was spoken from different text than the shot has now. */
export function textChangedSince(p: AkukoProject, a: Asset): boolean {
  if (!hasFile(a)) return false;
  const stamp = a.tags.find((t) => t.startsWith(TEXT_HASH));
  const cur = textFor(shotOf(p, a), a);
  return stamp !== undefined && (!cur || stamp !== `${TEXT_HASH}${hash8(cur.text)}`);
}

export function soundStatus(p: AkukoProject): StatusRow[] {
  return voAssets(p).map((a) => {
    const r = unitReadiness(p, a);
    return {
      shot: a.owner ?? '',
      asset: a.id,
      status: a.status,
      state: r.state,
      waiting: r.waiting,
      textChanged: textChangedSince(p, a),
      noWords: hasFile(a) && a.tags.includes(NO_WORDS_TAG),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────

/** A job has run once any output carries its tag or any ledger entry is in flight or done. */
export function jobRan(p: AkukoProject, id: string): boolean {
  return p.ledger.some((e) => e.job === id && (e.status === 'submitted' || e.status === 'done')) || p.assets.some((a) => a.tags.includes(jobTag(id)));
}

/**
 * Deterministic id: `job_snd_<hash of units + provider + model + voice + text>_r<n>`.
 * Provider, model, voice and the exact words are part of the id: a person's
 * approval binds to them, so changing any is a new job with a fresh approval.
 */
export function soundJobId(p: AkukoProject, texts: Array<[string, string]>, provider = '', model = '', voice = ''): string {
  const body = [...texts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([u, t]) => `${u}=${t}`).join('\n');
  const base = `job_snd_${hash8([body, provider, model, voice].join('#'))}`;
  let n = 1;
  while (jobRan(p, `${base}_r${n}`)) n++;
  return `${base}_r${n}`;
}

export interface BuildOptions {
  provider: string;
  model?: string;
  /** The voice (a provider voice id). Required for a paid provider; for the manual provider it is a note for the person. */
  voice?: string;
  /** Voice-over asset ids. Default: the next ready shot, alone. */
  units?: string[];
  /** Every ready voice-over of this scene in one job. */
  scene?: string;
}

export interface Skipped { unit: string; reason: string }
export interface BuiltJob { job: Job; units: string[]; characters: number; skipped: Skipped[] }

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Build one job. It never submits anything: hand the result to `gate.run()`.
 * By default one shot, the next that is ready, so each approval binds to the
 * amount for that one voice-over. `prompt` is the narration text exactly, so a
 * per-character price multiplies the real characters.
 */
export function buildSoundJob(p: AkukoProject, o: BuildOptions): BuiltJob {
  assertOpen(p);
  const paid = o.provider !== MANUAL_PROVIDER_ID;
  const voice = (o.voice ?? '').trim();
  if (paid && voice === '') throw new SoundError('Choose a voice first: pass the provider\'s voice id (for ElevenLabs, list yours with GET /v2/voices). akuko does not pick one for you.');
  const all = voAssets(p);
  const byId = new Map(all.map((a) => [a.id, a]));
  let chosen: Asset[];
  if (o.units) {
    chosen = o.units.map((id) => {
      const a = byId.get(id);
      if (!a) throw new SoundError(`"${id}" is not a planned voice-over; run plan first.`);
      const r = unitReadiness(p, a);
      if (r.state !== 'ready') throw new SoundError(`${id} cannot be generated now (${r.state}${r.waiting.length ? `; waiting for ${r.waiting.join(', ')}` : ''}).`);
      return a;
    });
  } else {
    chosen = all.filter((a) => unitReadiness(p, a).state === 'ready' && (o.scene === undefined || shotOf(p, a).scene === o.scene));
    if (o.scene === undefined) chosen = chosen.slice(0, 1); // default: one shot
  }
  if (chosen.length === 0) {
    const stuck = soundStatus(p).filter((r) => r.state === 'blocked').map((r) => `${r.asset} (waiting for ${r.waiting.join(', ')})`);
    throw new SoundError(stuck.length ? `Nothing can be generated yet: ${stuck.join('; ')}.` : 'Nothing is waiting to be generated.');
  }
  if (new Set(chosen.map((a) => a.id)).size !== chosen.length) throw new SoundError('a unit was listed twice');

  const items: JobItem[] = chosen.map((a) => {
    const shot = shotOf(p, a);
    const text = textFor(shot, a)!.text;
    return {
      unit: a.id,
      prompt: text,
      output: 'vo',
      count: 1,
      ...(shot.duration_s !== undefined ? { duration_s: shot.duration_s } : {}),
      ...(paid ? { refs: [{ id: voice, role: 'voice', note: 'provider voice id' }] } : {}),
    };
  });
  const units = chosen.map((a) => a.id);
  const characters = items.reduce((n, i) => n + i.prompt.length, 0);
  const job: Job = {
    id: soundJobId(p, items.map((i): [string, string] => [i.unit, i.prompt]), o.provider, o.model ?? '', voice),
    stage: SOUND_STAGE,
    kind: 'audio',
    provider: o.provider,
    ...(o.model !== undefined ? { model: o.model } : {}),
    label: `Voice-over: ${plural(units.length, 'shot')} (${chosen.map((a) => a.owner).join(', ')}), ${plural(characters, 'character')}`,
    items,
  };
  return { job, units, characters, skipped: [] };
}

/**
 * Record on each unit of a job the exact text spoken (`text-hash:`) and the
 * voice (`voice:`), replacing any earlier stamp, so a later edit to the shot's
 * narration shows up as "text changed since this take".
 */
export function stampTake(project: AkukoProject, job: Job): AkukoProject {
  const p = structuredClone(project);
  for (const item of job.items) {
    const a = p.assets.find((x) => x.id === item.unit);
    if (!a) continue;
    const voice = item.refs?.find((r) => r.role === 'voice')?.id;
    a.tags = [
      ...a.tags.filter((t) => !t.startsWith(TEXT_HASH) && !t.startsWith(VOICE_TAG)),
      `${TEXT_HASH}${hash8(item.prompt)}`,
      ...(voice ? [`${VOICE_TAG}${voice}`] : []),
    ];
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// Status moves an action may make
// ─────────────────────────────────────────────────────────────────────────

/**
 * Before a run: `pending → draft`. A take a person sent back (`needs-rework`)
 * becomes `draft` with its old file cleared (and its words stamp dropped) so
 * the new take fills the same asset; the old file stays where it was stored and
 * the "Revised:" comment says where.
 */
export function beginUnits(project: AkukoProject, ids: string[], ts: string): AkukoProject {
  const p = structuredClone(project);
  for (const id of ids) {
    const a = p.assets.find((x) => x.id === id);
    if (!a) throw new SoundError(`unknown asset "${id}"`);
    if (a.status === 'pending') {
      a.status = 'draft';
    } else if (a.status === 'needs-rework') {
      const prev = a.file?.uri;
      delete a.file;
      a.tags = a.tags.filter((t) => !t.startsWith(WORDS_TAG) && t !== NO_WORDS_TAG);
      a.status = 'draft';
      a.comments.push({ ts, stage: SOUND_STAGE, author: 'agent', text: `Revised: re-recording after the requested changes${prev ? `; the previous take stays at ${prev}` : ''}` });
    } else {
      continue;
    }
    a.by_stage = { ...(a.by_stage ?? {}), [SOUND_STAGE]: { status: 'draft' } };
    a.updated_at = ts;
  }
  return p;
}

/** A run was not accepted: put units that `beginUnits` just moved back exactly as they were. */
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
 * A sound asset that is `approved` or `pending-review` must have a file. If
 * one has none (an undo restored a status after a revision cleared the file),
 * set it back to `pending` with a comment: allowed only because no file exists.
 * Never writes `approved`.
 */
export function repairFileless(project: AkukoProject, ts: string): { project: AkukoProject; repaired: string[] } {
  const p = structuredClone(project);
  const repaired: string[] = [];
  for (const a of soundUnits(p)) {
    if ((a.status === 'approved' || a.status === 'pending-review') && !hasFile(a)) {
      a.status = 'pending';
      a.by_stage = { ...(a.by_stage ?? {}), [SOUND_STAGE]: { status: 'pending' } };
      a.comments.push({ ts, stage: SOUND_STAGE, author: 'agent', text: 'Revised: restored without a file; needs recording' });
      a.updated_at = ts;
      repaired.push(a.id);
    }
  }
  return { project: p, repaired };
}

/** Keep `stages.sound.state` honest after the units moved. Never touches `locked`, and never sets `approved`. */
export function refreshStageState(project: AkukoProject): AkukoProject {
  const rec = project.stages.sound;
  if (rec.state === 'locked') return project;
  const units = soundUnits(project);
  if (units.length === 0) return project;
  if (rec.state === 'approved' && units.every(approvedWithFile)) return project;
  const todo = units.filter((a) => a.status === 'pending' || a.status === 'draft' || a.status === 'needs-rework');
  let state: typeof rec.state;
  if (todo.length > 0) {
    const ids = new Set(todo.map((a) => a.id));
    const waiting = project.pending_spend.some((j) => j.stage === SOUND_STAGE && j.status === 'awaiting-approval' && j.units.some((u) => ids.has(u)));
    state = waiting ? 'waiting-spend' : 'in-progress';
  } else {
    state = 'in-review';
  }
  if (state === rec.state) return project;
  return { ...project, stages: { ...project.stages, sound: { state } } };
}
