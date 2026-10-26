import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modeRank } from './rails.js';
import type { WireMode } from './rails.js';

/**
 * Per-user policies (`userPolicies`): a Mattermost user who is NOT in a bot's `allowedUsers` can still be let in, for named
 * channels only, with a session that has a fixed, explicit toolset.
 *
 * What this file is and is not. The bridge never starts `claude`: it asks the Ikenga daemon for a Chi run (`chi_run`), and the
 * daemon builds the `claude` command line. So "the claude flags" are a contract between this bridge and the daemon. The bridge
 * side of it lives here: a policy is validated at load, turned into one `toolPolicy` object that rides in the `chi_run`
 * options, and `claudeArgsForToolPolicy` is the exact argv the daemon must append for it (the README has the contract and the
 * probes that pinned it). The ONLY enforcement is the daemon's: the bridge refuses to start a policy run unless the daemon
 * advertises the `chi.toolPolicy` capability on `/api/health` (see `POLICY_CAPABILITY`), so an old daemon fails closed.
 */

/** The `/api/health` capability a daemon advertises when it applies `opts.toolPolicy`. */
export const POLICY_CAPABILITY = 'chi.toolPolicy';

/**
 * Built-in Claude Code tool names a policy may mention, in the order they are listed in `--disallowedTools`. An unknown name is
 * a typo or a tool this list has not caught up with: both are refused. Names the CLI has but this list lacks cannot be
 * allowed, and are not denied by name either; `--tools` (the exact built-in set) is what leaves them out of the session.
 */
const KNOWN_TOOL_LIST: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'LSP',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'SendMessage',
  'RemoteTrigger',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'ListAgents',
  'TeamCreate',
  'TeamDelete',
  'PowerShell',
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'DesignSync',
  'ReportFindings',
  'SendFeedback',
  'StructuredOutput',
  'ListMcpResources',
  'ReadMcpResource',
];
const KNOWN_TOOLS: ReadonlySet<string> = new Set(KNOWN_TOOL_LIST);

/** The only built-in tools a policy session can ever have. Everything else known is denied outright. */
const ALLOWABLE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'ToolSearch']);

/**
 * Tools that are always denied to a policy user, whatever the policy says, and that a policy may not allow: everything known
 * except `ALLOWABLE_TOOLS` (so anything that writes a file, reaches the network, starts another agent, schedules work, messages
 * someone or would wait for an answer). They are added to `--disallowedTools` as well as being left out of `--tools`.
 */
export const POLICY_HARD_DENY: readonly string[] = KNOWN_TOOL_LIST.filter((t) => !ALLOWABLE_TOOLS.has(t));
const HARD_DENY_SET: ReadonlySet<string> = new Set(POLICY_HARD_DENY);

/** Read-side tools. Allowing one without a path scope would allow it everywhere (a bare `Read` rule reads `/etc`). */
const SCOPED_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS']);

/**
 * A Bash allow rule is exactly `Bash(<interpreter> <script path>)`, with an optional `:*` or ` *` (any arguments) suffix. The
 * script path is relative to the policy cwd, is made of plain path segments only (no `..`, no leading `/` or `~`, no dotfile
 * segment, no glob, no quote, no `$`, no space, no redirection, no operator: anything outside `[A-Za-z0-9._-]` is refused),
 * and the interpreter is one of a short list. Everything else is a refusal, so a hole is closed by what the rule cannot
 * express rather than by a list of what is known to be bad.
 */
const BASH_INTERPRETERS = ['bash', 'sh', 'node', 'python3'] as const;
const BASH_RULE = new RegExp(`^(${BASH_INTERPRETERS.join('|')}) ((?:\\./)?(?:[A-Za-z0-9_][A-Za-z0-9._-]*/)*[A-Za-z0-9_][A-Za-z0-9._-]*)(:\\*| \\*)?$`);

