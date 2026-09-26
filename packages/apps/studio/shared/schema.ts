/**
 * com.ikenga.studio — schema v1 (LANDED source of truth)
 *
 * This file is the canonical schema for com.ikenga.studio. It lives at
 * `ikenga-pkgs/packages/apps/studio/shared/schema.ts` and is published as
 * `@ikenga/studio-schema`. Earlier copies under `plans/studio/drafts/` are
 * superseded by this file — edit here, not there.
 *
 * LIFT PROVENANCE (prose only — no live imports back to these paths):
 *   pkgs/_review/studio/src/ui/video/lib/storyboard-schema.ts
 *   (byte-identical with royalti-video-engine/src/lib/storyboard-schema.ts —
 *    that engine was retired and deleted on 2026-09-08, WP-16; the path is kept
 *    here as provenance, not as somewhere to go looking)
 *
 * Lifted base: BeatStatus, Rung, the three per-rung schemas, Comment, the rung structure on Beat,
 * and the Narration block. Renamed Beat -> Cell at the boundary. Composition-engine-specific
 * fields (tsx_anchor, fixed still_path conventions) dropped or generalized to URI.
 *
 * Added on top (Round-2): Block, BlockParameter, Archetype, Anchor, AssetRef, Script, ScriptBeat,
 * project-level anchor library, archetype_id on Project, block_id? on Cell.
 *
 * Personal-mode collapse (Round-2): the 7-state approval machine collapses to `approved: boolean`.
 * Inline per-rung comments stay in the schema (they're cheap, useful even solo, and re-expanding
 * to threaded/attributed comments later is non-breaking).
 *
 * Added (Round-7): Project.aspect_ratio + resolution (G1), Project.audio_analysis (G4),
 * RenderRecord.{engine_version, model_id, cost_estimate, cost_actual} (G3 + model-churn traceability),
 * `.passthrough()` on Project / Cell / RenderRecord so unknown keys survive version skew (G9).
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Lifted enums + helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Approval state on a (cell, rung) pair. **VESTIGIAL in personal mode (Round 8 / G13).**
 * Three approval representations exist in this schema — the per-rung `status` below,
 * `Cell.approved`, and `Project.approved`. Personal mode's live signal is `Cell.approved`
 * (single boolean, Round 2); **nothing writes per-rung `status` in P1**. It's lifted from
 * `_review/studio` and kept (like `Comment`) because it's cheap and re-expanding to the full
 * 7-state machine in Phase 3 is non-breaking — not because P1 populates it. Default writers
 * should set `'pending'` and leave it; the canvas reads `Cell.approved`, not these.
 */
export const BeatStatusSchema = z.enum([
  'pending',
  'pending-review',
  'approved',
  'needs-rework',
]);
export type BeatStatus = z.infer<typeof BeatStatusSchema>;

/** Fidelity rung. `0` = beat sheet (text only), `1` = lo-fi (wireframe), `2` = hi-fi. */
export const RungSchema = z.enum(['0_beat_sheet', '1_lofi', '2_hifi']);
export type Rung = z.infer<typeof RungSchema>;

export const RUNG_LABELS: Record<number, Rung> = {
  0: '0_beat_sheet',
  1: '1_lofi',
  2: '2_hifi',
};

export const RUNG_NUMBERS: Record<Rung, number> = {
  '0_beat_sheet': 0,
  '1_lofi': 1,
  '2_hifi': 2,
};

/**
 * On-disk directory token for a rung (Round 8 / G14). The filesystem uses the SHORT token,
 * not the enum value: `cells/<rungDir>/<uid>/…` and `renders/<engine>/<rungDir>/<uid>.mp4`.
 * Single source of truth — the sidecar + every renderer adapter derive paths via `rungDir(cell.rung)`,
 * never by string-slicing the enum. Keep every path example in 01-plan/05-tracking aligned to these.
 */
export const RUNG_DIR: Record<Rung, string> = {
  '0_beat_sheet': 'beatsheet',
  '1_lofi': 'lofi',
  '2_hifi': 'hifi',
};
export const rungDir = (rung: Rung): string => RUNG_DIR[rung];

