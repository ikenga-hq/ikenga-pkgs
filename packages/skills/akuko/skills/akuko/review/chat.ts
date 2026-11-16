/**
 * akuko — review in chat (actions/review.md §1b "Review in chat").
 *
 * The person approves or sends back what is waiting without opening the board:
 * the agent shows one unit at a time (or one confirmed list), asks with the exact
 * replies, and records the person's answer as ordinary `chat@1` decisions, which
 * folding applies like any other. Only the person's exact words count (R-12):
 * nothing is inferred, nothing is approved by the agent.
 *
 *   node --experimental-strip-types review/chat.ts <command> [options]
 *
 *   next   (--project <dir> | --project-file <akuko.json>) [--stage <stage>] [--kind <kind>] [--skip <unit> …]
 *          The oldest unit waiting for review (pending-review), with its name, what it
 *          is, its file (and path on disk, B/C), any open quality flags, how many are
 *          left, and the exact replies: "approve <unit>", "send back <unit>".
 *          --kind is an asset kind (plate, portrait, …) or shot / character / location / style.
 *   decide (--project <dir> | --project-file <akuko.json> --out <file>) --unit <id>
 *          --action approve|send-back [--said "<the reply, verbatim>"] [--text "<their words>"]
 *          [--by <person>] (default "you") [--via chat]
 *          approve   → one approve (and a dismiss-flag for each open flag on the unit,
 *                      which the approval overrules: the same path as flags.ts decide);
 *                      --said must be exactly "approve <unit>".
 *          send-back → one request-changes with the person's own words (--text, required).
 *   batch  (--project <dir> | --project-file <akuko.json> [--out <file>]) --scope bible|part:<id> [--kind <kind>]
 *          [--said "<the reply, verbatim>"] [--by <person>]
 *          Without --said: the list a confirmed batch would approve (every unit, its
 *          file and path), what it leaves out and why, the count, and the one exact
 *          reply that confirms it ("approve all <N> <scope words>"). Writes nothing.
 *          With --said: recomputes the list; only that exact reply (same N) records one
 *          approve per listed unit, text "<reply> · batch <uuid>" (views/contract.md §4),
 *          and folds. Folding refuses the whole batch unless all N records are there.
 *
 * Every write is folded in memory first; if folding would refuse any decision,
 * nothing is written (`refused`). Each command prints one JSON object; exit 1 on a refusal.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost } from '../hosts/local.ts';
import { CHAT_VIEW } from '../decisions/conformed.ts';
import { isAgentAuthor } from '../decisions/fold.ts';
import { AkukoProjectSchema, DecisionSchema, StageIdSchema, findUnit, listUnits, removedAt, type AkukoProject, type Decision, type Unit, type UnitKind } from '../schema/akuko-project.ts';
import { locate } from '../rules/refs.ts';
import { batchUnits, isIdleMotionUnit } from '../scripts/check-view/expected.mjs';
import { currentFile, FlagError, recordChat, unitApproval } from './flags.ts';

export type ChatChoice = 'approve' | 'send-back';
export const CHAT_CHOICES: readonly ChatChoice[] = ['approve', 'send-back'];

/** The exact replies to offer for one unit. */
export const unitReplies = (unit: string): Record<ChatChoice, string> => ({ approve: `approve ${unit}`, 'send-back': `send back ${unit}` });

/** What `--kind` matches: an asset's kind, else the unit's kind (shot, character, location, style). */
const kindOf = (kind: UnitKind, u: Unit): string => (kind === 'asset' ? (u as unknown as { kind: string }).kind : kind);

const openFlagsOf = (u: Unit) => (u.by_stage?.[u.stage]?.flags ?? []).filter((f) => f.status === 'open');

export interface Waiting {
  unit: string;
  unit_kind: UnitKind;
  kind: string;
  name: string;
  what?: string;
  stage: Unit['stage'];
  status: Unit['status'];
  file?: string;
  path?: string;
  open_flags: { id: string; severity: string; kind: string; text: string; suggested_change?: string }[];
}

