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

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AkukoProjectSchema, type AkukoProject, type Asset, type Decision } from '../schema/akuko-project.ts';
import { classifyHost, defaultNodeDeps, probeNode, type NodeProbeDeps, type ProbeHints } from './detect.ts';
import { readJsonlStore } from '../decisions/jsonl.ts';
import { loadConformedFile } from '../decisions/conformed.ts';
import { assertPublishable, assetDir, assetId, buildAsset, safeBasename, SHIPPED_CONFORMED, viewFileStem } from './shared.ts';
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
        const e = new Error(`akuko: could not replace ${to} (${code}): another program may have it open, or akuko may not be allowed to write there. Close it, or check the folder's permissions, then try again; nothing was changed.`);
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
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A lock older than this was left by a process that died holding it; it is taken over. */
export const LOCK_STALE_MS = 30_000;
/** How long `writeState` waits for another process's lock before giving up. */
export const LOCK_WAIT_MS = 10_000;
/** Failed creates (EPERM / EACCES) with no lock file there before it counts as a permission error, not a lock being deleted. */
const PERMISSION_TRIES = 20;

/** What `fn` gets while it holds the lock. */
export interface HeldLock {
  /** Is the lock file still ours? (False only if it was taken over as stale while we held it.) */
  stillHeld(): Promise<boolean>;
}

const lockState = (lock: string): Promise<{ content: string; mtimeMs: number } | undefined> =>
  Promise.all([readFile(lock, 'utf8'), stat(lock)]).then(([content, st]) => ({ content, mtimeMs: st.mtimeMs }), () => undefined);

/** Create `path` exclusively, holding `content`. Returns the error instead of throwing. */
async function createExclusive(path: string, content: string): Promise<NodeJS.ErrnoException | undefined> {
  try {
    const fh = await open(path, 'wx');
    try { await fh.writeFile(content); } finally { await fh.close(); }
    return undefined;
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
}

/**
 * Remove a stale lock without ever removing a live one. Only one process at
 * a time takes over: it must first create `<lock>.takeover` exclusively,
 * then it re-reads the lock and removes it only if it is still the same
 * stale file (same pid + nonce, still old). A process that judged the lock
 * stale just before another one replaced it finds new content and leaves it
 * alone (review of #199, C1). A `.takeover` file older than staleMs was
 * left by a process that died during this short step and is removed.
 */
async function takeOverStale(lock: string, stale: { content: string }, token: string, staleMs: number): Promise<boolean> {
  const guard = `${lock}.takeover`;
  const err = await createExclusive(guard, token);
  if (err) {
    const g = await lockState(guard);
    if (g && Date.now() - g.mtimeMs > staleMs) {
      const again = await lockState(guard);
      if (again && again.content === g.content) await rm(guard, { force: true });
    }
    return false;
  }
  try {
    const now = await lockState(lock);
    if (now && now.content === stale.content && Date.now() - now.mtimeMs > staleMs) {
      await rm(lock, { force: true });
      return true;
    }
    return false;
  } finally {
    if ((await lockState(guard))?.content === token) await rm(guard, { force: true });
  }
}

/**
 * Run `fn` holding `<path>.lock`: created exclusively, holding this
 * process's pid and a random nonce, and removed afterwards only if it still
 * holds them (so a slow holder never removes a successor's lock).
 * Serialises `writeState` across processes on one project folder.
 *
 * A lock whose mtime is older than LOCK_STALE_MS was left by a process that
 * died; it is taken over under a second lock (takeOverStale), so two
 * processes can't both take it over. `fn` gets `stillHeld()` to check,
 * just before it writes, that its own lock was not taken over (it would
 * have had to hold it for LOCK_STALE_MS). A create that keeps failing with
 * EPERM / EACCES while no lock file exists is a permission problem and is
 * reported as one.
 */
export async function withFileLock<T>(path: string, fn: (held: HeldLock) => Promise<T>, opts: { waitMs?: number; staleMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<T> {
  const lock = `${path}.lock`;
  const token = `${process.pid} ${randomUUID()}
`;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  let denied = 0;
  await mkdir(dirname(path), { recursive: true });
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    const err = await createExclusive(lock, token);
    if (!err) break;
    // EPERM: on Windows a lock file that is being deleted can't be created yet.
    if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    const held = await lockState(lock);
    if (!held) {
      if (err.code !== 'EEXIST' && ++denied >= PERMISSION_TRIES) {
        throw Object.assign(new Error(`akuko: cannot create ${lock} (${err.code}): akuko is not allowed to write in ${dirname(lock)}. Check that folder's permissions; nothing was written.`), { code: err.code, cause: err });
      }
    } else {
      denied = 0;
      if (Date.now() - held.mtimeMs > staleMs) {
        // Retry at once only if the stale lock was actually removed. Otherwise
        // (the takeover guard is held, even by a crashed taker's fresh one) fall
        // through to the deadline check and the sleep instead of spinning.
        if (await takeOverStale(lock, held, token, staleMs)) continue;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`akuko: ${path} is locked by another akuko process (${lock}). Wait for it to finish, then try again; if none is running, delete the .lock file.`);
    }
    await (opts.sleep ?? sleep)(delay);
  }
  const stillHeld = async (): Promise<boolean> => (await lockState(lock))?.content === token;
  try {
    return await fn({ stillHeld });
  } finally {
    if (await stillHeld()) await rm(lock, { force: true });
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

  /**
   * Read and validate `akuko.json`. Throws when it is missing or invalid,
   * or not UTF-8 (a clear error, never a lossy read). The compare-and-swap
   * remembers the hash of the raw bytes: the same bytes `writeState` hashes.
   */
  async readState(): Promise<AkukoProject> {
    const bytes = await readFile(this.projectFile);
    let raw: string;
    try {
      raw = UTF8.decode(bytes);
    } catch {
      throw new Error(`akuko: ${this.projectFile} is not valid UTF-8 (was it saved in another encoding, such as Windows-1252?). Re-save it as UTF-8, then try again; akuko always writes UTF-8.`);
    }
    this.seen = digest(bytes);
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
   *
   * What it remembers belongs to this host instance: use one instance per
   * gate, and don't interleave another caller's read-modify-write on it, or
   * the check compares against the wrong read (lib/spend.md).
   */
  async writeState(p: AkukoProject): Promise<void> {
    const valid = AkukoProjectSchema.parse(p);
    const text = serializeProject(valid);
    await withFileLock(this.projectFile, async (held) => {
      if (this.seen !== undefined) {
        const now = await readFile(this.projectFile).then(digest, (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        });
        if (now !== this.seen) {
          throw new StateConflictError(`akuko: ${this.projectFile} changed on disk since akuko read it (another akuko run, or an edit); nothing was written. Run the step again: it starts from the current file.`);
        }
      }
      if (!(await held.stillHeld())) {
        throw new StateConflictError(`akuko: lost the lock on ${this.projectFile} (held too long, taken over as stale); nothing was written. Run the step again.`);
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
    const path = join(this.projectDir, VIEWS_DIR, `${viewFileStem(v.name)}.html`);
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
