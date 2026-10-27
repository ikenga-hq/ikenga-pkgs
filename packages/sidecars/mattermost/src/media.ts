import { createHash } from 'node:crypto';
import type { AuditLog } from './audit.js';
import { GcsError, GcsUploader, parseServiceAccount, publicUrl } from './gcs.js';
import type { GcsUploaderOptions, ServiceAccount } from './gcs.js';
import type { MattermostFileInfo, MattermostPost } from './types.js';

/**
 * Inbound images for the social queue (the `media` block).
 *
 * A user listed in `media.allowedUserIds` attaches PNG/JPEG files to a message. The bridge, which alone holds the Google
 * credential, downloads each one from Mattermost, checks it, uploads it to GCS and hands the Claude session ONLY the public
 * https URL, so the session can pass it on as `media_url`. The session, the user and the model never see the key.
 *
 * Everything here fails closed on the message, not on the bridge: a file that is refused or cannot be uploaded means the run
 * is NOT started, and the thread is told in one short plain sentence. Error text is a fixed phrase per reason class; the
 * key, the token, a GCS response body and a stack trace never reach a reply, a log line, the audit log or the prompt.
 */

/** Delimiters of the bridge-authored block appended to the prompt. A user's own text may not contain either. */
export const MEDIA_BLOCK_BEGIN = '[bridge: attachments uploaded]';
export const MEDIA_BLOCK_END = '[end bridge block]';

const MIB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 8 * MIB;
const HARD_MAX_BYTES = 20 * MIB;
const DEFAULT_MAX_FILES = 4;
const HARD_MAX_FILES = 10;
const DEFAULT_PREFIX = 'social/';
const MM_ID_RE = /^[a-z0-9]{26}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const PREFIX_RE = /^[A-Za-z0-9._\-/]+$/;
/** Longest file name (with its forced extension) that goes into an object name. */
const MAX_NAME = 64;

/** The `media` block as written in the bridge config. Env var NAMES only, never values. */
export interface MediaConfig {
  /** Default false. A block that is present but not enabled changes nothing. */
  enabled?: boolean;
  /** GCS bucket name. Required when enabled. The bucket is uniform-access public: no ACL is ever set. */
  bucket?: string;
  /** Object name prefix; ends with `/`. Default `social/`. */
  prefix?: string;
  /** Largest accepted file, bytes. Default 8 MiB, at most 20 MiB. */
  maxBytes?: number;
  /** Most files accepted in one message. Default 4, at most 10. */
  maxFiles?: number;
  /** Mattermost user ids who may send images. Required, non-empty, when enabled. The bot's gate still applies first. */
  allowedUserIds?: string[];
  /** NAMES of the environment variables that hold the credential. Required when enabled. */
  credentialEnv?: { serviceAccountJson?: string; projectId?: string };
}

export type ResolvedMedia =
  | { enabled: false }
  | {
      enabled: true;
      bucket: string;
      prefix: string;
      maxBytes: number;
      maxFiles: number;
      allowedUserIds: ReadonlySet<string>;
      credentialEnv: { serviceAccountJson: string; projectId: string };
    };

const MEDIA_KEYS = new Set(['enabled', 'bucket', 'prefix', 'maxBytes', 'maxFiles', 'allowedUserIds', 'credentialEnv']);
const CRED_KEYS = new Set(['serviceAccountJson', 'projectId']);

/**
 * Validate a bot's `media` block, strictly. Throws naming the bot; undefined means no block. Messages never repeat a value the
 * operator typed (a key pasted where an env var NAME belongs must not end up in a log), only the field and the rule.
 */
