/**
 * Cross-reference checks for an akuko project.
 *
 * The Zod schema (and the JSON Schema exported from it) checks shape only.
 * These checks cover what a schema cannot express: ids are unique, references
 * point at things that exist, and the budget agrees with the ledger.
 * Returns a list of issues; an empty list means the project is consistent.
 */

import type { AkukoProject } from './akuko-project.ts';
import { listUnits } from './akuko-project.ts';

export interface IntegrityIssue {
  path: string;
  message: string;
}

/** Tolerance for comparing sums of money amounts held as floats. */
const MONEY_EPSILON = 1e-9;

export function checkIntegrity(p: AkukoProject): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  // Unit ids and job ids share one namespace: a decision names either.
  const seen = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const prev = seen.get(id);
    if (prev) add(path, `id "${id}" is already used at ${prev}`);
    else seen.set(id, path);
  };
  p.shots.forEach((s, i) => claim(s.id, `shots[${i}]`));
  (['characters', 'locations', 'styles'] as const).forEach((list) =>
    p.bible[list].forEach((e, i) => claim(e.id, `bible.${list}[${i}]`)),
  );
  p.assets.forEach((a, i) => claim(a.id, `assets[${i}]`));
  p.pending_spend.forEach((j, i) => claim(j.id, `pending_spend[${i}]`));

  const sceneIds = new Set<string>();
  p.scenes.forEach((s, i) => {
    if (sceneIds.has(s.id)) add(`scenes[${i}]`, `scene id "${s.id}" is used twice`);
    sceneIds.add(s.id);
  });

  const unitIds = new Set(listUnits(p).map((u) => u.unit.id));
  const bibleIds = new Set(
    [...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((e) => e.id),
  );
  const assetIds = new Set(p.assets.map((a) => a.id));
  const jobIds = new Set(p.pending_spend.map((j) => j.id));

  p.shots.forEach((s, i) => {
    if (s.scene !== undefined && !sceneIds.has(s.scene)) add(`shots[${i}].scene`, `unknown scene "${s.scene}"`);
    s.refs.forEach((r, k) => {
      if (!bibleIds.has(r) && !assetIds.has(r)) add(`shots[${i}].refs[${k}]`, `"${r}" is not a bible entry or asset`);
    });
  });

  (['characters', 'locations', 'styles'] as const).forEach((list) =>
    p.bible[list].forEach((e, i) =>
      e.refs.forEach((r, k) => {
        if (!assetIds.has(r)) add(`bible.${list}[${i}].refs[${k}]`, `"${r}" is not an asset`);
      }),
    ),
  );

  p.assets.forEach((a, i) => {
    if (a.owner !== undefined && !unitIds.has(a.owner)) add(`assets[${i}].owner`, `unknown owner "${a.owner}"`);
  });

  p.pending_spend.forEach((j, i) => {
    j.units.forEach((u, k) => {
      if (!unitIds.has(u)) add(`pending_spend[${i}].units[${k}]`, `unknown unit "${u}"`);
    });
    if (j.approved_max !== undefined && j.approved_max < j.estimate) {
      add(`pending_spend[${i}].approved_max`, `approved_max ${j.approved_max} is below the estimate ${j.estimate}`);
    }
  });

  const ledgerIds = new Set<string>();
  p.ledger.forEach((e, i) => {
    if (e.id !== undefined) {
      if (ledgerIds.has(e.id)) add(`ledger[${i}].id`, `ledger id "${e.id}" is used twice`);
      ledgerIds.add(e.id);
    }
    if (!unitIds.has(e.unit)) add(`ledger[${i}].unit`, `unknown unit "${e.unit}"`);
    if (e.job !== undefined && !jobIds.has(e.job)) add(`ledger[${i}].job`, `unknown job "${e.job}"`);
  });

  const decisionIds = new Set<string>();
  p.decisions.forEach((d, i) => {
    if (decisionIds.has(d.id)) add(`decisions[${i}].id`, `decision id "${d.id}" is used twice`);
    decisionIds.add(d.id);
    if (!unitIds.has(d.unit) && !jobIds.has(d.unit)) add(`decisions[${i}].unit`, `unknown unit or job "${d.unit}"`);
    if (d.action === 'undo' && !p.decisions.some((x) => x.id === d.undoes)) {
      add(`decisions[${i}].undoes`, `unknown decision "${d.undoes}"`);
    }
  });

  if (p.budget) {
    const spent = p.ledger.reduce((sum, e) => (e.status === 'done' ? sum + (e.actual ?? 0) : sum), 0);
    if (Math.abs(spent - p.budget.spent) > MONEY_EPSILON) {
      add('budget.spent', `budget.spent is ${p.budget.spent} but done ledger entries sum to ${spent}`);
    }
  } else if (p.ledger.length > 0) {
    add('budget', 'ledger has entries but no budget is set');
  }

  return issues;
}
