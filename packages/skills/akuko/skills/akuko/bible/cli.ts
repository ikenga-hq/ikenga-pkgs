/**
 * akuko — command line for the bible stage (hosts B and C).
 *
 *   node --experimental-strip-types bible/cli.ts <command> --project <dir> [options]
 *
 *   plan                      create the planned images for every approved checklist entry (idempotent)
 *   status                    one line per image: its status and what it is waiting for
 *   step    --provider <id>   the next wave through the spend gate: manual | gemini-image | fal | byteplus-image
 *           [--model <id>] [--units a,b]
 *             paid: prints the spend line and stops until a person approves it, then runs and records
 *             manual: prints the prompt package and stops; bring files back with `ingest`
 *   ingest  --job <id> --unit <asset id> --file <path> [--actual <n>] [--model <id>]
 *           record a file the person made for a manual job
 *   collect --job <id>        poll a paid job submitted earlier and record its files
 *   sync                      refs[] and the stage state, after decisions were folded
 *
 * Fold decisions first (`decisions/cli.ts fold`); `approved` only ever arrives that way.
 * Everything goes through the local host adapter. On host A import the
 * functions from `plan.ts` / `run.ts` and pass the project read from the artifact database.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ledgerCostLine } from '../setup/cost-line.ts';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import type { Job, JobHandle, Provider } from '../providers/contract.ts';
import { createFalImageProvider } from '../providers/fal/index.ts';
import { createByteplusImageProvider } from '../providers/byteplus-image/index.ts';
import { defaultRefLoader } from '../providers/gemini-image/image-common.ts';
import { createGeminiImageProvider } from '../providers/gemini-image/index.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createSpendGate, isPhaseStop, phasedGateOptions } from '../spend/gate.ts';
import { guardGate } from '../rules/guard.ts';
import { BibleError, bibleStatus, planBible } from './plan.ts';
import { collectBible, finalizeBible, generateBible, ingestBible, type StepResult } from './run.ts';

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

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

interface SavedJob { job: Job; handle: JobHandle }
const jobFile = (dir: string, id: string): string => join(dir, 'bible', 'jobs', `${id}.json`);

function describe(r: StepResult, costLine?: string): { code: number; out: string } {
  switch (r.status) {
    case 'awaiting-approval':
      return { code: 0, out: `${r.confirmation}\nNothing has been sent. Put the amount in front of the person; once they have approved it, run this step again.` };
    case 'refused':
      if (isPhaseStop(r.code)) return { code: 0, out: r.message };
      return { code: 1, out: `Refused (${r.code}): ${r.message}` };
    case 'failed':
      return { code: 1, out: `Failed: ${r.error}` };
    case 'running':
      return { code: 0, out: `Job ${r.job.id} is still running (${r.message}). Run collect --job ${r.job.id} later.` };
    case 'done':
      return { code: 0, out: `Done: ${r.assets.length} image${r.assets.length === 1 ? '' : 's'} recorded (${r.assets.join(', ')}), ${costLine ?? `cost ${Number(r.cost.toFixed(4))}`}. They are waiting for the person's review.` };
    case 'handoff':
      return { code: 0, out: `${r.text}\n\nJob ${r.job.id}. When the files are back: ingest --job ${r.job.id} --unit <asset id> --file <path> for each.` };
  }
}

export async function run(argv: string[], now: () => Date = () => new Date()): Promise<CliResult> {
  const { cmd, opt } = flags(argv);
  const dir = str(opt.get('project'));
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  const host = createLocalHost({ projectDir: dir, now });
  const clock = () => now().toISOString();

  try {
    if (cmd === 'status') {
      const rows = bibleStatus(await host.readState());
      if (rows.length === 0) return { code: 0, out: 'Nothing planned yet. Run plan.' };
      return { code: 0, out: rows.map((r) => `${r.asset}: ${r.status} (${r.state}${r.waiting.length ? `, waiting for ${r.waiting.join(', ')}` : ''}${r.superseded.length ? `; generated against a superseded ${r.superseded.join(', ')} - consider sending it back` : ''})`).join('\n') };
    }
    if (cmd === 'plan') {
      const r = planBible(await host.readState(), clock());
      if (r.created.length > 0) await host.writeState(r.project);
      return { code: 0, out: r.created.length ? `Planned ${r.created.length} image${r.created.length === 1 ? '' : 's'}: ${r.created.join(', ')}.` : 'Everything is already planned.' };
    }
    if (cmd === 'sync') {
      const changed = await finalizeBible({ host, now: clock });
      return { code: 0, out: changed.length ? `Updated refs for ${changed.join(', ')}.` : 'Refs are up to date.' };
    }

    // Commands below talk to providers, always through the gate.
    const level = (await host.detect()).level;
    // Host A (R-11): --key-source pasted-this-chat and --phase reserve|send|release (lib/spend.md §Host A).
    const phased = phasedGateOptions((n) => opt.get(n));
    if ('error' in phased) return { code: 2, out: phased.error };
    const manual = createManualProvider(host, { now: clock });
    const loadRef = defaultRefLoader(undefined, dir); // project-relative uris read from the project folder, not the cwd
    const providers: Provider[] = [manual.provider, createGeminiImageProvider(host, { now: clock, loadRef }), createFalImageProvider(host, { now: clock, loadRef }), createByteplusImageProvider(host, { now: clock, loadRef })];
    // Every job is checked against the project rules before the gate sees it (WP-26); the guard reads through its own host.
    const gate = guardGate(createSpendGate({ host, providers, level, now: clock, ...phased }), createLocalHost({ projectDir: dir, now }), { projectDir: dir, providers });
    const deps = { host, gate, now: clock };

    if (cmd === 'step') {
      const provider = str(opt.get('provider'));
      if (!provider) return { code: 2, out: 'akuko: --provider manual|gemini-image|fal|byteplus-image is required.' };
      const model = str(opt.get('model'));
      const units = str(opt.get('units'))?.split(',').filter(Boolean);
      const r = await generateBible(deps, { provider, ...(model ? { model } : {}), ...(units ? { units } : {}) });
      if (r.status === 'handoff' || r.status === 'running') {
        await mkdir(join(dir, 'bible', 'jobs'), { recursive: true });
        await writeFileAtomic(jobFile(dir, r.job.id), `${JSON.stringify({ job: r.job, handle: r.handle } satisfies SavedJob, null, 2)}\n`);
      }
      return describe(r);
    }

    const jobId = str(opt.get('job'));
    if (cmd === 'ingest' || cmd === 'collect') {
      if (!jobId) return { code: 2, out: 'akuko: --job <id> is required.' };
      const file = jobFile(dir, jobId);
      if (!existsSync(file)) return { code: 1, out: `akuko: no saved job ${jobId}; run step first.` };
      const saved = JSON.parse(await readFile(file, 'utf8')) as SavedJob;
      if (cmd === 'collect') {
        const r = await collectBible(deps, saved.job, saved.handle);
        return describe(r, r.status === 'done' ? ledgerCostLine(await host.readState(), saved.job.id, r.cost) : undefined);
      }
      const unit = str(opt.get('unit'));
      const path = str(opt.get('file'));
      if (!unit || !path) return { code: 2, out: 'akuko: --unit and --file are required.' };
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) return { code: 1, out: `akuko: ${path} is not a .png, .jpg or .webp image.` };
      const actual = str(opt.get('actual'));
      const model = str(opt.get('model'));
      const r = await ingestBible(deps, manual, saved.job, unit, { filename: resolve(path).split(/[\\/]/).pop() ?? 'file', mime, data: new Uint8Array(await readFile(path)) }, {
        ...(actual !== undefined ? { actual: Number(actual) } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      return { code: 0, out: [`Recorded ${r.asset}; it is waiting for the person's review.`, ...r.warnings].join('\n') };
    }

    return { code: 2, out: 'akuko: command must be plan, status, step, ingest, collect or sync.' };
  } catch (err) {
    if (err instanceof BibleError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
