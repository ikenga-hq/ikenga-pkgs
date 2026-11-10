/**
 * akuko — one lip-sync, end to end (WP-28b).
 *
 * `generateLipsync()` is what the action does for each job (always one shot):
 *
 *   look up each unit's line audio on disk (cut.ts)
 *   → build one job from the next ready shot (plan.ts), refusing a shot at its retry cap
 *   → quote it at the (rules-guarded) spend gate: a breach is refused before anything is priced;
 *     paid, a `pending_spend` entry the person approves
 *   → only when it is free or already approved: begin the unit, `gate.run()`
 *   → paid: `gate.collect()` records the video; manual: hand the prompt package to the person
 *   → refresh the stage state
 *
 * The lip-sync provider checks every file (place, type, size, real length,
 * model limits) when it estimates, and a problem there is THROWN out of
 * `gate.quote()` / `gate.run()`, not returned (lib/providers.md §"For WP-28b").
 * Both calls are caught here and reported as an ordinary refusal; nothing was
 * priced or sent, and the unit is put back as it was.
 *
 * It never calls a provider's `submit()` itself (only `gate.run()` does),
 * never writes `approved`, and writes the project only through the host.
 */

import type { AkukoProject } from '../schema/akuko-project.ts';
import type { Job, JobHandle, JobStatus, WaveOneHost } from '../providers/contract.ts';
import type { ManualProvider } from '../providers/manual/index.ts';
import type { SpendGate } from '../spend/gate.ts';
import { abandonUnits, beginUnits } from '../motion/plan.ts';
import { resolveAll, stillHashes, type AudioContext } from './cut.ts';
import { buildLipsyncJob, refreshStageState, repairFileless, type Span } from './plan.ts';

export interface StepDeps {
  host: WaveOneHost;
  /** Built with `guardGate()` / `guardedGate()` (rules/guard.ts), never a bare spend gate. */
  gate: SpendGate;
  /** Where the line audio is looked for: the project folder, plus the folders the person named for this run. */
  audio: AudioContext;
  now?: () => string;
  /** Called as soon as a job is submitted, before anything is collected, so a caller can save the handle. */
  onSubmitted?: (job: Job, handle: JobHandle) => Promise<void>;
}

export interface StepOptions {
  provider: string;
  model?: string;
  /** The shot to make (default: the next ready one). */
  shot?: string;
  /** Paid attempts allowed per shot (default 3). Only when the person asked for more, in their own words. */
  maxAttempts?: number;
}

/** What the person should hear besides the result: where the video belongs on the master. */
export interface Notes { notes?: string[] }

/** The code a refusal gets when the provider (or the gate) threw while pricing or starting the job. */
export const PROVIDER_REFUSED = 'provider-refused';

export type StepResult = Notes & (
  | { status: 'awaiting-approval'; job: Job; estimate: number; confirmation: string }
  | { status: 'refused'; job: Job; code: string; message: string; confirmation?: string }
  | { status: 'handoff'; job: Job; handle: JobHandle; text: string }
  | { status: 'running'; job: Job; handle: JobHandle; message: string }
  | { status: 'done'; job: Job; handle: JobHandle; assets: string[]; cost: number }
  | { status: 'failed'; job: Job; error: string }
);

const clock = (d: Pick<StepDeps, 'now'>): string => (d.now ?? (() => new Date().toISOString()))();

/** A thrown error as a refusal: the gate's own code when it carries one, else the provider's message. */
function thrown(job: Job, err: unknown): StepResult {
  const r = (err as { refusal?: { code?: string; message?: string } } | undefined)?.refusal;
  const message = r?.message ?? (err instanceof Error ? err.message : String(err));
  return { status: 'refused', job, code: r?.code ?? PROVIDER_REFUSED, message: `${message} Nothing was priced, sent or spent.` };
}

/** Re-read, repair and refresh the stage state, write if anything changed. Returns the repaired ids. */
export async function finalizeLipsync(deps: Pick<StepDeps, 'host' | 'now'>): Promise<string[]> {
  const before = await deps.host.readState();
  const repaired = repairFileless(before, clock(deps));
  const after = refreshStageState(repaired.project);
  if (repaired.repaired.length > 0 || after !== repaired.project) await deps.host.writeState(after);
  return repaired.repaired;
}

export async function generateLipsync(deps: StepDeps, o: StepOptions): Promise<StepResult> {
  await finalizeLipsync(deps); // repairs first: an undo may have left a lip-sync without its file
  const project = await deps.host.readState();
  const audio = await resolveAll(project, deps.audio);
  const stills = await stillHashes(project, deps.audio);
  const built = buildLipsyncJob(project, {
    provider: o.provider,
    audio,
    stills,
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.shot !== undefined ? { shot: o.shot } : {}),
    ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}),
  });
  const res = await runJob(deps, built.job, [built.unit], built.audio.film);
  return built.notes.length ? { ...res, notes: built.notes } : res;
}

