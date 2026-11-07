/**
 * Recording a provider's output in `akuko.json`.
 *
 * Shared by the manual provider's ingest and the gate's `collect()`, so a file
 * lands the same way whoever made it:
 *   - the asset is upserted by id (hosts may or may not add it to state in
 *     `storeAsset()`; both work);
 *   - the unit it belongs to moves to the job's stage as `pending-review`,
 *     with the file as that stage's output. Never `approved`: only a person
 *     approves (schema design rule).
 * Recording the same file twice changes nothing, so a person's approval is
 * never undone by a second `collect()`.
 */

import type {
  AkukoProject,
  Asset,
  AssetRef,
  BibleEntry,
  Shot,
  StageId,
  Unit,
} from '../schema/akuko-project.ts';
import { AkukoProjectSchema, findUnit } from '../schema/akuko-project.ts';

export class OutputError extends Error {
  override name = 'OutputError';
}

/** Tag every output carries so a job's files can be found again: `job:<id>`. */
export const jobTag = (jobId: string): string => `job:${jobId}`;

/**
 * The asset id an output should be stored under. An asset unit that has no
 * file yet (a planned portrait, plate…) is filled in place; anything else
 * gets a new asset `<unit>-<stage>`, then `-2`, `-3`… when taken.
 */
export function planAssetId(p: AkukoProject, unit: string, stage: StageId): { id: string; inPlace: boolean } {
  const ref = findUnit(p, unit);
  if (!ref) throw new OutputError(`unknown unit "${unit}"`);
  if (ref.kind === 'asset' && !ref.unit.file) return { id: unit, inPlace: true };
  const taken = new Set(p.assets.map((a) => a.id));
  const base = `${unit}-${stage}`;
  if (!taken.has(base)) return { id: base, inPlace: false };
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return { id: `${base}-${n}`, inPlace: false };
}

/** Move a unit to `stage` as pending-review with `file` as that stage's output. */
function markProduced<U extends Unit>(u: U, stage: StageId, file: AssetRef | undefined, ts: string): U {
  const byStage = { ...(u.by_stage ?? {}) };
  if (u.stage !== stage && byStage[u.stage] === undefined) byStage[u.stage] = { status: u.status };
  byStage[stage] = { status: 'pending-review', ...(file ? { output: file } : {}) };
  return { ...u, stage, status: 'pending-review', by_stage: byStage, updated_at: ts };
}

/** True when `u` already shows `file` as its output for `stage`. */
const alreadyShows = (u: Unit, stage: StageId, file: AssetRef | undefined): boolean =>
  file !== undefined && u.by_stage?.[stage]?.output?.uri === file.uri;

function updateUnit(p: AkukoProject, id: string, fn: <U extends Unit>(u: U) => U): AkukoProject {
  const map = <U extends Unit>(list: U[]): U[] => list.map((u) => (u.id === id ? fn(u) : u));
  return {
    ...p,
    shots: map<Shot>(p.shots),
    bible: {
      characters: map<BibleEntry>(p.bible.characters),
      locations: map<BibleEntry>(p.bible.locations),
      styles: map<BibleEntry>(p.bible.styles),
    },
    assets: map<Asset>(p.assets),
  };
}

export interface RecordOutputArgs {
  asset: Asset;          // what host.storeAsset() returned
  unit: string;          // unit the output belongs to
  stage: StageId;
  job: string;
  provider: string;
  model?: string;
  ts: string;
}

/** Upsert one output asset and move its unit to pending-review. Pure. */
export function recordOutput(p: AkukoProject, a: RecordOutputArgs): AkukoProject {
  if (!findUnit(p, a.unit) && a.asset.id !== a.unit) throw new OutputError(`unknown unit "${a.unit}"`);
  const file = a.asset.file;
  const tags = [...new Set([...(a.asset.tags ?? []), jobTag(a.job)])];
  const existing = p.assets.find((x) => x.id === a.asset.id);
  const inPlace = a.asset.id === a.unit;

  let next: AkukoProject;
  if (existing) {
    const fileChanged = existing.file?.uri !== file?.uri;
    const merged: Asset = {
      ...existing,
      ...(file ? { file } : {}),
      tags: [...new Set([...existing.tags, ...tags])],
      provider: a.provider,
      ...(a.model !== undefined ? { model: a.model } : {}),
      ...(inPlace ? {} : { owner: a.unit }),
    };
    const asset = fileChanged ? markProduced(merged, a.stage, file, a.ts) : merged;
    next = { ...p, assets: p.assets.map((x) => (x.id === asset.id ? asset : x)) };
  } else {
    const asset: Asset = {
      id: a.asset.id,
      kind: a.asset.kind,
      stage: a.stage,
      status: 'pending-review',            // never what the host said: only people approve
      comments: [],
      owner: a.unit,
      tags,
      provider: a.provider,
      updated_at: a.ts,
      ...(a.asset.name !== undefined ? { name: a.asset.name } : {}),
      ...(file ? { file } : {}),
      ...(a.model !== undefined ? { model: a.model } : a.asset.model !== undefined ? { model: a.asset.model } : {}),
    };
    next = { ...p, assets: [...p.assets, asset] };
  }

  if (!inPlace) {
    const ref = findUnit(next, a.unit);
    if (ref && !alreadyShows(ref.unit, a.stage, file)) {
      next = updateUnit(next, a.unit, (u) => markProduced(u, a.stage, file, a.ts));
    }
  }
  return next;
}

/** Schema-check a project before it is written; throws with the first issue. */
export function assertValidProject(p: AkukoProject): AkukoProject {
  const r = AkukoProjectSchema.safeParse(p);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new OutputError(`project would be invalid: ${first ? `${first.path.join('.')}: ${first.message}` : r.error.message}`);
  }
  return r.data;
}
