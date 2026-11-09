// Real-project fields (WP-24, gate G-SCHEMA-2): sheet shot ids, film time on a
// master clock, dialogue lines, finished cards, project rules, people and
// sign-off gates. Synthetic data only: every id, name and time is invented.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import {
  AkukoProjectSchema,
  DecisionSchema,
  FpsSchema,
  IdSchema,
  SHOT_UNIT_KINDS,
  isCanonicalShotId,
  isSheetShotId,
  parseShotUnitId,
  rulesOf,
  shotUnitId,
  type AkukoProject,
} from './akuko-project.ts';
import { checkIntegrity } from './integrity.ts';
import { JSON_SCHEMA_PATH } from './export-json-schema.ts';
import { fromFreeform } from './convert/freeform.ts';
import { fromStudio } from './convert/studio.ts';
// Read-only imports of the code that builds unit ids from shot ids (and of fold and timecode).
import { assetIdFor as keyframeIdFor } from '../keyframes/plan.ts';
import { assetIdFor as clipIdFor } from '../motion/plan.ts';
import { assetIdFor as voIdFor } from '../sound/plan.ts';
import { planAssetId } from '../providers/outputs.ts';
import { expectedFilename } from '../providers/manual/package.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { SUPPORTED_FPS } from '../handoff/timecode.ts';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
const validateJson = ajv.compile(JSON.parse(readFileSync(JSON_SCHEMA_PATH, 'utf8')));

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const readText = (p: string): string => readFileSync(p, 'utf8');
const SHA_A = 'a'.repeat(64);
const SHA_B = '0123456789abcdef'.repeat(4);

