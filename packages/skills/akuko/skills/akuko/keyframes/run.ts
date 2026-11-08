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
 * It never calls a provider's `submit()` itself (only `gate.run()` does), never
 * writes `approved`, and writes the project only through the host.
 */

import type { Job, JobHandle, JobStatus, WaveOneHost } from '../providers/contract.ts';
import type { ManualProvider } from '../providers/manual/index.ts';
import type { SpendGate } from '../spend/gate.ts';
import { abandonUnits, beginUnits, buildKeyframeJob, refreshStageState, repairFileless, stampRefs } from './plan.ts';

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
}

export type StepResult =
  | { status: 'awaiting-approval'; job: Job; estimate: number; confirmation: string }
  | { status: 'refused'; job: Job; code: string; message: string; confirmation?: string }
  | { status: 'handoff'; job: Job; handle: JobHandle; text: string }
  | { status: 'running'; job: Job; handle: JobHandle; message: string }
  | { status: 'done'; job: Job; handle: JobHandle; assets: string[]; cost: number }
  | { status: 'failed'; job: Job; error: string };

const clock = (d: Pick<StepDeps, 'now'>): string => (d.now ?? (() => new Date().toISOString()))();

/** Re-read, repair and refresh the stage state, write if anything changed. Returns the repaired key-frame ids. */
export async function finalizeKeyframes(deps: Pick<StepDeps, 'host' | 'now'>): Promise<string[]> {
  const before = await deps.host.readState();
  const repaired = repairFileless(before, clock(deps));
  const after = refreshStageState(repaired.project);
  if (repaired.repaired.length > 0 || after !== repaired.project) await deps.host.writeState(after);
  return repaired.repaired;
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
  });
  const job = built.job;

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
  const begun = refreshStageState(stampRefs(beginUnits(before, built.units, clock(deps)), job));
  await host.writeState(begun);

  const r = await gate.run(job);
  if (r.status !== 'submitted') {
    await host.writeState(refreshStageState(abandonUnits(await host.readState(), before, built.units)));
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

/** The person brought a file back for a manual job. */
export async function ingestKeyframe(
  deps: Pick<StepDeps, 'host' | 'now'>,
  manual: ManualProvider,
  job: Job,
  unit: string,
  file: { filename: string; mime: string; data: Uint8Array },
  extra: { actual?: number; model?: string } = {},
): Promise<{ asset: string; warnings: string[] }> {
  const r = await manual.ingest({ job, unit, file, ...extra });
  await finalizeKeyframes(deps);
  return { asset: r.asset.id, warnings: r.warnings };
}
