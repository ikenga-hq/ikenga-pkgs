/**
 * akuko — motion prompts (WP-10).
 *
 * The prompt is built from the shot's own fields (camera, camera move, action,
 * the director's note) and states that the approved key frame is the start of
 * the clip. It knows no model, price or provider, and it never invents action:
 * a shot with no written action gets "only small natural movement".
 */

import type { Shot } from '../schema/akuko-project.ts';

export interface MotionContext {
  shot: Shot;
  /** Seconds the clip will run (after any change to what the model can make). */
  seconds: number;
  /** Whether native sound was asked for. Default off. */
  audio: boolean;
}

const NOTHING = '(not specified)';
const bare = (t: string | undefined): string => (t ?? '').trim().replace(/[.\s]+$/, '');

/** The prompt for one clip. `asked` is what a person last asked to change, if anything. */
export function motionPrompt(c: MotionContext, asked = ''): string {
  const s = c.shot;
  const move = s.camera_move === 'unset' ? 'none given, hold the frame steady' : s.camera_move;
  const lines = [
    `Animate the start frame into a ${c.seconds} second shot of a film. The first frame is the attached approved key frame: keep every character's face, hair and clothing, the place and the look exactly as in it. One continuous shot, no cuts, no text, no captions.`,
    `Action: ${bare(s.action) || 'not written; only small natural movement (breathing, cloth, light, drifting fog), nothing new happens'}.`,
    `Camera: ${bare(s.camera) || NOTHING}. Camera move: ${move}.`,
  ];
  if (s.prompt?.trim()) lines.push(`Director's note: ${bare(s.prompt)}.`);
  lines.push(c.audio ? 'Sound: natural ambient sound that fits the scene; no music, no dialogue unless written above.' : 'Sound: none (the clip is silent; sound is made in its own stage).');
  if (asked) lines.push(`Changes the person asked for: ${asked}`);
  return lines.join('\n');
}
