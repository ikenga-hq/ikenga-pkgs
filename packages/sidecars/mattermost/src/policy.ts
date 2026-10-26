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
 * probes that pinned it). Whether the daemon honours `toolPolicy` is NOT something the bridge can see, so every policy must
 * say how its limits are really enforced (`enforcedBy`). See the README, "User policies".
 */

/** Built-in Claude Code tool names a policy may mention. An unknown name is a typo or a tool this list has not caught up with: both are refused. */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'TaskOutput',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'Skill',
  'SlashCommand',
  'ExitPlanMode',
  'AskUserQuestion',
]);

/**
 * Tools that are always denied to a policy user, whatever the policy says, and that a policy may not allow: anything that
 * writes a file, reaches the network or starts another agent. They are added to `--disallowedTools` as well as being left out
 * of `--tools`, so a daemon that honours only one of the two still refuses them.
 */
export const POLICY_HARD_DENY: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'SlashCommand'];
const HARD_DENY_SET: ReadonlySet<string> = new Set(POLICY_HARD_DENY);

/** Read-side tools. Allowing one without a path scope would allow it everywhere (a bare `Read` rule reads `/etc`). */
const SCOPED_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS']);

/** Programs that run anything they are given: `Bash(bash:*)` is arbitrary Bash. Allowed only as `<interpreter> <script path> ...`. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'env', 'node', 'nodejs', 'bun', 'deno', 'npx', 'pnpm', 'npm', 'yarn', 'tsx',
  'python', 'python3', 'perl', 'ruby', 'php', 'lua', 'sudo', 'doas', 'xargs', 'eval', 'exec', 'nohup', 'timeout', 'time',
  'ssh', 'curl', 'wget', 'nc', 'ncat', 'socat', 'sqlite3', 'git',
]);

const SETTING_SOURCES: ReadonlySet<string> = new Set(['user', 'project', 'local']);
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

/** How the tool limits are really enforced: the operator's statement, recorded in the audit log. */
export type PolicyEnforcement = 'daemon' | 'settings-file';

/** One policy as written in `bridge.json`, under `userPolicies.<mattermost user id>`. */
export interface UserPolicy {
  /** Shown in the audit log and the operator commands. Default: the user id. */
  label?: string;
  /** Channels (name, `#name` or id) this user may use the bot in. Required. Independent of the bot's `allowedChannels`. */
  channels: string[];
  /** Working directory of this user's runs: a directory holding only what they may read. Absolute or `~/…`. Required; must differ from `chi.cwd`. */
  cwd: string;
  /** `default` (the default) or `plan`. `plan` refuses every command, including an allowed one, so it cannot queue anything. */
  mode?: string;
  /** Replaces `chi.systemPrompt` for this user's runs. Advisory: the limits do not depend on it. */
  systemPrompt?: string;
  /** Tool rules that run without asking, e.g. `Bash(bash scripts/cron/run-social-queue-submit.sh:*)`. Required, non-empty. Everything else is denied. */
  allowedTools: string[];
  /** The built-in tools the session has at all (`--tools`). Default: the tool names in `allowedTools`. */
  tools?: string[];
  /** Extra deny rules, added to the hard floor (`Write`, `Edit`, `WebFetch`, `WebSearch`, ...). */
  disallowedTools?: string[];
  /** Which settings files claude may read: any of `user`, `project`, `local`. Default `["project"]`, so the account's own `~/.claude/settings.json` cannot widen the policy. */
  settingSources?: string[];
  /** Required: `daemon` (the daemon applies `toolPolicy`) or `settings-file` (the policy cwd holds a `.claude/settings.json` from `--print-policy`). */
  enforcedBy: PolicyEnforcement;
}

/**
 * The one object sent to the daemon in `chi_run` as `opts.toolPolicy`, and the shape the daemon turns into `claude` flags.
 * It is deliberately complete: a daemon that applies it needs no other input.
 */
export interface ToolPolicy {
  /** `--tools`: the built-in tools that exist in the session. */
  tools: string[];
  /** `--allowedTools`: rules that run without a prompt. */
  allowedTools: string[];
  /** `--disallowedTools`: rules that are refused, always winning over an allow. */
  disallowedTools: string[];
  /** `--permission-prompts none`: anything not allowed is refused at once, nobody is asked. */
  permissionPrompts: 'none';
  /** `--setting-sources`. */
  settingSources: string[];
  /** `--strict-mcp-config` (with no `--mcp-config`): no MCP server, so no MCP tool. */
  strictMcpConfig: true;
  /** `--disable-slash-commands`. */
  disableSlashCommands: true;
}

