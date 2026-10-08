import { describe, it, beforeEach, afterEach, after } from 'node:test';
import { sweepTmp, tmpDir } from './test-tmp.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AuditLog,
  AuditMirror,
  AuditUnavailableError,
  auditFiles,
  parseSince,
  readAudit,
  resolveAuditConfig,
  summarize,
  verifyAudit,
} from './audit.js';
import type { AuditRecord } from './audit.js';
import { runAuditCli } from './audit-cli.js';

let dir: string;
let file: string;
const clock = { t: Date.UTC(2026, 9, 8, 12, 0, 0) };

beforeEach(() => {
  dir = tmpDir('mm-b5-audit-');
  file = path.join(dir, 'sub', 'audit-rex.jsonl');
  clock.t = Date.UTC(2026, 9, 8, 12, 0, 0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = (over: Partial<ConstructorParameters<typeof AuditLog>[0]> = {}) =>
  new AuditLog({ file, bot: 'rex', now: () => clock.t, log: () => undefined, ...over });
const lines = () => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const recs = () => lines().map((l) => JSON.parse(l) as AuditRecord);

describe('AuditLog: what is written', () => {
  it('one JSON line per record, file 0600 in a 0700 directory, core fields first, undefined dropped', () => {
    const a = mk();
    assert.equal(a.record('run.started', { run_id: 'r1', mode: 'plan', nothing: undefined, none: null }), true);
    const [r] = recs();
    assert.equal(r?.v, 1);
    assert.equal(r?.bot, 'rex');
    assert.equal(r?.event, 'run.started');
    assert.equal(r?.ts, '2026-10-08T12:00:00.000Z');
    assert.equal(r?.run_id, 'r1');
    assert.equal('nothing' in (r ?? {}), false);
    assert.equal(r?.none, null);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  });

  it('fields cannot overwrite the core fields', () => {
    mk().record('x.y', { event: 'forged', bot: 'ruby', prev: 'abc', ts: 'never', v: 99 } as never);
    const [r] = recs();
    assert.equal(r?.event, 'x.y');
    assert.equal(r?.bot, 'rex');
    assert.equal(r?.v, 1);
    assert.match(r?.prev ?? '', /^0{64}$/);
  });

  it('redacts every string value, truncates long ones, and caps arrays', () => {
    const a = mk({ redact: (s) => s.split('hunter2-secret').join('[redacted]') });
    a.record('e', { a: 'x hunter2-secret y', long: 'z'.repeat(5000), list: Array.from({ length: 80 }, (_, i) => `n${i}-hunter2-secret`) });
    const [r] = recs();
    assert.equal(r?.a, 'x [redacted] y');
    assert.equal((r?.long as string).length, 300);
    assert.equal((r?.list as string[]).length, 50);
    assert.ok(!lines().join('\n').includes('hunter2-secret'));
  });
});

describe('AuditLog: append-only and restart-safe', () => {
  it('only ever appends: earlier lines are byte-identical after later records, and a new instance continues the chain', () => {
    const a = mk();
    a.record('one', { n: 1 });
    a.record('two', { n: 2 });
    const before = lines();
    clock.t += 1000;
    const b = mk(); // a bridge restart
    b.record('three', { n: 3 });
    const after = lines();
    assert.deepEqual(after.slice(0, 2), before);
    assert.equal(after.length, 3);
    assert.deepEqual(verifyAudit(file), { ok: true, records: 3 });
  });

  it('a torn last line (crash mid-write) is never rewritten; the next writer seals it with an audit.recovered record', () => {
    mk().record('one', {});
    const torn = '{"v":1,"ts":"2026-10-08T12:00:00.000Z","bot":"rex","event":"half';
    appendFileSync(file, torn);
    mk().record('two', {});
    const all = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(all.length, 4, 'one, the torn line, the recovery record, two');
    assert.equal(all[1], torn, 'the torn bytes are kept as evidence, not dropped or repaired');
    const rec = JSON.parse(all[2] as string) as AuditRecord;
    assert.equal(rec.event, 'audit.recovered');
    assert.equal(rec.torn_sha, createHash('sha256').update(torn).digest('hex'), 'carries the torn line hash');
    assert.equal(rec.prev, rec.torn_sha);
    assert.equal(rec.torn_bytes, Buffer.byteLength(torn));
    assert.equal(JSON.parse(all[3] as string).event, 'two');
    assert.equal(readAudit(file).filter((l) => !l.rec).length, 1, 'the torn line is still reported as unreadable by --audit');
  });
});

describe('verifyAudit after a crash', () => {
  const crash = () => {
    mk().record('one', {});
    appendFileSync(file, '{"v":1,"ts":"2026-10-08T12:00:00.000Z","bot":"rex","event":"half');
    mk().record('two', {});
    mk().record('three', {});
  };

  it('reports "recovered after crash at line N" (ok, not tampering), and counts only real records', () => {
    crash();
    const v = verifyAudit(file);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.records, 4, 'one, recovered, two, three');
    assert.deepEqual(v.recovered?.map((r) => r.line), [2]);
  });

  it('the --verify CLI says it was a crash, with the line, and exits 0', () => {
    crash();
    writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ dataDir: path.join(dir, 'sub'), bots: { rex: {} } }));
    const out: string[] = [];
    const code = runAuditCli(path.join(dir, 'bridge.json'), { bot: 'rex', verify: true }, { out: (l) => out.push(l), err: () => undefined });
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /chain ok, 4 records.*recovered after crash at .*audit-rex\.jsonl:2/);
    assert.match(out[0] ?? '', /not tampering/);
  });

  it('a crash is not a licence: an edited line, or garbage that no recovery record names, still fails', () => {
    crash();
    const l = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // edit a real record after the crash point
    const edited = [...l];
    edited[3] = (edited[3] as string).replace('"event":"two"', '"event":"TWO"');
    writeFileSync(file, `${edited.join('\n')}\n`);
    assert.equal(verifyAudit(file).ok, false);
    // garbage line in the middle whose hash the recovery record does not carry
    const garbled = [...l];
    garbled[1] = '{"v":1,"event":"something else entirely';
    writeFileSync(file, `${garbled.join('\n')}\n`);
    const v = verifyAudit(file);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt?.line, 2);
    // a torn line with no recovery record after it (still the live tail, nobody has written yet)
    writeFileSync(file, `${l[0]}\n${l[1]}\n`);
    assert.equal(verifyAudit(file).ok, false, 'a torn tail nobody has sealed yet is reported, not waved through');
  });

  it('a second crash gets its own recovery record', () => {
    crash();
    appendFileSync(file, '{"v":1,"half-again');
    mk().record('four', {});
    const v = verifyAudit(file);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.recovered?.length, 2);
  });

  it('a crash right at a size rotation: the torn line is sealed in the file it is in, and the chain holds across the rotation', () => {
    const a = mk({ maxBytes: 1024 });
    for (let i = 0; i < 6; i++) a.record('tick', { i, pad: 'p'.repeat(100) });
    appendFileSync(file, '{"v":1,"torn-before-rotation');
    const b = mk({ maxBytes: 1024 });
    for (let i = 0; i < 12; i++) b.record('tick', { i, pad: 'p'.repeat(100) });
    const v = verifyAudit(file);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.recovered?.length, 1);
  });
});

