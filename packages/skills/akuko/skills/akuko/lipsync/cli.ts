/**
 * akuko — command line for the lip-sync step (hosts B and C).
 *
 *   node --experimental-strip-types lipsync/cli.ts <command> --project <dir> [options]
 *
 *   plan     [--allow-root <dir>]… [--from master] [--part P7]   plan a lip-sync for every shot that needs one (idempotent), then cut the
 *                                    line audio each needs (free, local): the line's own clip when it can be
 *                                    used as it is, else a 16-bit slice of the master
 *   status   [--allow-root <dir>]… [--part P7]   one line per lip-sync: its status, what it waits for, paid attempts, money
 *   step     --provider <id>         the next lip-sync (one shot) through the rules guard and the spend gate:
 *            [--shot <id>] [--part P7] [--model <id>] [--max-attempts N] [--allow-root <dir>]… [--from master]
 *              provider: manual | fal-lipsync
 *              paid: prints the spend line (with the files that would be uploaded) and stops until a person
 *                    approves it, then runs and records the video
 *              manual: prints the prompt package and stops; bring the video back with `ingest`
 *              --model         leave it out: akuko picks the model that fits the line's measured length
 *              --max-attempts  paid tries allowed per shot (default 3). Pass it ONLY when the person asked
 *                              for more tries in their own words.
 *   ingest   --job <id> --unit <lipsync id> --file <path> [--actual <n>] [--model <id>]
 *   collect  --job <id>              poll a paid job submitted earlier and record its video
 *   sync                             repair and refresh the stage state, after decisions were folded
 *   record-master-hash [--replace]   hash audio.master (streamed) and record it as audio.master.sha256
 *
 * `--allow-root <dir>` (repeatable) lets this ONE run read files in a folder outside the project, such as
 * a folder of line clips. Pass it only when the person named that folder; it is never remembered, and
 * nothing in akuko.json or a job can add one. `--from master` (plan, status, step) cuts the line from the master
 * instead of using its own clip, for that run: the person's choice when a clip may hold more than may leave
 * their machine.
 *
 * `--part P7` (plan, status, step) works on one part of the film only, once that part's own key frames and the
 * bible entries they use are approved (WP-32; motion's rule, `motion/cli.ts parts` lists every part). It is worked
 * out from the approvals each time and never stored; the motion stage itself stays locked until the whole film opens.
 *
 * Fold decisions first (`decisions/cli.ts fold`); `approved` only ever arrives that way.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import type { Job, JobHandle, Provider } from '../providers/contract.ts';
import { loadProviderConfig, providerKeyEnv } from '../providers/config.ts';
import type { FetchLike } from '../providers/gemini-image/image-common.ts';
import { FAL_LIPSYNC_PROVIDER_ID, createFalLipsyncProvider } from '../providers/lipsync/fal/index.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { MANUAL_PROVIDER_ID, createSpendGate } from '../spend/gate.ts';
import { guardGate } from '../rules/guard.ts';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { partOpenness, partRefusal, partsOf } from '../motion/stage.ts';
import { cutAudio, masterHash, resolveAll } from './cut.ts';
import { DEFAULT_MAX_ATTEMPTS, LipsyncError, lipsyncStatus, orphanLine, orphanedUnits, planLipsync } from './plan.ts';
import { collectLipsync, finalizeLipsync, generateLipsync, ingestLipsync, type StepResult } from './run.ts';

export interface CliResult { code: number; out: string }

/** For tests: a mocked network and environment. The command line itself uses the real ones. */
export interface CliIo { fetch?: FetchLike; env?: Record<string, string | undefined>; chunkBytes?: number }

function flags(argv: string[]): { cmd: string; opt: Map<string, string | true>; roots: string[]; bareRoot: boolean } {
  const [cmd = '', ...rest] = argv;
  const opt = new Map<string, string | true>();
  const roots: string[] = [];
  let bareRoot = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    const value: string | true = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (a === '--allow-root') { if (typeof value === 'string') roots.push(value); else bareRoot = true; continue; }
    opt.set(a.slice(2), value);
  }
  return { cmd, opt, roots, bareRoot };
}
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const NL = String.fromCharCode(10);

interface SavedJob { job: Job; handle: JobHandle }
const jobFile = (dir: string, id: string): string => join(dir, 'lipsync', 'jobs', `${id}.json`);

function describe(r: StepResult): CliResult {
  const o = describeStatus(r);
  return r.notes?.length ? { code: o.code, out: [o.out, ...r.notes].join(NL) } : o;
}

function describeStatus(r: StepResult): CliResult {
  switch (r.status) {
    case 'awaiting-approval':
      return { code: 0, out: `${r.confirmation}${NL}Nothing has been sent. Put the amount, and the files that would be uploaded, in front of the person; once they have approved it, run this step again.` };
    case 'refused':
      return { code: 1, out: `Refused (${r.code}): ${r.message}` };
    case 'failed':
      return { code: 1, out: `Failed: ${r.error}` };
    case 'running':
      return { code: 0, out: `Job ${r.job.id} is still running (${r.message}). Run collect --job ${r.job.id} again (it is safe to repeat).` };
    case 'done':
      return { code: 0, out: `Done: ${r.assets.join(', ')} recorded, cost ${Number(r.cost.toFixed(4))}. It is waiting for the person's review. Its own audio is not used: the edit keeps the master for sound.` };
    case 'handoff':
      return { code: 0, out: `${r.text}${NL}${NL}Job ${r.job.id}. When the video is back: ingest --job ${r.job.id} --unit ${r.job.items[0]?.unit ?? '<lipsync id>'} --file <path>.` };
  }
}

