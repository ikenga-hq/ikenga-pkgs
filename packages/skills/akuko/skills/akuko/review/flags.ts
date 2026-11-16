/**
 * akuko — AI quality flags (lib/state.md §Quality flags).
 *
 * After the agent ingests a file and looks at it against the bible (wardrobe,
 * proportions, the house style and its negatives, the project rules), it may
 * record what it sees wrong as a flag on the unit's current stage record
 * (`by_stage[<stage>].flags`). The board shows open flags; only the person acts
 * on one ("Send back with this", "Dismiss", "Note"), through ordinary decisions
 * that folding turns into the flag's status (decisions/fold.ts, step 2c).
 *
 * A flag NEVER changes a unit's status, comments, stage or spend, never sends
 * anything back and never approves anything. Writing one is the agent's own
 * observation, so it needs no OK; closing one is always the person's.
 *
 *   node --experimental-strip-types review/flags.ts <command> [options]
 *
 *   add   (--project <dir> | --project-file <akuko.json> --out <file>)
 *         --unit <id> --kind <kind> --text "<what is wrong>"
 *         [--severity info|warn|block] (default warn)
 *         [--suggest "<words a send-back could use>"]
 *         [--source "<agent id/model>"] (default "agent")
 *         [--uri <file>] [--sha256 <hex>] [--asset <id>] [--view <front|side|…>] [--region x,y,w,h]
 *         [--stage <stage>] (default and only allowed value: the unit's stage)
 *       Evidence defaults to the unit's own file (an asset's `file`, else the
 *       stage record's `output`); the sha256 is hashed from disk when the file is
 *       there (B/C), else taken from `file.hash`. Refuses a unit with nothing
 *       produced yet, a unit removed from the sheet, and an open flag that says
 *       the same thing about the same file (so re-running a check is safe).
 *   list  (--project <dir> | --project-file <akuko.json>) [--unit <id>] [--all]
 *         Open flags (with --all: every flag), with `earlier_take: true` when the
 *         unit's file has changed since the flag was raised.
 *   clear (--project <dir> | --project-file <akuko.json> --out <file>) (--flag <id> … | --unit <id>)
 *         Withdraw open flags the agent raised by mistake, or that a new take
 *         made moot. Never removes a flag a person closed (accepted / dismissed):
 *         those are the record.
 *
 *   next  (--project <dir> | --project-file <akuko.json>) [--skip <flag id> …]
 *         The oldest open flag: its unit and status, the evidence file (and its
 *         path on disk, B/C), the text and the suggested change, how many are
 *         left, and the exact replies to offer the person (chatReplies).
 *   decide (--project <dir> | --project-file <akuko.json> --out <file>) --flag <id>
 *         --action approve|send-back|dismiss [--said "<the person's reply, verbatim>"]
 *         [--text "<send-back words>"] [--by <person>] (default "you") [--via chat]
 *         Records the person's chat reply as Decision(s) stamped `chat@1`, then folds:
 *           approve   → approve the unit + dismiss-flag; --said must be "approve <unit>"
 *           send-back → request-changes carrying the flag; text = --text, else the suggestion
 *           dismiss   → dismiss-flag; --said must be "dismiss <flag>"
 *         Anything else is refused (`not-exact`) and nothing is written: never infer a
 *         reply. B/C append to decisions.jsonl and fold into akuko.json; A writes the
 *         folded project to --out and prints the rows to set in `decisions`.
 *
 * Host A: ArtifactData `get` `akuko/project` → file, run with --project-file /
 * --out, then `set` it back with `if_version` (actions/review.md §Quality flags).
 * Each command prints one JSON object; exit 1 on a refusal.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost } from '../hosts/local.ts';
import {
  AkukoProjectSchema,
  DecisionSchema,
  FlagEvidenceSchema,
  FlagKindSchema,
  FlagSchema,
  FlagSeveritySchema,
  SHA256_PATTERN,
  StageIdSchema,
  findUnit,
  listUnits,
  removedAt,
  type AkukoProject,
  type Decision,
  type Flag,
  type FlagEvidence,
  type FlagKind,
  type FlagSeverity,
  type StageId,
  type Unit,
  type UnitKind,
} from '../schema/akuko-project.ts';
import { locate, sha256FileSync } from '../rules/refs.ts';
import { conformedFrom } from '../decisions/cli.ts';
import { CHAT_VIEW } from '../decisions/conformed.ts';
import { foldDecisions, isAgentAuthor } from '../decisions/fold.ts';
import { appendDecisions, readJsonlStore } from '../decisions/jsonl.ts';

export type FlagErrorCode = 'unknown-unit' | 'removed' | 'stale-stage' | 'nothing-produced' | 'no-evidence' | 'duplicate' | 'unknown-flag' | 'closed' | 'invalid' | 'not-a-person' | 'not-exact' | 'refused';

export class FlagError extends Error {
  readonly code: FlagErrorCode;
  constructor(code: FlagErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'FlagError';
  }
}

/** A new flag id: `flag_` + 12 random hex characters. */
export const newFlagId = (): string => `flag_${randomBytes(6).toString('hex')}`;

