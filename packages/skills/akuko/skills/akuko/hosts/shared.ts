/**
 * akuko — helpers shared by the host adapters: where an asset belongs in the
 * project folder, how its id is derived, and how the returned `Asset` record
 * is built; and the publishView gate (the caller reads the conformed
 * lists). No I/O here.
 */

import { fileURLToPath } from 'node:url';
import { CONFORMED_FORMAT, isConformedHtml, type ConformedFile } from '../decisions/conformed.ts';
import { AssetSchema, ID_PATTERN, type Asset, type AssetKind, type StageId } from '../schema/akuko-project.ts';
import type { AssetInput, ViewArtifact } from './types.ts';

/** The stage that produces each asset kind (sets `Asset.stage`). */
export const STAGE_FOR_KIND: Record<AssetKind, StageId> = {
  reference: 'intake',
  sheet: 'bible',
  portrait: 'bible',
  turnaround: 'bible',
  plate: 'bible',
  lookbook: 'bible',
  panel: 'sketch',
  keyframe: 'keyframes',
  clip: 'motion',
  scene: 'motion',
  vo: 'sound',
  music: 'sound',
  sfx: 'sound',
  timeline: 'assemble',
  export: 'export',
  other: 'intake',
};

/**
 * Folder (relative to the project, POSIX separators) an asset is written to,
 * following the project layout in 01 §Phases (Phase 1, item 1).
 */
export function assetDir(a: Pick<AssetInput, 'kind' | 'owner'>): string {
  const owner = a.owner && ID_PATTERN.test(a.owner) ? a.owner : undefined;
  switch (a.kind) {
    case 'sheet':
    case 'portrait':
    case 'turnaround':
      return owner ? `bible/characters/${owner}/refs` : 'bible/characters/refs';
    case 'plate':
      return owner ? `bible/locations/${owner}/refs` : 'bible/locations/refs';
    case 'lookbook':
      return 'bible/style';
    case 'panel':
    case 'keyframe':
      return 'board/panels';
    case 'clip':
      return owner ? `motion/${owner}` : 'motion';
    case 'scene':
      return owner ? `motion/scenes/${owner}` : 'motion/scenes';
    case 'vo':
      return 'audio/vo';
    case 'music':
      return 'audio/music';
    case 'sfx':
      return 'audio/sfx';
    case 'timeline':
      return 'cut';
    case 'export':
      return 'cut/exports';
    case 'reference':
    case 'other':
      return 'refs';
  }
}

/** A safe basename: no directories, no characters outside `[A-Za-z0-9._-]`. */
export function safeBasename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return cleaned.length > 0 ? cleaned : 'asset';
}

/** Asset id from the input id, else from the filename stem. Always matches `ID_PATTERN`. */
export function assetId(a: Pick<AssetInput, 'id' | 'filename'>): string {
  if (a.id !== undefined) {
    if (!ID_PATTERN.test(a.id)) throw new Error(`akuko: invalid asset id "${a.id}"`);
    return a.id;
  }
  const stem = safeBasename(a.filename).replace(/\.[^.]*$/, '');
  const id = stem.replace(/^[^A-Za-z0-9]+/, '');
  return id.length > 0 ? id : 'asset';
}

/**
 * The `Asset` record for stored bytes. Status is `pending-review`: something
 * now exists and waits for a person (only people write `approved`). The
 * adapter does NOT add it to `akuko.json` — the caller appends it to
 * `project.assets` and calls `writeState`.
 */
export function buildAsset(
  a: AssetInput,
  file: { uri: string; hash?: string },
  id: string,
  now: Date,
): Asset {
  return AssetSchema.parse({
    id,
    stage: STAGE_FOR_KIND[a.kind],
    status: 'pending-review',
    comments: [],
    kind: a.kind,
    ...(a.owner !== undefined && { owner: a.owner }),
    ...(a.name !== undefined && { name: a.name }),
    file: { uri: file.uri, mime: a.mime, ...(file.hash !== undefined && { hash: file.hash }) },
    tags: a.tags ?? [],
    ...(a.provider !== undefined && { provider: a.provider }),
    ...(a.model !== undefined && { model: a.model }),
    updated_at: now.toISOString(),
  });
}

/** Which decisions store each host delegates to (WP-07a owns `decisions/**`). */
export const DECISION_STORE = {
  A: 'decisions/artifact-db.ts',
  B: 'decisions/jsonl.ts',
  C: 'decisions/ikenga.ts',
} as const;

// ─────────────────────────────────────────────────────────────────────────
// publishView gate (R-12 / C8): a view that writes decisions is published
// only when its exact HTML is on a conformed-views list.
// ─────────────────────────────────────────────────────────────────────────

/** The skill's own conformed list (views it ships, e.g. the default board). A missing file is an empty list. */
export const SHIPPED_CONFORMED = fileURLToPath(new URL('../views/conformed.json', import.meta.url));

/** The `<id>@<version>` a view's akuko-view manifest declares (what its decisions carry as `view`), or undefined. */
export function viewIdOf(html: string): string | undefined {
  const m = /<script\b[^>]*\bid=["']akuko-view["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[1] ?? '') as { id?: unknown; version?: unknown };
    return typeof v.id === 'string' && typeof v.version === 'string' ? `${v.id}@${v.version}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does this view write decisions? Any `data-akuko-action` control (in markup or
 * built by its scripts), the inlined decision writer, a manifest saying
 * `writes_decisions: true`, or the caller saying so. Anything else is read-only.
 */
export function viewWritesDecisions(v: Pick<ViewArtifact, 'html' | 'writesDecisions'>): boolean {
  const live = v.html.replace(/<!--[\s\S]*?-->/g, ''); // a comment naming a control is not one (as check-view)
  return v.writesDecisions === true
    || /data-akuko-action/i.test(live)
    || /akuko-decision-writer|akukoDecisions/.test(live)
    // writing a store directly: the Ikenga state key, or the artifact DB's decisions collection
    || /akuko\.decisions|collection\(\s*["'`]decisions["'`]/.test(live)
    || /"writes_decisions"\s*:\s*true/.test(live);
}

/**
 * Refuse to publish a view that writes decisions unless this exact HTML is
 * on one of the conformed lists (`decisions/conformed.ts#isConformedHtml`).
 * `lists` is read only when the view writes decisions, so a read-only view
 * never depends on a list. Throws an Error naming the view and the fix.
 */
export async function assertPublishable(
  v: Pick<ViewArtifact, 'name' | 'html' | 'writesDecisions'>,
  lists: () => ConformedFile[] | Promise<ConformedFile[]>,
): Promise<void> {
  if (!viewWritesDecisions(v)) return;
  const id = viewIdOf(v.html);
  if (id === undefined) {
    throw new Error(`akuko: refusing to publish view "${v.name}": it writes decisions but has no akuko-view manifest (views/contract.md §2). Add one, then run node scripts/check-view.mjs <view.html> --record <project>/views/conformed.json`);
  }
  const all = await lists();
  const merged: ConformedFile = { format: CONFORMED_FORMAT, version: 1, views: all.flatMap((l) => l.views) };
  if (!isConformedHtml(merged, id, v.html)) {
    throw new Error(`akuko: refusing to publish view ${id} ("${v.name}"): it writes decisions, and this exact HTML is not on a conformed-views list. Run node scripts/check-view.mjs <view.html> --record <project>/views/conformed.json (on claude.ai, record the entry in the akuko/conformed doc), then publish the same HTML. A changed page needs a new "version" and a new check.`);
  }
}