/** A synthetic project shaped like an imported shot-list sheet, using every new field. */
function sheetProject(): Record<string, any> {
  return {
    format: 'akuko',
    schema_version: 1,
    project: { slug: 'sheet-demo', title: 'Sheet Demo', profile: 'film', fps: '24', created_at: '2026-11-09T00:00:00Z' },
    scenes: [
      { id: 'S01', part: 'P1', source: { kind: 'sheet', id: 'S01' } },
      { id: 'S02', part: 'P2', source: { kind: 'sheet', id: 'S02', row: 14 } },
      { id: 'S02b', part: 'P2', source: { kind: 'sheet', id: 'S02b' } },
    ],
    shots: [
      {
        id: 'S01-010', stage: 'breakdown', status: 'pending-review', scene: 'S01', part: 'P1',
        source: { kind: 'sheet', id: 'S01-010', row: 3 },
        film: { in_s: 0.5, out_s: 4 }, // a gap at the scene start is fine
        tier: 'C', lighting: 'L1', framing: 'WS', motion_note: 'Locked off', treatment: 'still',
        prompt: 'A quiet harbour at dawn, wide.', refs: ['char_ada', 'style_house'],
      },
      {
        id: 'S01-020', stage: 'breakdown', status: 'pending-review', scene: 'S01', part: 'P1',
        source: { kind: 'sheet', id: 'S01-020', row: 4 },
        film: { in_s: 4, out_s: 9.25 }, // in = previous out
        tier: 'B', lighting: 'L2', framing: 'MCU', motion_note: 'Slow push-in', treatment: 'still-move',
        move: { from_scale: 1, to_scale: 1.15, x: -40, y: -20 },
      },
      {
        id: 'S02-010', stage: 'breakdown', status: 'pending-review', scene: 'S02', part: 'P2',
        source: { kind: 'sheet', id: 'S02-010', row: 15 },
        film: { in_s: 10, out_s: 14 }, tier: 'A', treatment: 'video',
        lines: [{ id: 'L001', kind: 'spoken' }],
      },
      {
        id: 'S02b-010', stage: 'breakdown', status: 'pending-review', scene: 'S02b', part: 'P2',
        source: { kind: 'sheet', id: 'S02b-010' },
        film: { in_s: 14, out_s: 18 }, tier: 'A', treatment: 'lipsync',
        move: { from_scale: 1.1, to_scale: 1, x: 0, y: 10, ease: 'sine.inOut' },
        lines: [{ id: 'L002', kind: 'spoken' }, { id: 'L003', kind: 'thought' }],
      },
    ],
    bible: {
      characters: [{ id: 'char_ada', stage: 'breakdown', status: 'approved', name: 'Ada (invented)' }],
      styles: [{ id: 'style_house', stage: 'breakdown', status: 'approved', name: 'House style' }],
    },
    assets: [
      {
        id: 'card_title', kind: 'card', stage: 'export', status: 'pending-review', name: 'Title card',
        file: { uri: '../Titles/title.png', mime: 'image/png' }, film: { in_s: 0, out_s: 0.5 },
      },
      {
        id: 'card_part_2', kind: 'card', stage: 'export', status: 'pending-review', name: 'Part 2 card',
        file: { uri: '../Titles/part-2.mov', mime: 'video/quicktime' }, film: { in_s: 9.25, out_s: 10 },
      },
      { id: 'S02b-010_lipsync', kind: 'lipsync', stage: 'motion', status: 'pending', owner: 'S02b-010' },
    ],
    audio: {
      master: { uri: '../Audio/master.wav', duration_s: 30.5, sample_rate: 48000, start_tc: '00:00:00:00', sha256: SHA_A },
      lines: [
        {
          id: 'L001', character: 'char_ada', kind: 'spoken', film_in_s: 10.2, film_out_s: 12, clip_uri: '../Lines/L001.wav',
          text: 'Not today.', words: [{ w: 'Not', t_s: 10.2 }, { w: 'today.', t_s: 10.6 }],
        },
        { id: 'L002', character: 'Ada (invented)', kind: 'spoken', film_in_s: 14.5, film_out_s: 16 },
        { id: 'L003', kind: 'thought', film_in_s: 16.5, film_out_s: 17.5 },
      ],
    },
    rules: {
      required: true,
      banned: [{ term: 'gore', except: ['Gore-Tex'], note: 'house rule' }],
      require: [
        { text: 'seen only as a silhouette', applies_to: 'prompt', scope: { scenes: ['S02b'] } },
        { text: 'no text, no logos', applies_to: 'negative' },
      ],
      uploads: { allow: [{ sha256: SHA_B, label: 'Reference photo A', consent_ref: 'consent-1', note: 'location only' }] },
      never_from_photo: ['char_ada'],
      exempt: [{ shots: ['S01-010'], skip: ['house-style'], note: 'reference shot' }],
      consent: [{ id: 'consent-1', who: 'A. Example', what: 'Use of one location photo as a reference', date: '2026-11-01' }],
    },
    people: [
      { id: 'p-day', name: 'Day Approver (invented)', role: 'approver' },
      { id: 'p-sign', name: 'Sign-off Person (invented)', role: 'signoff' },
    ],
    gates: [
      {
        id: 'G-LOOK', title: 'Look', scope: { stage: 'keyframes', parts: ['P2'], scenes: ['S02'], shots: ['S02-010'] }, needs: 'signoff',
        signed: { by: 'p-sign', role: 'signoff', at: '2026-11-09T12:00:00Z', via: 'email', note: 'Recorded on their word.' },
      },
      { id: 'G-PILOT', scope: { parts: ['P2'] }, needs: 'signoff' },
    ],
  };
}

const parse = (doc: unknown): AkukoProject => AkukoProjectSchema.parse(doc);
const paths = (p: AkukoProject): string[] => checkIntegrity(p).map((i) => i.path);

