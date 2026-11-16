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
 *
 * A shot with a layout is made in steps (keyframes/plan.ts `layoutStepPlan`):
 * `restylePrompt()` turns the blockout render, its only picture, into the
 * finished frame from words alone; `identityPrompt()` then edits that result
 * with one character's image. Tested in E01: with the layout beside other
 * pictures of the place or the finished frame, the model copied those and
 * ignored the blockout; alone, it followed the blockout.
 */

import type { BibleEntry, Blocking, Shot } from '../schema/akuko-project.ts';
import { lookNotes } from '../bible/plan.ts';

export interface KeyframeContext {
  shot: Shot;
  aspect: string;
  /** Scene heading and summary, already joined. */
  scene: string;
  /** The shot's style entries (its lighting look and the house style; every style when it names none). */
  styles?: BibleEntry[];
  /** True when a lookbook image is attached (only with a location plate; see `neededRefs`). */
  lookbook?: boolean;
  /** True when the shot's layout (a 3D-blockout render) is attached first (layout mode attach). */
  layout?: boolean;
  /** The shot whose approved key frame is attached as this shot's source frame. */
  source?: string;
  /** Characters in frame that have a reference image attached, in reference order. */
  characters: BibleEntry[];
  location: BibleEntry | undefined;
  /** Characters named by the shot that have no reference image (Background); described in text only. */
  unreferenced?: BibleEntry[];
}

const NOTHING = '(not specified)';

/** Text without its closing full stop, so the sentence it ends can add one. */
const bare = (t: string | undefined): string => (t ?? '').trim().replace(/[.\s]+$/, '');

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

const flat = (t: string | undefined): string => bare(t).toLowerCase().replace(/\s+/g, ' ');

/**
 * The Look line's text: each of the shot's styles once. A style whose wording
 * the director's note already holds (an imported sheet writes the lighting
 * phrase and the house style into every shot's prompt) is named, not repeated.
 */
export function lookLine(styles: BibleEntry[], note: string | undefined): string {
  const said = flat(note);
  return styles.map((e) => {
    const desc = bare(e.description);
    const inNote = desc !== '' && said.includes(flat(desc));
    const head = desc === '' ? e.name : inNote ? `${e.name} (worded in the director's note)` : `${e.name}: ${desc}`;
    return [head, ...lookNotes(e).map(bare)].join('. ');
  }).join(' | ');
}

/** The prompt for one key frame. `asked` is what a person last asked to change, if anything. */
export function keyframePrompt(c: KeyframeContext, asked = ''): string {
  const s = c.shot;
  const type = s.shot_type === 'unset' ? NOTHING : s.shot_type;
  const move = s.camera_move === 'unset' ? 'none given' : s.camera_move;
  const lines = [
    `Final key frame for a film, ${c.aspect}. One still image: the single most telling moment of the shot, not a collage, no text, no captions, no labels, no borders.`,
    `Shot ${s.id}: ${type}. Camera: ${bare(s.camera) || NOTHING}. Camera move (for context only, the image is still): ${move}.`,
    `Scene: ${bare(c.scene) || NOTHING}.`,
    `Action in frame: ${bare(s.action) || NOTHING}.`,
  ];
  if (c.layout) {
    lines.push('Layout (attached blockout render): keep the camera angle, the composition and the position and size of every object and figure exactly as in this picture; it is a plain untextured 3D blockout, so take no colour, material, lighting or style from it. The grey or blue box figures are stand-ins: replace each with the named character.');
    lines.push(`Who is where, from the approved sketch board (thirds grid; the layout wins where they differ): ${blockingText(s.blocking)}.`);
  } else {
    lines.push(`Composition, from the approved sketch board (thirds grid): ${blockingText(s.blocking)}.`);
  }
  if (c.characters.length > 0) {
    lines.push(`Characters (each must match the attached reference of the same name exactly): ${c.characters.map((e) => `${e.name}${e.description ? ` - ${bare(e.description)}` : ''}`).join('; ')}.`);
  }
  if (c.unreferenced && c.unreferenced.length > 0) {
    lines.push(`Also in frame, with no reference image (draw from this text only, keep them unobtrusive): ${c.unreferenced.map((e) => `${e.name}${e.description ? ` - ${bare(e.description)}` : ''}`).join('; ')}.`);
  }
  if (c.location) {
    const how = c.layout ? 'the attached plate is for the look of the place only: surfaces, materials, colour and light; where things are comes from the layout' : 'match the attached plate';
    lines.push(`Location (${how}): ${c.location.name}${c.location.description ? ` - ${bare(c.location.description)}` : ''}.`);
  }
  if (c.source) lines.push(`Source frame (attached): the approved key frame of shot ${c.source}. This shot shows that same picture; change only what the action says.`);
  const look = bare(lookLine(c.styles ?? [], s.prompt)) || NOTHING;
  lines.push(c.lookbook
    ? `Look (the attached lookbook is for light and colour only; do not copy its room, objects or people): ${look}.`
    : `Look (no lookbook attached; from this text only): ${look}.`);
  if (s.prompt?.trim()) lines.push(`Director's note: ${bare(s.prompt)}.`);
  if (asked) lines.push(`Changes the person asked for: ${asked}`);
  return lines.join('\n');
}

