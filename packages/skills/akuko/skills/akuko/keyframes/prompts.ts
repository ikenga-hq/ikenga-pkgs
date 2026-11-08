/**
 * akuko — key-frame prompts (WP-22).
 *
 * The prompt is built from the shot's own fields (shot type, camera, move,
 * action, blocking), the scene heading, the bible entries in frame and the
 * film's written look. It knows no model, price or provider.
 *
 * Composition comes in as text. The sketch panel is an SVG framing diagram and
 * neither image provider accepts SVG as a reference (WP-06 allows png, jpeg,
 * webp, gif), so `blockingText()` turns the shot's blocking boxes into
 * sentences ("Mara: left third, lower half, large") and no sketch file is attached.
 */

import type { BibleEntry, Blocking, Shot } from '../schema/akuko-project.ts';

export interface KeyframeContext {
  shot: Shot;
  aspect: string;
  /** Scene heading and summary, already joined. */
  scene: string;
  /** The film's written look (style entries). */
  look: string;
  /** Characters in frame that have a reference image attached, in reference order. */
  characters: BibleEntry[];
  location: BibleEntry | undefined;
}

const NOTHING = '(not specified)';

const third = (v: number, names: [string, string, string]): string => (v < 1 / 3 ? names[0] : v < 2 / 3 ? names[1] : names[2]);

/** One sentence per blocking box: where it sits in the frame and how large it is. Deterministic. */
export function blockingText(blocking: Blocking[]): string {
  if (blocking.length === 0) return 'No blocking was set; compose the frame from the action.';
  return blocking.map((b) => {
    const cx = b.shape === 'ellipse' ? b.x : b.x + b.w / 2;
    const cy = b.shape === 'ellipse' ? b.y : b.y + b.h / 2;
    const size = Math.max(b.w, b.h);
    const big = size >= 0.5 ? 'large' : size >= 0.25 ? 'medium' : 'small';
    const who = b.who.trim() === '' ? 'an unlabelled element' : b.who.trim();
    return `${who}: ${third(cx, ['left', 'centre', 'right'])} third, ${third(cy, ['upper', 'middle', 'lower'])} third, ${big}`;
  }).join('; ');
}

/** The prompt for one key frame. `asked` is what a person last asked to change, if anything. */
export function keyframePrompt(c: KeyframeContext, asked = ''): string {
  const s = c.shot;
  const type = s.shot_type === 'unset' ? NOTHING : s.shot_type;
  const move = s.camera_move === 'unset' ? 'none given' : s.camera_move;
  const lines = [
    `Final key frame for a film, ${c.aspect}. One still image: the single most telling moment of the shot, not a collage, no text, no captions, no labels, no borders.`,
    `Shot ${s.id}: ${type}. Camera: ${s.camera?.trim() || NOTHING}. Camera move (for context only, the image is still): ${move}.`,
    `Scene: ${c.scene.trim() || NOTHING}.`,
    `Action in frame: ${s.action?.trim() || NOTHING}.`,
    `Composition, from the approved sketch board (thirds grid): ${blockingText(s.blocking)}.`,
  ];
  if (c.characters.length > 0) {
    lines.push(`Characters (each must match the attached reference of the same name exactly): ${c.characters.map((e) => `${e.name}${e.description ? ` - ${e.description}` : ''}`).join('; ')}.`);
  }
  if (c.location) lines.push(`Location (match the attached plate): ${c.location.name}${c.location.description ? ` - ${c.location.description}` : ''}.`);
  lines.push(`Look (match the attached lookbook): ${c.look.trim() || NOTHING}.`);
  if (s.prompt?.trim()) lines.push(`Director's note: ${s.prompt.trim()}`);
  if (asked) lines.push(`Changes the person asked for: ${asked}`);
  return lines.join('\n');
}
