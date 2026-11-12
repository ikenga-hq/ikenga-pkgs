/**
 * akuko — command line for the sketch board (hosts B and C).
 *
 *   node --experimental-strip-types board/cli.ts <command> --project <dir> [options]
 *
 *   blocking --file <proposal.json>
 *            set shots' blocking from a proposal ({ "<shot id>": [ {who, shape, x, y, w, h} ] })
 *   draw     draw a panel for every shot that needs one (stored via the host adapter),
 *            move those shots to pending-review, and write the 9-panel beat boards
 *            to <project>/board/beatboards/ (each as .html and .svg)
 *   lint     blocking warnings (never errors)
 *
 * Fold decisions first (`decisions/cli.ts fold <project>`). Free: no provider, no spend gate.
 * On host A, import the functions from `panels.ts` / `beatboard.ts` instead and pass the
 * project read from the artifact database; store each board's `.svg` (the asset store refuses HTML).
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import { buildBeatBoards } from './beatboard.ts';
import { applyBlocking, BoardError, drawSketchPanels, lintBoard, type BoardIssue } from './panels.ts';

export interface CliResult { code: number; out: string }

const formatIssues = (issues: BoardIssue[]): string =>
  issues.length === 0 ? 'No warnings.' : issues.map((i) => `warning [${i.rule}] ${i.message}`).join('\n');

export async function run(argv: string[], now: () => Date = () => new Date()): Promise<CliResult> {
  const [cmd = '', ...rest] = argv;
  const opt = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const next = rest[i + 1];
    if (a.startsWith('--') && next !== undefined && !next.startsWith('--')) { opt.set(a.slice(2), next); i++; }
  }
  const dir = opt.get('project');
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  const host = createLocalHost({ projectDir: dir, now });
  try {
    const project = await host.readState();

    if (cmd === 'blocking') {
      const file = opt.get('file');
      if (!file) return { code: 2, out: 'akuko: --file <proposal.json> is required.' };
      const next = applyBlocking(project, JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>, { now });
      await host.writeState(next);
      return { code: 0, out: `Blocking set. ${formatIssues(lintBoard(next))}` };
    }

    if (cmd === 'draw') {
      const r = await drawSketchPanels(project, host, { now });
      if (r.changed) await host.writeState(r.project);
      const boards = buildBeatBoards(r.project);
      for (const b of boards) {
        await writeFileAtomic(join(dir, 'board', 'beatboards', b.file), b.html);
        await writeFileAtomic(join(dir, 'board', 'beatboards', b.svgFile), b.svg);
      }
      const out = [
        `Drew ${r.drawn.length} panel(s), redrew ${r.redrawn.length}; ${r.unchanged.length} left as they were; ${r.waiting.length} waiting on the breakdown.`,
        ...r.stillSentBack.map((id) => `  ${id} was sent back but nothing changed since: change its blocking or camera, then draw again.`),
        `Wrote ${boards.length} beat board(s) to board/beatboards/ (each as .html and .svg).`,
        formatIssues(r.lint),
      ];
      return { code: 0, out: out.join('\n') };
    }

    if (cmd === 'lint') return { code: 0, out: formatIssues(lintBoard(project)) };
    return { code: 2, out: 'akuko: command must be blocking, draw or lint.' };
  } catch (err) {
    if (err instanceof BoardError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
