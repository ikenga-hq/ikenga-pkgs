// Host detection + adapters, against simulated hosts (G-HOST).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  toHostRecord,
  type NodeProbeDeps,
} from './detect.ts';
import { createNodeHost, IkengaHost } from './ikenga.ts';
import { createLocalHost, LocalHost, PROJECT_FILE, serializeProject } from './local.ts';
import { NotImplementedError } from './shared.ts';
import type { AssetInput, HostAdapter, WaveOneHost } from './types.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/the-beating/akuko.json', import.meta.url));
const fixture = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
const NOW = new Date('2026-11-07T12:00:00.000Z');

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

  it('nothing at all is A (instruction-only)', () => {
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

  it('a Node sandbox with no shell (e.g. a chat code tool) → A, codeExec true', async () => {
    const d = await detectWith(sim({ env: {} }));
    assert.equal(d.level, 'A');
    assert.equal(d.capabilities.codeExec, true);
  });

  it('AKUKO_HOST=B keeps a local run out of a running Ikenga', async () => {
    const d = await detectWith(sim({ env: { SHELL: '/bin/bash', AKUKO_HOST: 'B' }, files: { [LINUX_CONTROL]: control(1) }, alive: [1] }));
    assert.equal(d.level, 'B');
    assert.equal(d.capabilities.ikengaBridge, true);
  });

  it('claude.ai (instruction-only adapter, Canva connected) → A', async () => {
    const host = createClaudeArtifactHost({ ...fakeBindings().b, capabilities: { connectedMcps: ['Canva'] } });
    const d = await host.detect();
    assert.equal(d.level, 'A');
    assert.deepEqual(d.capabilities, { ...NO_CAPABILITIES, artifactDb: true, connectedMcps: ['Canva'] });
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

  it('publishView returns the artifact url', async () => {
    const f = fakeBindings();
    assert.deepEqual(await createClaudeArtifactHost(f.b).publishView({ name: 'board', html: '' }), { url: 'https://claude.ai/artifact/board' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// readDecisions is a signature until WP-07a
// ─────────────────────────────────────────────────────────────────────────

describe('readDecisions (WP-07a)', () => {
  const cases: [string, HostAdapter, RegExp][] = [
    ['A', createClaudeArtifactHost(fakeBindings().b), /WP-07a \(decisions\/artifact-db\.ts\)/],
    ['B', createLocalHost({ projectDir: '/p' }), /WP-07a \(decisions\/jsonl\.ts\)/],
    ['C', new IkengaHost({ projectDir: '/p' }), /WP-07a \(decisions\/ikenga\.ts\)/],
  ];
  for (const [level, host, msg] of cases) {
    it(`host ${level} rejects with a clear not-implemented error`, async () => {
      await assert.rejects(host.readDecisions(), (e: unknown) => e instanceof NotImplementedError && msg.test(e.message));
    });
  }
});

// Compile-time: every adapter satisfies the wave-1 subset WP-03 codes against.
const _waveOne: WaveOneHost[] = [createLocalHost({ projectDir: '/p' }), new IkengaHost({ projectDir: '/p' }), createClaudeArtifactHost(fakeBindings().b)];
void _waveOne;
