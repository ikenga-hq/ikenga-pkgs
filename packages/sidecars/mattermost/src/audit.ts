import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

/**
 * B5 audit log: an append-only JSONL file per bot, written by the bridge.
 *
 * What it records is decided by the call sites, which pass explicit fields only (ids, names, modes, hashes,
 * statuses). The bridge never hands it a message, a prompt, a plan, a config object or an error string, so there is
 * nothing secret to leak by construction; `redact` is a second wall, applied to every string value.
 *
 * Integrity, said plainly. "Append-only" here means the bridge only ever appends or rotates; it cannot stop a
 * process running as the same Unix user from editing the file. Each record carries `prev`, the SHA-256 of the
 * previous line, so an edit, deletion or reordering in the middle of the retained history is detectable
 * (`--audit <bot> --verify`). Truncating the tail, or rewriting the whole chain, is not: that needs the file to be
 * owned by a different account than the agent, or the audit-channel mirror (an off-box copy).
 */

export const AUDIT_VERSION = 1;
const GENESIS = '0'.repeat(64);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 10;
const TAIL_BYTES = 64 * 1024;
const MAX_STRING = 300;
const MAX_ARRAY = 50;
const MAX_KEYS = 40;
const RESERVED = new Set(['v', 'ts', 'bot', 'event', 'prev']);
/** Mattermost caps a post at 16383 characters; a mirror line is far smaller. */
const MIRROR_MAX_QUEUE = 100;

export type AuditValue = string | number | boolean | null | undefined | string[];
export type AuditFields = Record<string, AuditValue>;

export interface AuditRecord {
  v: number;
  ts: string;
  bot: string;
  event: string;
  prev: string;
  [field: string]: unknown;
}

/** Thrown by `AuditLog.must` when a record cannot be made durable. `reason` is a short code, never a path or a secret. */
export class AuditUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: string = 'write-failed',
  ) {
    super(message);
    this.name = 'AuditUnavailableError';
  }
}

export interface AuditOptions {
  file: string;
  bot: string;
  /** Rotate when the live file would pass this size. Default 10 MiB. */
  maxBytes?: number;
  /** Rotated files kept (`<file>.1` newest ... `<file>.<keep>` oldest). Older ones are deleted. Default 10. */
  keep?: number;
  now?: () => number;
  /** Applied to every string value before it is written. */
  redact?: (s: string) => string;
  log?: (msg: string) => void;
}

/** `<dataDir>/audit-<bot>.jsonl` unless the bot's `audit.path` says otherwise. */
export function auditPath(dataDir: string, bot: string, override?: string): string {
  return override ?? path.join(dataDir, `audit-${bot}.jsonl`);
}

export interface ResolvedAuditConfig {
  channel?: string;
  promptHash: boolean;
  maxBytes: number;
  keep: number;
  path?: string;
}

const AUDIT_KEYS = new Set(['channel', 'promptHash', 'maxBytes', 'keep', 'path']);

