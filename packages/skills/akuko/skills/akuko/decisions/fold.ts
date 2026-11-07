/**
 * akuko — decision folding (gate G-VIEW, WP-07a).
 *
 * Views write `Decision` records to the host's store; every action reads them
 * (`readDecisions()`) and folds them into `akuko.json` with `foldDecisions()`
 * before doing anything else. Folding is the only code that writes
 * `approved` on a unit, and the only code that moves a `pending_spend` entry
 * to `approved` / `declined`. Rules in prose: lib/state.md §Decision folding.
 *
 * Properties (each one tested in decisions/fold.test.ts):
 *   - idempotent: folding the same decisions again changes nothing;
 *   - order-independent: decisions are applied in one total order, `at` (as
 *     an instant) then `id`, whatever order the store returned them in, and
 *     a decision that arrives late is slotted into place rather than
 *     overriding a later one;
 *   - `undo` reverses exactly the decision it names; an undo of an undo
 *     re-applies the original;
 *   - provenance (R-12): `approve`, `approve-spend` and `undo` count only
 *     from a person (`by` is not an agent name) and from a conformed view
 *     (decisions/conformed.ts). Rejected decisions stay visible: they are kept
 *     in `decisions[]`, listed in the report, and a unit gets an agent comment
 *     "Not applied: …".
 *
 * What lives where, inside the frozen schema:
 *   - Every applied status change leaves a trail comment on the unit,
 *     `{author: 'agent', text: 'Status: <was> → <now>', decision: <id>}`. The
 *     `<was>` part is what makes undo exact: undoing a decision restores the
 *     status the unit had just before it, even if an action revised the unit
 *     in between.
 *   - A person's words (`note`, `request-changes`, `approve` with text) become
 *     a comment authored by `Decision.by`, carrying the decision id.
 *   - A spend decision sets `pending_spend[].status` and `.decision`.
 */

import { canApprove } from '../spend/gate.ts';
import {
  AkukoProjectSchema,
  DecisionSchema,
  STAGES,
  findUnit,
  listUnits,
  type AkukoProject,
  type Comment,
  type Decision,
  type StageId,
  type Unit,
  type UnitStatus,
} from '../schema/akuko-project.ts';
import { CHAT_VIEW, conformedViewIds, type ConformedInput } from './conformed.ts';

// ─────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────

/** Author of the comments folding itself writes (trail + "Not applied" notices). */
export const FOLD_AUTHOR = 'agent';

/** `by` values that name an agent, never a person. Matched case-insensitively, alone or as a prefix (`agent:x`, `claude-code`). */
export const AGENT_AUTHOR = /^(agent|akuko|claude|assistant|system|ai|bot|llm)(?:$|[\s:@/_.-])/i;

export const isAgentAuthor = (by: string): boolean => AGENT_AUTHOR.test(by.trim());

/** The only words a chat spend approval may carry: the spend gate's own reply line (spend/gate.ts#confirmationLine). */
const CHAT_SPEND_WORDS = /^approve \d+(?:\.\d+)? [A-Z]{3}$/;

const TRAIL = /^Status: (pending|draft|pending-review|needs-rework|approved) → (pending|draft|pending-review|needs-rework|approved)$/;
const NOTICE_PREFIX = 'Not applied: ';

/** Statuses a person can decide on: something was produced. */
const REVIEWABLE: ReadonlySet<UnitStatus> = new Set(['pending-review', 'needs-rework', 'approved']);

const STATUS_OF: Partial<Record<Decision['action'], UnitStatus>> = { approve: 'approved', 'request-changes': 'needs-rework' };
const PROVENANCE_ACTIONS: ReadonlySet<Decision['action']> = new Set(['approve', 'approve-spend', 'undo']);
const SPEND_ACTIONS: ReadonlySet<Decision['action']> = new Set(['approve-spend', 'decline-spend']);

export type RejectCode =
  | 'not-a-person'        // an approval / undo authored by an agent
  | 'view-not-conformed'  // an approval / undo from a view that has not passed check-view
  | 'chat-without-words'  // a chat approval not in the exact words akuko asked for
  | 'chat-undo'           // an undo from chat (only a checked view can undo)
  | 'unknown-unit'        // names no unit or job in the project (not stored)
  | 'unknown-target'      // an undo of a decision akuko has not seen (not stored; retried next fold)
  | 'bad-undo'            // undoes a later decision, or one on another unit
  | 'stale-stage'         // the unit has moved to another stage since the person saw it
  | 'not-reviewable'      // nothing to decide on yet (unit pending / draft)
  | 'spend-refused'       // canApprove() refused (budget, amount shown, cap)
  | 'already-ran'         // the job already ran or is running; spend decisions can't change it
  | 'conflict';           // same id as a stored decision with different content (ignored)

