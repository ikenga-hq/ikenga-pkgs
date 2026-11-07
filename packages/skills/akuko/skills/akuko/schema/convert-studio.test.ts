// Studio storyboard.json ⇄ akuko.json.
//
// The gate: a Studio project converted to akuko and back is deep-equal to the
// original — no field lost, including Studio's unknown passthrough keys.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProjectSchema } from '@ikenga/studio-schema';
import { AkukoProjectSchema } from './akuko-project.ts';
import { RUNG_STAGE, StudioConversionError, fromStudio, stageToRung, toStudio } from './convert/studio.ts';
import { checkIntegrity } from './integrity.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

const SAMPLE_PATH = join(REPO, 'packages', 'apps', 'studio', 'fixtures', 'sample', 'storyboard.json');
const sample = readJson(SAMPLE_PATH) as Record<string, unknown>;
const full = readJson(join(HERE, '__fixtures__', 'studio-full.json')) as Record<string, unknown>;
const film = readJson(join(HERE, '..', 'fixtures', 'the-beating', 'akuko.json'));

describe('Studio → akuko → Studio round trip', () => {
  it('the Studio sample storyboard.json round-trips deep-equal (no field lost)', () => {
    assert.equal(ProjectSchema.safeParse(sample).success, true, 'sample is a valid Studio project');
    const back = toStudio(fromStudio(sample));
    assert.deepStrictEqual(back, sample);
  });

  it('a Studio project using every field, including unknown keys, round-trips deep-equal', () => {
    const back = toStudio(fromStudio(full));
    assert.deepStrictEqual(back, full);
    assert.deepStrictEqual(back, ProjectSchema.parse(full));
  });

  it('a sparse Studio project round-trips to its Studio-normalised form', () => {
    const sparse = {
      schema_version: 1,
      slug: 'sparse',
      title: 'Sparse',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archetype_id: 'explainer',
      cells: [{
        uid: 'c1', beat_id: 'b1', rung: '1_lofi', index: 0, label: 'One',
        time: { start: 0, end: 1 }, frames: { start: 0, end: 30 },
        content_path: 'cells/lofi/c1/content.html',
        rungs: { '0_beat_sheet': { status: 'pending' }, '1_lofi': { status: 'pending' }, '2_hifi': { status: 'pending' } },
        last_edited: '2026-01-01T00:00:00Z',
      }],
    };
    assert.deepStrictEqual(toStudio(fromStudio(sparse)), ProjectSchema.parse(sparse));
  });

  it('a Studio project with no script and a script-less akuko project both stay script-less', () => {
    const noScript = { ...(full as object), script: null };
    assert.deepStrictEqual(toStudio(fromStudio(noScript)), ProjectSchema.parse(noScript));
  });

  it('akuko → Studio → akuko is stable for a Studio-born project', () => {
    const once = fromStudio(full);
    assert.deepStrictEqual(fromStudio(toStudio(once)), once);
  });
});