/** Validate a bot's `audit` block. Throws, naming the bot. The audit channel must be write-only: not in `allowedChannels`. */
export function resolveAuditConfig(cfg: unknown, where: string, allowedChannels: string[]): ResolvedAuditConfig {
  const out: ResolvedAuditConfig = { promptHash: false, maxBytes: DEFAULT_MAX_BYTES, keep: DEFAULT_KEEP };
  if (cfg === undefined) return out;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${where}: audit must be an object`);
  const c = cfg as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!AUDIT_KEYS.has(k)) {
      const hint = k === 'enabled' || k === 'disabled' ? ' (the audit log cannot be switched off)' : '';
      throw new Error(`${where}: audit: unknown field '${k}'${hint}; allowed: ${[...AUDIT_KEYS].join(', ')}`);
    }
  }
  if (c.channel !== undefined) {
    if (typeof c.channel !== 'string' || !c.channel.replace(/^#/, '').trim()) throw new Error(`${where}: audit.channel must be a channel name or id`);
    const ch = c.channel.replace(/^#/, '').trim();
    if (allowedChannels.some((a) => a.replace(/^#/, '') === ch)) {
      throw new Error(`${where}: audit.channel '${ch}' is also in allowedChannels; the audit channel must be write-only (people talking there would reach the bot)`);
    }
    out.channel = ch;
  }
  if (c.promptHash !== undefined) {
    if (typeof c.promptHash !== 'boolean') throw new Error(`${where}: audit.promptHash must be true or false`);
    out.promptHash = c.promptHash;
  }
  if (c.maxBytes !== undefined) {
    if (typeof c.maxBytes !== 'number' || !Number.isFinite(c.maxBytes) || c.maxBytes < 1024) throw new Error(`${where}: audit.maxBytes must be a number of at least 1024`);
    out.maxBytes = Math.floor(c.maxBytes);
  }
  if (c.keep !== undefined) {
    if (typeof c.keep !== 'number' || !Number.isInteger(c.keep) || c.keep < 1 || c.keep > 1000) throw new Error(`${where}: audit.keep must be a whole number from 1 to 1000`);
    out.keep = c.keep;
  }
  if (c.path !== undefined) {
    if (typeof c.path !== 'string' || !path.isAbsolute(c.path)) throw new Error(`${where}: audit.path must be an absolute path`);
    out.path = c.path;
  }
  return out;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class AuditLog {
  readonly file: string;
  private readonly bot: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  private readonly redact: (s: string) => string;
  private readonly log: (msg: string) => void;
  private sink?: (rec: AuditRecord) => void;
  private readonly seen = new Map<string, { at: number; suppressed: number }>();

  constructor(opts: AuditOptions) {
    this.file = opts.file;
    this.bot = opts.bot;
    this.maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    this.keep = Math.max(1, Math.floor(opts.keep ?? DEFAULT_KEEP));
    this.now = opts.now ?? Date.now;
    this.redact = opts.redact ?? ((s) => s);
    this.log = opts.log ?? ((m) => console.error(`[mattermost:${opts.bot}:audit] ${m}`));
  }

  /** Receives each record after it is on disk (the Mattermost mirror). Never allowed to throw into the caller. */
  setSink(fn: ((rec: AuditRecord) => void) | undefined): void {
    this.sink = fn;
  }

  /** Append a record. Returns false (and logs) instead of throwing, for events that follow something already done. */
  record(event: string, fields: AuditFields = {}): boolean {
    try {
      this.append(event, fields, false);
      return true;
    } catch (err) {
      this.log(`FAILED to record ${event}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Append a record (fsynced) or throw `AuditUnavailableError`: for events that must exist before an action is taken. */
  must(event: string, fields: AuditFields = {}): void {
    try {
      this.append(event, fields, true);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'write-failed';
      this.log(`FAILED to record ${event}: ${(err as Error).message}`);
      throw new AuditUnavailableError(`audit log unavailable (${code})`, String(code));
    }
  }

  /**
   * Like `record`, but at most once per `windowMs` for the same `key`; the next record that does get through says how
   * many were left out (`suppressed`). For gate denials: a bot in a busy channel sees every post of everyone.
   */
  recordCoalesced(key: string, event: string, fields: AuditFields, windowMs = 60_000): boolean {
    const t = this.now();
    const prior = this.seen.get(key);
    if (prior && t - prior.at < windowMs) {
      prior.suppressed += 1;
      return false;
    }
    if (this.seen.size >= 1000) this.seen.delete(this.seen.keys().next().value as string);
    const suppressed = prior?.suppressed ?? 0;
    this.seen.set(key, { at: t, suppressed: 0 });
    return this.record(event, suppressed > 0 ? { ...fields, suppressed } : fields);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** `durable` fsyncs: only for records that precede an action (a slow disk must not stall every event). */
  private append(event: string, fields: AuditFields, durable: boolean): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const rec: AuditRecord = { v: AUDIT_VERSION, ts: new Date(this.now()).toISOString(), bot: this.bot, event, prev: '' };
    let n = 0;
    for (const [k, raw] of Object.entries(fields)) {
      if (RESERVED.has(k) || raw === undefined) continue;
      if (++n > MAX_KEYS) break;
      rec[k] = this.clean(raw);
    }

    const tail = this.tail();
    rec.prev = tail.hash;
    let torn = tail.torn;
    const body = `${JSON.stringify(rec)}\n`;
    // Rotate before writing. The hash of the last line does not change by renaming it, so the first record of the
    // new file chains onto the last record of the old one.
    if (tail.size > 0 && tail.size + body.length > this.maxBytes) {
      this.rotate();
      torn = false;
    }
    const line = `${torn ? '\n' : ''}${body}`;

    const created = !existsSync(this.file);
    const fd = openSync(this.file, 'a', 0o600);
    try {
      const buf = Buffer.from(line, 'utf8');
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off);
      if (durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) {
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* the open already asked for 0600 */
      }
    }

    if (this.sink) {
      try {
        this.sink(rec);
      } catch (err) {
        this.log(`audit mirror failed: ${(err as Error).message}`);
      }
    }
  }

  private clean(v: Exclude<AuditValue, undefined>): unknown {
    if (typeof v === 'string') return this.redact(v).slice(0, MAX_STRING);
    if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((s) => this.redact(String(s)).slice(0, MAX_STRING));
    return v;
  }

  /** Hash of the last line of the live file (else of the newest rotated file), plus whether that line was torn by a crash. */
  private tail(): { hash: string; torn: boolean; size: number } {
    for (const f of [this.file, `${this.file}.1`]) {
      const t = readTail(f);
      if (t === 'missing') continue;
      if (t.size === 0) continue;
      const live = f === this.file;
      return { hash: t.lastLine ? sha(t.lastLine) : GENESIS, torn: live && t.torn, size: live ? t.size : 0 };
    }
    return { hash: GENESIS, torn: false, size: 0 };
  }

  private rotate(): void {
    const f = this.file;
    try {
      unlinkSync(`${f}.${this.keep}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        renameSync(`${f}.${i}`, `${f}.${i + 1}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    renameSync(f, `${f}.1`);
  }
}

function readTail(file: string): 'missing' | { size: number; lastLine: string; torn: boolean } {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
  try {
    const size = statSync(file).size;
    if (size === 0) return { size: 0, lastLine: '', torn: false };
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const torn = !text.endsWith('\n');
    const lines = text.split('\n');
    if (!torn) lines.pop(); // the empty string after the final newline
    const lastLine = lines[lines.length - 1] ?? '';
    return { size, lastLine, torn };
  } finally {
    closeSync(fd);
  }
}

// ── reading ──────────────────────────────────────────────────────────────────

/** The live file plus its rotated siblings, oldest first. */
export function auditFiles(file: string): string[] {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const rotated: Array<{ n: number; f: string }> = [];
  try {
    for (const name of readdirSync(dir)) {
      const m = name.startsWith(`${base}.`) ? /^(\d+)$/.exec(name.slice(base.length + 1)) : null;
      if (m) rotated.push({ n: Number(m[1]), f: path.join(dir, name) });
    }
  } catch {
    /* no directory yet */
  }
  rotated.sort((a, b) => b.n - a.n);
  const out = rotated.map((r) => r.f);
  if (existsSync(file)) out.push(file);
  return out;
}

export interface AuditLine {
  file: string;
  line: number;
  text: string;
  rec?: AuditRecord;
}

/** Every retained line, oldest first. A line that is not JSON is returned with no `rec`. */
export function readAudit(file: string): AuditLine[] {
  const out: AuditLine[] = [];
  for (const f of auditFiles(file)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (!text) return;
      let rec: AuditRecord | undefined;
      try {
        rec = JSON.parse(text) as AuditRecord;
      } catch {
        /* torn line */
      }
      out.push({ file: f, line: i + 1, text, rec });
    });
  }
  return out;
}

