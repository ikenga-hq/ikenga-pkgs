/**
 * akuko — breakdown lint.
 *
 * Checks a project's shots against the limits the film profile sets, with a
 * message a person can act on:
 *   - no shot longer than 10 seconds (the clip limit of today's video models);
 *   - no shot with more than 2 principal characters (faces drift beyond that);
 *   - every shot has a duration, an action, a scene, and a canonical id.
 * Also checks that shot tags in the script match the shots.
 *
 * `error` blocks the breakdown (fix before it is written); `warning` is shown
 * to the person at review.
 */

import type { AkukoProject, Shot } from '../schema/akuko-project.ts';
import { isCanonicalShotId } from '../schema/akuko-project.ts';
import { parseFountain } from './fountain.ts';
import { readTags } from './tags.ts';

export const MAX_SHOT_SECONDS = 10;
export const MIN_SHOT_SECONDS = 5;
export const MAX_PRINCIPALS = 2;

/** Character roles that do not count towards the principal limit. */
const BACKGROUND_ROLE = /background|extra|crowd|bystander/i;

export type LintRule =
  | 'duration-missing'
  | 'duration-too-long'
  | 'duration-short'
  | 'too-many-principals'
  | 'action-missing'
  | 'scene-missing'
  | 'id-not-canonical'
  | 'split-note'
  | 'film-order'
  | 'sheet-id-not-in-script'
  | 'tag-missing'
  | 'tag-unknown-shot';

export interface LintIssue {
  severity: 'error' | 'warning';
  rule: LintRule;
  /** Shot id, or the tag's shot id for tag issues. */
  shot: string;
  message: string;
}

export interface LintOptions {
  maxSeconds?: number;
  minSeconds?: number;
  maxPrincipals?: number;
}

/** Names of the principal characters a shot references, in ref order. */
export function principalsOf(p: AkukoProject, shot: Shot): string[] {
  const out: string[] = [];
  for (const ref of shot.refs) {
    const c = p.bible.characters.find((x) => x.id === ref);
    if (c && !(c.role && BACKGROUND_ROLE.test(c.role))) out.push(c.name);
  }
  return out;
}

/** A shot imported from a sheet (WP-25): the sheet sets its length and id, not the film profile's limits. */
export const isImported = (s: Shot): boolean => s.source?.kind === 'sheet';

const SPLIT_NOTE = /\bSPLIT\b/;
const FILM_EPSILON = 1e-9;

export function lintShots(p: AkukoProject, opts: LintOptions = {}): LintIssue[] {
  const max = opts.maxSeconds ?? MAX_SHOT_SECONDS;
  const min = opts.minSeconds ?? MIN_SHOT_SECONDS;
  const maxP = opts.maxPrincipals ?? MAX_PRINCIPALS;
  const issues: LintIssue[] = [];
  const add = (severity: LintIssue['severity'], rule: LintRule, shot: string, message: string) =>
    issues.push({ severity, rule, shot, message });

  let prev: Shot | undefined;
  for (const s of p.shots) {
    if (isImported(s)) {
      lintImportedShot(p, s, prev, maxP, add);
      if (s.source?.removed_at === undefined) prev = s;
      continue;
    }
    prev = s;
    if (!isCanonicalShotId(s.id)) {
      add('warning', 'id-not-canonical', s.id, `${s.id}: shot ids from breakdown look like sc<N>_sh<M> (for example sc3_sh2).`);
    }
    if (s.duration_s === undefined) {
      add('error', 'duration-missing', s.id, `${s.id} has no duration. Give it one between ${min} and ${max} seconds.`);
    } else if (s.duration_s > max) {
      add('error', 'duration-too-long', s.id, `${s.id} runs ${s.duration_s} s; a shot can be at most ${max} s. Split it into two shots or shorten the action.`);
    } else if (s.duration_s < min) {
      add('warning', 'duration-short', s.id, `${s.id} runs ${s.duration_s} s, under the usual ${min} s. Fine for an insert or a cut-away; otherwise merge it with a neighbour.`);
    }
    const names = principalsOf(p, s);
    if (names.length > maxP) {
      add('error', 'too-many-principals', s.id, `${s.id} has ${names.length} principal characters (${names.join(', ')}); a shot can have at most ${maxP}. Split the action across shots or move one character out of frame.`);
    }
    if (!s.action || s.action.trim() === '') add('error', 'action-missing', s.id, `${s.id} has no action. Say what happens in frame.`);
    if (s.scene === undefined) add('error', 'scene-missing', s.id, `${s.id} is not attached to a scene.`);
  }
  return issues;
}

