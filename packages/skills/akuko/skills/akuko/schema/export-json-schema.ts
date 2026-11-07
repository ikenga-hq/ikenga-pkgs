/**
 * Generate `akuko-project.schema.json` from the Zod schema.
 *
 *   node --experimental-strip-types schema/export-json-schema.ts
 *
 * The output is deterministic (declaration order, two-space indent, trailing
 * newline), so CI can rebuild it and fail on any diff. Never edit the JSON by
 * hand: change `akuko-project.ts` and re-run this script.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AssetRefSchema } from '@ikenga/studio-schema';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AKUKO_SCHEMA_VERSION, AkukoProjectSchema, Schemas } from './akuko-project.ts';

export const JSON_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'akuko-project.schema.json');

export function generateJsonSchema(): Record<string, unknown> {
  const { AkukoProject: _root, ...definitions } = Schemas;
  const generated = zodToJsonSchema(AkukoProjectSchema, {
    name: 'AkukoProject',
    target: 'jsonSchema7',
    $refStrategy: 'root',
    definitions: { ...definitions, AssetRef: AssetRefSchema },
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    title: 'akuko project',
    description: `akuko.json project format, schema_version ${AKUKO_SCHEMA_VERSION}. Generated from akuko-project.ts; do not edit by hand.`,
    ...rest,
  };
}

export const serializeJsonSchema = (schema: Record<string, unknown>): string =>
  `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeFileSync(JSON_SCHEMA_PATH, serializeJsonSchema(generateJsonSchema()));
  console.log(`wrote ${JSON_SCHEMA_PATH}`);
}