export interface VerifyResult {
  ok: boolean;
  records: number;
  /** Where the chain first fails: the line whose `prev` does not match the line before it. */
  brokenAt?: { file: string; line: number; reason: string };
}

/** Check that every record's `prev` is the SHA-256 of the line before it, across rotated files. */
export function verifyAudit(file: string): VerifyResult {
  const lines = readAudit(file);
  let prevText: string | undefined;
  let records = 0;
  for (const l of lines) {
    if (!l.rec) return { ok: false, records, brokenAt: { file: l.file, line: l.line, reason: 'not valid JSON' } };
    // The oldest retained line has nothing before it to check against (older files may have been deleted).
    if (prevText !== undefined && l.rec.prev !== sha(prevText)) {
      return { ok: false, records, brokenAt: { file: l.file, line: l.line, reason: 'prev does not match the line before it' } };
    }
    prevText = l.text;
    records += 1;
  }
  return { ok: true, records };
}

/** `2026-10-01T00:00:00Z`, a date, or a relative `30m` / `12h` / `7d`. */
export function parseSince(raw: string, now: number = Date.now()): number {
  const rel = /^(\d+)([mhd])$/.exec(raw.trim());
  if (rel) return now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd'];
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new Error(`--since: '${raw}' is not a date or a relative time like 30m, 12h, 7d`);
  return t;
}

// ── Mattermost mirror ────────────────────────────────────────────────────────

const clean1 = (v: unknown) => String(v).replace(/\s+/g, '_').slice(0, 80);

/** One line, `key=value` pairs, no message text (the record has none to begin with). */
export function summarize(rec: AuditRecord): string {
  const parts = [`${rec.bot} ${rec.event}`];
  for (const [k, v] of Object.entries(rec)) {
    if (RESERVED.has(k) || v === null || v === undefined || v === '') continue;
    parts.push(`${k}=${Array.isArray(v) ? v.map(clean1).join(',') : clean1(v)}`);
  }
  return `\`${parts.join(' ')}\``;
}

/**
 * Posts one-line summaries to the bot's audit channel, one at a time, best effort. The file is the record; this is
 * an off-box copy that the agent's account cannot edit. If Mattermost is down the lines are lost from the channel
 * (and logged), never from the file.
 */
export class AuditMirror {
  private queue: string[] = [];
  private draining = false;
  private dropped = 0;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly post: (text: string) => Promise<unknown>,
    private readonly log: (msg: string) => void = (m) => console.error(`[audit-mirror] ${m}`),
  ) {}

  push(rec: AuditRecord): void {
    if (this.queue.length >= MIRROR_MAX_QUEUE) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(summarize(rec));
    if (!this.draining) {
      this.draining = true;
      this.idle = this.drain();
    }
  }

  /** Resolves once everything queued so far has been posted or given up on (tests, shutdown). */
  flushed(): Promise<void> {
    return this.idle;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const line = this.queue.shift() as string;
        try {
          await this.post(this.dropped > 0 ? `${line}\n(${this.dropped} earlier audit lines were not mirrored)` : line);
          this.dropped = 0;
        } catch (err) {
          this.log(`could not mirror an audit line: ${(err as Error).message}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
