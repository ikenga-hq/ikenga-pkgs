import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditLog } from './audit.js';
import { SenderSocketError } from './sender-socket.js';
import type { SenderSocket, VaultEvent } from './sender-socket.js';
import type { MattermostPost, VaultNotesConfig } from './types.js';

const MAX_REMEMBERED = 5000;
const MAX_TEXT_FIELD = 80;
const VAULT_BATCH = 100;
const MAX_VAULT_BATCHES = 5;

// ── config ───────────────────────────────────────────────────────────────────

export interface ResolvedVaultNotes {
  channel: string;
  pollMs: number;
}

const VAULT_NOTES_KEYS = new Set(['enabled', 'channel', 'pollMs']);

/**
 * Validate an `outboxApprovals.vaultNotes` block. Throws naming the bot and field.
 * Returns `undefined` when absent or not enabled (`enabled` defaults to false).
 */
export function resolveVaultNotes(
  cfg: unknown,
  where: string,
  defaultChannel: string,
  defaultPollMs: number,
): ResolvedVaultNotes | undefined {
  if (cfg === undefined) return undefined;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${where}: outboxApprovals.vaultNotes must be an object`);
  }
  const c = cfg as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!VAULT_NOTES_KEYS.has(k)) {
      throw new Error(
        `${where}: outboxApprovals.vaultNotes: unknown field '${k}'; allowed: ${[...VAULT_NOTES_KEYS].join(', ')}`,
      );
    }
  }
  const bad = (field: string, msg: string) => new Error(`${where}: outboxApprovals.vaultNotes.${field} ${msg}`);

  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    throw bad('enabled', 'must be true or false');
  }

  let channel = defaultChannel;
  if (c.channel !== undefined) {
    if (typeof c.channel !== 'string' || !c.channel.trim()) {
      throw bad('channel', 'must be a non-empty string');
    }
    channel = c.channel.replace(/^#/, '').trim();
  }

  let pollMs = defaultPollMs;
  if (c.pollMs !== undefined) {
    const p = c.pollMs;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1000 || p > 3_600_000) {
      throw bad('pollMs', 'must be a whole number of ms from 1000 to 3600000');
    }
    pollMs = p;
  }

  if (c.enabled !== true) return undefined;
  return { channel, pollMs };
}

// ── escaping & formatting ───────────────────────────────────────────────────

/**
 * Escape a sender-provided text field so mentions, markdown and links cannot render.
 * Same discipline as outreach card fields.
 */
export function escapeVaultNoteField(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const noAddress = oneLine.replace(/\S+@\S+/g, '(address removed)');
  const short = noAddress.length > MAX_TEXT_FIELD ? `${noAddress.slice(0, MAX_TEXT_FIELD)}...` : noAddress;
  return short.replace(/@/g, '@\u200b').replace(/[`[\]<>]/g, ' ');
}

/** Format a short founder note for one vault event. Never includes key names' values. */
export function vaultNoteText(ev: VaultEvent): string {
  const actor = escapeVaultNoteField(ev.actor);
  const action = escapeVaultNoteField(ev.action);
  const label = escapeVaultNoteField(ev.label);
  const at = escapeVaultNoteField(ev.at);
  return `Sender vault: ${actor} performed '${action}' on ${label} (${at}).`;
}

// ── persistence ──────────────────────────────────────────────────────────────

export interface VaultNotesState {
  version: 1;
  /**
   * The cursor of the newest event processed.
   * `null` means first run: the current cursor will be fetched and stored without replaying history.
   */
  cursor: number | null;
  /** event id (as string) -> Mattermost post id */
  posted: Record<string, string>;
}

function emptyState(): VaultNotesState {
  return { version: 1, cursor: null, posted: {} };
}

/**
 * Persisted state of vault notes for one bot.
 * Same atomic-write discipline as OutreachStore / OutboxCardStore (temp file, rename, mode 0600).
 */
export class VaultNotesStore {
  readonly state: VaultNotesState = emptyState();
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {
    this.load();
  }

