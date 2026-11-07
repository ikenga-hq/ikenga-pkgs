// views/decision.schema.json is generated from WP-01's Zod DecisionSchema,
// never hand-edited, and agrees with Zod.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { DecisionSchema } from '../schema/akuko-project.ts';
import { DECISION_SCHEMA_PATH, generateDecisionSchema, serializeDecisionSchema } from './export-decision-schema.ts';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const committed = readFileSync(DECISION_SCHEMA_PATH, 'utf8');
const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(committed));

const base = { id: '307820e6-1823-4a86-9b98-7a5e68ce1d4d', unit: 'sc2_sh4', stage: 'sketch', by: 'you', at: '2026-11-07T10:00:00Z', view: 'default-board@0.1' };

describe('views/decision.schema.json', () => {
  it('is exactly what decisions/export-decision-schema.ts generates (regenerate, never hand-edit)', () => {
    assert.equal(serializeDecisionSchema(generateDecisionSchema()), committed);
  });

  it('accepts and rejects the same records as the Zod schema', () => {
    const cases: [string, unknown][] = [
      ['approve', { ...base, action: 'approve' }],
      ['approve with text', { ...base, action: 'approve', text: 'nice' }],
      ['request-changes', { ...base, action: 'request-changes', text: 'darker' }],
      ['request-changes without text', { ...base, action: 'request-changes' }],
      ['note with empty text', { ...base, action: 'note', text: '' }],
      ['approve-spend', { ...base, action: 'approve-spend', unit: 'job_kf_sc1', stage: 'keyframes', text: 'approve 0.36 USD' }],
      ['decline-spend', { ...base, action: 'decline-spend', unit: 'job_kf_sc1' }],
      ['undo', { ...base, action: 'undo', undoes: '2ec96544-372a-4a31-9b6d-1780d32876ff' }],
      ['undo without undoes', { ...base, action: 'undo' }],
      ['unknown action', { ...base, action: 'approve-all' }],
      ['extra key', { ...base, action: 'approve', amount: 0.36 }],
      ['id not a uuid', { ...base, action: 'approve', id: 'one' }],
      ['timestamp without zone', { ...base, action: 'approve', at: '2026-11-07T10:00:00' }],
      ['empty by', { ...base, action: 'approve', by: '' }],
      ['unsafe unit', { ...base, action: 'approve', unit: '../x' }],
      ['bad stage', { ...base, action: 'approve', stage: 'review' }],
    ];
    let accepted = 0;
    for (const [name, rec] of cases) {
      const z = DecisionSchema.safeParse(rec).success;
      assert.equal(validate(rec), z, `${name}: zod ${z}, json schema ${!z} — ${JSON.stringify(validate.errors)}`);
      if (z) accepted++;
    }
    assert.equal(accepted, 6);
  });
});