describe('real-project fields: a synthetic sheet project', () => {
  it('uses every new field, parses, passes integrity and validates against the JSON Schema', () => {
    const doc = sheetProject();
    const p = parse(doc);
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal(validateJson(JSON.parse(JSON.stringify(p))), true, JSON.stringify(validateJson.errors));
    assert.equal(validateJson(doc), true, JSON.stringify(validateJson.errors));
    // Spot-check the parsed values.
    assert.equal(p.project.fps, '24');
    assert.equal(p.shots[1]!.move?.to_scale, 1.15);
    assert.equal(p.shots[3]!.treatment, 'lipsync');
    assert.equal(p.audio.master?.start_tc, '00:00:00:00');
    assert.equal(p.audio.lines?.length, 3);
    assert.equal(p.assets[0]!.kind, 'card');
    assert.equal(p.rules?.required, true);
    assert.equal(p.gates?.[0]?.signed?.via, 'email');
  });

  it('rules fill their empty defaults; a project without rules reads as empty rules', () => {
    const p = parse({ ...sheetProject(), rules: { required: true } });
    assert.deepEqual(p.rules, { required: true, banned: [], require: [], uploads: { allow: [] }, never_from_photo: [], exempt: [], consent: [] });
    const { rules: _r, ...without } = sheetProject();
    const q = parse(without);
    assert.equal(q.rules, undefined);
    assert.deepEqual(rulesOf(q), { required: false, banned: [], require: [], uploads: { allow: [] }, never_from_photo: [], exempt: [], consent: [] });
  });

  it('the frame rates are exactly the ones handoff/timecode.ts supports', () => {
    assert.deepEqual([...FpsSchema.options], SUPPORTED_FPS);
  });
});

describe('real-project fields: shapes Zod (and where it can, the JSON Schema) rejects', () => {
  const both: [string, (d: any) => void][] = [
    ['unknown key in a shot line', (d) => { d.shots[2].lines[0].who = 'x'; }],
    ['bad line kind', (d) => { d.shots[2].lines[0].kind = 'sung'; }],
    ['bad tier', (d) => { d.shots[0].tier = 'D'; }],
    ['bad treatment', (d) => { d.shots[0].treatment = 'animated'; }],
    ['move scale beyond the KenBurns range', (d) => { d.shots[1].move.to_scale = 5; }],
    ['unknown key in a move', (d) => { d.shots[1].move.rotate = 3; }],
    ['sheet source of another kind', (d) => { d.shots[0].source.kind = 'csv'; }],
    ['sheet id with "_"', (d) => { d.shots[0].source.id = 'S01_010'; }],
    ['row 0', (d) => { d.shots[0].source.row = 0; }],
    ['negative film time', (d) => { d.shots[0].film.in_s = -1; }],
    ['unsupported fps', (d) => { d.project.fps = '48'; }],
    ['fps as a number', (d) => { d.project.fps = 24; }],
    ['timecode without frames', (d) => { d.audio.master.start_tc = '00:00:00'; }],
    ['zero master duration', (d) => { d.audio.master.duration_s = 0; }],
    ['uppercase master sha256', (d) => { d.audio.master.sha256 = 'A'.repeat(64); }],
    ['short upload sha256', (d) => { d.rules.uploads.allow[0].sha256 = 'abc'; }],
    ['uppercase upload sha256', (d) => { d.rules.uploads.allow[0].sha256 = SHA_B.toUpperCase(); }],
    ['require applies to something else', (d) => { d.rules.require[0].applies_to = 'title'; }],
    ['exemption with no shots', (d) => { d.rules.exempt[0].shots = []; }],
    ['consent date not a date', (d) => { d.rules.consent[0].date = 'last week'; }],
    ['unknown key in rules', (d) => { d.rules.strict = true; }],
    ['bad person role', (d) => { d.people[0].role = 'host'; }],
    ['gate that needs an approver', (d) => { d.gates[0].needs = 'approver'; }],
    ['gate scope with a bad stage', (d) => { d.gates[0].scope.stage = 'review'; }],
    ['sign-off without via', (d) => { delete d.gates[0].signed.via; }],
    ['sign-off timestamp without a zone', (d) => { d.gates[0].signed.at = '2026-11-09T12:00:00'; }],
    ['unknown asset kind', (d) => { d.assets[0].kind = 'title'; }],
    ['line word without a time', (d) => { delete d.audio.lines[0].words[0].t_s; }],
  ];
  for (const [name, mutate] of both) {
    it(`rejects: ${name}`, () => {
      const d = sheetProject();
      mutate(d);
      assert.equal(AkukoProjectSchema.safeParse(d).success, false, `Zod accepted: ${name}`);
      assert.equal(validateJson(d), false, `JSON Schema accepted: ${name}`);
    });
  }

  // out > in is a Zod refinement: the JSON Schema checks the shape only.
  const zodOnly: [string, (d: any) => void][] = [
    ['shot film out before in', (d) => { d.shots[0].film = { in_s: 4, out_s: 3 }; }],
    ['shot film of zero length', (d) => { d.shots[0].film = { in_s: 4, out_s: 4 }; }],
    ['card film out before in', (d) => { d.assets[0].film = { in_s: 2, out_s: 1 }; }],
    ['line out before in', (d) => { d.audio.lines[0].film_out_s = 10; }],
  ];
  for (const [name, mutate] of zodOnly) {
    it(`rejects in Zod: ${name}`, () => {
      const d = sheetProject();
      mutate(d);
      const r = AkukoProjectSchema.safeParse(d);
      assert.equal(r.success, false, `Zod accepted: ${name}`);
      assert.match(r.success ? '' : r.error.message, /must be after/);
    });
  }
});

