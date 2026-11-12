/**
 * akuko — turn a breakdown proposal into `AkukoProject` content.
 *
 * The judgement (what the scenes are, where to cut, which shots, what the
 * checklist contains) is the agent's, and arrives as a `BreakdownProposal`:
 * plain JSON with no ids. Everything mechanical lives here and is tested:
 *   - the proposal is checked first, and a bad one is rejected whole;
 *   - scene, shot, beat and bible ids are allocated by code, never by the agent;
 *   - the result is a schema-valid project, with every new unit at
 *     `pending-review` (never `approved`);
 *   - running it again on a project that already has shots changes nothing.
 */

import { z } from 'zod';
import {
  AkukoProjectSchema,
  CameraMoveAkukoSchema,
  ShotTypeAkukoSchema,
  type AkukoProject,
  type BibleEntry,
  type Beat,
  type Scene,
  type Shot,
} from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { lintShots, type LintIssue, type LintOptions } from './lint.ts';
import { allocateShotId, insertTags, sceneIdFor, sceneNumberOf, stripTags, type Placement, type TagResult } from './tags.ts';

// ── the proposal the agent writes ───────────────────────────────────────

const ChecklistEntrySchema = z.object({
  name: z.string().min(1),
  role: z.string().optional().describe('Characters: Principal, Supporting or Background. Locations and styles: leave out.'),
  description: z.string().optional(),
  notes: z.array(z.string()).default([]),
}).strict();
export type ChecklistEntry = z.infer<typeof ChecklistEntrySchema>;

const ProposedSceneSchema = z.object({
  n: z.number().int().positive().describe('Scene number in screenplay order, starting at 1.'),
  heading: z.string().optional(),
  summary: z.string().optional(),
  act: z.string().optional(),
  sequence: z.string().optional(),
}).strict();

const ProposedShotSchema = z.object({
  scene: z.number().int().positive().describe('Scene number (matches scenes[].n).'),
  beat: z.string().optional().describe('Short description of the story beat. Shots sharing a scene and beat text share one beat.'),
  shot_type: ShotTypeAkukoSchema.default('unset'),
  camera: z.string().optional(),
  camera_move: CameraMoveAkukoSchema.default('unset'),
  action: z.string().min(1),
  duration_s: z.number().positive(),
  script_line: z.string().optional().describe('The screenplay or story text this shot covers, copied exactly.'),
  characters: z.array(z.string()).default([]).describe('Names from the checklist, as they appear in frame.'),
  location: z.string().optional().describe('Name from the checklist.'),
  narration: z.string().nullable().optional(),
  intent: z.string().optional(),
  notes: z.string().optional(),
  prompt: z.string().optional(),
}).strict();
export type ProposedShot = z.infer<typeof ProposedShotSchema>;

export const BreakdownProposalSchema = z.object({
  scenes: z.array(ProposedSceneSchema).min(1),
  shots: z.array(ProposedShotSchema).min(1),
  checklist: z.object({
    characters: z.array(ChecklistEntrySchema).default([]),
    locations: z.array(ChecklistEntrySchema).default([]),
    styles: z.array(ChecklistEntrySchema).default([]),
  }).strict().default({}),
}).strict();
export type BreakdownProposal = z.infer<typeof BreakdownProposalSchema>;
export type BreakdownProposalInput = z.input<typeof BreakdownProposalSchema>;

export class ProposalError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`akuko: the breakdown proposal is not usable:\n- ${problems.join('\n- ')}`);
    this.name = 'ProposalError';
    this.problems = problems;
  }
}

const key = (s: string) => s.trim().toLowerCase();