function describe(p: AkukoProject, kind: UnitKind, u: Unit, projectDir?: string): Waiting {
  const f = currentFile(u);
  const at = f && projectDir !== undefined ? locate(f.uri, projectDir) : undefined;
  const x = u as { name?: string; label?: string; action?: string; description?: string; summary?: string };
  return {
    unit: u.id,
    unit_kind: kind,
    kind: kindOf(kind, u),
    name: x.name ?? x.label ?? u.id,
    ...(x.action ?? x.description ?? x.summary ? { what: x.action ?? x.description ?? x.summary } : {}),
    stage: u.stage,
    status: u.status,
    ...(f ? { file: f.uri } : {}),
    ...(at?.kind === 'path' ? { path: at.path } : {}),
    open_flags: openFlagsOf(u).map((fl) => ({ id: fl.id, severity: fl.severity, kind: fl.kind, text: fl.text, ...(fl.suggested_change ? { suggested_change: fl.suggested_change } : {}) })),
  };
}

/** Units waiting for review, oldest first (updated_at, then id). */
export function waitingUnits(p: AkukoProject, opts: { stage?: string; kind?: string } = {}): { kind: UnitKind; unit: Unit }[] {
  const t = (u: Unit) => Date.parse(u.updated_at ?? '1970-01-01T00:00:00Z');
  return listUnits(p)
    .filter(({ kind, unit }) => unit.status === 'pending-review' && removedAt(p, unit) === undefined && !(kind === 'asset' && isIdleMotionUnit(p, unit as never)))
    .filter(({ unit }) => opts.stage === undefined || unit.stage === opts.stage)
    .filter(({ kind, unit }) => opts.kind === undefined || kindOf(kind, unit) === opts.kind)
    .sort((a, b) => (t(a.unit) - t(b.unit)) || (a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0));
}

export interface NextUnit extends Waiting {
  remaining: number;
  replies: Record<ChatChoice, string>;
}

export function nextUnit(p: AkukoProject, opts: { stage?: string; kind?: string; skip?: string[]; projectDir?: string } = {}): NextUnit | undefined {
  const skip = new Set(opts.skip ?? []);
  const list = waitingUnits(p, opts).filter(({ unit }) => !skip.has(unit.id));
  const first = list[0];
  if (!first) return undefined;
  return { ...describe(p, first.kind, first.unit, opts.projectDir), remaining: list.length - 1, replies: unitReplies(first.unit.id) };
}

/** The decision(s) a person's chat reply about one unit stands for. Writes nothing. */
export function decideUnit(p: AkukoProject, input: { unit: string; action: ChatChoice; said?: string; text?: string; by?: string; at?: string; ids?: string[] }): Decision[] {
  const ref = findUnit(p, input.unit);
  if (!ref) throw new FlagError('unknown-unit', `no unit "${input.unit}" in this project.`);
  if (input.action === 'approve') return unitApproval(p, input);
  if (input.action !== 'send-back') throw new FlagError('invalid', `--action is one of ${CHAT_CHOICES.join(', ')}.`);
  const by = input.by?.trim() || 'you';
  if (isAgentAuthor(by)) throw new FlagError('not-a-person', `"${by}" is an agent name: only the person sends a unit back.`);
  const text = input.text?.trim();
  if (!text) throw new FlagError('invalid', 'a send-back needs what should change, in the person\'s own words (--text).');
  const u = ref.unit;
  return [DecisionSchema.parse({ id: input.ids?.[0] ?? randomUUID(), unit: u.id, stage: u.stage, by, at: input.at ?? new Date().toISOString(), view: CHAT_VIEW, action: 'request-changes', text })];
}

// ─────────────────────────────────────────────────────────────────────────
// Confirmed batch from chat
// ─────────────────────────────────────────────────────────────────────────

