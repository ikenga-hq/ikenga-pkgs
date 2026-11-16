/**
 * akuko — command line for the spend ledger (hosts B and C).
 *
 *   node --experimental-strip-types spend/cli.ts allowance --project <dir> --service <id> --units <unit[:n]>,…
 *        [--tool <name>] [--job <id>] [--failed <unit[:n]>,…]
 *
 *   allowance   record what a connected-tool wave used (lib/spend.md §Allowance): one ledger entry per unit, zero
 *               money, `allowance.units` generations (default 1 per unit). `--job` links each entry to the manual
 *               job the files are for, so `ingest --via <service>` and the rules accept them as generated.
 *               `--failed` records units whose call made nothing (they count only when the service charged them).
 *
 * Run it only after the person approved that wave in their own words ("approve <n> <service> generations") and the
 * tool ran; it records what happened, it does not ask. On host A call `recordAllowance()` on the board's project.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost } from '../hosts/local.ts';
import { AllowanceServiceSchema, IdSchema } from '../schema/akuko-project.ts';
import { recordAllowance } from './allowance.ts';
import { assertValidProject } from '../providers/outputs.ts';

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

/** `a,b:2` → [{unit: 'a'}, {unit: 'b', count: 2}]. */
function unitList(s: string | undefined, status: 'done' | 'failed'): { unit: string; count?: number; status: 'done' | 'failed' }[] | string {
  if (s === undefined) return [];
  const out: { unit: string; count?: number; status: 'done' | 'failed' }[] = [];
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [unit = '', n] = part.split(':');
    if (!IdSchema.safeParse(unit).success) return `"${unit}" is not a unit id`;
    const count = n === undefined ? undefined : Number(n);
    if (count !== undefined && !(Number.isInteger(count) && count > 0)) return `"${part}": the count after ":" must be a whole number above 0`;
    out.push({ unit, ...(count !== undefined ? { count } : {}), status });
  }
  return out;
}

export async function run(argv: string[], now: () => Date = () => new Date()): Promise<CliResult> {
  const { cmd, opt } = flags(argv);
  if (cmd !== 'allowance') return { code: 2, out: 'akuko: command must be allowance.' };
  const dir = str(opt.get('project'));
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  const service = str(opt.get('service'));
  if (!service || !AllowanceServiceSchema.safeParse(service).success || service === 'manual') return { code: 2, out: 'akuko: --service <id> is required, a lower-case connected service id such as canva.' };
  const done = unitList(str(opt.get('units')), 'done');
  const failed = unitList(str(opt.get('failed')), 'failed');
  if (typeof done === 'string') return { code: 2, out: `akuko: --units: ${done}` };
  if (typeof failed === 'string') return { code: 2, out: `akuko: --failed: ${failed}` };
  if (done.length + failed.length === 0) return { code: 2, out: 'akuko: --units <unit[:n]>,… (or --failed) is required.' };
  const job = str(opt.get('job'));
  if (job !== undefined && !IdSchema.safeParse(job).success) return { code: 2, out: `akuko: --job "${job}" is not a job id.` };
  const tool = str(opt.get('tool'));
  try {
    const host = createLocalHost({ projectDir: dir, now });
    const p = await host.readState();
    const units = [...done, ...failed];
    const unknown = units.filter((u) => !p.assets.some((a) => a.id === u.unit) && !p.shots.some((s) => s.id === u.unit) && ![...p.bible.characters, ...p.bible.locations, ...p.bible.styles].some((e) => e.id === u.unit));
    if (unknown.length) return { code: 1, out: `akuko: no unit ${unknown.map((u) => u.unit).join(', ')} in this project.` };
    const next = assertValidProject(recordAllowance(p, { service, ts: now().toISOString(), ...(tool ? { tool } : {}), ...(job ? { job } : {}), units }));
    await host.writeState(next);
    const added = next.ledger.slice(p.ledger.length);
    const n = added.reduce((s, e) => s + (e.allowance?.units ?? 0), 0);
    return { code: 0, out: [`Recorded ${n} ${service} generation${n === 1 ? '' : 's'} in the ledger (no money)${job ? `, for job ${job}` : ''}:`, ...added.map((e) => `  ${e.id}: ${e.unit} × ${e.allowance?.units} (${e.status})`)].join('\n') };
  } catch (err) {
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
