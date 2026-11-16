/**
 * akuko — command line for the key-frame stage (hosts B and C).
 *
 *   node --experimental-strip-types keyframes/cli.ts <command> --project <dir> [options]
 *
 *   plan                      create a planned key frame for every shot (idempotent)
 *   status                    one line per key frame: its status, what it is waiting for, and its layout
 *   layout  --shot <id> --file <path> [--from <what made it>]
 *           make a 3D-blockout render the shot's layout (stored through the host, sha256 recorded);
 *           [--mode attach|two-step|off]  how its key frame uses it by default (attach if never set);
 *           --mode alone changes only the mode; --clear instead of --file removes the layout
 *   step    --provider <id>   the next key frame (one shot) through the spend gate: manual | gemini-image | fal | byteplus-image
 *           [--model <id>] [--units a,b] [--scene sc1] [--allowance <service>] [--layout-mode attach|two-step|off]
 *             paid: prints the spend line and stops until a person approves it, then runs and records
 *               (--layout-mode overrides each shot's layout.mode for this job; two-step: one approval per generation, run in order)
 *             manual: prints the prompt package and stops; bring files back with `ingest`
 *               --allowance canva also prints the allowance line, counting every generation
 *   ingest  --job <id> --unit <asset id> --file <path> [--step-files <p1>[,<p2>]] [--actual <n>] [--model <id>] [--via <service>] [--new-take]
 *           record a file the person made for a manual job (from a layout: the last step's result;
 *           --step-files the earlier steps' results, in order)
 *   collect --job <id>        poll a paid job submitted earlier and record its files (a layout step: then the next steps run)
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
import { KeyframeError, keyframeStatus, planKeyframes } from './plan.ts';
import { collectAndContinue, finalizeKeyframes, generateKeyframes, ingestKeyframe, type StepResult } from './run.ts';
import { allowanceLine } from '../spend/allowance.ts';
import { LAYOUT_MODES, layoutProgress, type LayoutMode } from './plan.ts';
import { clearLayout, setLayout, setLayoutMode } from './layout.ts';

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

function describe(r: StepResult, costLine?: string): { code: number; out: string } {
  const o = describeStatus(r, costLine);
  const money = (n: number): string => String(Number(n.toFixed(4)));
  const steps = r.steps?.length && r.status !== 'done'
    ? [`Made so far, each in the ledger: ${r.steps.map((s) => `${s.name} (${s.job}, ${money(s.cost)})`).join(', ')}. Run step again to go on from the next step; the steps already made are kept.`]
    : [];
  const skipped = (r.skipped ?? []).map((x) => `Skipped ${x.unit}: ${x.reason}`);
  const extra = [...steps, ...skipped];
  return extra.length ? { code: o.code, out: [o.out, ...extra].join(String.fromCharCode(10)) } : o;
}

function describeStatus(r: StepResult, costLine?: string): { code: number; out: string } {
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
      if (r.generations !== undefined && r.steps?.length) {
        return { code: 0, out: `Done: ${r.assets.join(', ')} recorded, made from its layout in ${r.generations} generation${r.generations === 1 ? '' : 's'} (${r.steps.map((s) => `${s.name} ${s.job} ${Number(s.cost.toFixed(4))}`).join(', ')}${r.steps.length < r.generations ? `, and ${r.generations - r.steps.length} made earlier` : ''}), cost ${Number(r.cost.toFixed(4))} for these. It is waiting for the person's review.` };
      }
      return { code: 0, out: `Done: ${r.assets.length} key frame${r.assets.length === 1 ? '' : 's'} recorded (${r.assets.join(', ')}), ${costLine ?? `cost ${Number(r.cost.toFixed(4))}`}. They are waiting for the person's review.` };
    case 'handoff': {
      const stepped = r.job.items.filter((i) => i.steps);
      const how = stepped.length
        ? ` For a key frame made in steps (${stepped.map((i) => `${i.unit}: ${i.steps!.length} generations`).join(', ')}), --file is the last step's result; add --step-files <step 1>[,<step 2>…] for the earlier ones.`
        : '';
      return { code: 0, out: `${r.text}\n\nJob ${r.job.id}. When the files are back: ingest --job ${r.job.id} --unit <asset id> --file <path> for each.${how}` };
    }
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
      const p = await host.readState();
      const LAYOUT: Record<string, string> = { pending: 'layout set; the next take is made from it', used: 'made from its layout', 'not-used': 'made without the layout the shot now has - consider sending it back', changed: 'made from an earlier layout' };
      const progress = (asset: string, state: string): string => {
        const a = p.assets.find((x) => x.id === asset);
        const g = a ? layoutProgress(p, a) : undefined;
        if (!g) return '';
        if (state !== 'pending') return '';
        if (g.mode !== 'two-step') return `; mode ${g.mode}${g.mode === 'off' ? ' (the layout is not used)' : ''}, 1 generation`;
        return `; mode two-step, ${g.total} generation${g.total === 1 ? '' : 's'} (${g.names.join(', ')})${g.done ? `, ${g.done} made, next: ${g.names[g.done]}` : ''}`;
      };
      return { code: 0, out: rows.map((r) => `${r.asset}: ${r.status} (${r.state}${r.waiting.length ? `, waiting for ${r.waiting.join(', ')}` : ''}${r.superseded.length ? `; made from a superseded ${r.superseded.join(', ')} - consider sending it back` : ''}${r.layout !== 'none' ? `; ${LAYOUT[r.layout]}${progress(r.asset, r.layout)}` : ''})`).join('\n') };
    }
    if (cmd === 'layout') {
      const shot = str(opt.get('shot'));
      const path = str(opt.get('file'));
      const modeArg = str(opt.get('mode'));
      if (opt.has('mode') && !(LAYOUT_MODES as readonly string[]).includes(modeArg ?? '')) return { code: 2, out: `akuko: --mode takes ${LAYOUT_MODES.join(', ')}.` };
      if (shot && !path && modeArg) {
        const r = await setLayoutMode(host, shot, modeArg as LayoutMode);
        return { code: 0, out: r.changed ? `${shot}'s key frame now uses its layout in mode ${modeArg} by default (a step's --layout-mode still overrides it).` : `${shot} already uses mode ${modeArg}.` };
      }
      if (!shot || (!path && opt.get('clear') !== true)) return { code: 2, out: 'akuko: layout needs --shot <id> and --file <path> (or --mode <mode>, or --clear).' };
      const stale = (t: string | undefined): string[] => (t ? [`${t} already has a take made from ${path ? 'an earlier layout or none' : 'this layout'}; status flags it. Only a person sends it back.`] : []);
      if (!path) {
        const r = await clearLayout(host, shot);
        return { code: 0, out: r.changed ? [`Removed ${shot}'s layout (the file stays at ${r.previous!.uri}).`, ...stale(r.staleTake)].join('\n') : `${shot} has no layout.` };
      }
      const from = str(opt.get('from'));
      const r = await setLayout(host, shot, { filename: resolve(path).split(/[\\/]/).pop() ?? 'layout', data: new Uint8Array(await readFile(path)) }, { now: clock(), ...(from ? { from } : {}) });
      const m = modeArg ? await setLayoutMode(host, shot, modeArg as LayoutMode) : undefined;
      const mode = (m?.layout ?? r.layout)?.mode ?? 'attach';
      const how = mode === 'two-step' ? 'mode two-step: the layout restyled on its own, then each character put on model, 1 + characters generations' : mode === 'off' ? 'mode off: not used unless a step asks for it' : 'mode attach: attached first with the other references, 1 generation';
      if (!r.changed) return { code: 0, out: `${shot} already has this file as its layout (${r.layout!.uri}); ${m?.changed ? `its mode is now ${mode}` : 'nothing changed'}.` };
      return { code: 0, out: [`${shot}'s layout is ${r.layout!.uri} (sha256 ${r.layout!.sha256.slice(0, 12)}…${r.previous ? `; it replaces ${r.previous.uri}` : ''}). Its key frame uses it in ${how} (--mode to change; step --layout-mode for one job).`, ...stale(r.staleTake)].join('\n') };
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
      const scene = str(opt.get('scene'));
      const service = str(opt.get('allowance'));
      if (opt.has('allowance') && (!service || provider !== 'manual')) return { code: 2, out: 'akuko: --allowance <service> (e.g. canva) goes with --provider manual: the frames are made with that connected tool from the prompt package.' };
      const lm = str(opt.get('layout-mode'));
      if (opt.has('layout-mode') && !(LAYOUT_MODES as readonly string[]).includes(lm ?? '')) return { code: 2, out: `akuko: --layout-mode takes ${LAYOUT_MODES.join(', ')}.` };
      const r = await generateKeyframes(deps, { provider, ...(model ? { model } : {}), ...(units ? { units } : {}), ...(scene ? { scene } : {}), ...(lm ? { layoutMode: lm as LayoutMode } : {}) });
      if (r.status === 'handoff' || r.status === 'running') {
        await mkdir(join(dir, 'keyframes', 'jobs'), { recursive: true });
        await writeFileAtomic(jobFile(dir, r.job.id), `${JSON.stringify({ job: r.job, handle: r.handle } satisfies SavedJob, null, 2)}\n`);
      }
      const d = describe(r);
      if (service && r.status === 'handoff') {
        // The allowance count is every generation: a key frame made from its layout in steps counts each step.
        const wave = { label: r.job.label, service, serviceLabel: service.charAt(0).toUpperCase() + service.slice(1), units: r.job.items.map((i) => ({ unit: i.unit, count: i.steps?.length ?? i.count ?? 1 })) };
        const record = `After the generations: spend/cli.ts allowance --project <folder> --service ${service} --job ${r.job.id} --units ${wave.units.map((u) => (u.count > 1 ? `${u.unit}:${u.count}` : u.unit)).join(',')}`;
        return { code: d.code, out: [d.out, '', allowanceLine(await host.readState(), wave), record].join('\n') };
      }
      return d;
    }

    const jobId = str(opt.get('job'));
    if (cmd === 'ingest' || cmd === 'collect') {
      if (!jobId) return { code: 2, out: 'akuko: --job <id> is required.' };
      const file = jobFile(dir, jobId);
      if (!existsSync(file)) return { code: 1, out: `akuko: no saved job ${jobId}; run step first.` };
      const saved = JSON.parse(await readFile(file, 'utf8')) as SavedJob;
      if (cmd === 'collect') {
        const r = await collectAndContinue(deps, saved.job, saved.handle);
        if (r.status === 'running') {
          await writeFileAtomic(jobFile(dir, r.job.id), `${JSON.stringify({ job: r.job, handle: r.handle } satisfies SavedJob, null, 2)}\n`);
        }
        return describe(r, r.status === 'done' && !r.steps ? ledgerCostLine(await host.readState(), saved.job.id, r.cost) : undefined);
      }
      const unit = str(opt.get('unit'));
      const path = str(opt.get('file'));
      if (!unit || !path) return { code: 2, out: 'akuko: --unit and --file are required.' };
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) return { code: 1, out: `akuko: ${path} is not a .png, .jpg or .webp image.` };
      const actual = str(opt.get('actual'));
      const model = str(opt.get('model'));
      const stepPaths = str(opt.get('step-files'))?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
      const stepFiles = [];
      for (const sp of stepPaths) {
        const m = MIME[extname(sp).toLowerCase()];
        if (!m) return { code: 1, out: `akuko: ${sp} is not a .png, .jpg or .webp image.` };
        stepFiles.push({ filename: resolve(sp).split(/[\\/]/).pop() ?? 'step', mime: m, data: new Uint8Array(await readFile(sp)) });
      }
      const r = await ingestKeyframe(deps, manual, saved.job, unit, { filename: resolve(path).split(/[\\/]/).pop() ?? 'file', mime, data: new Uint8Array(await readFile(path)) }, {
        ...(stepFiles.length ? { stepFiles } : {}),
        ...(actual !== undefined ? { actual: Number(actual) } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(str(opt.get('via')) !== undefined ? { via: str(opt.get('via'))!, projectDir: dir } : {}),
        ...(opt.get('new-take') === true ? { newTake: true } : {}),
      });
      return { code: 0, out: [`Recorded ${r.asset}; it is waiting for the person's review.`, ...r.warnings].join('\n') };
    }

    return { code: 2, out: 'akuko: command must be plan, status, layout, step, ingest, collect or sync.' };
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
