/**
 * akuko — instance file `.atelier/akuko/manifest.json` (WP-08, Atelier setup
 * lifecycle).
 *
 * Holds the non-money settings from `setup`: which provider keys are present
 * (names and a yes/no — never a value), defaults, and the brand the person
 * gave. The budget cap does NOT live here; it is `akuko.json.budget.cap`
 * (G-06). The skill ships no brand values (R2-8): brand is `null` until a
 * person provides one.
 */

import { z } from 'zod';
import { join } from 'node:path';
import { writeFileAtomic } from '../hosts/local.ts';
import { AkukoProjectSchema, TimestampSchema } from '../schema/akuko-project.ts';

export const MANIFEST_DIR = join('.atelier', 'akuko');
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_REL_PATH = `.atelier/akuko/${MANIFEST_FILE}`;
export const MANIFEST_TEMPLATE_VERSION = 1;

const HexColour = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'a colour is a hex value such as #1a2b3c');

/** Palette, fonts and logo. Every value comes from the person; none ships with the skill. */
export const BrandSchema = z.object({
  palette: z.array(z.object({ name: z.string().min(1).max(60).optional(), hex: HexColour }).strict()).max(24).default([]),
  fonts: z.array(z.object({ role: z.string().min(1).max(40).optional(), family: z.string().min(1).max(100) }).strict()).max(8).default([]),
  logo: z.string().min(1).max(500).nullable().default(null).describe('Path (relative to the project folder) or URL of the logo.'),
}).strict();
export type Brand = z.infer<typeof BrandSchema>;
export type BrandInput = z.input<typeof BrandSchema>;

const AspectRatioSchema = AkukoProjectSchema.shape.project.shape.aspect_ratio;

export const ManifestSchema = z.object({
  format: z.literal('akuko-instance'),
  template_version: z.literal(MANIFEST_TEMPLATE_VERSION),
  skill: z.literal('akuko'),
  updated_at: TimestampSchema,
  settings: z.object({
    /** provider id → the env var that holds its key, and whether it is set. Never the key. */
    keys_present: z.record(z.object({ env: z.string().min(1), present: z.boolean() }).strict()),
    defaults: z.object({
      aspect_ratio: AspectRatioSchema.optional(),
      runtime_s: z.number().positive().finite().optional(),
    }).strict(),
    brand: BrandSchema.nullable(),
    /** Windows only: whether HYPERFRAMES_BROWSER_PATH pointed at a real file when setup ran. */
    hyperframes_browser: z.object({ env: z.literal('HYPERFRAMES_BROWSER_PATH'), set: z.boolean() }).strict().nullable(),
  }).strict(),
}).strict();
export type Manifest = z.infer<typeof ManifestSchema>;

export function serializeManifest(m: Manifest): string {
  return `${JSON.stringify(ManifestSchema.parse(m), null, 2)}\n`;
}

/** Write `<projectDir>/.atelier/akuko/manifest.json` (hosts with a durable folder: B and C). */
export async function writeManifest(projectDir: string, m: Manifest): Promise<string> {
  const path = join(projectDir, MANIFEST_DIR, MANIFEST_FILE);
  await writeFileAtomic(path, serializeManifest(m));
  return path;
}