const plural: Record<string, string> = { character: 'characters', location: 'locations', style: 'styles', shot: 'shots' };

export interface BatchPreview {
  scope: string;
  kind?: string;
  count: number;
  units: Waiting[];
  left_out: { unit: string; why: string }[];
  /** The one exact reply that confirms this list. */
  reply: string;
}

/**
 * What a confirmed batch in this scope would approve: the board's rule
 * (scripts/check-view/expected.mjs#batchUnits — waiting for review, no unit sent
 * back, no asset without a file, no open block flag), narrowed to `kind`.
 */
export function batchPreview(p: AkukoProject, scope: string, opts: { kind?: string; projectDir?: string } = {}): BatchPreview {
  if (scope !== 'bible' && !/^part:[A-Za-z0-9_.-]+$/.test(scope)) throw new FlagError('invalid', '--scope is bible or part:<part id>.');
  const ids = new Set<string>(batchUnits(p as never, scope));
  const all = listUnits(p);
  const picked = all.filter(({ unit }) => ids.has(unit.id)).filter(({ kind, unit }) => opts.kind === undefined || kindOf(kind, unit) === opts.kind);
  const pickedIds = new Set(picked.map(({ unit }) => unit.id));
  // What the batch leaves out, and why: waiting units it would take but for an open block flag or a missing file.
  const bare: AkukoProject = structuredClone(p);
  for (const { unit } of listUnits(bare)) for (const r of Object.values(unit.by_stage ?? {})) if (r) delete r.flags;
  for (const a of bare.assets) a.file ??= { uri: 'x' };
  const left_out = all
    .filter(({ unit }) => batchUnits(bare as never, scope).includes(unit.id) && !pickedIds.has(unit.id))
    .filter(({ kind, unit }) => opts.kind === undefined || kindOf(kind, unit) === opts.kind)
    .map(({ unit }) => ({ unit: unit.id, why: openFlagsOf(unit).some((f) => f.severity === 'block') ? 'open block flag: decide on it on its own' : 'no file yet' }));
  const label = scope === 'bible' ? `bible ${opts.kind ? plural[opts.kind] ?? `${opts.kind}s` : 'items'}` : `shots in ${scope.slice(5)}`;
  return { scope, ...(opts.kind ? { kind: opts.kind } : {}), count: picked.length, units: picked.map(({ kind, unit }) => describe(p, kind, unit, opts.projectDir)), left_out, reply: `approve all ${picked.length} ${label}` };
}

/** The approvals the person's one batch reply stands for. Refuses anything but the exact reply for the list as it is now. */
export function batchDecisions(p: AkukoProject, input: { scope: string; kind?: string; said?: string; by?: string; at?: string; batch?: string; ids?: string[] }): Decision[] {
  const pv = batchPreview(p, input.scope, { kind: input.kind });
  if (pv.count === 0) throw new FlagError('invalid', 'nothing in this scope is waiting for a batch approval.');
  const by = input.by?.trim() || 'you';
  if (isAgentAuthor(by)) throw new FlagError('not-a-person', `"${by}" is an agent name: only the person approves.`);
  const said = (input.said ?? '').trim();
  const words = said.slice(0, 11).toLowerCase() + said.slice(11);
  if (words !== pv.reply) {
    throw new FlagError('not-exact', `a chat batch counts only on the exact reply "${pv.reply}" for the list as it is now${said ? `, not "${said}"` : ''}. Show the list again and ask again; never infer it.`);
  }
  const batch = input.batch ?? randomUUID();
  const at = input.at ?? new Date().toISOString();
  const ids = [...(input.ids ?? [])];
  return pv.units.map((w) => DecisionSchema.parse({ id: ids.shift() ?? randomUUID(), unit: w.unit, stage: w.stage, by, at, view: CHAT_VIEW, action: 'approve', text: `${said} · batch ${batch}` }));
}

