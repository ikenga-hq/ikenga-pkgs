/**
 * akuko — host B, local (Claude Code).
 *
 * Source of truth: `<project>/akuko.json` on disk. Assets are files in the
 * project folder; views are HTML files under `<project>/views/`; decisions
 * land in `<project>/decisions.jsonl` (read by `decisions/jsonl.ts`, WP-07a).
 *
 * Executable: scripts import `createLocalHost` (needs the package's deps —
 * zod, @ikenga/studio-schema). Detection alone has no dependencies:
 * `node --experimental-strip-types hosts/detect.ts` (lib/hosts.md).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AkukoProjectSchema, type AkukoProject, type Asset, type Decision } from '../schema/akuko-project.ts';
import { classifyHost, defaultNodeDeps, probeNode, type NodeProbeDeps, type ProbeHints } from './detect.ts';
import { readJsonlStore } from '../decisions/jsonl.ts';
import { assetDir, assetId, buildAsset, safeBasename } from './shared.ts';
import type { AssetInput, Capabilities, HostAdapter, HostLevel, ViewArtifact } from './types.ts';

export const PROJECT_FILE = 'akuko.json';
export const VIEWS_DIR = 'views';

export interface LocalHostOptions {
  /** The akuko project folder (holds `akuko.json`). */
  projectDir: string;
  /** Tool names / connectors the agent has — feeds `detect()`. */
  hints?: ProbeHints;
  /** Probe inputs; tests replace them to simulate hosts. */
  deps?: NodeProbeDeps;
  /** Clock for `updated_at`; tests pin it. */
  now?: () => Date;
}

/** JSON exactly as akuko writes it: two-space indent, trailing newline. */
export function serializeProject(p: AkukoProject): string {
  return `${JSON.stringify(p, null, 2)}\n`;
}

/** Write via a temp file + rename so a crash never leaves a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** First free `<stem>[-n]<ext>` in `dir`. Existing files are never overwritten. */
export function freeName(dir: string, basename: string, exists: (p: string) => boolean = existsSync): string {
  if (!exists(join(dir, basename))) return basename;
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const ext = dot > 0 ? basename.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!exists(join(dir, candidate))) return candidate;
  }
}

export class LocalHost implements HostAdapter {
  readonly projectDir: string;
  protected readonly hints: ProbeHints;
  protected readonly deps: NodeProbeDeps;
  protected readonly now: () => Date;

  constructor(opts: LocalHostOptions) {
    this.projectDir = opts.projectDir;
    this.hints = opts.hints ?? {};
    this.deps = opts.deps ?? defaultNodeDeps();
    this.now = opts.now ?? (() => new Date());
  }

  get projectFile(): string {
    return join(this.projectDir, PROJECT_FILE);
  }

  async detect(): Promise<{ level: HostLevel; capabilities: Capabilities }> {
    const capabilities = probeNode(this.hints, this.deps);
    return { level: classifyHost(capabilities, this.deps.env.AKUKO_HOST), capabilities };
  }

  /** Read and validate `akuko.json`. Throws when it is missing or invalid. */
  async readState(): Promise<AkukoProject> {
    const raw = await readFile(this.projectFile, 'utf8');
    return AkukoProjectSchema.parse(JSON.parse(raw));
  }

  /** Validate, then write `akuko.json` atomically. An invalid project is never written. */
  async writeState(p: AkukoProject): Promise<void> {
    const valid = AkukoProjectSchema.parse(p);
    await writeFileAtomic(this.projectFile, serializeProject(valid));
  }

  /** Write the bytes under the project folder; return the Asset (not yet in akuko.json). */
  async storeAsset(a: AssetInput): Promise<Asset> {
    const rel = assetDir(a);
    const dir = join(this.projectDir, ...rel.split('/'));
    // Everything that can fail validation happens before anything touches disk.
    const name = freeName(dir, safeBasename(a.filename));
    // A requested id is honoured as given; otherwise the id comes from the
    // FINAL (de-duplicated) file name, so two stores never share an id.
    const id = assetId({ id: a.id, filename: name });
    const hash = createHash('sha256').update(a.data).digest('hex');
    const asset = buildAsset(a, { uri: `${rel}/${name}`, hash }, id, this.now());
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), a.data, { flag: 'wx' });
    return asset;
  }

  /** Write the view to `<project>/views/<name>.html` and return its path. */
  async publishView(v: ViewArtifact): Promise<{ url?: string; path?: string }> {
    const path = join(this.projectDir, VIEWS_DIR, `${safeBasename(v.name).replace(/\.html?$/i, '')}.html`);
    await writeFileAtomic(path, v.html);
    return { path };
  }

  /** Delegates to `decisions/jsonl.ts`: `<project>/decisions.jsonl`. `since` is a `jsonl:<offset>` cursor. */
  async readDecisions(since?: string): Promise<Decision[]> {
    return (await readJsonlStore(this.projectDir, since)).decisions;
  }
}

export function createLocalHost(opts: LocalHostOptions): LocalHost {
  return new LocalHost(opts);
}