/** Characters a Read/Grep/Glob/LS path scope may contain. No `{}`/`[]`/`!` (expansion), no `$`, no space, no `\`. */
const READ_SPEC_CHARS = /^[A-Za-z0-9._\-/*?@+]+$/;

const POLICY_KEYS: ReadonlySet<string> = new Set([
  'label',
  'channels',
  'cwd',
  'mode',
  'systemPrompt',
  'allowedTools',
  'tools',
  'disallowedTools',
  'settingSources',
  'enforcedBy',
]);
const MM_ID = /^[a-z0-9]{26}$/;

/** How the tool limits are enforced. The daemon is the only thing that can; a policy must say so, and the bridge verifies the daemon can. */
export type PolicyEnforcement = 'daemon';

/** The permission mode a policy run uses: `dontAsk` denies a tool that is not allowed at once instead of asking (probed on claude 2.1.310). */
export type PolicyPermissionMode = 'default' | 'dontAsk';

/** One policy as written in `bridge.json`, under `userPolicies.<mattermost user id>`. */
export interface UserPolicy {
  /** Shown in the audit log and the operator commands. Default: the user id. */
  label?: string;
  /** Channels (name, `#name` or id) this user may use the bot in. Required. Resolved to channel IDS once at startup; only an id ever matches. Independent of the bot's `allowedChannels`. */
  channels: string[];
  /**
   * Working directory of this user's runs: a directory holding only what they may read. Absolute or `~/…`. Required; it may not
   * be, contain or sit inside `chi.cwd` or any `privateRoots` entry (spelling, `~` and symlinks are resolved first).
   */
  cwd: string;
  /** `default` (the default and the only value): the wire mode recorded for the run. The permission mode the session really runs in is `toolPolicy.mode`. */
  mode?: string;
  /** Replaces `chi.systemPrompt` for this user's runs. Advisory: the limits do not depend on it. */
  systemPrompt?: string;
  /** Tool rules that run without asking, e.g. `Bash(bash scripts/cron/run-social-queue-submit.sh:*)`. Required, non-empty. Everything else is denied. */
  allowedTools: string[];
  /** The built-in tools the session has at all (`--tools`). Default: the tool names in `allowedTools`. */
  tools?: string[];
  /** Extra deny rules, added to every known tool the session does not have (`Write`, `Edit`, `WebFetch`, ...). */
  disallowedTools?: string[];
  /**
   * Which settings files claude may read. Omitted or `[]` (no settings file): the only accepted value. `project` is refused
   * because it would load CLAUDE.md files from the cwd's parent directories into the session; `user` and `local` are the
   * account's own settings and could widen the policy.
   */
  settingSources?: string[];
  /** Required: `daemon` (the daemon applies `toolPolicy`; the bridge refuses to run unless the daemon advertises `chi.toolPolicy`). */
  enforcedBy: PolicyEnforcement;
}

/**
 * The one object sent to the daemon in `chi_run` as `opts.toolPolicy`, and the shape the daemon turns into `claude` flags.
 * It is deliberately complete: a daemon that applies it needs no other input.
 */
export interface ToolPolicy {
  /** `--tools`: the built-in tools that exist in the session (exact set). */
  tools: string[];
  /** `--allowedTools`: rules that run without a prompt. */
  allowedTools: string[];
  /** `--disallowedTools`: rules that are refused, always winning over an allow. Defaults to every known tool not in `tools`. */
  disallowedTools: string[];
  /** `--permission-mode`: `dontAsk` denies anything not allowed, immediately; nothing ever waits for an answer (no `awaiting_auth`). */
  mode: PolicyPermissionMode;
  /** `--strict-mcp-config` (with no `--mcp-config`): no MCP server, so no MCP tool. Always true. */
  strictMcp: true;
  /** `--setting-sources`: always `[]` (a policy cannot enable any settings source). */
  settingSources: string[];
}

export interface ResolvedUserPolicy {
  /** The Mattermost user id the policy is for. */
  userId: string;
  label: string;
  /** Channel references as written (names or ids). The bridge resolves them to ids at startup; the gate matches ids only. */
  channels: string[];
  cwd: string;
  mode: WireMode;
  systemPrompt?: string;
  toolPolicy: ToolPolicy;
  enforcedBy: PolicyEnforcement;
}

export interface PolicyContext {
  allowedUsers: readonly string[];
  /** The bot's `maxMode` (a wire mode); the policy's mode may not exceed it. */
  maxMode: WireMode;
  chi?: { engine?: string; cwd?: string };
  approvals?: unknown;
  /** Whether the bot has `daemon` + `chi` (an approvals-only bot runs nothing). */
  runsChi: boolean;
  botUserId?: string;
  /** Directories the operator keeps private: a policy cwd may not be, contain or sit inside one. Absolute or `~/…`. */
  privateRoots?: readonly string[];
  /** The home directory `~` means (default: the process's). Tests only. */
  home?: string;
  /** The uid of the account the bot runs as, for the script ownership check (default: the process's). Tests only. */
  botUid?: number;
}

interface ParsedRule {
  name: string;
  spec: string | undefined;
}

function parseRule(raw: unknown): ParsedRule | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /^([A-Za-z][A-Za-z0-9_-]*)(?:\(([\s\S]*)\))?$/.exec(raw.trim());
  if (!m) return undefined;
  return { name: m[1] as string, spec: m[2] };
}

