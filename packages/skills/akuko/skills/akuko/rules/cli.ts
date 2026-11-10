/**
 * akuko — command line for the project rules (WP-26, hosts B and C).
 *
 *   node --experimental-strip-types rules/cli.ts <command> [options]
 *
 *   check --project <dir> [--json]
 *         the free preflight: every shot's prompt and negative, every bible
 *         entry's text and every listed reference file, against `rules`.
 *         Prints each breach with its shot id; exit 1 on any breach, 0 when clean.
 *         Nothing is built, priced or sent.
 *   hash  <file> [<file>…]
 *         print each file's sha256, the value `rules.uploads.allow[].sha256` takes.
 *
 * The same checks run on every job at the spend gate (`guard.ts`); this
 * command shows them all at once, before any spend.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost } from '../hosts/local.ts';
import { checkProjectRules, formatBreach, type ProjectCheck } from './check.ts';
import { newHashCache, sha256File } from './refs.ts';

export interface CliResult { code: number; out: string }

const NL = String.fromCharCode(10);
const plural = (n: number, w: string, many = `${w}s`): string => `${n} ${n === 1 ? w : many}`;

function flags(argv: string[]): { cmd: string; opt: Map<string, string | true>; rest: string[] } {
  const [cmd = '', ...args] = argv;
  const opt = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opt.set(a.slice(2), next); i++; } else opt.set(a.slice(2), true);
  }
  return { cmd, opt, rest };
}

/** The one-line rules summary doctor and the preflight both print. */
export function summaryLine(c: Pick<ProjectCheck, 'status'>): string {
  const s = c.status;
  if (!s.present) return 'rules: none recorded (not required)';
  if (s.invalid) return `rules: INVALID (${s.invalid})`;
  const r = s.rules;
  return `rules: ${plural(r.banned.length, 'banned term')}, ${plural(r.require.length, 'required text')}, ${plural(r.uploads.allow.length, 'allowed file')}, ${r.never_from_photo.length} never-from-photo, ${plural(r.exempt.length, 'exemption')}; required: ${s.required ? 'yes' : 'no'}${s.empty ? ' (nothing to enforce yet)' : ''}`;
}

export function formatCheck(c: ProjectCheck, title: string): string {
  const lines = [`Rules check: ${title}`, `  ${summaryLine(c)}`];
  if (c.status.present) lines.push(`  checked: ${plural(c.counts.shots, 'shot')}, ${plural(c.counts.entries, 'bible entry', 'bible entries')}, ${plural(c.counts.refs, 'reference file')}${c.counts.lines ? `, ${plural(c.counts.lines, 'dialogue line')}` : ''}`);
  for (const b of c.breaches) lines.push(`BREACH ${formatBreach(b)}`);
  for (const w of c.warnings) lines.push(`warn: ${w}`);
  lines.push(c.breaches.length
    ? `${plural(c.breaches.length, 'breach', 'breaches')}. Nothing was spent; every paid job that hits one is refused until it is fixed.`
    : 'No breaches.');
  return lines.join(NL);
}

export async function run(argv: string[]): Promise<CliResult> {
  const { cmd, opt, rest } = flags(argv);
  try {
    if (cmd === 'hash') {
      if (rest.length === 0) return { code: 2, out: 'akuko: hash <file> [<file>…]' };
      const out: string[] = [];
      for (const f of rest) {
        if (!existsSync(f)) return { code: 1, out: `akuko: ${f} does not exist.` };
        out.push(`${await sha256File(resolve(f))}  ${f}`);
      }
      return { code: 0, out: out.join(NL) };
    }
    if (cmd === 'check') {
      const dir = typeof opt.get('project') === 'string' ? (opt.get('project') as string) : undefined;
      if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
      const p = await createLocalHost({ projectDir: dir }).readState();
      const c = await checkProjectRules(p, { projectDir: dir, cache: newHashCache() });
      const code = c.breaches.length ? 1 : 0;
      if (opt.get('json') === true) return { code, out: JSON.stringify({ summary: summaryLine(c), counts: c.counts, breaches: c.breaches, warnings: c.warnings }, null, 2) };
      return { code, out: formatCheck(c, p.project.title) };
    }
    return { code: 2, out: 'akuko: command must be check or hash.' };
  } catch (err) {
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