/** Shot types (Storyboarder-aligned). */
export const ShotTypeSchema = z.enum([
  'ews', 'ws', 'ls', 'fs', 'ms', 'cu', 'ecu', 'ots', 'pov', 'insert', 'aerial', 'unset',
]);
export type ShotType = z.infer<typeof ShotTypeSchema>;

/** Camera move enum. */
export const CameraMoveSchema = z.enum([
  'static', 'pan', 'tilt', 'dolly', 'truck', 'crane', 'handheld',
  'zoom-in', 'zoom-out', 'orbit', 'unset',
]);
export type CameraMove = z.infer<typeof CameraMoveSchema>;

/**
 * Output framing (Round 7 / G1). TikTok-first label content makes 9:16 a default
 * deliverable, not an export-time afterthought. Threaded through RenderContext +
 * composition.render({aspect_ratio?}). Default resolutions:
 *   16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080.
 */
export const AspectRatioSchema = z.enum(['16:9', '9:16', '1:1']);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const DEFAULT_RESOLUTION: Record<AspectRatio, { w: number; h: number }> = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
};

// ─────────────────────────────────────────────────────────────────────────
// AssetRef + Anchor (new in Round-2 — universal across archetypes)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cross-engine asset reference. URI is the only required field — relative paths
 * resolve against the project root, `file://` and `http(s)://` are absolute.
 * Never embed binary content in JSON.
 */
export const AssetRefSchema = z.object({
  uri: z.string(),
  mime: z.string().optional(),
  hash: z.string().optional(),                 // sha256, used for thumbnail-cache keying
  duration_ms: z.number().optional(),          // audio/video only
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

/**
 * Project-level reusable reference. Used three ways:
 *   1. Plain asset reference for HF / Remotion cells (resolves to <img/>, <video/>, <audio/>).
 *   2. Style prior for AI-gen adapters (Phase 3 — character/style/location locking).
 *   3. Shared asset library — one source of truth across all cells in a project.
 *
 * Universal field on every Cell (`anchors: Anchor.id[]`); renderer-specific interpretation.
 */
export const AnchorSchema = z.object({
  id: z.string(),                              // project-unique stable UID
  name: z.string(),
  // 'sketch' added in Round 6 — Excalidraw scenes as reusable anchors.
  kind: z.enum(['image', 'video', 'audio', 'style', 'character', 'location', 'sketch']),
  asset: AssetRefSchema,
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}), // open bag (e.g. AI-gen locked seed, palette)
});
export type Anchor = z.infer<typeof AnchorSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Block + BlockParameter + Archetype (new in Round-2)
// ─────────────────────────────────────────────────────────────────────────

/** Type tag for a Block parameter. */
export const BlockParameterTypeSchema = z.enum([
  'string', 'number', 'boolean',
  'asset_ref',                                 // AssetRef
  'anchor_ref',                                // Anchor.id
  'enum',
]);
export type BlockParameterType = z.infer<typeof BlockParameterTypeSchema>;

/** A typed input to a Block's template. */
export const BlockParameterSchema = z.object({
  name: z.string(),
  type: BlockParameterTypeSchema,
  default: z.unknown().optional(),
  required: z.boolean().default(false),
  enum_values: z.array(z.string()).optional(), // only when type === 'enum'
  description: z.string().optional(),
});
export type BlockParameter = z.infer<typeof BlockParameterSchema>;

/**
 * Reusable composition atom. Ships inside the archetype skill that introduces it
 * (or `studio-core-blocks` for universals). The MCP `block.*` namespace aggregates
 * blocks from all installed archetype skills + core; `template_path` resolves
 * relative to the owning skill's directory.
 */