function knownTool(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

// ── paths ────────────────────────────────────────────────────────────────────

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * A path in one canonical spelling: `~` expanded, lexically normalised (`//`, `/./`, trailing `/.` and `/` go), and the longest
 * prefix that exists on disk resolved through symlinks (the rest is appended as written). Two spellings of one directory,
 * and a symlink to it, therefore compare equal.
 */
export function canonicalPath(raw: string, home: string = os.homedir()): string {
  const abs = path.resolve(expandHome(raw.trim(), home));
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** How `cwd` overlaps `root`, or undefined when the two are apart. */
function overlap(cwd: string, root: string): 'is' | 'inside' | 'above' | undefined {
  if (cwd === root) return 'is';
  if (isInside(cwd, root)) return 'inside';
  if (isInside(root, cwd)) return 'above';
  return undefined;
}

function shapeOk(p: unknown): p is string {
  return typeof p === 'string' && (p.startsWith('/') || p.startsWith('~/')) && !p.split('/').includes('..') && !p.includes('\0');
}

// ── the cwd tree ─────────────────────────────────────────────────────────────

/** The walk of a policy cwd gives up (and the cwd is refused) past this many entries or this depth (the cwd itself is depth 0). */
export const CWD_WALK_MAX_ENTRIES = 10_000;
export const CWD_WALK_MAX_DEPTH = 20;

/** Why a policy cwd was refused. The first offending path is reported (relative to the cwd, `.` for the cwd itself), never its contents. */
export type CwdProblem =
  | 'symlink' // a symlink at any depth, whether it points inside, outside or nowhere
  | 'special_file' // a FIFO, socket or device
  | 'hardlink' // a regular file with more than one link (it may be the same file as one outside the cwd)
  | 'escapes_cwd' // a directory whose real path is not inside the cwd
  | 'not_a_directory' // the cwd itself is not a directory
  | 'too_many_entries'
  | 'too_deep'
  | 'unreadable';

export type CwdCheck = { ok: true; entries: number } | { ok: false; code: CwdProblem; path: string; detail: string };

const CWD_DETAIL: Record<CwdProblem, string> = {
  symlink: 'is a symlink; a shell glob can read through it past the read boundary',
  special_file: 'is not a regular file or directory (FIFO, socket or device)',
  hardlink: 'is a regular file with more than one hard link, so it may be the same file as one outside the cwd',
  escapes_cwd: 'is a directory whose real path is outside the cwd',
  not_a_directory: 'is not a directory',
  too_many_entries: `the cwd holds more than ${CWD_WALK_MAX_ENTRIES} entries`,
  too_deep: `the cwd is nested deeper than ${CWD_WALK_MAX_DEPTH} levels`,
  unreadable: 'could not be read',
};

/**
 * Walk a policy cwd with `lstat` (nothing is followed) and refuse anything that could let a session read outside it.
 * The session's read boundary is the cwd, and Claude's own path check does not follow a shell glob through a symlink
 * (`cat h*\/notes.txt` read the hub through `hublink -> ../hub`, verified on claude 2.1.310, while `cat hublink/notes.txt` was
 * denied). So the tree must hold only regular files and real directories: refused are a symlink at ANY depth (even one that
 * points inside), a FIFO, socket or device, a directory whose realpath leaves the cwd, and a regular file with `nlink > 1`.
 * A hard link cannot be told from a legitimate file except by its link count, so a file with two names is refused (a
 * file the operator really needs under two names is copied instead). Not detected: bind mounts, and a file with `nlink`
 * 1 that is changed or replaced later (the walk runs again before every run, and the README states the TOCTOU).
 *
 * A missing cwd passes (there is nothing in it, and a run there fails in the daemon). The walk is capped; past a cap
 * the cwd is refused rather than assumed fine. Entries are visited in sorted order, so the first offender is stable.
 */
export function checkPolicyCwd(cwd: string, home: string = os.homedir(), limits: { maxEntries?: number; maxDepth?: number } = {}): CwdCheck {
  const maxEntries = limits.maxEntries ?? CWD_WALK_MAX_ENTRIES;
  const maxDepth = limits.maxDepth ?? CWD_WALK_MAX_DEPTH;
  const abs = path.resolve(expandHome(cwd.trim(), home));
  const fail = (code: CwdProblem, rel: string): CwdCheck => ({ ok: false, code, path: rel, detail: CWD_DETAIL[code] });
  let rootStat;
  try {
    rootStat = lstatSync(abs);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, entries: 0 } : fail('unreadable', '.');
  }
  if (rootStat.isSymbolicLink()) return fail('symlink', '.');
  if (!rootStat.isDirectory()) return fail('not_a_directory', '.');
  let root: string;
  try {
    root = realpathSync(abs);
  } catch {
    return fail('unreadable', '.');
  }
  let count = 0;
  const visit = (dir: string, rel: string, depth: number): CwdCheck | undefined => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return fail('unreadable', rel || '.');
    }
    for (const name of names) {
      const entryRel = rel ? `${rel}/${name}` : name;
      if (++count > maxEntries) return fail('too_many_entries', entryRel);
      const full = path.join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // gone since the listing: nothing to read
        return fail('unreadable', entryRel);
      }
      if (st.isSymbolicLink()) return fail('symlink', entryRel);
      if (st.isDirectory()) {
        if (depth + 1 > maxDepth) return fail('too_deep', entryRel);
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          return fail('unreadable', entryRel);
        }
        if (!isInside(real, root)) return fail('escapes_cwd', entryRel);
        const inner = visit(full, entryRel, depth + 1);
        if (inner) return inner;
      } else if (st.isFile()) {
        if (st.nlink > 1) return fail('hardlink', entryRel);
      } else {
        return fail('special_file', entryRel);
      }
    }
    return undefined;
  };
  return visit(abs, '', 0) ?? { ok: true, entries: count };
}

