/**
 * akuko — stage 2 (sketch): framing-diagram panels. Free and deterministic.
 *
 * A panel is a storyboard *framing diagram*, not a drawing: the frame, a thirds
 * grid, labelled boxes for whatever the shot's blocking places in it, the shot
 * type, a camera-move arrow when the shot has one, the camera note and the
 * duration. There are no figures and no faces. It is plain SVG built from data:
 * the same shot gives the same bytes, nothing is fetched, nothing is paid for.
 *
 * Review unit: the SHOT at stage `sketch` (`lib/state.md` §2). The panel file
 * is stored with `storeAsset` and linked from `shot.by_stage.sketch.output`; it
 * is deliberately not added to `assets[]`, because a second unit per panel
 * would need its own approval and the stage could never reach `approved` from
 * the shot decisions the boards write.
 *
 * Blocking is never invented here. A shot with none still gets a panel (grid,
 * camera note, "no blocking") and lint warns. `applyBlocking` is the one way
 * blocking enters the project, from a proposal the agent wrote out of what the
 * script says.
 */

import { createHash } from 'node:crypto';
import {
  BlockingSchema,
  type AkukoProject,
  type AssetRef,
  type Blocking,
  type Shot,
} from '../schema/akuko-project.ts';
import type { HostAdapter } from '../hosts/types.ts';

export type AspectRatio = AkukoProject['project']['aspect_ratio'];

/** What a panel needs from a shot. */
export type PanelShot = Pick<Shot, 'id' | 'shot_type' | 'camera_move' | 'blocking'> & Partial<Pick<Shot, 'camera' | 'duration_s'>>;

// ── escaping and numbers ────────────────────────────────────────────────

/**
 * Drop what XML 1.0 forbids: C0 controls except tab/newline/return, lone
 * surrogates (a JSON � escape produces one), U+FFFE and U+FFFF. Such a
 * character in a script name would make the stored .svg unparseable.
 */
export function xmlSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const ok = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || cp >= 0x10000;
    if (ok) out += ch;
  }
  return out;
}