const described = (e: BibleEntry): string => `${e.name}${e.description ? ` - ${bare(e.description)}` : ''}`;

/**
 * Step 1 of a key frame made from its layout: the layout is the only picture.
 * Keep everything where it is and change only the surfaces; what each shape
 * is, and the look, come in words (no turnaround, plate, lookbook or source
 * frame is attached).
 */
export function restylePrompt(c: KeyframeContext, asked = ''): string {
  const s = c.shot;
  const type = s.shot_type === 'unset' ? NOTHING : s.shot_type;
  const people = [...c.characters, ...(c.unreferenced ?? [])];
  const lines = [
    `Restyle this plain 3D blockout render into the finished key frame for a film, ${c.aspect}. Keep the camera, the composition and the position and size of every wall, object and figure exactly as they are; change only materials, light and style; add nothing and move nothing. One still image, no text, no captions, no labels, no borders.`,
    `Shot ${s.id}: ${type}. Camera: ${bare(s.camera) || NOTHING}.`,
    `Scene: ${bare(c.scene) || NOTHING}.`,
    `What the shapes are. Action in frame: ${bare(s.action) || NOTHING}.`,
  ];
  if (s.blocking.length > 0) lines.push(`Who is where (from the sketch board, thirds grid; the blockout wins where they differ): ${blockingText(s.blocking)}.`);
  if (people.length > 0) lines.push(`The grey or blue box figures are: ${people.map(described).join('; ')}.`);
  if (c.location) lines.push(`The place: ${described(c.location)}.`);
  lines.push(`Look (from this text only): ${bare(lookLine(c.styles ?? [], s.prompt)) || NOTHING}.`);
  if (s.prompt?.trim()) lines.push(`Director's note: ${bare(s.prompt)}.`);
  if (asked) lines.push(`Changes the person asked for: ${asked}`);
  return lines.join('\n');
}

export interface IdentityContext {
  shot: Shot;
  /** The character this step puts on model. */
  name: string;
  /** Which image of them is attached. */
  image: 'turnaround' | 'portrait';
  /** True when they are the only character put on model in this frame. */
  alone: boolean;
  asked?: string;
}

/**
 * A later step of a key frame made from its layout: an edit of the step
 * before (attached first) with one character's image (attached second).
 * Everything stays; only that figure changes, and the image is for identity only.
 */
export function identityPrompt(c: IdentityContext): string {
  const where = c.shot.blocking.filter((b) => b.who.trim() !== '' && b.who.toLowerCase().includes(c.name.toLowerCase()));
  const who = c.alone ? `the figure that is ${c.name}` : `${c.name}${where.length ? ` (${blockingText(where).replace(/^[^:]*: /, '')})` : ''}`;
  const sheet = c.image === 'turnaround' ? 'the character on the attached sheet' : 'the character in the attached portrait';
  const only = c.image === 'turnaround' ? 'use the sheet for identity only, not its layout, background, labels or multiple views' : 'use the portrait for identity only, not its background, framing or light';
  const lines = [
    `Edit the first attached picture. Keep everything in it exactly: the camera, the composition, the place, the light, the style and every other figure. Change only ${who} so they are ${sheet}: their face, hair, build and clothing; ${only}. ${c.name} appears once.`,
  ];
  if (c.asked) lines.push(`Changes the person asked for: ${c.asked}`);
  return lines.join('\n');
}