export interface NewFlag {
  unit: string;
  kind: FlagKind;
  text: string;
  severity?: FlagSeverity;
  stage?: StageId;
  suggested_change?: string;
  source?: string;
  evidence?: Partial<FlagEvidence>;
}

export interface AddOptions {
  /** When the flag is raised (default: now). */
  now?: string;
  /** Id to use (tests); default newFlagId(). */
  id?: string;
  /** sha256 of a uri when it can be read here (B/C: the project folder), else undefined. */
  hashOf?: (uri: string) => string | undefined;
}

/** What a unit's current file is: an asset's `file`, else what its current stage recorded as `output`. */
export function currentFile(u: Unit): { uri: string; hash?: string } | undefined {
  const f = (u as { file?: { uri: string; hash?: string } }).file ?? u.by_stage?.[u.stage]?.output;
  return f?.uri ? f : undefined;
}

const REVIEWABLE = new Set(['pending-review', 'needs-rework', 'approved']);

/** Hash a project file from disk when it is there (B/C). */
export const diskHasher = (projectDir: string) => (uri: string): string | undefined => {
  const at = locate(uri, projectDir);
  if (at.kind !== 'path' || !existsSync(at.path)) return undefined;
  try { return sha256FileSync(at.path); } catch { return undefined; }
};

/**
 * Add a flag to a unit's current stage record. Returns a new project (the
 * input is not modified). The unit's status, comments and stage are untouched.
 */
