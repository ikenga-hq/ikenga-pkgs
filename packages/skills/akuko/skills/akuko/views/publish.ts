/**
 * akuko — put the current project into the default board and publish it.
 *
 *   node --experimental-strip-types views/publish.ts --project <folder>
 *
 * Hosts B and C (a local project folder). It reads `<folder>/akuko.json`,
 * writes it into the board's `<script id="akuko-project">` block (every `<`
 * as `<`, the same escape the publishers and check-view use) and
 * publishes the page through `LocalHost.publishView()`, so the host's
 * conformance gate still applies. Embedding the project does not change the
 * conformance hash. Prints the path of `<folder>/views/default-board.html`.
 *
 * Run it again whenever you want the page to start from newer data; a page
 * served over http re-reads `akuko.json` by itself. Decisions held only in an
 * open page are lost on a reload: read them first (`actions/review.md` §1).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeJsonForScript, findJsonBlock, PROJECT_BLOCK } from '../scripts/check-view/hash.mjs';
import { createLocalHost } from '../hosts/local.ts';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BOARD = join(SKILL, 'views', 'default-board.html');

/** The board page with `project` written into its project block. Throws when the page has no usable block. */
export function embedProject(html: string, project: unknown): string {
  const b = findJsonBlock(html, PROJECT_BLOCK);
  if (b.status !== 'ok') throw new Error(`the board has no usable <script id="${PROJECT_BLOCK}"> block${b.status === 'bad' ? ` (${b.reason})` : ''}`);
  return html.slice(0, b.start) + escapeJsonForScript(JSON.stringify(project)) + html.slice(b.end);
}

export async function publishBoard(projectDir: string, boardFile: string = DEFAULT_BOARD): Promise<string> {
  const host = createLocalHost({ projectDir });
  const project = await host.readState();
  const out = await host.publishView({ name: 'default-board', title: 'akuko default board', html: embedProject(readFileSync(boardFile, 'utf8'), project), writesDecisions: true });
  if (!out.path) throw new Error('the host returned no path');
  return out.path;
}

export async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf('--project');
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (!dir) {
    process.stderr.write('usage: node --experimental-strip-types views/publish.ts --project <folder>\n');
    return 2;
  }
  try {
    process.stdout.write(`${await publishBoard(resolve(dir))}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`publish failed: ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
