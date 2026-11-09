/**
 * Build the handoff fixture as a real project folder and export it, for the manual Resolve check
 * (`../MANUAL-CHECK.md`):
 *
 *   node --experimental-strip-types __fixtures__/make.ts <empty folder> [fps]
 *
 * The media are real and playable: PNG stills in a colour per shot, mp4 clips with the shot id and a running
 * timecode burned in (made with ffmpeg, which must be on PATH), and WAV tones. If ffmpeg is missing this says so
 * and stops; check a real project instead.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildExportProject } from './project.ts';
import { realMedia } from './real-media.ts';
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
let media;
try {
  media = realMedia();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
const project = await buildExportProject(dir, media);
const r = await writeExport({ project, projectDir: dir, outDir: join(dir, 'export', 'resolve'), format: 'both', ...(process.argv[3] ? { fps: process.argv[3] } : {}) });
console.log(`Fixture project: ${dir}\nExport: ${r.outDir}\n${r.written.length} files written.`);
