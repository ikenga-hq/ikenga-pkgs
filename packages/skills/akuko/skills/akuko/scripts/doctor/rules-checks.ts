/**
 * akuko — doctor: the project rules (WP-26).
 *
 * Reports whether the project has rules and whether they are required, how
 * many files the allow-list names, and how many of those are missing on disk.
 * An allowed file is matched by content, so "on disk" means: some file the
 * project points at has that sha256. The files looked at are every asset's
 * file (cards excepted: they are never uploaded), the master audio and each
 * line's clip. The master is not re-hashed when `audio.master.sha256` is
 * recorded and the file is there. Doctor changes nothing.
 */

import { existsSync } from 'node:fs';
import type { AkukoProject } from '../../schema/akuko-project.ts';
import { ruleWarnings, rulesStatus } from '../../rules/check.ts';
import { summaryLine } from '../../rules/cli.ts';
import { locate, newHashCache, sha256FileSync } from '../../rules/refs.ts';
import type { Finding } from './project-checks.ts';

export type RulesFinding = Finding & { code: 'rules-invalid' | 'rules-required-empty' | 'rules-allowed-missing' | 'rules-setup' };

export interface RulesReport {
  /** One line: present or not, the counts, required or not. */
  summary: string;
  /** Allow-list entries, and how many are not among the project's files. */
  allowed: number;
  missing: number;
  findings: RulesFinding[];
}

const short = (h: string): string => `${h.slice(0, 12)}…`;

/** sha256 → where it was found, over the files the project points at. */
function projectHashes(p: AkukoProject, projectDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const cache = newHashCache();
  const add = (uri: string | undefined, known?: string): void => {
    if (!uri) return;
    const loc = locate(uri, projectDir);
    if (loc.kind !== 'path' || !existsSync(loc.path)) return;
    try {
      out.set(known ?? sha256FileSync(loc.path, cache), uri);
    } catch { /* unreadable: counts as not found */ }
  };
  for (const a of p.assets) if (a.kind !== 'card') add(a.file?.uri);
  add(p.audio?.master?.uri, p.audio?.master?.sha256);
  for (const l of p.audio?.lines ?? []) add(l.clip_uri);
  return out;
}

export function rulesReport(p: AkukoProject, projectDir: string): RulesReport {
  const st = rulesStatus(p);
  const summary = summaryLine({ status: st });
  const findings: RulesFinding[] = [];
  if (st.invalid) {
    findings.push({ level: 'warn', code: 'rules-invalid', message: `The project rules are not valid (${st.invalid}): every job is refused.`, fix: 'Fix the rules block in akuko.json.' });
    return { summary, allowed: 0, missing: 0, findings };
  }
  if (!st.present) return { summary, allowed: 0, missing: 0, findings };
  if (st.required && st.empty) {
    findings.push({ level: 'warn', code: 'rules-required-empty', message: 'rules.required is true but no rules are recorded: every paid job is refused.', fix: 'Record the house rules (banned terms, required text, allowed files, never-from-photo entries).' });
  }
  const allow = st.rules.uploads.allow;
  let missing = 0;
  if (allow.length) {
    const found = projectHashes(p, projectDir);
    for (const a of allow) {
      if (found.has(a.sha256)) continue;
      missing++;
      findings.push({
        level: 'warn',
        code: 'rules-allowed-missing',
        message: `Allowed file "${a.label}" (sha256 ${short(a.sha256)}) is not among the files this project points at.`,
        fix: 'Attach it as a reference (it is matched by content, so any name works), or remove the entry if it is no longer used.',
      });
    }
  }
  for (const w of ruleWarnings(p, st.rules)) findings.push({ level: 'warn', code: 'rules-setup', message: `Rules: ${w}.` });
  return { summary, allowed: allow.length, missing, findings };
}
