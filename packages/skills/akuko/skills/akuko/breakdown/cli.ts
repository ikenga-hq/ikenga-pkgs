/**
 * akuko — command line for the intake and breakdown steps (hosts B and C).
 *
 *   node --experimental-strip-types breakdown/cli.ts <command> --project <dir> [options]
 *
 *   new     --title <t> [--logline <l>] [--source <credit>] [--runtime <s>] [--tools <a,b,…>]
 *           create <dir>/akuko.json (refuses to overwrite one)
 *   intake  --route screenplay|adapt|direct|import
 *           record script/source.md (+ script/screenplay.fountain) and put intake in review;
 *           `import` needs no source text (optional --film-script <md>, --sheet <file>)
 *   import  --sheet <xlsx|csv> [--lines <quotes.csv>] [--film-script <md>] [--master <wav>] [--mapping <json>]
 *           [--cards-dir <dir>] [--clips-dir <dir>] [--tokens <csv>] [--lighting <csv>] [--fps <n>] [--start-tc <tc>]
 *           [--hash] [--title <t>] [--dry-run]
 *           turn an existing shot list into the breakdown (breakdown/import/); re-running updates by sheet id
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
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectHostRecord } from '../setup/host-record.ts';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import { applyBreakdown, planRetag, ProposalError } from './apply.ts';
import { completeIntake, createProject, SCREENPLAY_PATH, SOURCE_PATH, type IntakeRoute } from './intake.ts';
import { formatIssues, hasErrors, isImported, lintShots, lintSheetIdsInScript, lintTags } from './lint.ts';
import { cardResolver, clipResolver, describeMaster, formatSummary, importSheet, ImportError, loadCsvTable, loadSheet, projectUri, resolveMapping, type MappingOverride } from './import/index.ts';
import { FpsSchema } from '../schema/akuko-project.ts';

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

    if (cmd === 'import') {
      const sheet = str(opt.get('sheet'));
      if (!sheet) return { code: 2, out: 'akuko: --sheet <xlsx|csv> is required.' };
      const dry = opt.has('dry-run');
      const mappingFile = str(opt.get('mapping'));
      const mapping = resolveMapping(mappingFile ? (JSON.parse(await readFile(mappingFile, 'utf8')) as MappingOverride) : undefined);
      let project = existsSync(host.projectFile)
        ? await host.readState()
        : createProject({ title: str(opt.get('title')) ?? basename(resolve(dir)), now });
      const files = await loadSheet(sheet, mapping, { tokensCsv: str(opt.get('tokens')), lightingCsv: str(opt.get('lighting')) });
      const linesFile = str(opt.get('lines'));
      const scriptFile = str(opt.get('film-script'));
      const masterFile = str(opt.get('master'));
      const cardsDir = str(opt.get('cards-dir'));
      const fpsArg = str(opt.get('fps'));
      if (fpsArg !== undefined && !FpsSchema.safeParse(fpsArg).success) return { code: 2, out: `akuko: --fps must be one of ${FpsSchema.options.join(', ')}.` };
      const r = importSheet(project, {
        ...files,
        mapping,
        ...(linesFile !== undefined && { lines: await loadCsvTable(linesFile), clipUri: clipResolver(dir, linesFile, str(opt.get('clips-dir'))) }),
        ...(scriptFile !== undefined && { filmScript: { uri: projectUri(dir, scriptFile), text: await readFile(scriptFile, 'utf8') } }),
        ...(masterFile !== undefined && { master: await describeMaster(dir, masterFile, { startTc: str(opt.get('start-tc')), hash: opt.has('hash') }) }),
        ...(fpsArg !== undefined && { fps: fpsArg as '24' }),
        sheetFile: { uri: projectUri(dir, sheet), mime: /.csv$/i.test(sheet) ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        cardFile: cardResolver(dir, cardsDir, mapping.cards.files),
      }, { now });
      const text = formatSummary(r, { dryRun: dry });
      if (r.integrity.length > 0) return { code: 1, out: `${text}
Nothing written.` };
      if (dry) return { code: 0, out: text };
      project = { ...r.project, host: project.host ?? detectHostRecord(str(opt.get('tools'))?.split(',').filter(Boolean)) };
      await mkdir(dirname(host.projectFile), { recursive: true });
      await host.writeState(project);
      return { code: 0, out: `${text}
Wrote ${host.projectFile}. Every unit is waiting for review; nothing is approved.` };
    }

    const project = await host.readState();

    if (cmd === 'intake') {
      const route = str(opt.get('route')) as IntakeRoute | undefined;
      if (route !== 'screenplay' && route !== 'adapt' && route !== 'direct' && route !== 'import') {
        return { code: 2, out: 'akuko: --route must be screenplay, adapt, direct or import.' };
      }
      if (route === 'import') {
        const script = str(opt.get('film-script'));
        const sheet = str(opt.get('sheet'));
        await host.writeState(completeIntake(project, {
          route, now,
          ...(script !== undefined && { sourceUri: projectUri(dir, script) }),
          ...(sheet !== undefined && { sheetUri: projectUri(dir, sheet), sheetMime: /.csv$/i.test(sheet) ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        }));
        return { code: 0, out: 'Intake recorded (route: import); intake is waiting for review. Import the shot list with the import command.' };
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

    if (cmd === 'lint' && project.shots.some(isImported)) {
      // Imported shots (WP-25): the script holds no shot tags, so the check is that each sheet id is named in the film script.
      const script = project.script.source !== undefined ? path(project.script.source) : undefined;
      const text = script !== undefined && existsSync(script) ? await readFile(script, 'utf8') : undefined;
      const issues = [...lintShots(project), ...(text !== undefined ? lintSheetIdsInScript(project, text) : [])];
      return { code: hasErrors(issues) ? 1 : 0, out: formatIssues(issues) };
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

    return { code: 2, out: 'akuko: command must be new, intake, import, apply, tag or lint.' };
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
