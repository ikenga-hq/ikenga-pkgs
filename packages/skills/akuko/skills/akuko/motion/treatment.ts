/**
 * akuko — shot treatments (WP-27): what each shot gets, defined once.
 *
 * A shot's `treatment` decides its motion. Paid treatments are opt-in: a shot
 * with no `treatment` gets the default for its tier, and only a person makes a
 * shot `video` or `lipsync` (the `treat` command, on their words).
 *
 *   tier A  → still-move   (a hero candidate: flagged, never made paid by default)
 *   tier B  → still-move
 *   tier C  → still
 *   no tier → undefined    (today's behaviour: every shot gets a `<shot>_clip`)
 *
 * WP-30 (`setup/estimate.ts`) keeps a local copy of this table pinned by a test.
 */

import type { AkukoProject, Shot, ShotTier, ShotTreatment } from '../schema/akuko-project.ts';

/** The default treatment per tier. A shot with no tier has no default (see `treatmentOf`). */
export const DEFAULT_TREATMENT: Readonly<Record<ShotTier, ShotTreatment>> = {
  A: 'still-move',
  B: 'still-move',
  C: 'still',
};

/** The treatment a shot gets: its own, else its tier's default, else `undefined` (legacy: a clip per shot). */
export function treatmentOf(shot: Pick<Shot, 'treatment' | 'tier'>): ShotTreatment | undefined {
  if (shot.treatment !== undefined) return shot.treatment;
  return shot.tier === undefined ? undefined : DEFAULT_TREATMENT[shot.tier];
}

/** Does this shot get a paid `<shot>_clip` unit: an explicit `video`, or no tier and no treatment (today's behaviour). */
export function wantsClip(shot: Pick<Shot, 'treatment' | 'tier'>): boolean {
  const t = treatmentOf(shot);
  return t === undefined || t === 'video';
}

/** Does this shot get a free camera move on its still. */
export function wantsMove(shot: Pick<Shot, 'treatment' | 'tier'>): boolean {
  return treatmentOf(shot) === 'still-move';
}

/** A tier-A shot: a candidate for a generated clip. Only flagged; the person decides. */
export function isHeroCandidate(shot: Pick<Shot, 'tier'>): boolean {
  return shot.tier === 'A';
}

/** A tier-A shot with a spoken line: a candidate for lip-sync. Only flagged; the person decides. Thought lines need nothing. */
export function isLipsyncCandidate(shot: Pick<Shot, 'tier' | 'lines'>, _project?: AkukoProject): boolean {
  return shot.tier === 'A' && (shot.lines ?? []).some((l) => l.kind === 'spoken');
}
