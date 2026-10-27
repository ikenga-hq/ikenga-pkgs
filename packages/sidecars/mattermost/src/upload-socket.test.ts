import { afterEach, beforeEach, describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { format } from 'node:util';
import { AuditLog } from './audit.js';
import type { AuditRecord } from './audit.js';
import { MattermostBridge } from './bridge.js';
import { resolveBridgeConfigs } from './config.js';
import { parseServiceAccount } from './gcs.js';
import { resolveMedia } from './media.js';
import type { ResolvedUploadSocket } from './media.js';
import { MockDaemon } from './mock-daemon.js';
import { MockGcs, publicKeyOf } from './mock-gcs.js';
import { MockMattermostServer } from './mock-server.js';
import { sweepTmp, tmpDir } from './test-tmp.js';
import { UploadSocket } from './upload-socket.js';
import type { UploadSocketOptions } from './upload-socket.js';
import type { MattermostBridgeConfig } from './types.js';

/**
 * The upload socket (`media.uploadSocket`): a renderer on this host names a PNG it wrote, the bridge checks it and publishes it to GCS
 * with the credential only the bridge holds. GCS is the local stub (`mock-gcs.ts`) reached through constructor options only.
 */

const ADA = 'buay4kf99bbk7cjtbeupd5rxow';
const FOUNDER = '9s65in45np8h98qeatgx7anuoa';
const HUB = '~/projects/royalti-co';
const WHERE = "bot 'ruby'";
const PASSWORD = 'daemon-pw-xyz';
const MM_TOKEN = 'mm-token-xyz';
const FAST = { pollMinMs: 10, pollMaxMs: 20, editIntervalMs: 0, maxWaitMs: 60_000, maxPollFailures: 3 };
const BUCKET = 'test-bucket';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = '20261027';
const MIB = 1024 * 1024;

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const KEY_BODY = PEM.split('\n').filter((l) => l && !l.startsWith('-----'))[0] as string;
const SA_JSON = JSON.stringify({ type: 'service_account', project_id: 'proj-1', private_key_id: 'SENTINEL-KEY-ID', private_key: PEM, client_email: 'bridge@proj-1.iam.gserviceaccount.com' });
const ENV = { MEDIA_SA: SA_JSON, MEDIA_PROJ: 'proj-1' };
const TOKEN_SENTINEL = 'ya29.SENTINEL-TOKEN-';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (n = 100, fill = 7) => Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(n, fill)]);
const jpeg = (n = 100) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 9)]);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await pause(10);
  }
}

after(async () => {
  await sweepTmp();
});

type Reply = { ok: boolean; url?: string; object?: string; sha256?: string; code?: string; message?: string };

/** One request on the socket: write `payload`, optionally half-close, read until the bridge closes. */
function ask(sock: string, payload: string | Buffer | undefined, o: { end?: boolean; timeoutMs?: number } = {}): Promise<{ reply: Reply | undefined; raw: string }> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    const chunks: Buffer[] = [];
    const t = setTimeout(() => {
      c.destroy();
      reject(new Error('no reply in time'));
    }, o.timeoutMs ?? 8_000);
    c.on('connect', () => {
      if (payload !== undefined) c.write(payload);
      if (o.end) c.end();
    });
    c.on('data', (d: Buffer) => chunks.push(d));
    c.on('error', () => undefined);
    c.on('close', () => {
      clearTimeout(t);
      const raw = Buffer.concat(chunks).toString('utf8');
      let reply: Reply | undefined;
      try {
        reply = JSON.parse(raw.split('\n')[0] as string) as Reply;
      } catch {
        reply = undefined;
      }
      resolve({ reply, raw });
    });
  });
}
const req = (p: string) => `${JSON.stringify({ path: p })}\n`;

const sgid = (): number => process.getgid?.() ?? 0;

interface Rig {
  dir: string;
  out: string;
  sock: string;
  gcs: MockGcs;
  us: UploadSocket;
  logs: string[];
  clock: { t: number };
  records: () => AuditRecord[];
  /** Write `bytes` into the source directory and return its absolute path. */
  put: (name: string, bytes: Buffer) => string;
  ask: (p: string) => Promise<Reply>;
}
let rig: Rig | undefined;
const R = (): Rig => rig as Rig;

async function makeRig(o: { cfg?: Partial<ResolvedUploadSocket>; requestTimeoutMs?: number; seam?: Partial<UploadSocketOptions>; start?: boolean } = {}): Promise<Rig> {
  const dir = tmpDir('mm-up-');
  const out = path.join(dir, 'out');
  mkdirSync(out);
  const sock = path.join(dir, 'u.sock');
  const gcs = new MockGcs();
  gcs.verifyWith = publicKeyOf(PEM);
  const ep = await gcs.listen();
  const clock = { t: NOW };
  const logs: string[] = [];
  const audit = new AuditLog({ file: path.join(dir, 'audit.jsonl'), bot: 'ruby', now: () => clock.t });
  const parsed = parseServiceAccount(SA_JSON);
  assert.ok(parsed.ok);
  const us = new UploadSocket({
    bot: 'ruby',
    bucket: BUCKET,
    prefix: 'social/',
    config: { path: sock, group: sgid(), sourceDir: out, maxBytes: 10 * MIB, ratePerMinute: 12, ...o.cfg },
    account: (parsed as Extract<typeof parsed, { ok: true }>).account,
    audit,
    log: (m) => logs.push(m),
    endpoints: ep,
    now: () => clock.t,
    timeoutMs: 5_000,
    requestTimeoutMs: o.requestTimeoutMs ?? 5_000,
    resolveGroup: async (g) => (typeof g === 'number' ? g : undefined),
    ...o.seam,
  });
  const r: Rig = {
    dir,
    out,
    sock,
    gcs,
    us,
    logs,
    clock,
    records: () => {
      try {
        return readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord).filter((x) => x.event === 'media.upload');
      } catch {
        return [];
      }
    },
    put: (name, bytes) => {
      const p = path.join(out, name);
      writeFileSync(p, bytes);
      return p;
    },
    ask: async (p) => {
      const { reply } = await ask(sock, req(p));
      assert.ok(reply, 'a reply line');
      return reply;
    },
  };
  if (o.start !== false) {
    const res = await us.start();
    assert.deepEqual(res, { ok: true });
  }
  return r;
}

const objectOf = (b: Buffer, name: string) => `social/${DAY}-${sha(b).slice(0, 16)}/${name}`;
const urlOf = (b: Buffer, name: string) => `https://storage.googleapis.com/${BUCKET}/${objectOf(b, name)}`;

