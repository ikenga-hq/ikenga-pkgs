/**
 * Generate `views/decision.schema.json` from WP-01's Zod `DecisionSchema`.
 *
 *   node --experimental-strip-types decisions/export-decision-schema.ts
 *
 * Same approach and options as `schema/export-json-schema.ts` (draft-07,
 * `$refStrategy: 'root'`, deterministic output, trailing newline), so the
 * decision format has one source of truth: `schema/akuko-project.ts`. Never
 * edit the JSON by hand. `decisions/decision-schema.test.ts` fails if the
 * committed file differs from what this script generates.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AKUKO_SCHEMA_VERSION, DecisionSchema, IdSchema, StageIdSchema, TimestampSchema } from '../schema/akuko-project.ts';

export const DECISION_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'views', 'decision.schema.json');

export function generateDecisionSchema(): Record<string, unknown> {
  const generated = zodToJsonSchema(DecisionSchema, {
    name: 'Decision',
    target: 'jsonSchema7',
    $refStrategy: 'root',
    definitions: { Id: IdSchema, Timestamp: TimestampSchema, StageId: StageIdSchema },
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    title: 'akuko decision',
    description: `One human decision written by a review surface (akuko.json schema_version ${AKUKO_SCHEMA_VERSION}). Generated from schema/akuko-project.ts by decisions/export-decision-schema.ts; do not edit by hand.`,
    ...rest,
  };
}

export const serializeDecisionSchema = (schema: Record<string, unknown>): string =>
  `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeFileSync(DECISION_SCHEMA_PATH, serializeDecisionSchema(generateDecisionSchema()));
  console.log(`wrote ${DECISION_SCHEMA_PATH}`);
}