/** Escape text for SVG/HTML text and attribute values. Every label from a script goes through this. */
export function esc(s: string): string {
  return xmlSafe(s).replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

/** At most two decimals, no trailing zeros, never `-0`. */
const num = (x: number): string => String(Math.round(x * 100) / 100 || 0);

export function clip(s: string, max: number): string {
  const chars = [...xmlSafe(s).replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

// ── geometry ────────────────────────────────────────────────────────────

/** viewBox size per aspect ratio. The long side is 160 units. */
export function panelSize(aspect: AspectRatio = '16:9'): { W: number; H: number } {
  return aspect === '9:16' ? { W: 90, H: 160 } : aspect === '1:1' ? { W: 120, H: 120 } : { W: 160, H: 90 };
}

const MOVE_LABEL: Record<string, string> = {
  static: 'STATIC', pan: 'PAN', tilt: 'TILT', dolly: 'DOLLY', truck: 'TRUCK', crane: 'CRANE', handheld: 'HANDHELD',
  'zoom-in': 'ZOOM IN', 'zoom-out': 'ZOOM OUT', orbit: 'ORBIT', 'push-in': 'PUSH IN', 'pull-out': 'PULL OUT', 'whip-pan': 'WHIP PAN',
};

/** Moves that get an arrow. `static` and `unset` get none. */
export const ARROW_MOVES = ['pan', 'tilt', 'dolly', 'truck', 'crane', 'handheld', 'zoom-in', 'zoom-out', 'orbit', 'push-in', 'pull-out', 'whip-pan'] as const;

function arrow(x1: number, y1: number, x2: number, y2: number, fromX = x1, fromY = y1): string {
  const a = Math.atan2(y2 - fromY, x2 - fromX);
  const h = 4.2;
  const p1 = `${num(x2 - h * Math.cos(a - 0.5))},${num(y2 - h * Math.sin(a - 0.5))}`;
  const p2 = `${num(x2 - h * Math.cos(a + 0.5))},${num(y2 - h * Math.sin(a + 0.5))}`;
  return `<line class="pa" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"/><polygon class="pah" points="${num(x2)},${num(y2)} ${p1} ${p2}"/>`;
}

/** The arrow (and any extra marks) for a camera move, in frame units. Empty for `static` and `unset`. */
function moveMarks(move: string, W: number, H: number): string {
  const u = (f: number) => f * W;
  const v = (f: number) => f * H;
  const inner = `<rect class="pm" x="${num(u(0.275))}" y="${num(v(0.275))}" width="${num(u(0.45))}" height="${num(v(0.45))}"/>`;
  const corners = (inward: boolean): string => {
    const near: Array<[number, number]> = [[0.056, 0.078], [0.944, 0.078], [0.056, 0.922], [0.944, 0.922]];
    const far: Array<[number, number]> = [[0.237, 0.222], [0.763, 0.222], [0.237, 0.778], [0.763, 0.778]];
    return near.map(([nx, ny], i) => {
      const [fx, fy] = far[i]!;
      return inward ? arrow(u(nx), v(ny), u(fx), v(fy)) : arrow(u(fx), v(fy), u(nx), v(ny));
    }).join('');
  };
  switch (move) {
    case 'dolly':
    case 'push-in':
    case 'zoom-in':
      return inner + corners(true);
    case 'pull-out':
    case 'zoom-out':
      return inner + corners(false);
    case 'pan':
      return arrow(u(0.2), v(0.15), u(0.8), v(0.15));
    case 'truck':
      return arrow(u(0.2), v(0.8), u(0.8), v(0.8));
    case 'tilt':
      return arrow(u(0.92), v(0.78), u(0.92), v(0.22));
    case 'crane':
      return arrow(u(0.08), v(0.8), u(0.08), v(0.2)) + `<line class="pa" x1="${num(u(0.08))}" y1="${num(v(0.8))}" x2="${num(u(0.15))}" y2="${num(v(0.8))}"/>`;
    case 'whip-pan':
      return arrow(u(0.16), v(0.15), u(0.84), v(0.15)) + `<line class="pa" x1="${num(u(0.29))}" y1="${num(v(0.1))}" x2="${num(u(0.65))}" y2="${num(v(0.1))}"/><line class="pa" x1="${num(u(0.29))}" y1="${num(v(0.2))}" x2="${num(u(0.65))}" y2="${num(v(0.2))}"/>`;
    case 'handheld': {
      const y = v(0.15);
      const pts = [0.2, 0.27, 0.34, 0.41, 0.48, 0.55, 0.62, 0.69].map((f, i) => `${num(u(f))},${num(y + (i % 2 === 0 ? -1.6 : 1.6))}`);
      return `<polyline class="pa" fill="none" points="${pts.join(' ')}"/>` + arrow(u(0.69), y, u(0.8), y);
    }
    case 'orbit': {
      const x1 = u(0.2), y1 = v(0.2), x2 = u(0.8), y2 = v(0.2), cx = u(0.5), cy = v(0.02);
      return `<path class="pa" d="M${num(x1)} ${num(y1)}Q${num(cx)} ${num(cy)} ${num(x2)} ${num(y2)}"/>` + arrow(x2, y2, x2, y2, cx, cy).replace(/<line[^>]*\/>/, '');
    }
    default:
      return '';
  }
}

// ── the panel ───────────────────────────────────────────────────────────

/**
 * Palette: opaque fills, so a panel is legible on a light or a dark page, in an
 * `<img>`, or in a viewer that ignores media queries. The dark block only
 * deepens the same panel for dark surfaces.
 */
const STYLE = [
  '.pf{fill:#f1ece2;stroke:#5c564d;stroke-width:1}',
  '.pg{fill:none;stroke:#7d766b;stroke-width:.45;stroke-dasharray:1.4 1.8}',
  '.ps{fill:none;stroke:#7d766b;stroke-width:.4}',
  '.pb{fill:#fffdf8;stroke:#3d3830;stroke-width:.9}',
  '.pt{font:600 7px ui-sans-serif,system-ui,sans-serif;fill:#1d1a15}',
  '.pk{font:700 7px ui-sans-serif,system-ui,sans-serif;letter-spacing:.5px;fill:#4a443b}',
  '.pd{font:500 6.5px ui-monospace,Menlo,Consolas,monospace;fill:#4a443b}',
  '.pm{fill:none;stroke:#1d1a15;stroke-width:.8;stroke-dasharray:2.2 1.6}',
  '.pa{fill:none;stroke:#1d1a15;stroke-width:1;stroke-linecap:round}',
  '.pah{fill:#1d1a15}',
  '@media (prefers-color-scheme:dark){',
  '.pf{fill:#1b1916;stroke:#9a9285}.pg,.ps{stroke:#6f685d}.pb{fill:#2b2823;stroke:#cfc7b8}',
  '.pt{fill:#f3eee4}.pk,.pd{fill:#bdb5a6}.pm,.pa{stroke:#f3eee4}.pah{fill:#f3eee4}',
  '}',
].join('');

export interface PanelOptions { aspect?: AspectRatio }

/** Short sentence for assistive tech; also the panel's `<title>`. */
export function describePanel(shot: PanelShot): string {
  const where = (b: Blocking): string => {
    const cx = b.shape === 'ellipse' ? b.x : b.x + b.w / 2;
    return cx < 0.4 ? 'left of frame' : cx > 0.6 ? 'right of frame' : 'centre frame';
  };
  let t = `${shot.id}: ${shot.shot_type === 'unset' ? 'shot type not set' : shot.shot_type} framing diagram. `;
  t += shot.blocking.length === 0 ? 'No blocking set.' : `${shot.blocking.map((b) => `${b.who || 'unlabelled'} ${where(b)}`).join(', ')}.`;
  if (shot.camera_move !== 'unset') t += ` Camera move: ${MOVE_LABEL[shot.camera_move] ?? shot.camera_move}.`;
  return t;
}

/** The framing diagram for one shot, as a standalone SVG document string. Deterministic. */
export function panelSvg(shot: PanelShot, opts: PanelOptions = {}): string {
  const { W, H } = panelSize(opts.aspect);
  const maxText = Math.floor((W - 48) / 3.9);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(describePanel(shot))}" data-akuko-panel="${esc(shot.id)}">`);
  parts.push(`<title>${esc(describePanel(shot))}</title><style>${STYLE}</style>`);
  parts.push(`<rect class="pf" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="1.5"/>`);
  parts.push(`<path class="pg" d="M${num(W / 3)} 0V${H}M${num((2 * W) / 3)} 0V${H}M0 ${num(H / 3)}H${W}M0 ${num((2 * H) / 3)}H${W}"/>`);
  parts.push(`<rect class="ps" x="${num(W * 0.05)}" y="${num(H * 0.05)}" width="${num(W * 0.9)}" height="${num(H * 0.9)}"/>`);

  for (const b of shot.blocking) {
    const label = clip(b.who, 16);
    let cx: number, cy: number, bw: number, bh: number;
    if (b.shape === 'ellipse') {
      cx = b.x * W; cy = b.y * H; bw = b.w * W; bh = b.h * H;
      parts.push(`<ellipse class="pb" cx="${num(cx)}" cy="${num(cy)}" rx="${num(bw / 2)}" ry="${num(bh / 2)}"><title>${esc(b.who)}</title></ellipse>`);
    } else {
      const x = b.x * W, y = b.y * H;
      bw = b.w * W; bh = b.h * H; cx = x + bw / 2; cy = y + bh / 2;
      parts.push(`<rect class="pb" x="${num(x)}" y="${num(y)}" width="${num(bw)}" height="${num(bh)}" rx=".8"><title>${esc(b.who)}</title></rect>`);
    }
    if (label !== '') {
      const fits = label.length * 4.2 <= bw - 1 && bh >= 9;
      const ty = fits ? cy : Math.max(17, cy - bh / 2 - 2);
      parts.push(`<text class="pt" x="${num(cx)}" y="${num(ty)}" text-anchor="middle"${fits ? ' dominant-baseline="central"' : ''}>${esc(label)}</text>`);
    }
  }
  if (shot.blocking.length === 0) {
    parts.push(`<text class="pk" x="${num(W / 2)}" y="${num(H / 2 - 1)}" text-anchor="middle">NO BLOCKING</text>`);
    parts.push(`<text class="pd" x="${num(W / 2)}" y="${num(H / 2 + 6)}" text-anchor="middle">nothing placed yet</text>`);
  }

  if (shot.camera_move !== 'unset') parts.push(moveMarks(shot.camera_move, W, H));

  parts.push(`<text class="pk" x="7" y="11">${esc(shot.shot_type === 'unset' ? 'TYPE ?' : shot.shot_type.toUpperCase())}</text>`);
  if (shot.camera_move !== 'unset') {
    parts.push(`<text class="pk" x="${W - 7}" y="11" text-anchor="end">${esc(MOVE_LABEL[shot.camera_move] ?? shot.camera_move.toUpperCase())}</text>`);
  }
  const note = shot.camera !== undefined && shot.camera.trim() !== '' ? shot.camera : 'camera not set';
  parts.push(`<text class="pd" x="7" y="${H - 6}">${esc(clip(note, maxText))}</text>`);
  if (shot.duration_s !== undefined) parts.push(`<text class="pd" x="${W - 7}" y="${H - 6}" text-anchor="end">${esc(num(shot.duration_s))} s</text>`);
  parts.push('</svg>');
  return `${parts.join('')}\n`;
}

/** `board/panels/<shot>-sketch.svg` (the file name the host receives). */
export const panelFileName = (shotId: string): string => `${shotId}-sketch.svg`;

// ── lint ────────────────────────────────────────────────────────────────

export type BoardRule = 'no-blocking' | 'blocking-out-of-frame' | 'blocking-unlabelled' | 'blocking-duplicate-label' | 'blocking-zero-size';
export interface BoardIssue { severity: 'warning'; rule: BoardRule; shot: string; message: string }

/** Sketch lint. Warnings only: a panel is always drawn, and blocking is never invented. */
export function lintBoard(project: Pick<AkukoProject, 'shots'>): BoardIssue[] {
  const issues: BoardIssue[] = [];
  const warn = (rule: BoardRule, shot: string, message: string) => issues.push({ severity: 'warning', rule, shot, message });
  for (const s of project.shots) {
    if (s.source?.removed_at !== undefined) continue; // left the shot list: kept for the record, not linted
    if (s.blocking.length === 0) {
      warn('no-blocking', s.id, `${s.id} has no blocking, so its panel shows only the grid and the camera note. Add blocking from what the script says, or leave it.`);
      continue;
    }
    const seen = new Set<string>();
    for (const b of s.blocking) {
      const label = b.who.trim();
      if (label === '') warn('blocking-unlabelled', s.id, `${s.id} has a blocking box with no label.`);
      else if (seen.has(label)) warn('blocking-duplicate-label', s.id, `${s.id} labels two boxes "${label}".`);
      seen.add(label);
      if (b.w === 0 || b.h === 0) warn('blocking-zero-size', s.id, `${s.id}: "${label || 'unlabelled'}" has zero width or height and cannot be seen.`);
      const [x0, x1, y0, y1] = b.shape === 'ellipse'
        ? [b.x - b.w / 2, b.x + b.w / 2, b.y - b.h / 2, b.y + b.h / 2]
        : [b.x, b.x + b.w, b.y, b.y + b.h];
      if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1) warn('blocking-out-of-frame', s.id, `${s.id}: "${label || 'unlabelled'}" runs outside the frame.`);
    }
  }
  return issues;
}

// ── blocking proposal ───────────────────────────────────────────────────

export class BoardError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'BoardError';
    this.problems = problems;
  }
}

