/**
 * akuko — bible stage (stage 3): planning, readiness, jobs, refs (WP-05).
 *
 * How the stage is tracked (lib/state.md §3): the bible entries came out of
 * breakdown already approved, and they stay approved. The *visual* work of
 * this stage is tracked on **assets**: one planned asset per image
 * (`<entry>_portrait`, `_turnaround`, `_plate`, `_lookbook`), stage `bible`,
 * owner = the entry. Those are units like any other, so the spend gate, the
 * manual provider's in-place fill, the board and decision folding all work on
 * them unchanged, and no entry is ever moved backwards.
 *
 *   planBible()       create the planned assets (idempotent)
 *   unitReadiness()   ready / blocked / in flight / in review / approved
 *   buildBibleJob()   one gate-ready Job for the units that are ready now
 *   beginUnits()      pending → draft; needs-rework → draft with the old take cleared
 *   syncRefs()        entry.refs[] = its approved visual assets (never writes a status)
 *   refreshStageState()
 *
 * Nothing here calls a provider, writes `approved`, or writes the project:
 * every function returns a new project for the caller to write via the host.
 */

import { createHash } from 'node:crypto';
import { STAGES, type AkukoProject, type Asset, type AssetKind, type BibleEntry } from '../schema/akuko-project.ts';
import { jobTag } from '../providers/outputs.ts';
import type { Job, JobItem, JobRef } from '../providers/contract.ts';
import { BIBLE_ROLES, promptFor, type BibleRole, type PromptContext } from './prompts.ts';

export { BIBLE_ROLES };
export type { BibleRole };

export const BIBLE_STAGE = 'bible' as const;
/** Gemini and fal both accept at most 14 reference images per image (WP-06). Per-role sublimits are not enforced yet. */
export const MAX_REFS = 14;
/** Tag every planned bible asset carries. */
export const BIBLE_TAG = 'bible';

export class BibleError extends Error {
  override name = 'BibleError';
}

export type EntryKind = 'character' | 'location' | 'style';
export interface EntryRef { kind: EntryKind; entry: BibleEntry }

export const ROLE_KIND: Record<BibleRole, AssetKind> = { portrait: 'portrait', turnaround: 'turnaround', plate: 'plate', lookbook: 'lookbook' };
export const ASPECT: Record<BibleRole, string> = { portrait: '3:4', turnaround: '16:9', plate: '16:9', lookbook: '16:9' };
/** Order in which a unit's approved assets appear in `entry.refs`. */
const REF_ORDER: BibleRole[] = ['lookbook', 'portrait', 'turnaround', 'plate'];
/** Dependency depth: lookbooks first, then portraits and plates, then turnarounds. */
const WAVE: Record<BibleRole, number> = { lookbook: 1, portrait: 2, plate: 2, turnaround: 3 };

export const bibleEntries = (p: AkukoProject): EntryRef[] => [
  ...p.bible.characters.map((entry) => ({ kind: 'character' as const, entry })),
  ...p.bible.locations.map((entry) => ({ kind: 'location' as const, entry })),
  ...p.bible.styles.map((entry) => ({ kind: 'style' as const, entry })),
];

const BACKGROUND = /^(background|extra|crowd|bystander)/i;
const SUPPORTING = /^supporting/i;

/** The images a bible entry gets (see profiles/film/templates/character.md). */
export function rolesFor(kind: EntryKind, entry: BibleEntry): BibleRole[] {
  if (kind === 'location') return ['plate'];
  if (kind === 'style') return ['lookbook'];
  const r = (entry.role ?? '').trim();
  if (BACKGROUND.test(r)) return [];
  if (SUPPORTING.test(r)) return ['portrait'];
  return ['portrait', 'turnaround'];
}

export const assetIdFor = (entryId: string, role: BibleRole): string => `${entryId}_${role}`;

export const isBibleAsset = (a: Asset): boolean => a.stage === BIBLE_STAGE && a.tags.includes(BIBLE_TAG);
export const bibleAssets = (p: AkukoProject): Asset[] => p.assets.filter(isBibleAsset);

/** The role a planned asset plays, from its `role:<r>` tag. */
export function roleOf(a: Asset): BibleRole {
  const t = a.tags.find((x) => x.startsWith('role:'))?.slice(5);
  if (t && (BIBLE_ROLES as readonly string[]).includes(t)) return t as BibleRole;
  throw new BibleError(`asset "${a.id}" has no bible role tag`);
}

const hasFile = (a: Asset): boolean => a.file !== undefined;

// ─────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────