export interface Rejection {
  id: string;
  action: Decision['action'];
  unit: string;
  code: RejectCode;
  reason: string;
}

export interface FoldReport {
  /** Decisions read from the store this time (valid records only). */
  read: number;
  /** Ids not seen before this fold. */
  new: string[];
  /** Ids already folded earlier (re-reads are expected: folding is idempotent). */
  duplicates: string[];
  /** New decisions that changed something. */
  applied: string[];
  /** New decisions that did not take effect, with why. Tell the person. */
  rejected: Rejection[];
  /** Whether the returned project differs from the input. */
  changed: boolean;
}

export interface FoldOptions {
  /** Views that passed the conformance check (decisions/conformed.ts). `chat@1` is always included. */
  conformed?: ConformedInput;
}

// ─────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────

const instant = (ts: string): number => Date.parse(ts);

/** The one total order folding uses: `at` as an instant, then `id`. */
export function compareDecisions(a: Pick<Decision, 'at' | 'id'>, b: Pick<Decision, 'at' | 'id'>): number {
  const d = instant(a.at) - instant(b.at);
  if (d !== 0) return d < 0 ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const later = (a: string | undefined, b: string): string => (a === undefined || instant(b) > instant(a) ? b : a);

/** Canonical form (schema key order) so records from different stores compare and serialise identically. */
const canonical = (d: Decision): Decision => DecisionSchema.parse(d);
const sameRecord = (a: Decision, b: Decision): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// ─────────────────────────────────────────────────────────────────────────
// Eligibility + undo resolution (pure functions of the decision set)
// ─────────────────────────────────────────────────────────────────────────

interface Verdict { ok: true }
interface Refused { ok: false; code: RejectCode; reason: string }

function provenance(d: Decision, conformed: Set<string>): Verdict | Refused {
  if (!PROVENANCE_ACTIONS.has(d.action)) return { ok: true };
  if (isAgentAuthor(d.by)) {
    return { ok: false, code: 'not-a-person', reason: `an ${d.action} must come from a person; this one is signed "${d.by}".` };
  }
  if (!conformed.has(d.view)) {
    return { ok: false, code: 'view-not-conformed', reason: `it came from "${d.view}", a view that has not passed the conformance check. Approve again on the board.` };
  }
  if (d.view === CHAT_VIEW) {
    // A chat reply written down by the agent counts only in the exact words akuko asked for.
    const said = (d.text ?? '').trim();
    const words = said.slice(0, 7).toLowerCase() + said.slice(7);
    if (d.action === 'undo') {
      return { ok: false, code: 'chat-undo', reason: 'an undo can only come from a checked view, never from chat.' };
    }
    if (d.action === 'approve' && words !== `approve ${d.unit}`) {
      return { ok: false, code: 'chat-without-words', reason: `a chat approval of ${d.unit} must quote the person's reply "approve ${d.unit}" exactly.` };
    }
    if (d.action === 'approve-spend' && !CHAT_SPEND_WORDS.test(words)) {
      return { ok: false, code: 'chat-without-words', reason: 'a chat spend approval must quote the person\'s reply "approve <amount> <CURRENCY>" exactly.' };
    }
  }
  return { ok: true };
}

interface Resolved {
  eligible: Map<string, Verdict | Refused>;
  /** Decisions reversed by an eligible, not-undone undo. */
  undone: Set<string>;
  /** Effective undo per target (the latest one), for blaming. */
  undoneBy: Map<string, Decision>;
}

function resolve(sorted: Decision[], conformed: Set<string>, refused: Map<string, Refused>): Resolved {
  const byId = new Map(sorted.map((d) => [d.id, d]));
  const eligible = new Map<string, Verdict | Refused>();
  for (const d of sorted) {
    let v = provenance(d, conformed);
    if (v.ok && d.action === 'undo') {
      const t = byId.get(d.undoes);
      if (!t) v = { ok: false, code: 'unknown-target', reason: `it undoes decision ${d.undoes}, which akuko has not seen yet.` };
      else if (compareDecisions(t, d) >= 0) v = { ok: false, code: 'bad-undo', reason: 'it undoes a decision made after it.' };
      else if (t.unit !== d.unit) v = { ok: false, code: 'bad-undo', reason: `it undoes a decision on "${t.unit}", not "${d.unit}".` };
    }
    // An undo folding refused (now, or at an earlier fold: it left a notice) stays refused.
    const r = d.action === 'undo' ? refused.get(d.id) : undefined;
    if (v.ok && r) v = r;
    eligible.set(d.id, v);
  }
  // Undos only point backwards in the total order, so walking from the latest
  // decision down settles each undo before the decision it names.
  const undone = new Set<string>();
  const undoneBy = new Map<string, Decision>();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const d = sorted[i]!;
    if (d.action !== 'undo' || !eligible.get(d.id)?.ok || undone.has(d.id)) continue;
    undone.add(d.undoes);
    if (!undoneBy.has(d.undoes)) undoneBy.set(d.undoes, d);
  }
  return { eligible, undone, undoneBy };
}

