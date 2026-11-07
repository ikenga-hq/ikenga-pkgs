// The exported JSON Schema: generated (never hand-edited), and it accepts and
// rejects the same documents as the Zod schema, checked with a real JSON
// Schema validator (ajv, draft-07, with formats).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { AkukoProjectSchema } from './akuko-project.ts';
import { findStripObjects, strictDeep } from './strict-deep.ts';
import { AssetRefSchema as StudioAssetRefSchema } from '@ikenga/studio-schema';
import { fromFreeform } from './convert/freeform.ts';
import { fromStudio } from './convert/studio.ts';
import { JSON_SCHEMA_PATH, generateJsonSchema, serializeJsonSchema } from './export-json-schema.ts';

// ajv-formats is CommonJS; under NodeNext its default import is the module object.
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

const committedText = readFileSync(JSON_SCHEMA_PATH, 'utf8');

function compile(): ValidateFunction {
  // allowUnionTypes: `type: [..]` arrays are valid draft-07; ajv's strict mode only lints them.
  const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(committedText));
}

const validate = compile();
const errors = () => JSON.stringify(validate.errors, null, 2);

const film = readJson(join(HERE, '..', 'fixtures', 'the-beating', 'akuko.json'));
const fromSample = fromStudio(readJson(join(REPO, 'packages', 'apps', 'studio', 'fixtures', 'sample', 'storyboard.json')));
const fromFull = fromStudio(readJson(join(HERE, '__fixtures__', 'studio-full.json')));
const fromFree = fromFreeform(readJson(join(HERE, '__fixtures__', 'freeform-storyboard.json')), { now: '2026-11-07T12:00:00Z' });

