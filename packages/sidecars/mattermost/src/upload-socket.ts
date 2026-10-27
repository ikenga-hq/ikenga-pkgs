import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsc, lstatSync, unlinkSync } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { AuditLog } from './audit.js';
import { GcsError, GcsUploader, publicUrl } from './gcs.js';
import type { GcsUploaderOptions, ServiceAccount } from './gcs.js';
import { mediaObjectName, safeObjectFileName, sniffImage } from './media.js';
import type { ResolvedUploadSocket } from './media.js';

/**
 * The upload socket (`media.uploadSocket`): a local renderer that has just written a PNG asks the bridge to publish it.
 *
 * The bridge alone holds the Google credential. A caller on this socket can only NAME a file; the bridge decides whether that file
 * is one it may publish (a regular PNG that really lives in the render output directory), hashes it, uploads it with the same naming
 * and the same never-overwrite rule as the inbound-image path (`media.ts`), and answers with the public https URL. Nothing about
 * Google (a token, a response body, a status text) and nothing about the host (a path, a stack) ever goes back to the caller.
 *
 * Wire format: one connection per request. The client sends ONE JSON line `{"path":"<absolute path>"}`; the bridge replies ONE JSON
 * line, `{"ok":true,"url":...,"object":...,"sha256":...}` or `{"ok":false,"code":...,"message":...}`, and closes. The message is a
 * fixed phrase per code.
 */

export type UploadCode = 'bad_request' | 'not_found' | 'outside_source_dir' | 'not_regular' | 'too_large' | 'not_png' | 'rate_limited' | 'upload_failed' | 'media_off';

const PHRASES: Record<UploadCode, string> = {
  bad_request: 'request must be one JSON line with a path',
  not_found: 'file not found',
  outside_source_dir: 'file is outside the render output directory',
  not_regular: 'not an acceptable regular file',
  too_large: 'file is too large',
  not_png: 'file is not a PNG',
  rate_limited: 'too many requests, try again shortly',
  upload_failed: 'upload failed',
  media_off: 'uploads are off',
};
/** The other fixed phrases a `bad_request` can carry. */
const BAD_PHRASES = { line: PHRASES.bad_request, size: 'request line too long', time: 'request not received in time' } as const;

/** The request line (with its newline) may not be longer than this. */
const MAX_REQUEST_BYTES = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** Connections held at once (reading, waiting for a slot, or uploading). A further one is answered `rate_limited` at once. */
const MAX_CONNECTIONS = 8;
/** Uploads to Google in flight at once; the rest of the admitted requests wait for a slot. */
const MAX_IN_FLIGHT = 2;
/** After the reply a connection that the peer keeps open is dropped after this long. */
const LINGER_MS = 1_000;
/** A flood of refused requests writes at most one audit record per this long (with the count left out). */
const FLOOD_AUDIT_MS = 60_000;

/** A request that is refused: the code the caller sees, which fixed phrase goes with it, and the HTTP status of a failed upload. */
class Refusal extends Error {
  constructor(
    readonly code: UploadCode,
    readonly phrase: string = PHRASES[code],
    readonly status?: number,
  ) {
    super(code);
  }
}

type Reply = { ok: true; url: string; object: string; sha256: string } | { ok: false; code: UploadCode; message: string };

/** What the audit record may say about a request. The file is a basename in a reduced alphabet, never a path. */
interface Seen {
  file?: string;
  bytes?: number;
  sha256?: string;
  object?: string;
}

/** `n` requests per minute, refilling continuously. Starts full. */
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (Math.max(0, t - this.last) * this.capacity) / 60_000);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** At most `max` holders at once; the others wait in order. */
class Slots {
  private busy = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.busy >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.busy += 1;
    // A released slot is handed straight to the next waiter (busy stays as it is) or given back.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.busy -= 1;
    };
  }
}

