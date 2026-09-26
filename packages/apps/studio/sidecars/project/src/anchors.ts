/**
 * anchor.* RPC implementations (WP-03b).
 *
 * Storage choice: anchors live as the project-level `Project.anchors[]`
 * array inside `storyboard.json` (per schema — `ProjectSchema.anchors`).
 * The schema ships an `anchors/` directory in the project skeleton too, but
 * that is reserved for anchor *payload* files; the canonical anchor records
 * are the in-document array, so list/create/delete mutate `Project.anchors`
 * and persist atomically (tmp+rename) through `writeProjectAtomic`. The FS
 * watcher emits `cells/changed` on the storyboard.json rename.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { AnchorSchema, type Project } from '@ikenga/studio-schema';

import { readProject, writeProjectAtomic } from './storyboard-fs.js';
import { importAsset } from './assets.js';
import { generateStill } from './renderers/fal.js';
import {
  reserve as reserveSpend,
  settle as settleSpend,
  voidEntry as voidSpend,
  type SpendDb,
} from './spend.js';

export interface AnchorResult {
  result: Record<string, unknown>;
  project?: Project;
}

export function list(projectRoot: string): AnchorResult {
  const project = readProject(projectRoot);
  return { result: { ok: true, anchors: project.anchors } };
}

export function create(projectRoot: string, anchorInput: unknown): AnchorResult {
  const parsed = AnchorSchema.safeParse(anchorInput);
  if (!parsed.success) {
    return { result: { ok: false, error: 'invalid-args', message: parsed.error.message } };
  }
  const anchor = parsed.data;
  const project = readProject(projectRoot);
  if (project.anchors.some((a) => a.id === anchor.id)) {
    return { result: { ok: false, error: 'anchor-already-exists', message: anchor.id } };
  }
  const next = writeProjectAtomic(projectRoot, {
    ...project,
    anchors: [...project.anchors, anchor],
  });
  return { result: { ok: true, anchor }, project: next };
}

/**
 * Input for `anchor.generate` (Stage 3 — reference plate generation).
 * `kind` is the anchor-plate subset (character/location/style/image) — the
 * other AnchorSchema kinds (video/audio/sketch) are not fal-still targets.
 */
export interface AnchorGenerateInput {
  kind: 'character' | 'location' | 'style' | 'image';
  name: string;
  prompt: string;
  seed?: number;
  model?: string;
  /**
   * WP-12 — the spend ledger + the project id it bills against.
   *
   * Optional so `generate()` stays callable in tests and tooling without a DB,
   * but the RPC handler ALWAYS supplies it: this is the second paid door in
   * the system, and the one the Round-3 experiments actually spent $6.30
   * through. A `generate()` call with no `spend` is ungated — do not add a
   * caller that omits it.
   */
  spend?: { db: SpendDb; projectId: string; projectMetadata?: Record<string, unknown> };
}

/**
 * Generate a reference plate via fal and store it as a project anchor.
 *
 * Flow: run `generateStill()` (key resolved from `process.env.FAL_KEY`) into a
 * temp file, import that file into the project's `assets/images/` dir via the
 * shared `importAsset()` helper (atomic copy + mime guess + project-relative
 * id), then mint an Anchor referencing the imported asset. The generation seed
 * (and fal model / cost) land in `Anchor.metadata` so the plate can be re-run
 * deterministically for character/location/style locking.
 */
export async function generate(
  projectRoot: string,
  input: AnchorGenerateInput,
): Promise<AnchorResult> {
  if (!input || typeof input.name !== 'string' || input.name.trim().length === 0) {
    return { result: { ok: false, error: 'invalid-args', message: 'name is required' } };
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    return { result: { ok: false, error: 'invalid-args', message: 'prompt is required' } };
  }

  const id = randomUUID();

  // 0) WP-12 — the spend gate, BEFORE the network call.
  //
  // `anchor.generate` bills fal for a still and never inserts a render_queue
  // row, so a gate that lived only on the queue would miss it entirely. It is
  // also the cheapest call in the system per invocation and therefore the
  // easiest to run a hundred times without noticing — which is exactly what
  // happened during Round 3. Reserve first, settle or void after.
  let spendEntryId: string | undefined;
  if (input.spend) {
    const reservation = reserveSpend(input.spend.db, {
      projectId: input.spend.projectId,
      refId: id,
      kind: 'still',
      engine: 'fal',
      model_id: input.model,
      projectMetadata: input.spend.projectMetadata,
    });
    if (!reservation.ok) {
      // Terminal, and not overridable from a tool call — same rule as the
      // render gate. The message names the human remedies.
      return {
        result: {
          ok: false,
          error: reservation.error,
          message: reservation.message,
          spend: {
            estimate_usd: reservation.estimate_usd,
            basis: reservation.basis,
            ceiling_usd: reservation.ceiling_usd,
            ceiling_source: reservation.ceiling_source,
            committed_usd: reservation.committed_usd,
            remaining_usd: reservation.remaining_usd,
          },
        },
      };
    }
    spendEntryId = reservation.entryId;
  }

  // 1) Generate the still to a temp file (fal downloads the produced image).
  const tmpDir = join(tmpdir(), 'ikenga-studio-anchor');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `${id}.png`);

  let still: { uri: string; model_id: string; cost?: number };
  try {
    still = await generateStill(
      {
        prompt: input.prompt,
        model: input.model,
        seed: input.seed,
        // Key via env for headless / stdio-driven runs (no vault here).
        keyGetter: async () => process.env.FAL_KEY,
      },
      tmpPath,
    );
  } catch (e) {
    // The call never produced an image, so it gives its reservation back.
    if (input.spend && spendEntryId) voidSpend(input.spend.db, spendEntryId);
    return { result: { ok: false, error: 'internal-error', message: (e as Error).message } };
  }

  // fal billed the moment it returned an image — settle now, before the local
  // import, so a downstream filesystem failure can't void a reservation for
  // money that has already left the account. `still.cost` is usually undefined
  // (fal rarely reports one), in which case the entry settles at its estimate.
  if (input.spend && spendEntryId) settleSpend(input.spend.db, spendEntryId, still.cost);

  // 2) Import the still into assets/images/ (reuses the shared importer).
  const imported = await importAsset(projectRoot, still.uri, 'image');
  try {
    rmSync(tmpPath, { force: true });
  } catch {
    // best-effort temp cleanup — the imported copy is what matters
  }
  if (!imported.result.ok) {
    return { result: imported.result };
  }
  const asset = imported.result.asset as { id: string; uri: string; mime?: string };

  // 3) Mint the Anchor referencing the imported asset (create() re-validates,
  //    checks id collision, and persists atomically).
  const anchorInput = {
    id,
    name: input.name,
    kind: input.kind,
    asset: { uri: asset.uri, mime: asset.mime },
    tags: [] as string[],
    metadata: {
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
      prompt: input.prompt,
      model_id: still.model_id,
      ...(typeof still.cost === 'number' ? { cost: still.cost } : {}),
    } as Record<string, unknown>,
  };
  return create(projectRoot, anchorInput);
}

export function remove(projectRoot: string, anchorId: string): AnchorResult {
  const project = readProject(projectRoot);
  const idx = project.anchors.findIndex((a) => a.id === anchorId);
  if (idx < 0) {
    return { result: { ok: false, error: 'anchor-not-found', message: anchorId } };
  }
  const next = writeProjectAtomic(projectRoot, {
    ...project,
    anchors: project.anchors.filter((a) => a.id !== anchorId),
  });
  return { result: { ok: true, anchorId }, project: next };
}