/**
 * Refuse unless the bible stage is open. The gating rule (lib/state.md
 * §Stages) is that every earlier stage is approved: intake, breakdown and
 * sketch. Every checklist entry must also be approved: the bible starts from
 * the approved entries.
 */
export function assertOpen(p: AkukoProject): void {
  for (const { id } of STAGES) {
    if (id === BIBLE_STAGE) break;
    if (p.stages[id].state !== 'approved') {
      throw new BibleError(`The bible stage is locked: ${id} is "${p.stages[id].state}". It opens when a person has approved every earlier stage (the breakdown's shots and checklist entries, then the sketch board).`);
    }
  }
  const open = bibleEntries(p).filter((e) => e.entry.status !== 'approved');
  if (open.length > 0) {
    throw new BibleError(`These checklist entries are not approved yet: ${open.map((e) => e.entry.id).join(', ')}. The bible starts from approved entries.`);
  }
  if (p.stages.bible.state === 'locked') throw new BibleError('The bible stage is still locked; fold the latest decisions first.');
}

export interface PlanResult { project: AkukoProject; created: string[] }

/**
 * Create the planned assets for every checklist entry that has none. Safe to
 * run again: existing assets are left alone. Moves the stage to `in-progress`
 * the first time.
 */
export function planBible(project: AkukoProject, now: string): PlanResult {
  assertOpen(project);
  const p = structuredClone(project);
  const created: string[] = [];
  for (const { kind, entry } of bibleEntries(p)) {
    for (const role of rolesFor(kind, entry)) {
      const id = assetIdFor(entry.id, role);
      if (p.assets.some((a) => a.id === id)) continue;
      p.assets.push({
        id,
        stage: BIBLE_STAGE,
        status: 'pending',
        comments: [],
        kind: ROLE_KIND[role],
        owner: entry.id,
        name: `${entry.name} - ${role}`,
        tags: [BIBLE_TAG, `role:${role}`],
        updated_at: now,
      });
      created.push(id);
    }
  }
  if (created.length > 0 && p.stages.bible.state === 'not-started') p.stages.bible = { state: 'in-progress' };
  return { project: p, created };
}

// ─────────────────────────────────────────────────────────────────────────
// Readiness
// ─────────────────────────────────────────────────────────────────────────

export type ReadinessState = 'approved' | 'in-review' | 'in-flight' | 'ready' | 'blocked';
export interface Readiness { state: ReadinessState; waiting: string[] }

const lookbooksOf = (p: AkukoProject): Asset[] => bibleAssets(p).filter((a) => roleOf(a) === 'lookbook');
const approvedWithFile = (a: Asset): boolean => a.status === 'approved' && hasFile(a);

/** The assets that must be approved (with a file) before `a` can be generated. */
export function dependenciesOf(p: AkukoProject, a: Asset): Asset[] {
  const role = roleOf(a);
  if (role === 'lookbook') return [];
  const out: Asset[] = [];
  if (role === 'turnaround') {
    const portrait = p.assets.find((x) => x.id === assetIdFor(a.owner ?? '', 'portrait'));
    if (!portrait) throw new BibleError(`${a.id} has no portrait to work from; plan the bible again.`);
    out.push(portrait);
  }
  out.push(...lookbooksOf(p));
  return out;
}

const inFlight = (p: AkukoProject, a: Asset): boolean => p.ledger.some((e) => e.unit === a.id && e.status === 'submitted');

export function unitReadiness(p: AkukoProject, a: Asset): Readiness {
  if (a.status === 'approved' && hasFile(a)) return { state: 'approved', waiting: [] };
  if (hasFile(a) && a.status === 'pending-review') return { state: 'in-review', waiting: [] };
  if (inFlight(p, a)) return { state: 'in-flight', waiting: [] };
  const waiting = dependenciesOf(p, a).filter((d) => !approvedWithFile(d)).map((d) => d.id);
  if (waiting.length > 0) return { state: 'blocked', waiting };
  // pending, needs-rework, or a draft whose file has not come back yet
  return { state: 'ready', waiting: [] };
}

export interface StatusRow {
  entry: string;
  entry_kind: EntryKind;
  role: BibleRole;
  asset: string;
  status: Asset['status'];
  state: ReadinessState;
  waiting: string[];
  /** Refs this image was generated against that have since been sent back or replaced. */
  superseded: string[];
}