describe('exported JSON Schema', () => {
  it('the committed schema is exactly what the export script generates', () => {
    assert.equal(serializeJsonSchema(generateJsonSchema()), committedText);
  });

  it('compiles under ajv strict mode', () => {
    assert.equal(typeof validate, 'function');
  });

  it('validates the converted board fixture', () => {
    assert.equal(validate(film), true, errors());
  });

  it('validates projects converted from Studio and freeform storyboards', () => {
    for (const [name, doc] of [['sample', fromSample], ['full', fromFull], ['freeform', fromFree]] as const) {
      assert.equal(validate(JSON.parse(JSON.stringify(doc))), true, `${name}: ${errors()}`);
    }
  });

  it('no object anywhere in the akuko schema silently strips unknown keys', () => {
    assert.deepEqual(findStripObjects(AkukoProjectSchema), []);
    // The detector does see strip objects: Studio's own AssetRef is one.
    assert.deepEqual(findStripObjects(StudioAssetRefSchema), ['$']);
    assert.deepEqual(findStripObjects(strictDeep(StudioAssetRefSchema)), []);
  });

  it('agrees with Zod on documents that must be rejected', () => {
    const base = film as Record<string, any>;
    const studioBase = JSON.parse(JSON.stringify(fromFull)) as Record<string, any>;
    const freeBase = JSON.parse(JSON.stringify(fromFree)) as Record<string, any>;
    const junk = { junk: 1 };
    // Unknown keys inside Studio shapes composed into akuko: Zod must reject
    // them like the JSON Schema does, never accept them and drop them.
    const nested: [string, Record<string, any>, (d: any) => void][] = [
      ['extra key in a by_stage output file ref', studioBase, (d) => { Object.assign(d.shots[0].by_stage.sketch.output, junk); }],
      ['extra key in a by_stage output (freeform import)', freeBase, (d) => { Object.assign(d.shots[0].by_stage.sketch.output, junk); }],
      ['extra key in a by_stage record', studioBase, (d) => { Object.assign(d.shots[0].by_stage.breakdown, junk); }],
      ['extra key in a script beat', studioBase, (d) => { Object.assign(d.script.beats[0], junk); }],
      ['extra key in narration', studioBase, (d) => { Object.assign(d.audio.narration, junk); }],
      ['extra key in narration audio file ref', studioBase, (d) => { Object.assign(d.audio.narration.audio, junk); }],
      ['extra key in a narration word', studioBase, (d) => { Object.assign(d.audio.narration.words[0], junk); }],
      ['extra key in audio analysis', studioBase, (d) => { Object.assign(d.audio.analysis, junk); }],
      ['extra key in audio analysis source', studioBase, (d) => { Object.assign(d.audio.analysis.source, junk); }],
      ['extra key in project resolution', studioBase, (d) => { Object.assign(d.project.resolution, junk); }],
      ['extra key in an asset file ref', studioBase, (d) => { Object.assign(d.assets[0].file, junk); }],
      ['extra key in asset studio anchor', studioBase, (d) => { Object.assign(d.assets[0].studio.anchor, junk); }],
      ['extra key in studio shot time', studioBase, (d) => { Object.assign(d.shots[0].studio.time, junk); }],
      ['extra key in studio shot frames', studioBase, (d) => { Object.assign(d.shots[0].studio.frames, junk); }],
      ['extra key in studio reference layer', studioBase, (d) => { Object.assign(d.shots[0].studio.reference_layer[0], junk); }],
      ['extra key in studio audio cue', studioBase, (d) => { Object.assign(d.shots[0].studio.audio_cue, junk); }],
      ['extra key in a studio render output', studioBase, (d) => { Object.assign(d.shots[0].studio.renders[0].output, junk); }],
      ['extra key in studio selected concept', studioBase, (d) => { Object.assign(d.studio.selected_concepts[0], junk); }],
      ['extra key in studio script header', studioBase, (d) => { Object.assign(d.studio.script, junk); }],
      ['extra key in freeform shot time', freeBase, (d) => { Object.assign(d.shots[0].freeform.time, junk); }],
      ['extra key in host', base, (d) => { Object.assign(d.host, junk); }],
      ['extra key in a stage record', base, (d) => { Object.assign(d.stages.sketch, junk); }],
      ['extra key in a comment', base, (d) => { Object.assign(d.shots[5].comments[0], junk); }],
      ['extra key in blocking', base, (d) => { Object.assign(d.shots[0].blocking[0], junk); }],
      ['extra key in a bible entry', base, (d) => { Object.assign(d.bible.characters[0], junk); }],
      ['extra key in pending spend', base, (d) => { Object.assign(d.pending_spend[0], junk); }],
      ['extra key in a ledger entry', base, (d) => { Object.assign(d.ledger[0], junk); }],
      ['extra key in budget', base, (d) => { Object.assign(d.budget, junk); }],
      ['extra key in a scene', base, (d) => { Object.assign(d.scenes[0], junk); }],
    ];
    for (const [name, doc, mutate] of nested) {
      const copy = structuredClone(doc);
      assert.equal(AkukoProjectSchema.safeParse(copy).success, true, `base for "${name}" must be valid`);
      mutate(copy);
      assert.equal(AkukoProjectSchema.safeParse(copy).success, false, `Zod accepted: ${name}`);
      assert.equal(validate(copy), false, `JSON Schema accepted: ${name}`);
    }
    // A render record stays open to unknown keys in both, as in Studio.
    const render = structuredClone(studioBase);
    render.shots[0].studio.renders[0].another_engine_key = true;
    assert.equal(AkukoProjectSchema.safeParse(render).success, true, 'Zod rejected a render passthrough key');
    assert.equal(validate(render), true, `JSON Schema rejected a render passthrough key: ${errors()}`);

    const mutants: [string, (d: any) => void][] = [
      ['unknown top-level key', (d) => { d.surprise = true; }],
      ['wrong format', (d) => { d.format = 'studio'; }],
      ['wrong schema_version', (d) => { d.schema_version = 2; }],
      ['missing project', (d) => { delete d.project; }],
      ['bad stage id', (d) => { d.current_stage = 'review'; }],
      ['missing stage', (d) => { delete d.stages.export; }],
      ['bad unit status', (d) => { d.shots[0].status = 'done'; }],
      ['unknown shot key', (d) => { d.shots[0].lens = '35mm'; }],
      ['unsafe shot id', (d) => { d.shots[0].id = '../x'; }],
      ['timestamp without seconds', (d) => { d.shots[5].comments[0].ts = '2026-11-06T21:12Z'; }],
      ['blocking outside the frame', (d) => { d.shots[0].blocking[0].x = 1.5; }],
      ['negative estimate', (d) => { d.pending_spend[0].estimate = -1; }],
      ['lowercase currency', (d) => { d.budget.currency = 'usd'; }],
      ['ledger without status', (d) => { delete d.ledger[0].status; }],
      ['empty ledger id', (d) => { d.ledger[0].id = ''; }],
      ['comment decision not a uuid', (d) => { d.shots[5].comments[0].decision = 'one'; }],
      ['negative approved_max', (d) => { d.pending_spend[0].approved_max = -1; }],
      ['pending spend created_at without zone', (d) => { d.pending_spend[0].created_at = '2026-11-06T21:12:00'; }],
      ['request-changes without text', (d) => {
        d.decisions = [{ id: randomUUID(), action: 'request-changes', unit: 'sc1_sh1', stage: 'sketch', by: 'you', at: '2026-11-06T21:12:00Z', view: 'test' }];
      }],
      ['decision id not a uuid', (d) => {
        d.decisions = [{ id: 'one', action: 'approve', unit: 'sc1_sh1', stage: 'sketch', by: 'you', at: '2026-11-06T21:12:00Z', view: 'test' }];
      }],
    ];
    for (const [name, mutate] of mutants) {
      const doc = structuredClone(base);
      mutate(doc);
      assert.equal(AkukoProjectSchema.safeParse(doc).success, false, `Zod accepted: ${name}`);
      assert.equal(validate(doc), false, `JSON Schema accepted: ${name}`);
    }
  });

  it('agrees with Zod on documents that must be accepted', () => {
    const decided = structuredClone(film) as Record<string, any>;
    const first = randomUUID();
    decided.decisions = [
      { id: first, action: 'request-changes', unit: 'sc2_sh3', stage: 'sketch', text: 'Lower angle.', by: 'you', at: '2026-11-06T21:12:00Z', view: 'default-board@0.1' },
      { id: randomUUID(), action: 'undo', undoes: first, unit: 'sc2_sh3', stage: 'sketch', by: 'you', at: '2026-11-06T21:13:00+01:00', view: 'default-board@0.1' },
      { id: randomUUID(), action: 'approve-spend', unit: 'job_kf_sc1', stage: 'keyframes', by: 'you', at: '2026-11-06T21:14:00.5Z', view: 'freehand:spend' },
    ];
    decided.ledger[0].id = 'call-1';
    decided.shots[5].comments[0].decision = first;
    Object.assign(decided.pending_spend[0], { approved_max: 0.5, decision: randomUUID(), created_at: '2026-11-06T21:00:00Z' });
    const minimal = { format: 'akuko', schema_version: 1, project: { slug: 'm', title: 'M', profile: 'film', created_at: '2026-11-01T00:00:00Z' } };
    for (const [name, doc] of [['with decisions', decided], ['minimal', minimal]] as const) {
      assert.equal(AkukoProjectSchema.safeParse(doc).success, true, `Zod rejected: ${name}`);
      assert.equal(validate(doc), true, `JSON Schema rejected ${name}: ${errors()}`);
    }
  });
});