/**
 * The unit, as it starts: `beginUnits` (pending → draft, a sent-back take cleared), and `film` set to
 * where the audio being sent sits on the master clock (a master slice), or cleared (a clip: not known).
 * That is where the video belongs in the edit.
 */
function begin(p: AkukoProject, unit: string, film: Span | undefined, ts: string): AkukoProject {
  const q = beginUnits(p, [unit], ts);
  const a = q.assets.find((x) => x.id === unit);
  if (a) { if (film) a.film = film; else delete a.film; }
  return q;
}

async function runJob(deps: StepDeps, job: Job, units: string[], film?: Span): Promise<StepResult> {
  const { host, gate } = deps;

  // Price it and, for a paid job, make the pending entry the person approves. Nothing is submitted.
  let q: Awaited<ReturnType<SpendGate['quote']>>;
  try {
    q = await gate.quote(job);
  } catch (err) {
    return thrown(job, err);
  }
  // `not-approved` just means the person has not answered yet: the normal "waiting" state, not a refusal.
  if (q.refusal && q.refusal.code !== 'not-approved') {
    return { status: 'refused', job, code: q.refusal.code, message: q.refusal.message, ...(q.confirmation ? { confirmation: q.confirmation } : {}) };
  }
  if (q.paid && q.pending?.status !== 'approved') {
    await finalizeLipsync(deps);
    return { status: 'awaiting-approval', job, estimate: q.cost.amount, confirmation: q.confirmation ?? '' };
  }

  // Clear to go. A sent-back lip-sync gets its old take cleared so the new one fills it in place;
  // if the gate does not accept the run (or throws), the unit is put back exactly as it was.
  const before = await host.readState();
  await host.writeState(refreshStageState(begin(before, units[0]!, film, clock(deps))));
  const putBack = async (): Promise<void> => host.writeState(refreshStageState(abandonUnits(await host.readState(), before, units)));

  let r: Awaited<ReturnType<SpendGate['run']>>;
  try {
    r = await gate.run(job);
  } catch (err) {
    await putBack();
    return thrown(job, err);
  }
  if (r.status !== 'submitted') {
    await putBack();
    if (r.status === 'awaiting-approval') return { status: 'awaiting-approval', job, estimate: r.cost.amount, confirmation: r.confirmation };
    if (r.status === 'refused') return { status: 'refused', job, code: r.refusal.code, message: r.refusal.message };
    return { status: 'failed', job, error: r.error };
  }

  await deps.onSubmitted?.(job, r.handle);
  if (!q.paid) return { status: 'handoff', job, handle: r.handle, text: r.handle.handoff?.text ?? '' };
  return collectLipsync(deps, job, r.handle, r.cost.amount);
}

/** Poll a submitted job; when it is finished the gate records the video and the stage state is refreshed. */
export async function collectLipsync(deps: Pick<StepDeps, 'host' | 'gate' | 'now'>, job: Job, handle: JobHandle, estimate = 0): Promise<StepResult> {
  let c: Awaited<ReturnType<SpendGate['collect']>>;
  try {
    c = await deps.gate.collect(handle);
  } catch (err) {
    // Polling or the download failed. The money is still reserved and nothing is lost: keep the job and try again.
    return { status: 'running', job, handle, message: `could not finish collecting yet (${err instanceof Error ? err.message : String(err)}); the video is not lost` };
  }
  const s: JobStatus = c.status;
  if (s.state === 'queued' || s.state === 'running' || s.state === 'waiting-for-input') {
    return { status: 'running', job, handle, message: s.message ?? s.state };
  }
  await finalizeLipsync(deps);
  if (s.state !== 'done' || c.assets.length === 0) return { status: 'failed', job, error: s.message ?? `the job ${s.state}` };
  const settled = (await deps.host.readState()).ledger.filter((e) => e.job === job.id && e.status === 'done');
  const cost = settled.length ? settled.reduce((sum, e) => sum + (e.actual ?? 0), 0) : estimate;
  return { status: 'done', job, handle, assets: c.assets.map((a) => a.id), cost };
}

/** The person brought a video back for a manual job. */
export async function ingestLipsync(
  deps: Pick<StepDeps, 'host' | 'now'>,
  manual: ManualProvider,
  job: Job,
  unit: string,
  file: { filename: string; mime: string; data: Uint8Array },
  extra: { actual?: number; model?: string } = {},
): Promise<{ asset: string; warnings: string[] }> {
  const r = await manual.ingest({ job, unit, file, ...extra });
  await finalizeLipsync(deps);
  return { asset: r.asset.id, warnings: r.warnings };
}