/** `{ "<shot id>": [ {who, shape, x, y, w, h}, … ] }`. Rect x/y is top-left; ellipse x/y is the centre; all 0–1 of the frame. */
export type BlockingProposal = Record<string, unknown>;

/**
 * Set blocking from a proposal. Pure. Allowed only on an approved breakdown
 * shot that has not been drawn yet, or on a sketch shot a person sent back
 * (`needs-rework`). Anything else (still in breakdown review, a panel under
 * review or approved, a send-back at a later stage) is refused.
 * Unknown shots, unknown fields and out-of-range numbers are refused (nothing
 * is applied). The agent writes the proposal only from what the script and the
 * shot's action say.
 */
export function applyBlocking(project: AkukoProject, proposal: BlockingProposal, opts: { now?: () => Date } = {}): AkukoProject {
  const problems: string[] = [];
  const out = structuredClone(project);
  const at = (opts.now ?? (() => new Date()))().toISOString();
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    throw new BoardError(['the blocking proposal must be an object keyed by shot id, e.g. { "sc1_sh1": [ {who, shape, x, y, w, h} ] }']);
  }
  for (const [id, raw] of Object.entries(proposal)) {
    const shot = out.shots.find((s) => s.id === id);
    if (!shot) { problems.push(`${id}: no such shot`); continue; }
    const open = (shot.stage === 'breakdown' && shot.status === 'approved') || (shot.stage === 'sketch' && shot.status === 'needs-rework');
    if (!open) {
      problems.push(`${id}: it is ${shot.status} at ${shot.stage}; blocking can change only on an approved breakdown shot not yet drawn, or on a sketch panel a person sent back (send it back first)`);
      continue;
    }
    const parsed = BlockingSchema.array().safeParse(raw);
    if (!parsed.success) { problems.push(`${id}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'blocking'} ${i.message}`).join('; ')}`); continue; }
    shot.blocking = parsed.data;
    shot.updated_at = at;
  }
  if (problems.length > 0) throw new BoardError(problems);
  return out;
}

// ── drawing the panels (the stage's action) ─────────────────────────────

export interface SketchReport {
  project: AkukoProject;
  /** Shots given their first panel. */
  drawn: string[];
  /** Shots a person sent back whose panel was drawn again. */
  redrawn: string[];
  /** Sent back, but nothing changed since: the panel would be identical, so it was not redrawn. */
  stillSentBack: string[];
  /** Shots already drawn and waiting for (or past) review: left alone. */
  unchanged: string[];
  /** Shots the breakdown has not approved: not drawn. */
  waiting: string[];
  lint: BoardIssue[];
  changed: boolean;
}

export type SketchHost = Pick<HostAdapter, 'storeAsset'>;

/**
 * Draw a panel for every shot that needs one, store it, and move the shot to
 * `pending-review` at stage `sketch`. Call after folding decisions. Free: no
 * provider, no spend gate. Idempotent: a second run over an unchanged project
 * stores nothing and changes nothing. Never writes `approved`.
 *
 * Throws `BoardError` while the breakdown is not approved. Pure over `project`
 * (returns a new one); the caller writes it with `writeState` when `changed`.
 */
export async function drawSketchPanels(project: AkukoProject, host: SketchHost, opts: { now?: () => Date } = {}): Promise<SketchReport> {
  if (project.stages.breakdown.state !== 'approved' || project.stages.sketch.state === 'locked') {
    throw new BoardError(['the sketch board is locked: the breakdown must be approved first (every shot and checklist entry)']);
  }
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const out = structuredClone(project);
  const rep: SketchReport = { project: out, drawn: [], redrawn: [], stillSentBack: [], unchanged: [], waiting: [], lint: lintBoard(out), changed: false };

  for (const shot of out.shots) {
    if (shot.source?.removed_at !== undefined) continue; // left the shot list: no panel is drawn or waited on
    const first = shot.stage === 'breakdown' && shot.status === 'approved';
    const revise = shot.stage === 'sketch' && shot.status === 'needs-rework';
    if (shot.stage === 'breakdown' && !first) { rep.waiting.push(shot.id); continue; }
    if (!first && !revise) { rep.unchanged.push(shot.id); continue; }

    const svg = panelSvg(shot, { aspect: out.project.aspect_ratio });
    const data = new TextEncoder().encode(svg);
    const hash = createHash('sha256').update(data).digest('hex');
    if (revise && shot.by_stage?.sketch?.output?.hash === hash) { rep.stillSentBack.push(shot.id); continue; }

    const asset = await host.storeAsset({
      kind: 'panel',
      filename: panelFileName(shot.id),
      mime: 'image/svg+xml',
      data,
      owner: shot.id,
      name: `${shot.id} sketch panel`,
      tags: ['sketch', 'framing-diagram'],
    });
    if (!asset.file) throw new BoardError([`the host stored ${shot.id}'s panel but returned no file reference`]);
    const output: AssetRef = { ...asset.file, mime: asset.file.mime ?? 'image/svg+xml', hash: asset.file.hash ?? hash };

    shot.stage = 'sketch';
    shot.status = 'pending-review';
    shot.by_stage = { ...shot.by_stage, sketch: { status: 'pending-review', content: describePanel(shot), output } };
    if (revise) shot.comments.push({ ts: at, stage: 'sketch', author: 'agent', text: 'Revised: sketch panel redrawn from the current blocking and camera.' });
    shot.updated_at = at;
    (first ? rep.drawn : rep.redrawn).push(shot.id);
  }

  rep.changed = rep.drawn.length + rep.redrawn.length > 0;
  if (rep.changed) {
    out.stages.sketch = { state: 'in-review' };
    out.current_stage = 'sketch';
    out.project.updated_at = at;
  }
  return rep;
}
