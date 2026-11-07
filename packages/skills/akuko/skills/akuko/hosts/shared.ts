/**
 * akuko — helpers shared by the host adapters: where an asset belongs in the
 * project folder, how its id is derived, and how the returned `Asset` record
 * is built. No I/O here.
 */

import { AssetSchema, ID_PATTERN, type Asset, type AssetKind, type StageId } from '../schema/akuko-project.ts';
import type { AssetInput } from './types.ts';

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

/** Thrown by every `readDecisions` until WP-07a lands `decisions/<store>.ts`. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
}

export function decisionsNotImplemented(level: keyof typeof DECISION_STORE): never {
  throw new NotImplementedError(`akuko: readDecisions not implemented — WP-07a (${DECISION_STORE[level]})`);
}
