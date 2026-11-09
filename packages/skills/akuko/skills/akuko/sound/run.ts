/**
 * akuko — one step of the sound stage, end to end (WP-12).
 *
 * `generateVoiceover()` is what the action does for each job (default: one shot):
 *
 *   build one job from the next ready voice-over (plan.ts)
 *   → quote it at the spend gate (paid: a `pending_spend` entry the person approves)
 *   → only when it is free or already approved: begin the units, `gate.run()`
 *   → paid: `gate.collect()` records the files; manual: hand the prompt package to the person
 *   → refresh the stage state
 *
 * It never calls a provider's `submit()` itself (only `gate.run()` does), never
 * writes `approved`, and writes the project only through the host.
 *
 * Also here: `ingestVoiceover()` (a take the person brought back, with or without
 * a words file) and `ingestSoundFile()` (music or SFX the person supplied).
 */

import type { AkukoProject, Asset } from '../schema/akuko-project.ts';
import type { Job, JobHandle, JobStatus, WaveOneHost } from '../providers/contract.ts';
import { ACCEPT } from '../providers/manual/package.ts';
import type { ManualProvider } from '../providers/manual/index.ts';
import type { SpendGate } from '../spend/gate.ts';
import { assertValidProject } from '../providers/outputs.ts';
import { SOUND_STAGE, SoundError, abandonUnits, assertOpen, beginUnits, buildSoundJob, refreshStageState, repairFileless, stampTake } from './plan.ts';
import { NO_WORDS_TAG, WORDS_TAG, parseWordsFile, serializeWords } from './words.ts';
import { isWav, parseWav } from './wav.ts';

export interface StepDeps {
  host: WaveOneHost;
  gate: SpendGate;
  now?: () => string;
}

export interface StepOptions {
  provider: string;
  model?: string;
  voice?: string;
  units?: string[];
  scene?: string;
}

export type StepResult =
  | { status: 'awaiting-approval'; job: Job; estimate: number; confirmation: string; characters: number }
  | { status: 'refused'; job: Job; code: string; message: string; confirmation?: string }
  | { status: 'handoff'; job: Job; handle: JobHandle; text: string }
  | { status: 'running'; job: Job; handle: JobHandle; message: string }
  | { status: 'done'; job: Job; handle: JobHandle; assets: string[]; cost: number; message?: string }
  | { status: 'failed'; job: Job; error: string };

const clock = (d: Pick<StepDeps, 'now'>): string => (d.now ?? (() => new Date().toISOString()))();

/** Re-read, repair and refresh the stage state, write if anything changed. Returns the repaired asset ids. */
export async function finalizeSound(deps: Pick<StepDeps, 'host' | 'now'>): Promise<string[]> {
  const before = await deps.host.readState();
  const repaired = repairFileless(before, clock(deps));
  const after = refreshStageState(repaired.project);
  if (repaired.repaired.length > 0 || after !== repaired.project) await deps.host.writeState(after);
  return repaired.repaired;
}

export async function generateVoiceover(deps: StepDeps, o: StepOptions): Promise<StepResult> {
  await finalizeSound(deps); // repairs first: an undo may have left a take without its file
  const project = await deps.host.readState();
  const built = buildSoundJob(project, {
    provider: o.provider,
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.voice !== undefined ? { voice: o.voice } : {}),
    ...(o.units !== undefined ? { units: o.units } : {}),
    ...(o.scene !== undefined ? { scene: o.scene } : {}),
  });
  return runJob(deps, built.job, built.units, built.characters);
}