// ── rules ────────────────────────────────────────────────────────────────────

/** Mode bits that let someone other than the owner change a file. */
const GROUP_OR_WORLD_WRITABLE = 0o022;

/**
 * A Bash allow rule is one interpreter and one script path relative to the policy cwd (see `BASH_RULE`). When the script exists
 * at load time it must also be something the bot's own account cannot rewrite: not a symlink out of the cwd, not group/world
 * writable and not owned by the bot's uid, and the same for every directory between it and the cwd (rename-over defeats a
 * read-only file in a writable directory). That is a check at load, not a guarantee later; the README says so.
 */
function checkBashAllow(spec: string | undefined, label: string, where: string, cwd: string, c: { home: string; botUid: number | undefined }): void {
  const m = spec === undefined ? null : BASH_RULE.exec(spec);
  if (!m) {
    throw new Error(
      `${where}: ${label} is not an allowed Bash rule; the only form is Bash(<${BASH_INTERPRETERS.join('|')}> <script path relative to the policy cwd>) with an optional ':*' suffix, e.g. Bash(bash scripts/cron/run-social-queue-submit.sh:*) (no '..', no absolute or ~ path, no shell characters, no other command)`,
    );
  }
  const script = m[2] as string;
  const root = canonicalPath(cwd, c.home);
  // Every component that exists, from the cwd down to the script, must be a real entry (lstat, not followed) that stays
  // inside the cwd. This runs whether or not the script itself exists yet: a rule whose directory is a symlink, or whose
  // directory chain leaves the cwd, is refused, so creating the script later cannot place it outside.
  let cur = root;
  const segs = script.split('/').filter((x) => x !== '' && x !== '.');
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i] as string);
    const last = i === segs.length - 1;
    let ls;
    try {
      ls = lstatSync(cur);
    } catch {
      return; // this component and everything below it are not there yet: nothing more to check at load
    }
    const shown = segs.slice(0, i + 1).join('/');
    if (ls.isSymbolicLink()) {
      throw new Error(last ? `${where}: ${label}: '${script}' is a symlink; name the real file` : `${where}: ${label}: '${shown}' is a symlink; the script's directory chain must be real directories inside the policy cwd`);
    }
    let realPart: string;
    try {
      realPart = realpathSync(cur);
    } catch {
      return;
    }
    if (!isInside(realPart, root)) throw new Error(`${where}: ${label}: '${shown}' resolves outside the policy cwd`);
  }
  const full = path.join(root, ...segs);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return;
  }
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return;
  }
  if (!isInside(real, root)) throw new Error(`${where}: ${label}: '${script}' resolves outside the policy cwd`);
  const mine = (uid: number) => c.botUid !== undefined && uid === c.botUid;
  const bad = (what: string, s: { mode: number; uid: number }): string | undefined =>
    s.mode & GROUP_OR_WORLD_WRITABLE ? `${what} is group- or world-writable` : mine(s.uid) ? `${what} is owned by the bot's own account (uid ${s.uid}), which could rewrite it` : undefined;
  const fileProblem = bad(`'${script}'`, st);
  if (fileProblem) throw new Error(`${where}: ${label}: ${fileProblem}; the script a policy user can trigger must be root-owned and not writable by the bot`);
  // Every directory from the script's up to and including the cwd.
  for (let d = path.dirname(real); ; d = path.dirname(d)) {
    const ds = lstatSync(d);
    const p = bad(`directory '${path.relative(root, d) || '.'}'`, ds);
    if (p) throw new Error(`${where}: ${label}: ${p}; the script a policy user can trigger must be root-owned and not replaceable by the bot`);
    if (d === root || path.dirname(d) === d) break;
  }
}

