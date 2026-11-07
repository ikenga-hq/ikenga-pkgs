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
 *   B local           — shell + filesystem
 *   A claude-artifact — anything else (no shell, no Studio MCP)
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

/** Capabilities of the Node process this code runs in. */
export function probeNode(hints: ProbeHints = {}, deps: NodeProbeDeps = defaultNodeDeps()): Capabilities {
  const tools = hints.toolNames ?? [];
  const shell = Boolean(deps.env.SHELL || deps.env.ComSpec || deps.env.COMSPEC);
  return normalizeCapabilities({
    shell,
    fs: true,       // node:fs is loaded, or this module would not have imported
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
  process.stdout.write(`${JSON.stringify({ level, label: HOST_LABEL[level], capabilities, ikengaControlFile: ikengaControlPath(deps) }, null, 2)}\n`);
}
