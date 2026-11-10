/**
 * akuko — sign-off gates (WP-29, R9-5 / R9-11).
 *
 * Two levels of approval:
 *   - day to day, a person approves units on the board (decisions, folded);
 *   - a milestone (`gates[]`, e.g. G-LOOK, G-PILOT) is passed only when
 *     `gates[].signed` names a `signoff` person.
 *
 * The sign-off record is written by `signGate()` (the `decisions/cli.ts
 * signoff` command), never by a view and never by folding. The person running
 * akuko records it on the signer's word, so on host B it is **attested, not
 * proven**. The agent runs it only on the person's explicit words naming the
 * gate and the signer (actions/review.md §Sign-off).
 *
 * Gates are informational: they never change stage locking. `gateStatus()`
 * says what is in scope, how much of it is approved, and whether it is signed;
 * the person decides when to move on.
 *
 * Which units a gate covers (`unitsInGate`), from its `scope`:
 *   1. In-scope shots. With no `shots` / `scenes` / `parts`, every shot. Else a
 *      shot is in scope when its id is in `shots`, its scene in `scenes`, or
 *      its part (or its scene's part) in `parts` (any match).
 *   2. Candidates. Without a shot filter: every shot, asset and bible entry.
 *      With one: the in-scope shots; the assets they own (`owner`); the bible
 *      entries they name (`refs`, and `lighting`); the assets those entries
 *      own; and the cards whose part (`cardPart`) is in `parts`.
 *   3. `stage`, when set, keeps only the candidates at that stage (a unit's
 *      `stage`): G-LOOK `{stage: "bible"}` is the bible images,
 *      G-PILOT `{stage: "keyframes", parts: ["P7"]}` the P7 key frames.
 *   Rows that left the sheet (`source.removed_at`) are never in scope; they
 *   are listed in `removed`.
 *
 * Pure functions; `decisions/gates.test.ts` pins them. The default board
 * (views/default-board.html) repeats the same rules in its own script and
 * `views/default-board.test.ts` checks the two agree.
 */

import { AkukoProjectSchema, type AkukoProject, type Asset, type BibleEntry, type Gate, type GateSignature, type Person, type Shot, type UnitStatus } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';

export type GateUnitType = 'shot' | 'asset' | 'entry';

export interface GateUnit {
  id: string;
  type: GateUnitType;
  /** Asset kind, `shot`, or the bible group (`character` / `location` / `style`). */
  kind: string;
  stage: string;
  status: UnitStatus;
  owner?: string;
  part?: string;
  /** The stored file (assets), as `file.uri`. */
  file?: string;
  updated_at?: string;
}

export type GateState = 'signed' | 'ready' | 'open' | 'empty';

export interface GateStatus {
  id: string;
  title?: string;
  needs: 'signoff';
  scope: Gate['scope'];
  units: GateUnit[];
  total: number;
  approved: number;
  pending_review: number;
  needs_rework: number;
  /** Not reviewable yet (`pending`, `draft`). */
  not_ready: number;
  /** Every unit in scope approved (and at least one). */
  all_approved: boolean;
  signed?: GateSignature;
  /** The signer, from `people`, when the record names one. */
  signer?: Person;
  /** signed: recorded; ready: everything approved, not signed; open: work left; empty: nothing in scope yet. */
  state: GateState;
  /** In-scope units whose `updated_at` is later than the sign-off. */
  changed_since_signed: string[];
  /** Rows in the scope's shots that left the sheet (never counted). */
  removed: string[];
  /** Plain-language notes: signed with work still open, changed since, nothing in scope. */
  notes: string[];
}

const removedRow = (x: { source?: { removed_at?: string } | undefined }): boolean => x.source?.removed_at !== undefined;

const filmIn = (s: Shot): number | undefined => s.film?.in_s;

/**
 * The part a card belongs to: the part of the first shot that starts at or
 * after the card starts (a part card sits just before its part), else the part
 * of the last shot (end credits). Shots without film time or part are ignored.
 */