/** One row per planned image, for the status report. */
export function bibleStatus(p: AkukoProject): StatusRow[] {
  const kinds = new Map(bibleEntries(p).map((e) => [e.entry.id, e.kind]));
  return bibleAssets(p).map((a) => {
    const r = unitReadiness(p, a);
    return { entry: a.owner ?? '', entry_kind: kinds.get(a.owner ?? '') ?? 'character', role: roleOf(a), asset: a.id, status: a.status, state: r.state, waiting: r.waiting, superseded: supersededRefs(p, a) };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────

const fileUri = (a: Asset): string => {
  if (!a.file) throw new BibleError(`asset "${a.id}" has no file`);
  return a.file.uri;
};

/** Text of the styles, used as the written part of "the film's look" in every prompt. */
function lookText(p: AkukoProject): string {
  return p.bible.styles
    .map((s) => [s.name + (s.description ? `: ${s.description}` : ''), ...s.notes].join('. ').replace(/\.\.+/g, '.'))
    .join(' | ');
}

const entryOf = (p: AkukoProject, id: string): EntryRef => {
  const e = bibleEntries(p).find((x) => x.entry.id === id);
  if (!e) throw new BibleError(`unknown bible entry "${id}"`);
  return e;
};

/** What a person asked for the last time they sent this unit back. */
export function requestedChanges(a: Asset): string {
  const comments = [...a.comments].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  const sentBack = [...comments].reverse().find((c) => c.author === 'agent' && c.decision !== undefined && /→ needs-rework$/.test(c.text));
  const since = sentBack ? comments.filter((c) => c.ts >= sentBack.ts) : comments;
  return since.filter((c) => c.author !== 'agent' && c.text.trim() !== '').map((c) => c.text.trim()).join(' ');
}

function refsFor(p: AkukoProject, a: Asset): JobRef[] {
  const role = roleOf(a);
  const entry = entryOf(p, a.owner ?? '');
  const refs: JobRef[] = [];
  if (role === 'turnaround') {
    const portrait = dependenciesOf(p, a)[0]!;
    refs.push({ id: portrait.id, uri: fileUri(portrait), role: 'character', note: 'the approved portrait: same face, hair, age and build' });
  }
  for (const l of role === 'lookbook' ? [] : lookbooksOf(p)) {
    refs.push({ id: l.id, uri: fileUri(l), role: 'style', note: 'the approved lookbook: match its light, palette and grain' });
  }
  // Pictures the person supplied for this entry (kind `reference`).
  for (const x of p.assets) {
    if (x.kind === 'reference' && x.owner === entry.entry.id && hasFile(x)) {
      refs.push({ id: x.id, uri: fileUri(x), role: entry.kind, note: 'supplied by the person' });
    }
  }
  return refs;
}

const hash8 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);

/** A job has run once any output carries its tag or any ledger entry is in flight or done. */
export function jobRan(p: AkukoProject, id: string): boolean {
  return p.ledger.some((e) => e.job === id && (e.status === 'submitted' || e.status === 'done')) || p.assets.some((a) => a.tags.includes(jobTag(id)));
}

/**
 * Deterministic job id for a set of units: `job_bible_w<wave>_<hash>_r<n>`.
 * The same units give the same id until that job has run; after a person
 * sends one back, regenerating it is the next `r<n>`, which needs its own approval.
 */
export function bibleJobId(p: AkukoProject, wave: number, units: string[], provider = '', model = ''): string {
  // Provider and model are part of the id (as for key frames): an approval binds to one provider and model, so changing either is a new job with a fresh approval.
  const base = `job_bible_w${wave}_${hash8([[...units].sort().join('|'), provider, model].join('#'))}`;
  let n = 1;
  while (jobRan(p, `${base}_r${n}`)) n++;
  return `${base}_r${n}`;
}

export interface BuildOptions {
  provider: string;
  model?: string;
  /** Asset ids to generate. Default: every unit that is ready, in the earliest wave that has any. */
  units?: string[];
  /** Directory of the film templates; defaults to the shipped ones. */
  templates?: string;
}

export interface BuiltJob { job: Job; wave: number; units: string[] }

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Build one job for the units that can be generated now. It never submits
 * anything: hand the result to `gate.run()`. Refuses a unit whose references
 * are not yet approved, so "a labelled turnaround referencing the approved
 * portrait" is enforced here, not left to the agent.
 */
export function buildBibleJob(p: AkukoProject, o: BuildOptions): BuiltJob {
  assertOpen(p);
  const all = bibleAssets(p);
  const byId = new Map(all.map((a) => [a.id, a]));
  let chosen: Asset[];
  if (o.units) {
    chosen = o.units.map((id) => {
      const a = byId.get(id);
      if (!a) throw new BibleError(`"${id}" is not a planned bible asset; run plan first.`);
      const r = unitReadiness(p, a);
      if (r.state !== 'ready') throw new BibleError(`${id} cannot be generated now (${r.state}${r.waiting.length ? `; waiting for a person to approve ${r.waiting.join(', ')}` : ''}).`);
      return a;
    });
  } else {
    const ready = all.filter((a) => unitReadiness(p, a).state === 'ready');
    const first = Math.min(...ready.map((a) => WAVE[roleOf(a)]));
    chosen = ready.filter((a) => WAVE[roleOf(a)] === first);
  }
  if (chosen.length === 0) {
    const stuck = bibleStatus(p).filter((r) => r.state === 'blocked').map((r) => `${r.asset} (waiting for ${r.waiting.join(', ')})`);
    throw new BibleError(stuck.length ? `Nothing can be generated yet: ${stuck.join('; ')}.` : 'Nothing is waiting to be generated.');
  }
  if (new Set(chosen.map((a) => a.id)).size !== chosen.length) throw new BibleError('a unit was listed twice');

  const look = lookText(p);
  const items: JobItem[] = chosen.map((a) => {
    const role = roleOf(a);
    const { entry } = entryOf(p, a.owner ?? '');
    const ctx: PromptContext = {
      name: entry.name,
      role: entry.role ?? '',
      description: entry.description ?? '',
      notes: entry.notes.join('; '),
      look,
    };
    const changes = requestedChanges(a);
    const asked = (a.status === 'needs-rework' || a.status === 'draft') && changes !== '' ? changes : '';
    const prompt = promptFor(role, ctx, o.templates) + (asked ? `\nChanges the person asked for: ${asked}` : '');
    const refs = refsFor(p, a);
    if (refs.length > MAX_REFS) {
      throw new BibleError(`${a.id} would send ${refs.length} reference images; the image providers accept at most ${MAX_REFS}. Remove some supplied references.`);
    }
    return { unit: a.id, prompt, output: ROLE_KIND[role], aspect_ratio: ASPECT[role], count: 1, ...(refs.length ? { refs } : {}) };
  });

  const wave = Math.max(...chosen.map((a) => WAVE[roleOf(a)]));
  const units = chosen.map((a) => a.id);
  const counts = BIBLE_ROLES.map((r) => [r, chosen.filter((a) => roleOf(a) === r).length] as const).filter(([, n]) => n > 0);
  const job: Job = {
    id: bibleJobId(p, wave, units, o.provider, o.model ?? ''),
    stage: BIBLE_STAGE,
    kind: 'image',
    provider: o.provider,
    ...(o.model !== undefined ? { model: o.model } : {}),
    label: `Bible: ${counts.map(([r, n]) => plural(n, r)).join(', ')}`,
    items,
  };
  return { job, wave, units };
}

/** Short fingerprint of a file: its uri, plus its hash when the host recorded one. */
const fingerprint = (a: Asset): string => hash8(`${a.file?.uri ?? ''}|${a.file?.hash ?? ''}`);
const FROM = 'from:';

/**
 * Record, on each unit of a job, which reference files it is generated from
 * (`from:<ref id>@<fingerprint>` tags; no schema change). Replaces any earlier
 * stamp, so it always describes the latest take.
 */
export function stampRefs(project: AkukoProject, job: Job): AkukoProject {
  const p = structuredClone(project);
  for (const item of job.items) {
    const a = p.assets.find((x) => x.id === item.unit);
    if (!a) continue;
    const stamps = (item.refs ?? [])
      .map((r) => p.assets.find((x) => x.id === r.id))
      .filter((r): r is Asset => r !== undefined && r.stage === BIBLE_STAGE && r.tags.includes(BIBLE_TAG) && hasFile(r))
      .map((r) => `${FROM}${r.id}@${fingerprint(r)}`);
    a.tags = [...a.tags.filter((t) => !t.startsWith(FROM)), ...stamps];
  }
  return p;
}

/**
 * Ids of the references a produced image was generated against that are no
 * longer what it was made from: sent back, no longer approved, or replaced.
 * Reporting only. A dependent is never changed by code; only a person sends one back.
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

// ─────────────────────────────────────────────────────────────────────────
// Status moves an action may make
// ─────────────────────────────────────────────────────────────────────────

/**
 * Before a run: `pending → draft`. A unit a person sent back
 * (`needs-rework`) becomes `draft` with its old file cleared, so the new take
 * fills the same asset in place; the old file stays where it was stored and
 * the "Revised:" comment says where. Units already `draft` are left alone, so
 * this is safe to call again.
 */
export function beginUnits(project: AkukoProject, ids: string[], ts: string): AkukoProject {
  const p = structuredClone(project);
  for (const id of ids) {
    const a = p.assets.find((x) => x.id === id);
    if (!a) throw new BibleError(`unknown asset "${id}"`);
    if (a.status === 'pending') {
      a.status = 'draft';
    } else if (a.status === 'needs-rework') {
      const prev = a.file?.uri;
      delete a.file;
      a.status = 'draft';
      a.comments.push({ ts, stage: BIBLE_STAGE, author: 'agent', text: `Revised: regenerating after the requested changes${prev ? `; the previous take stays at ${prev}` : ''}` });
    } else {
      continue;
    }
    a.by_stage = { ...(a.by_stage ?? {}), [BIBLE_STAGE]: { status: 'draft' } };
    a.updated_at = ts;
  }
  return p;
}

/**
 * A run was not accepted (the gate refused, or the provider failed before
 * anything landed): put units that `beginUnits` just moved back exactly as
 * they were. Only a unit that is still `draft` with no file is touched.
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
 * A bible image that is `approved` or `pending-review` must have a file. If
 * one has none (an undo restored a status after the action had cleared the
 * file for a revision), set it back to `pending` with a comment. This is a
 * code-side status move, allowed only because there is no image: nothing a
 * person approved or is reviewing still exists. It never writes `approved`.
 */
export function repairFileless(project: AkukoProject, ts: string): { project: AkukoProject; repaired: string[] } {
  const p = structuredClone(project);
  const repaired: string[] = [];
  for (const a of bibleAssets(p)) {
    if ((a.status === 'approved' || a.status === 'pending-review') && !hasFile(a)) {
      a.status = 'pending';
      a.by_stage = { ...(a.by_stage ?? {}), [BIBLE_STAGE]: { status: 'pending' } };
      a.comments.push({ ts, stage: BIBLE_STAGE, author: 'agent', text: 'Revised: restored without an image; needs generating' });
      a.updated_at = ts;
      repaired.push(a.id);
    }
  }
  return { project: p, repaired };
}

/**
 * Set each entry's `refs[]` to its approved visual assets (lookbook, portrait,
 * turnaround, plate), keeping any ref that is not a bible asset of that entry.
 * Reads statuses; never writes one. An asset a person un-approves drops out.
 */
export function syncRefs(project: AkukoProject, ts: string): { project: AkukoProject; changed: string[] } {
  const p = structuredClone(project);
  const changed: string[] = [];
  const mine = bibleAssets(p);
  for (const { entry } of bibleEntries(p)) {
    const owned = mine.filter((a) => a.owner === entry.id);
    const approved = owned
      .filter(approvedWithFile)
      .sort((a, b) => REF_ORDER.indexOf(roleOf(a)) - REF_ORDER.indexOf(roleOf(b)))
      .map((a) => a.id);
    const ownedIds = new Set(owned.map((a) => a.id));
    const next = [...approved, ...entry.refs.filter((r) => !ownedIds.has(r))];
    if (next.length !== entry.refs.length || next.some((r, i) => r !== entry.refs[i])) {
      entry.refs = next;
      entry.updated_at = ts;
      changed.push(entry.id);
    }
  }
  return { project: p, changed };
}

/** Keep `stages.bible.state` honest after the units moved. Never touches `approved` or `locked`. */
export function refreshStageState(project: AkukoProject): AkukoProject {
  const rec = project.stages.bible;
  if (rec.state === 'locked') return project;
  const units = bibleAssets(project);
  if (units.length === 0) return project;
  // An approved stage stays approved only while every image is approved and has its file.
  if (rec.state === 'approved' && units.every((a) => a.status === 'approved' && hasFile(a))) return project;
  const todo = units.filter((a) => a.status === 'pending' || a.status === 'draft' || a.status === 'needs-rework');
  let state: typeof rec.state;
  if (todo.length > 0) {
    const ids = new Set(todo.map((a) => a.id));
    const waiting = project.pending_spend.some((j) => j.stage === BIBLE_STAGE && j.status === 'awaiting-approval' && j.units.some((u) => ids.has(u)));
    state = waiting ? 'waiting-spend' : 'in-progress';
  } else {
    state = 'in-review';
  }
  if (state === rec.state) return project;
  return { ...project, stages: { ...project.stages, bible: { state } } };
}