describe('AuditLog: two writers', () => {
  const CHILD = `
    const { AuditLog } = await import(process.env.AUDIT_MODULE);
    const a = new AuditLog({ file: process.env.AUDIT_FILE, bot: 'rex', log: () => undefined });
    const go = Number(process.env.START_AT);
    while (Date.now() < go) { /* start together */ }
    for (let i = 0; i < Number(process.env.N); i++) a.record('tick', { who: process.env.WHO, i });
  `;
  const child = (who: string, startAt: number, n: number) =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', CHILD], {
        env: { ...process.env, AUDIT_MODULE: pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), 'audit.ts')).href, AUDIT_FILE: file, WHO: who, START_AT: String(startAt), N: String(n) },
      });
      let err = '';
      c.stderr.on('data', (d) => (err += d));
      c.on('close', (code) => resolve({ code, err }));
    });

  it('two processes appending to one file at once keep one unbroken chain (the service and --run-schedule)', async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const N = 300;
    const startAt = Date.now() + 2500; // both children are up and spinning before this
    const [a, b] = await Promise.all([child('a', startAt, N), child('b', startAt, N)]);
    assert.deepEqual([a.code, b.code], [0, 0], a.err + b.err);
    const v = verifyAudit(file);
    assert.equal(v.ok, true, `chain broken: ${JSON.stringify(v)}`);
    assert.equal(v.records, 2 * N);
    const all = recs();
    for (const who of ['a', 'b']) assert.deepEqual(all.filter((r) => r.who === who).map((r) => r.i), Array.from({ length: N }, (_, i) => i), `${who} in order, none lost`);
    assert.equal(existsSync(`${file}.lock`), false, 'no lock left behind');
  });

  it('a lock left by a process that died is taken over, and the record is written', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, `2147483646:dead-writer`); // no such pid
    const logs: string[] = [];
    assert.equal(mk({ log: (m) => logs.push(m) }).record('x', {}), true);
    assert.equal(recs().length, 1);
    assert.ok(logs.some((l) => /stale audit lock/.test(l)));
    assert.equal(existsSync(`${file}.lock`), false);
  });

  it('a live writer holding the lock makes must() fail closed after the timeout, and record() return false; nothing is written', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, `${process.pid}:somebody-else`); // alive, fresh
    const a = mk({ lockTimeoutMs: 60 });
    assert.throws(() => a.must('x', {}), (e: unknown) => e instanceof AuditUnavailableError && e.reason === 'lock-timeout');
    assert.equal(a.record('x', {}), false);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(`${file}.lock`, 'utf8'), `${process.pid}:somebody-else`, 'a lock that is not ours is never removed');
  });

  it('a lock held for longer than the stale window is taken over even if its pid is alive', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, `${process.pid}:wedged`);
    assert.equal(mk({ lockStaleMs: 0 }).record('x', {}), true);
    assert.equal(recs().length, 1);
  });
});