/** Nothing reached Google. */
const untouched = () => assert.equal(R().gcs.uploads.length, 0, 'nothing was sent to Google');

afterEach(async () => {
  if (!rig) return;
  await rig.us.stop();
  await rig.gcs.close();
  rig = undefined;
});

// ── config validation ────────────────────────────────────────────────────────

const enabledMedia = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  bucket: BUCKET,
  allowedUserIds: [ADA],
  credentialEnv: { serviceAccountJson: 'MEDIA_SA', projectId: 'MEDIA_PROJ' },
  uploadSocket: {},
  ...over,
});
const sockCfg = (over: Record<string, unknown>) => enabledMedia({ uploadSocket: over });
const resolved = (over: Record<string, unknown> = {}) => {
  const m = resolveMedia(sockCfg(over), WHERE, { runsChi: true });
  assert.ok(m && m.enabled);
  return (m as Extract<typeof m, { enabled: true }>).uploadSocket;
};

describe('media.uploadSocket config', () => {
  it('is absent unless asked for', () => {
    const m = resolveMedia({ ...enabledMedia(), uploadSocket: undefined }, WHERE, { runsChi: true });
    assert.ok(m && m.enabled && m.uploadSocket === undefined);
  });

  it('applies the defaults for an empty block', () => {
    assert.deepEqual(resolved({}), {
      path: '/run/ikenga-mattermost/upload.sock',
      group: 'ikenga-renderers',
      sourceDir: '/var/lib/ikenga-render/out',
      maxBytes: 10 * MIB,
      ratePerMinute: 12,
    });
  });

  it('keeps what was asked for, a numeric group in either spelling', () => {
    assert.deepEqual(resolved({ path: '/run/x/u.sock', group: 'renderers', sourceDir: '/srv/out', maxBytes: 20 * MIB, ratePerMinute: 600 }), {
      path: '/run/x/u.sock',
      group: 'renderers',
      sourceDir: '/srv/out',
      maxBytes: 20 * MIB,
      ratePerMinute: 600,
    });
    assert.equal(resolved({ group: 1234 })?.group, 1234);
    assert.equal(resolved({ group: '1234' })?.group, 1234);
  });

  const bad: Array<[string, unknown, RegExp]> = [
    ['an unknown field', { extra: 1 }, /uploadSocket: unknown field 'extra'/],
    ['a non-object block', 'yes', /uploadSocket must be an object/],
    ['an array block', [], /uploadSocket must be an object/],
    ['a relative path', { path: 'run/u.sock' }, /path must be an absolute path/],
    ['a path with ..', { path: '/run/../etc/u.sock' }, /path must be an absolute path/],
    ['a path with a . segment', { path: '/run/./u.sock' }, /path must be an absolute path/],
    ['a path with //', { path: '/run//u.sock' }, /path must be an absolute path/],
    ['a path with a trailing slash', { path: '/run/u/' }, /path must be an absolute path/],
    ['a path with a space', { path: '/run/my dir/u.sock' }, /path must be an absolute path/],
    ['a path with a newline', { path: '/run/u\n.sock' }, /path must be an absolute path/],
    ['a path too long for a socket', { path: `/run/${'a'.repeat(120)}` }, /path must be an absolute path/],
    ['the root as the path', { path: '/' }, /path must be an absolute path/],
    ['a path that is not a string', { path: 5 }, /path must be an absolute path/],
    ['a relative sourceDir', { sourceDir: 'out' }, /sourceDir must be an absolute directory/],
    ['a sourceDir with ..', { sourceDir: '/var/../etc' }, /sourceDir must be an absolute directory/],
    ['a sourceDir with a trailing slash', { sourceDir: '/var/out/' }, /sourceDir must be an absolute directory/],
    ['the root as sourceDir', { sourceDir: '/' }, /sourceDir must be an absolute directory/],
    ['group 0', { group: 0 }, /root group is refused/],
    ['group "0"', { group: '0' }, /root group is refused/],
    ['a negative gid', { group: -5 }, /root group is refused/],
    ['a fractional gid', { group: 1.5 }, /root group is refused/],
    ['a gid too big', { group: 4294967295 }, /root group is refused/],
    ['a group name with a space', { group: 'a b' }, /group must be a group name/],
    ['a group name starting with -', { group: '-rf' }, /group must be a group name/],
    ['a group name with a slash', { group: 'a/b' }, /group must be a group name/],
    ['a group that is a boolean', { group: true }, /group must be a group name/],
    ['maxBytes over 20 MiB', { maxBytes: 20 * MIB + 1 }, /maxBytes must be/],
    ['maxBytes zero', { maxBytes: 0 }, /maxBytes must be/],
    ['maxBytes a string', { maxBytes: '8' }, /maxBytes must be/],
    ['maxBytes fractional', { maxBytes: 10.5 }, /maxBytes must be/],
    ['ratePerMinute zero', { ratePerMinute: 0 }, /ratePerMinute must be/],
    ['ratePerMinute over the maximum', { ratePerMinute: 601 }, /ratePerMinute must be/],
    ['ratePerMinute a string', { ratePerMinute: '12' }, /ratePerMinute must be/],
  ];
  for (const [what, over, re] of bad) {
    it(`refuses ${what}`, () => {
      assert.throws(() => resolveMedia(sockCfg(over as Record<string, unknown>), WHERE, { runsChi: true }), re);
    });
  }
  it('refuses a non-object block too', () => {
    assert.throws(() => resolveMedia(enabledMedia({ uploadSocket: 'yes' }), WHERE, { runsChi: true }), /uploadSocket must be an object/);
  });

  it('checks the block even while media is disabled, and then ignores it', () => {
    assert.throws(() => resolveMedia({ enabled: false, uploadSocket: { path: 'rel' } }, WHERE, { runsChi: true }), /path must be an absolute path/);
    assert.deepEqual(resolveMedia({ enabled: false, uploadSocket: {} }, WHERE, { runsChi: true }), { enabled: false });
  });

  it('never repeats a value the operator typed', () => {
    let msg = '';
    try {
      resolveMedia(sockCfg({ path: '/run/SENTINELVALUE bad path' }), WHERE, { runsChi: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.match(msg, /path must be/);
    assert.ok(!msg.includes('SENTINELVALUE'));
    let msg2 = '';
    try {
      resolveMedia(sockCfg({ ['SENTINELVALUE' + 'x'.repeat(100)]: 1 }), WHERE, { runsChi: true });
    } catch (e) {
      msg2 = (e as Error).message;
    }
    assert.ok(msg2.length < 300);
  });

  it('is refused at config load, naming the bot', () => {
    const file = (media: Record<string, unknown>) => ({
      mattermostUrl: 'http://x',
      bots: {
        ruby: {
          mattermostToken: { value: 't' },
          allowedUsers: [FOUNDER],
          allowedChannels: ['c'],
          daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { value: 't' } } },
          chi: { engine: 'claude-code' },
          media: media as never,
        },
      },
    });
    assert.throws(() => resolveBridgeConfigs(file(sockCfg({ group: 0 }))), /bot 'ruby': media.uploadSocket.group/);
    const [ok] = resolveBridgeConfigs(file(sockCfg({ ratePerMinute: 5 })));
    assert.equal((ok as MattermostBridgeConfig).media?.uploadSocket?.ratePerMinute, 5);
  });
});

// ── the socket itself ────────────────────────────────────────────────────────

describe('the socket node', () => {
  it('is created with mode 0660, owned by the configured group, and is a socket', async () => {
    // A group the process belongs to but is not its primary one, when there is one: chown to it must really change the group.
    const other = (process.getgroups?.() ?? []).find((g) => g !== sgid());
    const gid = other ?? sgid();
    rig = await makeRig({ cfg: { group: gid } });
    const st = lstatSync(R().sock);
    assert.ok(st.isSocket());
    assert.equal(st.mode & 0o777, 0o660);
    assert.equal(st.gid, gid);
    assert.equal(st.uid, process.getuid?.());
  });

  it('does not leave the process umask changed', async () => {
    const before = process.umask();
    rig = await makeRig();
    assert.equal(process.umask(), before);
  });

  it('fails, leaving nothing behind, for a group that does not exist', async () => {
    rig = await makeRig({ cfg: { group: 'no-such-group-xyz' }, start: false });
    const res = await R().us.start();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /group 'no-such-group-xyz' does not exist/);
    assert.equal(existsSync(R().sock), false);
  });

  it('fails, leaving nothing behind, when the group is not one the process may give a file to', async () => {
    if (process.getuid?.() === 0) return; // root may chown to anything
    const groups = new Set([sgid(), ...(process.getgroups?.() ?? [])]);
    let foreign = 65000;
    while (groups.has(foreign)) foreign += 1;
    rig = await makeRig({ cfg: { group: foreign }, start: false });
    const res = await R().us.start();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /could not create .*EPERM/);
    assert.equal(existsSync(R().sock), false, 'a node that could not be put in its group is removed');
  });

  it('fails when the directory of the socket does not exist', async () => {
    rig = await makeRig({ start: false });
    const us = new UploadSocket({ ...R().us['opts'], config: { ...R().us['cfg'], path: path.join(R().dir, 'nope', 'u.sock') } });
    const res = await us.start();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /could not create .*\/nope\/u\.sock/);
    assert.equal(existsSync(path.join(R().dir, 'nope')), false, 'no directory was made for it');
  });

  it('removes a stale socket node (a crashed bridge) and listens', async () => {
    rig = await makeRig({ start: false });
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(R().sock)},()=>console.log('up'));setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    assert.ok(lstatSync(R().sock).isSocket(), 'the dead process left its node');
    assert.deepEqual(await R().us.start(), { ok: true });
    R().put('20261027-0123456789abcdef-a.png', png());
    assert.equal((await R().ask(path.join(R().out, '20261027-0123456789abcdef-a.png'))).ok, true);
  });

  it('refuses to take over a socket somebody is listening on, and leaves it working', async () => {
    rig = await makeRig({ start: false });
    const live = net.createServer((c) => {
      c.on('error', () => undefined);
      c.end('mine\n');
    });
    await new Promise<void>((r) => live.listen(R().sock, () => r()));
    try {
      const res = await R().us.start();
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.message, /in use by a running listener/);
      const got = await ask(R().sock, 'x\n');
      assert.equal(got.raw, 'mine\n', 'the other listener still owns the path');
    } finally {
      live.close();
    }
  });

  it('leaves alone anything at the path that is not a socket node', async () => {
    rig = await makeRig({ start: false });
    writeFileSync(R().sock, 'precious');
    let res = await R().us.start();
    assert.equal(res.ok, false);
    assert.equal(readFileSync(R().sock, 'utf8'), 'precious');
    rmFile(R().sock);
    mkdirSync(R().sock);
    res = await new UploadSocket({ ...R().us['opts'] }).start();
    assert.equal(res.ok, false);
    assert.ok(lstatSync(R().sock).isDirectory());
    rmDir(R().sock);
    const target = path.join(R().dir, 'target');
    writeFileSync(target, 'precious');
    symlinkSync(target, R().sock);
    res = await new UploadSocket({ ...R().us['opts'] }).start();
    assert.equal(res.ok, false);
    assert.ok(lstatSync(R().sock).isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), 'precious');
  });

  it('closes and unlinks the socket on stop, and answers nobody afterwards', async () => {
    rig = await makeRig();
    assert.ok(existsSync(R().sock));
    await R().us.stop();
    assert.equal(existsSync(R().sock), false);
    const gone = await ask(R().sock, req('/x'));
    assert.deepEqual([gone.reply, gone.raw], [undefined, ''], 'nothing listens any more');
    await R().us.stop(); // twice is fine
  });

  it('a stop during start leaves nothing listening', async () => {
    rig = await makeRig({ start: false });
    const starting = R().us.start();
    const stopping = R().us.stop();
    const res = await starting;
    await stopping;
    assert.equal(res.ok, false);
    assert.equal(existsSync(R().sock), false);
  });
});

