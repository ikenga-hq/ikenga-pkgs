/**
 * akuko — put the current project into the default board and publish it, or
 * publish a gate's read-only sign-off page.
 *
 *   node --experimental-strip-types views/publish.ts --project <folder>
 *   node --experimental-strip-types views/publish.ts --project <folder> --signoff <gate id>
 *        [--out <file>] [--images embed|link|none] [--max-image-mb <n>] [--max-total-mb <n>]
 *
 * Hosts B and C (a local project folder).
 *
 * The board: it reads `<folder>/akuko.json`, writes it into the board's
 * `<script id="akuko-project">` block (every `<` as `<`, the same escape
 * the publishers and check-view use) and publishes the page through
 * `LocalHost.publishView()`, so the host's conformance gate still applies.
 * Embedding the project does not change the conformance hash. Prints the path
 * of `<folder>/views/default-board.html`.
 *
 * Run it again whenever you want the page to start from newer data; a page
 * served over http re-reads `akuko.json` by itself. Decisions held only in an
 * open page are lost on a reload: read them first (`actions/review.md` §1).
 *
 * `--signoff <gate>` (WP-29): builds the gate's read-only sign-off page
 * (`views/signoff.ts`: what is in scope with pictures and approval status, the
 * house rules, what signing means; no scripts, no buttons, no network) and
 * writes it to `<folder>/views/signoff-<gate>.html` through `publishView()`,
 * or to `--out`. Prints one JSON line: the path, the gate's progress and how
 * each picture was included.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeJsonForScript, findJsonBlock, PROJECT_BLOCK } from '../scripts/check-view/hash.mjs';
import { decisionWriteSigns } from '../scripts/check-view/predicates.mjs';
import { createLocalHost } from '../hosts/local.ts';
import { buildSignoffPage, signoffFileName, type SignoffPageOptions } from './signoff.ts';

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

export interface SignoffPublishResult {
  path: string;
  gate: string;
  state: string;
  approved: number;
  total: number;
  images: { embedded: number; linked: number; other: number };
  embedded_bytes: number;
}

/** Build and write a gate's read-only sign-off page. Throws for an unknown gate. */
export async function publishSignoff(projectDir: string, gateId: string, opts: Omit<SignoffPageOptions, 'outDir'> & { out?: string } = {}): Promise<SignoffPublishResult> {
  const host = createLocalHost({ projectDir });
  const project = await host.readState();
  const outFile = opts.out ? resolve(opts.out) : undefined;
  const page = buildSignoffPage(project, gateId, projectDir, { ...opts, outDir: outFile ? dirname(outFile) : join(projectDir, 'views') });
  // A sign-off page never writes decisions; refuse to put one out that looks as if it could.
  const signs = decisionWriteSigns(page.html);
  if (signs.length) throw new Error(`the sign-off page shows signs of writing decisions (${signs.join(', ')}); not published`);
  let path: string;
  if (outFile) {
    writeFileSync(outFile, page.html);
    path = outFile;
  } else {
    const r = await host.publishView({ name: signoffFileName(gateId), title: `Sign-off: ${gateId}`, html: page.html, writesDecisions: false });
    if (!r.path) throw new Error('the host returned no path');
    path = r.path;
  }
  const n = (how: string) => page.images.filter((i) => i.how === how).length;
  return {
    path, gate: page.status.id, state: page.status.state, approved: page.status.approved, total: page.status.total,
    images: { embedded: n('embedded'), linked: n('linked'), other: page.images.length - n('embedded') - n('linked') },
    embedded_bytes: page.embeddedBytes,
  };
}

function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const dir = opt(argv, 'project');
  if (!dir) {
    process.stderr.write('usage: node --experimental-strip-types views/publish.ts --project <folder> [--signoff <gate id> [--out <file>] [--images embed|link|none] [--max-image-mb <n>] [--max-total-mb <n>]]\n');
    return 2;
  }
  try {
    const gate = opt(argv, 'signoff');
    if (gate === undefined) {
      process.stdout.write(`${await publishBoard(resolve(dir))}\n`);
      return 0;
    }
    const images = opt(argv, 'images');
    if (images !== undefined && !['embed', 'link', 'none'].includes(images)) throw new Error('--images is embed, link or none');
    const mib = (k: string, unit: number) => { const v = opt(argv, k); if (v === undefined) return undefined; const x = Number(v); if (!(x > 0)) throw new Error(`--${k} must be a positive number`); return Math.floor(x * unit); };
    const maxImageBytes = mib('max-image-mb', 1024 * 1024);
    const maxTotalBytes = mib('max-total-mb', 1000 * 1000);
    const out = opt(argv, 'out');
    const r = await publishSignoff(resolve(dir), gate, {
      ...(images ? { images: images as 'embed' | 'link' | 'none' } : {}),
      ...(maxImageBytes ? { maxImageBytes } : {}),
      ...(maxTotalBytes ? { maxTotalBytes } : {}),
      ...(out ? { out } : {}),
    });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`publish failed: ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