describe('real-project integrity: each rule has a failing case', () => {
  const cases: [string, (p: AkukoProject) => void, string[]][] = [
    ['a shot line not in audio.lines', (p) => { p.shots[2]!.lines![0]!.id = 'L999'; }, ['shots[2].lines[0].id']],
    ['a shot line of the wrong kind', (p) => { p.shots[3]!.lines![1]!.kind = 'spoken'; }, ['shots[3].lines[1].kind']],
    ['a repeated line id', (p) => { p.audio.lines!.push({ ...p.audio.lines![2]! }); }, ['audio.lines[3].id']],
    ['overlapping film times in one scene', (p) => { p.shots[1]!.film = { in_s: 3.5, out_s: 9.25 }; }, ['shots[1].film']],
    ['a card without film time', (p) => { delete p.assets[0]!.film; }, ['assets[0].film']],
    ['a card without a file', (p) => { delete p.assets[1]!.file; }, ['assets[1].file']],
    ['a gate scoped to an unknown shot, scene and part', (p) => {
      p.gates![1]!.scope = { shots: ['S09-010'], scenes: ['S09'], parts: ['P9'] };
    }, ['gates[1].scope.shots[0]', 'gates[1].scope.scenes[0]', 'gates[1].scope.parts[0]']],
    ['a malformed upload hash (built in code, never parsed)', (p) => { p.rules!.uploads.allow[0]!.sha256 = 'ABC'; }, ['rules.uploads.allow[0].sha256']],
    ['a consent_ref to no consent', (p) => { p.rules!.uploads.allow[0]!.consent_ref = 'consent-9'; }, ['rules.uploads.allow[0].consent_ref']],
    ['a repeated consent id', (p) => { p.rules!.consent.push({ ...p.rules!.consent[0]! }); }, ['rules.consent[1].id']],
    ['rule scopes naming unknown shots and scenes', (p) => {
      p.rules!.banned[0]!.scope = { scenes: ['S09'] };
      p.rules!.require[0]!.scope = { shots: ['S09-010'] };
      p.rules!.exempt[0]!.shots = ['S09-020'];
    }, ['rules.banned[0].scope.scenes[0]', 'rules.require[0].scope.shots[0]', 'rules.exempt[0].shots[0]']],
    ['never_from_photo naming no bible entry', (p) => { p.rules!.never_from_photo.push('char_ghost'); }, ['rules.never_from_photo[1]']],
    ['a repeated person id', (p) => { p.people!.push({ ...p.people![0]! }); }, ['people[2].id']],
    ['a sign-off by an unknown person', (p) => { p.gates![0]!.signed!.by = 'p-nobody'; }, ['gates[0].signed.by']],
    ['a sign-off by an approver', (p) => { p.gates![0]!.signed!.by = 'p-day'; }, ['gates[0].signed.by']],
    ['a sign-off recorded with the approver role', (p) => { p.gates![0]!.signed!.role = 'approver'; }, ['gates[0].signed.role']],
    ['a gate id that is also a shot id', (p) => { p.gates![1]!.id = 'S01-010'; }, ['gates[1]']],
  ];
  for (const [name, mutate, want] of cases) {
    it(name, () => {
      const p = parse(sheetProject());
      mutate(p);
      assert.deepEqual(paths(p), want);
    });
  }

  it('gaps between shots, a shot with no scene and touching spans are fine', () => {
    const p = parse(sheetProject());
    p.shots.push({ ...structuredClone(p.shots[0]!), id: 'S03-010', scene: undefined, film: { in_s: 1, out_s: 2 } });
    delete p.shots[4]!.scene;
    assert.deepEqual(checkIntegrity(p), []);
  });
});

