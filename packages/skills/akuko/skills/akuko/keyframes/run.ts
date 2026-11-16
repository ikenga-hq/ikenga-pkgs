/**
 * akuko — one step of the key-frame stage, end to end (WP-22).
 *
 * `generateKeyframes()` is what the action does for each job (default: one shot):
 *
 *   build one job from the next ready key frame (plan.ts)
 *   → quote it at the spend gate (paid: a `pending_spend` entry the person approves)
 *   → only when it is free or already approved: begin the units, `gate.run()`
 *   → paid: `gate.collect()` records the files; manual: hand the prompt package to the person
 *   → refresh the stage state
 *
 * A key frame made from its shot's layout with a paid provider runs in steps,
 * one job each (plan.ts `layoutStepPlan`): every step still to run is quoted
 * first, so the person sees and approves all of its generations; then they run
 * in order, each recorded in the ledger as it finishes. A step before the last
 * is parked on the key frame (`parkLayoutSteps`), not reviewed; if a later step
 * fails or is refused, running `step` again picks up at that step.
 *
 * It never calls a provider's `submit()` itself (only `gate.run()` does), never
 * writes `approved`, and writes the project only through the host.
 */

import { createHash } from 'node:crypto';
import type { Job, JobHandle, JobStatus, WaveOneHost } from '../providers/contract.ts';
import type { ManualProvider } from '../providers/manual/index.ts';
import { SETUP_POINTER, type QuoteResult, type SpendGate } from '../spend/gate.ts';
import { ledgerSummary } from '../spend/ledger.ts';
import { assertValidProject, jobTag } from '../providers/outputs.ts';
import type { LayoutStep } from '../schema/akuko-project.ts';
import { KeyframeError, abandonUnits, beginUnits, buildKeyframeJob, layoutKey, parkLayoutSteps, refreshStageState, repairFileless, stampRefs, type LayoutChain, type LayoutMode } from './plan.ts';

export interface StepDeps {
  host: WaveOneHost;
  gate: SpendGate;
  now?: () => string;
}

export interface StepOptions {
  provider: string;
  model?: string;
  units?: string[];
  scene?: string;
  /** How a shot's layout is used (default: the shot's `layout.mode`, else attach). */
  layoutMode?: LayoutMode;
}

/** Ready key frames that could not be built this time, with the reason (unit id + why). */
export interface SkippedInfo {
  skipped?: Array<{ unit: string; reason: string }>;
  /** A key frame made from its layout: the steps that finished in this call (each already in the ledger). */
  steps?: Array<{ job: string; name: string; cost: number }>;
  /** A key frame made from its layout: how many generations it takes in all. */
  generations?: number;
}

export type StepResult = SkippedInfo & (
  | { status: 'awaiting-approval'; job: Job; estimate: number; confirmation: string }
  | { status: 'refused'; job: Job; code: string; message: string; confirmation?: string }
  | { status: 'handoff'; job: Job; handle: JobHandle; text: string }
  | { status: 'running'; job: Job; handle: JobHandle; message: string }
  | { status: 'done'; job: Job; handle: JobHandle; assets: string[]; cost: number }
  | { status: 'failed'; job: Job; error: string }
);

const clock = (d: Pick<StepDeps, 'now'>): string => (d.now ?? (() => new Date().toISOString()))();

/** Re-read, repair and refresh the stage state, write if anything changed. Returns the repaired key-frame ids. */
export async function finalizeKeyframes(deps: Pick<StepDeps, 'host' | 'now'>): Promise<string[]> {
  const before = await deps.host.readState();
  // An earlier step of a key frame made from its layout is not a take: park its file before anything else looks.
  const parked = parkLayoutSteps(before, clock(deps));
  const repaired = repairFileless(parked.project, clock(deps));
  const after = refreshStageState(repaired.project);
  if (parked.parked.length > 0 || repaired.repaired.length > 0 || after !== repaired.project) await deps.host.writeState(after);
  return repaired.repaired;
}

