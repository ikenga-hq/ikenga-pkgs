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
 *   no tier → undefined    (today's behaviour: every shot gets a `<shot>_clip`) for a HAND-MADE project;
 *             but a shot imported from a sheet (`source.kind === 'sheet'`) with a missing or unreadable tier
 *             is `still`: never a paid clip by accident. Only an explicit `treatment` makes it video.
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
export function treatmentOf(shot: Pick<Shot, 'treatment' | 'tier'> & { source?: { kind?: string } | undefined }): ShotTreatment | undefined {
  if (shot.treatment !== undefined) return shot.treatment;
  const byTier = shot.tier === undefined ? undefined : (DEFAULT_TREATMENT as Partial<Record<string, ShotTreatment>>)[shot.tier];
  if (byTier !== undefined) return byTier;
  return shot.source?.kind === 'sheet' ? 'still' : undefined;
}

/** An imported (sheet) shot with no usable tier and no treatment: treated as `still`, so the person should hear about it. */
export function isUntieredImport(shot: Pick<Shot, 'treatment' | 'tier'> & { source?: { kind?: string } | undefined }): boolean {
  return shot.source?.kind === 'sheet' && shot.treatment === undefined && (shot.tier === undefined || !(shot.tier in DEFAULT_TREATMENT));
}

/** One line per shot that is a hero or lip-sync candidate and has not been chosen yet. Flags only: the person decides. */
export function candidateFlags(p: AkukoProject, live: (s: Shot) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const s of p.shots) {
    if (!live(s)) continue;
    const t = treatmentOf(s);
    const lip = isLipsyncCandidate(s, p) && t !== 'lipsync';
    const hero = isHeroCandidate(s) && t !== 'video' && t !== 'lipsync';
    if (!lip && !hero) continue;
    out.push(`${s.id}: tier A${lip ? ', spoken line, a lip-sync candidate' : ', a hero candidate'}; the person decides`);
  }
  return out;
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
