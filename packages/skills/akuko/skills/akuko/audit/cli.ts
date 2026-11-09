/**
 * akuko — command line for the key-frame continuity audit (hosts B and C).
 *
 *   node --experimental-strip-types audit/cli.ts <command> --project <dir> [options]
 *
 *   run                      audit every made key frame: the structural checks plus the visual
 *                            notes recorded so far. Writes board/audit.json and board/audit.md,
 *                            and swaps the audit's own "Audit: ..." comments onto the frames.
 *   record --unit <id> --finding "<text>" --severity low|medium|high
 *                            the agent's note from looking at one frame next to its references.
 *                            Stored in board/audit.json; run `run` afterwards to publish it.
 *   summary                  print the last report's summary without changing anything
 *
 * Advisory only. Nothing here changes a status: only a person sends a frame back, on the board.
 * On host A import the functions from `audit.ts` and pass the project read from the artifact store.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import { SEVERITIES, applyAuditComments, auditProject, renderSummary, takeOf, type AuditReport, type Severity, type VisualNote } from './audit.ts';
import { keyframeAssets } from '../keyframes/plan.ts';

export interface CliResult { code: number; out: string }

/** What board/audit.json holds: the agent's notes (input) and the last report (output). */
export interface AuditFile { version: 1; notes: VisualNote[]; report?: AuditReport }

const AUDIT_JSON = ['board', 'audit.json'];
const AUDIT_MD = ['board', 'audit.md'];

function flags(argv: string[]): { cmd: string; opt: Map<string, string | true> } {
  const [cmd = '', ...rest] = argv;
  const opt = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opt.set(a.slice(2), next); i++; } else opt.set(a.slice(2), true);
  }
  return { cmd, opt };
}
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export async function readAuditFile(dir: string): Promise<AuditFile> {
  const path = join(dir, ...AUDIT_JSON);
  if (!existsSync(path)) return { version: 1, notes: [] };
  const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<AuditFile>;
  return { version: 1, notes: Array.isArray(raw.notes) ? raw.notes : [], ...(raw.report ? { report: raw.report } : {}) };
}

async function writeAuditFile(dir: string, file: AuditFile, summary?: string): Promise<void> {
  await mkdir(join(dir, 'board'), { recursive: true });
  await writeFileAtomic(join(dir, ...AUDIT_JSON), `${JSON.stringify(file, null, 2)}\n`);
  if (summary !== undefined) await writeFileAtomic(join(dir, ...AUDIT_MD), summary);
}

const line = (r: AuditReport): string => {
  const s = r.summary;
  return `Audited ${s.audited} key frame${s.audited === 1 ? '' : 's'}: ${s.flagged} with findings (${s.high} high, ${s.medium} medium, ${s.low} low).`;
};

export async function run(argv: string[], now: () => Date = () => new Date()): Promise<CliResult> {
  const { cmd, opt } = flags(argv);
  const dir = str(opt.get('project'));
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  const clock = (): string => now().toISOString();
  const host = createLocalHost({ projectDir: dir, now });

  try {
    if (cmd === 'summary') {
      const f = await readAuditFile(dir);
      if (!f.report) return { code: 0, out: 'No audit has been run yet. Run `run`.' };
      return { code: 0, out: renderSummary(f.report).trimEnd() };
    }

    if (cmd === 'record') {
      const unit = str(opt.get('unit'));
      const text = str(opt.get('finding'))?.trim();
      const severity = str(opt.get('severity')) as Severity | undefined;
      if (!unit || !text || !severity) return { code: 2, out: 'akuko: --unit <asset id>, --finding "<text>" and --severity low|medium|high are required.' };
      if (!SEVERITIES.includes(severity)) return { code: 2, out: `akuko: --severity must be ${SEVERITIES.join(', ')}.` };
      const a = keyframeAssets(await host.readState()).find((x) => x.id === unit);
      if (!a) return { code: 1, out: `akuko: ${unit} is not a key frame.` };
      if (!a.file) return { code: 1, out: `akuko: ${unit} has no image yet; there is nothing to look at.` };
      const f = await readAuditFile(dir);
      const note: VisualNote = { unit, text, severity, take: takeOf(a), at: clock() };
      // The same finding on the same take is recorded once.
      if (!f.notes.some((n) => n.unit === unit && n.take === note.take && n.text === text)) f.notes.push(note);
      await writeAuditFile(dir, f);
      return { code: 0, out: `Recorded your ${severity} note on ${unit}. Run \`run\` to publish it as an "Audit:" comment; it changes no status.` };
    }

    if (cmd === 'run') {
      const file = await readAuditFile(dir);
      const project = await host.readState();
      const report = auditProject(project, { visual: file.notes, now: clock() });
      const next = applyAuditComments(project, report, clock());
      if (JSON.stringify(next) !== JSON.stringify(project)) await host.writeState(next);
      const summary = renderSummary(report);
      await writeAuditFile(dir, { version: 1, notes: file.notes, report }, summary);
      const send = report.frames.flatMap((f) => (f.suggestion ? [`- ${f.suggestion}`] : []));
      return {
        code: 0,
        out: [
          line(report),
          report.summary.clean ? 'No high findings.' : 'There are high findings; show them to the person before motion.',
          ...(send.length ? ['Suggested for the person to consider (nothing was changed):', ...send] : []),
          'Report: board/audit.json and board/audit.md. Comments added to the frames start with "Audit:".',
        ].join('\n'),
      };
    }

    return { code: 2, out: 'akuko: command must be run, record or summary.' };
  } catch (err) {
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