/** A paid step job before the last of a key frame made from its layout (`<take job>_s<n>`). */
export const isLayoutStepJob = (id: string): boolean => /^job_kf_.+_s\d+$/.test(id);

const money = (n: number): string => String(Number(n.toFixed(4)));
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** The spend line for a key frame made from its layout: every generation, the total, and one approval per step. */
export function chainConfirmation(p: Parameters<typeof ledgerSummary>[0], chain: LayoutChain, quotes: Array<{ name: string; index: number; job: Job; q: QuoteResult }>): string {
  const cur = p.budget?.currency ?? quotes[0]?.q.cost.currency ?? '';
  const total = sum(quotes.map((x) => x.q.cost.amount));
  const job = quotes[0]!.job;
  const model = quotes[0]!.q.cost.model ?? job.model;
  const head = `Spend check — ${chain.unit} from its layout: ${chain.total} generation${chain.total === 1 ? '' : 's'} in all (${[...Array(chain.total).keys()].map((i) => quotes.find((x) => x.index === i)?.name ?? `step ${i + 1} done`).join(', ')})${chain.done ? `, ${chain.done} already made` : ''}; ${quotes.length} to run with ${job.provider}${model ? ` (${model})` : ''}, estimate ${money(total)} ${cur} for them.`;
  const s = ledgerSummary(p);
  if (s.cap === null) return `${head} ${SETUP_POINTER}`;
  const budget = `Budget ${money(s.cap)} ${cur}: spent ${money(s.spent + s.sunk)}, in flight ${money(s.reserved)}, left after this ${money((s.remaining ?? 0) - total)}.`;
  const each = quotes.map((x) => `step ${x.index + 1} ${x.name} (${x.job.id}): ${x.q.pending?.status === 'approved' ? 'approved' : `reply "approve ${money(x.q.cost.amount)} ${cur}"`}`);
  return `${head} ${budget} Each generation is its own approval, and they run in order once all are approved: ${each.join('; ')}. Anything else stops it.`;
}

export async function generateKeyframes(deps: StepDeps, o: StepOptions): Promise<StepResult> {
  const { host, gate } = deps;
  await finalizeKeyframes(deps); // repairs first: an undo may have left a key frame without its file
  const project = await host.readState();
  const built = buildKeyframeJob(project, {
    provider: o.provider,
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.units !== undefined ? { units: o.units } : {}),
    ...(o.scene !== undefined ? { scene: o.scene } : {}),
    ...(o.layoutMode !== undefined ? { layoutMode: o.layoutMode } : {}),
  });
  const res = built.chain ? await runChain(deps, built.chain, o, []) : await runJob(deps, built.job, built.units);
  return built.skipped.length > 0 ? { ...res, skipped: built.skipped } : res;
}

/** Quote every step still to run, then run them in order while each is approved and finishes. */
async function runChain(deps: StepDeps, chain: LayoutChain, o: StepOptions, ran: NonNullable<SkippedInfo['steps']>): Promise<StepResult> {
  const info = (): SkippedInfo => ({ generations: chain.total, ...(ran.length ? { steps: [...ran] } : {}) });
  const quotes: Array<{ name: string; index: number; job: Job; q: QuoteResult }> = [];
  for (const s of chain.steps) {
    const q = await deps.gate.quote(s.job);
    if (q.refusal && q.refusal.code !== 'not-approved') {
      return { status: 'refused', job: s.job, code: q.refusal.code, message: q.refusal.message, ...(q.confirmation ? { confirmation: q.confirmation } : {}), ...info() };
    }
    quotes.push({ name: s.name, index: s.index, job: s.job, q });
  }
  if (quotes.some((x) => x.q.paid && x.q.pending?.status !== 'approved')) {
    await finalizeKeyframes(deps);
    return { status: 'awaiting-approval', job: chain.steps[0]!.job, estimate: sum(quotes.map((x) => x.q.cost.amount)), confirmation: chainConfirmation(await deps.host.readState(), chain, quotes), ...info() };
  }
  const first = chain.steps[0]!;
  const r = await runJob(deps, first.job, [chain.unit]);
  if (r.status !== 'done') return { ...r, ...info() };
  ran.push({ job: first.job.id, name: first.name, cost: r.cost });
  if (chain.steps.length === 1) return { ...r, cost: sum(ran.map((x) => x.cost)), ...info() };
  // runJob collected the step and parked its file on the key frame: build the next step from what is recorded now.
  const next = buildKeyframeJob(await deps.host.readState(), { provider: o.provider, ...(o.model !== undefined ? { model: o.model } : {}), units: [chain.unit], layoutMode: 'two-step' });
  if (!next.chain || next.chain.done !== first.index + 1) {
    return { status: 'failed', job: first.job, error: `step ${first.index + 1} of ${chain.unit} finished but was not recorded as a step; run sync, then step again`, ...info() };
  }
  return runChain(deps, next.chain, o, ran);
}