export const BlockSchema = z.object({
  id: z.string(),                              // 'hook.stat' | 'beat.problem' | 'transition.smash-cut' | 'sketch.flowchart'
  // 'sketch' added in Round 6 — blocks with a .excalidraw template (e.g. sketch.flowchart, sketch.timeline).
  kind: z.enum([
    'hook', 'beat', 'transition',
    'narration_pattern', 'anchor_pack',
    'sfx', 'music_preset', 'cta', 'sketch',
  ]),
  name: z.string(),
  description: z.string(),
  category: z.enum(['narrative', 'visual', 'audio', 'timing', 'style']).optional(),
  default_duration_ms: z.number().int().nonnegative().optional(),
  // 'excalidraw' added in WP-32 (G-68) — sketch blocks may now name it directly
  // instead of the older `default_renderer: 'auto'` + `metadata.renderer_hint`
  // workaround (which remains valid for blocks targeting older schemas).
  default_renderer: z.enum(['hyperframes', 'remotion', 'excalidraw', 'auto']).default('auto'),
  template_path: z.string(),                   // 'blocks/hook/stat/template.html' (relative to owning skill)
  parameters: z.array(BlockParameterSchema).default([]),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type Block = z.infer<typeof BlockSchema>;

/** A single step in an archetype's chain — references a Block + per-instance bindings. */
export const ArchetypeChainEntrySchema = z.object({
  block_id: z.string(),
  bindings: z.record(z.unknown()).default({}), // BlockParameter.name → value
});
export type ArchetypeChainEntry = z.infer<typeof ArchetypeChainEntrySchema>;

/**
 * A curated chain of Blocks. Seven built-in presets ship with the pkg
 * (explainer / product / ai-short / narrative / montage / tutorial / music-video);
 * user-custom archetypes save into `<project>/archetypes/` or the user-global dir.
 */
export const ArchetypeSchema = z.object({
  id: z.string(),                              // 'explainer' (builtin) | 'product-demo-30s' (custom)
  name: z.string(),
  description: z.string(),
  builtin: z.boolean().default(false),
  chain: z.array(ArchetypeChainEntrySchema),
  default_total_duration_ms: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type Archetype = z.infer<typeof ArchetypeSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Script + ScriptBeat (new in Round-2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per-beat script entry. OTIO-style scene/shot IDs (`sc3_sh2A`) make script ↔ storyboard
 * binding stable — beats carry `scene_id?` + `shot_id?` so external tools (FCPXML, OTIO,
 * Final Draft) can round-trip.
 */
export const ScriptBeatSchema = z.object({
  id: z.string(),                              // matches Cell.beat_id
  scene_id: z.string().optional(),             // OTIO: 'sc3'
  shot_id: z.string().optional(),              // OTIO: 'sc3_sh2A'
  vo: z.string().default(''),                  // voiceover / narration text
  on_screen_text: z.string().optional(),
  action: z.string().optional(),               // visual description
  duration_ms: z.number().int().nonnegative(),
  sfx: z.array(z.string()).default([]),
  transition: z.string().optional(),           // out-transition (e.g. 'smash-cut')
  metadata: z.record(z.unknown()).default({}),
});
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

/**
 * Per-archetype script. Stored as `<project>/script.json` for most archetypes;
 * the `narrative` archetype reads `<project>/script.fountain` natively (parser
 * outputs to the same Zod shape in memory).
 */
export const ScriptArchetypeSchema = z.enum([
  'explainer', 'product', 'ai_short', 'narrative', 'montage', 'tutorial', 'music_video', 'custom',
]);
export type ScriptArchetype = z.infer<typeof ScriptArchetypeSchema>;

export const ScriptSchema = z.object({
  schema_version: z.literal(1),
  archetype: ScriptArchetypeSchema,
  title: z.string(),
  duration_ms: z.number().int().nonnegative(),
  style_anchors: z.array(z.string()).default([]),  // Anchor.id[] — project-level look refs
  music_preset: z.string().optional(),
  beats: z.array(ScriptBeatSchema),
  metadata: z.record(z.unknown()).default({}),
});
export type Script = z.infer<typeof ScriptSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Narration block (lifted — composition-level audio + word-level alignment)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Word-level alignment entry. Times in milliseconds from start of composition audio.
 * Lifted format aligns with ElevenLabs convert-with-timestamps output.
 */
export const NarrationWordSchema = z.object({
  word: z.string(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
});
export type NarrationWord = z.infer<typeof NarrationWordSchema>;

/**
 * Composition-level narration block. Populated after TTS; stale when any beat's
 * narration_excerpt changes after `generated_at`.
 */
export const NarrationBlockSchema = z.object({
  audio: AssetRefSchema,                       // path to narration.mp3
  words: z.array(NarrationWordSchema),         // composition-absolute timings
  voice_id: z.string().optional(),
  duration_ms: z.number().int().nonnegative(),
  generated_at: z.string(),                    // ISO-8601 — staleness detection
});
export type NarrationBlock = z.infer<typeof NarrationBlockSchema>;

/**
 * Music-video beat-map (Round 7 / G4). The music-video archetype is the one archetype
 * with audio-structural needs the other six lack. Populated by the `studio-beat-detect`
 * skill (shells `python3` + librosa — primary; madmom is an optional/contingency detector
 * only, Round 8 / G12 — over the project audio track). The Composition
 * timeline snaps cell durations to bar/beat boundaries when present. Optional everywhere —
 * absent for the other six archetypes. All arrays are millisecond offsets from track start.
 */
export const AudioAnalysisSchema = z.object({
  bpm: z.number().positive(),
  downbeats: z.array(z.number().nonnegative()).default([]),  // bar starts (ms)
  beats: z.array(z.number().nonnegative()).default([]),      // every beat (ms)
  onsets: z.array(z.number().nonnegative()).default([]),     // transient onsets (ms)
  source: AssetRefSchema.optional(),                         // the analysed audio track
  analysed_at: z.string().optional(),                        // ISO-8601 — stale once `source` audio changes after this ts (mirrors NarrationBlock.generated_at)
});
export type AudioAnalysis = z.infer<typeof AudioAnalysisSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Per-rung status (lifted from _review/studio, generalized)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Rung 0 — beat sheet (text-only). The lifted shape is exactly right for our needs.
 */
export const BeatSheet0Schema = z.object({
  status: BeatStatusSchema,
  content: z.string().optional(),              // free-form text from beat-sheet phase
});

/**
 * Rung 1 — lo-fi. Lifted, but dropped `tsx_anchor` (composition-engine-specific path).
 * `still_path` generalized to optional AssetRef — works for HF, Remotion, AI adapters,
 * and arbitrary-folder projects.
 */
export const Lofi1Schema = z.object({
  status: BeatStatusSchema,
  still: AssetRefSchema.optional(),            // generalized from string still_path
});

/**
 * Rung 2 — hi-fi. Lifted, `still_path` generalized as above.
 */
export const Hifi2Schema = z.object({
  status: BeatStatusSchema,
  still: AssetRefSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────
// Comment (lifted, kept for cheap per-rung notes — personal mode opts not to surface them in UI)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Inline per-rung note. Kept in the schema even though personal-mode UI doesn't
 * surface comment threading — useful for `TODO`-style annotations the
 * agent might leave for itself or the user. Round-3 comments + threading + pin
 * coordinates expand non-breaking.
 */
export const CommentSchema = z.object({
  ts: z.number().int().nonnegative(),          // unix ms
  rung: z.number().int().min(0).max(2),
  text: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

// ─────────────────────────────────────────────────────────────────────────
// RenderRecord (new in Round-2 — engine-agnostic)
// ─────────────────────────────────────────────────────────────────────────

export const RenderStatusSchema = z.enum([
  'queued', 'running', 'done', 'failed', 'cancelled',
]);
export type RenderStatus = z.infer<typeof RenderStatusSchema>;

/**
 * Output of one renderer adapter invocation. Multiple records per cell allowed
 * (one per engine × variant). The latest `done` record per (engine, variant) is canonical.
 */
export const RenderRecordSchema = z.object({
  id: z.string(),
  cell_uid: z.string(),
  engine: z.string(),                          // 'hyperframes' | 'remotion' | 'veo' | …
  engine_version: z.string().optional(),       // Round 7 — reproducibility across model churn (null for deterministic HF/Excalidraw)
  model_id: z.string().optional(),             // Round 7 — e.g. 'veo-3.1-fast'; null for HF/Excalidraw
  variant: z.string().default('default'),      // P2+ — alternative renders
  status: RenderStatusSchema,
  output: AssetRefSchema.optional(),           // the MP4 / PNG
  preview: AssetRefSchema.optional(),          // thumb/poster
  cost_estimate: z.number().nonnegative().optional(),  // Round 7 / G3 — 0 for HF/Excalidraw, filled by AI adapters (P3)
  cost_actual: z.number().nonnegative().optional(),    // Round 7 / G3 — actual spend once render completes
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).default({}), // per-engine: seed, fps, codec
}).passthrough();                              // Round 7 / G9 — preserve unknown keys across version skew
export type RenderRecord = z.infer<typeof RenderRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Cell (lifted Beat, renamed + extended for Round-2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The atom of a storyboard. Lifted shape: id + label + time/frames ranges +
 * narration_excerpt + intent + rungs + comments. Added on top: production fields
 * (shot_type, camera_move, duration_ms, audio_cue), AI/reference-adherence
 * (prompt, anchors, seed, action, camera_text), content (renderer hint, content_path,
 * notes, reference_layer), block back-reference (block_id?), simplified approval.
 *
 * Renamed from `Beat` → `Cell` to disambiguate from `ScriptBeat` (script-side) and
 * from the lifted `_review/studio` Beat type.
 */
export const CellSchema = z.object({
  // ── Identity (lifted base, extended) ────
  uid: z.string(),                             // stable, project-unique (new: lifted used `id`, renamed)
  beat_id: z.string(),                         // matches ScriptBeat.id (new — FK)
  rung: RungSchema,                            // which rung this cell exists at (lifted nested → flat)
  index: z.number().int().nonnegative(),       // ordinal inside (beat_id, rung) (new)
  label: z.string(),                           // lifted
  block_id: z.string().optional(),             // new — Block this cell was instantiated from

  // ── Lifted time/frames bounds ────
  time: z.object({
    start: z.number(),                         // seconds, composition-absolute
    end: z.number(),
  }),
  frames: z.object({
    start: z.number().int(),
    end: z.number().int(),
  }),

  // ── Lifted narration excerpt ────
  narration_excerpt: z.string().nullable().default(null),
  intent: z.string().optional(),               // lifted — beat-level semantic note

  // ── Production fields (new — Storyboarder-aligned) ────
  shot_type: ShotTypeSchema.default('unset'),
  camera_move: CameraMoveSchema.default('unset'),
  duration_ms: z.number().int().nonnegative().default(0),
  audio_cue: AssetRefSchema.optional(),

  // ── AI / reference-adherence (new — universal across renderers) ────
  prompt: z.string().default(''),
  anchors: z.array(z.string()).default([]),    // Anchor.id[]
  seed: z.number().int().optional(),
  action: z.string().optional(),
  camera_text: z.string().optional(),

  // ── Content + production (new) ────
  // 'excalidraw' added in Round 6 — cells whose content_path is a .excalidraw JSON file.
  // 'blender' + 'fal' added in WP-32 (G-68) — the local Blender adapter and the
  // fal.ai network engine, matching the sidecar adapter registry. Additive only;
  // schema_version stays 1 (every existing document still parses unchanged).
  renderer: z.enum(['hyperframes', 'remotion', 'excalidraw', 'blender', 'fal', 'veo', 'kling', 'runway', 'auto']).default('auto'),
  content_path: z.string(),                    // 'cells/hifi/<uid>/content.html' (HF) | 'Composition.tsx' (Remotion) | 'content.excalidraw' (Excalidraw)
  notes: z.string().default(''),
  reference_layer: z.array(AssetRefSchema).default([]),

  // ── Workflow (lifted rungs structure; personal-mode `approved: boolean` collapse at Project level) ────
  rungs: z.object({
    '0_beat_sheet': BeatSheet0Schema,
    '1_lofi': Lofi1Schema,
    '2_hifi': Hifi2Schema,
  }),
  comments: z.array(CommentSchema).default([]),  // lifted — kept for cheap per-rung notes
  approved: z.boolean().default(false),          // new — single-bit personal-mode shortcut
  last_edited: z.string(),                       // new — ISO-8601, debug + staleness

  // ── Renders ────
  renders: z.array(RenderRecordSchema).default([]),

  // ── Open metadata bag (future-slot) ────
  // For Excalidraw cells, animation hints live in metadata.animation:
  //   {
  //     order?: number[],                      // excalidraw-animate's primary primitive (P1)
  //     duration_ms?: number,
  //     keyframes?: Array<{                    // Excalimate-compatible (P2 — load-bearing when adapter switches)
  //       element_id: string,
  //       t: number,                            // 0..1 normalized
  //       opacity?: number,
  //       position?: { x: number; y: number },
  //       scale?: number,
  //       rotation?: number,                    // radians
  //       draw_progress?: number,               // 0..1
  //       easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | string,
  //     }>,
  //   }
  // For HF + Remotion cells, no `metadata.animation` field — animation is in-template.
  metadata: z.record(z.unknown()).default({}),
}).passthrough();                              // Round 7 / G9 — preserve unknown keys across version skew
export type Cell = z.infer<typeof CellSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Project (lifted Storyboard, renamed + extended)
// ─────────────────────────────────────────────────────────────────────────

export const ProjectModeSchema = z.enum(['studio', 'watch', 'oneshot']);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

/**
 * Top-level project document. Stored as `<project>/storyboard.json`.
 *
 * Lifted base: slug, title, narration (full shape), current_rung, selected_concepts(_note),
 * beats[] (now `cells[]`).
 * Added: schema_version, mode, archetype_id, anchors[], script, approved, created_at,
 * updated_at, metadata.
 */
export const ProjectSchema = z.object({
  schema_version: z.literal(1),

  // ── Identity (lifted + extended) ────
  slug: z.string(),                            // lifted — matches project directory name
  title: z.string(),
  created_at: z.string(),                      // new — ISO-8601
  updated_at: z.string(),                      // new — ISO-8601

  // ── Round-2 mode + archetype ────
  mode: ProjectModeSchema.default('studio'),
  archetype_id: z.string(),                    // FK → Archetype.id (built-in or custom)

  // ── Round-7 output framing (G1) ────
  aspect_ratio: AspectRatioSchema.default('16:9'),
  resolution: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).optional(),
  // ↑ when omitted, derive from aspect_ratio via DEFAULT_RESOLUTION.
  //   NOTE: an explicit resolution OVERRIDES aspect_ratio (it wins) — we deliberately do NOT .refine()
  //   a match, so a user can force e.g. 1920×1920 if they really mean it. The studio UI should warn
  //   (not block) when w:h doesn't match aspect_ratio, to avoid silent letterboxing surprises.

  // ── Round-7 music-video beat-map (G4) — optional; only the music-video archetype populates it ────
  audio_analysis: AudioAnalysisSchema.optional(),

  // ── Lifted concept selection (kept; useful for AI archetypes' style anchors UX) ────
  selected_concepts: z.array(z.object({
    filename: z.string(),
    role: z.string().optional(),
  })).optional(),
  selected_concepts_note: z.string().optional(),

  // ── Lifted pipeline pointer ────
  current_rung: z.number().int().min(0).max(2).default(0),

  // ── Round-2 universal asset library ────
  anchors: z.array(AnchorSchema).default([]),

  // ── Round-2 script (separate file, denormalized here for the storyboard.json doc) ────
  script: ScriptSchema.nullable().default(null),

  // ── Round-2 cells (lifted `beats`; renamed to disambiguate from ScriptBeat) ────
  cells: z.array(CellSchema).default([]),

  // ── Lifted narration block ────
  narration: NarrationBlockSchema.nullable().default(null),

  // ── Round-2 single-bit approval (personal mode) ────
  approved: z.boolean().default(false),

  // ── Open metadata bag (future-slot for created_by, tags, deployment refs, etc.) ────
  metadata: z.record(z.unknown()).default({}),
}).passthrough();                              // Round 7 / G9 — preserve unknown keys across version skew
export type Project = z.infer<typeof ProjectSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Re-exports for consumers
// ─────────────────────────────────────────────────────────────────────────

export const Schemas = {
  AssetRef: AssetRefSchema,
  Anchor: AnchorSchema,
  AudioAnalysis: AudioAnalysisSchema,
  Block: BlockSchema,
  BlockParameter: BlockParameterSchema,
  Archetype: ArchetypeSchema,
  ArchetypeChainEntry: ArchetypeChainEntrySchema,
  Script: ScriptSchema,
  ScriptBeat: ScriptBeatSchema,
  Narration: NarrationBlockSchema,
  NarrationWord: NarrationWordSchema,
  BeatSheet0: BeatSheet0Schema,
  Lofi1: Lofi1Schema,
  Hifi2: Hifi2Schema,
  Comment: CommentSchema,
  RenderRecord: RenderRecordSchema,
  Cell: CellSchema,
  Project: ProjectSchema,
} as const;