describe('AuditLog: rotation', () => {
  it('rotates by size, keeps the chain unbroken across files, keeps 0600, and prunes beyond `keep`', () => {
    const a = mk({ maxBytes: 1024, keep: 2 });
    for (let i = 0; i < 40; i++) a.record('tick', { i, pad: 'p'.repeat(60) });
    const names = readdirSync(path.dirname(file)).sort();
    assert.deepEqual(names, ['audit-rex.jsonl', 'audit-rex.jsonl.1', 'audit-rex.jsonl.2']);
    for (const n of names) assert.equal(statSync(path.join(path.dirname(file), n)).mode & 0o777, 0o600);
    assert.ok(statSync(file).size <= 1024);
    assert.deepEqual(auditFiles(file).map((f) => path.basename(f)), ['audit-rex.jsonl.2', 'audit-rex.jsonl.1', 'audit-rex.jsonl']);
    const v = verifyAudit(file);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.ok(v.records > 10 && v.records < 40, 'older files were pruned');
    // the retained history is a contiguous suffix
    const idx = readAudit(file).map((l) => l.rec?.i as number);
    assert.deepEqual(idx, Array.from({ length: idx.length }, (_, k) => 40 - idx.length + k));
  });

  it('the first record after a rotation chains onto the last record of the rotated file', () => {
    const a = mk({ maxBytes: 1024 });
    let i = 0;
    while (!existsSync(`${file}.1`) && i < 200) a.record('tick', { i: i++, pad: 'p'.repeat(100) });
    assert.ok(existsSync(`${file}.1`), 'the log rotated');
    const rotated = readFileSync(`${file}.1`, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines()[0] as string) as AuditRecord;
    assert.equal(first.prev, createHash('sha256').update(rotated[rotated.length - 1] as string).digest('hex'));
  });
});

