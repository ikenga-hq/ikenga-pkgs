/**
 * akuko — continuity audit for key frames (WP-14, plan R-1).
 *
 * Image models drift on faces and costumes from shot to shot, and motion (the
 * next stage) pays per shot, so before that money is spent a person should see
 * which frames likely break continuity. Two layers, both advisory:
 *
 *   1. structural checks, here, deterministic and free, over every made key frame;
 *   2. visual notes the agent records after looking at each frame next to its
 *      references (`record`): the agent's own notes, never a person's decision.
 *
 * Nothing here moves a status or writes `approved`. The only project change is
 * the agent's own "Audit: ..." comments on key-frame assets, and re-running
 * replaces exactly those (author `agent`, the prefix, an audit run id) and never
 * touches a person's comments. Only a person sends a frame back, on the board,
 * and the existing key-frame `needs-rework` flow takes it from there.
 *
 *   auditProject(project, opts)   pure: project in, AuditReport out
 *   applyAuditComments(...)       a new project with the audit's comments swapped in
 *   renderSummary(report)         the short markdown summary
 */

import { createHash } from 'node:crypto';
import { removedAt, type AkukoProject, type Asset, type BibleEntry, type Shot } from '../schema/akuko-project.ts';
import { bibleAssets, roleOf } from '../bible/plan.ts';
import { keyframeAssets, neededRefs, supersededRefs } from '../keyframes/plan.ts';

export type Severity = 'low' | 'medium' | 'high';
export const SEVERITIES: Severity[] = ['low', 'medium', 'high'];
const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

/** Plan R-1: more principals than this in one frame tend to blend faces. */
export const MAX_PRINCIPALS = 2;

/** Prefix every audit comment carries. */
export const AUDIT_PREFIX = 'Audit: ';

export type CheckId =
  | 'missing-reference'
  | 'superseded-reference'
  | 'character-not-in-prompt'
  | 'too-many-principals'
  | 'mixed-model'
  | 'lookbook-mismatch'
  | 'visual';

export interface Finding {
  source: 'structural' | 'visual';
  check: CheckId;
  severity: Severity;
  text: string;
}

/** What the agent saw when it looked at one frame. Tied to the take it looked at. */
export interface VisualNote {
  unit: string;
  text: string;
  severity: Severity;
  /** Fingerprint of the frame file when the note was recorded; a note on an earlier take is stale. */
  take: string;
  at?: string;
}

export interface FrameAudit {
  unit: string;
  shot: string;
  scene: string | undefined;
  status: Asset['status'];
  structural: Finding[];
  visual: Finding[];
  /** Highest severity among all findings, or none. */
  worst: Severity | 'none';
  /** "send back sc2_sh3: hair colour differs from the turnaround"; only for a frame with a medium or high finding. */
  suggestion?: string;
}

export interface AuditReport {
  run: string;
  generated_at: string;
  frames: FrameAudit[];
  /** Key frames with no image yet; not audited. */
  not_made: string[];
  /** Visual notes on an earlier take of a frame (it was regenerated since); not counted. */
  stale_notes: VisualNote[];
  summary: { audited: number; flagged: number; high: number; medium: number; low: number; clean: boolean };
}

export interface AuditOptions {
  /** The agent's recorded visual notes. */
  visual?: VisualNote[];
  run?: string;
  now?: string;
}

const hasFile = (a: Asset): boolean => a.file !== undefined;

/** Fingerprint of a frame's file; changes when the frame is regenerated. */
export const takeOf = (a: Asset): string => createHash('sha1').update(`${a.file?.uri ?? ''}|${a.file?.hash ?? ''}`).digest('hex').slice(0, 8);

const worstOf = (fs: Finding[]): Severity | 'none' =>
  fs.reduce<Severity | 'none'>((w, f) => (w === 'none' || RANK[f.severity] > RANK[w] ? f.severity : w), 'none');

const characterEntries = (p: AkukoProject, shot: Shot): BibleEntry[] => p.bible.characters.filter((c) => shot.refs.includes(c.id));
const isPrincipal = (e: BibleEntry): boolean => e.role === undefined || /principal/i.test(e.role);

/** "Officers (x3)" matches as "Officers"; case-insensitive whole phrase. */
const cleanName = (n: string): string => n.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const mentions = (text: string | undefined, name: string): boolean => {
  const n = cleanName(name);
  if (!text || n.length < 2) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
};

/** Bible asset ids a frame's `from:<id>@<fingerprint>` tags say it was made from. */
const fromIds = (a: Asset): string[] => a.tags.flatMap((t) => {
  const m = /^from:(.+)@[0-9a-f]{8}$/.exec(t);
  return m ? [m[1]!] : [];
});

