// Host detection + adapters, against simulated hosts (G-HOST).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AkukoProjectSchema, AssetSchema, HostSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { createClaudeArtifactHost, PROJECT_DOC } from './claude-artifact.ts';
import {
  classifyHost,
  ikengaControlPath,
  mcpServersFromToolNames,
  NO_CAPABILITIES,
  normalizeCapabilities,
  parseCliArgs,
  probeNode,
  shellBinaryPath,
  toHostRecord,
  type NodeProbeDeps,
} from './detect.ts';
import { createIkengaHost, createNodeHost, IkengaHost } from './ikenga.ts';
import { createLocalHost, LocalHost, PROJECT_FILE, serializeProject, writeFileAtomic } from './local.ts';
import { NotImplementedError } from './shared.ts';
import type { AssetInput, HostAdapter, WaveOneHost } from './types.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/the-beating/akuko.json', import.meta.url));
const fixture = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
const NOW = new Date('2026-11-07T12:00:00.000Z');

/**
 * claude.ai chat tool list, as observed in the G-HOST manual check (A2,
 * 2026-11-07, Sonnet 5.5; 157 tools). Bare names and MCP server segments are
 * as observed; the `__tool` suffixes after a server are placeholders (the
 * per-tool names were not recorded and detection only reads the server).
 */
const CLAUDE_AI_TOOLS_OBSERVED = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'ToolSearch', 'ArtifactData',
  'conversation_search', 'recent_chats', 'read_conversation', 'end_conversation',
  'memory_read', 'memory_write',
  'mcp__claude_ai__tool', 'mcp__Canva__tool', 'mcp__Claude_Docs__tool', 'mcp__Google_Calendar__tool',
  'mcp__claude-code-remote__tool', 'mcp__claude-in-chrome__tool', 'mcp__memory__tool',
  'mcp__remote-devices__tool', 'mcp__visualize__tool', 'mcp__widgets__tool',
];

/**
 * Claude desktop app, Code tab (the session that built WP-02; real names).
 * The B counterexample: it shares Bash, ArtifactData, claude-in-chrome and
 * visualize with claude.ai but has no claude.ai-only signal.
 */
const DESKTOP_CODE_TAB_TOOLS = [
  'Agent', 'Artifact', 'Bash', 'Edit', 'Glob', 'Grep', 'PowerShell', 'Read', 'SearchPlugins', 'Skill', 'ToolSearch', 'Write',
  'ArtifactComments', 'ArtifactData', 'Monitor', 'WebFetch', 'WebSearch',
  'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch', 'mcp__520e91dc-b31f-4939-9157-d07c1e43c896__generate-image',
  'mcp__ccd_session__mark_chapter', 'mcp__ccd_turn__update_plan', 'mcp__Claude_Browser__navigate',
  'mcp__claude-in-chrome__navigate', 'mcp__computer-use__screenshot', 'mcp__scheduled-tasks__list_scheduled_tasks',
  'mcp__terminal__read_terminal', 'mcp__visualize__show_widget',
];

/** A simulated machine. `files` maps absolute path → contents; `alive` lists live pids. */
function sim(over: Partial<NodeProbeDeps> & { files?: Record<string, string>; alive?: number[] } = {}): NodeProbeDeps {
  const files = over.files ?? {};
  const alive = new Set(over.alive ?? []);
  return {
    env: over.env ?? {},
    platform: over.platform ?? 'linux',
    home: over.home ?? '/home/u',
    exists: over.exists ?? ((p) => p in files),
    readFile: over.readFile ?? ((p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    }),
    pidAlive: over.pidAlive ?? ((pid) => alive.has(pid)),
    ikengaHostGlobal: over.ikengaHostGlobal,
  };
}

const LINUX_CONTROL = '/home/u/.local/share/app.ikenga/control.json';
const control = (pid: number) => JSON.stringify({ schema_version: 1, port: 7777, token: 't', pid, started_at_unix_ms: 1, identifier: 'app.ikenga' });