describe('Studio → akuko field mapping', () => {
  const p = fromStudio(full);
  const [climb, lamp, orphan] = p.shots;

  it('produces a schema-valid, internally consistent akuko project', () => {
    assert.equal(AkukoProjectSchema.safeParse(p).success, true);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('maps project identity and the pipeline pointer', () => {
    assert.equal(p.project.slug, 'lantern-test');
    assert.equal(p.project.profile, 'film', 'the narrative archetype is the film profile');
    assert.equal(p.project.aspect_ratio, '9:16');
    assert.equal(p.current_stage, 'keyframes', 'current_rung 2 is the key-frames stage');
    assert.equal(p.studio?.archetype_id, 'narrative');
    assert.deepEqual(p.studio?.extra, { studio_ui: { zoom: 1.5, panels: ['timeline'] } });
  });

  it('turns script scene ids into scenes and links shots to them through their beat', () => {
    assert.deepEqual(p.scenes, [{ id: 'sc1' }, { id: 'sc2' }]);
    assert.equal(climb?.scene, 'sc1');
    assert.equal(orphan?.scene, undefined, 'a cell whose beat is not in the script has no scene');
    assert.equal(p.script.beats.length, 2);
  });

  it('turns anchors into reference assets that remember their Studio kind', () => {
    assert.deepEqual(p.assets.map((a) => [a.id, a.kind, a.studio?.anchor.kind]), [
      ['anchor-keeper', 'reference', 'character'],
      ['anchor-look', 'reference', 'style'],
    ]);
    assert.deepEqual(climb?.refs, ['anchor-keeper', 'anchor-look']);
  });

  it('maps rungs to stages and keeps per-rung status and stills in by_stage', () => {
    for (const [rung, stage] of Object.entries(RUNG_STAGE)) assert.equal(stageToRung(stage), rung);
    assert.equal(climb?.stage, 'keyframes');
    assert.equal(lamp?.stage, 'sketch');
    assert.equal(orphan?.stage, 'breakdown');
    assert.deepEqual(climb?.by_stage, {
      breakdown: { status: 'approved', content: 'Keeper climbs toward the lamp.' },
      sketch: { status: 'approved', output: { uri: 'cells/lofi/keeper-climb/still.png', mime: 'image/png', hash: 'sha256-def' } },
      keyframes: { status: 'pending-review', output: { uri: 'cells/hifi/keeper-climb/still.png' } },
    });
  });

  it('reads status from Studio approval first, without granting approval', () => {
    assert.equal(climb?.status, 'approved', 'cell.approved wins');
    assert.equal(lamp?.status, 'pending-review', 'a rung marked approved on an unapproved cell needs a look');
    assert.equal(orphan?.status, 'needs-rework');
  });

  it('converts comments to ISO timestamps and stage names', () => {
    assert.deepEqual(climb?.comments, [
      { ts: '2025-06-01T09:00:00.000Z', stage: 'breakdown', author: 'unknown', text: 'Start lower on the stair.' },
      { ts: '2025-06-02T09:00:00.123Z', stage: 'keyframes', author: 'unknown', text: 'Revised: lower start.' },
    ]);
    assert.deepEqual(orphan?.comments, [
      { ts: '1970-01-01T00:00:00.000Z', stage: 'sketch', author: 'unknown', text: 'epoch comment' },
    ]);
  });

  it('maps production fields first-class and keeps engine wiring in the studio slot', () => {
    assert.equal(climb?.shot_type, 'ls');
    assert.equal(climb?.camera_move, 'crane');
    assert.equal(climb?.camera, 'Crane up the stairwell');
    assert.equal(climb?.duration_s, 7);
    assert.equal(orphan?.duration_s, 3.25);
    assert.equal(climb?.seed, 42);
    assert.equal(lamp?.narration, null);
    assert.equal(climb?.studio?.renderer, 'fal');
    assert.equal(climb?.studio?.renders[0]?.queue_position, 3, 'render passthrough keys survive');
    assert.deepEqual(climb?.studio?.extra, { ui_pin: { x: 10, y: 20 } });
    assert.equal(lamp?.studio?.extra, undefined);
  });
});

describe('akuko → Studio projection', () => {
  it('projects the film fixture onto a valid Studio project', () => {
    const p = AkukoProjectSchema.parse(film);
    const s = toStudio(p);
    assert.equal(ProjectSchema.safeParse(s).success, true);
    assert.equal(s.cells.length, p.shots.length);
    assert.equal(s.current_rung, 1, 'the sketch stage is the lo-fi rung');
    assert.equal(s.archetype_id, 'narrative');
    const sh3 = s.cells.find((c) => c.uid === 'sc2_sh3');
    assert.equal(sh3?.rungs['1_lofi'].status, 'needs-rework');
    assert.equal(sh3?.comments[0]?.rung, 1);
    assert.equal(sh3?.camera_text, 'Static');
    const top = s.cells.find((c) => c.uid === 'sc3_sh1');
    assert.equal(top?.shot_type, 'unset', 'overhead has no Studio shot type');
    assert.equal(top?.camera_text, 'Overhead, static', 'the camera note keeps the wording');
    // Bible refs expand to the bible entry's assets; assets without files are not anchors.
    assert.deepEqual(s.anchors, []);
    assert.deepEqual(s.cells[0]?.anchors, []);
    // Timeline positions are laid end to end.
    assert.deepEqual(s.cells.slice(0, 2).map((c) => [c.time, c.frames]), [
      [{ start: 0, end: 6 }, { start: 0, end: 180 }],
      [{ start: 6, end: 10 }, { start: 180, end: 300 }],
    ]);
  });

  it('rejects input that is not a Studio project', () => {
    assert.throws(() => fromStudio({ slug: 'x' }), StudioConversionError);
    assert.throws(() => fromStudio({ ...sample, schema_version: 2 }), StudioConversionError);
  });

  it('rejects a Studio project whose ids are not file-name safe', () => {
    const bad = structuredClone(sample) as { cells: { uid: string }[] };
    bad.cells[0]!.uid = 'has space';
    assert.throws(() => fromStudio(bad), StudioConversionError);
  });
});