export function resolveMedia(cfg: unknown, where: string, ctx: { runsChi: boolean }): ResolvedMedia | undefined {
  if (cfg === undefined) return undefined;
  const w = `${where}: media`;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${w} must be an object`);
  const c = cfg as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!MEDIA_KEYS.has(k)) throw new Error(`${w}: unknown field '${k.slice(0, 40)}'; allowed: ${[...MEDIA_KEYS].join(', ')}`);
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') throw new Error(`${w}.enabled must be true or false`);
  const enabled = c.enabled === true;

  let bucket: string | undefined;
  if (c.bucket !== undefined) {
    if (typeof c.bucket !== 'string' || !BUCKET_RE.test(c.bucket) || c.bucket.includes('..')) {
      throw new Error(`${w}.bucket must be a GCS bucket name (3 to 63 characters: lowercase letters, digits, '-', '_', '.')`);
    }
    bucket = c.bucket;
  }

  let prefix = DEFAULT_PREFIX;
  if (c.prefix !== undefined) {
    const p = c.prefix;
    if (typeof p !== 'string' || !p.endsWith('/') || p.length > 128 || !PREFIX_RE.test(p) || p.startsWith('/') || p.includes('//') || p.split('/').some((s) => s === '.' || s === '..' || s.includes('..'))) {
      throw new Error(`${w}.prefix must end with '/', use only letters, digits, '.', '_', '-', '/', and contain no '..', '//' or leading '/'`);
    }
    prefix = p;
  }

  let maxBytes = DEFAULT_MAX_BYTES;
  if (c.maxBytes !== undefined) {
    if (typeof c.maxBytes !== 'number' || !Number.isInteger(c.maxBytes) || c.maxBytes < 1 || c.maxBytes > HARD_MAX_BYTES) {
      throw new Error(`${w}.maxBytes must be a whole number of bytes from 1 to ${HARD_MAX_BYTES} (20 MiB)`);
    }
    maxBytes = c.maxBytes;
  }

  let maxFiles = DEFAULT_MAX_FILES;
  if (c.maxFiles !== undefined) {
    if (typeof c.maxFiles !== 'number' || !Number.isInteger(c.maxFiles) || c.maxFiles < 1 || c.maxFiles > HARD_MAX_FILES) {
      throw new Error(`${w}.maxFiles must be a whole number from 1 to ${HARD_MAX_FILES}`);
    }
    maxFiles = c.maxFiles;
  }

  let allowed: string[] | undefined;
  if (c.allowedUserIds !== undefined) {
    if (!Array.isArray(c.allowedUserIds) || c.allowedUserIds.some((u) => typeof u !== 'string' || !MM_ID_RE.test(u))) {
      throw new Error(`${w}.allowedUserIds must be a list of Mattermost user ids (26 lowercase letters and digits; usernames are refused)`);
    }
    if (new Set(c.allowedUserIds).size !== c.allowedUserIds.length) throw new Error(`${w}.allowedUserIds lists the same id twice`);
    allowed = c.allowedUserIds as string[];
  }

  let credentialEnv: { serviceAccountJson?: string; projectId?: string } | undefined;
  if (c.credentialEnv !== undefined) {
    const ce = c.credentialEnv;
    if (!ce || typeof ce !== 'object' || Array.isArray(ce)) throw new Error(`${w}.credentialEnv must be an object`);
    credentialEnv = {};
    for (const [k, v] of Object.entries(ce as Record<string, unknown>)) {
      if (!CRED_KEYS.has(k)) throw new Error(`${w}.credentialEnv: unknown field '${k.slice(0, 40)}'; allowed: ${[...CRED_KEYS].join(', ')}`);
      if (typeof v !== 'string' || !ENV_NAME_RE.test(v)) {
        throw new Error(`${w}.credentialEnv.${k} must be the NAME of an environment variable (letters, digits, '_'), never the value`);
      }
      credentialEnv[k as 'serviceAccountJson' | 'projectId'] = v;
    }
  }

  if (!enabled) return { enabled: false };

  if (!ctx.runsChi) throw new Error(`${w}: needs daemon and chi (images are passed to a Chi run); this bot runs none`);
  if (!bucket) throw new Error(`${w}.bucket is required when media is enabled`);
  if (!allowed || allowed.length === 0) throw new Error(`${w}.allowedUserIds is required and must be non-empty when media is enabled (deny by default)`);
  if (!credentialEnv?.serviceAccountJson || !credentialEnv.projectId) {
    throw new Error(`${w}.credentialEnv needs both serviceAccountJson and projectId (names of environment variables)`);
  }
  if (credentialEnv.serviceAccountJson === credentialEnv.projectId) throw new Error(`${w}.credentialEnv: serviceAccountJson and projectId must name different variables`);
  return {
    enabled: true,
    bucket,
    prefix,
    maxBytes,
    maxFiles,
    allowedUserIds: new Set(allowed),
    credentialEnv: { serviceAccountJson: credentialEnv.serviceAccountJson, projectId: credentialEnv.projectId },
  };
}

// ── the credential ───────────────────────────────────────────────────────────

export type MediaCredential =
  | { ok: true; account: ServiceAccount; projectId: string }
  | { ok: false; code: 'env_missing' | 'not_json' | 'not_service_account' | 'bad_key' | 'project_missing'; envName: string; message: string };

/**
 * Read the credential from the environment by the NAMES in the config. Any problem is a disabled media block, described by the
 * variable's NAME and a fixed phrase: the value is never put in the message.
 */
export function loadMediaCredential(cfg: Extract<ResolvedMedia, { enabled: true }>, env: NodeJS.ProcessEnv): MediaCredential {
  const jsonName = cfg.credentialEnv.serviceAccountJson;
  const projName = cfg.credentialEnv.projectId;
  const raw = env[jsonName];
  if (raw === undefined || raw.trim() === '') return { ok: false, code: 'env_missing', envName: jsonName, message: `environment variable ${jsonName} is not set` };
  const parsed = parseServiceAccount(raw);
  if (!parsed.ok) {
    const what = {
      not_json: 'does not hold JSON (it must be the service-account key file on ONE line)',
      not_service_account: 'is not a service-account key (needs client_email and private_key)',
      bad_key: 'holds a private key that cannot be used for RS256 signing',
    }[parsed.reason];
    return { ok: false, code: parsed.reason, envName: jsonName, message: `environment variable ${jsonName} ${what}` };
  }
  const projectId = (env[projName] ?? '').trim();
  if (!projectId || projectId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(projectId)) {
    return { ok: false, code: 'project_missing', envName: projName, message: `environment variable ${projName} is not set to a project id` };
  }
  return { ok: true, account: parsed.account, projectId };
}

// ── names and bytes ──────────────────────────────────────────────────────────

/**
 * The file name that goes into the object name AND into the prompt. It is reduced to `[A-Za-z0-9._-]`: no path separator, no
 * traversal, no whitespace, no newline, no quote and no markup, so a crafted attachment name cannot add a line, a link or an
 * instruction to the bridge block. The extension is the one the SNIFFED type dictates, whatever the user's name said.
 */
export function safeObjectFileName(name: string | undefined, ext: 'png' | 'jpg'): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  let stem = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/_{2,}/g, '_')
    .replace(/^[.]+/, '')
    .replace(/[.]+$/, '');
  stem = stem.slice(0, MAX_NAME - ext.length - 1).replace(/[.]+$/, '');
  return `${stem || 'image'}.${ext}`;
}

/** A name for a REPLY about a file we may have refused: same alphabet and length, the user's extension left as it was. */
function displayName(name: string | undefined, index: number): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const s = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/_{2,}/g, '_').replace(/^[.]+/, '').slice(0, MAX_NAME);
  return s || `attachment ${index}`;
}

type Kind = { ext: 'png' | 'jpg'; mime: 'image/png' | 'image/jpeg' };
const PNG: Kind = { ext: 'png', mime: 'image/png' };
const JPEG: Kind = { ext: 'jpg', mime: 'image/jpeg' };

/** The type the first bytes say it is: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`. Nothing else is an image here. */
export function sniffImage(b: Uint8Array): Kind | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return PNG;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return JPEG;
  return undefined;
}