function rmFile(p: string): void {
  execFileSync('rm', ['-f', p]);
}
function rmDir(p: string): void {
  execFileSync('rm', ['-rf', p]);
}

// ── publishing ───────────────────────────────────────────────────────────────

describe('a rendered PNG', () => {
  beforeEach(async () => {
    rig = await makeRig();
  });

  it('is uploaded once, to the content-addressed object, and the reply carries the public URL', async () => {
    const b = png(200);
    const p = R().put('20261026-aaaaaaaaaaaaaaaa-spring-sale.png', b);
    const r = await R().ask(p);
    assert.deepEqual(r, { ok: true, url: urlOf(b, 'spring-sale.png'), object: objectOf(b, 'spring-sale.png'), sha256: sha(b) });
    assert.equal(R().gcs.uploads.length, 1);
    const up = R().gcs.uploads[0]!;
    assert.equal(up.bucket, BUCKET);
    assert.equal(up.name, objectOf(b, 'spring-sale.png'));
    assert.equal(up.query.ifGenerationMatch, '0');
    assert.equal(up.query.predefinedAcl, undefined);
    assert.equal(up.contentType, 'image/png');
    assert.equal(up.authorization, `Bearer ${R().gcs.tokens[0]}`);
    assert.equal(R().gcs.objects.get(`${BUCKET}/${up.name}`)?.sha256, sha(b), 'the stored bytes are the file');
    assert.deepEqual(R().gcs.jwtProblems, []);
  });

  it('is audited once, with the basename, hash, size and object and nothing else about the path', async () => {
    const b = png(64);
    const p = R().put('20261026-aaaaaaaaaaaaaaaa-card.png', b);
    await R().ask(p);
    const rec = R().records();
    assert.equal(rec.length, 1);
    assert.deepEqual(
      { outcome: rec[0]?.outcome, file: rec[0]?.file, sha: rec[0]?.sha256, bytes: rec[0]?.bytes, object: rec[0]?.object },
      { outcome: 'uploaded', file: '20261026-aaaaaaaaaaaaaaaa-card.png', sha: sha(b), bytes: b.length, object: objectOf(b, 'card.png') },
    );
    assert.ok(!JSON.stringify(rec).includes(R().dir), 'no directory in the record');
  });

  const names: Array<[string, string, string]> = [
    ['drops the leading date and hash of the render name', '20261026-0123456789abcdef-linkedin-card.png', 'linkedin-card.png'],
    ['keeps a name that has no date-hash', 'plain.png', 'plain.png'],
    ['keeps a name whose hash is too short to be one', '20261026-0123-x.png', '20261026-0123-x.png'],
    ['sanitizes what is left', '20261026-0123456789abcdef-a b$c.png', 'a_b_c.png'],
    ['falls back when nothing is left', '20261026-0123456789abcdef-.png', 'image.png'],
    ['forces the png extension', '20261026-0123456789abcdef-x.PNG.html', 'x.PNG.png'],
  ];
  for (const [what, file, want] of names) {
    it(`${what}`, async () => {
      const b = png(30);
      const r = await R().ask(R().put(file, b));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.object, objectOf(b, want));
    });
  }

  it('accepts a PNG in a subdirectory of the source directory', async () => {
    mkdirSync(path.join(R().out, 'sub'));
    const b = png(40);
    const p = path.join(R().out, 'sub', 'x.png');
    writeFileSync(p, b);
    assert.equal((await R().ask(p)).ok, true);
  });

  it('accepts a symlink inside the directory that points at a file inside it (the real file is what counts)', async () => {
    const b = png(40);
    R().put('real.png', b);
    symlinkSync(path.join(R().out, 'real.png'), path.join(R().out, 'alias.png'));
    const r = await R().ask(path.join(R().out, 'alias.png'));
    assert.equal(r.ok, true);
    assert.equal(r.object, objectOf(b, 'real.png'));
  });

  it('answers a second request for the same bytes (a 412) as a success with the same URL', async () => {
    const b = png(77);
    const p = R().put('x.png', b);
    const r1 = await R().ask(p);
    const r2 = await R().ask(p);
    assert.deepEqual(r2, r1);
    assert.equal(R().gcs.uploads.length, 2, 'the second attempt reached Google and was refused with 412');
    assert.equal(R().gcs.objects.size, 1);
    assert.deepEqual(R().records().map((x) => x.outcome), ['uploaded', 'already_present']);
  });

  it('treats an object that was already there (seeded) as success and does not overwrite it', async () => {
    const b = png(50);
    R().gcs.seed(BUCKET, objectOf(b, 'x.png'), 'old');
    const r = await R().ask(R().put('x.png', b));
    assert.equal(r.ok, true);
    assert.equal(R().gcs.objects.get(`${BUCKET}/${objectOf(b, 'x.png')}`)?.bytes, 3, 'the old object is untouched');
    assert.equal(R().records()[0]?.outcome, 'already_present');
  });

  it('five concurrent requests for one file leave one object and all get the URL', async () => {
    const b = png(500);
    const p = R().put('same.png', b);
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => R().ask(p)));
    assert.ok(all.every((r) => r.ok && r.url === urlOf(b, 'same.png')), JSON.stringify(all));
    assert.equal(R().gcs.objects.size, 1);
    assert.equal(R().records().filter((x) => x.outcome === 'uploaded').length, 1);
  });

  it('never has more than two uploads in flight, and answers all of them', async () => {
    R().gcs.uploadDelayMs = 80;
    const files = [1, 2, 3, 4, 5, 6].map((n) => R().put(`f${n}.png`, png(20, n)));
    const all = await Promise.all(files.map((f) => R().ask(f)));
    assert.ok(all.every((r) => r.ok), JSON.stringify(all));
    assert.equal(R().gcs.maxInFlight, 2);
    assert.equal(R().gcs.objects.size, 6);
  });

  it('accepts a file of exactly maxBytes and refuses one a byte over', async () => {
    await rig!.us.stop();
    await rig!.gcs.close();
    rig = await makeRig({ cfg: { maxBytes: 1000 } });
    const exact = Buffer.concat([png(0), Buffer.alloc(1000 - 8, 1)]);
    assert.equal(exact.length, 1000);
    assert.equal((await R().ask(R().put('exact.png', exact))).ok, true);
    const over = Buffer.concat([exact, Buffer.from([1])]);
    const r = await R().ask(R().put('over.png', over));
    assert.equal(r.code, 'too_large');
    assert.equal(R().gcs.uploads.length, 1, 'only the first reached Google');
  });
});