/** A part-scoped run's first line: the part is open, and the stage itself still reads as it does project-wide. */
function partHead(p: AkukoProject, part: string): string {
  const o = partOpenness(p, part);
  if (!o.open) return partRefusal(o, partsOf(p));
  const st = p.stages.motion.state;
  return `${part}: open for motion (its key frames and the bible entries they use are approved).${st === 'locked' ? ' The motion stage itself stays locked until the whole film opens; the part's progress is on its units.' : ''}`;
}

export async function run(argv: string[], now: () => Date = () => new Date(), io: CliIo = {}): Promise<CliResult> {
  const { cmd, opt, roots, bareRoot } = flags(argv);
  const dir = str(opt.get('project'));
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  if (bareRoot) return { code: 2, out: 'akuko: --allow-root needs a folder (one the person named), e.g. --allow-root "../Audio/Clips".' };
  const from = opt.get('from');
  if (from !== undefined && from !== 'master') return { code: 2, out: 'akuko: --from takes master (cut the line from the master instead of using its own clip).' };
  for (const r of roots) {
    if (!existsSync(resolve(r))) return { code: 2, out: `akuko: --allow-root ${r} does not exist.` };
  }
  const allowRoots = roots.map((r) => resolve(r));
  const part = opt.get('part');
  if (part === true) return { code: 2, out: 'akuko: --part needs a part id, e.g. --part P7.' };
  const scope = part !== undefined ? { part } : {};
  const audioCtx = { projectDir: dir, allowRoots, ...(from === 'master' ? { from: 'master' as const } : {}), ...scope };
  const host = createLocalHost({ projectDir: dir, now });
  const clock = () => now().toISOString();
  const env = io.env ?? process.env;

  try {
    if (cmd === 'status') {
      const p = await host.readState();
      const rows = lipsyncStatus(p, await resolveAll(p, audioCtx), scope);
      const orphans = orphanedUnits(p, scope).map(orphanLine);
      const head = part !== undefined ? [partHead(p, part)] : [];
      if (rows.length === 0 && orphans.length === 0) return { code: 0, out: [...head, 'Nothing planned yet. Run plan.'].join(NL) };
      return {
        code: 0,
        out: [...head, ...rows.map((r) => `${r.asset} (line${r.lines.length === 1 ? '' : 's'} ${r.lines.join(', ')}): ${r.status} (${r.state}${r.waiting.length ? `, waiting for ${r.waiting.join(' and ')}` : ''}${r.attempts ? `; ${r.attempts} paid attempt${r.attempts === 1 ? '' : 's'}, ${Number(r.spent.toFixed(4))} spent` : ''})`), ...orphans].join(NL),
      };
    }
    if (cmd === 'plan') {
      const before = await host.readState();
      const planned = planLipsync(before, clock(), scope);
      const cut = await cutAudio(planned.project, { ...audioCtx, now: clock(), ...(io.chunkBytes !== undefined ? { chunkBytes: io.chunkBytes } : {}) });
      if (planned.created.length > 0 || cut.cut.length > 0 || cut.project.stages.motion.state !== before.stages.motion.state) await host.writeState(AkukoProjectSchema.parse(cut.project));
      const capped = lipsyncStatus(cut.project, await resolveAll(cut.project, audioCtx), scope).filter((x) => x.attempts >= DEFAULT_MAX_ATTEMPTS && x.state !== 'approved');
      const out = [
        ...(part !== undefined ? [partHead(cut.project, part)] : []),
        planned.created.length ? `Planned ${planned.created.length} lip-sync${planned.created.length === 1 ? '' : 's'}: ${planned.created.join(', ')}.` : 'Every lip-sync is already planned.',
        ...planned.passed.map((x) => `${x.shot}: no lip-sync, because ${x.why}.`),
        ...(cut.cut.length ? [`Cut the line audio for ${cut.cut.join(', ')} (16-bit WAV in lipsync/cuts/). Each is waiting for the person to listen to it on the board.`] : []),
        ...cut.notes,
        ...capped.map((x) => `${x.asset} is at the retry limit (${x.attempts} paid attempts, ${Number(x.spent.toFixed(4))} spent); step will refuse it until the person decides.`),
      ];
      return { code: 0, out: out.join(NL) };
    }
    if (cmd === 'sync') {
      const repaired = await finalizeLipsync({ host, now: clock });
      return { code: 0, out: repaired.length ? `Reset ${repaired.join(', ')} to pending (no video).` : 'Nothing to repair.' };
    }
    if (cmd === 'record-master-hash') {
      const p = await host.readState();
      const m = p.audio?.master;
      if (!m) return { code: 1, out: 'akuko: the project has no audio.master.' };
      const h = await masterHash(p, dir);
      if (m.sha256 === h.sha256) return { code: 0, out: `audio.master.sha256 is already ${h.sha256}.` };
      if (m.sha256 && opt.get('replace') !== true) {
        return { code: 1, out: `audio.master.sha256 is ${m.sha256}, but ${m.uri} now hashes to ${h.sha256}: the master has changed. Nothing was written. If the new file is the right one, check that the film times still match it, then run record-master-hash --replace.` };
      }
      await host.writeState(AkukoProjectSchema.parse({ ...p, audio: { ...p.audio, master: { ...m, sha256: h.sha256 } } }));
      return { code: 0, out: `Recorded audio.master.sha256 = ${h.sha256} for ${m.uri}. If the project has rules, slices of it are uploadable only with { sha256: "${h.sha256}", label: "…", slices: true } in rules.uploads.allow.` };
    }

    // Commands below talk to providers, always through the rules guard and the gate.
    const level = (await host.detect()).level;
    const manual = createManualProvider(host, { now: clock });
    const keyEnv = providerKeyEnv(loadProviderConfig(), FAL_LIPSYNC_PROVIDER_ID);
    const fal = createFalLipsyncProvider(host, {
      projectDir: dir,
      allowRoots,
      now: clock,
      apiKey: () => (keyEnv ? env[keyEnv] : undefined),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    const providers: Provider[] = [manual.provider, fal];
    // Every job is checked against the project rules before the gate sees it (WP-26); the guard reads through its own host.
    const gate = guardGate(createSpendGate({ host, providers, level, now: clock }), createLocalHost({ projectDir: dir, now }), { projectDir: dir, providers });
    // The job file is written the moment a job is submitted, before collecting, so `collect` can always pick it up.
    const saveJob = async (job: Job, handle: JobHandle): Promise<void> => {
      await mkdir(join(dir, 'lipsync', 'jobs'), { recursive: true });
      await writeFileAtomic(jobFile(dir, job.id), `${JSON.stringify({ job, handle } satisfies SavedJob, null, 2)}${NL}`);
    };
    const deps = { host, gate, now: clock, audio: audioCtx, onSubmitted: saveJob };

    if (cmd === 'step') {
      const provider = str(opt.get('provider'));
      if (provider !== MANUAL_PROVIDER_ID && provider !== FAL_LIPSYNC_PROVIDER_ID) return { code: 2, out: `akuko: --provider ${MANUAL_PROVIDER_ID}|${FAL_LIPSYNC_PROVIDER_ID} is required.` };
      const model = str(opt.get('model'));
      const shot = str(opt.get('shot'));
      const max = str(opt.get('max-attempts'));
      // A missing key is a setup problem, not an attempt: say so before the gate is touched.
      if (provider !== MANUAL_PROVIDER_ID && keyEnv && !env[keyEnv]) {
        return { code: 1, out: `Setup needed: ${keyEnv} is not set, so ${provider} cannot be used. Nothing was sent and nothing was counted. Set the key (see /akuko setup), or use --provider manual.` };
      }
      if (max !== undefined && !/^[1-9][0-9]*$/.test(max)) return { code: 2, out: 'akuko: --max-attempts takes a whole number of 1 or more.' };
      const r = await generateLipsync(deps, {
        provider,
        ...(model ? { model } : {}),
        ...(shot ? { shot } : {}),
        ...(part !== undefined ? { part } : {}),
        ...(max !== undefined ? { maxAttempts: Number(max) } : {}),
      });
      return describe(r);
    }

    const jobId = str(opt.get('job'));
    if (cmd === 'ingest' || cmd === 'collect') {
      if (!jobId) return { code: 2, out: 'akuko: --job <id> is required.' };
      const file = jobFile(dir, jobId);
      if (!existsSync(file)) return { code: 1, out: `akuko: no saved job ${jobId}; run step first.` };
      const saved = JSON.parse(await readFile(file, 'utf8')) as SavedJob;
      if (cmd === 'collect') return describe(await collectLipsync(deps, saved.job, saved.handle));
      const unit = str(opt.get('unit'));
      const path = str(opt.get('file'));
      if (!unit || !path) return { code: 2, out: 'akuko: --unit and --file are required.' };
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) return { code: 1, out: `akuko: ${path} is not a .mp4, .webm or .mov video.` };
      const actual = str(opt.get('actual'));
      const model = str(opt.get('model'));
      const r = await ingestLipsync(deps, manual, saved.job, unit, { filename: resolve(path).split(/[\\/]/).pop() ?? 'file', mime, data: new Uint8Array(await readFile(path)) }, {
        ...(actual !== undefined ? { actual: Number(actual) } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      return { code: 0, out: [`Recorded ${r.asset}; it is waiting for the person's review.`, ...r.warnings].join(NL) };
    }

    return { code: 2, out: 'akuko: command must be plan, status, step, ingest, collect, sync or record-master-hash.' };
  } catch (err) {
    if (err instanceof LipsyncError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