export interface UploadSocketOptions {
  bot: string;
  bucket: string;
  prefix: string;
  config: ResolvedUploadSocket;
  account: ServiceAccount;
  audit: Pick<AuditLog, 'record' | 'recordCoalesced'>;
  log?: (msg: string) => void;
  /** Test seams, constructor options only: stub GCS endpoints, a clock, timeouts, the group lookup. */
  endpoints?: GcsUploaderOptions['endpoints'];
  now?: () => number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  resolveGroup?: (group: string | number) => Promise<number | undefined>;
}

export type UploadSocketStart = { ok: true } | { ok: false; message: string };

export class UploadSocket {
  private readonly cfg: ResolvedUploadSocket;
  private readonly uploader: GcsUploader;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly log: (msg: string) => void;
  private readonly limiter: TokenBucket;
  private readonly slots = new Slots(MAX_IN_FLIGHT);
  private readonly conns = new Set<net.Socket>();
  private server?: net.Server;
  private closing = false;
  private closed?: Promise<void>;

  constructor(private readonly opts: UploadSocketOptions) {
    this.cfg = opts.config;
    this.now = opts.now ?? Date.now;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.uploader = new GcsUploader({ account: opts.account, endpoints: opts.endpoints, timeoutMs: opts.timeoutMs ?? 60_000, now: this.now });
    this.limiter = new TokenBucket(this.cfg.ratePerMinute, this.now);
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}] upload socket: ${m}`));
  }

  /** The socket path (from the config). */
  get socketPath(): string {
    return this.cfg.path;
  }

  /**
   * Create the socket, mode 0660, group `config.group`, and start answering. Never throws: a problem is `{ok:false}` with a message
   * that names the field or errno code, and nothing is left listening or on disk. A stale socket node is removed only when a
   * connect to it is refused (nobody listens); anything else at the path is left alone and the start fails.
   */
  async start(): Promise<UploadSocketStart> {
    if (this.server || this.closing) return { ok: false, message: 'already started or stopped' };
    const sock = this.cfg.path;
    const fail = (message: string): UploadSocketStart => ({ ok: false, message });
    let server: net.Server | undefined;
    let created = false;
    const undo = async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      if (created) this.unlinkSocket();
      this.server = undefined;
    };
    try {
      const gid = await (this.opts.resolveGroup ?? resolveGid)(this.cfg.group);
      if (gid === undefined) return fail(`group '${typeof this.cfg.group === 'number' ? this.cfg.group : this.cfg.group.slice(0, 40)}' does not exist`);

      const prep = await clearStaleSocket(sock);
      if (prep) return fail(prep);
      if (this.closing) return fail('stopped while starting');

      server = net.createServer({ allowHalfOpen: true }, (s) => this.onConnection(s));
      this.server = server;
      // bind() is synchronous, so a restrictive umask held across `listen` and restored at once cannot touch any other file. The
      // node is born 0600: only after it is in the right group does it open to the group (0660), never wider than that.
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        const old = process.umask(0o177);
        try {
          server!.listen(sock, () => resolve());
        } catch (err) {
          reject(err);
        } finally {
          process.umask(old);
        }
      });
      created = true;
      await fsp.chown(sock, process.getuid?.() ?? -1, gid);
      await fsp.chmod(sock, 0o660);
      const after = await fsp.lstat(sock);
      if (!after.isSocket() || (after.mode & 0o777) !== 0o660 || after.gid !== gid) throw new Error('mode');
      if (this.closing) {
        await undo();
        return fail('stopped while starting');
      }
      server.on('error', (err) => this.log(`server error: ${(err as NodeJS.ErrnoException).code ?? 'error'}`));
      this.log(`listening on ${sock} (mode 660, gid ${gid}); files from ${this.cfg.sourceDir}; max ${this.cfg.maxBytes} bytes, ${this.cfg.ratePerMinute}/min`);
      return { ok: true };
    } catch (err) {
      await undo().catch(() => undefined);
      const code = (err as NodeJS.ErrnoException).code;
      const why = code ?? ((err as Error).message === 'mode' ? 'permissions not as required' : 'error');
      return fail(`could not create ${sock}: ${why}`);
    }
  }

  /** Stop listening, drop every connection, unlink the socket node. The synchronous part runs before this returns. */
  stop(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    const server = this.server;
    for (const s of this.conns) s.destroy();
    this.conns.clear();
    this.unlinkSocket();
    this.closed = new Promise<void>((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
    return this.closed;
  }

  /** Remove the socket node, if it is still one (a file someone put there since is not ours to delete). */
  private unlinkSocket(): void {
    try {
      if (lstatSync(this.cfg.path).isSocket()) unlinkSync(this.cfg.path);
    } catch {
      // already gone
    }
  }

  // ── one connection ─────────────────────────────────────────────────────────

  private onConnection(sock: net.Socket): void {
    sock.on('error', () => undefined); // a reset peer is not our problem, and an unhandled 'error' would be
    if (this.closing) return this.answerAndClose(sock, new Refusal('media_off'));
    if (this.conns.size >= MAX_CONNECTIONS) {
      this.opts.audit.recordCoalesced('upload-conn-cap', 'media.upload', { outcome: 'refused', reason: 'rate_limited', detail: 'connection_cap' }, FLOOD_AUDIT_MS);
      return this.answerAndClose(sock, new Refusal('rate_limited'));
    }
    this.conns.add(sock);
    let head = Buffer.alloc(0);
    let started = false;
    const timer = setTimeout(() => run(new Refusal('bad_request', BAD_PHRASES.time)), this.requestTimeoutMs);
    timer.unref?.();
    sock.once('close', () => {
      clearTimeout(timer);
      this.conns.delete(sock);
    });
    /** Take the request exactly once; later bytes are read and thrown away so the peer is not reset before it has our reply. */
    const run = (input: string | Refusal) => {
      if (started) return;
      started = true;
      clearTimeout(timer);
      this.serve(input).then(
        (reply) => this.send(sock, reply),
        () => this.send(sock, { ok: false, code: 'upload_failed', message: PHRASES.upload_failed }),
      );
    };
    sock.on('data', (chunk: Buffer) => {
      if (started) return;
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(0x0a);
      if (nl >= 0 && nl < MAX_REQUEST_BYTES) return run(head.subarray(0, nl).toString('utf8'));
      if (head.length >= MAX_REQUEST_BYTES) run(new Refusal('bad_request', BAD_PHRASES.size));
    });
    sock.on('end', () => {
      if (!started) run(head.length > 0 ? head.toString('utf8') : new Refusal('bad_request'));
    });
  }

  /** A refusal that needs no work: reply and close. */
  private answerAndClose(sock: net.Socket, r: Refusal): void {
    this.send(sock, { ok: false, code: r.code, message: r.phrase });
  }

  private send(sock: net.Socket, reply: Reply): void {
    if (sock.destroyed || !sock.writable) return;
    sock.end(`${JSON.stringify(reply)}\n`);
    sock.resume(); // anything else the peer sends is discarded
    const linger = setTimeout(() => sock.destroy(), LINGER_MS);
    linger.unref?.();
    sock.once('close', () => clearTimeout(linger));
  }

  // ── one request ────────────────────────────────────────────────────────────

  /** Parse, admit, publish, audit. Never throws: any failure is a reply with a fixed code. */
  private async serve(input: string | Refusal): Promise<Reply> {
    const seen: Seen = {};
    try {
      if (input instanceof Refusal) throw input;
      const reqPath = parseRequest(input);
      seen.file = displayBase(reqPath);
      if (this.closing) throw new Refusal('media_off');
      // The bucket is taken once the request is well-formed, so garbage costs a read and nothing else.
      if (!this.limiter.take()) throw new Refusal('rate_limited');
      const release = await this.slots.acquire();
      let done: { url: string; sha256: string; bytes: number; object: string; created: boolean };
      try {
        done = await this.publish(reqPath, seen);
      } finally {
        release();
      }
      this.opts.audit.record('media.upload', { outcome: done.created ? 'uploaded' : 'already_present', file: seen.file, sha256: done.sha256, bytes: done.bytes, object: done.object });
      this.log(`${done.created ? 'uploaded' : 'already present'}: ${seen.file} (${done.bytes} bytes) as ${done.object}`);
      return { ok: true, url: done.url, object: done.object, sha256: done.sha256 };
    } catch (err) {
      const refusal = err instanceof Refusal ? err : new Refusal('upload_failed'); // a crashed handler is a failed upload, never a crashed bridge
      const fields = { outcome: 'refused', reason: refusal.code, file: seen.file, sha256: seen.sha256, bytes: seen.bytes, object: seen.object, http_status: refusal.status, ...(err instanceof Refusal ? {} : { detail: 'handler_error' }) };
      if (refusal.code === 'rate_limited') this.opts.audit.recordCoalesced('upload-rate', 'media.upload', fields, FLOOD_AUDIT_MS);
      else this.opts.audit.record('media.upload', fields);
      this.log(`refused ${seen.file ?? 'request'}: ${refusal.code}${refusal.status !== undefined ? ` (HTTP ${refusal.status})` : ''}`);
      return { ok: false, code: refusal.code, message: refusal.phrase };
    }
  }

  /**
   * The file checks, in the order that keeps the work cheap and the hazards out: where it REALLY is (symlinks resolved), what it is
   * (lstat, then an `O_NOFOLLOW` open and an fstat of the open descriptor, which must agree), how big, whether it is a PNG; the bytes
   * are read through that descriptor and the path is never used again.
   */
  private async publish(reqPath: string, seen: Seen): Promise<{ url: string; sha256: string; bytes: number; object: string; created: boolean }> {
    let real: string;
    try {
      real = await fsp.realpath(reqPath);
    } catch {
      throw new Refusal('not_found');
    }
    let realSrc: string;
    try {
      realSrc = await fsp.realpath(this.cfg.sourceDir);
    } catch {
      throw new Refusal('outside_source_dir');
    }
    if (!isInside(real, realSrc)) throw new Refusal('outside_source_dir');

    let lst;
    try {
      lst = await fsp.lstat(real);
    } catch {
      throw new Refusal('not_found');
    }
    // A FIFO, device, socket or directory is refused here, before any open could block on it or touch it.
    if (!lst.isFile()) throw new Refusal('not_regular');

    let fh: FileHandle;
    try {
      fh = await fsp.open(real, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    } catch (err) {
      throw new Refusal((err as NodeJS.ErrnoException).code === 'ELOOP' ? 'not_regular' : 'not_found');
    }
    try {
      const st = await fh.stat();
      // nlink 1: a second name for the same inode (a hard link made from somewhere else) is not a render output. Same inode as the lstat:
      // the file was not swapped between the two.
      if (!st.isFile() || st.nlink !== 1 || st.dev !== lst.dev || st.ino !== lst.ino) throw new Refusal('not_regular');
      // Where the descriptor really points, when the OS can say (Linux): the last word on a path that changed under us.
      let where: string | undefined;
      try {
        where = await fsp.readlink(`/proc/self/fd/${fh.fd}`);
      } catch {
        where = undefined;
      }
      if (where !== undefined && !isInside(where, realSrc)) throw new Refusal('outside_source_dir');
      if (st.size > this.cfg.maxBytes) throw new Refusal('too_large');
      if (st.size === 0) throw new Refusal('not_png');

      // One byte more than fstat said: a file still growing is caught, and never more than `maxBytes + 1` is held.
      const buf = Buffer.allocUnsafe(st.size + 1);
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      if (off !== st.size) throw new Refusal('not_regular');
      const bytes = buf.subarray(0, off);
      seen.bytes = bytes.length;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      seen.sha256 = sha256;
      // PNG only: a JPEG (or anything else, whatever the extension says) is not what the renderer writes.
      if (sniffImage(bytes)?.ext !== 'png') throw new Refusal('not_png');

      const object = mediaObjectName(this.opts.prefix, this.now(), sha256, safeObjectFileName(outputStem(path.basename(real)), 'png'));
      seen.object = object;
      let created: boolean;
      try {
        created = (await this.uploader.upload(this.opts.bucket, object, bytes, 'image/png')) === 'created';
      } catch (err) {
        throw new Refusal('upload_failed', PHRASES.upload_failed, err instanceof GcsError ? err.status : undefined);
      }
      return { url: publicUrl(this.opts.bucket, object), sha256, bytes: bytes.length, object, created };
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** The one thing a request must be: a JSON object with a non-empty absolute `path` string. Other keys are ignored. */
function parseRequest(line: string): string {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new Refusal('bad_request');
  }
  const p = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>).path : undefined;
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024 || p.includes('\0') || !p.startsWith('/')) throw new Refusal('bad_request');
  return p;
}

/** True when `p` is a file strictly below directory `dir` (both already resolved). */
function isInside(p: string, dir: string): boolean {
  return p.length > dir.length + 1 && p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/** A name for the audit record: the last path segment in the safe alphabet, at most 64 characters. Never the directories. */
function displayBase(p: string): string {
  const base = p.split('/').pop() ?? '';
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').slice(0, 64) || '(none)';
}

/** The render service names outputs `<YYYYMMDD>-<sha16>-<name>.png`; the leading date and hash are dropped, the object gets its own. */
function outputStem(base: string): string {
  return base.replace(/^\d{8}-[0-9a-f]{16}-/, '');
}

/**
 * Make the socket path free to bind. Nothing there is fine. A socket node nobody listens on (a connect is refused) is a leftover of a
 * crashed bridge and is removed. A live listener, a connect that fails any other way, or anything that is not a socket node (a file,
 * a directory, a symlink) is left exactly as it is. Returns a message when the path cannot be used, undefined when it is free.
 */
async function clearStaleSocket(p: string): Promise<string | undefined> {
  let st;
  try {
    st = await fsp.lstat(p);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : `cannot inspect the socket path (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  if (!st.isSocket()) return 'the socket path exists and is not a socket; left alone';
  const verdict = await new Promise<'refused' | 'live' | 'unknown'>((resolve) => {
    const c = net.createConnection(p);
    const t = setTimeout(() => {
      c.destroy();
      resolve('unknown');
    }, 2_000);
    c.once('connect', () => {
      clearTimeout(t);
      c.destroy();
      resolve('live');
    });
    c.once('error', (err) => {
      clearTimeout(t);
      resolve((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'unknown');
    });
  });
  if (verdict === 'live') return 'the socket path is in use by a running listener';
  if (verdict === 'unknown') return 'the socket path holds a socket that could not be proven stale; left alone';
  try {
    await fsp.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return `cannot remove the stale socket (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  return undefined;
}

/** Group name or gid to gid: `/etc/group` first, then `getent` (for a directory service). A name that matches neither is undefined. */
export async function resolveGid(group: string | number): Promise<number | undefined> {
  if (typeof group === 'number') return group;
  try {
    for (const line of (await fsp.readFile('/etc/group', 'utf8')).split('\n')) {
      const [name, , gid] = line.split(':');
      if (name === group && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
    }
  } catch {
    // fall through to getent
  }
  return new Promise((resolve) => {
    // `group` was validated at config load (letters, digits, `_-.`, starting with a letter or `_`) and goes in as one argv entry.
    execFile('/usr/bin/getent', ['group', group], { timeout: 3_000 }, (err, stdout) => {
      const gid = err ? undefined : stdout.split(':')[2];
      resolve(gid !== undefined && /^\d+$/.test(gid) ? Number(gid) : undefined);
    });
  });
}