/** Problems with a proposal beyond its shape: unknown names, duplicate scenes. Empty means usable. */
export function checkProposal(input: unknown): { proposal?: BreakdownProposal; problems: string[] } {
  const parsed = BreakdownProposalSchema.safeParse(input);
  if (!parsed.success) {
    return { problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'proposal'}: ${i.message}`) };
  }
  const p = parsed.data;
  const problems: string[] = [];
  const sceneNs = new Set<number>();
  for (const s of p.scenes) {
    if (sceneNs.has(s.n)) problems.push(`scene ${s.n} is listed twice`);
    sceneNs.add(s.n);
  }
  const chars = new Set(p.checklist.characters.map((c) => key(c.name)));
  const locs = new Set(p.checklist.locations.map((c) => key(c.name)));
  for (const [kind, list] of [['character', p.checklist.characters], ['location', p.checklist.locations], ['style', p.checklist.styles]] as const) {
    const names = new Set<string>();
    for (const e of list) {
      if (names.has(key(e.name))) problems.push(`${kind} "${e.name}" is listed twice in the checklist`);
      names.add(key(e.name));
    }
  }
  p.shots.forEach((s, i) => {
    const at = `shots[${i}]`;
    if (!sceneNs.has(s.scene)) problems.push(`${at}: scene ${s.scene} is not in scenes[]`);
    for (const c of s.characters) if (!chars.has(key(c))) problems.push(`${at}: character "${c}" is not in the checklist`);
    if (s.location !== undefined && !locs.has(key(s.location))) problems.push(`${at}: location "${s.location}" is not in the checklist`);
  });
  return problems.length > 0 ? { problems } : { proposal: p, problems };
}

// ── applying it ─────────────────────────────────────────────────────────

export interface ApplyOptions {
  now?: () => Date;
  lint?: LintOptions;
}

export interface ApplyResult {
  project: AkukoProject;
  /** True when nothing was created because the project already has a breakdown. */
  skipped: boolean;
  reason?: string;
  created: { scenes: number; beats: number; shots: number; characters: number; locations: number; styles: number };
  lint: LintIssue[];
}

const NONE = { scenes: 0, beats: 0, shots: 0, characters: 0, locations: 0, styles: 0 };

/** True when a breakdown already exists, so a re-run must only (re)tag. */
export function alreadyBrokenDown(p: AkukoProject): boolean {
  return p.shots.length > 0 || p.scenes.length > 0;
}

function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.length > 0 ? out : 'x';
}

function uniqueId(prefix: string, name: string, taken: Set<string>): string {
  const base = `${prefix}_${slug(name)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Write a breakdown into the project. Pure: returns a new project and does not
 * touch the input. On a project that already has shots or scenes it returns
 * the project unchanged (`skipped: true`): creating a second set of shots next
 * to an existing one is the one unrecoverable mistake (lifted from
 * `studio-breakdown`). Use `planRetag` to add missing script tags instead.
 *
 * Throws `ProposalError` for an unusable proposal and when the intake stage is
 * still locked. Lint errors do not throw: they are returned so the agent can
 * fix the proposal before anything is written.
 */
export function applyBreakdown(project: AkukoProject, input: unknown, opts: ApplyOptions = {}): ApplyResult {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  if (alreadyBrokenDown(project)) {
    return {
      project: structuredClone(project),
      skipped: true,
      reason: 'this project already has a breakdown; nothing was created (use the tag step to add missing script tags)',
      created: { ...NONE },
      lint: lintShots(project, opts.lint),
    };
  }
  if (project.stages.breakdown.state === 'locked') {
    throw new ProposalError(['the breakdown stage is locked: intake must be approved first']);
  }
  const checked = checkProposal(input);
  if (!checked.proposal) throw new ProposalError(checked.problems);
  const prop = checked.proposal;

  const out = structuredClone(project);
  const taken = new Set<string>();
  const ts = { updated_at: now };

  // scenes, in screenplay order
  const scenes: Scene[] = [...prop.scenes]
    .sort((a, b) => a.n - b.n)
    .map((s) => ({
      id: sceneIdFor(s.n),
      ...(s.heading !== undefined && { heading: s.heading }),
      ...(s.summary !== undefined && { summary: s.summary }),
    }));
  out.scenes = scenes;

  // checklist -> bible entries (re-use an entry that already has the same name)
  const entry = (e: ChecklistEntry, prefix: string, existing: BibleEntry[]): { entry: BibleEntry; isNew: boolean } => {
    const found = existing.find((x) => key(x.name) === key(e.name));
    if (found) return { entry: found, isNew: false };
    const content = [e.role ? `${e.role}.` : '', e.description ?? ''].join(' ').trim();
    const status = 'pending-review' as const;
    return {
      isNew: true,
      entry: {
        id: uniqueId(prefix, e.name, taken),
        stage: 'breakdown',
        status,
        comments: [],
        by_stage: { breakdown: { status, ...(content !== '' && { content }) } },
        name: e.name,
        ...(e.role !== undefined && { role: e.role }),
        ...(e.description !== undefined && { description: e.description }),
        notes: e.notes,
        refs: [],
        ...ts,
      },
    };
  };
  for (const e of [...out.bible.characters, ...out.bible.locations, ...out.bible.styles]) taken.add(e.id);
  const created = { ...NONE, scenes: scenes.length };
  const charIds = new Map<string, string>();
  const locIds = new Map<string, string>();
  const styleIds: string[] = [];
  for (const c of prop.checklist.characters) {
    const r = entry(c, 'char', out.bible.characters);
    if (r.isNew) { out.bible.characters.push(r.entry); created.characters++; }
    charIds.set(key(c.name), r.entry.id);
  }
  for (const c of prop.checklist.locations) {
    const r = entry(c, 'loc', out.bible.locations);
    if (r.isNew) { out.bible.locations.push(r.entry); created.locations++; }
    locIds.set(key(c.name), r.entry.id);
  }
  for (const c of prop.checklist.styles) {
    const r = entry(c, 'style', out.bible.styles);
    if (r.isNew) { out.bible.styles.push(r.entry); created.styles++; }
    styleIds.push(r.entry.id);
  }

  // beats and shots, in the order the agent gave them
  const shotIds: string[] = out.shots.map((s) => s.id);
  const beatIdByKey = new Map<string, string>();
  const beatCount = new Map<number, number>();
  const beats: Beat[] = [];
  const shots: Shot[] = [];
  const sceneAct = new Map(prop.scenes.map((s) => [s.n, s]));
  for (const ps of prop.shots) {
    const id = allocateShotId(shotIds, ps.scene);
    shotIds.push(id);
    const beatKey = `${ps.scene}|${ps.beat !== undefined ? key(ps.beat) : id}`;
    let beatId = beatIdByKey.get(beatKey);
    if (beatId === undefined) {
      const k = (beatCount.get(ps.scene) ?? 0) + 1;
      beatCount.set(ps.scene, k);
      beatId = `${sceneIdFor(ps.scene)}_b${k}`;
      beatIdByKey.set(beatKey, beatId);
      const sc = sceneAct.get(ps.scene);
      beats.push({
        id: beatId,
        scene_id: sceneIdFor(ps.scene),
        shot_id: id,
        vo: ps.narration ?? '',
        action: ps.beat ?? ps.action,
        duration_ms: 0,
        sfx: [],
        metadata: {
          ...(sc?.act !== undefined && { act: sc.act }),
          ...(sc?.sequence !== undefined && { sequence: sc.sequence }),
        },
      });
    }
    const beat = beats.find((b) => b.id === beatId)!;
    beat.duration_ms += Math.round(ps.duration_s * 1000);

    const refs = [
      ...ps.characters.map((c) => charIds.get(key(c))!),
      ...(ps.location !== undefined ? [locIds.get(key(ps.location))!] : []),
      ...styleIds,
    ];
    const status = 'pending-review' as const;
    shots.push({
      id,
      stage: 'breakdown',
      status,
      comments: [],
      by_stage: { breakdown: { status, content: ps.action } },
      scene: sceneIdFor(ps.scene),
      beat: beatId,
      shot_type: ps.shot_type,
      ...(ps.camera !== undefined && { camera: ps.camera }),
      camera_move: ps.camera_move,
      action: ps.action,
      duration_s: ps.duration_s,
      ...(ps.prompt !== undefined && { prompt: ps.prompt }),
      refs: [...new Set(refs)],
      ...(ps.script_line !== undefined && { script_line: ps.script_line }),
      ...(ps.narration !== undefined && { narration: ps.narration }),
      ...(ps.intent !== undefined && { intent: ps.intent }),
      ...(ps.notes !== undefined && { notes: ps.notes }),
      blocking: [],
      ...ts,
    });
    created.shots++;
  }
  created.beats = beats.length;
  out.shots = shots;
  out.script.beats = beats;

  out.stages.breakdown = { state: 'in-review' };
  out.current_stage = 'breakdown';
  out.project.updated_at = now;

  // Final gate: the whole project must still be valid and consistent.
  const valid = AkukoProjectSchema.parse(out);
  const integrity = checkIntegrity(valid);
  if (integrity.length > 0) throw new ProposalError(integrity.map((i) => `${i.path}: ${i.message}`));
  return { project: valid, skipped: false, created, lint: lintShots(valid, opts.lint) };
}

// ── tagging an existing breakdown ───────────────────────────────────────

/** Placements for every shot in the project, for `insertTags`. */
export function placementsFor(project: AkukoProject): Placement[] {
  return project.shots.map((s) => {
    const scene = sceneNumberOf(s.scene);
    return {
      shotId: s.id,
      ...(scene !== undefined && { scene }),
      ...(s.script_line !== undefined && { scriptLine: s.script_line }),
    };
  });
}

/**
 * Tag the script for a project that already has shots. Creates, deletes and
 * reorders nothing in the project; only returns the script with the missing
 * `[[sc<N>_sh<M>]]` notes added. `prose: true` tags the source text on the
 * direct route.
 */
export function planRetag(project: AkukoProject, scriptText: string, opts: { prose?: boolean } = {}): TagResult {
  return insertTags(scriptText, placementsFor(project), opts);
}

// ── the tagged copy (B-3) ───────────────────────────────────────────────

/**
 * Where the shot-tagged copy of an approved script lives: the same path with
 * `.tagged` before the extension (`script/screenplay.fountain` ->
 * `script/screenplay.tagged.fountain`, `script/source.md` ->
 * `script/source.tagged.md`). On host A the same name is the stored file's name.
 */
export function taggedPathFor(scriptPath: string): string {
  const slash = scriptPath.lastIndexOf('/');
  const dot = scriptPath.lastIndexOf('.');
  return dot > slash + 1 ? `${scriptPath.slice(0, dot)}.tagged${scriptPath.slice(dot)}` : `${scriptPath}.tagged`;
}

export interface TaggedCopy extends TagResult {
  /** True when an earlier tagged copy no longer matched the approved script (it was edited, or the copy was), so the copy was rebuilt from the approved text. */
  rebuilt: boolean;
}

/**
 * Tag a project's script WITHOUT touching the approved file (B-3). A person
 * approved the intake script (`script-screenplay`, or `script-source` on the
 * direct route); an approved unit's content never changes silently. Shot tags
 * are annotations, so they go into a derived copy that is not a review unit:
 * `script.tagged` points at it, the approved asset keeps pointing at the file
 * the person approved, and no asset is added for the copy.
 *
 * `approved` is the approved script's text, `copy` the current tagged copy (if
 * any). The copy is reused while it is the approved text plus tags; otherwise it
 * is rebuilt from the approved text. Pure; the caller stores `text` as the copy
 * and records it with `withTaggedCopy`.
 */
export function tagScriptCopy(project: AkukoProject, approved: string, copy: string | undefined, opts: { prose?: boolean } = {}): TaggedCopy {
  const reuse = copy !== undefined && stripTags(copy) === stripTags(approved);
  return { ...planRetag(project, reuse ? copy : approved, opts), rebuilt: copy !== undefined && !reuse };
}

/** The project with `script.tagged` set to the stored copy. Touches nothing else: no asset, no status. */
export function withTaggedCopy(project: AkukoProject, uri: string): AkukoProject {
  if (project.script.tagged === uri) return project;
  return { ...project, script: { ...project.script, tagged: uri } };
}
