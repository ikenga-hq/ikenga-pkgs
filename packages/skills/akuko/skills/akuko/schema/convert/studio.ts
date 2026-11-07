/**
 * Studio `storyboard.json` ⇄ `akuko.json`.
 *
 * fromStudio — lossless. Every Studio field lands either in a first-class
 * akuko field or in the typed `studio` slot on the project / shot / asset, so
 * `toStudio(fromStudio(x))` deep-equals the Studio-normalised `x`
 * (`ProjectSchema.parse(x)`; for an already-normalised document, `x` itself).
 *
 *   Studio project                 akuko
 *   ─────────────────────────────  ─────────────────────────────────────────
 *   slug, title, created_at,       project.*
 *     updated_at, aspect_ratio,
 *     resolution
 *   archetype_id                   project.profile (narrative → film) + studio.archetype_id
 *   current_rung 0 / 1 / 2         current_stage breakdown / sketch / keyframes
 *   anchors[]                      assets[] (kind "reference", studio.anchor keeps kind + metadata)
 *   script.beats[]                 script.beats[] (same shape); scene_ids → scenes[]
 *   script (header fields)         studio.script
 *   narration, audio_analysis      audio.narration, audio.analysis
 *   mode, approved, metadata,      studio.*
 *     selected_concepts(_note)
 *   unknown keys                   studio.extra
 *
 *   Studio cell                    akuko shot
 *   ─────────────────────────────  ─────────────────────────────────────────
 *   uid, beat_id, label            id, beat, label (scene from the beat's scene_id)
 *   rung                           stage (0 breakdown · 1 sketch · 2 keyframes)
 *   rungs{…}                       by_stage{breakdown, sketch, keyframes} (still → output)
 *   approved + rungs[rung].status  status (see statusFromCell)
 *   comments{ts ms, rung}          comments{ts ISO, stage, author "unknown"}
 *   shot_type, camera_move,        shot_type, camera_move, camera, action, prompt,
 *     camera_text, action, prompt,   refs, seed, narration, intent, notes,
 *     anchors, seed,                 duration_s (ms ÷ 1000), updated_at
 *     narration_excerpt, intent,
 *     notes, duration_ms, last_edited
 *   index, time, frames, renderer, studio.* (engine wiring + render state, which
 *     content_path, reference_layer, Studio owns)
 *     audio_cue, block_id, renders,
 *     metadata
 *   unknown keys                   studio.extra
 *
 * toStudio — a projection. A project that came from Studio goes back
 * unchanged. For an akuko-born project, Studio has no place for the bibles,
 * scenes, budget, pending spend, ledger, decisions, host, stage states,
 * logline / source / runtime / notes, shot blocking and script lines, so those
 * are not written; engine wiring gets Studio defaults; bible refs on shots are
 * expanded to the bible entry's asset ids; akuko-only shot types and camera
 * moves fall back to the nearest Studio value (the free-text camera note
 * keeps the original wording).
 */

import {
  CellSchema,
  ProjectSchema,
  rungDir,
} from '@ikenga/studio-schema';
import type {
  Anchor,
  BeatStatus,
  CameraMove,
  Cell,
  Project as StudioProject,
  Rung,
  Script as StudioScript,
  ScriptArchetype,
  ShotType,
} from '@ikenga/studio-schema';
import {
  AKUKO_FORMAT,
  AKUKO_SCHEMA_VERSION,
  AkukoProjectSchema,
  ID_PATTERN,
  STAGE_NUMBER,
  defaultStages,
} from '../akuko-project.ts';
import type {
  AkukoCameraMove,
  AkukoProject,
  AkukoShotType,
  Asset,
  ByStage,
  Comment,
  Shot,
  StageId,
  UnitStatus,
} from '../akuko-project.ts';

export class StudioConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioConversionError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Rung ⇄ stage
// ─────────────────────────────────────────────────────────────────────────

/** Studio rung → the akuko stage that produces the same thing. */
export const RUNG_STAGE: Record<Rung, StageId> = {
  '0_beat_sheet': 'breakdown',
  '1_lofi': 'sketch',
  '2_hifi': 'keyframes',
};
const RUNG_BY_NUMBER: Rung[] = ['0_beat_sheet', '1_lofi', '2_hifi'];

/**
 * akuko stage → nearest Studio rung: intake/breakdown → beat sheet,
 * sketch/bible → lo-fi, key frames and later → hi-fi. Inverse of RUNG_STAGE
 * on the three rung stages.
 */