async function runJob(deps: StepDeps, job: Job, units: string[], characters: number): Promise<StepResult> {
  const { host, gate } = deps;

  // Price it and, for a paid job, make the pending entry the person approves. Nothing is submitted.
  const q = await gate.quote(job);
  // `not-approved` just means the person has not answered yet: the normal "waiting" state, not a refusal.
  if (q.refusal && q.refusal.code !== 'not-approved') {
    return { status: 'refused', job, code: q.refusal.code, message: q.refusal.message, ...(q.confirmation ? { confirmation: q.confirmation } : {}) };
  }
  if (q.paid && q.pending?.status !== 'approved') {
    await finalizeSound(deps);
    return { status: 'awaiting-approval', job, estimate: q.cost.amount, confirmation: q.confirmation ?? '', characters };
  }

  // Clear to go. If the gate does not accept the run, the units are put back exactly as they were.
  const before = await host.readState();
  const begun = refreshStageState(stampTake(beginUnits(before, units, clock(deps)), job));
  await host.writeState(begun);

  const r = await gate.run(job);
  if (r.status !== 'submitted') {
    await host.writeState(refreshStageState(abandonUnits(await host.readState(), before, units)));
    if (r.status === 'awaiting-approval') return { status: 'awaiting-approval', job, estimate: r.cost.amount, confirmation: r.confirmation, characters };
    if (r.status === 'refused') return { status: 'refused', job, code: r.refusal.code, message: r.refusal.message };
    return { status: 'failed', job, error: r.error };
  }

  if (!q.paid) return { status: 'handoff', job, handle: r.handle, text: r.handle.handoff?.text ?? '' };
  return collectVoiceover(deps, job, r.handle, r.cost.amount);
}

/** Poll a submitted job; when it is finished the gate records the files and the stage state is refreshed. */
export async function collectVoiceover(deps: StepDeps, job: Job, handle: JobHandle, estimate = 0): Promise<StepResult> {
  const c = await deps.gate.collect(handle);
  const s: JobStatus = c.status;
  if (s.state === 'queued' || s.state === 'running' || s.state === 'waiting-for-input') {
    return { status: 'running', job, handle, message: s.message ?? s.state };
  }
  await finalizeSound(deps);
  if (s.state !== 'done') return { status: 'failed', job, error: s.message ?? `the job ${s.state}` };
  const cost = Object.values(s.actual ?? {}).reduce((a, b) => a + b, 0) || estimate;
  return { status: 'done', job, handle, assets: c.assets.map((a) => a.id), cost, ...(s.message ? { message: s.message } : {}) };
}

export interface IngestVoiceoverResult { asset: string; warnings: string[]; timings: boolean }

/**
 * The person brought a voice-over back for a manual job. With a words file the
 * take is stored with its word timings; without one it is recorded WITHOUT
 * timings (tagged `no-words`) and the result says captions need them. Timings
 * are never made up.
 */
export async function ingestVoiceover(
  deps: Pick<StepDeps, 'host' | 'now'>,
  manual: ManualProvider,
  job: Job,
  unit: string,
  file: { filename: string; mime: string; data: Uint8Array },
  extra: { words?: { filename: string; data: Uint8Array }; actual?: number; model?: string } = {},
): Promise<IngestVoiceoverResult> {
  const item = job.items.find((i) => i.unit === unit);
  if (!item) throw new SoundError(`unit "${unit}" is not part of job "${job.id}"`);
  // Read the words first: a bad words file must not leave a half-recorded take.
  const wordsFile = extra.words ? parseWordsFile(extra.words.data, unit, item.prompt) : undefined;
  const r = await manual.ingest({ job, unit, file, ...(extra.actual !== undefined ? { actual: extra.actual } : {}), ...(extra.model !== undefined ? { model: extra.model } : {}) });
  const warnings = [...r.warnings];

  let tag: string;
  if (wordsFile) {
    let duration = wordsFile.duration_ms;
    if (isWav(file.data)) {
      try { duration = Math.max(duration, parseWav(file.data).durationMs); } catch { /* keep the words' own length */ }
    }
    const stored = await deps.host.storeAsset({
      kind: 'vo',
      filename: `${r.asset.id}-words.json`,
      mime: 'application/json',
      data: serializeWords({ ...wordsFile, duration_ms: duration }),
      tags: ['words-file'],
      owner: unit,
    });
    tag = `${WORDS_TAG}${stored.file?.uri ?? ''}`;
  } else {
    tag = NO_WORDS_TAG;
    warnings.push('Recorded without word timings: captions need them. Bring a words file ({word, start_ms, end_ms} in milliseconds) with --words, or the takes can be captioned later. No timings were guessed.');
  }
  const p = await deps.host.readState();
  const next: AkukoProject = {
    ...p,
    assets: p.assets.map((a): Asset => (a.id === r.asset.id ? { ...a, tags: [...a.tags.filter((t) => !t.startsWith(WORDS_TAG) && t !== NO_WORDS_TAG), tag] } : a)),
  };
  await deps.host.writeState(assertValidProject(next));
  await finalizeSound(deps);
  return { asset: r.asset.id, warnings, timings: wordsFile !== undefined };
}