async function runJob(deps: StepDeps, job: Job, units: string[]): Promise<StepResult> {
  const { host, gate } = deps;

  // Price it and, for a paid job, make the pending entry the person approves. Nothing is submitted.
  const q = await gate.quote(job);
  // `not-approved` just means the person has not answered yet: the normal "waiting" state, not a refusal.
  if (q.refusal && q.refusal.code !== 'not-approved') {
    return { status: 'refused', job, code: q.refusal.code, message: q.refusal.message, ...(q.confirmation ? { confirmation: q.confirmation } : {}) };
  }
  if (q.paid && q.pending?.status !== 'approved') {
    await finalizeKeyframes(deps);
    return { status: 'awaiting-approval', job, estimate: q.cost.amount, confirmation: q.confirmation ?? '' };
  }

  // Clear to go. A sent-back key frame gets its old take cleared so the new one fills it in place;
  // if the gate does not accept the run, the units are put back exactly as they were.
  const before = await host.readState();
  const begun = refreshStageState(stampRefs(beginUnits(before, units, clock(deps)), job));
  await host.writeState(begun);

  const r = await gate.run(job);
  if (r.status !== 'submitted') {
    await host.writeState(refreshStageState(abandonUnits(await host.readState(), before, units)));
    if (r.status === 'awaiting-approval') return { status: 'awaiting-approval', job, estimate: r.cost.amount, confirmation: r.confirmation };
    if (r.status === 'refused') return { status: 'refused', job, code: r.refusal.code, message: r.refusal.message };
    return { status: 'failed', job, error: r.error };
  }

  if (!q.paid) return { status: 'handoff', job, handle: r.handle, text: r.handle.handoff?.text ?? '' };
  return collectKeyframes(deps, job, r.handle, r.cost.amount);
}

/** Poll a submitted job; when it is finished the gate records the files and the stage state is refreshed. */
export async function collectKeyframes(deps: StepDeps, job: Job, handle: JobHandle, estimate = 0): Promise<StepResult> {
  const c = await deps.gate.collect(handle);
  const s: JobStatus = c.status;
  if (s.state === 'queued' || s.state === 'running' || s.state === 'waiting-for-input') {
    return { status: 'running', job, handle, message: s.message ?? s.state };
  }
  await finalizeKeyframes(deps);
  if (s.state !== 'done') return { status: 'failed', job, error: s.message ?? `the job ${s.state}` };
  const cost = Object.values(s.actual ?? {}).reduce((a, b) => a + b, 0) || estimate;
  return { status: 'done', job, handle, assets: c.assets.map((a) => a.id), cost };
}

/**
 * `collect` for a job submitted earlier. When it was a step before the last of a
 * key frame made from its layout, the next steps run straight after (each was
 * approved before the first one ran; one not approved stops it there).
 */