/**
 * A Read/Grep/Glob/LS rule must scope itself to a relative path inside the policy cwd. The first path segment must be a literal
 * name (so `Read(**)`, `Grep(*)`, `Read(./**)` are unscoped), and `/…`, `//…`, `~…`, `..` and every shell/glob-expansion
 * character outside `* ?` are refused. A literal prefix that exists must not be a symlink out of the cwd.
 */
function checkReadAllow(name: string, spec: string | undefined, label: string, where: string, cwd: string, home: string): void {
  const hint = `scope it relative to the policy cwd, e.g. ${name}(./docs/**)`;
  const s = spec ?? '';
  if (!s) throw new Error(`${where}: ${label} has no path scope, so it would read anywhere; ${hint}`);
  if (!READ_SPEC_CHARS.test(s)) throw new Error(`${where}: ${label}: the path scope has a character that is not allowed (only letters, digits and . _ - / * ? @ +); ${hint}`);
  if (s.startsWith('/') || s.startsWith('~')) throw new Error(`${where}: ${label}: an absolute or ~ path reaches outside the policy cwd; ${hint}`);
  const segs = s.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.includes('..')) throw new Error(`${where}: ${label}: '..' leaves the policy cwd; ${hint}`);
  const first = segs[0];
  if (first === undefined || /[*?]/.test(first)) throw new Error(`${where}: ${label} is not scoped to a directory or file of its own (it starts with a wildcard); ${hint}`);
  const literal: string[] = [];
  for (const seg of segs) {
    if (/[*?]/.test(seg)) break;
    literal.push(seg);
  }
  const root = canonicalPath(cwd, home);
  const target = path.join(root, ...literal);
  let real: string | undefined;
  try {
    real = realpathSync(target);
  } catch {
    real = undefined; // not there yet
  }
  if (real !== undefined && !isInside(real, root)) throw new Error(`${where}: ${label}: '${literal.join('/')}' is a symlink that leaves the policy cwd`);
}

