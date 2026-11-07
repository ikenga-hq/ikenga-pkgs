/**
 * akuko — host detection.
 *
 * `classifyHost()` is the one rule every adapter uses to turn capabilities
 * into a level; `probeNode()` gathers capabilities when this code runs in a
 * Node process (Claude Code, Ikenga's engine). Every probe input is
 * injectable so tests can simulate each host.
 *
 * Level rule (01 §Host levels):
 *   C ikenga          — an Ikenga shell is reachable or the Studio MCP is connected
 *   B local           — shell + DURABLE project filesystem
 *   A claude-artifact — anything else. claude.ai's chat has Bash and a
 *                       workspace fs too, but both are remote and ephemeral,
 *                       so a claude.ai tool list sets `fs: false` (see
 *                       `isClaudeAiToolList`) and lands here.
 * `AKUKO_HOST=A|B|C` forces a level (manual host check, or to keep a local
 * run out of a running Ikenga).
 *
 * No runtime dependencies (node builtins only; schema imports are type-only),
 * so it runs straight from an installed skill:
 *   node --experimental-strip-types hosts/detect.ts [--tools a,b,…]
 * prints `{ level, capabilities }` as JSON. `--tools` takes the agent's tool
 * names (e.g. `mcp__studio__list_projects,ArtifactData`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Host } from '../schema/akuko-project.ts';
import type { Capabilities, HostLevel } from './types.ts';

export const HOST_LABEL: Record<HostLevel, string> = {
  A: 'claude-artifact',
  B: 'local',
  C: 'ikenga',
};

export const NO_CAPABILITIES: Capabilities = Object.freeze({
  shell: false,
  fs: false,
  artifactDb: false,
  ikengaBridge: false,
  studioMcp: false,
  codeExec: false,
  connectedMcps: [] as string[],
}) as Capabilities;

/** Fill missing fields with `false` / `[]`; de-duplicate and sort MCP names. */
export function normalizeCapabilities(c: Partial<Capabilities>): Capabilities {
  const mcps = [...new Set((c.connectedMcps ?? []).map((s) => s.trim()).filter(Boolean))].sort();
  const studioMcp = Boolean(c.studioMcp) || mcps.some(isStudioServer);
  return {
    shell: Boolean(c.shell),
    fs: Boolean(c.fs),
    artifactDb: Boolean(c.artifactDb),
    ikengaBridge: Boolean(c.ikengaBridge),
    studioMcp,
    codeExec: Boolean(c.codeExec),
    connectedMcps: mcps,
  };
}

export function isHostLevel(v: unknown): v is HostLevel {
  return v === 'A' || v === 'B' || v === 'C';
}

/** Capabilities → level. `override` (e.g. `AKUKO_HOST`) wins when valid. */
export function classifyHost(c: Capabilities, override?: string): HostLevel {
  const forced = override?.trim().toUpperCase();
  if (isHostLevel(forced)) return forced;
  if (c.ikengaBridge || c.studioMcp) return 'C';
  if (c.shell && c.fs) return 'B';
  return 'A';
}

/** True for a server name that is the Ikenga Studio MCP (`studio`, `com.ikenga.studio`, …). */
export function isStudioServer(name: string): boolean {
  return /(^|[._-])studio$/i.test(name.trim());
}

/**
 * MCP server names from an agent's tool list. Claude Code names MCP tools
 * `mcp__<server>__<tool>`; the server is the segment between `mcp__` and the
 * next `__`. Non-MCP tools are ignored.
 */
export function mcpServersFromToolNames(toolNames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of toolNames) {
    const m = /^mcp__(.+?)__./.exec(t);
    if (m?.[1]) out.add(m[1]);
  }
  return [...out].sort();
}

/** True when the agent's tool list can read/write a Claude artifact database. */
export function hasArtifactDbTool(toolNames: readonly string[]): boolean {
  return toolNames.includes('ArtifactData');
}

