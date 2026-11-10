/**
 * akuko — read and fold decisions from the command line.
 *
 *   node --experimental-strip-types decisions/cli.ts <command> …
 *
 * Commands (each prints one JSON object: the fold report, invalid records, cursor):
 *
 *   fold <projectDir> [--iframe-state <file|->] [--conformed <file>]… [--dry-run]
 *       Hosts B and C. Reads <projectDir>/decisions.jsonl (with --iframe-state,
 *       first mirrors what an Ikenga pane published — `iyke iframe-state <pane>`
 *       output — into it), folds into <projectDir>/akuko.json and writes it.
 *
 *   fold-file --project <akuko.json> --rows <list.json> [--conformed <file>]… --out <file>
 *       Host A, in claude.ai's workspace. <list.json> is the ArtifactData `list`
 *       result for the `decisions` collection; <akuko.json> the `akuko/project`
 *       doc; --conformed the `akuko/conformed` doc. Writes the folded project
 *       to --out for the agent to `set` back with `if_version`.
 *
 *   append <projectDir> <file|->
 *       Host B. Validates decision lines a person copied from a local view
 *       ("Copy decisions for akuko") and appends the new ones to decisions.jsonl.
 *
 *   signoff --project <dir> --gate <id> --by <person id> --via "<how>" [--note …] [--at <ISO>] [--replace]
 *       Hosts B and C (WP-29). Records gates[].signed {by, role: "signoff", at, via, note}
 *       on the signer's word, after checking the person has the gate's role and the gate
 *       isn't signed yet (--replace re-signs, keeping the old record in the note). Run it
 *       ONLY on the person's explicit words naming the gate and the signer
 *       (actions/review.md §Sign-off). Attested, not proven. Exit 1 on a refusal.
 *
 *   signoff-file --project-file <akuko.json> --out <file> --gate … --by … --via … [same options]
 *       Host A: the same, on the `akuko/project` doc saved as a file; writes the
 *       signed project to --out for the agent to `set` back with `if_version`.
 *
 *   gates --project <dir> [--gate <id>]   |   gates --project-file <akuko.json> [--gate <id>]
 *       Every gate's status (decisions/gates.ts): units in scope, how many are approved,
 *       whether and how it is signed. Read-only.
 *
 * Conformed views: always the skill's shipped views/conformed.json, plus each --conformed file
 * (default <projectDir>/views/conformed.json). Missing files count as empty, listed in `warnings`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AkukoProjectSchema } from '../schema/akuko-project.ts';
import { createIkengaHost } from '../hosts/ikenga.ts';
import { createLocalHost } from '../hosts/local.ts';
import { parseArtifactRows } from './artifact-db.ts';
import { loadConformedFile, parseConformedFile, type ConformedView } from './conformed.ts';
import { foldDecisions } from './fold.ts';
import { GateError, gateStatus, gateStatuses, signGate, type GateStatus } from './gates.ts';
import { readIkengaStore } from './ikenga.ts';
import { appendDecisions, parseJsonl, readJsonlStore } from './jsonl.ts';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..');

const readInput = (f: string): string => readFileSync(f === '-' ? 0 : f, 'utf8');

function args(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a.slice(2), takesValue(a) ? argv[++i] ?? '' : 'true'];
      (opt[k!] ??= []).push(v!);
    } else pos.push(a);
  }
  return { pos, opt };
}
const FLAGS = new Set(['--dry-run', '--replace', '--units']);
const takesValue = (a: string) => !FLAGS.has(a);

/** A gate's status for printing: the unit list is summarised unless --units is given. */
function printable(s: GateStatus, withUnits: boolean) {
  const { units, ...rest } = s;
  return withUnits ? s : { ...rest, units: units.length };
}

/**
 * The conformed views folding accepts approvals from: ALWAYS the skill's
 * shipped views/conformed.json, plus each --conformed file (or, without one,
 * <projectDir>/views/conformed.json). A file that doesn't exist counts as an
 * empty list and is reported in `warnings`; a malformed one is an error.
 */
