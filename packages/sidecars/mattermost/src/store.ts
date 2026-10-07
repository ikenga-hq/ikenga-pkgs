import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * A turn that was in flight when the record was last written. Kept so a
 * bridge restart can re-attach to the run and finish the progress post
 * instead of leaving it saying "Working..." forever.
 */
export interface ActiveTurn {
  run_id: string;
  progress_post_id: string;
  started_at: number;
  /** The notice shown above the progress text ("started a fresh run..."), if any. */
  notice?: string;
}

export interface ThreadRecord {
  root_id: string;
  run_id: string;
  bot: string;
  channel_id: string;
  /**
   * The exact prompt the run was started with. `chi_status` reports a run that
   * wrote no output as `output = <this prompt>` (the cache row's `brief`), so
   * the bridge must recognise it and not post it back as a "result".
   */
  brief: string;
  created_at: number;
  updated_at: number;
  active?: ActiveTurn;
}

interface StoreFile {
  version: 1;
  threads: Record<string, ThreadRecord>;
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `root_id -> Chi run` map for one bot, in a JSON file. Reads are served from
 * memory; every mutation rewrites the file atomically (temp file in the same
 * directory, then rename), so a crash leaves either the old or the new file,
 * never half of one.
 */
export class ThreadStore {
  private threads = new Map<string, ThreadRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly bot: string,
    private readonly retentionMs: number = DEFAULT_RETENTION_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get(rootId: string): ThreadRecord | undefined {
    const rec = this.threads.get(rootId);
    return rec && rec.bot === this.bot ? rec : undefined;
  }

  /** Threads with a turn that never finished, for restart recovery. */
  activeThreads(): ThreadRecord[] {
    return [...this.threads.values()].filter((r) => r.bot === this.bot && r.active);
  }

  size(): number {
    return this.threads.size;
  }

  async put(rec: ThreadRecord): Promise<void> {
    this.threads.set(rec.root_id, { ...rec, bot: this.bot });
    await this.flush();
  }

  async update(rootId: string, patch: Partial<Omit<ThreadRecord, 'root_id' | 'bot'>>): Promise<void> {
    const cur = this.threads.get(rootId);
    if (!cur) return;
    const next: ThreadRecord = { ...cur, ...patch, updated_at: this.now() };
    if (patch.active === undefined && 'active' in patch) delete next.active;
    this.threads.set(rootId, next);
    await this.flush();
  }

  async remove(rootId: string): Promise<void> {
    if (this.threads.delete(rootId)) await this.flush();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`thread store: cannot read ${this.filePath}: ${(err as Error).message}`);
    }
    let parsed: StoreFile;
    try {
      parsed = JSON.parse(raw) as StoreFile;
    } catch {
      // A corrupt store must not stop the bridge. Keep the evidence, start empty.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${this.now()}`);
      } catch {
        /* best effort */
      }
      console.error(`thread store ${this.filePath} was unreadable; moved aside and starting empty`);
      return;
    }
    const cutoff = this.now() - this.retentionMs;
    for (const rec of Object.values(parsed.threads ?? {})) {
      if (rec && rec.root_id && rec.run_id && rec.updated_at >= cutoff) this.threads.set(rec.root_id, rec);
    }
  }

  /** Serialised, atomic write of the whole map. */
  private flush(): Promise<void> {
    const snapshot: StoreFile = { version: 1, threads: Object.fromEntries(this.threads) };
    const body = JSON.stringify(snapshot, null, 2);
    this.writing = this.writing.then(() => {
      const dir = path.dirname(this.filePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, body, { mode: 0o600 });
        renameSync(tmp, this.filePath);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        console.error(`thread store: write failed: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }
}
