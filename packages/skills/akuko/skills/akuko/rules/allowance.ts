/**
 * akuko — files made with a connected allowance tool (Canva on claude.ai)
 * count as generated (rules/refs.ts §3b).
 *
 * Such a file comes back by hand, like a manual take, but the generation that
 * made it is in the ledger: `recordAllowance()` (or `spend/cli.ts allowance`)
 * wrote one entry per unit after the person approved the wave. `ingest --via
 * <service>` links that entry to the job (`allowance.job`) and records the file
 * as the service's; `adoptAllowance()` does the same, once, for files ingested
 * before `--via` existed.
 *
 * A never-from-photo entry trusts such a file only when its job sent no
 * reference that akuko did not generate (`externalRefs()`); otherwise the
 * asset carries `refs:external` and `check.ts` refuses it there.
 */

import type { JobRef } from '../providers/contract.ts';
import { jobTag } from '../providers/outputs.ts';
import type { AkukoProject, Asset } from '../schema/akuko-project.ts';
import { allowanceEntryFor, linkAllowance } from '../spend/allowance.ts';
import { MANUAL_PROVIDER, REFS_EXTERNAL_TAG, allowanceTag, classifyRef, hashUri, newHashCache, type RefContext } from './refs.ts';

const SHA256 = /^[0-9a-f]{64}$/;
const JOB_TAG = jobTag('');

/**
 * The refs of a job item that are not files akuko generated (as the project
 * stands now): anything `classifyRef` does not call `generated`, except a ref
 * with no file at all and a shot's layout that still matches its sha256. An allowed external file still counts: it is external.
 */
export async function externalRefs(p: AkukoProject, refs: readonly Pick<JobRef, 'id' | 'uri'>[], ctx: RefContext): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    const o = await classifyRef(p, ref, ctx);
    // A shot's layout whose bytes still match its recorded sha256 is trusted as a generated file is (refs.ts §A shot's layout).
    const layoutOk = (o.kind === 'layout' && o.actual === o.expected)
      || (o.kind === 'layout-step' && o.generated && o.actual !== undefined && (o.expected === undefined || o.actual === o.expected));
    if (o.kind !== 'generated' && o.kind !== 'no-file' && !layoutOk) out.push(ref.id);
  }
  return out;
}

/** The job tags on an asset (`job:<id>`), as job ids. */
export const jobsOf = (a: Asset): string[] => a.tags.filter((t) => t.startsWith(JOB_TAG)).map((t) => t.slice(JOB_TAG.length));

export interface AdoptChange {
  asset: string;
  job: string;
  /** The ledger entry linked to the job. */
  ledger: string;
  /** Refs of the job item that were not generated; the asset is then tagged `refs:external`. */
  externalRefs: string[];
  /** Why the refs could not be checked (no saved job, no item for the unit): treated as external. */
  refsUnknown?: string;
  /** sha256 recorded now (the asset had none). */
  hashed?: boolean;
}

export interface AdoptSkip { asset: string; reason: string }

/** A saved job's items, as far as adoption needs them. */
export interface SavedJobItems { items: { unit: string; refs?: Pick<JobRef, 'id' | 'uri'>[] }[] }

/**
 * Switch every ingested manual file that a done allowance entry of `service`
 * made to a generated file of that service: provider = service, tags
 * `allowance:<service>` (and `refs:external` when its job's refs for it were
 * not all generated), sha256 in `file.hash`, the ledger entry linked to the
 * job. Files are taken in the order their generations were recorded, so a
 * lookbook adopted first counts as generated when a later portrait's refs are
 * checked. Pure apart from reading files to hash them; returns a new project.
 */
export async function adoptAllowance(
  p0: AkukoProject,
  service: string,
  opts: { projectDir?: string; job: (id: string) => SavedJobItems | undefined },
): Promise<{ project: AkukoProject; changes: AdoptChange[]; skipped: AdoptSkip[] }> {
  let p = structuredClone(p0);
  const changes: AdoptChange[] = [];
  const skipped: AdoptSkip[] = [];
  const ctx: RefContext = { ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}), cache: newHashCache() };
  const firstGen = (a: Asset): number => {
    const ts = p.ledger.filter((e) => e.status === 'done' && e.allowance?.service === service && (e.unit === a.id || e.unit === a.owner)).map((e) => Date.parse(e.ts));
    return ts.length ? Math.min(...ts) : Infinity;
  };
  const candidates = p.assets
    .filter((a) => a.provider === MANUAL_PROVIDER && a.file !== undefined && jobsOf(a).length > 0)
    .map((a, i) => ({ id: a.id, at: firstGen(a), i }))
    .filter((x) => x.at !== Infinity)
    .sort((x, y) => x.at - y.at || x.i - y.i);

  for (const { id } of candidates) {
    const a = p.assets.find((x) => x.id === id)!;
    const units = [a.id, ...(a.owner !== undefined ? [a.owner] : [])];
    let job: string | undefined;
    let index = -1;
    for (const j of jobsOf(a)) {
      index = allowanceEntryFor(p, service, units, j);
      if (index !== -1) { job = j; break; }
    }
    if (job === undefined || index === -1) { skipped.push({ asset: a.id, reason: `every ${service} allowance entry for it is already linked to another job` }); continue; }

    const uri = a.file!.uri;
    const h = await hashUri(uri, opts.projectDir, ctx.cache);
    if (!h.ok) { skipped.push({ asset: a.id, reason: `its file ${uri} can't be hashed (${h.reason})` }); continue; }
    const recorded = a.file!.hash;
    if (recorded !== undefined && SHA256.test(recorded) && recorded !== h.sha256) {
      skipped.push({ asset: a.id, reason: `its file ${uri} changed since it was ingested (sha256 ${h.sha256.slice(0, 12)}…, recorded ${recorded.slice(0, 12)}…)` });
      continue;
    }

    const saved = opts.job(job);
    const item = saved?.items.find((x) => x.unit === a.id || x.unit === a.owner);
    let ext: string[] = [];
    let refsUnknown: string | undefined;
    if (!saved) refsUnknown = `no saved job ${job}`;
    else if (!item) refsUnknown = `job ${job} has no item for ${a.id}`;
    else ext = await externalRefs(p, item.refs ?? [], ctx);

    const tags = [...new Set([...a.tags, allowanceTag(service), ...(ext.length || refsUnknown ? [REFS_EXTERNAL_TAG] : [])])];
    const hashed = !(recorded !== undefined && SHA256.test(recorded));
    const next: Asset = { ...a, provider: service, tags, file: { ...a.file!, hash: h.sha256 } };
    p = { ...linkAllowance(p, index, job), assets: p.assets.map((x) => (x.id === a.id ? next : x)) };
    changes.push({ asset: a.id, job, ledger: p.ledger[index]!.id ?? `ledger[${index}]`, externalRefs: ext, ...(refsUnknown ? { refsUnknown } : {}), ...(hashed ? { hashed } : {}) });
  }
  return { project: p, changes, skipped };
}
