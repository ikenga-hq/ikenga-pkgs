/**
 * Cross-reference checks for an akuko project.
 *
 * The Zod schema (and the JSON Schema exported from it) checks shape only.
 * These checks cover what a schema cannot express: ids are unique, references
 * point at things that exist, and the budget agrees with the ledger.
 * Returns a list of issues; an empty list means the project is consistent.
 */

import type { AkukoProject, RuleScope } from './akuko-project.ts';
import { SHA256_PATTERN, listUnits } from './akuko-project.ts';

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

  checkRealProject(p, add, claim, sceneIds, bibleIds);

  if (p.budget) {
    const spent = p.ledger.reduce((sum, e) => (e.status === 'done' ? sum + Math.round((e.actual ?? 0) * 1e6) : sum), 0) / 1e6; // micro-units, same as spentFromLedger()
    if (Math.abs(spent - p.budget.spent) > MONEY_EPSILON) {
      add('budget.spent', `budget.spent is ${p.budget.spent} but done ledger entries sum to ${spent}`);
    }
  } else if (p.ledger.length > 0) {
    add('budget', 'ledger has entries but no budget is set');
  }

  return issues;
}

/** Tolerance for comparing film times (seconds) held as floats. */
const FILM_EPSILON = 1e-9;

/**
 * Real-project references (WP-24): lines, film times, cards, rules, people
 * and gates. Everything here is optional in the schema, so a project that
 * uses none of it gets no issues.
 */
function checkRealProject(
  p: AkukoProject,
  add: (path: string, message: string) => void,
  claim: (id: string, path: string) => void,
  sceneIds: Set<string>,
  bibleIds: Set<string>,
): void {
  const shotIds = new Set(p.shots.map((s) => s.id));

  // Dialogue lines: unique ids; every shot line names one, with the same kind.
  const lines = new Map<string, string>();
  (p.audio.lines ?? []).forEach((l, i) => {
    if (lines.has(l.id)) add(`audio.lines[${i}].id`, `line id "${l.id}" is used twice`);
    else lines.set(l.id, l.kind);
  });
  p.shots.forEach((s, i) =>
    (s.lines ?? []).forEach((l, k) => {
      const kind = lines.get(l.id);
      if (kind === undefined) add(`shots[${i}].lines[${k}].id`, `"${l.id}" is not in audio.lines`);
      else if (kind !== l.kind) add(`shots[${i}].lines[${k}].kind`, `"${l.id}" is ${kind} in audio.lines, not ${l.kind}`);
    }),
  );

  // Film times must not overlap within a scene (gaps are fine).
  const byScene = new Map<string, { i: number; in_s: number; out_s: number }[]>();
  p.shots.forEach((s, i) => {
    if (s.film && s.scene !== undefined) byScene.set(s.scene, [...(byScene.get(s.scene) ?? []), { i, ...s.film }]);
  });
  for (const list of byScene.values()) {
    const sorted = [...list].sort((a, b) => a.in_s - b.in_s || a.i - b.i);
    for (let k = 1; k < sorted.length; k++) {
      const prev = sorted[k - 1]!;
      const cur = sorted[k]!;
      if (cur.in_s < prev.out_s - FILM_EPSILON) {
        add(`shots[${cur.i}].film`, `film ${cur.in_s}–${cur.out_s} s overlaps ${p.shots[prev.i]!.id} (${prev.in_s}–${prev.out_s} s) in scene ${p.shots[cur.i]!.scene}`);
      }
    }
  }

  // Cards are placed by film time, so they need one, and a file.
  p.assets.forEach((a, i) => {
    if (a.kind !== 'card') return;
    if (!a.film) add(`assets[${i}].film`, `card "${a.id}" has no film time`);
    if (!a.file) add(`assets[${i}].file`, `card "${a.id}" has no file`);
  });

  // Parts exist when a shot or scene carries them.
  const parts = new Set<string>([...p.shots, ...p.scenes].flatMap((x) => (x.part === undefined ? [] : [x.part])));
  const scopeIds = (path: string, scope: RuleScope | undefined) => {
    scope?.shots?.forEach((id, k) => { if (!shotIds.has(id)) add(`${path}.shots[${k}]`, `unknown shot "${id}"`); });
    scope?.scenes?.forEach((id, k) => { if (!sceneIds.has(id)) add(`${path}.scenes[${k}]`, `unknown scene "${id}"`); });
  };

  // Rules: scopes name real shots and scenes; hashes are well formed; consent refs resolve.
  if (p.rules) {
    const r = p.rules;
    const consentIds = new Set<string>();
    r.consent.forEach((c, i) => {
      if (consentIds.has(c.id)) add(`rules.consent[${i}].id`, `consent id "${c.id}" is used twice`);
      consentIds.add(c.id);
    });
    r.banned.forEach((b, i) => scopeIds(`rules.banned[${i}].scope`, b.scope));
    r.require.forEach((q, i) => scopeIds(`rules.require[${i}].scope`, q.scope));
    r.exempt.forEach((e, i) => scopeIds(`rules.exempt[${i}]`, { shots: e.shots }));
    r.uploads.allow.forEach((u, i) => {
      if (!SHA256_PATTERN.test(u.sha256)) add(`rules.uploads.allow[${i}].sha256`, 'sha256 must be 64 lowercase hex characters');
      if (u.consent_ref !== undefined && !consentIds.has(u.consent_ref)) add(`rules.uploads.allow[${i}].consent_ref`, `unknown consent "${u.consent_ref}"`);
    });
    r.never_from_photo.forEach((id, i) => {
      if (!bibleIds.has(id)) add(`rules.never_from_photo[${i}]`, `"${id}" is not a bible entry`);
    });
  }

  // People: unique ids.
  const people = new Map<string, string>();
  (p.people ?? []).forEach((x, i) => {
    if (people.has(x.id)) add(`people[${i}].id`, `person id "${x.id}" is used twice`);
    else people.set(x.id, x.role);
  });

  // Gates: ids share the unit namespace (a decision may name one), scope ids exist,
  // and a signature names a person whose role is the one the gate needs.
  (p.gates ?? []).forEach((g, i) => {
    claim(g.id, `gates[${i}]`);
    scopeIds(`gates[${i}].scope`, g.scope);
    g.scope.parts?.forEach((part, k) => { if (!parts.has(part)) add(`gates[${i}].scope.parts[${k}]`, `no shot or scene is in part "${part}"`); });
    if (g.signed) {
      const role = people.get(g.signed.by);
      if (role === undefined) add(`gates[${i}].signed.by`, `unknown person "${g.signed.by}"`);
      else if (role !== g.needs) add(`gates[${i}].signed.by`, `"${g.signed.by}" is ${role === 'approver' ? 'an approver' : role}; ${g.id} needs ${g.needs}`);
      if (g.signed.role !== g.needs) add(`gates[${i}].signed.role`, `${g.id} needs ${g.needs}, not ${g.signed.role}`);
    }
  });
}
