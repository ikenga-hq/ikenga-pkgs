/**
 * akuko — record a shot's treatment (WP-27). Free, and the person's choice: the agent
 * runs it only on the person's words. It writes `shot.treatment` and nothing paid.
 *
 * Moving a shot away from `video` never deletes anything that was made or paid for:
 * a clip with a file, a status past `pending`, or any ledger entry stays, with a warning.
 * Only an empty planned clip (never started, never paid) is dropped, because it is only a plan.
 */

import type { AkukoProject, ShotTreatment } from '../schema/akuko-project.ts';
import { removedAt } from '../decisions/fold.ts';
import { MotionError, assetIdFor } from './plan.ts';
import { treatmentOf } from './treatment.ts';

export interface TreatResult { project: AkukoProject; changed: string[]; unchanged: string[]; warnings: string[]; dropped: string[] }

export function treatShots(project: AkukoProject, ids: string[], as: ShotTreatment): TreatResult {
  if (ids.length === 0) throw new MotionError('Name at least one shot: --shot <id>[,<id>...].');
  const p = structuredClone(project);
  const changed: string[] = [];
  const unchanged: string[] = [];
  const warnings: string[] = [];
  const dropped: string[] = [];
  for (const id of ids) {
    const shot = p.shots.find((s) => s.id === id);
    if (!shot) throw new MotionError(`"${id}" is not a shot in this project.`);
    if (removedAt(p, shot) !== undefined) throw new MotionError(`"${id}" was removed from the shot list; it takes no treatment.`);
    if (shot.treatment === as) { unchanged.push(id); continue; }
    const wasVideo = (treatmentOf(shot) === undefined || treatmentOf(shot) === 'video') && as !== 'video';
    shot.treatment = as;
    changed.push(id);
    if (wasVideo) {
      const clipId = assetIdFor(id);
      const clip = p.assets.find((a) => a.id === clipId);
      if (clip) {
        const made = clip.file !== undefined || (clip.status !== 'pending' && clip.status !== 'draft') || p.ledger.some((e) => e.unit === clipId);
        if (made) {
          warnings.push(`${id}: its clip ${clipId} (${clip.status}${clip.file ? ', has a file' : ''}) is kept; it was made or paid for, so nothing is deleted. The shot is now "${as}"; the handoff still places a clip that exists.`);
        } else {
          p.assets = p.assets.filter((a) => a.id !== clipId);
          dropped.push(clipId);
        }
      }
    }
    if (as === 'lipsync' && !(shot.lines ?? []).some((l) => l.kind === 'spoken')) {
      warnings.push(`${id}: no spoken line is linked to this shot, so lip-sync will have nothing to do.`);
    }
  }
  return { project: p, changed, unchanged, warnings, dropped };
}
