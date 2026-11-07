/**
 * Manual provider — the no-key path for every stage.
 *
 * Implements the provider contract by handing the work to a person:
 *   estimate  0 (priced from config.json like any provider: the `manual` entry's default model)
 *   submit    builds a prompt package and returns it as the handle's `handoff`
 *   ingest    takes the file the person brings back, stores it via
 *             host.storeAsset() and records it in akuko.json (asset added,
 *             unit → pending-review, any spend they report → ledger)
 *   poll      done once every unit of the job has an ingested file
 *   fetch     the ingested assets
 *
 * Lifted in shape from Studio's `export.prompt_package` /
 * `render.ingest_external` pair. State lives in akuko.json (assets tagged
 * `job:<id>`), so a job can be picked up in a later session from its handle.
 */

import type { AkukoProject, Asset } from '../../schema/akuko-project.ts';
import { findUnit } from '../../schema/akuko-project.ts';
import type { Job, JobHandle, JobStatus, Provider, WaveOneHost } from '../contract.ts';
import { jobProblems } from '../contract.ts';
import type { AkukoProviderConfig } from '../config.ts';
import { estimateFromConfig, loadProviderConfig } from '../config.ts';
import { assertValidProject, jobTag, planAssetId, recordOutput } from '../outputs.ts';
import { SETUP_POINTER, sealProvider } from '../../spend/gate.ts';
import { recordDone } from '../../spend/ledger.ts';
import type { ManualPlatform, PromptPackage } from './package.ts';
import { ACCEPT, EXT_BY_MIME, buildPromptPackage, expectedFilename, renderPromptPackage } from './package.ts';

export const MANUAL_PROVIDER_ID = 'manual';

export class ManualIngestError extends Error {
  override name = 'ManualIngestError';
}

export interface ManualOptions {
  platform?: ManualPlatform;
  config?: AkukoProviderConfig;
  now?: () => string;
}

export interface IngestInput {
  job: Job;
  unit: string;
  file: { filename: string; mime: string; data: Uint8Array };
  /** What the person says it cost them (credits on a tool they ran by hand). Recorded when a budget exists. */
  actual?: number;
  /** Model the person used, if they say. */
  model?: string;
}

export interface IngestResult {
  asset: Asset;
  warnings: string[];
}

export interface ManualProvider {
  provider: Provider;
  ingest(input: IngestInput): Promise<IngestResult>;
}

/** Assets ingested for a job: tagged `job:<id>`, belonging to one of its units, with a file. */
function ingested(p: AkukoProject, h: Pick<JobHandle, 'job' | 'units'>): Map<string, Asset[]> {
  const tag = jobTag(h.job);
  const byUnit = new Map<string, Asset[]>();
  for (const a of p.assets) {
    if (!a.file || !a.tags.includes(tag)) continue;
    const unit = h.units.includes(a.id) ? a.id : a.owner;
    if (unit === undefined || !h.units.includes(unit)) continue;
    byUnit.set(unit, [...(byUnit.get(unit) ?? []), a]);
  }
  return byUnit;
}

export function createManualProvider(host: WaveOneHost, opts: ManualOptions = {}): ManualProvider {
  const config = opts.config ?? loadProviderConfig();
  const now = opts.now ?? (() => new Date().toISOString());
  const platform = opts.platform ?? 'generic';

  const provider = sealProvider(
    {
      id: MANUAL_PROVIDER_ID,
      kinds: ['image', 'video', 'audio', 'layout'],
      hosts: ['A', 'B', 'C'],
      capabilities: {},

      async estimate(job) {
        return estimateFromConfig(config, job);
      },

      async submit(job) {
        const pkg: PromptPackage = buildPromptPackage(job, platform, now());
        return {
          job: job.id,
          provider: MANUAL_PROVIDER_ID,
          ref: `manual:${job.id}`,
          stage: job.stage,
          units: job.items.map((i) => i.unit),
          submitted_at: now(),
          ledger: [],
          handoff: { kind: 'prompt-package', body: pkg, text: renderPromptPackage(pkg) },
        };
      },

      async poll(h): Promise<JobStatus> {
        const got = ingested(await host.readState(), h);
        const back = h.units.filter((u) => got.has(u)).length;
        if (back === h.units.length) return { state: 'done', progress: 1, message: `all ${back} file${back === 1 ? '' : 's'} back` };
        return {
          state: 'waiting-for-input',
          progress: back / h.units.length,
          message: `${back} of ${h.units.length} files back; waiting for ${h.units.filter((u) => !got.has(u)).join(', ')}`,
        };
      },

      async fetch(h) {
        const got = ingested(await host.readState(), h);
        return h.units.flatMap((u) => got.get(u) ?? []);
      },
    },
    { config },
  );

  async function ingest(input: IngestInput): Promise<IngestResult> {
    const { job, unit, file } = input;
    const problems = jobProblems(job);
    if (problems.length) throw new ManualIngestError(problems.join('; '));
    if (job.provider !== MANUAL_PROVIDER_ID) throw new ManualIngestError(`job "${job.id}" is for ${job.provider}, not the manual provider`);
    const item = job.items.find((i) => i.unit === unit);
    if (!item) throw new ManualIngestError(`unit "${unit}" is not part of job "${job.id}"`);
    if (!ACCEPT[job.kind].includes(file.mime)) {
      throw new ManualIngestError(`a ${job.kind} job takes ${ACCEPT[job.kind].join(', ')}; got ${file.mime}`);
    }
    if (file.data.byteLength === 0) throw new ManualIngestError(`${file.filename} is empty`);
    if (input.actual !== undefined && (!Number.isFinite(input.actual) || input.actual < 0)) {
      throw new ManualIngestError(`actual ${input.actual} is not a non-negative amount`);
    }

    const before = await host.readState();
    const ref = findUnit(before, unit);
    if (!ref) throw new ManualIngestError(`unknown unit "${unit}"`);
    const planned = planAssetId(before, unit, job.stage);
    const kind = planned.inPlace && ref.kind === 'asset' ? ref.unit.kind : item.output;
    const ext = EXT_BY_MIME[file.mime] ?? file.filename.split('.').pop() ?? 'bin';

    const stored = await host.storeAsset({
      kind,
      filename: expectedFilename(unit, job.stage, ext),
      mime: file.mime,
      data: file.data,
      id: planned.id,
      provider: MANUAL_PROVIDER_ID,
      tags: [jobTag(job.id), 'manual'],
      ...(planned.inPlace ? {} : { owner: unit }),
      ...(input.model !== undefined ? { model: input.model } : {}),
    });

    const ts = now();
    let p = recordOutput(await host.readState(), {
      asset: stored,
      unit,
      stage: job.stage,
      job: job.id,
      provider: MANUAL_PROVIDER_ID,
      ts,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });

    const warnings: string[] = [];
    if (input.actual !== undefined && input.actual > 0) {
      if (p.budget) {
        p = recordDone(p, {
          provider: MANUAL_PROVIDER_ID,
          unit,
          actual: input.actual,
          ts,
          prefix: `${job.id}.${unit}.manual`,
          ...(input.model !== undefined ? { model: input.model } : {}),
        });
      } else {
        warnings.push(`The ${input.actual} you reported was not recorded: ${SETUP_POINTER}`);
      }
    }

    p = assertValidProject(p);
    await host.writeState(p);
    const asset = p.assets.find((a) => a.id === stored.id);
    if (!asset) throw new ManualIngestError(`asset "${stored.id}" did not land in akuko.json`);
    return { asset, warnings };
  }

  return { provider, ingest };
}
