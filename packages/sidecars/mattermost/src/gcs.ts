import { createPrivateKey, createSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Google Cloud Storage for the media block: a service-account OAuth token (RS256 JWT, built here with `node:crypto`, no
 * dependency) and a single-shot "create this object, never overwrite" upload through the JSON API.
 *
 * The key lives in this process only. Nothing in this file puts the key, the signed assertion, the token or a response
 * body into an error message or a log line: a failure is a status code and a fixed phrase (`GcsError`).
 */

/** Fixed endpoints. Only a constructor option (tests) can change them; there is no env var or config key for it. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GCS_API_BASE = 'https://storage.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
/** A token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ServiceAccount {
  clientEmail: string;
  privateKey: KeyObject;
  /** The key text itself, kept only so the bridge can add it to its redactor. Never logged. */
  privateKeyPem: string;
  /** `project_id` of the JSON, when it has one. */
  projectId?: string;
}

export type ServiceAccountParse = { ok: true; account: ServiceAccount } | { ok: false; reason: 'not_json' | 'not_service_account' | 'bad_key' };

/**
 * Parse the one-line service-account JSON. Needs `client_email` and a usable RSA `private_key`; `type`, when present, must be
 * `service_account`. A value that came through an env file with its `\n` escapes turned into real newlines is repaired once
 * (a raw newline is not legal inside a JSON string).
 */
export function parseServiceAccount(raw: string): ServiceAccountParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    try {
      json = JSON.parse(raw.replace(/\r?\n/g, '\\n'));
    } catch {
      return { ok: false, reason: 'not_json' };
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'not_service_account' };
  const o = json as Record<string, unknown>;
  if (o.type !== undefined && o.type !== 'service_account') return { ok: false, reason: 'not_service_account' };
  if (typeof o.client_email !== 'string' || !o.client_email.trim() || typeof o.private_key !== 'string' || !o.private_key.trim()) {
    return { ok: false, reason: 'not_service_account' };
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(o.private_key);
  } catch {
    return { ok: false, reason: 'bad_key' }; // fixed phrase: the library's message is not passed on
  }
  if (key.asymmetricKeyType !== 'rsa') return { ok: false, reason: 'bad_key' };
  return {
    ok: true,
    account: {
      clientEmail: o.client_email.trim(),
      privateKey: key,
      privateKeyPem: o.private_key,
      ...(typeof o.project_id === 'string' && o.project_id ? { projectId: o.project_id } : {}),
    },
  };
}

/** A GCS or token-endpoint failure: the HTTP status (0 for a network error or timeout) and a fixed phrase. Nothing else. */
export class GcsError extends Error {
  constructor(
    readonly stage: 'token' | 'upload',
    readonly status: number,
  ) {
    super(`${stage === 'token' ? 'GCS token request' : 'GCS upload'} failed: ${status ? `HTTP ${status}` : 'no response'}`);
    this.name = 'GcsError';
  }
}

export interface GcsUploaderOptions {
  account: ServiceAccount;
  /** Test seam only (a constructor option, never config or env). Defaults are the real Google endpoints. */
  endpoints?: { tokenUrl?: string; apiBase?: string };
  timeoutMs?: number;
  now?: () => number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class GcsUploader {
  private readonly account: ServiceAccount;
  private readonly tokenUrl: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached?: { token: string; expiresAt: number };
  /** The token request in flight, shared by every upload that needs a token meanwhile (one request, not one per caller). */
  private pending?: Promise<string>;

  constructor(opts: GcsUploaderOptions) {
    this.account = opts.account;
    this.tokenUrl = opts.endpoints?.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.apiBase = (opts.endpoints?.apiBase ?? GCS_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Create `object` in `bucket` unless it already exists (`ifGenerationMatch=0`). `'exists'` is HTTP 412: the object name carries the
   * content hash, so what is there is these bytes; nothing is written after it. Anything else that is not a success throws `GcsError`.
   * One retry with a fresh token on a 401 (a token revoked or expired early).
   */
  async upload(bucket: string, object: string, bytes: Uint8Array, contentType: string): Promise<'created' | 'exists'> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      const url = `${this.apiBase}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(object)}`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
          body: new Uint8Array(bytes),
          redirect: 'error', // never carry the token somewhere else
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new GcsError('upload', 0);
      }
      await res.body?.cancel().catch(() => undefined); // the response body is never read or kept
      if (res.ok) return 'created';
      if (res.status === 412) return 'exists';
      if (res.status === 401 && attempt === 0) {
        if (this.cached?.token === token) this.cached = undefined;
        continue;
      }
      throw new GcsError('upload', res.status);
    }
  }

  /** The cached token, or a new one. Concurrent callers share one request. */
  private token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - TOKEN_MARGIN_MS) return Promise.resolve(this.cached.token);
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.account.clientEmail, scope: SCOPE, aud: this.tokenUrl, iat, exp: iat + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(this.account.privateKey);
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(signature)}` });
    let res: Response;
    try {
      res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GcsError('token', 0);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new GcsError('token', res.status);
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      throw new GcsError('token', res.status);
    }
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new GcsError('token', res.status);
    const lifetimeS = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600;
    this.cached = { token: parsed.access_token, expiresAt: this.now() + lifetimeS * 1000 };
    return parsed.access_token;
  }
}

/** `https://storage.googleapis.com/<bucket>/<object>` with the object path percent-encoded one segment at a time. */
export function publicUrl(bucket: string, object: string): string {
  return `${GCS_API_BASE}/${encodeURIComponent(bucket)}/${object.split('/').map(encodeURIComponent).join('/')}`;
}