export function stageToRung(stage: StageId): Rung {
  const n = STAGE_NUMBER[stage];
  if (n <= 1) return '0_beat_sheet';
  if (n <= 3) return '1_lofi';
  return '2_hifi';
}
const rungNumber = (r: Rung): number => RUNG_BY_NUMBER.indexOf(r);

function rungFromNumber(n: number): Rung {
  const r = RUNG_BY_NUMBER[n];
  if (!r) throw new StudioConversionError(`rung ${n} is outside 0–2`);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────

/** Drop `undefined` values so outputs compare cleanly and serialise the same. */
const toJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Keys present on `obj` that the Zod `shape` does not declare (Studio passthrough keys). */
function unknownKeys(obj: Record<string, unknown>, shape: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!(k in shape)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

function msToIso(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new StudioConversionError(`comment timestamp ${ms} is not a valid time`);
  return d.toISOString();
}

const PROFILE_FOR_ARCHETYPE: Record<string, string> = { narrative: 'film' };
function profileForArchetype(archetypeId: string): string {
  const mapped = PROFILE_FOR_ARCHETYPE[archetypeId];
  if (mapped) return mapped;
  return ID_PATTERN.test(archetypeId) ? archetypeId : 'custom';
}

function archetypeForProfile(profile: string): string {
  return profile === 'film' ? 'narrative' : profile;
}

const SCRIPT_ARCHETYPES: readonly ScriptArchetype[] = [
  'explainer', 'product', 'ai_short', 'narrative', 'montage', 'tutorial', 'music_video', 'custom',
];
function scriptArchetypeForProfile(profile: string): ScriptArchetype {
  const a = archetypeForProfile(profile).replace(/-/g, '_') as ScriptArchetype;
  return SCRIPT_ARCHETYPES.includes(a) ? a : 'custom';
}

/**
 * Shot status from a Studio cell. Studio's live approval signal is
 * `cell.approved`; per-rung status is secondary. The mapping is invertible:
 *   approved                          → "approved"
 *   not approved, rung "approved"     → "pending-review" (needs a person's look)
 *   not approved, any other rung      → that rung status
 * `toStudio` reads `approved` back from `status` and the rung status from
 * `by_stage`, so every combination survives.
 */
function statusFromCell(cell: Cell): UnitStatus {
  if (cell.approved) return 'approved';
  const r = cell.rungs[cell.rung].status;
  return r === 'approved' ? 'pending-review' : r;
}

const toStudioStatus = (s: UnitStatus): BeatStatus => (s === 'draft' ? 'pending' : s);

const SHOT_TYPE_TO_STUDIO: Partial<Record<AkukoShotType, ShotType>> = { overhead: 'unset' };
const toStudioShotType = (t: AkukoShotType): ShotType => SHOT_TYPE_TO_STUDIO[t] ?? (t as ShotType);

const MOVE_TO_STUDIO: Partial<Record<AkukoCameraMove, CameraMove>> = {
  'push-in': 'dolly',
  'pull-out': 'dolly',
  'whip-pan': 'pan',
};
const toStudioMove = (m: AkukoCameraMove): CameraMove => MOVE_TO_STUDIO[m] ?? (m as CameraMove);

/** Studio anchor kind for an akuko asset that has no anchor record of its own. */
function anchorKindForAsset(a: Asset): Anchor['kind'] {
  switch (a.kind) {
    case 'sheet': case 'portrait': case 'turnaround': return 'character';
    case 'plate': return 'location';
    case 'lookbook': return 'style';
    case 'panel': return 'sketch';
    case 'clip': return 'video';
    case 'vo': case 'music': case 'sfx': return 'audio';
    default: return 'image';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Studio → akuko
// ─────────────────────────────────────────────────────────────────────────

function shotFromCell(cell: Cell, sceneOfBeat: Map<string, string>): Shot {
  const r0 = cell.rungs['0_beat_sheet'];
  const r1 = cell.rungs['1_lofi'];
  const r2 = cell.rungs['2_hifi'];
  const byStage: ByStage = {
    breakdown: { status: r0.status, content: r0.content },
    sketch: { status: r1.status, output: r1.still },
    keyframes: { status: r2.status, output: r2.still },
  };
  const comments: Comment[] = cell.comments.map((c) => ({
    ts: msToIso(c.ts),
    stage: RUNG_STAGE[rungFromNumber(c.rung)],
    author: 'unknown',
    text: c.text,
  }));
  return {
    id: cell.uid,
    stage: RUNG_STAGE[cell.rung],
    status: statusFromCell(cell),
    comments,
    by_stage: byStage,
    updated_at: cell.last_edited,
    scene: sceneOfBeat.get(cell.beat_id),
    beat: cell.beat_id,
    label: cell.label,
    shot_type: cell.shot_type,
    camera: cell.camera_text,
    camera_move: cell.camera_move,
    action: cell.action,
    duration_s: cell.duration_ms / 1000,
    prompt: cell.prompt,
    refs: cell.anchors,
    seed: cell.seed,
    narration: cell.narration_excerpt,
    intent: cell.intent,
    notes: cell.notes,
    blocking: [],
    studio: {
      index: cell.index,
      time: cell.time,
      frames: cell.frames,
      renderer: cell.renderer,
      content_path: cell.content_path,
      reference_layer: cell.reference_layer,
      audio_cue: cell.audio_cue,
      block_id: cell.block_id,
      renders: cell.renders,
      metadata: cell.metadata,
      extra: unknownKeys(cell, CellSchema.shape),
    },
  };
}

function assetFromAnchor(a: Anchor): Asset {
  return {
    id: a.id,
    // An anchor is a reference already in use in the source project, so it
    // arrives approved; the import grants no new approval.
    stage: 'bible',
    status: 'approved',
    comments: [],
    kind: 'reference',
    name: a.name,
    file: a.asset,
    tags: a.tags,
    studio: { anchor: { kind: a.kind, metadata: a.metadata } },
  };
}

/** Convert a Studio `storyboard.json` (any version-1 document) to an akuko project. */
export function fromStudio(input: unknown): AkukoProject {
  const parsed = ProjectSchema.safeParse(input);
  if (!parsed.success) {
    throw new StudioConversionError(`not a valid Studio project: ${parsed.error.message}`);
  }
  const sp = parsed.data;
  const beats = sp.script?.beats ?? [];

  const sceneOfBeat = new Map<string, string>();
  const sceneIds: string[] = [];
  for (const b of beats) {
    if (b.scene_id === undefined) continue;
    sceneOfBeat.set(b.id, b.scene_id);
    if (!sceneIds.includes(b.scene_id)) sceneIds.push(b.scene_id);
  }

  const scriptHeader = sp.script
    ? (({ schema_version: _v, beats: _b, ...rest }: StudioScript) => rest)(sp.script)
    : null;

  const draft = {
    format: AKUKO_FORMAT,
    schema_version: AKUKO_SCHEMA_VERSION,
    project: {
      slug: sp.slug,
      title: sp.title,
      aspect_ratio: sp.aspect_ratio,
      resolution: sp.resolution,
      profile: profileForArchetype(sp.archetype_id),
      created_at: sp.created_at,
      updated_at: sp.updated_at,
    },
    stages: defaultStages('not-started'),
    current_stage: RUNG_STAGE[rungFromNumber(sp.current_rung)],
    script: { beats },
    scenes: sceneIds.map((id) => ({ id })),
    shots: sp.cells.map((c) => shotFromCell(c, sceneOfBeat)),
    assets: sp.anchors.map(assetFromAnchor),
    audio: { narration: sp.narration, analysis: sp.audio_analysis },
    studio: {
      mode: sp.mode,
      archetype_id: sp.archetype_id,
      approved: sp.approved,
      metadata: sp.metadata,
      selected_concepts: sp.selected_concepts,
      selected_concepts_note: sp.selected_concepts_note,
      script: scriptHeader,
      extra: unknownKeys(sp, ProjectSchema.shape),
    },
  };

  const result = AkukoProjectSchema.safeParse(toJson(draft));
  if (!result.success) {
    throw new StudioConversionError(`Studio project does not fit the akuko format: ${result.error.message}`);
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────
// akuko → Studio
// ─────────────────────────────────────────────────────────────────────────

const STUDIO_FPS = 30;

function rungsFor(s: Shot, rung: Rung): Cell['rungs'] {
  const bs = s.by_stage;
  const fallback = (r: Rung): BeatStatus => (r === rung ? toStudioStatus(s.status) : 'pending');
  const b = bs?.breakdown;
  const l = bs?.sketch;
  const h = bs?.keyframes;
  return {
    '0_beat_sheet': { status: b ? toStudioStatus(b.status) : fallback('0_beat_sheet'), content: b?.content },
    '1_lofi': { status: l ? toStudioStatus(l.status) : fallback('1_lofi'), still: l?.output },
    '2_hifi': { status: h ? toStudioStatus(h.status) : fallback('2_hifi'), still: h?.output },
  };
}

/** Project an akuko project onto a Studio `storyboard.json`. */
export function toStudio(p: AkukoProject): StudioProject {
  const ext = p.studio;
  const fallbackEdited = p.project.updated_at ?? p.project.created_at;

  // Anchors: assets imported from Studio anchors, plus any akuko asset that has a file.
  const anchorAssets = p.assets.filter((a) => a.studio || a.file);
  const anchorIds = new Set(anchorAssets.map((a) => a.id));
  const anchors: Anchor[] = anchorAssets.map((a) => ({
    id: a.id,
    name: a.name ?? a.id,
    kind: a.studio?.anchor.kind ?? anchorKindForAsset(a),
    asset: a.file ?? { uri: '' },
    tags: a.tags,
    metadata: a.studio?.anchor.metadata ?? {},
  }));

  // A shot ref may name a bible entry; Studio only knows anchors, so expand it.
  const bibleRefs = new Map<string, string[]>();
  for (const e of [...p.bible.characters, ...p.bible.locations, ...p.bible.styles]) {
    bibleRefs.set(e.id, e.refs.filter((r) => anchorIds.has(r)));
  }

  const groupIndex = new Map<string, number>();
  let clock = 0;
  const cells = p.shots.map((s) => {
    const rung = stageToRung(s.stage);
    const x = s.studio;
    const durationMs = s.duration_s === undefined ? 0 : Math.round(s.duration_s * 1000);
    const beatId = s.beat ?? s.id;

    const groupKey = `${beatId}\u0000${rung}`;
    const nextIndex = groupIndex.get(groupKey) ?? 0;
    groupIndex.set(groupKey, nextIndex + 1);

    const start = clock;
    const end = start + durationMs / 1000;
    clock = end;

    return {
      uid: s.id,
      beat_id: beatId,
      rung,
      index: x?.index ?? nextIndex,
      label: s.label ?? s.id,
      block_id: x?.block_id,
      time: x?.time ?? { start, end },
      frames: x?.frames ?? { start: Math.round(start * STUDIO_FPS), end: Math.round(end * STUDIO_FPS) },
      narration_excerpt: s.narration ?? null,
      intent: s.intent,
      shot_type: toStudioShotType(s.shot_type),
      camera_move: toStudioMove(s.camera_move),
      duration_ms: durationMs,
      audio_cue: x?.audio_cue,
      prompt: s.prompt ?? '',
      anchors: s.refs.flatMap((r) => bibleRefs.get(r) ?? [r]),
      seed: s.seed,
      action: s.action,
      camera_text: s.camera,
      renderer: x?.renderer ?? 'auto',
      content_path: x?.content_path ?? `cells/${rungDir(rung)}/${s.id}/index.html`,
      notes: s.notes ?? '',
      reference_layer: x?.reference_layer ?? [],
      rungs: rungsFor(s, rung),
      comments: s.comments.map((c) => ({
        ts: Date.parse(c.ts),
        rung: rungNumber(stageToRung(c.stage)),
        text: c.text,
      })),
      approved: s.status === 'approved',
      last_edited: s.updated_at ?? fallbackEdited,
      renders: x?.renders ?? [],
      metadata: x?.metadata ?? {},
      ...(x?.extra ?? {}),
    };
  });

  const beats = p.script.beats;
  let script: StudioScript | null;
  if (ext && ext.script === null && beats.length === 0) {
    script = null;
  } else if (ext?.script) {
    script = { schema_version: 1, ...ext.script, beats };
  } else if (beats.length > 0) {
    script = {
      schema_version: 1,
      archetype: scriptArchetypeForProfile(p.project.profile),
      title: p.project.title,
      duration_ms: beats.reduce((sum, b) => sum + b.duration_ms, 0),
      style_anchors: [],
      metadata: {},
      beats,
    };
  } else {
    script = null;
  }

  const out = {
    schema_version: 1 as const,
    slug: p.project.slug,
    title: p.project.title,
    created_at: p.project.created_at,
    updated_at: p.project.updated_at ?? p.project.created_at,
    mode: ext?.mode ?? 'studio',
    archetype_id: ext?.archetype_id ?? archetypeForProfile(p.project.profile),
    aspect_ratio: p.project.aspect_ratio,
    resolution: p.project.resolution,
    audio_analysis: p.audio.analysis,
    selected_concepts: ext?.selected_concepts,
    selected_concepts_note: ext?.selected_concepts_note,
    current_rung: rungNumber(stageToRung(p.current_stage)),
    anchors,
    script,
    cells,
    narration: p.audio.narration ?? null,
    approved: ext?.approved ?? p.stages.export.state === 'approved',
    metadata: ext?.metadata ?? {},
    ...(ext?.extra ?? {}),
  };

  const result = ProjectSchema.safeParse(toJson(out));
  if (!result.success) {
    throw new StudioConversionError(`akuko project does not project onto Studio: ${result.error.message}`);
  }
  return result.data;
}