export function cardPart(p: Pick<AkukoProject, 'shots' | 'scenes'>, card: Pick<Asset, 'film'>): string | undefined {
  if (!card.film) return undefined;
  const sceneParts = new Map(p.scenes.map((sc) => [sc.id, sc.part]));
  const timed = p.shots
    .filter((s) => !removedRow(s) && filmIn(s) !== undefined)
    .map((s) => ({ in_s: filmIn(s)!, part: s.part ?? (s.scene ? sceneParts.get(s.scene) : undefined) }))
    .filter((s): s is { in_s: number; part: string } => s.part !== undefined)
    .sort((a, b) => a.in_s - b.in_s);
  const next = timed.find((s) => s.in_s >= card.film!.in_s - 1e-6);
  return (next ?? timed[timed.length - 1])?.part;
}

/** A shot's part: its own, else its scene's. */
export function shotPart(p: Pick<AkukoProject, 'scenes'>, s: Shot): string | undefined {
  return s.part ?? (s.scene ? p.scenes.find((sc) => sc.id === s.scene)?.part : undefined);
}

function bibleEntries(p: AkukoProject): { e: BibleEntry; group: string }[] {
  return [
    ...p.bible.characters.map((e) => ({ e, group: 'character' })),
    ...p.bible.locations.map((e) => ({ e, group: 'location' })),
    ...p.bible.styles.map((e) => ({ e, group: 'style' })),
  ];
}

