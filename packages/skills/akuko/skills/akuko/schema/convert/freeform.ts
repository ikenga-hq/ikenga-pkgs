/**
 * Freeform storyboard → `akuko.json` (one-way import).
 *
 * The freeform format is the older per-composition storyboard
 * (`compositions/<slug>/storyboard.json`): a project-level `current_rung`,
 * beats with a per-rung status (`rungs["0_beat_sheet" | "1_lofi" | "2_hifi"]`),
 * rung stills (`still_path`), inline review comments `{ts, rung, text}`, and a
 * narration block with word timings.
 *
 *   freeform                         akuko
 *   ───────────────────────────────  ─────────────────────────────────────────
 *   slug, title                      project.slug, project.title
 *   current_rung 0 / 1 / 2           current_stage breakdown / sketch / keyframes
 *   beats[]                          shots[] (one shot per beat, id = beat id)
 *   beat.rungs[r].status             shot.by_stage[stage].status; the current
 *                                      rung's status is shot.status
 *   beat.rungs[r].content            shot.by_stage[stage].content
 *   beat.rungs[r].still_path         shot.by_stage[stage].output.uri
 *   other rung keys (tsx_anchor…)    shot.freeform.rung_extra[r]
 *   beat.comments[] {ts ms, rung}    shot.comments[] {ts ISO, stage, author "unknown"}
 *   beat.label, narration_excerpt,   shot.label, narration, intent
 *     intent
 *   beat.time end − start            shot.duration_s (time + frames kept in shot.freeform)
 *   narration {audio, words, …}      audio.narration (kept whole in freeform.extra
 *                                      when it does not fit)
 *   anything else                    freeform.extra / shot.freeform.extra
 *
 * Stage states for the three rung stages are derived from beat statuses:
 * every beat approved → "approved"; the current rung → "in-review" when any
 * beat waits for review, else "in-progress"; otherwise "not-started".
 */

import { z } from 'zod';
import { AssetRefSchema, BeatStatusSchema, NarrationWordSchema } from '@ikenga/studio-schema';
import type { Rung } from '@ikenga/studio-schema';
import {
  AKUKO_FORMAT,
  AKUKO_SCHEMA_VERSION,
  AkukoProjectSchema,
  defaultStages,
} from '../akuko-project.ts';
import type {
  AkukoProject,
  ByStage,
  Shot,
  StageId,
  Stages,
} from '../akuko-project.ts';
import { RUNG_STAGE } from './studio.ts';

export class FreeformConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreeformConversionError';
  }
}

const RUNGS: Rung[] = ['0_beat_sheet', '1_lofi', '2_hifi'];
const RUNG_KNOWN_KEYS = new Set(['status', 'content', 'still_path']);

const FreeformRungSchema = z.object({
  status: BeatStatusSchema,
  content: z.string().optional(),
  still_path: z.string().optional(),
}).passthrough();

const FreeformCommentSchema = z.object({
  ts: z.number().int().nonnegative(),
  rung: z.number().int().min(0).max(2),
  text: z.string(),
}).strict();

const FREEFORM_BEAT_KEYS = ['id', 'label', 'time', 'frames', 'narration_excerpt', 'intent', 'rungs', 'comments'] as const;
const FreeformBeatSchema = z.object({
  id: z.string(),
  label: z.string(),
  time: z.object({ start: z.number(), end: z.number() }).strict(),
  frames: z.object({ start: z.number().int(), end: z.number().int() }).strict().optional(),
  narration_excerpt: z.string().nullable().optional(),
  intent: z.string().optional(),
  rungs: z.object({
    '0_beat_sheet': FreeformRungSchema.optional(),
    '1_lofi': FreeformRungSchema.optional(),
    '2_hifi': FreeformRungSchema.optional(),
  }).strict(),
  comments: z.array(FreeformCommentSchema).default([]),
}).passthrough();

const FreeformNarrationSchema = z.object({
  audio: z.union([z.string(), AssetRefSchema]),
  words: z.array(NarrationWordSchema),
  voice_id: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  generated_at: z.string().optional(),
}).strict();

const FREEFORM_TOP_KEYS = ['slug', 'title', 'current_rung', 'narration', 'beats'] as const;
export const FreeformStoryboardSchema = z.object({
  slug: z.string(),
  title: z.string(),
  current_rung: z.number().int().min(0).max(2).default(0),
  narration: z.unknown().optional(),
  beats: z.array(FreeformBeatSchema),
}).passthrough();
export type FreeformStoryboard = z.infer<typeof FreeformStoryboardSchema>;

export interface FreeformImportOptions {
  /** ISO timestamp used for `project.created_at` (and narration `generated_at` when missing). Defaults to now. */
  now?: string;
  /** Pipeline profile; freeform storyboards were short design-led explainers. */
  profile?: string;
  aspect_ratio?: '16:9' | '9:16' | '1:1';
}

const toJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function rest(obj: Record<string, unknown>, known: readonly string[] | Set<string>): Record<string, unknown> | undefined {
  const has = (k: string) => (known instanceof Set ? known.has(k) : known.includes(k));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!has(k)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

function msToIso(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new FreeformConversionError(`comment timestamp ${ms} is not a valid time`);
  return d.toISOString();
}

type FreeformBeat = z.infer<typeof FreeformBeatSchema>;

function shotFromBeat(beat: FreeformBeat, currentRung: Rung): Shot {
  const byStage: ByStage = {};
  const rungExtra: Record<string, Record<string, unknown>> = {};
  for (const r of RUNGS) {
    const rec = beat.rungs[r];
    if (!rec) continue;
    byStage[RUNG_STAGE[r]] = {
      status: rec.status,
      content: rec.content,
      output: rec.still_path === undefined ? undefined : { uri: rec.still_path },
    };
    const leftover = rest(rec, RUNG_KNOWN_KEYS);
    if (leftover) rungExtra[r] = leftover;
  }
  return {
    id: beat.id,
    stage: RUNG_STAGE[currentRung],
    status: beat.rungs[currentRung]?.status ?? 'pending',
    comments: beat.comments.map((c) => ({
      ts: msToIso(c.ts),
      stage: RUNG_STAGE[RUNGS[c.rung] as Rung],
      author: 'unknown',
      text: c.text,
    })),
    by_stage: byStage,
    label: beat.label,
    shot_type: 'unset',
    camera_move: 'unset',
    duration_s: Math.max(0, Math.round((beat.time.end - beat.time.start) * 1000) / 1000),
    refs: [],
    narration: beat.narration_excerpt,
    intent: beat.intent,
    blocking: [],
    freeform: {
      time: beat.time,
      frames: beat.frames,
      rung_extra: Object.keys(rungExtra).length ? rungExtra : undefined,
      extra: rest(beat, FREEFORM_BEAT_KEYS),
    },
  };
}

function stageStates(beats: FreeformBeat[], currentRung: Rung): Stages {
  const stages = defaultStages('not-started');
  for (const r of RUNGS) {
    const stage: StageId = RUNG_STAGE[r];
    const statuses = beats.map((b) => b.rungs[r]?.status ?? 'pending');
    if (statuses.length > 0 && statuses.every((s) => s === 'approved')) stages[stage] = { state: 'approved' };
    else if (r === currentRung) {
      stages[stage] = { state: statuses.includes('pending-review') ? 'in-review' : 'in-progress' };
    }
  }
  return stages;
}

/** Import a freeform storyboard. Throws FreeformConversionError when the input is not one. */
export function fromFreeform(input: unknown, opts: FreeformImportOptions = {}): AkukoProject {
  const parsed = FreeformStoryboardSchema.safeParse(input);
  if (!parsed.success) {
    throw new FreeformConversionError(`not a freeform storyboard: ${parsed.error.message}`);
  }
  const fb = parsed.data;
  const now = opts.now ?? new Date().toISOString();
  const currentRung = RUNGS[fb.current_rung] as Rung;

  const extra: Record<string, unknown> = rest(fb, FREEFORM_TOP_KEYS) ?? {};
  let narration;
  if (fb.narration !== undefined && fb.narration !== null) {
    const n = FreeformNarrationSchema.safeParse(fb.narration);
    if (n.success) {
      const words = n.data.words;
      narration = {
        audio: typeof n.data.audio === 'string' ? { uri: n.data.audio } : n.data.audio,
        words,
        voice_id: n.data.voice_id,
        duration_ms: n.data.duration_ms ?? words.reduce((m, w) => Math.max(m, w.end_ms), 0),
        generated_at: n.data.generated_at ?? now,
      };
    } else {
      extra.narration = fb.narration;
    }
  } else if (fb.narration === null) {
    narration = null;
  }

  const draft = {
    format: AKUKO_FORMAT,
    schema_version: AKUKO_SCHEMA_VERSION,
    project: {
      slug: fb.slug,
      title: fb.title,
      aspect_ratio: opts.aspect_ratio ?? '16:9',
      profile: opts.profile ?? 'explainer',
      created_at: now,
    },
    stages: stageStates(fb.beats, currentRung),
    current_stage: RUNG_STAGE[currentRung],
    shots: fb.beats.map((b) => shotFromBeat(b, currentRung)),
    audio: { narration },
    freeform: Object.keys(extra).length ? { extra } : undefined,
  };

  const result = AkukoProjectSchema.safeParse(toJson(draft));
  if (!result.success) {
    throw new FreeformConversionError(`freeform storyboard does not fit the akuko format: ${result.error.message}`);
  }
  return result.data;
}
