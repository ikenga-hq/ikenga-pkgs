/**
 * akuko — helpers shared by the host adapters: where an asset belongs in the
 * project folder, how its id is derived, and how the returned `Asset` record
 * is built; and the publishView gate (the caller reads the conformed
 * lists). No I/O here.
 */

import { fileURLToPath } from 'node:url';
import { CONFORMED_FORMAT, isConformedHtml, type ConformedFile } from '../decisions/conformed.ts';
import { decisionWriteSigns, viewIdOf as manifestViewId } from '../scripts/check-view/predicates.mjs';
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

/**
 * Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`,
 * `LPT0`–`LPT9`), reserved whatever the extension and the case: `aux.svg`
 * and `Con.tar.gz` open the device, not a file, in most Windows programs.
 */
const DOS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A safe basename: no directories, no characters outside `[A-Za-z0-9._-]`,
 * no trailing dots (Windows drops them, so the file on disk would not match
 * its uri), and no Windows device name as its stem (`con.png` → `con_.png`;
 * Wave 3 review, finding 6). Works the same on every OS, so a project made on
 * one opens on another.
 */
export function safeBasename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/\.+$/, '');
  if (cleaned.length === 0) return 'asset';
  const dot = cleaned.indexOf('.');
  const stem = dot < 0 ? cleaned : cleaned.slice(0, dot);
  return DOS_DEVICE.test(stem) ? `${stem}_${cleaned.slice(stem.length)}` : cleaned;
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

/** The `<id>@<version>` a view's akuko-view manifest declares (one real block; comments ignored), or undefined. */
export const viewIdOf = (html: string): string | undefined => manifestViewId(html);

/**
 * Does this view write decisions? The predicate check-view uses too
 * (scripts/check-view/predicates.mjs): a `data-akuko-action` control (or
 * `dataset.akukoAction`), the decision writer, the outbox key, an Ikenga
 * state post, a write to the decisions collection, a manifest saying
 * `writes_decisions: true` — or the caller saying so. Reading decisions is
 * not writing them. Comments never count.
 */
export function viewWritesDecisions(v: Pick<ViewArtifact, 'html' | 'writesDecisions'>): boolean {
  return v.writesDecisions === true || decisionWriteSigns(v.html).length > 0;
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