describe('verifyAudit', () => {
  const seed = () => {
    const a = mk();
    for (let i = 0; i < 5; i++) a.record('e', { i });
  };

  it('is ok on an untouched log', () => {
    seed();
    assert.deepEqual(verifyAudit(file), { ok: true, records: 5 });
  });

  it('detects an edited line (the NEXT line no longer matches it)', () => {
    seed();
    const l = lines();
    l[2] = (l[2] as string).replace('"i":2', '"i":99');
    writeFileSync(file, `${l.join('\n')}\n`);
    const v = verifyAudit(file);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt?.line, 4);
  });

  it('detects a deleted line and a reordered pair', () => {
    seed();
    const l = lines();
    writeFileSync(file, `${[l[0], l[1], l[3], l[4]].join('\n')}\n`);
    assert.equal(verifyAudit(file).ok, false);
    writeFileSync(file, `${[l[0], l[2], l[1], l[3], l[4]].join('\n')}\n`);
    assert.equal(verifyAudit(file).ok, false);
  });

  it('does NOT detect truncating the tail: that needs an off-box copy (the audit channel) or a separate owner', () => {
    seed();
    const l = lines();
    writeFileSync(file, `${l.slice(0, 3).join('\n')}\n`);
    assert.equal(verifyAudit(file).ok, true);
  });
});

describe('AuditLog: failing to write', () => {
  it('must() throws AuditUnavailableError and record() returns false when the file cannot be written', () => {
    mkdirSync(file, { recursive: true }); // a directory where the log should be
    const a = mk();
    assert.equal(a.record('x', {}), false);
    assert.throws(() => a.must('x', {}), (e: unknown) => e instanceof AuditUnavailableError && /audit log unavailable/.test((e as Error).message));
  });

  it('the error and the log line name a code, never a path or a value', () => {
    mkdirSync(file, { recursive: true });
    const logs: string[] = [];
    const a = mk({ log: (m) => logs.push(m) });
    try {
      a.must('x', { secret: 'tok-123' });
    } catch (e) {
      assert.ok(!(e as Error).message.includes(dir));
      assert.ok(!(e as Error).message.includes('tok-123'));
    }
    assert.ok(logs.every((l) => !l.includes('tok-123')));
  });
});

describe('AuditLog: coalesced denials', () => {
  it('records the first, suppresses repeats within the window, then says how many were left out', () => {
    const a = mk();
    assert.equal(a.recordCoalesced('k', 'gate.denied', { u: 'x' }, 60_000), true);
    for (let i = 0; i < 3; i++) assert.equal(a.recordCoalesced('k', 'gate.denied', { u: 'x' }, 60_000), false);
    assert.equal(a.recordCoalesced('other', 'gate.denied', { u: 'y' }, 60_000), true, 'a different key is its own');
    clock.t += 61_000;
    assert.equal(a.recordCoalesced('k', 'gate.denied', { u: 'x' }, 60_000), true);
    const r = recs();
    assert.equal(r.length, 3);
    assert.equal(r[0]?.suppressed, undefined);
    assert.equal(r[2]?.suppressed, 3);
  });
});

describe('parseSince / resolveAuditConfig', () => {
  it('parses relative and absolute times and refuses nonsense', () => {
    const now = Date.UTC(2026, 9, 8, 12);
    assert.equal(parseSince('30m', now), now - 30 * 60_000);
    assert.equal(parseSince('2h', now), now - 2 * 3_600_000);
    assert.equal(parseSince('7d', now), now - 7 * 86_400_000);
    assert.equal(parseSince('2026-10-01T00:00:00Z', now), Date.UTC(2026, 9, 1));
    assert.throws(() => parseSince('yesterday-ish', now), /--since/);
  });

  it('validates the audit block, names the bot, and keeps the audit channel write-only', () => {
    assert.deepEqual(resolveAuditConfig(undefined, "bot 'rex'", []), { promptHash: false, maxBytes: 10 * 1024 * 1024, keep: 10 });
    assert.equal(resolveAuditConfig({ channel: '#rex-audit' }, "bot 'rex'", ['eng']).channel, 'rex-audit');
    assert.throws(() => resolveAuditConfig({ channel: 'eng' }, "bot 'rex'", ['#eng']), /bot 'rex': audit.channel 'eng' is also in allowedChannels/);
    assert.throws(() => resolveAuditConfig({ enabled: false }, "bot 'rex'", []), /cannot be switched off/);
    assert.throws(() => resolveAuditConfig({ maxBytes: 10 }, "bot 'rex'", []), /maxBytes/);
    assert.throws(() => resolveAuditConfig({ keep: 0 }, "bot 'rex'", []), /keep/);
    assert.throws(() => resolveAuditConfig({ path: 'relative.jsonl' }, "bot 'rex'", []), /absolute/);
    assert.throws(() => resolveAuditConfig({ promptHash: 'yes' }, "bot 'rex'", []), /promptHash/);
  });
});

