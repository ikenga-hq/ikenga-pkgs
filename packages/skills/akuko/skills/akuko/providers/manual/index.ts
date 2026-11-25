/**
 * Manual provider — the no-key path for every stage.
 *
 * Implements the provider contract by handing the work to a person:
 *   estimate  0 (priced from config.json like any provider: the `manual` entry's default model)
 *   submit    builds a prompt package and returns it as the handle's `handoff`
 *   ingest    takes the file the person brings back, stores it via
 *             host.storeAsset() and records it in akuko.json (asset added,
 *             unit → pending-review, any spend they report → ledger).
 *             A planned asset that a person sent back (`needs-rework`) and
 *             still holds its old file takes the new file in place: the old
 *             file stays stored, a "Revised:" comment says where. One that
 *             has a file and was not sent back is refused (or, with
 *             `newTake`, gets a separate take). Ingest never leaves a stray
 *             `<unit>-<stage>` asset beside a sent-back unit.
 *             With `via: <service>` the file was made by a connected
 *             allowance tool (Canva): it is accepted only when the ledger has
 *             a done allowance entry of that service for the unit, which is
 *             linked to the job, and the asset is recorded as the service's
 *             (rules/refs.ts §3b)
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
import { MANUAL_PROVIDER_ID, MANUAL_SEAL, SETUP_POINTER, sealProvider } from '../../spend/gate.ts';
import { recordDone } from '../../spend/ledger.ts';
import { allowanceEntryFor, linkAllowance } from '../../spend/allowance.ts';
import { AllowanceServiceSchema } from '../../schema/akuko-project.ts';
import { externalRefs } from '../../rules/allowance.ts';
import { REFS_EXTERNAL_TAG, allowanceTag, sha256Bytes } from '../../rules/refs.ts';
import type { ManualPlatform, PromptPackage } from './package.ts';
import { ACCEPT, EXT_BY_MIME, buildPromptPackage, expectedFilename, renderPromptPackage } from './package.ts';

export { MANUAL_PROVIDER_ID };

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
  /**
   * The connected allowance tool that made the file (`canva`). The ledger must already hold a done allowance entry of
   * that service for the unit (recorded after the person approved the wave); it is linked to this job, and the asset
   * is recorded with the service as its provider, so the rules count it as generated.
   */
  via?: string;
  /** Folder relative ref uris are read from, to check the job's refs (with `via`). */
  projectDir?: string;
  /**
   * Store the file as a new take beside an asset unit that already has a file (`<unit>-<stage>`, `-2`…). Without it,
   * an ingest for an asset that already has a file and was not sent back is refused (`planAssetId` `filled: 'refuse'`),
   * and one that was sent back (`needs-rework`) takes the new file in place (its old file stays stored).
   * The separate take is its own review unit: the stage waits for a person to decide on it too.
   */
  newTake?: boolean;
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
    { config, manual: MANUAL_SEAL },
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
    // A planned asset the person sent back that still holds its old file (they ingest without running step again,
    // or into the job that made the old take): the new file replaces it in place, as the stage's own redo would.
    // Before this, it became a separate `<unit>-<stage>` asset that waited for review and held the stage open while
    // the unit kept its old file. The old file is never deleted; the "Revised:" comment says where it stays.
    const replacing = !input.newTake && ref.kind === 'asset' && ref.unit.file !== undefined && ref.unit.status === 'needs-rework'
      ? ref.unit.file.uri
      : undefined;
    let planned: { id: string; inPlace: boolean };
    if (replacing !== undefined) {
      planned = { id: unit, inPlace: true };
    } else {
      try {
        planned = planAssetId(before, unit, job.stage, { filled: input.newTake ? 'sibling' : 'refuse' });
      } catch (err) {
        throw new ManualIngestError(err instanceof Error ? err.message : String(err));
      }
    }

    // --via <service>: the generation must already be in the ledger (lib/spend.md §Allowance).
    const via = input.via;
    let viaEntry = -1;
    let viaTags: string[] = [];
    if (via !== undefined) {
      if (!AllowanceServiceSchema.safeParse(via).success || via === MANUAL_PROVIDER_ID) throw new ManualIngestError(`--via takes a connected service id such as "canva", not "${via}"`);
      viaEntry = allowanceEntryFor(before, via, [unit, planned.id], job.id);
      if (viaEntry === -1) {
        throw new ManualIngestError(`no done ${via} allowance entry for ${unit} in the ledger that is free for job ${job.id}: record the generation first (spend/cli.ts allowance --service ${via} --units ${unit} --job ${job.id}), or ingest without --via (the file then counts as external)`);
      }
      const ext = await externalRefs(before, item.refs ?? [], { ...(input.projectDir !== undefined ? { projectDir: input.projectDir } : {}) });
      viaTags = [allowanceTag(via), ...(ext.length ? [REFS_EXTERNAL_TAG] : [])];
    }
    const kind = planned.inPlace && ref.kind === 'asset' ? ref.unit.kind : item.output;
    const ext = EXT_BY_MIME[file.mime] ?? file.filename.split('.').pop() ?? 'bin';

    // A replacement never reuses the old file's name, so no host can write over the old take.
    const taken = new Set(before.assets.map((a) => a.file?.uri.split('/').pop()).filter((n): n is string => n !== undefined));
    let filename = expectedFilename(unit, job.stage, ext);
    if (replacing !== undefined) {
      for (let n = 2; taken.has(filename); n++) filename = `${unit}-${job.stage}-${n}.${ext}`;
    }

    const stored = await host.storeAsset({
      kind,
      filename,
      mime: file.mime,
      data: file.data,
      id: planned.id,
      provider: via ?? MANUAL_PROVIDER_ID,
      tags: [jobTag(job.id), 'manual', ...viaTags],
      ...(planned.inPlace ? {} : { owner: unit }),
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    // The rules check a generated file's bytes against a sha256 (rules/refs.ts §4): record one when the host did not.
    const sha = sha256Bytes(file.data);
    const withHash = via !== undefined && stored.file && stored.file.hash !== sha ? { ...stored, file: { ...stored.file, hash: sha } } : stored;

    const ts = now();
    let current = await host.readState();
    if (replacing !== undefined) {
      current = {
        ...current,
        assets: current.assets.map((a) => (a.id === unit
          ? { ...a, comments: [...a.comments, { ts, stage: job.stage, author: 'agent', text: `Revised: replaced by a file brought back after the requested changes; the previous take stays at ${replacing}` }] }
          : a)),
      };
    }
    let p = recordOutput(current, {
      asset: withHash,
      unit,
      stage: job.stage,
      job: job.id,
      provider: via ?? MANUAL_PROVIDER_ID,
      ts,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });

    if (via !== undefined) p = linkAllowance(p, viaEntry, job.id);

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
