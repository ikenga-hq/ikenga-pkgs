import http from 'node:http';
import { createHash, createPublicKey, createVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * A fake Google: the OAuth token endpoint (`POST /token`) and the GCS JSON upload endpoint
 * (`POST /upload/storage/v1/b/{bucket}/o?uploadType=media&name=...&ifGenerationMatch=0`), on 127.0.0.1. The bridge reaches it only through
 * the test option that replaces the endpoints; nothing in production can point at it.
 */
export interface StoredObject {
  bucket: string;
  name: string;
  contentType: string;
  sha256: string;
  bytes: number;
}

export interface UploadCall {
  bucket: string;
  name: string;
  query: Record<string, string>;
  authorization?: string;
  contentType?: string;
}

export class MockGcs {
  private server: http.Server;
  private port = 0;
  /** Objects by `bucket/name`. Pre-seed one (`seed`) to see a 412. */
  readonly objects = new Map<string, StoredObject>();
  readonly uploads: UploadCall[] = [];
  /** Every `Authorization` header the upload endpoint saw, and how many token requests were made. */
  tokenRequests = 0;
  /** Tokens issued so far, newest last. */
  readonly tokens: string[] = [];
  /** Lifetime of the next tokens, seconds. */
  expiresIn = 3600;
  /** When set, the upload endpoint answers this status for every request (403, 500, ...) with a body that holds a secret-looking marker. */
  uploadStatus?: number;
  /** Hold every upload this long (ms) before answering, and count how many are being held at once (`maxInFlight`). */
  uploadDelayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  /** When set, the token endpoint answers this status. */
  tokenStatus?: number;
  /** Tokens the upload endpoint rejects with a 401 (a revoked token). */
  readonly revoked = new Set<string>();
  /** Verify the JWT signature on every token request against this public key, and record what was wrong. */
  verifyWith?: KeyObject;
  readonly jwtProblems: string[] = [];
  /** Claims of the last assertion that verified. */
  lastClaims?: Record<string, unknown>;
  /** Hold token responses until `releaseTokens()` (to prove concurrent callers share one request). */
  holdTokens = false;
  private held: Array<() => void> = [];
  private nextToken = 1;

  constructor(private readonly tokenPrefix = 'ya29.SENTINEL-TOKEN-') {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.method === 'POST' && url.pathname === '/token') return this.token(res, body);
        const m = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
        if (req.method === 'POST' && m) return this.upload(req, res, decodeURIComponent(m[1] as string), url, body);
        res.writeHead(404);
        res.end('Not Found');
      });
    });
  }

  private token(res: http.ServerResponse, body: Buffer): void {
    this.tokenRequests += 1;
    const respond = () => {
      if (this.tokenStatus) {
        res.writeHead(this.tokenStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'mock refusal SECRET-DETAIL' }));
        return;
      }
      const token = `${this.tokenPrefix}${this.nextToken++}`;
      this.tokens.push(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, expires_in: this.expiresIn, token_type: 'Bearer' }));
    };
    const form = new URLSearchParams(body.toString('utf8'));
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') this.jwtProblems.push('grant_type');
    const assertion = form.get('assertion') ?? '';
    const [h, c, sig] = assertion.split('.');
    if (!h || !c || !sig) {
      this.jwtProblems.push('assertion shape');
    } else {
      try {
        const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>;
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>;
        if (header.alg !== 'RS256') this.jwtProblems.push('alg');
        if (this.verifyWith && !createVerify('RSA-SHA256').update(`${h}.${c}`).verify(this.verifyWith, Buffer.from(sig, 'base64url'))) this.jwtProblems.push('signature');
        this.lastClaims = claims;
      } catch {
        this.jwtProblems.push('assertion parse');
      }
    }
    if (this.holdTokens) this.held.push(respond);
    else respond();
  }

  /** Answer the token requests held by `holdTokens`. */
  releaseTokens(): void {
    this.holdTokens = false;
    for (const f of this.held.splice(0)) f();
  }

  private upload(req: http.IncomingMessage, res: http.ServerResponse, bucket: string, url: URL, body: Buffer): void {
    const query = Object.fromEntries(url.searchParams.entries());
    const name = query.name ?? '';
    const authorization = req.headers.authorization;
    this.uploads.push({ bucket, name, query, authorization, contentType: req.headers['content-type'] });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const send = (status: number, payload: unknown) => {
      const go = () => {
        this.inFlight -= 1;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (this.uploadDelayMs > 0) setTimeout(go, this.uploadDelayMs);
      else go();
    };
    if (this.uploadStatus) return send(this.uploadStatus, { error: { code: this.uploadStatus, message: 'mock failure SECRET-DETAIL' } });
    const bearer = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    if (!bearer || !this.tokens.includes(bearer)) return send(401, { error: { code: 401, message: 'no valid token' } });
    if (this.revoked.has(bearer)) return send(401, { error: { code: 401, message: 'token revoked' } });
    const key = `${bucket}/${name}`;
    // `ifGenerationMatch=0` means "only if the object does not exist": anything already there is a 412 and is left alone.
    if (query.ifGenerationMatch === '0' && this.objects.has(key)) return send(412, { error: { code: 412, message: 'conditionNotMet' } });
    this.objects.set(key, {
      bucket,
      name,
      contentType: req.headers['content-type'] ?? '',
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
    });
    send(200, { name, bucket, generation: '1' });
  }

  /** An object that is already there. */
  seed(bucket: string, name: string, content = 'old'): void {
    this.objects.set(`${bucket}/${name}`, { bucket, name, contentType: 'image/png', sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length });
  }

  async listen(): Promise<{ tokenUrl: string; apiBase: string }> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (typeof addr === 'object' && addr) this.port = addr.port;
        resolve({ tokenUrl: `http://127.0.0.1:${this.port}/token`, apiBase: `http://127.0.0.1:${this.port}` });
      });
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** Public half of a PEM private key, for `verifyWith`. */
export function publicKeyOf(privatePem: string): KeyObject {
  return createPublicKey(privatePem);
}