const effective = (r: Resolved, d: Decision): boolean => r.eligible.get(d.id)?.ok === true && !r.undone.has(d.id) && d.action !== 'undo';

// ─────────────────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────────────────

interface ChainEntry { id: string; stage: StageId; was: UnitStatus; now: UnitStatus; at: string }

const isTrail = (c: Comment): boolean => c.author === FOLD_AUTHOR && c.decision !== undefined && TRAIL.test(c.text);
const isNotice = (c: Comment): boolean => c.author === FOLD_AUTHOR && c.decision !== undefined && c.text.startsWith(NOTICE_PREFIX);

const trailComment = (e: ChainEntry): Comment => ({ ts: e.at, stage: e.stage, author: FOLD_AUTHOR, text: `Status: ${e.was} → ${e.now}`, decision: e.id });
const noticeComment = (d: Decision, reason: string): Comment => ({ ts: d.at, stage: d.stage, author: FOLD_AUTHOR, text: `${NOTICE_PREFIX}${reason}`, decision: d.id });
const personComment = (d: Decision): Comment => ({ ts: d.at, stage: d.stage, author: d.by, text: d.text ?? '', decision: d.id });

const carriesWords = (d: Decision): boolean =>
  d.action === 'note' || d.action === 'request-changes' || (d.action === 'approve' && (d.text ?? '').trim() !== '');

