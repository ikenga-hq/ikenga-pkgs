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

  it('agrees with Zod on documents that must be rejected', () => {
    const base = film as Record<string, any>;
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
    const minimal = { format: 'akuko', schema_version: 1, project: { slug: 'm', title: 'M', profile: 'film', created_at: '2026-11-01T00:00:00Z' } };
    for (const [name, doc] of [['with decisions', decided], ['minimal', minimal]] as const) {
      assert.equal(AkukoProjectSchema.safeParse(doc).success, true, `Zod rejected: ${name}`);
      assert.equal(validate(doc), true, `JSON Schema rejected ${name}: ${errors()}`);
    }
  });
});