/** The units a gate covers (module comment). Order: shots, then assets, then bible entries, each in project order. */
export function unitsInGate(p: AkukoProject, gate: Pick<Gate, 'scope'>): { units: GateUnit[]; removed: string[] } {
  const sc = gate.scope;
  const filtered = (sc.shots?.length ?? 0) + (sc.scenes?.length ?? 0) + (sc.parts?.length ?? 0) > 0;
  const want = {
    shots: new Set(sc.shots ?? []),
    scenes: new Set(sc.scenes ?? []),
    parts: new Set(sc.parts ?? []),
  };
  const matches = (s: Shot): boolean => {
    if (!filtered) return true;
    const part = shotPart(p, s);
    return want.shots.has(s.id) || (s.scene !== undefined && want.scenes.has(s.scene)) || (part !== undefined && want.parts.has(part));
  };
  const removed = p.shots.filter((s) => removedRow(s) && matches(s)).map((s) => s.id);
  const shots = p.shots.filter((s) => !removedRow(s) && matches(s));
  const shotIds = new Set(shots.map((s) => s.id));
  const entries = bibleEntries(p).filter(({ e }) => !removedRow(e));
  const named = new Set<string>();
  for (const s of shots) {
    for (const r of s.refs) named.add(r);
    if (s.lighting) named.add(s.lighting);
  }
  const entryIds = new Set(entries.filter(({ e }) => !filtered || named.has(e.id)).map(({ e }) => e.id));
  const assets = p.assets.filter((a) => {
    if (removedRow(a)) return false;
    if (!filtered) return true;
    if (a.owner !== undefined && (shotIds.has(a.owner) || entryIds.has(a.owner))) return true;
    if (a.kind === 'card') { const part = cardPart(p, a); return part !== undefined && want.parts.has(part); }
    return false;
  });
  const stageOk = (stage: string): boolean => sc.stage === undefined || stage === sc.stage;
  const partOfOwner = (owner: string | undefined): string | undefined => {
    const s = owner ? p.shots.find((x) => x.id === owner) : undefined;
    return s ? shotPart(p, s) : undefined;
  };
  const units: GateUnit[] = [
    ...shots.filter((s) => stageOk(s.stage)).map((s): GateUnit => clean({ id: s.id, type: 'shot', kind: 'shot', stage: s.stage, status: s.status, part: shotPart(p, s), updated_at: s.updated_at })),
    ...assets.filter((a) => stageOk(a.stage)).map((a): GateUnit => clean({
      id: a.id, type: 'asset', kind: a.kind, stage: a.stage, status: a.status, owner: a.owner,
      part: a.kind === 'card' ? cardPart(p, a) : partOfOwner(a.owner), file: a.file?.uri, updated_at: a.updated_at,
    })),
    ...entries.filter(({ e }) => entryIds.has(e.id) && stageOk(e.stage)).map(({ e, group }): GateUnit => clean({ id: e.id, type: 'entry', kind: group, stage: e.stage, status: e.status, updated_at: e.updated_at })),
  ];
  return { units, removed };
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

const instant = (t: string | undefined): number => (t ? Date.parse(t) : NaN);

/** What a gate covers, how much is approved, and whether it is signed. Throws for an unknown gate id. */
export function gateStatus(p: AkukoProject, gateId: string): GateStatus {
  const gate = (p.gates ?? []).find((g) => g.id === gateId);
  if (!gate) throw new GateError('unknown-gate', `no gate "${gateId}" in this project${knownGates(p)}`);
  const { units, removed } = unitsInGate(p, gate);
  const count = (st: UnitStatus) => units.filter((u) => u.status === st).length;
  const approved = count('approved');
  const total = units.length;
  const all_approved = total > 0 && approved === total;
  const signed = gate.signed;
  const signer = signed ? (p.people ?? []).find((x) => x.id === signed.by) : undefined;
  const at = instant(signed?.at);
  const changed_since_signed = signed ? units.filter((u) => instant(u.updated_at) > at).map((u) => u.id) : [];
  const notes: string[] = [];
  if (total === 0) notes.push(`nothing is in scope yet${gate.scope.stage ? ` (no units at stage ${gate.scope.stage})` : ''}`);
  if (signed && !all_approved && total > 0) notes.push(`signed while ${total - approved} of ${total} were not approved`);
  if (changed_since_signed.length > 0) notes.push(`${changed_since_signed.length} changed after it was signed: ${changed_since_signed.slice(0, 5).join(', ')}${changed_since_signed.length > 5 ? ', …' : ''}`);
  if (removed.length > 0) notes.push(`${removed.length} removed from the sheet (not counted)`);
  return clean({
    id: gate.id,
    title: gate.title,
    needs: gate.needs,
    scope: gate.scope,
    units,
    total,
    approved,
    pending_review: count('pending-review'),
    needs_rework: count('needs-rework'),
    not_ready: count('pending') + count('draft'),
    all_approved,
    signed,
    signer,
    state: signed ? 'signed' : total === 0 ? 'empty' : all_approved ? 'ready' : 'open',
    changed_since_signed,
    removed,
    notes,
  } as GateStatus);
}

/** Every gate's status, in project order. */
export function gateStatuses(p: AkukoProject): GateStatus[] {
  return (p.gates ?? []).map((g) => gateStatus(p, g.id));
}

// ─────────────────────────────────────────────────────────────────────────
// Sign-off
// ─────────────────────────────────────────────────────────────────────────

export type SignoffRefusal =
  | 'unknown-gate'      // no gate with that id
  | 'unknown-person'    // `by` is not in people[]
  | 'wrong-role'        // the person exists but has not the gate's role (signoff)
  | 'already-signed'    // the gate has a sign-off; --replace to re-sign
  | 'bad-input';        // empty via, a malformed time, an invalid project after the change

export class GateError extends Error {
  readonly code: SignoffRefusal;
  constructor(code: SignoffRefusal, message: string) {
    super(message);
    this.code = code;
    this.name = 'GateError';
  }
}

function knownGates(p: AkukoProject): string {
  const ids = (p.gates ?? []).map((g) => g.id);
  return ids.length ? ` (gates: ${ids.join(', ')})` : ' (it has no gates)';
}

export interface SignoffInput {
  gate: string;
  /** people[].id of the signer. */
  by: string;
  /** How the sign-off was given: "email", "in person", "shared page", … */
  via: string;
  note?: string;
  /** When it was given; default `now`. ISO timestamp with a zone. */
  at?: string;
  /** Re-sign a gate that is already signed. The old record is kept in the new note. */
  replace?: boolean;
  now?: () => Date;
}

export interface SignoffResult {
  project: AkukoProject;
  record: GateSignature;
  /** The record replaced, when `replace` was used. */
  replaced?: GateSignature;
  /** The gate's status after signing. */
  status: GateStatus;
  /** Not refusals: the gate is signed. Tell the person. */
  warnings: string[];
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** One line that keeps a replaced record readable inside the new record's note. */
export function describeSignature(s: GateSignature): string {
  return `signed by ${s.by} (${s.role}) at ${s.at} via ${s.via}${s.note ? `; note: ${s.note}` : ''}`;
}

/**
 * Record a sign-off on a gate. Refuses (GateError) an unknown gate, an unknown
 * signer, a signer without the gate's role, an already-signed gate (unless
 * `replace`), an empty `via` or a malformed `at`. Returns a new project; the
 * caller writes it (`writeState`). Never called by folding or a view.
 *
 * `replace`: the new record's note ends with "Replaces: <old record>", and the
 * old record's own note (which may name the one it replaced) is carried in it,
 * so the whole chain stays in akuko.json.
 */
export function signGate(project: AkukoProject, input: SignoffInput): SignoffResult {
  const p = structuredClone(project);
  const gate = (p.gates ?? []).find((g) => g.id === input.gate);
  if (!gate) throw new GateError('unknown-gate', `no gate "${input.gate}" in this project${knownGates(p)}`);
  const person = (p.people ?? []).find((x) => x.id === input.by);
  if (!person) {
    const ids = (p.people ?? []).map((x) => `${x.id} (${x.role})`);
    throw new GateError('unknown-person', `no person "${input.by}" in this project's people${ids.length ? ` (people: ${ids.join(', ')})` : ' (it lists nobody: add the signer to people[] with role "signoff" first)'}`);
  }
  if (person.role !== gate.needs) {
    throw new GateError('wrong-role', `${person.name} (${person.id}) is ${person.role === 'approver' ? 'an approver' : person.role}; ${gate.id} needs a person with the "${gate.needs}" role. Day-to-day approvals never pass a gate.`);
  }
  if (gate.signed && !input.replace) {
    throw new GateError('already-signed', `${gate.id} is already ${describeSignature(gate.signed)}. To record a new sign-off, run it again with --replace (the old record is kept in the new note).`);
  }
  const via = input.via.trim();
  if (!via) throw new GateError('bad-input', 'say how the sign-off was given (--via "email", "in person", "shared page", …)');
  const recorded = iso((input.now ?? (() => new Date()))());
  const at = input.at ?? recorded;
  if (!ISO_WITH_ZONE.test(at) || Number.isNaN(Date.parse(at))) throw new GateError('bad-input', `--at must be an ISO timestamp with seconds and a zone, e.g. 2026-11-10T14:30:00Z (got "${at}")`);
  const replaced = gate.signed;
  const parts = [input.note?.trim(), replaced ? `Replaces: ${describeSignature(replaced)}` : undefined].filter((x): x is string => !!x);
  const record: GateSignature = { by: person.id, role: gate.needs, at, via, ...(parts.length ? { note: parts.join(' · ') } : {}) };
  gate.signed = record;
  p.project.updated_at = recorded;
  const parsed = AkukoProjectSchema.safeParse(p);
  if (!parsed.success) throw new GateError('bad-input', `the signed project does not validate: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const issues = checkIntegrity(parsed.data).filter((i) => i.path.startsWith('gates'));
  if (issues.length) throw new GateError('bad-input', `the signed project has integrity issues: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  const status = gateStatus(parsed.data, gate.id);
  const warnings: string[] = [];
  if (status.total === 0) warnings.push(`${gate.id} has nothing in scope yet: the signer signed an empty gate`);
  else if (!status.all_approved) warnings.push(`${gate.id} is signed with ${status.total - status.approved} of ${status.total} items not approved yet (gates don't block work; tell the person)`);
  return { project: parsed.data, record, ...(replaced ? { replaced } : {}), status, warnings };
}
