/**
 * akuko — command line for the key-frame stage (hosts B and C).
 *
 *   node --experimental-strip-types keyframes/cli.ts <command> --project <dir> [options]
 *
 *   plan                      create a planned key frame for every shot (idempotent)
 *   status                    one line per key frame: its status and what it is waiting for
 *   step    --provider <id>   the next key frame (one shot) through the spend gate: manual | gemini-image | fal
 *           [--model <id>] [--units a,b] [--scene sc1]
 *             paid: prints the spend line and stops until a person approves it, then runs and records
 *             manual: prints the prompt package and stops; bring files back with `ingest`
 *   ingest  --job <id> --unit <asset id> --file <path> [--actual <n>] [--model <id>]
 *           record a file the person made for a manual job
 *   collect --job <id>        poll a paid job submitted earlier and record its files
 *   sync                      repair and refresh the stage state, after decisions were folded
 *
 * Fold decisions first (`decisions/cli.ts fold`); `approved` only ever arrives that way.
 * Everything goes through the local host adapter. On host A import the
 * functions from `plan.ts` / `run.ts` and pass the project read from the artifact database.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import type { Job, JobHandle, Provider } from '../providers/contract.ts';
import { createFalImageProvider } from '../providers/fal/index.ts';
import { createGeminiImageProvider } from '../providers/gemini-image/index.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createSpendGate } from '../spend/gate.ts';
import { KeyframeError, keyframeStatus, planKeyframes } from './plan.ts';
import { collectKeyframes, finalizeKeyframes, generateKeyframes, ingestKeyframe, type StepResult } from './run.ts';

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
const jobFile = (dir: string, id: string): string => join(dir, 'keyframes', 'jobs', `${id}.json`);

function describe(r: StepResult): { code: number; out: string } {
  const o = describeStatus(r);
  const skipped = (r.skipped ?? []).map((x) => `Skipped ${x.unit}: ${x.reason}`);
  return skipped.length ? { code: o.code, out: [o.out, ...skipped].join(String.fromCharCode(10)) } : o;
}

function describeStatus(r: StepResult): { code: number; out: string } {
  switch (r.status) {
    case 'awaiting-approval':
      return { code: 0, out: `${r.confirmation}\nNothing has been sent. Put the amount in front of the person; once they have approved it, run this step again.` };
    case 'refused':
      return { code: 1, out: `Refused (${r.code}): ${r.message}` };
    case 'failed':
      return { code: 1, out: `Failed: ${r.error}` };
    case 'running':
      return { code: 0, out: `Job ${r.job.id} is still running (${r.message}). Run collect --job ${r.job.id} later.` };
    case 'done':
      return { code: 0, out: `Done: ${r.assets.length} key frame${r.assets.length === 1 ? '' : 's'} recorded (${r.assets.join(', ')}), cost ${Number(r.cost.toFixed(4))}. They are waiting for the person's review.` };
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
      const rows = keyframeStatus(await host.readState());
      if (rows.length === 0) return { code: 0, out: 'Nothing planned yet. Run plan.' };
      return { code: 0, out: rows.map((r) => `${r.asset}: ${r.status} (${r.state}${r.waiting.length ? `, waiting for the bible image ${r.waiting.join(', ')}` : ''}${r.superseded.length ? `; made from a superseded ${r.superseded.join(', ')} - consider sending it back` : ''})`).join('\n') };
    }
    if (cmd === 'plan') {
      const r = planKeyframes(await host.readState(), clock());
      if (r.created.length > 0) await host.writeState(r.project);
      return { code: 0, out: r.created.length ? `Planned ${r.created.length} key frame${r.created.length === 1 ? '' : 's'}: ${r.created.join(', ')}.` : 'Everything is already planned.' };
    }
    if (cmd === 'sync') {
      const repaired = await finalizeKeyframes({ host, now: clock });
      return { code: 0, out: repaired.length ? `Reset ${repaired.join(', ')} to pending (no image).` : 'Nothing to repair.' };
    }

    // Commands below talk to providers, always through the gate.
    const level = (await host.detect()).level;
    const manual = createManualProvider(host, { now: clock });
    const providers: Provider[] = [manual.provider, createGeminiImageProvider(host, { now: clock }), createFalImageProvider(host, { now: clock })];
    const gate = createSpendGate({ host, providers, level, now: clock });
    const deps = { host, gate, now: clock };

    if (cmd === 'step') {
      const provider = str(opt.get('provider'));
      if (!provider) return { code: 2, out: 'akuko: --provider manual|gemini-image|fal is required.' };
      const model = str(opt.get('model'));
      const units = str(opt.get('units'))?.split(',').filter(Boolean);
      const scene = str(opt.get('scene'));
      const r = await generateKeyframes(deps, { provider, ...(model ? { model } : {}), ...(units ? { units } : {}), ...(scene ? { scene } : {}) });
      if (r.status === 'handoff' || r.status === 'running') {
        await mkdir(join(dir, 'keyframes', 'jobs'), { recursive: true });
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
      if (cmd === 'collect') return describe(await collectKeyframes(deps, saved.job, saved.handle));
      const unit = str(opt.get('unit'));
      const path = str(opt.get('file'));
      if (!unit || !path) return { code: 2, out: 'akuko: --unit and --file are required.' };
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) return { code: 1, out: `akuko: ${path} is not a .png, .jpg or .webp image.` };
      const actual = str(opt.get('actual'));
      const model = str(opt.get('model'));
      const r = await ingestKeyframe(deps, manual, saved.job, unit, { filename: resolve(path).split(/[\\/]/).pop() ?? 'file', mime, data: new Uint8Array(await readFile(path)) }, {
        ...(actual !== undefined ? { actual: Number(actual) } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      return { code: 0, out: [`Recorded ${r.asset}; it is waiting for the person's review.`, ...r.warnings].join('\n') };
    }

    return { code: 2, out: 'akuko: command must be plan, status, step, ingest, collect or sync.' };
  } catch (err) {
    if (err instanceof KeyframeError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