function checkRuleList(value: unknown, field: string, where: string, kind: 'allow' | 'deny', cwd: string, c: { home: string; botUid: number | undefined }): string[] {
  if (!Array.isArray(value)) throw new Error(`${where}: ${field} must be a list of tool rules`);
  const out: string[] = [];
  for (const raw of value) {
    const label = `${field} '${String(raw)}'`;
    const rule = parseRule(raw);
    if (!rule) throw new Error(`${where}: ${label} is not a tool rule (use Name or Name(specifier), e.g. Read(./docs/**))`);
    if (rule.name.startsWith('mcp__')) {
      if (kind === 'allow') throw new Error(`${where}: ${label}: MCP tools are not available to policy users (the session runs with --strict-mcp-config)`);
      out.push((raw as string).trim());
      continue;
    }
    if (!knownTool(rule.name)) {
      throw new Error(`${where}: ${label}: unknown tool '${rule.name}' (known: ${KNOWN_TOOL_LIST.join(', ')})`);
    }
    if (kind === 'allow') {
      if (HARD_DENY_SET.has(rule.name)) {
        throw new Error(`${where}: ${label}: ${rule.name} can never be allowed for a policy user (no file writes, no network, no sub-agents, no scheduling, nothing that waits for an answer)`);
      }
      if (rule.name === 'Bash') checkBashAllow(rule.spec, label, where, cwd, c);
      else if (SCOPED_TOOLS.has(rule.name)) checkReadAllow(rule.name, rule.spec, label, where, cwd, c.home);
      else if (rule.spec !== undefined) throw new Error(`${where}: ${label}: ${rule.name} takes no specifier`);
    }
    out.push((raw as string).trim());
  }
  return out;
}

function uniq(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** `privateRoots` as written: a list of absolute or `~/…` paths. */
export function resolvePrivateRoots(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((r) => !shapeOk(r))) {
    throw new Error(`${where}: privateRoots must be a list of absolute or ~/... paths without '..' (the directories no policy cwd may overlap)`);
  }
  return uniq(raw as string[]);
}

/**
 * Validate `userPolicies` of one bot at load and return the resolved policies by user id. Throws, naming the bot and the
 * user, on anything it cannot be sure of; never repairs. `undefined` (no policies) resolves to an empty map: a bot that
 * does not use the feature is untouched.
 */
