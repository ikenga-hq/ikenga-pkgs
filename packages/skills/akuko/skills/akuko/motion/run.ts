/**
 * akuko — one step of the motion stage (clips), end to end (WP-10).
 *
 * `generateClips()` is what the action does for each job (default: one shot):
 *
 *   build one job from the next ready clip (plan.ts), refusing a shot at its retry cap
 *   → quote it at the spend gate (paid: a `pending_spend` entry the person approves)
 *   → only when it is free or already approved: begin the units, `gate.run()`
 *   → paid: `gate.collect()` records the files; manual: hand the prompt package to the person
 *   → refresh the stage state
 *
 * It never calls a provider's `submit()` itself (only `gate.run()` does), never
 * writes `approved`, and writes the project only through the host.
 */

import type { Job, JobHandle, JobStatus, WaveOneHost } from '../providers/contract.ts';
import type { ManualProvider } from '../providers/manual/index.ts';
import type { SpendGate } from '../spend/gate.ts';
import { abandonUnits, beginUnits, buildMotionJob, refreshStageState, repairFileless } from './plan.ts';

export interface StepDeps {
  host: WaveOneHost;
  gate: SpendGate;
  now?: () => string;
  /** Called as soon as a job is submitted and before anything is collected, so a caller can save the handle: if collecting then fails, the reservation can still be recovered with `collect`. */
  onSubmitted?: (job: Job, handle: JobHandle) => Promise<void>;
}

export interface StepOptions {
  provider: string;
  model?: string;
  units?: string[];
  scene?: string;
  /** Ask for native sound where the model has it. Default off. */
  audio?: boolean;
  /** Paid attempts allowed per shot (default 3). Only when the person asked for more, in their own words. */
  maxAttempts?: number;
  /** `cover` (default) or `nearest`: see buildMotionJob. */
  fit?: 'cover' | 'nearest';
}

/** Ready clips that could not be built this time, with the reason (unit id + why). */
export interface SkippedInfo { skipped?: Array<{ unit: string; reason: string }>; /** What the person should hear: a changed length, sound off. */ notes?: string[] }

export type StepResult = SkippedInfo & (
  | { status: 'awaiting-approval'; job: Job; estimate: number; confirmation: string }
  | { status: 'refused'; job: Job; code: string; message: string; confirmation?: string }
  | { status: 'handoff'; job: Job; handle: JobHandle; text: string }
  | { status: 'running'; job: Job; handle: JobHandle; message: string }
  | { status: 'done'; job: Job; handle: JobHandle; assets: string[]; cost: number; /** Clips of a batch the provider did not make (they stay draft; a new job with its own approval remakes them). */ missing?: string[]; message?: string }
  | { status: 'failed'; job: Job; error: string }
);

const clock = (d: Pick<StepDeps, 'now'>): string => (d.now ?? (() => new Date().toISOString()))();

/** Re-read, repair and refresh the stage state, write if anything changed. Returns the repaired clip ids. */
export async function finalizeMotion(deps: Pick<StepDeps, 'host' | 'now'>): Promise<string[]> {
  const before = await deps.host.readState();
  const repaired = repairFileless(before, clock(deps));
  const after = refreshStageState(repaired.project);
  if (repaired.repaired.length > 0 || after !== repaired.project) await deps.host.writeState(after);
  return repaired.repaired;
}

export async function generateClips(deps: StepDeps, o: StepOptions): Promise<StepResult> {
  const { host, gate } = deps;
  await finalizeMotion(deps); // repairs first: an undo may have left a clip without its file
  const project = await host.readState();
  const built = buildMotionJob(project, {
    provider: o.provider,
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.units !== undefined ? { units: o.units } : {}),
    ...(o.scene !== undefined ? { scene: o.scene } : {}),
    ...(o.audio !== undefined ? { audio: o.audio } : {}),
    ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}),
    ...(o.fit !== undefined ? { fit: o.fit } : {}),
  });
  const res = await runJob(deps, built.job, built.units);
  return { ...res, ...(built.skipped.length > 0 ? { skipped: built.skipped } : {}), ...(built.notes.length > 0 ? { notes: built.notes } : {}) };
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
    await finalizeMotion(deps);
    return { status: 'awaiting-approval', job, estimate: q.cost.amount, confirmation: q.confirmation ?? '' };
  }

  // Clear to go. A sent-back clip gets its old take cleared so the new one fills it in place;
  // if the gate does not accept the run, the units are put back exactly as they were.
  const before = await host.readState();
  const begun = refreshStageState(beginUnits(before, units, clock(deps)));
  await host.writeState(begun);

  const r = await gate.run(job);
  if (r.status !== 'submitted') {
    await host.writeState(refreshStageState(abandonUnits(await host.readState(), before, units)));
    if (r.status === 'awaiting-approval') return { status: 'awaiting-approval', job, estimate: r.cost.amount, confirmation: r.confirmation };
    if (r.status === 'refused') return { status: 'refused', job, code: r.refusal.code, message: r.refusal.message };
    return { status: 'failed', job, error: r.error };
  }

  await deps.onSubmitted?.(job, r.handle);
  if (!q.paid) return { status: 'handoff', job, handle: r.handle, text: r.handle.handoff?.text ?? '' };
  return collectClips(deps, job, r.handle, r.cost.amount);
}

/** Poll a submitted job; when it is finished the gate records the files and the stage state is refreshed. */
export async function collectClips(deps: StepDeps, job: Job, handle: JobHandle, estimate = 0): Promise<StepResult> {
  let c: Awaited<ReturnType<SpendGate['collect']>>;
  try {
    c = await deps.gate.collect(handle);
  } catch (err) {
    // Polling or the download failed. The money is still reserved and nothing is lost: keep the job and try again.
    return { status: 'running', job, handle, message: `could not finish collecting yet (${err instanceof Error ? err.message : String(err)}); the clip is not lost` };
  }
  const s: JobStatus = c.status;
  if (s.state === 'queued' || s.state === 'running' || s.state === 'waiting-for-input') {
    return { status: 'running', job, handle, message: s.message ?? s.state };
  }
  await finalizeMotion(deps);
  if (s.state !== 'done') return { status: 'failed', job, error: s.message ?? `the job ${s.state}` };
  // What this job actually cost: its settled ledger entries (a batch that partly failed settles the missing clips at 0).
  const settled = (await deps.host.readState()).ledger.filter((e) => e.job === job.id && e.status === 'done');
  const cost = settled.length ? settled.reduce((sum, e) => sum + (e.actual ?? 0), 0) : estimate;
  const made = new Set(c.assets.map((a) => a.id));
  const missing = handle.units.filter((u) => !made.has(u));
  return { status: 'done', job, handle, assets: [...made], cost, ...(missing.length ? { missing, ...(s.message ? { message: s.message } : {}) } : {}) };
}

/** The person brought a file back for a manual job. */
export async function ingestClip(
  deps: Pick<StepDeps, 'host' | 'now'>,
  manual: ManualProvider,
  job: Job,
  unit: string,
  file: { filename: string; mime: string; data: Uint8Array },
  extra: { actual?: number; model?: string } = {},
): Promise<{ asset: string; warnings: string[] }> {
  const r = await manual.ingest({ job, unit, file, ...extra });
  await finalizeMotion(deps);
  return { asset: r.asset.id, warnings: r.warnings };
}