// ─────────────────────────────────────────────────────────────────────────
// Command line
// ─────────────────────────────────────────────────────────────────────────

function args(argv: string[]) {
  const [cmd = '', ...rest] = argv;
  const opt: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    (opt[a.slice(2)] ??= []).push(rest[++i] ?? '');
  }
  return { cmd, opt };
}

export interface CliResult { code: number; out: unknown }

export async function run(argv: string[]): Promise<CliResult> {
  const { cmd, opt } = args(argv);
  const one = (k: string) => opt[k]?.[0];
  const dir = one('project');
  const file = one('project-file');
  if (!['next', 'decide', 'batch'].includes(cmd)) return { code: 2, out: { ok: false, usage: 'chat.ts next|decide|batch (--project <dir> | --project-file <akuko.json> [--out <file>]) …' } };
  if (!dir && !file) return { code: 2, out: { ok: false, message: 'give --project <dir> (hosts B, C) or --project-file <akuko.json> (host A)' } };
  const p = dir ? await createLocalHost({ projectDir: dir }).readState() : AkukoProjectSchema.parse(JSON.parse(readFileSync(file!, 'utf8')));
  const ctx = { dir, out: one('out'), conformed: opt.conformed };
  try {
    const via = one('via') ?? 'chat';
    if (via !== 'chat') throw new FlagError('invalid', '--via is chat: a decision made on the board arrives from the board.');
    if (cmd === 'next') {
      const stage = one('stage') === undefined ? undefined : StageIdSchema.parse(one('stage'));
      const n = nextUnit(p, { stage, kind: one('kind'), skip: (opt.skip ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean), projectDir: dir });
      if (!n) return { code: 0, out: { ok: true, done: true, remaining: 0, message: 'Nothing is waiting for review.' } };
      const ask = n.open_flags.length
        ? `It has open flags: put each to the person first (flags.ts next / decide), or offer: ${n.replies.approve} (also dismisses its open flags) · ${n.replies['send-back']} + their words.`
        : `Offer exactly: ${n.replies.approve} · ${n.replies['send-back']} + their words. Record with: chat.ts decide --unit ${n.unit} --action approve|send-back --said "<their reply>" [--text "<their words>"]`;
      return { code: 0, out: { ok: true, done: false, ...n, ask } };
    }
    if (cmd === 'decide') {
      const unit = one('unit');
      const action = one('action') as ChatChoice | undefined;
      if (!unit) throw new FlagError('invalid', 'decide needs --unit <id>.');
      if (!action || !CHAT_CHOICES.includes(action)) throw new FlagError('invalid', `--action is one of ${CHAT_CHOICES.join(', ')}.`);
      const ds = decideUnit(p, { unit, action, said: one('said'), text: one('text'), by: one('by'), at: one('at') });
      return { code: 0, out: await recordChat(p, ds, ctx) };
    }
    const scope = one('scope');
    if (!scope) throw new FlagError('invalid', 'batch needs --scope bible|part:<id>.');
    if (one('said') === undefined) {
      const pv = batchPreview(p, scope, { kind: one('kind'), projectDir: dir });
      return { code: 0, out: { ok: true, ...pv, ask: pv.count ? `Show every unit listed (the pictures), say what is left out, then ask. Only the exact reply "${pv.reply}" confirms it: chat.ts batch --scope ${scope}${one('kind') ? ` --kind ${one('kind')}` : ''} --said "<their reply>"` : 'Nothing to batch.' } };
    }
    const ds = batchDecisions(p, { scope, kind: one('kind'), said: one('said'), by: one('by'), at: one('at') });
    return { code: 0, out: await recordChat(p, ds, ctx) };
  } catch (e) {
    if (e instanceof FlagError) return { code: 1, out: { ok: false, code: e.code, message: e.message } };
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((r) => { console.log(JSON.stringify(r.out, null, 2)); process.exitCode = r.code; }, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
