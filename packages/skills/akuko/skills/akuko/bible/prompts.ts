/**
 * akuko — bible prompts (WP-05).
 *
 * The wording of a portrait, turnaround, plate or lookbook prompt lives in the
 * film profile's templates (`profiles/film/templates/*.md`, one
 * `## Prompt: <role>` heading followed by one fenced block). This module reads
 * them and fills the `{{name}}`-style placeholders from a bible entry. It
 * knows no model, price or provider.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type BibleRole = 'portrait' | 'turnaround' | 'plate' | 'lookbook';
export const BIBLE_ROLES: readonly BibleRole[] = ['portrait', 'turnaround', 'plate', 'lookbook'];

/** Which template file holds each role's prompt. */
const FILE_OF: Record<BibleRole, string> = {
  portrait: 'character.md',
  turnaround: 'character.md',
  plate: 'location.md',
  lookbook: 'style.md',
};

export const PLACEHOLDERS = ['name', 'role', 'description', 'notes', 'look'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type PromptContext = Record<Placeholder, string>;

export class PromptError extends Error {
  override name = 'PromptError';
}

const TEMPLATE_DIR = fileURLToPath(new URL('../profiles/film/templates/', import.meta.url));
const NOTHING = '(none given)';

/** The raw prompt text for a role, read from the template file. */
export function templateFor(role: BibleRole, dir: string = TEMPLATE_DIR): string {
  const file = FILE_OF[role];
  const text = readFileSync(`${dir}${file}`, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const FENCE = '`'.repeat(3);
  const at = lines.findIndex((l) => /^#{2,} Prompt: (\w+)\s*$/.exec(l)?.[1] === role);
  const open = at < 0 ? -1 : lines.findIndex((l, i) => i > at && l.startsWith(FENCE));
  const close = open < 0 ? -1 : lines.findIndex((l, i) => i > open && l.startsWith(FENCE));
  // The fence must follow the heading directly (blank lines allowed), not belong to a later section.
  const direct = open > at && lines.slice(at + 1, open).every((l) => l.trim() === '');
  if (at < 0 || close < 0 || !direct) throw new PromptError(`${file} has no "## Prompt: ${role}" block`);
  return lines.slice(open + 1, close).join('\n');
}

/** Fill a template. An unknown placeholder is an error; an empty value reads "(none given)". */
export function renderPrompt(template: string, ctx: PromptContext): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_all, key: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(key)) throw new PromptError(`template uses unknown placeholder {{${key}}}`);
    const v = ctx[key as Placeholder].trim();
    return v === '' ? NOTHING : v;
  });
}

export const promptFor = (role: BibleRole, ctx: PromptContext, dir?: string): string => renderPrompt(templateFor(role, dir), ctx);