export function conformedFrom(files: string[] | undefined, projectDir: string | undefined, warnings: string[]): ConformedView[] {
  const read = (f: string): ConformedView[] => {
    if (!existsSync(f)) {
      warnings.push(`conformed-views file ${f} not found: treated as an empty list (approvals from unlisted views will be rejected)`);
      return [];
    }
    try {
      return parseConformedFile(JSON.parse(readFileSync(f, 'utf8'))).views;
    } catch (e) {
      throw new Error(`conformed-views file ${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const shipped = loadConformedFile(join(SKILL, 'views', 'conformed.json')).views;
  const extra = files && files.length > 0 ? files.flatMap(read) : projectDir ? loadConformedFile(join(projectDir, 'views', 'conformed.json')).views : [];
  return [...shipped, ...extra];
}

export async function main(argv: string[]): Promise<number> {
  const { pos, opt } = args(argv);
  const cmd = pos[0];
  if (cmd === 'fold') {
    const dir = pos[1];
    if (!dir) throw new Error('usage: fold <projectDir>');
    const iframe = opt['iframe-state']?.[0];
    const read = iframe !== undefined
      ? await readIkengaStore({ projectDir: dir, iframeState: readInput(iframe) })
      : await readJsonlStore(dir);
    const host = iframe !== undefined ? createIkengaHost({ projectDir: dir }) : createLocalHost({ projectDir: dir });
    const warnings: string[] = [];
    const { project, report } = foldDecisions(await host.readState(), read.decisions, { conformed: conformedFrom(opt.conformed, dir, warnings) });
    if (report.changed && !opt['dry-run']) await host.writeState(project);
    console.log(JSON.stringify({ report, invalid: read.invalid, cursor: read.cursor, wrote: report.changed && !opt['dry-run'], warnings }, null, 2));
    return 0;
  }
  if (cmd === 'fold-file') {
    const [pf, rf, out] = [opt.project?.[0], opt.rows?.[0], opt.out?.[0]];
    if (!pf || !rf || !out) throw new Error('usage: fold-file --project <akuko.json> --rows <list.json> --out <file>');
    const p = AkukoProjectSchema.parse(JSON.parse(readInput(pf)));
    const read = parseArtifactRows(readInput(rf));
    const warnings: string[] = [];
    const { project, report } = foldDecisions(p, read.decisions, { conformed: conformedFrom(opt.conformed, undefined, warnings) });
    writeFileSync(out, `${JSON.stringify(project, null, 2)}\n`);
    console.log(JSON.stringify({ report, invalid: read.invalid, cursor: read.cursor, out, warnings }, null, 2));
    return 0;
  }
  if (cmd === 'append') {
    const [dir, f] = [pos[1], pos[2]];
    if (!dir || !f) throw new Error('usage: append <projectDir> <file|->');
    const read = parseJsonl(`${readInput(f).trim()}\n`);
    const written = await appendDecisions(dir, read.decisions);
    console.log(JSON.stringify({ appended: written.map((d) => d.id), invalid: read.invalid }, null, 2));
    return read.invalid.length > 0 ? 1 : 0;
  }
  if (cmd === 'signoff' || cmd === 'signoff-file') {
    const one = (k: string) => opt[k]?.[0];
    const [gate, by, via] = [one('gate'), one('by'), one('via')];
    const file = cmd === 'signoff-file';
    const dir = one('project');
    const pf = one('project-file');
    const out = one('out');
    if (!gate || !by || via === undefined || (file ? !pf || !out : !dir)) {
      throw new Error(file
        ? 'usage: signoff-file --project-file <akuko.json> --out <file> --gate <id> --by <person id> --via "<how>" [--note …] [--at <ISO>] [--replace]'
        : 'usage: signoff --project <dir> --gate <id> --by <person id> --via "<how>" [--note …] [--at <ISO>] [--replace]');
    }
    const host = file ? undefined : createLocalHost({ projectDir: dir! });
    const project = host ? await host.readState() : AkukoProjectSchema.parse(JSON.parse(readInput(pf!)));
    const note = one('note');
    const at = one('at');
    try {
      const r = signGate(project, { gate, by, via, ...(note !== undefined ? { note } : {}), ...(at !== undefined ? { at } : {}), replace: !!opt.replace });
      if (host) await host.writeState(r.project);
      else writeFileSync(out!, `${JSON.stringify(r.project, null, 2)}\n`);
      console.log(JSON.stringify({ ok: true, gate, signed: r.record, ...(r.replaced ? { replaced: r.replaced } : {}), status: printable(r.status, false), warnings: r.warnings, attested: "recorded on the signer's word; not proven", ...(file ? { out } : {}) }, null, 2));
      return 0;
    } catch (e) {
      if (!(e instanceof GateError)) throw e;
      console.log(JSON.stringify({ ok: false, gate, code: e.code, message: e.message }, null, 2));
      return 1;
    }
  }
  if (cmd === 'gates') {
    const dir = opt.project?.[0];
    const pf = opt['project-file']?.[0];
    if (!dir && !pf) throw new Error('usage: gates --project <dir> | --project-file <akuko.json> [--gate <id>] [--units]');
    const project = dir ? await createLocalHost({ projectDir: dir }).readState() : AkukoProjectSchema.parse(JSON.parse(readInput(pf!)));
    const id = opt.gate?.[0];
    try {
      const list = id ? [gateStatus(project, id)] : gateStatuses(project);
      console.log(JSON.stringify({ gates: list.map((s) => printable(s, !!opt.units)) }, null, 2));
      return 0;
    } catch (e) {
      if (!(e instanceof GateError)) throw e;
      console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }, null, 2));
      return 1;
    }
  }
  console.error('usage: cli.ts fold <projectDir> | fold-file --project … --rows … --out … | append <projectDir> <file|-> | signoff --project <dir> --gate … --by … --via … | signoff-file … | gates --project <dir>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