/** The type a file's METADATA claims, only if its declared mime and every extension it shows agree on PNG or on JPEG. */
function declaredKind(info: MattermostFileInfo): Kind | undefined {
  const mime = (info.mime_type ?? '').split(';')[0]?.trim().toLowerCase();
  const kind = mime === 'image/png' ? PNG : mime === 'image/jpeg' ? JPEG : undefined;
  if (!kind) return undefined;
  const exts: string[] = [];
  if (info.extension) exts.push(info.extension.replace(/^\./, '').toLowerCase());
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(info.name ?? '');
  if (m) exts.push((m[1] as string).toLowerCase());
  if (exts.length === 0) return undefined;
  const ok = kind === PNG ? ['png'] : ['jpg', 'jpeg'];
  return exts.every((e) => ok.includes(e)) ? kind : undefined;
}

// ── the ingest ───────────────────────────────────────────────────────────────

export type MediaReason = 'too_large' | 'not_image' | 'upload_failed' | 'unreadable' | 'not_attached' | 'too_many' | 'marker_in_text' | 'error';

/** What the router does with a post: nothing special, append this block to the prompt, or refuse (reply, start no run). */
export type MediaOutcome = { kind: 'none' } | { kind: 'ok'; block: string } | { kind: 'refused'; reply: string };

