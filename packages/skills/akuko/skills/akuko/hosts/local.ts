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
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AkukoProjectSchema, type AkukoProject, type Asset, type Decision } from '../schema/akuko-project.ts';
import { classifyHost, defaultNodeDeps, probeNode, type NodeProbeDeps, type ProbeHints } from './detect.ts';
import { readJsonlStore } from '../decisions/jsonl.ts';
import { loadConformedFile } from '../decisions/conformed.ts';
import { assertPublishable, assetDir, assetId, buildAsset, safeBasename, SHIPPED_CONFORMED } from './shared.ts';
import type { AssetInput, Capabilities, HostAdapter, HostLevel, ViewArtifact } from './types.ts';
import { StateConflictError } from './conflict.ts';

export { StateConflictError, isStateConflict, STATE_CONFLICT } from './conflict.ts';

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

/** Errors Windows gives when the target is open in another program (an editor, a viewer, an indexer). */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Waits between rename attempts while the target is busy: about 2.5 s in all. */
export const RENAME_BACKOFF_MS = [10, 20, 40, 80, 150, 250, 400, 600, 900] as const;

/**
 * `rename(from, to)`, retried with a short backoff while Windows reports the
 * target busy (EPERM / EBUSY / EACCES: some program has it open, even only
 * to read it). After the last wait it throws a clear error naming the file
 * (Wave 3 review, finding 5). Other errors are thrown at once.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: { rename?: (a: string, b: string) => Promise<void>; backoff?: readonly number[] } = {},
): Promise<void> {
  const mv = opts.rename ?? rename;
  const waits = opts.backoff ?? RENAME_BACKOFF_MS;
  for (let i = 0; ; i++) {
    try {
      return await mv(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!BUSY.has(code)) throw err;
      if (i >= waits.length) {
        const e = new Error(`akuko: could not replace ${to}: another program has it open (${code}). Close it (or wait for it to finish), then try again; nothing was changed.`);
        (e as NodeJS.ErrnoException).code = code;
        throw e;
      }
      await sleep(waits[i]!);
    }
  }
}

/** Write via a temp file + rename so a crash never leaves a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, opts: Parameters<typeof renameWithRetry>[2] = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data);
    await renameWithRetry(tmp, path, opts);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

const digest = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** A lock older than this was left by a process that died holding it; it is taken over. */
export const LOCK_STALE_MS = 30_000;
/** How long `writeState` waits for another process's lock before giving up. */
export const LOCK_WAIT_MS = 10_000;

/**
 * Run `fn` holding `<path>.lock` (created exclusively; removed after).
 * Serialises `writeState` across processes on one project folder. A lock
 * whose mtime is older than LOCK_STALE_MS is removed and retried. (Two
 * processes taking over the same stale lock in the same instant could both
 * proceed; the compare-and-swap in `writeState` still runs under each.)
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, opts: { waitMs?: number; staleMs?: number } = {}): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  await mkdir(dirname(path), { recursive: true });
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      const fh = await open(lock, 'wx');
      try { await fh.writeFile(`${process.pid}
`); } finally { await fh.close(); }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EPERM: on Windows a lock that is being deleted can't be created yet.
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > (opts.staleMs ?? LOCK_STALE_MS)) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`akuko: ${path} is locked by another akuko process (${lock}). Wait for it to finish, then try again; if none is running, delete the .lock file.`);
      }
      await sleep(delay);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
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
  /** sha256 of `akuko.json` as this host last read or wrote it; undefined until it has. */
  private seen: string | undefined;

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
    this.seen = digest(raw);
    return AkukoProjectSchema.parse(JSON.parse(raw));
  }

  /**
   * Validate, then write `akuko.json` atomically. An invalid project is never written.
   *
   * Compare-and-swap (Wave 3 review, finding 1): under `akuko.json.lock`,
   * the file on disk must still be the one this host last read or wrote;
   * otherwise another process (or an editor) changed it in between, nothing
   * is written, and `StateConflictError` is thrown. The spend gate redoes
   * its read → check → write on that error, so two processes on one project
   * can't overrun the cap or lose a ledger entry. A host that has never read
   * the file writes it as before (creating a project).
   */
  async writeState(p: AkukoProject): Promise<void> {
    const valid = AkukoProjectSchema.parse(p);
    const text = serializeProject(valid);
    await withFileLock(this.projectFile, async () => {
      if (this.seen !== undefined) {
        const now = await readFile(this.projectFile).then(digest, (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        });
        if (now !== this.seen) {
          throw new StateConflictError(`akuko: ${this.projectFile} changed on disk since akuko read it (another akuko run, or an edit); nothing was written. Run the step again: it starts from the current file.`);
        }
      }
      await writeFileAtomic(this.projectFile, text);
      this.seen = digest(text);
    });
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

  /**
   * Write the view to `<project>/views/<name>.html` and return its path. A view
   * that writes decisions is refused unless its exact HTML is on the skill's
   * `views/conformed.json` or `<project>/views/conformed.json` (C8; a
   * missing file is an empty list). Read-only views publish freely.
   */
  async publishView(v: ViewArtifact): Promise<{ url?: string; path?: string }> {
    await assertPublishable(v, () => [loadConformedFile(SHIPPED_CONFORMED), loadConformedFile(join(this.projectDir, VIEWS_DIR, 'conformed.json'))]);
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