const tmpRoots: string[] = [];
function tmpProject(withFixture = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'akuko-host-'));
  tmpRoots.push(dir);
  if (withFixture) {
    // write through the serializer so the file is exactly what writeState produces
    writeFileSync(join(dir, PROJECT_FILE), serializeProject(fixture()));
  }
  return dir;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const png = (n = 1): AssetInput => ({
  kind: 'keyframe',
  filename: 'sc1_sh2-keyframe.png',
  mime: 'image/png',
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]),
  owner: 'sc1_sh2',
  provider: 'manual',
});

// ─────────────────────────────────────────────────────────────────────────

describe('classifyHost', () => {
  const c = (p: Parameters<typeof normalizeCapabilities>[0]) => normalizeCapabilities(p);

  it('nothing at all is A', () => {
    assert.equal(classifyHost(NO_CAPABILITIES), 'A');
  });
  it('artifact DB without shell is A', () => {
    assert.equal(classifyHost(c({ artifactDb: true, connectedMcps: ['Canva'] })), 'A');
  });
  it('code execution without a shell is still A', () => {
    assert.equal(classifyHost(c({ codeExec: true, fs: true })), 'A');
  });
  it('shell + fs is B', () => {
    assert.equal(classifyHost(c({ shell: true, fs: true, codeExec: true })), 'B');
  });
  it('an Ikenga bridge makes it C', () => {
    assert.equal(classifyHost(c({ shell: true, fs: true, ikengaBridge: true })), 'C');
  });
  it('the Studio MCP alone makes it C', () => {
    assert.equal(classifyHost(c({ connectedMcps: ['studio'] })), 'C');
  });
  it('AKUKO_HOST overrides, case-insensitively; junk is ignored', () => {
    const b = c({ shell: true, fs: true });
    assert.equal(classifyHost(b, 'a'), 'A');
    assert.equal(classifyHost(b, 'C'), 'C');
    assert.equal(classifyHost(b, 'local'), 'B');
  });
});