export function addFlag(project: AkukoProject, nf: NewFlag, opts: AddOptions = {}): { project: AkukoProject; flag: Flag } {
  const p: AkukoProject = structuredClone(project);
  const ref = findUnit(p, nf.unit);
  if (!ref) throw new FlagError('unknown-unit', `no unit "${nf.unit}" in this project.`);
  const u = ref.unit;
  if (removedAt(p, u) !== undefined) throw new FlagError('removed', `"${u.id}" was removed from the shot list; it takes no review.`);
  const stage = nf.stage ?? u.stage;
  if (stage !== u.stage) throw new FlagError('stale-stage', `"${u.id}" is at ${u.stage}; flag what that stage produced, not ${stage}.`);
  if (!REVIEWABLE.has(u.status)) throw new FlagError('nothing-produced', `"${u.id}" is ${u.status}: nothing has been produced to flag yet.`);

  const file = currentFile(u);
  const uri = nf.evidence?.uri ?? file?.uri;
  if (!uri) throw new FlagError('no-evidence', `"${u.id}" has no file of its own; say which file you looked at (--uri).`);
  const sameFile = file?.uri === uri;
  const sha = nf.evidence?.sha256 ?? opts.hashOf?.(uri) ?? (sameFile && file?.hash && SHA256_PATTERN.test(file.hash) ? file.hash : undefined);
  const asset = nf.evidence?.asset ?? (ref.kind === 'asset' && sameFile ? u.id : undefined);
  const evidence: FlagEvidence = FlagEvidenceSchema.parse({
    uri,
    ...(sha ? { sha256: sha } : {}),
    ...(asset ? { asset } : {}),
    ...(nf.evidence?.view ? { view: nf.evidence.view } : {}),
    ...(nf.evidence?.region ? { region: nf.evidence.region } : {}),
  });

  const rec = (u.by_stage ??= {})[stage] ??= { status: u.status };
  const flags = (rec.flags ??= []);
  const text = nf.text.trim();
  const dup = flags.find((f) => f.status === 'open' && f.kind === nf.kind && f.text === text && f.evidence.uri === evidence.uri && f.evidence.sha256 === evidence.sha256 && f.evidence.view === evidence.view);
  if (dup) throw new FlagError('duplicate', `${dup.id} already says this about the same file.`);

  const ts = opts.now ?? new Date().toISOString();
  const parsed = FlagSchema.safeParse({
    id: opts.id ?? newFlagId(),
    ts,
    stage,
    kind: nf.kind,
    severity: nf.severity ?? 'warn',
    text,
    evidence,
    ...(nf.suggested_change?.trim() ? { suggested_change: nf.suggested_change.trim() } : {}),
    source: nf.source?.trim() || 'agent',
    status: 'open',
  });
  if (!parsed.success) throw new FlagError('invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const flag = parsed.data;
  if (listUnits(p).some(({ unit }) => Object.values(unit.by_stage ?? {}).some((r) => r?.flags?.some((f) => f.id === flag.id)))) {
    throw new FlagError('invalid', `flag id ${flag.id} is already used.`);
  }
  flags.push(flag);
  return { project: AkukoProjectSchema.parse(p), flag };
}

export interface ListedFlag {
  unit: string;
  unit_kind: UnitKind;
  unit_status: Unit['status'];
  flag: Flag;
  /** The unit's file has changed since the flag was raised: it is about an earlier take. */
  earlier_take: boolean;
}

/** Flags in the project, open ones only unless `all`. */
export function listFlags(p: AkukoProject, opts: { unit?: string; all?: boolean } = {}): ListedFlag[] {
  const out: ListedFlag[] = [];
  for (const { kind, unit } of listUnits(p)) {
    if (opts.unit !== undefined && unit.id !== opts.unit) continue;
    const file = currentFile(unit);
    for (const rec of Object.values(unit.by_stage ?? {})) {
      for (const f of rec?.flags ?? []) {
        if (!opts.all && f.status !== 'open') continue;
        const earlier = !!(f.evidence.sha256 && file?.hash && SHA256_PATTERN.test(file.hash) && f.evidence.uri === file.uri && f.evidence.sha256 !== file.hash)
          || !!(file && f.evidence.uri !== file.uri && f.evidence.asset === unit.id);
        out.push({ unit: unit.id, unit_kind: kind, unit_status: unit.status, flag: f, earlier_take: earlier });
      }
    }
  }
  return out;
}

/** Withdraw open flags (by id, or every open flag on a unit). A closed flag is never removed. */
export function clearFlags(project: AkukoProject, which: { ids?: string[]; unit?: string }): { project: AkukoProject; cleared: Flag[] } {
  const p: AkukoProject = structuredClone(project);
  const ids = new Set(which.ids ?? []);
  if (!ids.size && which.unit === undefined) throw new FlagError('unknown-flag', 'name the flags to clear (--flag) or a unit (--unit).');
  if (which.unit !== undefined && !findUnit(p, which.unit)) throw new FlagError('unknown-unit', `no unit "${which.unit}" in this project.`);
  const found = new Set<string>();
  const cleared: Flag[] = [];
  for (const { unit } of listUnits(p)) {
    for (const rec of Object.values(unit.by_stage ?? {})) {
      if (!rec?.flags) continue;
      for (const f of rec.flags) {
        const hit = ids.has(f.id) || (which.unit === unit.id && !ids.size);
        if (!hit) continue;
        found.add(f.id);
        if (f.status !== 'open') {
          if (ids.has(f.id)) throw new FlagError('closed', `${f.id} was ${f.status} by a person (decision ${f.decision}); it stays as the record.`);
          continue;
        }
        cleared.push(f);
      }
      const gone = new Set(cleared.map((f) => f.id));
      rec.flags = rec.flags.filter((f) => !gone.has(f.id));
      if (rec.flags.length === 0) delete rec.flags;
    }
  }
  const missing = [...ids].filter((id) => !found.has(id));
  if (missing.length) throw new FlagError('unknown-flag', `no flag ${missing.join(', ')} in this project.`);
  return { project: AkukoProjectSchema.parse(p), cleared };
}

// ─────────────────────────────────────────────────────────────────────────
// Acting on a flag from chat (actions/review.md §3b "In chat")
// ─────────────────────────────────────────────────────────────────────────

/** The three choices put to the person for one flag. */
export type FlagChoice = 'approve' | 'send-back' | 'dismiss';
export const FLAG_CHOICES: readonly FlagChoice[] = ['approve', 'send-back', 'dismiss'];

/**
 * The exact replies that count for each choice (lib/state.md R-12): "approve <unit>"
 * approves the unit as it is and dismisses the flag; "dismiss <flag>" dismisses it;
 * "send back <flag>" sends the unit back with the suggestion (or the person's own words).
 * Offer them as the answer labels, so the person's pick IS the exact words.
 */
export const chatReplies = (unit: string, flag: string): Record<FlagChoice, string> => ({
  approve: `approve ${unit}`,
  'send-back': `send back ${flag}`,
  dismiss: `dismiss ${flag}`,
});

/** First word in any case, the rest exactly (the same rule fold.ts applies to chat@1). */
const sameWords = (said: string, want: string): boolean => {
  const s = said.trim();
  const n = want.indexOf(' ');
  return s.slice(0, n).toLowerCase() + s.slice(n) === want;
};

function findFlag(p: AkukoProject, id: string): ListedFlag {
  const hit = listFlags(p, { all: true }).find((l) => l.flag.id === id);
  if (!hit) throw new FlagError('unknown-flag', `no flag ${id} in this project.`);
  return hit;
}

export interface NextFlag extends ListedFlag {
  /** Open flags left after this one (not counting skipped ones). */
  remaining: number;
  /** Where the evidence file is on disk (B/C), when it is a local file. */
  path?: string;
  /** The exact replies to offer (chatReplies). */
  replies: Record<FlagChoice, string>;
}

/**
 * The oldest open flag (by when it was raised, then id), skipping `skip`, with what
 * to show the person and the replies to offer. undefined when none is left.
 */
export function nextFlag(p: AkukoProject, opts: { skip?: string[]; projectDir?: string } = {}): NextFlag | undefined {
  const skip = new Set(opts.skip ?? []);
  const open = listFlags(p).filter((l) => !skip.has(l.flag.id))
    .sort((a, b) => (Date.parse(a.flag.ts) - Date.parse(b.flag.ts)) || (a.flag.id < b.flag.id ? -1 : a.flag.id > b.flag.id ? 1 : 0));
  const first = open[0];
  if (!first) return undefined;
  const at = opts.projectDir !== undefined ? locate(first.flag.evidence.uri, opts.projectDir) : undefined;
  return { ...first, remaining: open.length - 1, ...(at?.kind === 'path' ? { path: at.path } : {}), replies: chatReplies(first.unit, first.flag.id) };
}

export interface DecideInput {
  flag: string;
  action: FlagChoice;
  /** The person's reply, verbatim. Required for approve and dismiss: it must be the exact words (chatReplies). */
  said?: string;
  /** send-back: the words to send (default: the flag's suggested_change). */
  text?: string;
  /** Who replied (default "you"); never an agent name. */
  by?: string;
  at?: string;
  /** Decision ids to use (tests); default random UUIDs. */
  ids?: string[];
}

/**
 * The Decision(s) a person's chat reply to a flag stands for, stamped `chat@1`.
 * Writes nothing: the caller appends and folds them. Refuses anything that is not
 * the person's explicit reply — nothing is inferred.
 */
export function decideFlag(p: AkukoProject, input: DecideInput): Decision[] {
  const { unit, flag } = findFlag(p, input.flag);
  if (flag.status !== 'open') throw new FlagError('closed', `${flag.id} was already ${flag.status} by a person (decision ${flag.decision}).`);
  const by = input.by?.trim() || 'you';
  if (isAgentAuthor(by)) throw new FlagError('not-a-person', `"${by}" is an agent name: only the person decides on a flag.`);
  const replies = chatReplies(unit, flag.id);
  const ids = [...(input.ids ?? [])];
  const base = () => ({ id: ids.shift() ?? randomUUID(), unit, stage: flag.stage, by, at: input.at ?? new Date().toISOString(), view: CHAT_VIEW });
  if (input.action === 'send-back') {
    const text = input.text?.trim() || flag.suggested_change;
    if (!text) throw new FlagError('invalid', `${flag.id} has no suggested change: give the person's own words (--text).`);
    return [DecisionSchema.parse({ ...base(), action: 'request-changes', text, flag: flag.id })];
  }
  const want = replies[input.action];
  if (!want) throw new FlagError('invalid', `--action is one of ${FLAG_CHOICES.join(', ')}.`);
  const said = input.said ?? '';
  if (!sameWords(said, want)) {
    throw new FlagError('not-exact', `a chat ${input.action} counts only on the person's exact reply "${want}"${said.trim() ? `, not "${said.trim()}"` : ''}. Ask again; never infer it.`);
  }
  const words = said.trim();
  if (input.action === 'dismiss') return [DecisionSchema.parse({ ...base(), action: 'dismiss-flag', flag: flag.id, text: words })];
  return unitApproval(p, { unit, said: words, by, at: input.at, ids });
}

/**
 * "approve <unit>" in chat (the one approval behaviour, with or without flags):
 * one `approve`, plus one `dismiss-flag` for each open flag on the unit's current
 * stage, which the approval overrules. All carry the reply as text, stamped `chat@1`.
 * Refuses anything but the exact words and agent names. Writes nothing.
 */
export function unitApproval(p: AkukoProject, input: { unit: string; said?: string; by?: string; at?: string; ids?: string[] }): Decision[] {
  const ref = findUnit(p, input.unit);
  if (!ref) throw new FlagError('unknown-unit', `no unit "${input.unit}" in this project.`);
  const u = ref.unit;
  const by = input.by?.trim() || 'you';
  if (isAgentAuthor(by)) throw new FlagError('not-a-person', `"${by}" is an agent name: only the person approves.`);
  const want = `approve ${u.id}`;
  const said = input.said ?? '';
  if (!sameWords(said, want)) {
    throw new FlagError('not-exact', `a chat approval counts only on the person's exact reply "${want}"${said.trim() ? `, not "${said.trim()}"` : ''}. Ask again; never infer it.`);
  }
  const ids = input.ids ?? [];
  const at = input.at ?? new Date().toISOString();
  const base = () => ({ id: ids.shift() ?? randomUUID(), unit: u.id, stage: u.stage, by, at, view: CHAT_VIEW, text: said.trim() });
  const open = (u.by_stage?.[u.stage]?.flags ?? []).filter((f) => f.status === 'open');
  return [
    DecisionSchema.parse({ ...base(), action: 'approve' }),
    ...open.map((f) => DecisionSchema.parse({ ...base(), action: 'dismiss-flag', flag: f.id })),
  ];
}

export interface ChatContext {
  /** Hosts B/C: the project folder. */
  dir?: string;
  /** Host A: where to write the folded project. */
  out?: string;
  /** Extra conformed-views files (decisions/cli.ts#conformedFrom). */
  conformed?: string[];
}

/**
 * Record chat decisions the person made and fold them. They are folded in memory
 * first: if folding would refuse any of them, nothing is written (`refused`).
 * B/C: appended to decisions.jsonl, then the whole store is folded into akuko.json.
 * A: the folded project is written to `out`; the caller sets each decision as a
 * row in `decisions` (doc id = its id) and `out` back as akuko/project (if_version).
 */
export async function recordChat(p: AkukoProject, ds: Decision[], ctx: ChatContext): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const conformed = conformedFrom(ctx.conformed, ctx.dir, warnings);
  const trial = foldDecisions(p, ds, { conformed });
  const mine = new Set(ds.map((d) => d.id));
  const refused = trial.report.rejected.filter((r) => mine.has(r.id));
  if (refused.length) throw new FlagError('refused', refused.map((r) => `${r.action} ${r.unit}: ${r.reason} (${r.code})`).join('; '));
  if (ctx.dir !== undefined) {
    const host = createLocalHost({ projectDir: ctx.dir });
    await appendDecisions(ctx.dir, ds);
    const store = await readJsonlStore(ctx.dir);
    const { project, report } = foldDecisions(await host.readState(), store.decisions, { conformed });
    if (report.changed) await host.writeState(project);
    return { ok: true, decisions: ds, applied: report.applied.filter((x) => mine.has(x)), rejected: report.rejected, wrote: resolve(ctx.dir, 'akuko.json'), appended_to: resolve(ctx.dir, 'decisions.jsonl'), warnings };
  }
  if (!ctx.out) throw new FlagError('invalid', '--out <file> is needed with --project-file: the agent sets it back as akuko/project (if_version).');
  writeFileSync(ctx.out, `${JSON.stringify(trial.project, null, 2)}\n`);
  return { ok: true, decisions: ds, applied: trial.report.applied, wrote: ctx.out, warnings, note: 'Host A: set every decision as a row in the `decisions` collection (doc id = decision id) in ONE ArtifactData batch, then set --out back as akuko/project with if_version.' };
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
    const k = a.slice(2);
    const v = k === 'all' ? 'true' : rest[++i] ?? '';
    (opt[k] ??= []).push(v);
  }
  return { cmd, opt };
}