/**
 * Compare the shot tags in a script with the project's shots. A shot with no
 * tag is a warning (it may be one the breakdown could not place); a tag that
 * names a shot that does not exist is an error.
 */
export function lintTags(p: AkukoProject, scriptText: string, opts: { prose?: boolean } = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const doc = parseFountain(scriptText, opts);
  const tags = readTags(doc);
  const tagged = new Set(tags.map((t) => t.shotId));
  const known = new Set(p.shots.map((s) => s.id));
  for (const s of p.shots) {
    if (!tagged.has(s.id)) {
      issues.push({ severity: 'warning', rule: 'tag-missing', shot: s.id, message: `${s.id} has no [[${s.id}]] tag in the script. Run the tag step, or place it by hand.` });
    }
  }
  for (const t of tags) {
    if (!known.has(t.shotId)) {
      issues.push({ severity: 'error', rule: 'tag-unknown-shot', shot: t.shotId, message: `Line ${t.line + 1} is tagged [[${t.shotId}]] but the project has no such shot.` });
    }
  }
  return issues;
}

/**
 * Imported shots (WP-25). The sheet decides a shot's length and id, so there is no 10 s cap, no
 * 5 s floor and no canonical-id check; a SPLIT note is a reminder, not an error. Film times that
 * overlap inside a scene are reported by the integrity check, so only a shot that starts before
 * the previous shot of a different scene ends is reported here.
 */
function lintImportedShot(
  p: AkukoProject,
  s: Shot,
  prev: Shot | undefined,
  maxP: number,
  add: (severity: LintIssue['severity'], rule: LintRule, shot: string, message: string) => void,
): void {
  if (s.source?.removed_at !== undefined) return;
  if (s.duration_s === undefined) add('error', 'duration-missing', s.id, `${s.id} has no duration.`);
  if (s.scene === undefined) add('error', 'scene-missing', s.id, `${s.id} is not attached to a scene.`);
  if (!s.action || s.action.trim() === '') add('warning', 'action-missing', s.id, `${s.id} has no text in the sheet.`);
  if (s.notes !== undefined && SPLIT_NOTE.test(s.notes)) {
    add('warning', 'split-note', s.id, `${s.id} is marked SPLIT in the sheet's notes: it may be one shot the sheet cut in two, or a long shot to split.`);
  }
  const names = principalsOf(p, s);
  if (names.length > maxP) {
    add('warning', 'too-many-principals', s.id, `${s.id} has ${names.length} principal characters (${names.join(', ')}); faces drift beyond ${maxP} in one generated frame.`);
  }
  if (prev?.film && s.film && prev.scene !== s.scene && s.film.in_s < prev.film.out_s - FILM_EPSILON) {
    add('warning', 'film-order', s.id, `${s.id} starts at ${s.film.in_s} s, before ${prev.id} ends (${prev.film.out_s} s).`);
  }
}

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does each imported shot's sheet id appear in the film script (a document that names its shots,
 * for example with the id in backticks)? A missing id is a warning, so the person can see which
 * shots the script does not mention. Shots that did not come from a sheet are not checked.
 */
export function lintSheetIdsInScript(p: AkukoProject, scriptText: string): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const s of p.shots) {
    if (!isImported(s) || s.source?.removed_at !== undefined) continue;
    const id = s.source!.id;
    if (!new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(id)}(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9])`).test(scriptText)) {
      issues.push({ severity: 'warning', rule: 'sheet-id-not-in-script', shot: s.id, message: `${s.id} is not mentioned in the film script.` });
    }
  }
  return issues;
}

export function hasErrors(issues: LintIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function formatIssues(issues: LintIssue[]): string {
  if (issues.length === 0) return 'Lint passed: no issues.';
  return issues.map((i) => `${i.severity === 'error' ? 'ERROR  ' : 'warning'} ${i.message}`).join('\n');
}