function structuralChecks(p: AkukoProject, a: Asset, shot: Shot): Finding[] {
  const out: Finding[] = [];
  const add = (check: CheckId, severity: Severity, text: string): void => { out.push({ source: 'structural', check, severity, text }); };
  const used = new Set(fromIds(a));
  const needed = neededRefs(p, shot);

  // 1. Made with every principal's approved turnaround (portrait if none), the plate and the lookbook.
  for (const n of needed) {
    if (used.has(n.asset.id)) continue;
    if (n.kind === 'character') add('missing-reference', 'high', `Made without ${n.entry.name}'s approved ${roleOf(n.asset)}, so ${n.entry.name} can look different from the other shots`);
    else add('missing-reference', 'medium', `Made without the ${n.kind === 'location' ? 'plate' : 'lookbook'} of ${n.entry.name}`);
  }

  // 2. The references are still the approved, current takes. Reuses the key-frame stage's own check.
  const characterImage = new Set(needed.filter((n) => n.kind === 'character').map((n) => n.asset.id));
  for (const id of supersededRefs(p, a)) {
    const dep = p.assets.find((x) => x.id === id);
    const why = !dep ? 'no longer exists' : dep.status !== 'approved' || !hasFile(dep) ? `is now ${dep.status}` : 'was replaced after this frame was made';
    add('superseded-reference', characterImage.has(id) ? 'high' : 'medium', `Made from ${id}, which ${why}; the frame may no longer match the approved look`);
  }

  // 3. A character named in the shot is in the prompt (the prompt names the characters in `refs`).
  for (const c of p.bible.characters) {
    if (shot.refs.includes(c.id)) continue;
    // A single-word name ("Mara", "Hood") cannot be told from ordinary prose by a text match, so it is capped at low;
    // a multi-word name found in the action or blocking is medium.
    const single = cleanName(c.name).split(' ').length === 1;
    if (mentions(shot.action, c.name) || shot.blocking.some((b) => mentions(b.who, c.name))) {
      add('character-not-in-prompt', single ? 'low' : 'medium', `${c.name} is named in the shot's action or blocking but is not in its refs, so the prompt leaves them out`);
    } else if (mentions(shot.script_line, c.name)) {
      add('character-not-in-prompt', 'low', `${c.name} is named in the shot's script line but is not in its refs`);
    }
  }

  // 4. More than two principals in one frame (plan R-1).
  const principals = characterEntries(p, shot).filter(isPrincipal);
  const label = (c: BibleEntry): string => (c.role === undefined ? `${c.name} (role not set, counted as principal)` : c.name);
  if (principals.length > MAX_PRINCIPALS) {
    add('too-many-principals', 'high', `${principals.length} principals in one frame (${principals.map(label).join(', ')}); more than ${MAX_PRINCIPALS} tends to blend faces`);
  }

  // 6. The lookbook used matches the shot's style.
  const wantStyle = new Set(needed.filter((n) => n.kind === 'style').map((n) => n.asset.id));
  const lookbooks = new Set(bibleAssets(p).filter((x) => roleOf(x) === 'lookbook').map((x) => x.id));
  for (const id of used) {
    if (lookbooks.has(id) && !wantStyle.has(id)) add('lookbook-mismatch', 'medium', `Made with the lookbook ${id}, which is not the style this shot names`);
  }
  return out;
}

/** 5. Same provider and model across a scene: frames that differ from the scene's majority get a finding. */
function mixedModelFindings(p: AkukoProject, made: Asset[]): Map<string, Finding> {
  const out = new Map<string, Finding>();
  const label = (a: Asset): string => (a.provider || a.model ? `${a.provider ?? '?'}/${a.model ?? '?'}` : '');
  const byScene = new Map<string, Asset[]>();
  for (const a of made) {
    if (!label(a)) continue;
    const scene = p.shots.find((s) => s.id === a.owner)?.scene ?? '';
    byScene.set(scene, [...(byScene.get(scene) ?? []), a]);
  }
  for (const [scene, list] of byScene) {
    const count = new Map<string, number>();
    for (const a of list) count.set(label(a), (count.get(label(a)) ?? 0) + 1);
    if (count.size < 2) continue;
    // Majority wins; a tie goes to the earliest frame's choice.
    const ranked = [...count.entries()];
    const top = ranked.reduce((best, e) => (e[1] > best[1] ? e : best));
    const tied = ranked.filter((e) => e[1] === top[1]);
    for (const a of list) {
      if (tied.length === 1 && label(a) === top[0]) continue;
      const text = tied.length > 1
        ? `Scene ${scene || '(none)'} is split between ${tied.map((e) => e[0]).join(' and ')}; this frame used ${label(a)}. Mixing models is a drift risk`
        : `Made with ${label(a)} while most of scene ${scene || '(none)'} used ${top[0]}; mixing models is a drift risk`;
      out.set(a.id, { source: 'structural', check: 'mixed-model', severity: 'medium', text });
    }
  }
  return out;
}

const runIdFor = (visual: VisualNote[]): string => `audit_${createHash('sha1').update(JSON.stringify(visual)).digest('hex').slice(0, 8)}`;

