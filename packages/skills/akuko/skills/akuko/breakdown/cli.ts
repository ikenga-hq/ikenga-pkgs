/**
 * akuko — command line for the intake and breakdown steps (hosts B and C).
 *
 *   node --experimental-strip-types breakdown/cli.ts <command> --project <dir> [options]
 *
 *   new     --title <t> [--logline <l>] [--source <credit>] [--runtime <s>] [--tools <a,b,…>]
 *           create <dir>/akuko.json (refuses to overwrite one)
 *   intake  --route screenplay|adapt|direct
 *           record script/source.md (+ script/screenplay.fountain) and put intake in review
 *   apply   --proposal <file.json>
 *           write the breakdown from the agent's proposal; a project that already has shots is left alone
 *   tag     [--prose]
 *           add missing [[sc<N>_sh<M>]] notes to script/screenplay.fountain (or script/source.md with --prose)
 *   lint
 *           check the shots (and the tags in the script); exit 1 on errors
 *
 * Everything goes through the local host adapter (`hosts/local.ts`). On host A
 * (no durable folder) import the functions from `apply.ts` / `tags.ts` /
 * `lint.ts` instead and pass the project read from the artifact database.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectHostRecord } from '../setup/host-record.ts';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import { applyBreakdown, planRetag, ProposalError } from './apply.ts';
import { completeIntake, createProject, SCREENPLAY_PATH, SOURCE_PATH, type IntakeRoute } from './intake.ts';
import { formatIssues, hasErrors, lintShots, lintTags } from './lint.ts';

export interface CliResult { code: number; out: string }

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

export async function run(argv: string[], now: () => Date = () => new Date()): Promise<CliResult> {
  const { cmd, opt } = flags(argv);
  const dir = str(opt.get('project'));
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  const host = createLocalHost({ projectDir: dir, now });
  const path = (rel: string) => join(dir, ...rel.split('/'));
  const out: string[] = [];

  try {
    if (cmd === 'new') {
      const title = str(opt.get('title'));
      if (!title) return { code: 2, out: 'akuko: --title is required.' };
      if (existsSync(host.projectFile)) return { code: 1, out: `akuko: ${host.projectFile} already exists; not overwriting it.` };
      const runtime = str(opt.get('runtime'));
      const p = createProject({
        title,
        now,
        ...(str(opt.get('logline')) !== undefined && { logline: str(opt.get('logline'))! }),
        ...(str(opt.get('source')) !== undefined && { source: str(opt.get('source'))! }),
        ...(runtime !== undefined && { runtime_s: Number(runtime) }),
      });
      await mkdir(dirname(host.projectFile), { recursive: true });
      await host.writeState({ ...p, host: detectHostRecord(str(opt.get('tools'))?.split(',').filter(Boolean)) });
      return { code: 0, out: `Created ${host.projectFile} (${p.project.slug}).` };
    }

    const project = await host.readState();

    if (cmd === 'intake') {
      const route = str(opt.get('route')) as IntakeRoute | undefined;
      if (route !== 'screenplay' && route !== 'adapt' && route !== 'direct') {
        return { code: 2, out: 'akuko: --route must be screenplay, adapt or direct.' };
      }
      if (!existsSync(path(SOURCE_PATH))) return { code: 1, out: `akuko: write ${SOURCE_PATH} first.` };
      if (route !== 'direct' && !existsSync(path(SCREENPLAY_PATH))) return { code: 1, out: `akuko: write ${SCREENPLAY_PATH} first.` };
      await host.writeState(completeIntake(project, { route, now }));
      return { code: 0, out: `Intake recorded (route: ${route}); intake is waiting for review.` };
    }

    if (cmd === 'apply') {
      const file = str(opt.get('proposal'));
      if (!file) return { code: 2, out: 'akuko: --proposal <file.json> is required.' };
      const r = applyBreakdown(project, JSON.parse(await readFile(file, 'utf8')) as unknown, { now });
      if (r.skipped) return { code: 0, out: `Nothing created: ${r.reason}.` };
      if (hasErrors(r.lint)) {
        return { code: 1, out: `Nothing written. Fix these and apply again:\n${formatIssues(r.lint)}` };
      }
      await host.writeState(r.project);
      const c = r.created;
      out.push(`Wrote ${c.scenes} scenes, ${c.beats} beats, ${c.shots} shots; checklist: ${c.characters} characters, ${c.locations} locations, ${c.styles} styles. All are waiting for review.`);
      if (r.lint.length > 0) out.push(formatIssues(r.lint));
      return { code: 0, out: out.join('\n') };
    }

    if (cmd === 'tag' || cmd === 'lint') {
      const prose = opt.has('prose') || project.script.screenplay === undefined;
      const rel = prose ? (project.script.source ?? SOURCE_PATH) : (project.script.screenplay ?? SCREENPLAY_PATH);
      const file = path(rel);
      const text = existsSync(file) ? await readFile(file, 'utf8') : undefined;
      if (cmd === 'tag') {
        if (text === undefined) return { code: 1, out: `akuko: ${rel} not found.` };
        const r = planRetag(project, text, { prose });
        if (r.text !== text) await writeFileAtomic(file, r.text);
        out.push(`Tagged ${r.tagged.length}, already tagged ${r.alreadyTagged.length}, left untagged ${r.unplaced.length}, conflicts ${r.conflicts.length}.`);
        for (const u of r.unplaced) out.push(`  untagged ${u.shotId}: ${u.reason}`);
        for (const c of r.conflicts) out.push(`  conflict ${c.shotId}: tagged at line ${c.line} but matches line ${c.matchedLine}; left as is`);
        return { code: 0, out: out.join('\n') };
      }
      const issues = [...lintShots(project), ...(text !== undefined ? lintTags(project, text, { prose }) : [])];
      return { code: hasErrors(issues) ? 1 : 0, out: formatIssues(issues) };
    }

    return { code: 2, out: 'akuko: command must be new, intake, apply, tag or lint.' };
  } catch (err) {
    if (err instanceof ProposalError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
