/**
 * Convert a review-board fixture into an `akuko.json` project.
 *
 *   node --experimental-strip-types fixtures/convert-fixture.ts [input] [output]
 *
 * Defaults: input `fixtures/the-beating/board-fixture.json`, output
 * `fixtures/the-beating/akuko.json` (both next to this file).
 *
 * The board fixture is the data the board designs were drawn against (a
 * twelve-shot adaptation of a public-domain story, mid-review). Its shape is
 * close to akuko's but not identical; the mapping is:
 *   project.created (date)          project.created_at (midnight UTC)
 *   _note                           project.notes
 *   stages[] {id, n, label, state,  stages{id: {state}} + current_stage
 *     current}                        (n and label are checked against STAGES)
 *   scenes[].slug                   scenes[].heading
 *   shots[].type / .move            shot_type / camera_move (see the maps below)
 *   shots[] (in the current stage)  stage = the current stage
 *   bible.*.assets[] {kind,status}  assets[] with id "<entry>_<kind>", owner = entry,
 *                                     and the entry's refs[] list those ids
 *   bible.style (one)               bible.styles[0]
 *   status "not-started"            "pending"
 *   ledger[].unit "<entry> · <kind>" the matching asset id; status "done" (it has an actual)
 * Every input object is parsed strictly, so a field this mapping does not know
 * about fails the conversion instead of being dropped.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  AKUKO_FORMAT,
  AKUKO_SCHEMA_VERSION,
  AkukoProjectSchema,
  STAGE_LABEL,
  STAGE_NUMBER,
  StageIdSchema,
  StageStateSchema,
  UnitStatusSchema,
} from '../schema/akuko-project.ts';
import type {
  AkukoCameraMove,
  AkukoProject,
  AkukoShotType,
  Asset,
  BibleEntry,
  StageId,
  Stages,
  UnitStatus,
} from '../schema/akuko-project.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INPUT = join(HERE, 'the-beating', 'board-fixture.json');
export const DEFAULT_OUTPUT = join(HERE, 'the-beating', 'akuko.json');

// ─────────────────────────────────────────────────────────────────────────
// Board fixture input shape (strict: unknown fields fail loudly)
// ─────────────────────────────────────────────────────────────────────────

const BoardStatus = z.union([UnitStatusSchema, z.literal('not-started')]);

const BoardComment = z.object({
  ts: z.string(),
  stage: StageIdSchema,
  author: z.string(),
  text: z.string(),
}).strict();

const BoardShot = z.object({
  id: z.string(),
  scene: z.string(),
  type: z.string(),
  camera: z.string(),
  duration_s: z.number(),
  status: BoardStatus,
  action: z.string(),
  script_line: z.string(),
  prompt: z.string(),
  refs: z.array(z.string()),
  blocking: z.array(z.object({
    who: z.string(),
    shape: z.enum(['rect', 'ellipse']),
    x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  }).strict()),
  move: z.string().nullable(),
  comments: z.array(BoardComment),
}).strict();

const BoardAsset = z.object({ kind: z.string(), status: BoardStatus }).strict();

const BoardEntry = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().optional(),
  status: BoardStatus,
  description: z.string().optional(),
  assets: z.array(BoardAsset).optional(),
  notes: z.array(z.string()).optional(),
}).strict();

export const BoardFixtureSchema = z.object({
  schema_version: z.literal(1),
  project: z.object({
    slug: z.string(),
    title: z.string(),
    logline: z.string(),
    source: z.string(),
    runtime_s: z.number(),
    aspect_ratio: z.enum(['16:9', '9:16', '1:1']),
    profile: z.string(),
    created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(),
  host: z.object({ level: z.enum(['A', 'B', 'C']), label: z.string() }).strict(),
  stages: z.array(z.object({
    id: StageIdSchema,
    n: z.number().int(),
    label: z.string(),
    state: StageStateSchema,
    current: z.boolean().optional(),
  }).strict()),
  scenes: z.array(z.object({ id: z.string(), slug: z.string(), summary: z.string() }).strict()),
  shots: z.array(BoardShot),
  bible: z.object({
    characters: z.array(BoardEntry),
    locations: z.array(BoardEntry),
    style: BoardEntry,
  }).strict(),
  budget: z.object({ currency: z.string(), cap: z.number(), spent: z.number() }).strict(),
  pending_spend: z.array(z.object({
    id: z.string(),
    stage: StageIdSchema,
    label: z.string(),
    units: z.array(z.string()),
    provider: z.string(),
    model: z.string(),
    estimate: z.number(),
    status: z.literal('awaiting-approval'),
  }).strict()),
  ledger: z.array(z.object({
    ts: z.string(),
    provider: z.string(),
    unit: z.string(),
    actual: z.number(),
  }).strict()),
  _note: z.string().optional(),
}).strict();
export type BoardFixture = z.infer<typeof BoardFixtureSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Value maps
// ─────────────────────────────────────────────────────────────────────────

const SHOT_TYPE: Record<string, AkukoShotType> = {
  EWS: 'ews', 'EXTREME WIDE': 'ews',
  WIDE: 'ws', WS: 'ws',
  LONG: 'ls', LS: 'ls',
  FULL: 'fs', FS: 'fs',
  MEDIUM: 'ms', MS: 'ms',
  CU: 'cu', 'CLOSE-UP': 'cu',
  ECU: 'ecu',
  OTS: 'ots',
  POV: 'pov',
  INSERT: 'insert',
  AERIAL: 'aerial',
  TOP: 'overhead', OVERHEAD: 'overhead',
};

const CAMERA_MOVE: Record<string, AkukoCameraMove> = {
  push: 'push-in', 'push-in': 'push-in', 'dolly-in': 'push-in',
  pull: 'pull-out', 'pull-out': 'pull-out', 'dolly-out': 'pull-out',
  whip: 'whip-pan', 'whip-pan': 'whip-pan',
  pan: 'pan', tilt: 'tilt', dolly: 'dolly', truck: 'truck', crane: 'crane',
  handheld: 'handheld', 'zoom-in': 'zoom-in', 'zoom-out': 'zoom-out', orbit: 'orbit', static: 'static',
};

function lookup<T>(map: Record<string, T>, key: string, what: string): T {
  const v = map[key];
  if (v === undefined) throw new Error(`board fixture: unknown ${what} "${key}"`);
  return v;
}

const status = (s: z.infer<typeof BoardStatus>): UnitStatus => (s === 'not-started' ? 'pending' : s);

// ─────────────────────────────────────────────────────────────────────────
// Conversion
// ─────────────────────────────────────────────────────────────────────────

export function convertBoardFixture(input: unknown): AkukoProject {
  const fx = BoardFixtureSchema.parse(input);

  const stages = {} as Stages;
  let current: StageId | undefined;
  for (const s of fx.stages) {
    if (STAGE_NUMBER[s.id] !== s.n || STAGE_LABEL[s.id] !== s.label) {
      throw new Error(`board fixture: stage ${s.id} is n=${s.n} "${s.label}", expected n=${STAGE_NUMBER[s.id]} "${STAGE_LABEL[s.id]}"`);
    }
    stages[s.id] = { state: s.state };
    if (s.current) {
      if (current) throw new Error('board fixture: more than one current stage');
      current = s.id;
    }
  }
  if (!current) throw new Error('board fixture: no current stage');
  const currentStage: StageId = current;

  const assets: Asset[] = [];
  const entry = (e: z.infer<typeof BoardEntry>): BibleEntry => {
    const refs = (e.assets ?? []).map((a) => {
      const id = `${e.id}_${a.kind}`;
      assets.push({
        id,
        stage: 'bible',
        status: status(a.status),
        comments: [],
        kind: a.kind as Asset['kind'],
        owner: e.id,
        tags: [],
      });
      return id;
    });
    return {
      id: e.id,
      stage: 'bible',
      status: status(e.status),
      comments: [],
      name: e.name,
      role: e.role,
      description: e.description,
      notes: e.notes ?? [],
      refs,
    };
  };
  const characters = fx.bible.characters.map(entry);
  const locations = fx.bible.locations.map(entry);
  const styles = [entry(fx.bible.style)];

  const assetIds = new Set(assets.map((a) => a.id));
  const ledger = fx.ledger.map((l) => {
    const parts = l.unit.split(' · ');
    const id = parts.length === 2 ? `${parts[0]}_${parts[1]}` : l.unit;
    if (!assetIds.has(id)) throw new Error(`board fixture: ledger unit "${l.unit}" matches no asset`);
    return { ts: l.ts, provider: l.provider, unit: id, actual: l.actual, status: 'done' as const };
  });

  const draft = {
    format: AKUKO_FORMAT,
    schema_version: AKUKO_SCHEMA_VERSION,
    project: {
      slug: fx.project.slug,
      title: fx.project.title,
      logline: fx.project.logline,
      source: fx.project.source,
      runtime_s: fx.project.runtime_s,
      aspect_ratio: fx.project.aspect_ratio,
      profile: fx.project.profile,
      created_at: `${fx.project.created}T00:00:00Z`,
      notes: fx._note,
    },
    host: { level: fx.host.level, label: fx.host.label, capabilities: {} },
    stages,
    current_stage: currentStage,
    script: { beats: [] },
    scenes: fx.scenes.map((s) => ({ id: s.id, heading: s.slug, summary: s.summary })),
    shots: fx.shots.map((s) => ({
      id: s.id,
      stage: currentStage,
      status: status(s.status),
      comments: s.comments,
      scene: s.scene,
      shot_type: lookup(SHOT_TYPE, s.type, 'shot type'),
      camera: s.camera,
      camera_move: s.move === null ? 'unset' : lookup(CAMERA_MOVE, s.move, 'camera move'),
      action: s.action,
      duration_s: s.duration_s,
      prompt: s.prompt,
      refs: s.refs,
      script_line: s.script_line,
      blocking: s.blocking,
    })),
    bible: { characters, locations, styles },
    assets,
    audio: {},
    budget: fx.budget,
    pending_spend: fx.pending_spend,
    ledger,
    decisions: [],
  };

  return AkukoProjectSchema.parse(JSON.parse(JSON.stringify(draft)));
}

/** The exact text written to `akuko.json`. */
export const serialize = (p: AkukoProject): string => `${JSON.stringify(p, null, 2)}\n`;

function main(argv: string[]): void {
  const input = resolve(argv[0] ?? DEFAULT_INPUT);
  const output = resolve(argv[1] ?? DEFAULT_OUTPUT);
  const project = convertBoardFixture(JSON.parse(readFileSync(input, 'utf8')));
  writeFileSync(output, serialize(project));
  console.log(`wrote ${output} (${project.shots.length} shots, ${project.assets.length} assets)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
