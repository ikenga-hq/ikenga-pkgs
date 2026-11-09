/**
 * Build the handoff fixture as a real project folder and export it, for the manual Resolve check
 * (`../MANUAL-CHECK.md`):
 *
 *   node --experimental-strip-types __fixtures__/make.ts <empty folder> [fps]
 *
 * The media are tiny placeholders (a 11-byte PNG, mp4 files with a movie header but no picture, silent
 * WAVs), so Resolve will show them as offline or black: what the check looks at is the timeline's
 * structure (order, lengths, audio positions, relinking by name), not the pictures.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildExportProject } from './project.ts';
import { writeExport } from '../write.ts';

const dir = process.argv[2] ? resolve(process.argv[2]) : '';
if (!dir) {
  console.error('usage: make.ts <empty folder> [fps]');
  process.exit(2);
}
if (existsSync(dir) && readdirSync(dir).length > 0) {
  console.error(`${dir} is not empty; use a new folder.`);
  process.exit(2);
}
const project = await buildExportProject(dir);
const r = await writeExport({ project, projectDir: dir, outDir: join(dir, 'export', 'resolve'), format: 'both', ...(process.argv[3] ? { fps: process.argv[3] } : {}) });
console.log(`Fixture project: ${dir}\nExport: ${r.outDir}\n${r.written.length} files written.`);