  save(): Promise<void> {
    this.prune();
    const body = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.then(() => {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
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
        console.error(`vault notes store: write failed: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }

  private prune(): void {
    const keys = Object.keys(this.state.posted);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) {
      delete this.state.posted[k];
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`vault notes store: cannot read ${this.filePath}: ${(err as Error).message}`);
    }
    let parsed: Partial<VaultNotesState>;
    try {
      parsed = JSON.parse(raw) as Partial<VaultNotesState>;
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      console.error(`vault notes store ${this.filePath} was unreadable; moved aside and starting empty`);
      return;
    }
    if (Number.isInteger(parsed.cursor) && (parsed.cursor as number) >= 0) {
      this.state.cursor = parsed.cursor as number;
    }
    for (const [k, v] of Object.entries(parsed.posted ?? {})) {
      if (typeof v === 'string') this.state.posted[k] = v;
    }
  }
}

// ── manager ──────────────────────────────────────────────────────────────────

export interface VaultNotesApi {
  reply(channelId: string, message: string): Promise<MattermostPost>;
  resolveChannelId(ref: string): Promise<string>;
}

export type VaultNotesSender = Pick<SenderSocket, 'vaultEvents'>;

export interface VaultNotesManagerOptions {
  bot: string;
  client: VaultNotesApi;
  store: VaultNotesStore;
  config: ResolvedVaultNotes;
  sender: VaultNotesSender;
  audit?: AuditLog;
  redact?: (s: string) => string;
  now?: () => number;
  log?: (msg: string) => void;
}

function codeOf(err: unknown): string {
  const raw = err instanceof SenderSocketError ? err.code : err instanceof Error ? err.message : 'error';
  return raw.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 60);
}

export class VaultNotesManager {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly redact: (s: string) => string;
  private channelId?: string;
  private timer?: NodeJS.Timeout;
  private cycling?: Promise<void>;
  private stopped = false;
  private lastSenderProblem?: string;

  constructor(private readonly opts: VaultNotesManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}] vault-notes: ${m}`));
    this.redact = opts.redact ?? ((s) => s);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.resolveChannel();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async whenIdle(): Promise<void> {
    await this.cycling;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runCycle()
        .catch((err) => this.log(`poll failed: ${this.redact(codeOf(err))}`))
        .finally(() => this.schedule(this.opts.config.pollMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private async resolveChannel(): Promise<string | undefined> {
    if (this.channelId) return this.channelId;
    try {
      return (this.channelId = await this.opts.client.resolveChannelId(this.opts.config.channel));
    } catch (err) {
      this.log(`channel lookup failed (${this.redact((err as Error).message)}); will retry`);
      return undefined;
    }
  }

  runCycle(): Promise<void> {
    if (this.cycling) return this.cycling;
    const run = this.cycleInner().finally(() => {
      if (this.cycling === run) this.cycling = undefined;
    });
    this.cycling = run;
    return run;
  }

  private async cycleInner(): Promise<void> {
    const { sender, store } = this.opts;

    // First run: establish current cursor, do not replay history
    if (store.state.cursor === null) {
      let cur = 0;
      try {
        while (true) {
          const res = await sender.vaultEvents(cur, VAULT_BATCH);
          if (res.cursor === cur || res.events.length === 0) {
            cur = res.cursor;
            break;
          }
          cur = res.cursor;
          if (res.events.length < VAULT_BATCH) break;
        }
        this.noteSender(undefined);
        store.state.cursor = cur;
        await store.save();
      } catch (err) {
        this.noteSender(codeOf(err));
      }
      return;
    }

    // Subsequent runs: fetch events after cursor and post notes
    let cur = store.state.cursor;
    for (let batch = 0; batch < MAX_VAULT_BATCHES; batch++) {
      let res: { events: VaultEvent[]; cursor: number };
      try {
        res = await sender.vaultEvents(cur, VAULT_BATCH);
        this.noteSender(undefined);
      } catch (err) {
        this.noteSender(codeOf(err));
        return;
      }

      if (res.events.length > 0) {
        const channelId = await this.resolveChannel();
        if (!channelId) return;
        for (const ev of res.events) {
          const key = String(ev.id);
          if (store.state.posted[key]) continue;
          const text = vaultNoteText(ev);
          const post = await this.opts.client.reply(channelId, text);
          store.state.posted[key] = post.id;
          this.opts.audit?.record('vault_note.posted', {
            event_id: ev.id,
            actor: ev.actor,
            group: ev.group,
            action: ev.action,
            post_id: post.id,
          });
          await store.save();
        }
      }

      if (res.cursor !== store.state.cursor) {
        store.state.cursor = res.cursor;
        cur = res.cursor;
        await store.save();
      }

      if (res.events.length < VAULT_BATCH) break;
    }
  }

  private noteSender(problem: string | undefined): void {
    if (problem === this.lastSenderProblem) return;
    this.lastSenderProblem = problem;
    this.log(problem ? `sender unavailable (${this.redact(problem)}); will keep trying` : 'sender reachable');
  }
}
