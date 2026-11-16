/**
 * akuko — a shot's layout picture (actions/keyframes.md §Layout from a 3D blockout).
 *
 * A layout is a plain render of a 3D blockout of the place from the shot's
 * camera. The key frame uses it in its mode (keyframes/plan.ts `layoutModeOf`:
 * attach it first, the default; or two-step,
 * `layoutStepPlan`: restyle it alone, then each character on model) so the image
 * model keeps the camera, the composition and where every object and figure
 * is, and takes each character from their image.
 *
 *   setLayout()    store a render through the host and record it on the shot (uri + sha256)
 *   clearLayout()  remove the shot's layout (the stored file stays where it is)
 *
 * The file is the agent's own (made by a script in the project), not a
 * person's upload and not a generation: it is not added to `rules.uploads.allow`
 * and not to `assets[]`. Its record on the shot is its provenance; the rules
 * guard sends it only while the bytes still hash to that sha256 (rules/refs.ts).
 *
 * Neither function moves a status. A key frame made from an earlier layout is
 * reported by `status` as made from a superseded `<shot>_layout`, the way a
 * replaced bible image is; only a person sends it back.
 */

import { createHash } from 'node:crypto';
import type { HostAdapter } from '../hosts/types.ts';
import type { AkukoProject, ShotLayout } from '../schema/akuko-project.ts';
import type { LayoutMode } from './plan.ts';
import { removedAt } from '../decisions/fold.ts';
import { KeyframeError, assetIdFor, layoutState } from './plan.ts';

export type LayoutHost = Pick<HostAdapter, 'readState' | 'writeState' | 'storeAsset'>;

export interface LayoutFile { filename: string; data: Uint8Array }

export interface LayoutResult {
  project: AkukoProject;
  /** False when the shot already had this exact file as its layout (nothing stored or written). */
  changed: boolean;
  layout?: ShotLayout;
  previous?: ShotLayout;
  /** The shot's key frame, when it has a take that is now made from an earlier layout (or none). */
  staleTake?: string;
}

/** What an image's first bytes say it is: png, jpeg or webp, which every image provider accepts as a reference. */
export function imageMime(d: Uint8Array): string | undefined {
  if (d.length >= 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'image/png';
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'image/jpeg';
  if (d.length >= 12 && String.fromCharCode(...d.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...d.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

function liveShot(p: AkukoProject, id: string) {
  const shot = p.shots.find((s) => s.id === id);
  if (!shot) throw new KeyframeError(`"${id}" is not a shot id.`);
  if (removedAt(p, shot) !== undefined) throw new KeyframeError(`${id} has left the shot list; it gets no key frame, so no layout.`);
  return shot;
}

const staleTakeOf = (p: AkukoProject, shotId: string): string | undefined => {
  const a = p.assets.find((x) => x.id === assetIdFor(shotId));
  if (!a) return undefined;
  const s = layoutState(p, a);
  return s === 'changed' || s === 'not-used' ? a.id : undefined;
};

/** Store `file` through the host and make it the shot's layout. Writes the project. */
export async function setLayout(host: LayoutHost, shotId: string, file: LayoutFile, o: { now: string; from?: string }): Promise<LayoutResult> {
  const mime = imageMime(file.data);
  if (!mime) throw new KeyframeError(`${file.filename} is not a PNG, JPEG or WebP image (by its content); a layout must be one the image providers accept.`);
  const sha256 = createHash('sha256').update(file.data).digest('hex');
  const before = await host.readState();
  const cur = liveShot(before, shotId);
  if (cur.layout?.sha256 === sha256) return { project: before, changed: false, layout: cur.layout };

  const stored = await host.storeAsset({ kind: 'other', filename: `${shotId}_layout${EXT[mime]}`, mime, data: file.data, owner: shotId, name: `${shotId} layout`, tags: ['layout'] });
  if (!stored.file) throw new KeyframeError(`the host stored ${shotId}'s layout but returned no file reference`);
  if (stored.file.hash !== undefined && stored.file.hash !== sha256) throw new KeyframeError(`the host stored ${shotId}'s layout with a different hash (${stored.file.hash.slice(0, 12)}…); nothing was recorded`);

  const p = structuredClone(before);
  const shot = liveShot(p, shotId);
  const previous = shot.layout;
  // A new render keeps the mode the shot had chosen.
  const layout: ShotLayout = { uri: stored.file.uri, sha256, mime, ...(o.from ? { from: o.from } : {}), set_at: o.now, ...(cur.layout?.mode ? { mode: cur.layout.mode } : {}) };
  shot.layout = layout;
  await host.writeState(p);
  const staleTake = staleTakeOf(p, shotId);
  return { project: p, changed: true, layout, ...(previous ? { previous } : {}), ...(staleTake ? { staleTake } : {}) };
}

/** Set (or with `undefined`, clear back to attach) how the shot's key frame uses its layout by default. Writes the project. */
export async function setLayoutMode(host: LayoutHost, shotId: string, mode: LayoutMode | undefined): Promise<LayoutResult> {
  const before = await host.readState();
  const cur = liveShot(before, shotId);
  if (!cur.layout) throw new KeyframeError(`${shotId} has no layout; set one with --file first.`);
  if (cur.layout.mode === mode) return { project: before, changed: false, layout: cur.layout };
  const p = structuredClone(before);
  const shot = liveShot(p, shotId);
  if (mode === undefined) delete shot.layout!.mode; else shot.layout!.mode = mode;
  await host.writeState(p);
  return { project: p, changed: true, layout: shot.layout! };
}

/** Remove the shot's layout. The stored file is left where it is. Writes the project. */
export async function clearLayout(host: LayoutHost, shotId: string): Promise<LayoutResult> {
  const before = await host.readState();
  const cur = liveShot(before, shotId);
  if (!cur.layout) return { project: before, changed: false };
  const p = structuredClone(before);
  const shot = liveShot(p, shotId);
  const previous = shot.layout!;
  delete shot.layout;
  await host.writeState(p);
  const staleTake = staleTakeOf(p, shotId);
  return { project: p, changed: true, previous, ...(staleTake ? { staleTake } : {}) };
}