/** The one thing the router needs. `text` is the user's message text as the router will send it. Never throws. */
export interface MediaHook {
  process(post: MattermostPost, text: string): Promise<MediaOutcome>;
}

/** The slice of the Mattermost client the ingest reads files through. */
export interface MediaFileSource {
  getFileInfo(fileId: string): Promise<MattermostFileInfo>;
  fetchFile(fileId: string, signal?: AbortSignal): Promise<Response>;
}

export interface MediaIngestOptions {
  bot: string;
  config: Extract<ResolvedMedia, { enabled: true }>;
  files: MediaFileSource;
  account: ServiceAccount;
  audit: Pick<AuditLog, 'record'>;
  log?: (msg: string) => void;
  /** Test seams, constructor options only: stub GCS endpoints, a clock, request timeouts. */
  endpoints?: GcsUploaderOptions['endpoints'];
  now?: () => number;
  timeoutMs?: number;
}

/** A refusal of one file: the reason class, which the reply and the audit record both use. */
class FileRefusal extends Error {
  constructor(
    readonly reason: MediaReason,
    readonly status?: number,
  ) {
    super(reason);
  }
}

export class MediaIngest implements MediaHook {
  private readonly cfg: Extract<ResolvedMedia, { enabled: true }>;
  private readonly uploader: GcsUploader;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: MediaIngestOptions) {
    this.cfg = opts.config;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.uploader = new GcsUploader({ account: opts.account, endpoints: opts.endpoints, timeoutMs: this.timeoutMs, now: this.now });
    this.log = opts.log ?? ((m) => console.log(`[mattermost:${opts.bot}] media: ${m}`));
  }

  async process(post: MattermostPost, text: string): Promise<MediaOutcome> {
    const ids = [...new Set(post.file_ids ?? [])];
    if (ids.length === 0) return { kind: 'none' };
    // Anyone else's attachments are exactly what they were before this block existed: not read, not uploaded, not mentioned.
    if (!this.cfg.allowedUserIds.has(post.user_id)) return { kind: 'none' };
    const base = { thread_root: post.root_id || post.id, channel_id: post.channel_id, user_id: post.user_id };

    // The block below is the bridge's. Text that spells its delimiters could pose as one (an attachment that was never uploaded).
    if (text.includes(MEDIA_BLOCK_BEGIN) || text.includes(MEDIA_BLOCK_END)) {
      this.opts.audit.record('media.file', { ...base, outcome: 'refused', reason: 'marker_in_text' });
      return { kind: 'refused', reply: `I did not start anything: your message contains the text \`${MEDIA_BLOCK_BEGIN}\` or \`${MEDIA_BLOCK_END}\`, which I use to list uploaded images. Please remove it and send again.` };
    }

    if (ids.length > this.cfg.maxFiles) {
      // Refused whole, before anything is downloaded or published: a message that will not run must not leave images behind.
      for (const id of ids.slice(this.cfg.maxFiles)) this.opts.audit.record('media.file', { ...base, file_id: id, outcome: 'refused', reason: 'too_many' });
      return { kind: 'refused', reply: `I did not start anything: ${ids.length} files were attached and the limit is ${this.cfg.maxFiles} per message. Nothing was uploaded. Please send at most ${this.cfg.maxFiles}.` };
    }

    const lines: string[] = [];
    for (const [i, id] of ids.entries()) {
      const seen: { name?: string; sha256?: string; bytes?: number; object?: string } = {};
      try {
        const done = await this.one(post, id, i + 1, seen);
        lines.push(`${i + 1}. ${done.name} -> ${done.url}`);
        this.opts.audit.record('media.file', { ...base, file_id: id, sha256: done.sha256, bytes: done.bytes, object: done.object, outcome: done.created ? 'uploaded' : 'already_present' });
        this.log(`${done.created ? 'uploaded' : 'already present'}: file ${id} (${done.bytes} bytes) as ${done.object}`);
      } catch (err) {
        const refusal = err instanceof FileRefusal ? err : new FileRefusal('error');
        this.opts.audit.record('media.file', {
          ...base,
          file_id: id,
          sha256: seen.sha256,
          bytes: seen.bytes,
          object: seen.object,
          outcome: 'refused',
          reason: refusal.reason,
          http_status: refusal.status,
        });
        this.log(`refused file ${id}: ${refusal.reason}${refusal.status !== undefined ? ` (HTTP ${refusal.status})` : ''}`);
        return { kind: 'refused', reply: this.refusalReply(seen.name ?? `attachment ${i + 1}`, refusal.reason) };
      }
    }
    return { kind: 'ok', block: `${MEDIA_BLOCK_BEGIN}\n${lines.join('\n')}\n${MEDIA_BLOCK_END}` };
  }

  private refusalReply(name: string, reason: MediaReason): string {
    const why: Record<MediaReason, string> = {
      too_large: `is too large (the limit is ${(this.cfg.maxBytes / MIB).toFixed(this.cfg.maxBytes % MIB ? 2 : 0)} MB)`,
      not_image: 'is not a PNG or JPEG image (only those are accepted)',
      upload_failed: 'could not be uploaded (upload failed)',
      unreadable: 'could not be read from Mattermost',
      not_attached: 'does not belong to this message',
      too_many: 'is over the limit on files per message',
      marker_in_text: 'was not processed',
      error: 'could not be processed',
    };
    // `name` is already reduced to [A-Za-z0-9._-] (or "attachment N"), so it cannot carry markup into the reply.
    return `I did not start anything: \`${name}\` ${why[reason]}. Nothing was sent to Claude.`;
  }

  /** Fetch, check and upload one file. Throws `FileRefusal`. `seen` collects what the audit record may say about it. */
  private async one(
    post: MattermostPost,
    fileId: string,
    index: number,
    seen: { name?: string; sha256?: string; bytes?: number; object?: string },
  ): Promise<{ name: string; url: string; sha256: string; bytes: number; object: string; created: boolean }> {
    const { files } = this.opts;
    if (!/^[a-z0-9]{26}$/.test(fileId)) throw new FileRefusal('unreadable');
    let info: MattermostFileInfo;
    try {
      info = await files.getFileInfo(fileId);
    } catch {
      throw new FileRefusal('unreadable');
    }
    seen.name = displayName(info.name, index);

    // The file must be the one this post carries, in this post's channel: an id for someone else's file is not ours to publish.
    if (info.id !== undefined && info.id !== fileId) throw new FileRefusal('not_attached');
    if (info.post_id !== post.id) throw new FileRefusal('not_attached');
    if (info.channel_id !== undefined && info.channel_id !== post.channel_id) throw new FileRefusal('not_attached');

    if (typeof info.size === 'number' && info.size > this.cfg.maxBytes) throw new FileRefusal('too_large');
    const declared = declaredKind(info);
    if (!declared) throw new FileRefusal('not_image');

    const bytes = await this.download(fileId);
    seen.bytes = bytes.length;
    // The hash comes first so that even a refused file is identified in the audit record by its bytes.
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    seen.sha256 = sha256;
    const sniffed = sniffImage(bytes);
    if (!sniffed || sniffed !== declared) throw new FileRefusal('not_image');

    const day = new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, '');
    const name = safeObjectFileName(info.name, sniffed.ext);
    const object = `${this.cfg.prefix}${day}-${sha256.slice(0, 16)}/${name}`;
    seen.object = object;
    let created: boolean;
    try {
      created = (await this.uploader.upload(this.cfg.bucket, object, bytes, sniffed.mime)) === 'created';
    } catch (err) {
      throw new FileRefusal('upload_failed', err instanceof GcsError ? err.status : undefined);
    }
    return { name, url: publicUrl(this.cfg.bucket, object), sha256, bytes: bytes.length, object, created };
  }

  /** The file's bytes, never more than `maxBytes` held: the stream is cancelled the moment it passes the limit. */
  private async download(fileId: string): Promise<Buffer> {
    const max = this.cfg.maxBytes;
    let res: Response;
    try {
      res = await this.opts.files.fetchFile(fileId, AbortSignal.timeout(this.timeoutMs));
    } catch {
      throw new FileRefusal('unreadable');
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new FileRefusal('unreadable');
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await res.body.cancel().catch(() => undefined);
      throw new FileRefusal('too_large');
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) {
          await reader.cancel().catch(() => undefined);
          throw new FileRefusal('too_large');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof FileRefusal) throw err;
      throw new FileRefusal('unreadable');
    }
    return Buffer.concat(chunks, total);
  }
}