/** Comments in time order; ties keep their order (people's words, then the trail, then notices). */
function sortComments(cs: Comment[]): Comment[] {
  const rank = (c: Comment) => (isNotice(c) ? 2 : isTrail(c) ? 1 : 0);
  return cs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => instant(a.c.ts) - instant(b.c.ts) || (a.c.decision ?? '').localeCompare(b.c.decision ?? '') || rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

// ─────────────────────────────────────────────────────────────────────────
// The fold
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fold decisions into a project. Returns a new project (the input is not
 * modified) and a report. Pass every decision the store holds, or only the
 * ones since a cursor: decisions already in `project.decisions` are
 * recognised by id. The result is schema-valid and passes `checkIntegrity`.
 */
export function foldDecisions(project: AkukoProject, incoming: Iterable<Decision>, opts: FoldOptions = {}): { project: AkukoProject; report: FoldReport } {
  const conformed = conformedViewIds(opts.conformed);
  const p: AkukoProject = structuredClone(project);
  const report: FoldReport = { read: 0, new: [], duplicates: [], applied: [], rejected: [], changed: false };

  // 1. Merge by id. A stored decision is never replaced.
  const prior = new Map(p.decisions.map((d) => [d.id, canonical(d)]));
  const fresh = new Map<string, Decision>();
  for (const raw of incoming) {
    const d = canonical(raw);
    report.read++;
    const known = prior.get(d.id) ?? fresh.get(d.id);
    if (known) {
      if (sameRecord(known, d)) report.duplicates.push(d.id);
      else {
        // Two new copies of one id that differ: keep the same one whatever order they came in.
        const keepNew = !prior.has(d.id) && JSON.stringify(d) < JSON.stringify(known);
        if (keepNew) fresh.set(d.id, d);
        const dropped = keepNew ? known : d;
        report.rejected.push({ id: d.id, action: dropped.action, unit: dropped.unit, code: 'conflict', reason: 'another decision with this id is already recorded; this copy was ignored.' });
      }
      continue;
    }
    fresh.set(d.id, d);
  }
  const reject = (d: Decision, code: RejectCode, reason: string) => {
    if (fresh.has(d.id) && !report.rejected.some((r) => r.id === d.id)) report.rejected.push({ id: d.id, action: d.action, unit: d.unit, code, reason });
  };

  // Decisions about something the project doesn't have are reported, not stored (integrity).
  const isJob = (id: string) => p.pending_spend.some((j) => j.id === id);
  for (const d of [...fresh.values()]) {
    const target = SPEND_ACTIONS.has(d.action) ? isJob(d.unit) : d.action === 'undo' ? isJob(d.unit) || !!findUnit(p, d.unit) : !!findUnit(p, d.unit);
    if (!target) {
      reject(d, 'unknown-unit', SPEND_ACTIONS.has(d.action) ? `no paid job "${d.unit}" is waiting.` : `no unit "${d.unit}" in this project.`);
      fresh.delete(d.id);
    }
  }
  let all = [...prior.values(), ...fresh.values()].sort(compareDecisions);
  // Undos whose target hasn't arrived: report and keep out until it does.
  for (;;) {
    const ids = new Set(all.map((d) => d.id));
    const orphan = all.find((d) => d.action === 'undo' && fresh.has(d.id) && !ids.has(d.undoes));
    if (!orphan) break;
    reject(orphan, 'unknown-target', `it undoes decision ${(orphan as Extract<Decision, { action: 'undo' }>).undoes}, which akuko has not seen yet; it will be tried again.`);
    fresh.delete(orphan.id);
    all = all.filter((d) => d.id !== orphan.id);
  }
  report.new = [...fresh.keys()].sort((a, b) => compareDecisions(fresh.get(a)!, fresh.get(b)!));
  const priorSorted = [...prior.values()].sort(compareDecisions);

  // Decisions folding refused at an earlier fold (they left a notice).
  const noticed = new Set<string>();
  const refusedUndo = new Map<string, Refused>();
  for (const { unit } of listUnits(p)) {
    for (const c of unit.comments) {
      if (!isNotice(c)) continue;
      noticed.add(c.decision!);
      refusedUndo.set(c.decision!, { ok: false, code: 'stale-stage', reason: 'refused at an earlier fold.' });
    }
  }
  // New undos that can't be honoured whatever else happens: the decision they
  // name belongs to a stage the unit has left, or the job it approved has run.
  const byIdAll = new Map(all.map((d) => [d.id, d]));
  for (const d of fresh.values()) {
    if (d.action !== 'undo') continue;
    const t = byIdAll.get(d.undoes);
    if (!t) continue;
    if (SPEND_ACTIONS.has(t.action)) {
      const job = p.pending_spend.find((j) => j.id === t.unit);
      if (job && p.ledger.some((e) => e.job === job.id && (e.status === 'submitted' || e.status === 'done'))) {
        refusedUndo.set(d.id, { ok: false, code: 'already-ran', reason: `"${job.label}" has already run; money spent can't be un-approved.` });
      }
      continue;
    }
    const ref = findUnit(p, t.unit);
    const tr = ref?.unit.comments.find((c) => isTrail(c) && c.decision === t.id);
    if (ref && tr && tr.stage !== ref.unit.stage) {
      refusedUndo.set(d.id, { ok: false, code: 'stale-stage', reason: `"${t.unit}" has moved on to ${ref.unit.stage}; its ${tr.stage} decision can't be reversed now.` });
    }
  }

  const rNew = resolve(all, conformed, refusedUndo);
  const rOld = resolve(priorSorted, conformed, refusedUndo);
  for (const d of fresh.values()) {
    const v = rNew.eligible.get(d.id);
    if (v && !v.ok) reject(d, v.code, v.reason);
  }

  const applied = new Set<string>();
  const touchedStages = new Set<StageId>();
  const ats: string[] = [...fresh.values()].map((d) => d.at);

  // 2. Units: status chains + comments.
  const byUnit = new Map<string, Decision[]>();
  for (const d of all) if (!SPEND_ACTIONS.has(d.action)) byUnit.set(d.unit, [...(byUnit.get(d.unit) ?? []), d]);

  for (const [unitId, ds] of byUnit) {
    const ref = findUnit(p, unitId);
    if (!ref) continue; // an undo on a job lands here; spend is handled below
    const unit: Unit = ref.unit;
    const notices: Comment[] = [];
    const notice = (d: Decision, code: RejectCode, reason: string) => {
      reject(d, code, reason);
      if (fresh.has(d.id) && !unit.comments.some((c) => isNotice(c) && c.decision === d.id) && !notices.some((c) => c.decision === d.id)) {
        notices.push(noticeComment(d, reason));
        noticed.add(d.id);
      }
    };

    // Refusals by provenance on this unit get a visible notice.
    for (const d of ds) {
      const v = rNew.eligible.get(d.id);
      if (v && !v.ok && fresh.has(d.id) && d.action !== 'undo' && PROVENANCE_ACTIONS.has(d.action)) notice(d, v.code, v.reason);
      if (v && !v.ok && fresh.has(d.id) && d.action === 'undo' && v.code !== 'unknown-target') notice(d, v.code, v.reason);
    }

    // 2a. Status chain for the unit's current stage. Chains of earlier stages are history.
    const trail: ChainEntry[] = [];
    for (const c of unit.comments) {
      const m = isTrail(c) ? TRAIL.exec(c.text) : null;
      if (m) trail.push({ id: c.decision!, stage: c.stage, was: m[1] as UnitStatus, now: m[2] as UnitStatus, at: c.ts });
    }
    const dec = new Map(all.map((d) => [d.id, d]));
    const keyOf = (e: { id: string; at: string }) => dec.get(e.id) ?? { id: e.id, at: e.at };
    const chain = trail.filter((e) => e.stage === unit.stage).sort((a, b) => compareDecisions(keyOf(a), keyOf(b)));
    const inChain = new Set(trail.map((e) => e.id));
    let status = unit.status;
    let chainChanged = false;

    // Removals: entries an effective undo now reverses.
    for (const e of [...trail]) {
      if (!rNew.undone.has(e.id)) continue;
      const undo = rNew.undoneBy.get(e.id)!;
      if (e.stage !== unit.stage) continue; // refused above (stale-stage)
      const i = chain.findIndex((x) => x.id === e.id);
      if (i < 0) continue;
      if (i === chain.length - 1) status = chain[i]!.was;
      else chain[i + 1]!.was = chain[i]!.was;
      chain.splice(i, 1);
      chainChanged = true;
      if (fresh.has(undo.id)) applied.add(undo.id);
    }
    // Inserts: effective status decisions not yet on the trail, in order.
    for (const d of ds) {
      const now = STATUS_OF[d.action];
      if (!now || inChain.has(d.id) || noticed.has(d.id) || !effective(rNew, d)) continue;
      if (d.stage !== unit.stage) {
        notice(d, 'stale-stage', `"${unitId}" is now at ${unit.stage}; this was a decision on its ${d.stage} version.`);
        continue;
      }
      if (!REVIEWABLE.has(unit.status)) {
        notice(d, 'not-reviewable', `"${unitId}" is ${unit.status}: there is nothing to ${d.action === 'approve' ? 'approve' : 'send back'} yet.`);
        continue;
      }
      const pos = chain.findIndex((x) => compareDecisions(keyOf(x), d) > 0);
      const entry: ChainEntry = { id: d.id, stage: d.stage, was: status, now, at: d.at };
      if (pos < 0) {
        entry.was = status;
        status = now;
        chain.push(entry);
      } else {
        entry.was = chain[pos]!.was;
        chain[pos]!.was = now;
        chain.splice(pos, 0, entry);
      }
      chainChanged = true;
      if (fresh.has(d.id)) applied.add(d.id);
    }

    // 2b. People's words.
    const wantWords = new Map<string, Decision>();
    for (const d of ds) if (carriesWords(d) && rNew.eligible.get(d.id)?.ok && !rNew.undone.has(d.id)) wantWords.set(d.id, d);
    const known = new Set(all.map((d) => d.id));
    let comments = unit.comments.filter((c) => {
      if (isTrail(c) || isNotice(c) || c.decision === undefined || !known.has(c.decision)) return true;
      if (wantWords.has(c.decision)) return true;
      const u = rNew.undoneBy.get(c.decision);
      if (u && fresh.has(u.id)) applied.add(u.id);
      return false; // undone
    });
    const wordsChanged = comments.length !== unit.comments.length;
    let added = false;
    for (const d of wantWords.values()) {
      if (comments.some((c) => c.decision === d.id && !isTrail(c) && !isNotice(c))) continue;
      comments.push(personComment(d));
      added = true;
      if (fresh.has(d.id)) applied.add(d.id);
    }

    if (!chainChanged && !wordsChanged && !added && notices.length === 0) continue;
    if (chainChanged) {
      comments = comments.filter((c) => !(isTrail(c) && c.stage === unit.stage));
      comments.push(...chain.map(trailComment));
    }
    comments.push(...notices);
    unit.comments = sortComments(comments);
    if (status !== unit.status) {
      unit.status = status;
      touchedStages.add(unit.stage);
    }
    const rec = unit.by_stage?.[unit.stage];
    if (rec && rec.status !== unit.status) rec.status = unit.status;
  }

  // A unit that received a decision is updated as of the latest decision on
  // it. Computed from the whole recorded set so batching can't change it.
  for (const id of new Set([...fresh.values()].map((d) => d.unit))) {
    const u = findUnit(p, id)?.unit;
    if (!u) continue;
    for (const d of all) if (d.unit === id) u.updated_at = later(u.updated_at, d.at);
  }

  // 3. Spend: the latest effective spend decision per job sets the entry.
  for (const job of p.pending_spend) {
    const latest = (r: Resolved, list: Decision[]) =>
      list.filter((d) => d.unit === job.id && SPEND_ACTIONS.has(d.action) && effective(r, d)).at(-1);
    const was = latest(rOld, priorSorted);
    const now = latest(rNew, all);
    if (was?.id === now?.id) continue;
    // Only a new decision on this job moves it (never a change of the conformed list alone).
    const cause = [...fresh.values()].filter((d) => d.unit === job.id).sort(compareDecisions).at(-1);
    if (!cause) continue;
    const ran = p.ledger.some((e) => e.job === job.id && (e.status === 'submitted' || e.status === 'done'));
    if (ran) {
      reject(cause, 'already-ran', `"${job.label}" has already run (or is running); a spend decision can't change it now.`);
      continue;
    }
    if (!now) {
      job.status = 'awaiting-approval';
      delete job.decision;
    } else if (now.action === 'approve-spend') {
      const refusal = canApprove(p, job.id, now);
      if (refusal) {
        reject(now, 'spend-refused', refusal.message);
        continue;
      }
      job.status = 'approved';
      job.decision = now.id;
    } else {
      job.status = 'declined';
      job.decision = now.id;
    }
    touchedStages.add(job.stage);
    if (fresh.has(cause.id)) applied.add(cause.id);
  }

  // 4. Stages: approved only when every unit in it is approved.
  if (touchedStages.size > 0) recomputeStages(p, touchedStages);

  // 5. Record every decision read (rejected ones too, so people can see them), in order.
  p.decisions = all;
  report.applied = [...applied].sort((a, b) => compareDecisions(fresh.get(a)!, fresh.get(b)!));
  report.rejected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  report.changed = JSON.stringify(p) !== JSON.stringify(project);
  if (report.changed) for (const at of ats) p.project.updated_at = later(p.project.updated_at, at);
  return { project: AkukoProjectSchema.parse(p), report };
}

/** Stage gating after units changed (lib/state.md §Stages): approve / re-open, then unlock and move `current_stage`. */
function recomputeStages(p: AkukoProject, touched: Set<StageId>): void {
  const units = listUnits(p).map((u) => u.unit);
  for (const s of touched) {
    const inStage = units.filter((u) => u.stage === s);
    if (inStage.length === 0) continue;
    const all = inStage.every((u) => u.status === 'approved');
    const rec = p.stages[s];
    if (all && rec.state !== 'approved') rec.state = 'approved';
    else if (!all && rec.state === 'approved') rec.state = 'in-review';
  }
  let open = true;
  for (const { id } of STAGES) {
    const rec = p.stages[id];
    if (open && rec.state === 'locked') rec.state = 'not-started';
    if (rec.state !== 'approved') open = false;
  }
  p.current_stage = STAGES.find(({ id }) => p.stages[id].state !== 'approved')?.id ?? 'export';
}