export interface SoundFileInput {
  kind: 'music' | 'sfx';
  file: { filename: string; mime: string; data: Uint8Array };
  /** Required: what the person says the licence is (for example "CC BY 4.0", "bought, standard licence", "own recording"). */
  licence: string;
  /** Optional: where it came from (a URL, a library, a person). */
  source?: string;
  /** Where it sits: one shot, one scene, or the whole film (default). */
  placement?: { shot: string } | { scene: string } | 'film';
  name?: string;
}

/**
 * Record a music bed or SFX the person supplied. It becomes a `music` / `sfx`
 * asset at `pending-review` (a person approves it like any unit) with the
 * licence and source in its tags and where it sits (`placement:film|scene:<id>|shot:<id>`).
 * akuko generates none of these. A licence statement is required.
 */
export async function ingestSoundFile(deps: Pick<StepDeps, 'host' | 'now'>, input: SoundFileInput): Promise<{ asset: string; warnings: string[] }> {
  const licence = input.licence.trim();
  if (licence === '') throw new SoundError('Say what the licence is (for example "own recording", "CC BY 4.0", "bought: standard licence"). akuko records it with the file; it cannot check it.');
  if (!ACCEPT.audio.includes(input.file.mime)) throw new SoundError(`audio files only (${ACCEPT.audio.join(', ')}); got ${input.file.mime}`);
  if (input.file.data.byteLength === 0) throw new SoundError(`${input.file.filename} is empty`);
  const where = input.placement ?? 'film';
  const p0 = await deps.host.readState();
  assertOpen(p0);
  let placement: string;
  let owner: string | undefined;
  if (where === 'film') placement = 'placement:film';
  else if ('shot' in where) {
    if (!p0.shots.some((s) => s.id === where.shot)) throw new SoundError(`unknown shot "${where.shot}"`);
    placement = `placement:shot:${where.shot}`;
    owner = where.shot;
  } else {
    if (!p0.scenes.some((s) => s.id === where.scene)) throw new SoundError(`unknown scene "${where.scene}"`);
    placement = `placement:scene:${where.scene}`;
  }
  const slug = (where === 'film' ? 'film' : 'shot' in where ? where.shot : where.scene).replace(/[^A-Za-z0-9_-]/g, '_');
  const taken = new Set(p0.assets.map((a) => a.id));
  let n = 1;
  while (taken.has(`${slug}_${input.kind}_${n}`)) n++;
  const id = `${slug}_${input.kind}_${n}`;
  const ext = input.file.filename.includes('.') ? input.file.filename.split('.').pop()!.toLowerCase() : 'bin';
  const stored = await deps.host.storeAsset({
    kind: input.kind,
    filename: `${id}.${ext}`,
    mime: input.file.mime,
    data: input.file.data,
    id,
    tags: ['supplied'],
    ...(owner ? { owner } : {}),
  });
  const ts = clock(deps);
  const p = await deps.host.readState();
  const asset: Asset = {
    id,
    kind: input.kind,
    stage: SOUND_STAGE,
    status: 'pending-review', // a person approves it; nothing here writes `approved`
    comments: [],
    tags: ['supplied', `licence:${licence}`, ...(input.source?.trim() ? [`source:${input.source.trim()}`] : []), placement],
    updated_at: ts,
    name: input.name?.trim() || `${input.kind} (${placement.slice('placement:'.length)})`,
    ...(owner ? { owner } : {}),
    ...(stored.file ? { file: stored.file } : {}),
    by_stage: { [SOUND_STAGE]: { status: 'pending-review', ...(stored.file ? { output: stored.file } : {}) } },
  };
  const unlocked = p.stages.sound.state === 'locked' ? { ...p, stages: { ...p.stages, sound: { state: 'not-started' as const } } } : p;
  const next = refreshStageState(assertValidProject({ ...unlocked, assets: [...p.assets.filter((a) => a.id !== id), asset] }));
  await deps.host.writeState(next);
  return { asset: id, warnings: [] };
}