export interface ResolvedUserPolicy {
  /** The Mattermost user id the policy is for. */
  userId: string;
  label: string;
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

/** A Bash rule must name a program or script, not "anything". */
function checkBashSpec(spec: string | undefined, label: string, where: string): void {
  const s = (spec ?? '').trim();
  if (!s) throw new Error(`${where}: ${label} is a bare Bash rule, which allows any command; name the one command it may run, e.g. Bash(bash scripts/cron/run-social-queue-submit.sh:*)`);
  // Strip the prefix wildcard (`:*` or ` *`) and look at what is left.
  const base = s.replace(/(?::\*|\s\*)$/, '').trim();
  if (!base || /^[*:]/.test(base)) throw new Error(`${where}: ${label} allows any command (it starts with a wildcard)`);
  const tokens = base.split(/\s+/);
  const first = (tokens[0] as string).split('/').pop() as string;
  if (INTERPRETERS.has(first)) {
    const arg = tokens[1];
    // `bash:*` and `bash -c:*` run anything; `bash scripts/x.sh:*` runs one script.
    if (!arg || arg.startsWith('-') || arg.includes('*')) {
      throw new Error(`${where}: ${label} lets '${first}' run any command; give it one script path, e.g. Bash(${first} scripts/cron/<script>.sh:*)`);
    }
  }
  if (/[;&|`\n]|\$\(/.test(base)) throw new Error(`${where}: ${label} contains a shell operator; allow one plain command`);
}

function checkRuleList(value: unknown, field: string, where: string, kind: 'allow' | 'deny'): string[] {
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
      throw new Error(`${where}: ${label}: unknown tool '${rule.name}' (known: ${[...KNOWN_TOOLS].join(', ')})`);
    }
    if (kind === 'allow') {
      if (HARD_DENY_SET.has(rule.name)) {
        throw new Error(`${where}: ${label}: ${rule.name} can never be allowed for a policy user (no file writes, no network, no sub-agents)`);
      }
      if (rule.name === 'Bash') checkBashSpec(rule.spec, label, where);
      if (SCOPED_TOOLS.has(rule.name) && !(rule.spec ?? '').trim()) {
        throw new Error(`${where}: ${label} has no path scope, so it would read anywhere; scope it, e.g. ${rule.name}(./docs/**)`);
      }
    }
    out.push((raw as string).trim());
  }
  return out;
}

function uniq(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function stripSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
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
  const allowedUsers = new Set(ctx.allowedUsers.map((u) => u.replace(/^@/, '')));

  for (const [userId, value] of entries) {
    const w = `${where}: userPolicies.${userId}`;
    if (!MM_ID.test(userId)) {
      throw new Error(`${w}: the key must be a Mattermost user id (26 lowercase letters and digits), not a username: a username can be renamed or reused`);
    }
    if (allowedUsers.has(userId)) throw new Error(`${w}: this user is also in allowedUsers, which would give them an unrestricted session; remove them from one of the two`);
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
    if (typeof p.cwd !== 'string' || !(p.cwd.startsWith('/') || p.cwd.startsWith('~/')) || p.cwd.split('/').includes('..')) {
      throw new Error(`${w}: cwd is required: an absolute path or ~/..., without '..' (a directory holding only what this user may read; never the bot's own cwd)`);
    }
    if (ctx.chi?.cwd && stripSlash(ctx.chi.cwd) === stripSlash(p.cwd)) {
      throw new Error(`${w}: cwd is the same as chi.cwd; a policy user needs a directory of their own`);
    }

    // The permission mode. `plan` is accepted but cannot run an allowed command (see README), `default` is the working one.
    const rawMode = p.mode === undefined ? 'default' : p.mode;
    if (rawMode !== 'default' && rawMode !== 'plan') throw new Error(`${w}: mode must be 'default' or 'plan' (got '${String(rawMode)}'); a policy user never gets acceptEdits or bypassPermissions`);
    const mode = rawMode as WireMode;
    if (modeRank(mode) > modeRank(ctx.maxMode)) {
      throw new Error(`${w}: mode '${mode}' is above this bot's ceiling (maxMode '${ctx.maxMode}'); set maxMode to 'default' to allow it`);
    }

    if (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 64)) throw new Error(`${w}: label must be a short non-empty string`);
    if (p.systemPrompt !== undefined && (typeof p.systemPrompt !== 'string' || !p.systemPrompt.trim())) throw new Error(`${w}: systemPrompt must be a non-empty string`);
    if (p.enforcedBy !== 'daemon' && p.enforcedBy !== 'settings-file') {
      throw new Error(
        `${w}: enforcedBy is required: 'daemon' (the Ikenga daemon applies toolPolicy as claude flags) or 'settings-file' (the policy cwd holds the .claude/settings.json printed by --print-policy). The bridge cannot see which is true, so it will not guess`,
      );
    }

    // What it may use.
    if (!Array.isArray(p.allowedTools) || p.allowedTools.length === 0) {
      throw new Error(`${w}: allowedTools must name at least one tool rule; an empty allowlist would be a session that can do nothing, or, on a daemon that ignores it, anything`);
    }
    const allowed = uniq(checkRuleList(p.allowedTools, 'allowedTools', w, 'allow'));
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

    const extraDeny = p.disallowedTools === undefined ? [] : checkRuleList(p.disallowedTools, 'disallowedTools', w, 'deny');
    const disallowed = uniq([...POLICY_HARD_DENY, ...extraDeny]);
    const clash = allowed.filter((r) => disallowed.includes(r));
    if (clash.length) throw new Error(`${w}: '${clash[0]}' is both allowed and disallowed`);

    let settingSources = ['project'];
    if (p.settingSources !== undefined) {
      if (!Array.isArray(p.settingSources) || p.settingSources.some((s) => typeof s !== 'string' || !SETTING_SOURCES.has(s))) {
        throw new Error(`${w}: settingSources must be a list drawn from user, project, local`);
      }
      settingSources = uniq(p.settingSources as string[]);
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
        permissionPrompts: 'none',
        settingSources,
        strictMcpConfig: true,
        disableSlashCommands: true,
      },
      enforcedBy: p.enforcedBy,
    });
  }

  // A channel in two policies is fine. A channel that is also the audit channel is checked by the caller.
  return out;
}

/**
 * The argv fragment the daemon appends to the `claude` command for a run that carries `toolPolicy`. One element per argv
 * entry (the daemon execs without a shell, so there is no quoting). The prompt is not here: it goes in on stdin.
 *
 * Pinned against `claude` 2.1.310 by running it: `--tools`, `--allowedTools`, `--disallowedTools` are variadic, so each is
 * followed by its values and the next `--flag` ends it; `--permission-prompts none` makes anything not allowed fail at once
 * instead of waiting for an answer nobody gives; in `--permission-mode plan` an allowed command is still refused, which is
 * why a policy runs in `default`.
 */
export function claudeArgsForToolPolicy(tp: ToolPolicy): string[] {
  return [
    '--tools',
    tp.tools.join(','),
    '--allowedTools',
    ...tp.allowedTools,
    '--disallowedTools',
    ...tp.disallowedTools,
    '--permission-prompts',
    tp.permissionPrompts,
    '--setting-sources',
    tp.settingSources.join(','),
    ...(tp.strictMcpConfig ? ['--strict-mcp-config'] : []),
    ...(tp.disableSlashCommands ? ['--disable-slash-commands'] : []),
  ];
}

/**
 * The `.claude/settings.json` for a policy's cwd, for `enforcedBy: "settings-file"` (and as defence in depth under `daemon`).
 * Project settings are read from the cwd, so this carries the allow and deny rules without any daemon support. It cannot
 * carry `--tools`, `--strict-mcp-config` or `--permission-prompts none`; the README says what that leaves open.
 */
export function policySettingsJson(policy: ResolvedUserPolicy): { permissions: { defaultMode: string; allow: string[]; deny: string[] } } {
  return {
    permissions: {
      defaultMode: policy.mode,
      allow: [...policy.toolPolicy.allowedTools],
      deny: [...policy.toolPolicy.disallowedTools],
    },
  };
}

/** Channels the policies add, for checks against the audit channel. */
export function policyChannels(policies: ReadonlyMap<string, ResolvedUserPolicy>): string[] {
  return uniq([...policies.values()].flatMap((p) => p.channels));
}
