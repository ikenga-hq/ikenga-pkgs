/**
 * akuko — command line for the motion stage, clips (hosts B and C).
 *
 *   node --experimental-strip-types motion/cli.ts <command> --project <dir> [options]
 *
 *   plan                      create a planned clip for every shot (idempotent); says which shots are at the retry cap
 *   status                    one line per clip: its status, what it waits for, paid attempts and money spent
 *   step    --provider <id>   the next clip (one shot) through the spend gate: manual | fal-video
 *           [--model <id>] [--units a,b] [--scene sc1] [--audio] [--fit cover|nearest] [--max-attempts N]
 *             paid: prints the spend line and stops until a person approves it, then runs and records
 *             manual: prints the prompt package and stops; bring files back with `ingest`
 *             --audio       ask for the model's own sound (off by default; costs more; a new approval)
 *             --fit         cover (default): a clip at least as long as the shot; nearest: the closest
 *                           length the model makes (cheaper, may be shorter than the shot)
 *             --max-attempts  paid tries allowed per shot (default 3). Pass it ONLY when the person
 *                             asked for more tries in their own words.
 *   ingest  --job <id> --unit <clip id> --file <path> [--actual <n>] [--model <id>]
 *           record a clip the person made for a manual job
 *   collect --job <id>        poll a paid job submitted earlier and record its clips
 *   sync                      repair and refresh the stage state, after decisions were folded
 *
 * Fold decisions first (`decisions/cli.ts fold`); `approved` only ever arrives that way.
 * Everything goes through the local host adapter. On host A the same Node code runs in
 * the claude.ai workspace (lib/hosts.md); paid providers are still refused there, so use
 * the manual provider.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import type { Job, JobHandle, Provider } from '../providers/contract.ts';
import { loadProviderConfig, providerKeyEnv } from '../providers/config.ts';
import { createFalVideoProvider } from '../providers/fal-video/index.ts';
import { defaultRefLoader } from '../providers/gemini-image/image-common.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { MANUAL_PROVIDER_ID, createSpendGate } from '../spend/gate.ts';
import { guardGate } from '../rules/guard.ts';
import { DEFAULT_MAX_ATTEMPTS, MotionError, motionStatus, planMotion } from './plan.ts';
import { collectClips, finalizeMotion, generateClips, ingestClip, type StepResult } from './run.ts';

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

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const NL = String.fromCharCode(10);

interface SavedJob { job: Job; handle: JobHandle }
const jobFile = (dir: string, id: string): string => join(dir, 'motion', 'jobs', `${id}.json`);

function describe(r: StepResult): CliResult {
  const o = describeStatus(r);
  const extra = [...(r.notes ?? []), ...(r.skipped ?? []).map((x) => `Skipped ${x.unit}: ${x.reason}`)];
  return extra.length ? { code: o.code, out: [o.out, ...extra].join(NL) } : o;
}

function describeStatus(r: StepResult): CliResult {
  switch (r.status) {
    case 'awaiting-approval':
      return { code: 0, out: `${r.confirmation}${NL}Nothing has been sent. Put the amount in front of the person; once they have approved it, run this step again.` };
    case 'refused':
      return { code: 1, out: `Refused (${r.code}): ${r.message}` };
    case 'failed':
      return { code: 1, out: `Failed: ${r.error}` };
    case 'running':
      return { code: 0, out: `Job ${r.job.id} is still running (${r.message}). Run collect --job ${r.job.id} again (it is safe to repeat).` };
    case 'done':
      return {
        code: 0,
        out: `Done: ${r.assets.length} clip${r.assets.length === 1 ? '' : 's'} recorded (${r.assets.join(', ')}), cost ${Number(r.cost.toFixed(4))}. They are waiting for the person's review.` +
          (r.missing?.length ? `${NL}NOT MADE: ${r.missing.join(', ')} (${r.message ?? 'the provider failed them'}). They stay draft and were not billed; tell the person, and only if they agree run step again for them: that is a new job with its own spend line and approval.` : ''),
      };
    case 'handoff':
      return { code: 0, out: `${r.text}${NL}${NL}Job ${r.job.id}. When the clips are back: ingest --job ${r.job.id} --unit <clip id> --file <path> for each.` };
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
      const rows = motionStatus(await host.readState());
      if (rows.length === 0) return { code: 0, out: 'Nothing planned yet. Run plan.' };
      return {
        code: 0,
        out: rows.map((r) => `${r.asset}: ${r.status} (${r.state}${r.waiting.length ? `, waiting for the approved key frame ${r.waiting.join(', ')}` : ''}${r.attempts ? `; ${r.attempts} paid attempt${r.attempts === 1 ? '' : 's'}, ${Number(r.spent.toFixed(4))} spent` : ''})`).join(NL),
      };
    }
    if (cmd === 'plan') {
      const before = await host.readState();
      const r = planMotion(before, clock());
      if (r.created.length > 0) await host.writeState(r.project);
      const capped = motionStatus(r.project).filter((x) => x.attempts >= DEFAULT_MAX_ATTEMPTS && x.state !== 'approved');
      const out = [
        r.created.length ? `Planned ${r.created.length} clip${r.created.length === 1 ? '' : 's'}: ${r.created.join(', ')}.` : 'Everything is already planned.',
        ...capped.map((x) => `${x.asset} is at the retry limit (${x.attempts} paid attempts, ${Number(x.spent.toFixed(4))} spent); step will refuse it until the person decides.`),
      ];
      return { code: 0, out: out.join(NL) };
    }
    if (cmd === 'sync') {
      const repaired = await finalizeMotion({ host, now: clock });
      return { code: 0, out: repaired.length ? `Reset ${repaired.join(', ')} to pending (no clip).` : 'Nothing to repair.' };
    }

    // Commands below talk to providers, always through the gate.
    const level = (await host.detect()).level;
    const manual = createManualProvider(host, { now: clock });
    const loadRef = defaultRefLoader(undefined, dir); // project-relative uris read from the project folder, not the cwd
    const providers: Provider[] = [manual.provider, createFalVideoProvider(host, { now: clock, loadRef })];
    // Every job is checked against the project rules before the gate sees it (WP-26); the guard reads through its own host.
    const gate = guardGate(createSpendGate({ host, providers, level, now: clock }), createLocalHost({ projectDir: dir, now }), { projectDir: dir, providers });
    // The job file is written the moment a job is submitted, before collecting, so `collect` can always pick it up.
    const saveJob = async (job: Job, handle: JobHandle): Promise<void> => {
      await mkdir(join(dir, 'motion', 'jobs'), { recursive: true });
      await writeFileAtomic(jobFile(dir, job.id), `${JSON.stringify({ job, handle } satisfies SavedJob, null, 2)}${NL}`);
    };
    const deps = { host, gate, now: clock, onSubmitted: saveJob };

    if (cmd === 'step') {
      const provider = str(opt.get('provider'));
      if (!provider) return { code: 2, out: 'akuko: --provider manual|fal-video is required.' };
      const model = str(opt.get('model'));
      const units = str(opt.get('units'))?.split(',').filter(Boolean);
      const scene = str(opt.get('scene'));
      const max = str(opt.get('max-attempts'));
      const fit = str(opt.get('fit'));
      if (fit !== undefined && fit !== 'cover' && fit !== 'nearest') return { code: 2, out: 'akuko: --fit takes cover or nearest.' };
      // A missing key is a setup problem, not an attempt: say so before the gate is touched.
      if (provider !== MANUAL_PROVIDER_ID) {
        const env = providerKeyEnv(loadProviderConfig(), provider);
        if (env && !process.env[env]) return { code: 1, out: `Setup needed: ${env} is not set, so ${provider} cannot be used. Nothing was sent and nothing was counted. Set the key (see /akuko setup), or use --provider manual.` };
      }
      if (max !== undefined && !/^[1-9][0-9]*$/.test(max)) return { code: 2, out: 'akuko: --max-attempts takes a whole number of 1 or more.' };
      const r = await generateClips(deps, {
        provider,
        ...(model ? { model } : {}),
        ...(units ? { units } : {}),
        ...(scene ? { scene } : {}),
        ...(opt.get('audio') === true ? { audio: true } : {}),
        ...(max !== undefined ? { maxAttempts: Number(max) } : {}),
        ...(fit !== undefined ? { fit } : {}),
      });
      return describe(r);
    }

    const jobId = str(opt.get('job'));
    if (cmd === 'ingest' || cmd === 'collect') {
      if (!jobId) return { code: 2, out: 'akuko: --job <id> is required.' };
      const file = jobFile(dir, jobId);
      if (!existsSync(file)) return { code: 1, out: `akuko: no saved job ${jobId}; run step first.` };
      const saved = JSON.parse(await readFile(file, 'utf8')) as SavedJob;
      if (cmd === 'collect') return describe(await collectClips(deps, saved.job, saved.handle));
      const unit = str(opt.get('unit'));
      const path = str(opt.get('file'));
      if (!unit || !path) return { code: 2, out: 'akuko: --unit and --file are required.' };
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) return { code: 1, out: `akuko: ${path} is not a .mp4, .webm or .mov clip.` };
      const actual = str(opt.get('actual'));
      const model = str(opt.get('model'));
      const r = await ingestClip(deps, manual, saved.job, unit, { filename: resolve(path).split(/[\\/]/).pop() ?? 'file', mime, data: new Uint8Array(await readFile(path)) }, {
        ...(actual !== undefined ? { actual: Number(actual) } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      return { code: 0, out: [`Recorded ${r.asset}; it is waiting for the person's review.`, ...r.warnings].join(NL) };
    }

    return { code: 2, out: 'akuko: command must be plan, status, step, ingest, collect or sync.' };
  } catch (err) {
    if (err instanceof MotionError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