function region(v: string | undefined): FlagEvidence['region'] {
  if (v === undefined) return undefined;
  const n = v.split(',').map((x) => Number(x.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) throw new FlagError('invalid', '--region is x,y,w,h, each 0–1 of the picture.');
  return { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
}

export interface CliResult { code: number; out: unknown }

/** Run one command; returns what to print (tests call this directly). */
export async function run(argv: string[]): Promise<CliResult> {
  const { cmd, opt } = args(argv);
  const one = (k: string) => opt[k]?.[0];
  const dir = one('project');
  const file = one('project-file');
  if (!['add', 'list', 'clear', 'next', 'decide'].includes(cmd)) return { code: 2, out: { ok: false, usage: 'flags.ts add|list|clear|next|decide (--project <dir> | --project-file <akuko.json> [--out <file>]) …' } };
  if (!dir && !file) return { code: 2, out: { ok: false, message: 'give --project <dir> (hosts B, C) or --project-file <akuko.json> (host A)' } };
  const host = dir ? createLocalHost({ projectDir: dir }) : undefined;
  const p = host ? await host.readState() : AkukoProjectSchema.parse(JSON.parse(readFileSync(file!, 'utf8')));
  const save = async (next: AkukoProject): Promise<string> => {
    if (host) { await host.writeState(next); return resolve(dir!, 'akuko.json'); }
    const out = one('out');
    if (!out) throw new FlagError('invalid', '--out <file> is needed with --project-file: the agent sets it back as akuko/project (if_version).');
    writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);
    return out;
  };
  try {
    if (cmd === 'list') {
      const list = listFlags(p, { unit: one('unit'), all: !!opt.all });
      return { code: 0, out: { ok: true, count: list.length, flags: list } };
    }
    if (cmd === 'next') {
      const n = nextFlag(p, { skip: (opt.skip ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean), projectDir: dir });
      if (!n) return { code: 0, out: { ok: true, done: true, remaining: 0, message: 'No open flags left.' } };
      const { replies, ...rest } = n;
      return { code: 0, out: { ok: true, done: false, ...rest, replies, ask: `Offer exactly these replies: ${replies.approve} · ${replies['send-back']} · ${replies.dismiss}. Record the pick with: flags.ts decide --flag ${n.flag.id} --action approve|send-back|dismiss --said "<their reply>"` } };
    }
    if (cmd === 'decide') {
      const via = one('via') ?? 'chat';
      if (via !== 'chat') throw new FlagError('invalid', '--via is chat: a decision made on the board arrives from the board.');
      const action = one('action') as FlagChoice | undefined;
      if (!action || !FLAG_CHOICES.includes(action)) throw new FlagError('invalid', `--action is one of ${FLAG_CHOICES.join(', ')}.`);
      const id = one('flag');
      if (!id) throw new FlagError('invalid', 'decide needs --flag <id>.');
      const ds = decideFlag(p, { flag: id, action, said: one('said'), text: one('text'), by: one('by'), at: one('at') });
      return { code: 0, out: await recordChat(p, ds, { dir, out: one('out'), conformed: opt.conformed }) };
    }
    if (cmd === 'clear') {
      const r = clearFlags(p, { ids: (opt.flag ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean), unit: one('unit') });
      const wrote = r.cleared.length ? await save(r.project) : null;
      return { code: 0, out: { ok: true, cleared: r.cleared.map((f) => f.id), wrote } };
    }
    const kind = FlagKindSchema.safeParse(one('kind'));
    if (!kind.success) throw new FlagError('invalid', `--kind is one of ${FlagKindSchema.options.join(', ')}.`);
    const sev = FlagSeveritySchema.safeParse(one('severity') ?? 'warn');
    if (!sev.success) throw new FlagError('invalid', `--severity is one of ${FlagSeveritySchema.options.join(', ')}.`);
    const stage = one('stage') === undefined ? undefined : StageIdSchema.parse(one('stage'));
    const unit = one('unit'), text = one('text');
    if (!unit || !text?.trim()) throw new FlagError('invalid', 'add needs --unit <id> and --text "<what is wrong>".');
    const r = addFlag(p, {
      unit, kind: kind.data, text, severity: sev.data, stage,
      suggested_change: one('suggest'),
      source: one('source'),
      evidence: { uri: one('uri'), sha256: one('sha256'), asset: one('asset'), view: one('view'), region: region(one('region')) },
    }, { hashOf: dir ? diskHasher(dir) : undefined });
    const wrote = await save(r.project);
    return { code: 0, out: { ok: true, flag: r.flag, unit, wrote, note: 'The unit\'s status is unchanged. The person acts on the flag on the board.' } };
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