describe('old projects parse unchanged', () => {
  it('the board fixture parses to exactly its committed text (no new keys appear)', () => {
    const path = join(HERE, '..', 'fixtures', 'the-beating', 'akuko.json');
    const text = readText(path);
    const p = parse(JSON.parse(text));
    assert.equal(`${JSON.stringify(p, null, 2)}\n`, text);
    for (const k of ['rules', 'people', 'gates'] as const) assert.equal(k in p, false, k);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('Studio and freeform conversions still parse, round-trip and pass integrity', () => {
    const sample = fromStudio(JSON.parse(readText(join(REPO, 'packages', 'apps', 'studio', 'fixtures', 'sample', 'storyboard.json'))));
    const full = fromStudio(JSON.parse(readText(join(HERE, '__fixtures__', 'studio-full.json'))));
    const free = fromFreeform(JSON.parse(readText(join(HERE, '__fixtures__', 'freeform-storyboard.json'))), { now: '2026-11-07T12:00:00Z' });
    for (const p of [sample, full, free]) {
      assert.deepEqual(parse(JSON.parse(JSON.stringify(p))), p);
      assert.deepEqual(checkIntegrity(p), []);
    }
  });
});

describe('unit ids built from shot ids', () => {
  const sheetIds = ['S11-010', 'S16b-010', 'S00-010', 'S11-015A'];
  const canonicalIds = ['sc1_sh1', 'sc3_sh2A'];

  it('sheet ids and canonical ids are disjoint forms', () => {
    for (const id of sheetIds) {
      assert.ok(isSheetShotId(id), id);
      assert.ok(!isCanonicalShotId(id), id);
      assert.ok(!id.includes('_'), id);
      assert.ok(IdSchema.safeParse(id).success, id);
    }
    for (const id of canonicalIds) assert.ok(!isSheetShotId(id), id);
    for (const id of ['S11_010', 'S11-010-keyframes', 'S11-010-2', 'sc1-sh1', 's11-010', 'S11', 'job_kf_1']) assert.ok(!isSheetShotId(id), id);
  });

  it('every stage helper round-trips a sheet id (and a canonical id)', () => {
    const helpers: [string, (shot: string) => string, (typeof SHOT_UNIT_KINDS)[number]][] = [
      ['keyframes/plan.ts assetIdFor', keyframeIdFor, 'keyframe'],
      ['motion/plan.ts assetIdFor', clipIdFor, 'clip'],
      ['sound/plan.ts assetIdFor', voIdFor, 'vo'],
      ['handoff/plan.ts `${shot.id}_clip` / `_keyframe`', (s) => `${s}_clip`, 'clip'],
      ['<shot>_lipsync (WP-28b)', (s) => shotUnitId(s, 'lipsync'), 'lipsync'],
    ];
    for (const shot of [...sheetIds, ...canonicalIds]) {
      for (const [name, build, kind] of helpers) {
        const unit = build(shot);
        assert.equal(unit, shotUnitId(shot, kind), name);
        assert.deepEqual(parseShotUnitId(unit), { shot, kind }, `${name}: ${unit}`);
        assert.ok(IdSchema.safeParse(unit).success, `${name}: ${unit}`);
        assert.ok(!isSheetShotId(unit) && !isCanonicalShotId(unit), `${name}: ${unit} looks like a shot id`);
      }
      assert.equal(parseShotUnitId(shot), undefined, shot);
    }
  });

  it('provider output ids and manual file names built from a sheet shot or unit stay unambiguous', () => {
    const p = parse(sheetProject());
    const shotOut = planAssetId(p, 'S02-010', 'sketch');
    assert.deepEqual(shotOut, { id: 'S02-010-sketch', inPlace: false });
    assert.ok(!isSheetShotId(shotOut.id) && IdSchema.safeParse(shotOut.id).success);
    p.assets.push({ ...structuredClone(p.assets[2]!), id: 'S02-010-sketch', owner: 'S02-010' });
    assert.equal(planAssetId(p, 'S02-010', 'sketch').id, 'S02-010-sketch-2');
    // An asset unit with no file is filled in place: the lip-sync unit keeps its id.
    assert.deepEqual(planAssetId(p, 'S02b-010_lipsync', 'motion'), { id: 'S02b-010_lipsync', inPlace: true });
    assert.equal(expectedFilename('S02-010_keyframe', 'keyframes', 'png'), 'S02-010_keyframe-keyframes.png');
  });
});

describe("today's fold with the new fields (decisions/fold.ts, read-only)", () => {
  const CONFORMED = ['default-board@0.2'];
  const base = { by: 'Day Approver', at: '2026-11-09T13:00:00Z', view: 'default-board@0.2' };

  it('folds a project that has rules, people, gates, cards and a lip-sync unit without changing any of it', () => {
    const p = parse(sheetProject());
    const r = foldDecisions(p, [], { conformed: CONFORMED });
    assert.equal(r.report.changed, false);
    assert.deepEqual(r.project, p);
  });

  it('a board approval aimed at a gate is refused and not stored: nothing is approved or signed', () => {
    const p = parse(sheetProject());
    delete p.gates![0]!.signed;
    const d = DecisionSchema.parse({ id: randomUUID(), action: 'approve', unit: 'G-LOOK', stage: 'keyframes', ...base });
    const r = foldDecisions(p, [d], { conformed: CONFORMED });
    assert.deepEqual(r.report.rejected.map((x) => [x.unit, x.code]), [['G-LOOK', 'unknown-unit']]);
    assert.deepEqual(r.report.applied, []);
    assert.deepEqual(r.project.decisions, []);
    assert.equal(r.project.gates![0]!.signed, undefined);
    assert.deepEqual(r.project.shots.map((s) => s.status), p.shots.map((s) => s.status));
    assert.deepEqual(checkIntegrity(r.project), []);
  });

  it('a sign-off cannot be written as a decision today (no decision variant carries one)', () => {
    const signoff = { id: randomUUID(), action: 'signoff', unit: 'G-LOOK', stage: 'keyframes', role: 'signoff', via: 'email', ...base };
    assert.equal(DecisionSchema.safeParse(signoff).success, false);
    assert.equal(AkukoProjectSchema.safeParse({ ...sheetProject(), decisions: [signoff] }).success, false);
  });

  it('a card can still be decided on like any asset, and an agent can never approve one', () => {
    const p = parse(sheetProject());
    const agent = DecisionSchema.parse({ id: randomUUID(), action: 'approve', unit: 'card_title', stage: 'export', ...base, by: 'agent' });
    const r = foldDecisions(p, [agent], { conformed: CONFORMED });
    assert.deepEqual(r.report.rejected.map((x) => x.code), ['not-a-person']);
    assert.equal(r.project.assets[0]!.status, 'pending-review');
  });
});
