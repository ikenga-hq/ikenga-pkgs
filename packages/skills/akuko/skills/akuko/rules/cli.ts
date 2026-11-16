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
 *   allow --project <dir> --file <path> --label "<what it is>" [--for <entry> …] [--note "…"] [--consent <id>]
 *         hash the file and add it to `rules.uploads.allow` (refused if that hash is already there).
 *         ONLY on the person's explicit word naming this file, never to get past a breach on the
 *         agent's own initiative (actions/bible.md, actions/keyframes.md).
 *   adopt-allowance --project <dir> --service <id> [--apply]
 *         one-time back-fill: every file ingested by hand whose unit has a done allowance entry of that
 *         service becomes a generated file of the service (rules/refs.ts §3b): provider, sha256, the
 *         ledger entry linked to its job. A dry run unless --apply; prints what it changes either way.
 *
 * The same checks run on every job at the spend gate (`guard.ts`); this
 * command shows them all at once, before any spend.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost } from '../hosts/local.ts';
import { assertValidProject } from '../providers/outputs.ts';
import { AllowanceServiceSchema, IdSchema, RulesSchema, rulesOf, type UploadAllow } from '../schema/akuko-project.ts';
import { adoptAllowance, type SavedJobItems } from './allowance.ts';
import { checkProjectRules, formatBreach, type ProjectCheck } from './check.ts';
import { newHashCache, sha256File } from './refs.ts';

/** Stages that save their manual jobs as `<project>/<stage>/jobs/<id>.json`. */
const JOB_DIRS = ['bible', 'keyframes', 'motion', 'lipsync', 'sound'];

function savedJob(dir: string, id: string): SavedJobItems | undefined {
  for (const s of JOB_DIRS) {
    const f = join(dir, s, 'jobs', `${id}.json`);
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { job?: SavedJobItems };
      if (j.job && Array.isArray(j.job.items)) return j.job;
    } catch { /* unreadable: treated as unknown */ }
  }
  return undefined;
}

/** Every value of a repeatable flag (`--for A --for B`, or `--for A,B`). */
function all(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out.push(...argv[i + 1]!.split(',').map((x) => x.trim()).filter(Boolean));
  return out;
}

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
    if (cmd === 'allow') {
      const dir = typeof opt.get('project') === 'string' ? (opt.get('project') as string) : undefined;
      const file = typeof opt.get('file') === 'string' ? (opt.get('file') as string) : undefined;
      const label = typeof opt.get('label') === 'string' ? (opt.get('label') as string).trim() : '';
      if (!dir || !file || !label) return { code: 2, out: 'akuko: allow --project <dir> --file <path> --label "<what it is>" [--for <entry> …] [--note "…"] [--consent <id>]' };
      if (!existsSync(file)) return { code: 1, out: `akuko: ${file} does not exist.` };
      const host = createLocalHost({ projectDir: dir });
      const p = await host.readState();
      const entries = new Set([...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((e) => e.id));
      const forIds = [...new Set(all(argv, 'for'))];
      const unknown = forIds.filter((id) => !entries.has(id));
      if (unknown.length) return { code: 1, out: `akuko: --for names no bible entry ${unknown.join(', ')}.` };
      const consent = typeof opt.get('consent') === 'string' ? (opt.get('consent') as string) : undefined;
      if (consent !== undefined && !IdSchema.safeParse(consent).success) return { code: 2, out: `akuko: --consent "${consent}" is not an id.` };
      const note = typeof opt.get('note') === 'string' ? (opt.get('note') as string) : undefined;
      const sha256 = await sha256File(resolve(file));
      const rules = rulesOf(p);
      const dup = rules.uploads.allow.find((a) => a.sha256 === sha256);
      if (dup) return { code: 1, out: `akuko: ${file} (sha256 ${sha256.slice(0, 12)}…) is already allowed as "${dup.label}". Nothing changed.` };
      const entry: UploadAllow = { sha256, label, ...(consent ? { consent_ref: consent } : {}), ...(forIds.length ? { for: forIds } : {}), ...(note ? { note } : {}) };
      const nextRules = RulesSchema.parse({ ...rules, uploads: { ...rules.uploads, allow: [...rules.uploads.allow, entry] } });
      await host.writeState(assertValidProject({ ...p, rules: nextRules }));
      const nfp = forIds.filter((id) => nextRules.never_from_photo.includes(id));
      return { code: 0, out: [`Allowed ${file} as "${label}" (sha256 ${sha256})${forIds.length ? `, as a reference only for ${forIds.join(', ')}` : ', as a reference for anything'}.`,
        ...(nfp.length ? [`warn: ${nfp.join(', ')} ${nfp.length === 1 ? 'is' : 'are'} never_from_photo, which wins: this file still can't be used for ${nfp.length === 1 ? 'it' : 'them'}.`] : [])].join(NL) };
    }
    if (cmd === 'adopt-allowance') {
      const dir = typeof opt.get('project') === 'string' ? (opt.get('project') as string) : undefined;
      const service = typeof opt.get('service') === 'string' ? (opt.get('service') as string) : undefined;
      if (!dir || !service) return { code: 2, out: 'akuko: adopt-allowance --project <dir> --service <id> [--apply]' };
      if (!AllowanceServiceSchema.safeParse(service).success || service === 'manual') return { code: 2, out: `akuko: --service "${service}" is not a connected service id such as canva.` };
      const apply = opt.get('apply') === true;
      const host = createLocalHost({ projectDir: dir });
      const p = await host.readState();
      const r = await adoptAllowance(p, service, { projectDir: dir, job: (id) => savedJob(dir, id) });
      const lines = [`adopt-allowance ${service}: ${apply ? 'APPLY' : 'dry run (nothing written; add --apply to write)'}`];
      for (const c of r.changes) {
        const refs = c.refsUnknown ? `refs not checked (${c.refsUnknown}): tagged refs:external` : c.externalRefs.length ? `refs not generated: ${c.externalRefs.join(', ')}: tagged refs:external` : 'refs all generated';
        lines.push(`  ${c.asset}: manual → ${service} · job ${c.job} · ledger ${c.ledger} linked · ${c.hashed ? 'sha256 recorded' : 'sha256 kept'} · ${refs}`);
      }
      for (const s of r.skipped) lines.push(`  skip ${s.asset}: ${s.reason}`);
      const manualLeft = r.project.assets.filter((a) => a.provider === 'manual' && a.file !== undefined).length;
      lines.push(`${r.changes.length} file${r.changes.length === 1 ? '' : 's'} ${apply ? 'adopted' : 'would be adopted'}, ${r.skipped.length} skipped; ${manualLeft} hand-made file${manualLeft === 1 ? '' : 's'} ${apply ? 'remain' : 'would remain'} external.`);
      const nowAllowed = r.changes.filter((c) => rulesOf(p).uploads.allow.some((a) => a.sha256 === r.project.assets.find((x) => x.id === c.asset)?.file?.hash));
      if (nowAllowed.length) lines.push(`note: ${nowAllowed.length} of them ${nowAllowed.length === 1 ? 'is' : 'are'} also in rules.uploads.allow (${nowAllowed.map((c) => c.asset).join(', ')}); once adopted those entries are no longer needed. This command leaves them; remove them only on the person's word.`);
      if (apply && r.changes.length) await host.writeState(assertValidProject(r.project));
      return { code: 0, out: lines.join(NL) };
    }
    return { code: 2, out: 'akuko: command must be check, hash, allow or adopt-allowance.' };
  } catch (err) {
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