export async function collectAndContinue(deps: StepDeps, job: Job, handle: JobHandle): Promise<StepResult> {
  const r = await collectKeyframes(deps, job, handle);
  if (r.status !== 'done' || !isLayoutStepJob(job.id)) return r;
  const rest = await generateKeyframes(deps, { provider: job.provider, ...(job.model !== undefined ? { model: job.model } : {}), units: job.items.map((i) => i.unit), layoutMode: 'two-step' });
  const before = { job: job.id, name: `step ${/_s(\d+)$/.exec(job.id)![1]}`, cost: r.cost };
  const steps = [before, ...(rest.steps ?? [])];
  return rest.status === 'done' ? { ...rest, steps, cost: sum(steps.map((x) => x.cost)) } : { ...rest, steps };
}

type InFile = { filename: string; mime: string; data: Uint8Array };

/**
 * The person brought a file back for a manual job. For a key frame made from its
 * layout in several steps, `file` is the last step's result; `stepFiles` (optional)
 * are the earlier steps' results, in order, kept on the take as `layout_steps`.
 */
export async function ingestKeyframe(
  deps: Pick<StepDeps, 'host' | 'now'>,
  manual: ManualProvider,
  job: Job,
  unit: string,
  file: InFile,
  extra: { actual?: number; model?: string; via?: string; projectDir?: string; newTake?: boolean; stepFiles?: InFile[] } = {},
): Promise<{ asset: string; warnings: string[] }> {
  const { stepFiles, ...rest } = extra;
  const steps = job.items.find((i) => i.unit === unit)?.steps;
  if (stepFiles?.length && !steps) throw new KeyframeError(`${unit} is made in one generation in job ${job.id}; it takes no step files.`);
  if (steps && stepFiles?.length && stepFiles.length !== steps.length - 1) {
    throw new KeyframeError(`${unit} is made in ${steps.length} steps: bring back the last one's result as the file and the ${steps.length - 1} before it as step files, in order (got ${stepFiles.length}).`);
  }
  const r = await manual.ingest({ job, unit, file, ...rest });
  const warnings = [...r.warnings];
  if (steps) {
    let p = await deps.host.readState();
    const shot = p.shots.find((s) => s.id === r.asset.owner);
    if (stepFiles?.length && shot?.layout) {
      const recorded: LayoutStep[] = [];
      for (const [k, f] of stepFiles.entries()) {
        const ext = f.mime === 'image/jpeg' ? 'jpg' : f.mime === 'image/webp' ? 'webp' : 'png';
        const stored = await deps.host.storeAsset({ kind: 'keyframe', filename: `${unit}-step${k + 1}.${ext}`, mime: f.mime, data: f.data, owner: unit, name: `${unit} step ${k + 1} (${steps[k]!.name})`, tags: ['layout-step', jobTag(job.id)] });
        const charRef = steps[k]!.refs?.find((x) => x.role === 'character');
        const owner = charRef ? p.assets.find((a) => a.id === charRef.id)?.owner : undefined;
        recorded.push({
          step: k === 0 ? 'restyle' : 'identity',
          ...(owner ? { for: owner } : {}),
          uri: stored.file?.uri ?? f.filename,
          hash: createHash('sha256').update(f.data).digest('hex'),
          job: job.id,
          layout: layoutKey(shot.layout.sha256),
          at: clock(deps),
        });
      }
      p = await deps.host.readState();
      p = assertValidProject({ ...p, assets: p.assets.map((a) => (a.id === r.asset.id ? { ...a, layout_steps: recorded } : a)) });
      await deps.host.writeState(p);
    } else {
      warnings.push(`${unit} was made in ${steps.length} steps; the earlier steps' files were not recorded (pass them with --step-files to keep them on the take).`);
    }
    if (extra.via !== undefined) {
      const used = p.ledger.filter((e) => e.allowance?.service === extra.via && e.allowance?.job === job.id && (e.unit === unit || e.unit === r.asset.id)).reduce((n, e) => n + (e.allowance?.units ?? 0), 0);
      if (used < steps.length) warnings.push(`${unit} took ${steps.length} ${extra.via} generations, but the ledger records ${used} for job ${job.id}; record the rest (spend/cli.ts allowance --service ${extra.via} --job ${job.id} --units ${unit}:${steps.length - used}).`);
    }
  }
  await finalizeKeyframes(deps);
  return { asset: r.asset.id, warnings };
}
