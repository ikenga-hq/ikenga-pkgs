/**
 * akuko — record a shot's treatment (WP-27). Free, and the person's choice: the agent
 * runs it only on the person's words. It writes `shot.treatment` and nothing paid.
 *
 * Nothing is ever deleted. Moving a shot away from `video` keeps its planned clip, whatever state it is in
 * (a file, a ledger entry, a pending spend, a person's comment) and marks it idle: it is never made while
 * the shot is not `video`, and does not hold the stage back. If the shot goes back to `video`, `plan` reuses it.
 */

import type { AkukoProject, ShotTreatment } from '../schema/akuko-project.ts';
import { removedAt } from '../decisions/fold.ts';
import { MotionError, assetIdFor } from './plan.ts';

export interface TreatResult { project: AkukoProject; changed: string[]; unchanged: string[]; warnings: string[] }

export function treatShots(project: AkukoProject, ids: string[], as: ShotTreatment): TreatResult {
  if (ids.length === 0) throw new MotionError('Name at least one shot: --shot <id>[,<id>...].');
  const p = structuredClone(project);
  const changed: string[] = [];
  const unchanged: string[] = [];
  const warnings: string[] = [];
  for (const id of ids) {
    const shot = p.shots.find((s) => s.id === id);
    if (!shot) throw new MotionError(`"${id}" is not a shot in this project.`);
    if (removedAt(p, shot) !== undefined) throw new MotionError(`"${id}" was removed from the shot list; it takes no treatment.`);
    if (shot.treatment === as) { unchanged.push(id); continue; }
    shot.treatment = as;
    changed.push(id);
    if (as !== 'video') {
      const clipId = assetIdFor(id);
      const clip = p.assets.find((a) => a.id === clipId);
      if (clip) {
        const made = clip.file !== undefined || (clip.status !== 'pending' && clip.status !== 'draft') || p.ledger.some((e) => e.unit === clipId);
        if (made) {
          warnings.push(`${id}: its clip ${clipId} (${clip.status}${clip.file ? ', has a file' : ''}) is kept; it was made or paid for, so nothing is deleted. The shot is now "${as}"; the handoff still places a clip that exists.`);
        } else {
          warnings.push(`${id}: planned clip ${clipId} kept, idle while the shot is ${as}.`);
        }
      }
    }
    if (as === 'lipsync' && !(shot.lines ?? []).some((l) => l.kind === 'spoken')) {
      warnings.push(`${id}: no spoken line is linked to this shot, so lip-sync will have nothing to do.`);
    }
  }
  return { project: p, changed, unchanged, warnings };
}