// ── what must be refused ─────────────────────────────────────────────────────

const REFUSALS: Record<string, string> = {
  bad_request: 'request must be one JSON line with a path',
  not_found: 'file not found',
  outside_source_dir: 'file is outside the render output directory',
  not_regular: 'not an acceptable regular file',
  too_large: 'file is too large',
  not_png: 'file is not a PNG',
  rate_limited: 'too many requests, try again shortly',
  upload_failed: 'upload failed',
};

describe('a file that must be refused', () => {
  beforeEach(async () => {
    rig = await makeRig();
  });
  const refused = async (p: string, code: string) => {
    const r = await R().ask(p);
    assert.equal(r.ok, false, `${p} was accepted: ${JSON.stringify(r)}`);
    assert.equal(r.code, code);
    assert.equal(r.message, REFUSALS[code], 'a fixed phrase');
    assert.deepEqual(Object.keys(r).sort(), ['code', 'message', 'ok']);
    untouched();
    const rec = R().records().at(-1);
    assert.equal(rec?.outcome, 'refused');
    assert.equal(rec?.reason, code);
  };

  it('a name that is not there', async () => refused(path.join(R().out, 'missing.png'), 'not_found'));

  it('a path with ../ that climbs out', async () => {
    writeFileSync(path.join(R().dir, 'secret.png'), png());
    await refused(`${R().out}/../secret.png`, 'outside_source_dir');
  });

  it('a path with ../ that goes down and back up inside is fine', async () => {
    mkdirSync(path.join(R().out, 'd'));
    R().put('ok.png', png(9));
    const r = await R().ask(`${R().out}/d/../ok.png`);
    assert.equal(r.ok, true);
  });

  it('an absolute path outside the directory', async () => {
    const p = path.join(R().dir, 'elsewhere.png');
    writeFileSync(p, png());
    await refused(p, 'outside_source_dir');
  });

  it('a directory whose name merely starts with the source directory name', async () => {
    const evil = `${R().out}-evil`;
    mkdirSync(evil);
    writeFileSync(path.join(evil, 'x.png'), png());
    await refused(path.join(evil, 'x.png'), 'outside_source_dir');
  });

  it('a symlink inside the directory that points to a file outside', async () => {
    const target = path.join(R().dir, 'outside.png');
    writeFileSync(target, png());
    symlinkSync(target, path.join(R().out, 'link.png'));
    await refused(path.join(R().out, 'link.png'), 'outside_source_dir');
  });

  it('a path through a symlinked directory that leads outside', async () => {
    const outside = path.join(R().dir, 'outdir');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'x.png'), png());
    symlinkSync(outside, path.join(R().out, 'sub'));
    await refused(path.join(R().out, 'sub', 'x.png'), 'outside_source_dir');
  });

  it('a symlink to /etc/passwd', async () => {
    symlinkSync('/etc/passwd', path.join(R().out, 'pw.png'));
    await refused(path.join(R().out, 'pw.png'), 'outside_source_dir');
  });

  it('a symlink loop', async () => {
    symlinkSync(path.join(R().out, 'b.png'), path.join(R().out, 'a.png'));
    symlinkSync(path.join(R().out, 'a.png'), path.join(R().out, 'b.png'));
    await refused(path.join(R().out, 'a.png'), 'not_found');
  });

  it('a hard link to a file that lives elsewhere (two names for one inode)', async () => {
    const elsewhere = path.join(R().dir, 'elsewhere.png');
    writeFileSync(elsewhere, png());
    linkSync(elsewhere, path.join(R().out, 'hard.png'));
    await refused(path.join(R().out, 'hard.png'), 'not_regular');
  });

  it('a FIFO (and it does not hang opening it)', async () => {
    execFileSync('mkfifo', [path.join(R().out, 'pipe.png')]);
    await refused(path.join(R().out, 'pipe.png'), 'not_regular');
  });

  it('a directory with a .png name', async () => {
    mkdirSync(path.join(R().out, 'dir.png'));
    await refused(path.join(R().out, 'dir.png'), 'not_regular');
  });

  it('the source directory itself', async () => refused(R().out, 'outside_source_dir'));

  it('a device node outside the directory, and a device node inside a source directory', async () => {
    await refused('/dev/null', 'outside_source_dir');
    await R().us.stop();
    await R().gcs.close();
    rig = await makeRig({ cfg: { sourceDir: '/dev' } });
    await refused('/dev/null', 'not_regular');
    await refused('/dev/zero', 'not_regular');
  });

  it('a unix socket node', async () => {
    const s = net.createServer();
    const p = path.join(R().out, 'sock.png');
    await new Promise<void>((r) => s.listen(p, () => r()));
    try {
      await refused(p, 'not_regular');
    } finally {
      s.close();
    }
  });

  it('a JPEG with a .png name', async () => refused(R().put('j.png', jpeg()), 'not_png'));
  it('an SVG with a .png name', async () => refused(R().put('s.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'not_png'));
  it('a GIF with a .png name', async () => refused(R().put('g.png', Buffer.from('GIF89a........')), 'not_png'));
  it('an HTML file with a .png name', async () => refused(R().put('h.png', Buffer.from('<html><script>alert(1)</script></html>')), 'not_png'));
  it('a PNG signature that is cut short', async () => refused(R().put('t.png', Buffer.from(PNG_HEAD.slice(0, 7))), 'not_png'));
  it('a file that starts like a PNG but is off by one byte', async () => refused(R().put('o.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b, 1, 2])), 'not_png'));
  it('an empty file', async () => refused(R().put('e.png', Buffer.alloc(0)), 'not_png'));
  it('a real PNG without the .png extension is fine, because the bytes decide', async () => {
    const r = await R().ask(R().put('data.bin', png(10)));
    assert.equal(r.ok, true);
    assert.ok(r.object?.endsWith('/data.png'));
  });

  it('a file over maxBytes is refused before it is read', async () => {
    await R().us.stop();
    await R().gcs.close();
    rig = await makeRig({ cfg: { maxBytes: 100 } });
    await refused(R().put('big.png', png(500)), 'too_large');
  });

  it('a sparse file of 10 GB is refused without being read', async () => {
    const p = path.join(R().out, 'sparse.png');
    writeFileSync(p, png());
    execFileSync('truncate', ['-s', '10G', p]);
    await refused(p, 'too_large');
  });

  it('a file that cannot be read (mode 000) is not found, not a stack trace', async () => {
    if (process.getuid?.() === 0) return;
    const p = R().put('locked.png', png());
    chmodSync(p, 0);
    const r = await R().ask(p);
    assert.equal(r.ok, false);
    assert.equal(r.message, REFUSALS[r.code as string]);
  });

  it('a source directory that does not exist refuses everything', async () => {
    await R().us.stop();
    await R().gcs.close();
    rig = await makeRig({ cfg: { sourceDir: '/nonexistent-dir-for-test' } });
    await refused(path.join(R().dir, 'x.png'), 'not_found');
    writeFileSync(path.join(R().dir, 'y.png'), png());
    await refused(path.join(R().dir, 'y.png'), 'outside_source_dir');
  });
});

// ── what is on the wire ──────────────────────────────────────────────────────

describe('the request line', () => {
  beforeEach(async () => {
    rig = await makeRig({ requestTimeoutMs: 150 });
  });
  const bad = async (payload: string | Buffer | undefined, o: { end?: boolean } = {}, phrase = REFUSALS.bad_request) => {
    const { reply, raw } = await ask(R().sock, payload, o);
    assert.equal(reply?.ok, false, raw);
    assert.equal(reply?.code, 'bad_request');
    assert.equal(reply?.message, phrase);
    untouched();
  };

  it('truncated JSON, then the client goes away', async () => bad('{"path":"/a/b', { end: true }));
  it('truncated JSON with no end: it times out', async () => bad('{"path":"/a/b', {}, 'request not received in time'));
  it('not JSON', async () => bad('GET / HTTP/1.1\n'));
  it('an empty line', async () => bad('\n'));
  it('a client that sends nothing and hangs up', async () => bad(undefined, { end: true }));
  it('a JSON array', async () => bad('[]\n'));
  it('a JSON string', async () => bad('"/a"\n'));
  it('null', async () => bad('null\n'));
  it('no path', async () => bad('{}\n'));
  it('a path that is a number', async () => bad('{"path":5}\n'));
  it('a path that is an object', async () => bad('{"path":{"a":1}}\n'));
  it('an empty path', async () => bad('{"path":""}\n'));
  it('a relative path', async () => bad('{"path":"out/x.png"}\n'));
  it('a path with a NUL', async () => bad('{"path":"/a\\u0000b"}\n'));
  it('a path of 2000 characters', async () => bad(`{"path":"/${'a'.repeat(2000)}"}\n`));

  it('a line of 64 KiB with no newline gets a reply, without the bridge buffering it', async () => bad(Buffer.alloc(64 * 1024, 0x61), {}, 'request line too long'));

  it('the line limit is 4096 bytes including the newline', async () => {
    const pad = (n: number) => `{"path":"/x","pad":"${'a'.repeat(n)}"}`;
    const base = pad(0).length;
    const fits = `${pad(4095 - base)}\n`;
    assert.equal(fits.length, 4096);
    const ok = await ask(R().sock, fits);
    assert.equal(ok.reply?.code, 'not_found', 'a 4096-byte request is read');
    const tooLong = `${pad(4096 - base)}\n`;
    assert.equal(tooLong.length, 4097);
    const r = await ask(R().sock, tooLong);
    assert.equal(r.reply?.code, 'bad_request');
    assert.equal(r.reply?.message, 'request line too long');
  });

  it('only the first line is a request; what follows is ignored', async () => {
    const p = R().put('x.png', png(5));
    const { reply } = await ask(R().sock, `${JSON.stringify({ path: p })}\n${JSON.stringify({ path: '/etc/passwd' })}\n`);
    assert.equal(reply?.ok, true);
    assert.equal(R().gcs.uploads.length, 1);
  });

  it('extra keys in the request are ignored', async () => {
    const p = R().put('x.png', png(5));
    const { reply } = await ask(R().sock, `${JSON.stringify({ path: p, bucket: 'evil', object: 'x', prefix: '../' })}\n`);
    assert.equal(reply?.ok, true);
    assert.equal(R().gcs.uploads[0]?.bucket, BUCKET, 'the caller cannot choose the bucket');
    assert.ok(R().gcs.uploads[0]?.name.startsWith('social/'));
  });

  it('a request sent without a final newline but with the client half-closed is read', async () => {
    const p = R().put('x.png', png(5));
    const { reply } = await ask(R().sock, JSON.stringify({ path: p }), { end: true });
    assert.equal(reply?.ok, true);
  });

  it('a slow client that stalls after a few bytes is answered at the timeout and the next client is served', async () => {
    const t0 = Date.now();
    const slow = await ask(R().sock, '{"pa');
    assert.equal(slow.reply?.message, 'request not received in time');
    assert.ok(Date.now() - t0 < 3_000);
    const p = R().put('x.png', png(5));
    assert.equal((await R().ask(p)).ok, true);
  });

  it('a client that disconnects without waiting for the reply does not hurt the bridge', async () => {
    const p = R().put('x.png', png(5));
    for (let i = 0; i < 5; i++) {
      const c = net.createConnection(R().sock);
      await new Promise<void>((r) => c.on('connect', () => r()));
      c.write(req(p));
      c.destroy();
    }
    await pause(200);
    const again = R().put('y.png', png(6));
    assert.equal((await R().ask(again)).ok, true);
  });
});

describe('load', () => {
  it('a ninth connection while eight are open is answered rate_limited at once; the rest are unaffected', async () => {
    rig = await makeRig({ requestTimeoutMs: 3_000 });
    const held: net.Socket[] = [];
    for (let i = 0; i < 8; i++) {
      const c = net.createConnection(R().sock);
      await new Promise<void>((r) => c.on('connect', () => r()));
      held.push(c);
    }
    await pause(50);
    const t0 = Date.now();
    const ninth = await ask(R().sock, req('/x'));
    assert.equal(ninth.reply?.code, 'rate_limited');
    assert.equal(ninth.reply?.message, REFUSALS.rate_limited);
    assert.ok(Date.now() - t0 < 1_000, 'it did not wait for a slot');
    for (const c of held) c.destroy();
    await pause(100);
    const p = R().put('x.png', png(5));
    assert.equal((await R().ask(p)).ok, true, 'served again once the connections closed');
  });

  it('a flood of 200 connections that send garbage leaves the bridge serving', async () => {
    rig = await makeRig({ requestTimeoutMs: 200 });
    const flood = Array.from({ length: 200 }, (_, i) => ask(R().sock, i % 2 ? 'garbage\n' : '{"path":', { timeoutMs: 15_000 }).catch(() => undefined));
    await Promise.all(flood);
    const p = R().put('x.png', png(5));
    assert.equal((await R().ask(p)).ok, true);
  });

  it('rate limit: ratePerMinute requests go through, the next is refused, and the bucket refills with the clock', async () => {
    rig = await makeRig({ cfg: { ratePerMinute: 3 } });
    const p = R().put('x.png', png(5));
    for (let i = 0; i < 3; i++) assert.equal((await R().ask(p)).ok, true);
    const r = await R().ask(p);
    assert.equal(r.code, 'rate_limited');
    assert.equal(r.message, REFUSALS.rate_limited);
    assert.equal(R().gcs.uploads.length, 3, 'the refused request did no work');
    R().clock.t += 19_000;
    assert.equal((await R().ask(p)).code, 'rate_limited', '19 s is not yet a token at 3 per minute');
    R().clock.t += 1_500;
    assert.equal((await R().ask(p)).ok, true, 'a token came back');
    assert.equal((await R().ask(p)).code, 'rate_limited');
    R().clock.t += 10 * 60_000;
    for (let i = 0; i < 3; i++) assert.equal((await R().ask(p)).ok, true);
    assert.equal((await R().ask(p)).code, 'rate_limited', 'the bucket never holds more than ratePerMinute');
  });

  it('requests that are not well-formed do not use up the budget', async () => {
    rig = await makeRig({ cfg: { ratePerMinute: 2 } });
    for (let i = 0; i < 10; i++) assert.equal((await ask(R().sock, 'nope\n')).reply?.code, 'bad_request');
    const p = R().put('x.png', png(5));
    assert.equal((await R().ask(p)).ok, true);
    assert.equal((await R().ask(p)).ok, true);
    assert.equal((await R().ask(p)).code, 'rate_limited');
  });

  it('refused requests do count, and a flood writes one audit record per minute (with the count)', async () => {
    rig = await makeRig({ cfg: { ratePerMinute: 1 } });
    const p = path.join(R().out, 'missing.png');
    assert.equal((await R().ask(p)).code, 'not_found');
    for (let i = 0; i < 20; i++) assert.equal((await R().ask(p)).code, 'rate_limited');
    const rec = R().records();
    assert.equal(rec.filter((x) => x.reason === 'rate_limited').length, 1, 'coalesced');
    assert.equal(rec.filter((x) => x.reason === 'not_found').length, 1);
    R().clock.t += 61_000;
    assert.equal((await R().ask(p)).code, 'not_found');
    for (let i = 0; i < 3; i++) await R().ask(p);
    const later = R().records().filter((x) => x.reason === 'rate_limited');
    assert.equal(later.length, 2);
    assert.equal(later[1]?.suppressed, 19);
  });
});

// ── Google trouble ───────────────────────────────────────────────────────────

describe('when Google refuses', () => {
  beforeEach(async () => {
    rig = await makeRig();
  });
  for (const status of [403, 500, 400, 404]) {
    it(`an upload answered HTTP ${status} is a fixed upload_failed, with nothing of Google's reply`, async () => {
      R().gcs.uploadStatus = status;
      const p = R().put('x.png', png(5));
      const { reply, raw } = await ask(R().sock, req(p));
      assert.deepEqual(reply, { ok: false, code: 'upload_failed', message: 'upload failed' });
      assert.ok(!raw.includes('SECRET-DETAIL') && !raw.includes('mock failure') && !raw.includes(String(status)));
      const rec = R().records()[0];
      assert.equal(rec?.reason, 'upload_failed');
      assert.equal(rec?.http_status, status);
      assert.ok(!JSON.stringify(R().records()).includes('SECRET-DETAIL'));
      assert.ok(!R().logs.join('\n').includes('SECRET-DETAIL'));
    });
  }
  it('a token request that is refused is a fixed upload_failed', async () => {
    R().gcs.tokenStatus = 400;
    const { reply, raw } = await ask(R().sock, req(R().put('x.png', png(5))));
    assert.deepEqual(reply, { ok: false, code: 'upload_failed', message: 'upload failed' });
    assert.ok(!raw.includes('SECRET-DETAIL') && !raw.includes('invalid_grant'));
    assert.equal(R().gcs.uploads.length, 0);
  });
  it('Google being down is a fixed upload_failed', async () => {
    await R().gcs.close();
    const { reply } = await ask(R().sock, req(R().put('x.png', png(5))));
    assert.deepEqual(reply, { ok: false, code: 'upload_failed', message: 'upload failed' });
    rig = { ...R(), gcs: new MockGcs() }; // the afterEach closes this one
  });
  it('keeps serving after a failure', async () => {
    R().gcs.uploadStatus = 500;
    const p = R().put('x.png', png(5));
    assert.equal((await R().ask(p)).code, 'upload_failed');
    R().gcs.uploadStatus = undefined;
    assert.equal((await R().ask(p)).ok, true);
  });
});

describe('a handler that crashes', () => {
  it('is answered upload_failed and the socket goes on serving', async () => {
    rig = await makeRig();
    const p = R().put('x.png', png(5));
    const audit = R().us['opts'].audit as AuditLog;
    const real = audit.record.bind(audit);
    let boom = 1;
    audit.record = ((event: string, fields: Record<string, never>) => {
      if (boom-- > 0) throw new Error('SENTINEL-CRASH detail with /secret/path');
      return real(event, fields);
    }) as AuditLog['record'];
    const first = await ask(R().sock, req(p));
    assert.deepEqual(first.reply, { ok: false, code: 'upload_failed', message: 'upload failed' });
    assert.ok(!first.raw.includes('SENTINEL-CRASH') && !first.raw.includes('/secret'));
    assert.equal((await R().ask(p)).ok, true, 'still serving');
  });
});

// ── secrets ──────────────────────────────────────────────────────────────────

describe('secrets', () => {
  it('the key, the key id, the token and a Google body appear in no reply, log line or audit record, success or failure', async () => {
    rig = await makeRig();
    const good = R().put('x.png', png(5));
    const replies: string[] = [];
    replies.push((await ask(R().sock, req(good))).raw);
    R().gcs.uploadStatus = 403;
    replies.push((await ask(R().sock, req(R().put('y.png', png(6))))).raw);
    R().gcs.uploadStatus = undefined;
    replies.push((await ask(R().sock, req('/etc/passwd'))).raw);
    replies.push((await ask(R().sock, 'junk\n')).raw);
    assert.ok(R().gcs.tokens.length > 0 && R().gcs.tokens.every((t) => t.startsWith(TOKEN_SENTINEL)));
    const everything = [...replies, ...R().logs, readFileSync(path.join(R().dir, 'audit.jsonl'), 'utf8')].join('\n');
    for (const secret of [KEY_BODY, 'SENTINEL-KEY-ID', TOKEN_SENTINEL, 'SECRET-DETAIL', 'bridge@proj-1', 'BEGIN PRIVATE KEY']) {
      assert.ok(!everything.includes(secret), `${secret} leaked`);
    }
    assert.ok(!replies.join('\n').includes(R().dir), 'no host path in a reply');
  });

  it('a reply holds only the contract fields', async () => {
    rig = await makeRig();
    const ok = await R().ask(R().put('x.png', png(5)));
    assert.deepEqual(Object.keys(ok).sort(), ['object', 'ok', 'sha256', 'url']);
    const no = await R().ask('/nope');
    assert.deepEqual(Object.keys(no).sort(), ['code', 'message', 'ok']);
  });
});

// ── inside the bridge ────────────────────────────────────────────────────────

describe('the bridge and the upload socket', () => {
  let mm: MockMattermostServer;
  let daemon: MockDaemon;
  let gcs: MockGcs;
  let dir: string;
  let out: string;
  let sock: string;
  let bridge: MattermostBridge | undefined;
  let logs: string[];
  let restore: (() => void) | undefined;
  const auditFile = () => path.join(dir, 'audit-ruby.jsonl');
  const audit = (): AuditRecord[] => {
    try {
      return readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    mm = new MockMattermostServer();
    daemon = new MockDaemon('t1', { username: 'ruby', password: PASSWORD });
    gcs = new MockGcs();
    gcs.verifyWith = publicKeyOf(PEM);
    dir = tmpDir('mm-up-');
    out = path.join(dir, 'out');
    mkdirSync(out);
    sock = path.join(dir, 'u.sock');
    logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const grab = (...a: unknown[]) => void logs.push(format(...a));
    console.log = grab;
    console.error = grab;
    console.warn = grab;
    restore = () => Object.assign(console, orig);
  });
  afterEach(async () => {
    restore?.();
    bridge?.stop();
    bridge = undefined;
    await mm.close();
    await daemon.close();
    await gcs.close();
  });

  process.env.MM_TEST_TOKEN = MM_TOKEN;
  process.env.DAEMON_TEST_PW = PASSWORD;

  async function boot(o: { media?: Record<string, unknown> | null; env?: NodeJS.ProcessEnv; group?: number | undefined } = {}): Promise<void> {
    mm.channels.set('royalti-co', 'id-royalti-co');
    const mmUrl = await mm.listen();
    const daemonUrl = await daemon.listen();
    const ep = await gcs.listen();
    const [cfg] = resolveBridgeConfigs({
      mattermostUrl: mmUrl,
      dataDir: dir,
      bots: {
        ruby: {
          mattermostToken: { env: 'MM_TEST_TOKEN' },
          allowedUsers: [FOUNDER],
          allowedChannels: ['ruby-test'],
          daemon: { url: daemonUrl, auth: { kind: 'session', username: 'ruby', password: { env: 'DAEMON_TEST_PW' } } },
          chi: { engine: 'claude-code', cwd: HUB, systemPrompt: 'You are Ruby.', persistent: true },
          maxMode: 'default',
          progress: FAST,
          ...(o.media === null ? {} : { media: enabledMedia({ uploadSocket: { path: sock, sourceDir: out, group: 'test-renderers' }, ...(o.media ?? {}) }) }),
        },
      },
    });
    bridge = new MattermostBridge({ ...(cfg as MattermostBridgeConfig) }, undefined, undefined, {
      media: {
        endpoints: ep,
        now: () => NOW,
        env: o.env ?? ENV,
        timeoutMs: 5_000,
        uploadSocket: { requestTimeoutMs: 300, resolveGroup: async (g) => (g === 'test-renderers' ? (o.group ?? sgid()) : undefined) },
      },
    });
    await bridge.start();
    await pause(60);
  }

  it('creates the socket on start, publishes through it, audits it, and unlinks it on stop', async () => {
    await boot();
    assert.ok(lstatSync(sock).isSocket());
    assert.equal(lstatSync(sock).mode & 0o777, 0o660);
    const b = png(80);
    const p = path.join(out, '20261026-aaaaaaaaaaaaaaaa-hero.png');
    writeFileSync(p, b);
    const { reply } = await ask(sock, req(p));
    assert.deepEqual(reply, { ok: true, url: urlOf(b, 'hero.png'), object: objectOf(b, 'hero.png'), sha256: sha(b) });
    const recs = audit();
    assert.deepEqual(recs.find((r) => r.event === 'media.upload_socket')?.outcome, 'listening');
    assert.equal(recs.find((r) => r.event === 'media.upload')?.outcome, 'uploaded');
    assert.equal(recs.find((r) => r.event === 'config.loaded')?.upload_socket, true);
    bridge!.stop();
    await waitFor(() => !existsSync(sock), 'the socket to be unlinked');
    bridge = undefined;
  });

  it('does not touch the audit key or token: nothing secret in the logs or the audit file', async () => {
    await boot();
    const p = path.join(out, 'x.png');
    writeFileSync(p, png(5));
    await ask(sock, req(p));
    gcs.uploadStatus = 500;
    writeFileSync(path.join(out, 'y.png'), png(6));
    await ask(sock, req(path.join(out, 'y.png')));
    const everything = [...logs, readFileSync(auditFile(), 'utf8')].join('\n');
    for (const secret of [KEY_BODY, 'SENTINEL-KEY-ID', TOKEN_SENTINEL, 'SECRET-DETAIL']) assert.ok(!everything.includes(secret), `${secret} leaked`);
  });

  it('creates no socket when the bot has no media block', async () => {
    await boot({ media: null });
    assert.equal(existsSync(sock), false);
    assert.equal(bridge!.uploadSocket, undefined);
  });

  it('creates no socket when media is enabled but has no uploadSocket', async () => {
    await boot({ media: { uploadSocket: undefined } });
    assert.equal(existsSync(sock), false);
    assert.equal(bridge!.uploadSocket, undefined);
    assert.equal(audit().find((r) => r.event === 'config.loaded')?.upload_socket, undefined);
  });

  it('creates no socket when the block has an uploadSocket but is not enabled', async () => {
    await boot({ media: { enabled: false } });
    assert.equal(existsSync(sock), false);
    assert.equal(bridge!.uploadSocket, undefined);
  });

  it('creates no socket, and says so, when the credential does not load; the bridge still runs', async () => {
    await boot({ env: { MEDIA_PROJ: 'proj-1' } });
    assert.equal(existsSync(sock), false);
    assert.equal(bridge!.isRunning(), true);
    assert.ok(logs.some((l) => l.includes('media is OFF') && l.includes('MEDIA_SA') && l.includes('upload socket is not created')), logs.join('\n'));
  });

  it('keeps running, with the socket off and one error line, when the socket cannot be created', async () => {
    await boot({ media: { uploadSocket: { path: sock, sourceDir: out, group: 'missing-group' } } });
    assert.equal(bridge!.isRunning(), true);
    assert.equal(existsSync(sock), false);
    assert.ok(logs.some((l) => l.includes('upload socket is OFF') && l.includes("group 'missing-group' does not exist")), logs.join('\n'));
    assert.equal(audit().find((r) => r.event === 'media.upload_socket')?.outcome, 'failed');
  });

  it('two bridges on one socket path: the second one stays off and the first keeps its socket', async () => {
    await boot();
    const second = new UploadSocket({ ...bridge!.uploadSocket!['opts'] });
    const res = await second.start();
    assert.equal(res.ok, false);
    const p = path.join(out, 'x.png');
    writeFileSync(p, png(5));
    assert.equal((await ask(sock, req(p))).reply?.ok, true);
  });
});