export function resolveUserPolicies(raw: unknown, where: string, ctx: PolicyContext): Map<string, ResolvedUserPolicy> {
  const out = new Map<string, ResolvedUserPolicy>();
  if (raw === undefined) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: userPolicies must be an object keyed by Mattermost user id`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return out;

  if (!ctx.runsChi) throw new Error(`${where}: userPolicies need daemon and chi; a bot that runs nothing has no sessions to limit`);
  if (ctx.approvals) throw new Error(`${where}: userPolicies cannot be combined with approvals (an approved run is a different, writable session); use one or the other`);
  if (ctx.chi?.engine !== 'claude-code') {
    throw new Error(`${where}: userPolicies need chi.engine 'claude-code'; only Claude Code has the tool flags a policy is turned into (got '${String(ctx.chi?.engine)}')`);
  }
  const chiCwd = ctx.chi?.cwd;
  if (!shapeOk(chiCwd)) {
    throw new Error(`${where}: userPolicies need chi.cwd (absolute or ~/...): the bot's own working directory, which no policy cwd may overlap`);
  }
  const home = ctx.home ?? os.homedir();
  const botUid = ctx.botUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const roots = [{ what: 'chi.cwd', dir: chiCwd }, ...resolvePrivateRoots(ctx.privateRoots, where).map((d) => ({ what: `privateRoots '${d}'`, dir: d }))].map((r) => ({ ...r, canon: canonicalPath(r.dir, home) }));

  // A username entry cannot be compared with a policy's user id (it is a different name for the same person, or for no one
  // by the time it is read), so a bot with policies lists its own users by id only.
  const allowedIds = new Set<string>();
  for (const u of ctx.allowedUsers) {
    if (!MM_ID.test(u)) {
      throw new Error(`${where}: allowedUsers entry '${u}' is a username; a bot with userPolicies must list allowedUsers by Mattermost user id, so that no listed user can also be a policy user under another spelling`);
    }
    allowedIds.add(u);
  }

  for (const [userId, value] of entries) {
    const w = `${where}: userPolicies.${userId}`;
    if (!MM_ID.test(userId)) {
      throw new Error(`${w}: the key must be a Mattermost user id (26 lowercase letters and digits), not a username: a username can be renamed or reused`);
    }
    if (allowedIds.has(userId)) throw new Error(`${w}: this user is also in allowedUsers, which would give them an unrestricted session; remove them from one of the two`);
    if (ctx.botUserId && ctx.botUserId === userId) throw new Error(`${w}: this is the bot's own user id`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${w}: must be an object`);
    const p = value as Record<string, unknown>;
    for (const k of Object.keys(p)) {
      if (!POLICY_KEYS.has(k)) throw new Error(`${w}: unknown field '${k}'; allowed: ${[...POLICY_KEYS].join(', ')}`);
    }

    // Where it works.
    if (!Array.isArray(p.channels) || p.channels.length === 0 || p.channels.some((c) => typeof c !== 'string' || !c.replace(/^#/, '').trim() || /\s/.test(c))) {
      throw new Error(`${w}: channels must be a non-empty list of channel names or ids`);
    }
    const channels = uniq((p.channels as string[]).map((c) => c.replace(/^#/, '').trim()));

    // Where it runs.
    if (!shapeOk(p.cwd)) {
      throw new Error(`${w}: cwd is required: an absolute path or ~/..., without '..' (a directory holding only what this user may read; never the bot's own cwd)`);
    }
    const cwdCanon = canonicalPath(p.cwd, home);
    for (const r of roots) {
      const o = overlap(cwdCanon, r.canon);
      if (o === 'is') throw new Error(`${w}: cwd is the same directory as ${r.what} ('${r.canon}'); a policy user needs a directory of their own`);
      if (o === 'inside') throw new Error(`${w}: cwd is inside ${r.what} ('${r.canon}'), so the user could read everything it holds; use a dedicated directory outside it`);
      if (o === 'above') throw new Error(`${w}: cwd contains ${r.what} ('${r.canon}'), so the user could read it; use a dedicated directory that is neither inside nor above it`);
    }

    // The permission mode. A policy session runs in `toolPolicy.mode`; `mode` here is the wire mode recorded for the run.
    const rawMode = p.mode === undefined ? 'default' : p.mode;
    if (rawMode !== 'default') {
      throw new Error(`${w}: mode must be 'default' (got '${String(rawMode)}'); plan mode refuses even an allowed command and a policy user never gets acceptEdits or bypassPermissions`);
    }
    const mode = rawMode as WireMode;
    if (modeRank(mode) > modeRank(ctx.maxMode)) {
      throw new Error(`${w}: mode '${mode}' is above this bot's ceiling (maxMode '${ctx.maxMode}'); set maxMode to 'default' to allow it`);
    }

    if (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 64)) throw new Error(`${w}: label must be a short non-empty string`);
    if (p.systemPrompt !== undefined && (typeof p.systemPrompt !== 'string' || !p.systemPrompt.trim())) throw new Error(`${w}: systemPrompt must be a non-empty string`);
    if (p.enforcedBy !== 'daemon') {
      throw new Error(
        `${w}: enforcedBy is required and must be 'daemon' (got '${String(p.enforcedBy)}'): the Ikenga daemon applies toolPolicy as claude flags, and the bridge refuses to run a policy session unless the daemon advertises '${POLICY_CAPABILITY}'. A settings file in the cwd cannot enforce a policy, so there is no other mode`,
      );
    }

    // What it may use.
    if (!Array.isArray(p.allowedTools) || p.allowedTools.length === 0) {
      throw new Error(`${w}: allowedTools must name at least one tool rule; an empty allowlist would be a session that can do nothing, or, on a daemon that ignores it, anything`);
    }
    const rc = { home, botUid };
    const allowed = uniq(checkRuleList(p.allowedTools, 'allowedTools', w, 'allow', p.cwd, rc));
    const allowedNames = uniq(allowed.map((r) => (parseRule(r) as ParsedRule).name));

    let tools: string[];
    if (p.tools === undefined) {
      tools = allowedNames;
    } else {
      if (!Array.isArray(p.tools) || p.tools.length === 0) throw new Error(`${w}: tools must be a non-empty list of built-in tool names`);
      tools = uniq(p.tools.map((t) => {
        if (typeof t !== 'string' || !knownTool(t) || HARD_DENY_SET.has(t)) {
          throw new Error(`${w}: tools '${String(t)}' is ${typeof t === 'string' && HARD_DENY_SET.has(t) ? 'never available to a policy user' : 'not a known built-in tool'}`);
        }
        return t;
      }));
      for (const n of allowedNames) {
        if (!tools.includes(n)) throw new Error(`${w}: allowedTools uses ${n}, which tools leaves out, so it would never run`);
      }
    }

    const extraDeny = p.disallowedTools === undefined ? [] : checkRuleList(p.disallowedTools, 'disallowedTools', w, 'deny', p.cwd, rc);
    // Everything known that the session does not have is denied by name too: a daemon that honours only one of --tools and
    // --disallowedTools still refuses it. (Names the CLI has but this list lacks are left out of `--tools` and so absent.)
    const disallowed = uniq([...KNOWN_TOOL_LIST.filter((t) => !tools.includes(t)), ...extraDeny]);
    const clash = allowed.filter((r) => disallowed.includes(r));
    if (clash.length) throw new Error(`${w}: '${clash[0]}' is both allowed and disallowed`);

    // Only "no settings source". `project` would make claude read CLAUDE.md files from the cwd's PARENT directories into the
    // session (probed on 2.1.310): the hub's instructions and anything near it. `user` and `local` are the account's own.
    if (p.settingSources !== undefined && (!Array.isArray(p.settingSources) || p.settingSources.length !== 0)) {
      throw new Error(
        `${w}: settingSources must be omitted or []; a policy cannot enable any settings source ('project' loads CLAUDE.md from the cwd's parent directories into the session, and 'user' and 'local' are the account's own settings). Put what the session needs in the cwd and the system prompt`,
      );
    }
    const settingSources: string[] = [];

    // The cwd tree is the read boundary (see checkPolicyCwd). Checked last so a mistake in a rule is reported as the rule.
    const tree = checkPolicyCwd(p.cwd, home);
    if (!tree.ok) {
      throw new Error(
        `${w}: cwd is unsafe: ${JSON.stringify(tree.path)} ${tree.detail} (${tree.code}). A policy cwd may hold only regular files and real directories, with no symlink at any depth, no FIFO/socket/device and no hard-linked file; it is checked again before every run`,
      );
    }

    out.set(userId, {
      userId,
      label: typeof p.label === 'string' ? p.label.trim() : userId,
      channels,
      cwd: p.cwd,
      mode,
      systemPrompt: typeof p.systemPrompt === 'string' ? p.systemPrompt : undefined,
      toolPolicy: {
        tools,
        allowedTools: allowed,
        disallowedTools: disallowed,
        mode: 'dontAsk',
        strictMcp: true,
        settingSources,
      },
      enforcedBy: 'daemon',
    });
  }

  // A channel in two policies is fine. A channel that is also the audit channel is checked by the caller.
  return out;
}