/** Audit every key frame that has an image. Pure: reads the project, returns the report, writes nothing. */
export function auditProject(project: AkukoProject, opts: AuditOptions = {}): AuditReport {
  const keyframes = keyframeAssets(project);
  // A key frame whose shot left the shot list is kept for the record, not audited.
  const made = keyframes.filter((a) => hasFile(a) && removedAt(project, a) === undefined);
  const notes = opts.visual ?? [];
  const mixed = mixedModelFindings(project, made);
  const stale: VisualNote[] = [];
  const frames: FrameAudit[] = [];

  for (const a of made) {
    const shot = project.shots.find((s) => s.id === a.owner);
    if (!shot) continue;
    const structural = structuralChecks(project, a, shot);
    const m = mixed.get(a.id);
    if (m) structural.push(m);
    const visual: Finding[] = [];
    for (const n of notes.filter((x) => x.unit === a.id)) {
      if (n.take !== takeOf(a)) { stale.push(n); continue; }
      visual.push({ source: 'visual', check: 'visual', severity: n.severity, text: n.text });
    }
    const all = [...structural, ...visual];
    const worst = worstOf(all);
    const top = all.filter((f) => f.severity === worst).find((f) => f.source === 'visual') ?? all.find((f) => f.severity === worst);
    frames.push({
      unit: a.id, shot: shot.id, scene: shot.scene, status: a.status, structural, visual, worst,
      ...(top && RANK[worst as Severity] >= RANK.medium ? { suggestion: `send back ${shot.id}: ${top.text.replace(/[.\s]+$/, '')}` } : {}),
    });
  }
  const sevCount = (s: Severity): number => frames.reduce((n, f) => n + [...f.structural, ...f.visual].filter((x) => x.severity === s).length, 0);
  const high = sevCount('high');
  return {
    run: opts.run ?? runIdFor(notes),
    generated_at: opts.now ?? new Date().toISOString(),
    frames,
    not_made: keyframes.filter((a) => !hasFile(a)).map((a) => a.id),
    stale_notes: stale,
    summary: { audited: frames.length, flagged: frames.filter((f) => f.worst !== 'none').length, high, medium: sevCount('medium'), low: sevCount('low'), clean: high === 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Comments on the board
// ─────────────────────────────────────────────────────────────────────────

const RUN_SUFFIX = / \(audit [A-Za-z0-9_-]+\)$/;
/** An audit comment of ours: the agent's, with the prefix and a run id. A person's comment never matches. */
export const isAuditComment = (c: { author: string; text: string }): boolean => c.author === 'agent' && c.text.startsWith(AUDIT_PREFIX) && RUN_SUFFIX.test(c.text);

/**
 * A new project whose key-frame assets carry this report's comments in place
 * of any earlier audit's. Touches only `comments`; never a status, never a
 * person's comment, never `updated_at`.
 */
export function applyAuditComments(project: AkukoProject, report: AuditReport, ts: string): AkukoProject {
  const p = structuredClone(project);
  const byUnit = new Map(report.frames.map((f) => [f.unit, f]));
  for (const a of keyframeAssets(p)) {
    a.comments = a.comments.filter((c) => !isAuditComment(c));
    const f = byUnit.get(a.id);
    if (!f) continue;
    for (const x of [...f.structural, ...f.visual]) {
      a.comments.push({ ts, stage: 'keyframes', author: 'agent', text: `${AUDIT_PREFIX}${x.severity}: ${x.text.replace(/[.\s]+$/, '')}. (audit ${report.run})` });
    }
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// Short markdown summary
// ─────────────────────────────────────────────────────────────────────────

export function renderSummary(r: AuditReport): string {
  const s = r.summary;
  const lines = [
    `# Key-frame continuity audit (${r.run})`,
    '',
    'Advisory only: it changes no status. Only a person sends a frame back, on the board.',
    '',
    `${s.audited} frame${s.audited === 1 ? '' : 's'} audited, ${s.flagged} with findings (${s.high} high, ${s.medium} medium, ${s.low} low). ${s.high === 0 ? 'No high findings.' : 'Look at the high findings before motion spends money on these shots.'}`,
  ];
  if (r.not_made.length) lines.push('', `Not audited, no image yet: ${r.not_made.join(', ')}.`);
  const flagged = r.frames.filter((f) => f.worst !== 'none');
  if (flagged.length) {
    lines.push('', '## Frames with findings');
    for (const f of [...flagged].sort((a, b) => RANK[b.worst as Severity] - RANK[a.worst as Severity] || a.unit.localeCompare(b.unit))) {
      lines.push('', `### ${f.unit} (${f.worst})`);
      for (const x of [...f.structural, ...f.visual]) lines.push(`- [${x.severity}] ${x.source === 'visual' ? 'Seen: ' : ''}${x.text}`);
      if (f.suggestion) lines.push(`- Suggested: ${f.suggestion}`);
    }
  }
  const clean = r.frames.filter((f) => f.worst === 'none');
  if (clean.length) lines.push('', `Clean: ${clean.map((f) => f.unit).join(', ')}.`);
  if (r.stale_notes.length) lines.push('', `${r.stale_notes.length} visual note${r.stale_notes.length === 1 ? '' : 's'} on an earlier take of a regenerated frame were left out; look at the new take.`);
  return `${lines.join('\n')}\n`;
}