/** The `akuko.json.host` record for a detection result (capabilities flattened to scalars). */
export function toHostRecord(level: HostLevel, c: Capabilities): Host {
  return {
    level,
    label: HOST_LABEL[level],
    capabilities: {
      shell: c.shell,
      fs: c.fs,
      artifactDb: c.artifactDb,
      ikengaBridge: c.ikengaBridge,
      studioMcp: c.studioMcp,
      codeExec: c.codeExec,
      connectedMcps: c.connectedMcps.join(','),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Node probe
// ─────────────────────────────────────────────────────────────────────────

/** Everything `probeNode` reads from the outside world. All injectable for tests. */
export interface NodeProbeDeps {
  env: Record<string, string | undefined>;
  platform: string;
  home: string;
  exists(path: string): boolean;
  readFile(path: string): string;
  pidAlive(pid: number): boolean;
  /** `globalThis.__ikenga_host__` — set by the Ikenga bridge inside an artifact page. */
  ikengaHostGlobal: unknown;
}

export interface ProbeHints {
  /** The agent's tool names; MCP servers and the ArtifactData tool are read from them. */
  toolNames?: readonly string[];
  /** Extra connected MCP servers / connectors the agent knows about. */
  connectedMcps?: readonly string[];
}

export function defaultNodeDeps(): NodeProbeDeps {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    ikengaHostGlobal: (globalThis as { __ikenga_host__?: unknown }).__ikenga_host__,
  };
}

/**
 * Where the Ikenga shell writes its bridge control file. Mirrors
 * `iyke-cli/src/control.rs#control_path` (`dirs::data_local_dir()` joined
 * with the bundle id `app.ikenga`).
 */
export function ikengaControlPath(d: Pick<NodeProbeDeps, 'env' | 'platform' | 'home'>): string {
  if (d.platform === 'win32') {
    return win32.join(d.env.LOCALAPPDATA ?? win32.join(d.home, 'AppData', 'Local'), 'app.ikenga', 'control.json');
  }
  const base = d.platform === 'darwin'
    ? posix.join(d.home, 'Library', 'Application Support')
    : d.env.XDG_DATA_HOME ?? posix.join(d.home, '.local', 'share');
  return posix.join(base, 'app.ikenga', 'control.json');
}

/** True when a live Ikenga shell's control file exists (its recorded pid is alive). */
export function ikengaShellRunning(d: NodeProbeDeps): boolean {
  const path = ikengaControlPath(d);
  if (!d.exists(path)) return false;
  try {
    const cf = JSON.parse(d.readFile(path)) as { pid?: unknown; port?: unknown };
    return typeof cf.pid === 'number' && typeof cf.port === 'number' && d.pidAlive(cf.pid);
  } catch {
    return false;
  }
}

/**
 * Shell tools (Claude Code's names; claude.ai's chat uses the same `Bash`).
 * Exact names only — a near miss like `bash_tool` doesn't count.
 */
export const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell'];

export function hasShellTool(toolNames: readonly string[]): boolean {
  return toolNames.some((t) => SHELL_TOOLS.includes(t));
}

/**
 * MCP server names that only claude.ai's chat has. Exact match: Claude Code
 * names claude.ai connectors `claude_ai_<Connector>` (e.g. `claude_ai_Canva`),
 * which must NOT match. Observed on claude.ai 2026-11-07 (manual check A2).
 */
export const CLAUDE_AI_SERVERS: readonly string[] = ['claude_ai'];

/**
 * Built-in (non-MCP) tools that only claude.ai's chat has: chat history and
 * conversation control. Observed on claude.ai 2026-11-07 (manual check A2);
 * absent from the Claude desktop app's Code tab and the Claude Code CLI.
 * claude.ai's `memory_*` tools are left out on purpose: "memory" is also a
 * common MCP server name in Claude Code setups.
 */
export const CLAUDE_AI_TOOLS: readonly string[] = [
  'conversation_search',
  'recent_chats',
  'read_conversation',
  'end_conversation',
];

/** True when a tool list comes from claude.ai's chat (host A), whatever else it contains. */
export function isClaudeAiToolList(toolNames: readonly string[]): boolean {
  if (toolNames.some((t) => CLAUDE_AI_TOOLS.includes(t))) return true;
  return mcpServersFromToolNames(toolNames).some((s) => CLAUDE_AI_SERVERS.includes(s));
}

/** A shell binary that exists on any normal machine of that platform. */
export function shellBinaryPath(d: Pick<NodeProbeDeps, 'env' | 'platform'>): string {
  if (d.platform === 'win32') {
    return win32.join(d.env.SystemRoot ?? d.env.windir ?? 'C:\\Windows', 'System32', 'cmd.exe');
  }
  return '/bin/sh';
}

/**
 * Can the agent run shell commands (anywhere — on host A that is claude.ai's
 * cloud workspace)?
 *   - A tool list was passed → it decides: true iff it contains `Bash` or
 *     `PowerShell`.
 *   - No tool list (a script or CI run with no agent) → `SHELL` / `ComSpec`
 *     in the environment, else a shell binary on disk (`/bin/sh`,
 *     `%SystemRoot%\System32\cmd.exe`), e.g. a bare Docker container.
 * Having a shell does not make a host B: see `hasDurableFs`.
 */
export function detectShell(hints: ProbeHints, deps: NodeProbeDeps): boolean {
  const tools = hints.toolNames ?? [];
  if (tools.length > 0) return hasShellTool(tools);
  if (deps.env.SHELL || deps.env.ComSpec || deps.env.COMSPEC) return true;
  return deps.exists(shellBinaryPath(deps));
}

/**
 * Does this runtime have DURABLE access to the project folder? False on
 * claude.ai (its workspace is remote and lasts one chat), detected from the
 * tool list. With no tool list there is no claude.ai fingerprint we trust
 * (see lib/hosts.md §How the level is decided), so a plain Node run counts as
 * durable — agents on claude.ai must always pass `--tools`.
 */
export function hasDurableFs(hints: ProbeHints): boolean {
  return !isClaudeAiToolList(hints.toolNames ?? []);
}

/** Capabilities of the Node process this code runs in. */
export function probeNode(hints: ProbeHints = {}, deps: NodeProbeDeps = defaultNodeDeps()): Capabilities {
  const tools = hints.toolNames ?? [];
  return normalizeCapabilities({
    shell: detectShell(hints, deps),
    fs: hasDurableFs(hints),
    codeExec: true, // this code is running
    artifactDb: hasArtifactDbTool(tools),
    ikengaBridge: deps.ikengaHostGlobal != null || ikengaShellRunning(deps),
    connectedMcps: [...mcpServersFromToolNames(tools), ...(hints.connectedMcps ?? [])],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// CLI (lib/hosts.md §Manual host check)
// ─────────────────────────────────────────────────────────────────────────

/** `--tools a,b` / `--tools=a,b` → tool names. Other arguments are ignored. */
export function parseCliArgs(argv: readonly string[]): { toolNames: string[] } {
  const toolNames: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--tools') toolNames.push(...(argv[++i] ?? '').split(',').filter(Boolean));
    else if (arg.startsWith('--tools=')) toolNames.push(...arg.slice(8).split(',').filter(Boolean));
  }
  return { toolNames };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const { toolNames } = parseCliArgs(process.argv.slice(2));
  const deps = defaultNodeDeps();
  const capabilities = probeNode({ toolNames }, deps);
  const level = classifyHost(capabilities, deps.env.AKUKO_HOST);
  const out: Record<string, unknown> = { level, label: HOST_LABEL[level], capabilities, ikengaControlFile: ikengaControlPath(deps) };
  if (toolNames.length === 0) {
    out.warning = 'no --tools passed: claude.ai cannot be recognised without the tool list; an agent must pass its full tool list';
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