/**
 * The argv fragment the daemon appends to the `claude` command for a run that carries `toolPolicy`. One element per argv
 * entry (the daemon execs without a shell, so there is no quoting). The prompt is not here: it goes in on stdin. The
 * daemon adds nothing else for a policy run (no `--mcp-config`, no `--permission-prompt-tool`).
 *
 * Pinned against `claude` 2.1.310 by running it: `--tools`, `--allowedTools`, `--disallowedTools` are variadic, so each is
 * followed by its values and the next `--flag` ends it; `--permission-mode dontAsk` denies a tool that is not allowed at
 * once instead of waiting for an answer nobody gives; `--setting-sources ''` loads no settings file.
 */
export function claudeArgsForToolPolicy(tp: ToolPolicy): string[] {
  return [
    '--tools',
    tp.tools.join(','),
    '--allowedTools',
    ...tp.allowedTools,
    '--disallowedTools',
    ...tp.disallowedTools,
    '--permission-mode',
    tp.mode,
    '--setting-sources',
    tp.settingSources.join(','),
    ...(tp.strictMcp ? ['--strict-mcp-config'] : []),
    '--disable-slash-commands',
  ];
}

/** Channel references the policies add, for checks against the audit channel. */
export function policyChannels(policies: ReadonlyMap<string, ResolvedUserPolicy>): string[] {
  return uniq([...policies.values()].flatMap((p) => p.channels));
}