describe('capability helpers', () => {
  it('reads MCP servers from tool names', () => {
    assert.deepEqual(
      mcpServersFromToolNames(['Bash', 'mcp__studio__list_projects', 'mcp__studio__render', 'mcp__claude-in-chrome__navigate', 'mcp__x', 'ArtifactData']),
      ['claude-in-chrome', 'studio'],
    );
  });
  it('normalizes: dedupes + sorts MCPs, derives studioMcp', () => {
    const n = normalizeCapabilities({ connectedMcps: ['studio', ' canva ', 'canva', ''] });
    assert.deepEqual(n.connectedMcps, ['canva', 'studio']);
    assert.equal(n.studioMcp, true);
    assert.equal(normalizeCapabilities({ connectedMcps: ['studio-breakdown-x'] }).studioMcp, false);
    assert.equal(normalizeCapabilities({ connectedMcps: ['com.ikenga.studio'] }).studioMcp, true);
  });
  it('control.json path matches iyke-cli on each OS', () => {
    assert.equal(ikengaControlPath({ platform: 'linux', home: '/home/u', env: {} }), '/home/u/.local/share/app.ikenga/control.json');
    assert.equal(ikengaControlPath({ platform: 'linux', home: '/home/u', env: { XDG_DATA_HOME: '/x' } }), '/x/app.ikenga/control.json');
    assert.equal(ikengaControlPath({ platform: 'darwin', home: '/Users/u', env: {} }), '/Users/u/Library/Application Support/app.ikenga/control.json');
    assert.equal(ikengaControlPath({ platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'D:\\Local' } }), 'D:\\Local\\app.ikenga\\control.json');
    assert.equal(ikengaControlPath({ platform: 'win32', home: 'C:\\Users\\u', env: {} }), 'C:\\Users\\u\\AppData\\Local\\app.ikenga\\control.json');
  });
  it('the host record validates against the schema', () => {
    const rec = toHostRecord('C', normalizeCapabilities({ shell: true, fs: true, connectedMcps: ['studio', 'canva'] }));
    assert.equal(HostSchema.safeParse(rec).success, true);
    assert.equal(rec.label, 'ikenga');
    assert.equal(rec.capabilities.connectedMcps, 'canva,studio');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// detect() on simulated hosts
// ─────────────────────────────────────────────────────────────────────────

describe('detect() — simulated hosts', () => {
  const detectWith = (deps: NodeProbeDeps, toolNames: string[] = []) =>
    createLocalHost({ projectDir: '/p', deps, hints: { toolNames } }).detect();

  it('Claude Code on Linux/macOS (SHELL set, no Ikenga) → B', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash' } }), ['Bash', 'Read']);
    assert.equal(d.level, 'B');
    assert.deepEqual(d.capabilities, { ...NO_CAPABILITIES, shell: true, fs: true, codeExec: true });
  });

  it('Claude Code on Windows (ComSpec only) → B', async () => {
    const d = await detectWith(sim({ platform: 'win32', home: 'C:\\Users\\u', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } }));
    assert.equal(d.level, 'B');
  });

  it('Claude Code desktop with the ArtifactData tool → B with artifactDb', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/zsh' } }), ['Bash', 'ArtifactData', 'mcp__claude_ai_Canva__generate']);
    assert.equal(d.level, 'B');
    assert.equal(d.capabilities.artifactDb, true);
    assert.deepEqual(d.capabilities.connectedMcps, ['claude_ai_Canva']);
  });

  it('a running Ikenga shell (live control.json) → C', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash' }, files: { [LINUX_CONTROL]: control(42) }, alive: [42] }));
    assert.equal(d.level, 'C');
    assert.equal(d.capabilities.ikengaBridge, true);
  });

  it('a stale control.json (dead pid) is not a bridge → B', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash' }, files: { [LINUX_CONTROL]: control(42) }, alive: [] }));
    assert.equal(d.level, 'B');
    assert.equal(d.capabilities.ikengaBridge, false);
  });

  it('a corrupt control.json is not a bridge', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash' }, files: { [LINUX_CONTROL]: '{nope' } }));
    assert.equal(d.capabilities.ikengaBridge, false);
  });

  it('inside an Ikenga artifact page (window.__ikenga_host__) → C', async () => {
    const d = await detectWith(sim({ ikengaHostGlobal: { kind: 'ikenga', user: null } }));
    assert.equal(d.level, 'C');
  });

  it('Studio MCP in the tool list → C, studio listed', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash' } }), ['mcp__studio__list_projects']);
    assert.equal(d.level, 'C');
    assert.equal(d.capabilities.studioMcp, true);
    assert.deepEqual(d.capabilities.connectedMcps, ['studio']);
  });

  it('a Node runtime with no shell and no tool list → A, codeExec true', async () => {
    const d = await detectWith(sim({ env: {} }));
    assert.equal(d.level, 'A');
    assert.equal(d.capabilities.codeExec, true);
  });

  // SHELL / ComSpec unset (Claude Code in Docker, a bare CI container): G-HOST review condition 1.
  it('SHELL/ComSpec unset + a Bash tool → B', async () => {
    const d = await detectWith(sim({ env: {} }), ['Bash', 'Read', 'Write']);
    assert.equal(d.level, 'B');
    assert.equal(d.capabilities.shell, true);
  });

  it('SHELL/ComSpec unset + a PowerShell tool on Windows → B', async () => {
    const d = await detectWith(sim({ platform: 'win32', home: 'C:\\Users\\u', env: {} }), ['PowerShell', 'Read']);
    assert.equal(d.level, 'B');
  });

  it('SHELL/ComSpec unset, no tool list, /bin/sh present (bare container script) → B', async () => {
    const d = await detectWith(sim({ env: {}, files: { '/bin/sh': '' } }));
    assert.equal(d.level, 'B');
  });

  it('SHELL/ComSpec unset, no tool list, cmd.exe present on Windows → B', async () => {
    const files = { 'D:\\Win\\System32\\cmd.exe': '' };
    const d = await detectWith(sim({ platform: 'win32', home: 'C:\\Users\\u', env: { SystemRoot: 'D:\\Win' }, files }));
    assert.equal(d.level, 'B');
    assert.equal(shellBinaryPath({ platform: 'win32', env: {} }), 'C:\\Windows\\System32\\cmd.exe');
  });

  it('a tool list without a shell tool keeps a sandbox with /bin/sh at A', async () => {
    const d = await detectWith(sim({ env: {}, files: { '/bin/sh': '' } }), ['bash_tool', 'create_file', 'view']);
    assert.equal(d.level, 'A');
    assert.equal(d.capabilities.shell, false);
  });

  it('SHELL set + tool list without a shell tool → A', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash' }, files: { '/bin/sh': '' } }), ['ArtifactData']);
    assert.equal(d.level, 'A');
    assert.equal(d.capabilities.shell, false);
    assert.equal(d.capabilities.artifactDb, true);
  });

  it('ComSpec set + tool list with only mcp__ names → A (the full list must include the shell tool)', async () => {
    const d = await detectWith(sim({ platform: 'win32', home: 'C:\\Users\\u', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } }), ['mcp__claude-in-chrome__navigate']);
    assert.equal(d.level, 'A');
  });

  it('SHELL/ComSpec unset, no tools, no shell binary → A', async () => {
    assert.equal((await detectWith(sim({ env: {} }))).level, 'A');
  });

  it('AKUKO_HOST=B keeps a local run out of a running Ikenga', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash', AKUKO_HOST: 'B' }, files: { [LINUX_CONTROL]: control(1) }, alive: [1] }));
    assert.equal(d.level, 'B');
    assert.equal(d.capabilities.ikengaBridge, true);
  });

  it('claude.ai adapter with detect.ts output (shell + workspace, fs false) stays A', async () => {
    const capabilities = probeNode({ toolNames: CLAUDE_AI_TOOLS_OBSERVED }, sim({ env: { SHELL: '/bin/bash' } }));
    assert.equal((await createClaudeArtifactHost({ ...fakeBindings().b, capabilities }).detect()).level, 'A');
  });

  it('claude.ai adapter (DB by tool calls, Canva connected) → A', async () => {
    const host = createClaudeArtifactHost({ ...fakeBindings().b, capabilities: { connectedMcps: ['Canva'] } });
    const d = await host.detect();
    assert.equal(d.level, 'A');
    assert.deepEqual(d.capabilities, { ...NO_CAPABILITIES, artifactDb: true, codeExec: true, connectedMcps: ['Canva'] });
  });

  // G-HOST manual check A2 (2026-11-07): claude.ai has Bash + a workspace fs, and must still be A.
  it('claude.ai observed tool list, SHELL set, /bin/sh present → A (fs false, codeExec true)', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash', HOME: '/home/claude' }, home: '/root', files: { '/bin/sh': '' } }), CLAUDE_AI_TOOLS_OBSERVED);
    assert.equal(d.level, 'A');
    assert.equal(d.capabilities.shell, true);
    assert.equal(d.capabilities.fs, false);
    assert.equal(d.capabilities.codeExec, true);
    assert.equal(d.capabilities.artifactDb, true);
    assert.ok(d.capabilities.connectedMcps.includes('claude_ai'));
  });

  it('one mcp__claude_ai__ tool beside Bash is enough for A', async () => {
    assert.equal((await detectWith(sim({ env: { SHELL: '/bin/bash' } }), ['Bash', 'Read', 'mcp__claude_ai__tool'])).level, 'A');
  });

  it('one claude.ai-only built-in tool beside Bash is enough for A', async () => {
    for (const t of ['conversation_search', 'recent_chats', 'read_conversation', 'end_conversation']) {
      assert.equal((await detectWith(sim({ env: { SHELL: '/bin/bash' } }), ['Bash', t])).level, 'A', t);
    }
  });

  it('Claude desktop Code tab tool list → B (no claude.ai-only signal)', async () => {
    const d = await detectWith(sim({ platform: 'win32', home: 'C:\\Users\\u', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } }), DESKTOP_CODE_TAB_TOOLS);
    assert.equal(d.level, 'B');
    assert.equal(d.capabilities.fs, true);
    assert.equal(d.capabilities.artifactDb, true);
  });

  it('Claude Code CLI claude.ai connectors (server claude_ai_Canva) and a `memory` MCP stay B', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash' } }), ['Bash', 'Read', 'mcp__claude_ai_Canva__generate', 'mcp__memory__create_entities']);
    assert.equal(d.level, 'B');
  });

  it('createNodeHost refuses host A (the project lives in the artifact DB)', async () => {
    await assert.rejects(
      createNodeHost({ projectDir: '/p', deps: sim({ env: { SHELL: '/bin/bash' } }), hints: { toolNames: CLAUDE_AI_TOOLS_OBSERVED } }),
      /ClaudeArtifactHost/,
    );
  });

  it('createNodeHost picks IkengaHost on C and LocalHost on B', async () => {
    const c = await createNodeHost({ projectDir: '/p', deps: sim({ ikengaHostGlobal: {} }) });
    const b = await createNodeHost({ projectDir: '/p', deps: sim({ env: { SHELL: 'sh' } }) });
    assert.ok(c instanceof IkengaHost);
    assert.ok(b instanceof LocalHost && !(b instanceof IkengaHost));
  });

  it('probeNode runs against the real process without throwing', () => {
    const c = probeNode();
    assert.equal(c.fs, true);
    assert.equal(c.codeExec, true);
  });

  it('CLI args parse tool names', () => {
    assert.deepEqual(parseCliArgs(['--tools', 'Bash,mcp__studio__x']), { toolNames: ['Bash', 'mcp__studio__x'] });
    assert.deepEqual(parseCliArgs(['--tools=ArtifactData']).toolNames, ['ArtifactData']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Local adapter (B; C shares it)
// ─────────────────────────────────────────────────────────────────────────

describe('LocalHost state + assets', () => {
  it('readState → writeState round-trips the fixture byte for byte', async () => {
    const dir = tmpProject();
    const host = createLocalHost({ projectDir: dir });
    const before = readFileSync(join(dir, PROJECT_FILE), 'utf8');
    await host.writeState(await host.readState());
    assert.equal(readFileSync(join(dir, PROJECT_FILE), 'utf8'), before);
  });

  it('writeState refuses an invalid project and leaves the file untouched', async () => {
    const dir = tmpProject();
    const host = createLocalHost({ projectDir: dir });
    const before = readFileSync(join(dir, PROJECT_FILE), 'utf8');
    const bad = { ...(await host.readState()), current_stage: 'nope' } as unknown as AkukoProject;
    await assert.rejects(host.writeState(bad));
    assert.equal(readFileSync(join(dir, PROJECT_FILE), 'utf8'), before);
  });

  it('readState rejects when there is no akuko.json', async () => {
    await assert.rejects(createLocalHost({ projectDir: tmpProject(false) }).readState());
  });

  it('storeAsset writes the bytes in the project layout and returns a valid Asset', async () => {
    const dir = tmpProject(false);
    const host = createLocalHost({ projectDir: dir, now: () => NOW });
    const a = await host.storeAsset(png());
    assert.equal(AssetSchema.safeParse(a).success, true);
    assert.equal(a.id, 'sc1_sh2-keyframe');
    assert.equal(a.stage, 'keyframes');
    assert.equal(a.status, 'pending-review');
    assert.equal(a.file?.uri, 'board/panels/sc1_sh2-keyframe.png');
    assert.equal(a.file?.mime, 'image/png');
    assert.match(a.file?.hash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(a.updated_at, NOW.toISOString());
    assert.deepEqual([...readFileSync(join(dir, 'board', 'panels', 'sc1_sh2-keyframe.png'))], [...png().data]);
    assert.equal(existsSync(join(dir, PROJECT_FILE)), false, 'storeAsset must not write akuko.json');
  });

  it('storeAsset never overwrites; ids and owners route the file', async () => {
    const dir = tmpProject(false);
    const host = createLocalHost({ projectDir: dir });
    await host.storeAsset(png(1));
    const second = await host.storeAsset({ ...png(2), id: 'kf_sc1_sh2_v2' });
    assert.equal(second.file?.uri, 'board/panels/sc1_sh2-keyframe-2.png');
    assert.equal(second.id, 'kf_sc1_sh2_v2');
    const sheet = await host.storeAsset({ kind: 'turnaround', filename: '../../evil name.png', mime: 'image/png', data: new Uint8Array([1]), owner: 'char_narrator' });
    assert.equal(sheet.file?.uri, 'bible/characters/char_narrator/refs/evil-name.png');
    assert.equal(sheet.stage, 'bible');
    await assert.rejects(host.storeAsset({ ...png(), id: 'bad id!' }));
  });

  it('storing the same file name twice gives two distinct ids from the final names', async () => {
    const dir = tmpProject(false);
    const host = createLocalHost({ projectDir: dir });
    const a = await host.storeAsset(png(1));
    const b = await host.storeAsset(png(2));
    const c = await host.storeAsset(png(3));
    assert.deepEqual([a.id, b.id, c.id], ['sc1_sh2-keyframe', 'sc1_sh2-keyframe-2', 'sc1_sh2-keyframe-3']);
    assert.deepEqual([a.file?.uri, b.file?.uri, c.file?.uri], [
      'board/panels/sc1_sh2-keyframe.png', 'board/panels/sc1_sh2-keyframe-2.png', 'board/panels/sc1_sh2-keyframe-3.png',
    ]);
  });

  it('a requested id is honoured even when the file name is de-duplicated', async () => {
    const dir = tmpProject(false);
    const host = createLocalHost({ projectDir: dir });
    await host.storeAsset({ ...png(1), id: 'kf_v1' });
    const second = await host.storeAsset({ ...png(2), id: 'kf_v2' });
    assert.equal(second.id, 'kf_v2');
    assert.equal(second.file?.uri, 'board/panels/sc1_sh2-keyframe-2.png');
  });

  it('a bad id or owner is refused before anything is written', async () => {
    const dir = tmpProject(false);
    const host = createLocalHost({ projectDir: dir });
    await assert.rejects(host.storeAsset({ ...png(), id: 'bad id!' }), /invalid asset id/);
    await assert.rejects(host.storeAsset({ ...png(), owner: 'bad owner!' }));
    assert.deepEqual(readdirSync(dir), [], 'no file and no folder was created');
  });

  it('writeFileAtomic removes its temp file when the write fails', async () => {
    const dir = tmpProject(false);
    mkdirSync(join(dir, 'target.json')); // rename onto a directory fails
    await assert.rejects(writeFileAtomic(join(dir, 'target.json'), '{}'));
    assert.deepEqual(readdirSync(dir), ['target.json']);
  });

  it('publishView writes views/<name>.html', async () => {
    const dir = tmpProject(false);
    const r = await createLocalHost({ projectDir: dir }).publishView({ name: 'default-board', html: '<!doctype html><title>b</title>' });
    assert.equal(r.path, join(dir, 'views', 'default-board.html'));
    assert.equal(readFileSync(r.path ?? '', 'utf8'), '<!doctype html><title>b</title>');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Claude artifact adapter (A) over fake bindings
// ─────────────────────────────────────────────────────────────────────────

function fakeBindings() {
  const docs = new Map<string, Record<string, unknown>>();
  const uploads: { filename: string; mime: string }[] = [];
  const published: string[] = [];
  const b = {
    artifactUrl: 'https://claude.ai/artifact/fake',
    getDoc: async (p: string) => docs.get(p),
    setDoc: async (p: string, d: Record<string, unknown>) => void docs.set(p, structuredClone(d)),
    uploadAsset: async (a: { filename: string; mime: string }) => {
      uploads.push(a);
      return { id: `a${uploads.length}`, url: `/_blob/a${uploads.length}` };
    },
    publish: async (v: { name: string }) => {
      published.push(v.name);
      return { url: `https://claude.ai/artifact/${v.name}` };
    },
    now: () => NOW,
  };
  return { b, docs, uploads, published };
}

describe('ClaudeArtifactHost', () => {
  it('reads and writes the project doc, validating both ways', async () => {
    const f = fakeBindings();
    const host = createClaudeArtifactHost(f.b);
    await assert.rejects(host.readState(), /no project/);
    await host.writeState(fixture());
    assert.ok(f.docs.has(PROJECT_DOC));
    assert.deepEqual(await host.readState(), fixture());
    await assert.rejects(host.writeState({ ...fixture(), format: 'x' } as unknown as AkukoProject));
  });

  it('storeAsset uploads and points the asset at the returned url', async () => {
    const f = fakeBindings();
    const a = await createClaudeArtifactHost(f.b).storeAsset(png());
    assert.equal(a.file?.uri, '/_blob/a1');
    assert.equal(AssetSchema.safeParse(a).success, true);
    assert.deepEqual(f.uploads, [{ filename: 'sc1_sh2-keyframe.png', mime: 'image/png', data: png().data }]);
  });

  it('storeAsset ids are unique per upload unless an id is requested; bad input never uploads', async () => {
    const f = fakeBindings();
    const host = createClaudeArtifactHost(f.b);
    const a = await host.storeAsset(png(1));
    const b = await host.storeAsset(png(2));
    assert.deepEqual([a.id, b.id], ['sc1_sh2-keyframe-a1', 'sc1_sh2-keyframe-a2']);
    assert.equal((await host.storeAsset({ ...png(3), id: 'kf_v3' })).id, 'kf_v3');
    await assert.rejects(host.storeAsset({ ...png(), id: 'bad id!' }));
    await assert.rejects(host.storeAsset({ ...png(), owner: 'bad owner!' }));
    assert.equal(f.uploads.length, 3, 'rejected inputs were not uploaded');
  });

  it('publishView returns the artifact url', async () => {
    const f = fakeBindings();
    assert.deepEqual(await createClaudeArtifactHost(f.b).publishView({ name: 'board', html: '' }), { url: 'https://claude.ai/artifact/board' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// readDecisions delegates to decisions/<store>.ts (WP-07a)
// ─────────────────────────────────────────────────────────────────────────

describe('readDecisions (WP-07a)', () => {
  const DEC_FX = fileURLToPath(new URL('../decisions/__fixtures__/', import.meta.url));
  const recordedIds = readFileSync(join(DEC_FX, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { id: string }).id).sort();
  const idsOf = (ds: { id: string }[]) => ds.map((d) => d.id).sort();

  it('no host throws NotImplementedError any more', async () => {
    const hosts: HostAdapter[] = [createLocalHost({ projectDir: tmpProject(false) }), new IkengaHost({ projectDir: tmpProject(false) })];
    for (const h of hosts) {
      const r = await h.readDecisions().then((x) => x, (e: unknown) => e);
      assert.ok(!(r instanceof NotImplementedError));
      assert.deepEqual(r, []);
    }
  });

  it('B reads <project>/decisions.jsonl (decisions/jsonl.ts), honouring a cursor', async () => {
    const dir = tmpProject(false);
    writeFileSync(join(dir, 'decisions.jsonl'), readFileSync(join(DEC_FX, 'decisions.jsonl')));
    const host = createLocalHost({ projectDir: dir });
    assert.deepEqual(idsOf(await host.readDecisions()), recordedIds);
    assert.deepEqual(await host.readDecisions(`jsonl:${readFileSync(join(dir, 'decisions.jsonl')).length}`), []);
  });

  it('C mirrors iframe-state into decisions.jsonl, then reads the mirror (decisions/ikenga.ts)', async () => {
    const dir = tmpProject(false);
    writeFileSync(join(dir, 'decisions.jsonl'), readFileSync(join(DEC_FX, 'ikenga-mirror.jsonl')));
    const state = readFileSync(join(DEC_FX, 'iframe-state.txt'), 'utf8');
    const host = createIkengaHost({ projectDir: dir, readIframeState: async () => state });
    assert.deepEqual(idsOf(await host.readDecisions()), recordedIds);
    // the pane reloaded: its state is gone, the mirror is not
    const after = createIkengaHost({ projectDir: dir, readIframeState: async () => undefined });
    assert.deepEqual(idsOf(await after.readDecisions()), recordedIds);
  });

  it('A lists the `decisions` collection through the binding (decisions/artifact-db.ts)', async () => {
    const rows = JSON.parse(readFileSync(join(DEC_FX, 'artifact-db-list.json'), 'utf8'));
    const asked: string[] = [];
    const host = createClaudeArtifactHost({ ...fakeBindings().b, listCollection: async (c: string) => { asked.push(c); return rows; } });
    assert.deepEqual(idsOf(await host.readDecisions()), recordedIds);
    assert.deepEqual(asked, ['decisions']);
  });

  it('A without a list binding says how to read the store with ArtifactData', async () => {
    await assert.rejects(createClaudeArtifactHost(fakeBindings().b).readDecisions(), /ArtifactData/);
  });
});

// Compile-time: every adapter satisfies the wave-1 subset WP-03 codes against.
const _waveOne: WaveOneHost[] = [createLocalHost({ projectDir: '/p' }), new IkengaHost({ projectDir: '/p' }), createClaudeArtifactHost(fakeBindings().b)];
void _waveOne;
