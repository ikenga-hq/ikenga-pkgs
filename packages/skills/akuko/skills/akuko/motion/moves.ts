/**
 * akuko — camera moves on a still (WP-27): parse a sheet's `motion_note` into a `move`.
 *
 * The note is free text ("Slow push-in; falling snow particles"). Only its first
 * clause (before `;` or `,`) is read, because the rest describes the picture, not
 * the camera. The defaults are gentle on purpose (the house motion rule is slow
 * moves only), and every scale stays at or above 1 so a drift never shows the edge
 * of the frame: a lateral drift of 40 px needs 40 px of spare picture, and a
 * scale of 1.06 on a 1920 px frame gives 57 px each side.
 *
 *   Slow push-in     scale 1.00 → 1.08, no drift
 *   Slow pull-back   scale 1.08 → 1.00, no drift
 *   Lateral drift    scale 1.06 → 1.06, x +40 px (left: −40 px)
 *   Hold             no move
 *   anything else    no move, with a warning
 *
 * Eases are `ease-in-out` (slow in, slow out). Nothing here is paid or calls a provider.
 */

import type { Shot, StillMove } from '../schema/akuko-project.ts';

export const PUSH: StillMove = { from_scale: 1, to_scale: 1.08, x: 0, y: 0, ease: 'ease-in-out' };
export const PULL: StillMove = { from_scale: 1.08, to_scale: 1, x: 0, y: 0, ease: 'ease-in-out' };
export const DRIFT_PX = 40;
export const DRIFT_SCALE = 1.06;

export interface ParsedMove {
  /** The move to record; `undefined` = no move. */
  move?: StillMove;
  /** Which rule matched: `push-in`, `pull-back`, `drift`, `hold`, or `unknown`. */
  kind: 'push-in' | 'pull-back' | 'drift' | 'hold' | 'unknown';
  warning?: string;
}

/** Parse one motion note. Pure. */
export function parseMotionNote(note: string | undefined): ParsedMove {
  const text = (note ?? '').trim();
  if (text === '') return { kind: 'hold' };
  const head = (text.split(/[;,]/)[0] ?? '').toLowerCase();
  if (/\bwhip\b|\bsnap\b|\bcrash\b/.test(head)) return { kind: 'unknown', warning: `"${text}": fast moves are not made as still moves (house rule: slow moves only); no move recorded.` };
  if (/^\s*(static|hold|locked|still|no move)\b/.test(head)) return { kind: 'hold' };
  if (/\b(push|dolly in|zoom in|move in|creep in)\b/.test(head)) return { kind: 'push-in', move: { ...PUSH } };
  if (/\b(pull|dolly out|zoom out|move out|back out)\b/.test(head)) return { kind: 'pull-back', move: { ...PULL } };
  if (/\b(drift|lateral|truck|slide|pan)\b/.test(head)) {
    const left = /\bleft\b/.test(head);
    return { kind: 'drift', move: { from_scale: DRIFT_SCALE, to_scale: DRIFT_SCALE, x: left ? -DRIFT_PX : DRIFT_PX, y: 0, ease: 'ease-in-out' } };
  }
  return { kind: 'unknown', warning: `"${text}": not a camera move akuko knows (push-in, pull-back, lateral drift, hold); no move recorded.` };
}

export interface MoveRow {
  shot: string;
  note: string;
  kind: ParsedMove['kind'];
  move: StillMove | undefined;
  /** The shot already has a move; `--apply` leaves it alone. */
  has_move: boolean;
  warning?: string;
}

/** One row per shot in `shots` (callers pass the still-move shots), parsed from its note. */
export function planMoves(shots: Shot[]): MoveRow[] {
  return shots.map((s) => {
    const parsed = parseMotionNote(s.motion_note);
    return {
      shot: s.id,
      note: s.motion_note ?? '',
      kind: parsed.kind,
      move: parsed.move,
      has_move: s.move !== undefined,
      ...(parsed.warning ? { warning: parsed.warning } : {}),
    };
  });
}

/** Write the parsed moves onto shots that have no move yet and whose note parsed to one. Never replaces a move. */
export function applyMoves(rows: MoveRow[], project: { shots: Shot[] }): { applied: string[] } {
  const applied: string[] = [];
  for (const r of rows) {
    if (r.has_move || r.move === undefined) continue;
    const s = project.shots.find((x) => x.id === r.shot);
    if (!s || s.move !== undefined) continue;
    s.move = { ...r.move };
    applied.push(r.shot);
  }
  return { applied };
}