describe('mirror', () => {
  it('summarize is one line of key=value with no whitespace in values', () => {
    const rec = { v: 1, ts: 't', bot: 'rex', event: 'run.started', prev: 'p', run_id: 'r1', user_name: 'a b', list: ['x', 'y'], nothing: null } as AuditRecord;
    assert.equal(summarize(rec), '`rex run.started run_id=r1 user_name=a_b list=x,y`');
  });

  it('posts in order, survives a failing post, and is wired to the log through setSink', async () => {
    const posted: string[] = [];
    let fail = true;
    const m = new AuditMirror(async (t) => {
      if (fail) {
        fail = false;
        throw new Error('mattermost down');
      }
      posted.push(t);
    }, () => undefined);
    const a = mk();
    a.setSink((r) => m.push(r));
    a.record('one', {});
    a.record('two', {});
    a.record('three', {});
    await m.flushed();
    assert.deepEqual(posted.map((p) => p.split(' ')[1]?.replace('`', '')), ['two', 'three']);
    assert.equal(recs().length, 3, 'a mirror failure never costs a record');
  });
});

describe('--audit CLI function', () => {
  let cfgPath: string;
  const run = (args: Parameters<typeof runAuditCli>[1], cfg: object | null = { dataDir: path.join(dir, 'sub'), bots: { rex: {} } }) => {
    if (cfg) writeFileSync((cfgPath = path.join(dir, 'bridge.json')), JSON.stringify(cfg));
    const out: string[] = [];
    const err: string[] = [];
    const code = runAuditCli(cfg ? cfgPath : undefined, args, { out: (l) => out.push(l), err: (l) => err.push(l), now: () => clock.t });
    return { code, out, err };
  };

  it('prints every retained record oldest first, honours --since, and needs the config', () => {
    const a = mk();
    a.record('old', {});
    clock.t += 3 * 3_600_000;
    a.record('new', {});
    assert.deepEqual(run({ bot: 'rex', verify: false }).out.map((l) => JSON.parse(l).event), ['old', 'new']);
    assert.deepEqual(run({ bot: 'rex', since: '1h', verify: false }).out.map((l) => JSON.parse(l).event), ['new']);
    assert.equal(run({ bot: 'rex', verify: false }, null).code, 2);
  });

  it('exits 2 for an unknown bot or a bad --since, and 1 with --verify on a broken chain', () => {
    mk().record('a', {});
    mk().record('b', {});
    mk().record('c', {});
    assert.equal(run({ bot: 'nobody', verify: false }).code, 2);
    assert.equal(run({ bot: 'rex', since: 'whenever', verify: false }).code, 2);
    const ok = run({ bot: 'rex', verify: true });
    assert.equal(ok.code, 0);
    assert.match(ok.out[0] ?? '', /rex: chain ok, 3 records in 1 file/);
    const l = lines();
    l[0] = (l[0] as string).replace('"event":"a"', '"event":"A"');
    writeFileSync(file, `${l.join('\n')}\n`);
    const bad = run({ bot: 'rex', verify: true });
    assert.equal(bad.code, 1);
    assert.match(bad.out[0] ?? '', /chain BROKEN at .*audit-rex\.jsonl:2/);
  });

  it('says so, and exits 0, when no log exists yet', () => {
    const r = run({ bot: 'rex', verify: false }, { dataDir: path.join(dir, 'nothing-here'), bots: { rex: {} } });
    assert.equal(r.code, 0);
    assert.match(r.err[0] ?? '', /no audit records/);
  });
});

// Remove every temp directory the file made, including ones a stopped bridge wrote into again.
after(() => sweepTmp());
