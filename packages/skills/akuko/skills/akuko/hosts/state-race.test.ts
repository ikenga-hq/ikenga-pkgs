// akuko — two processes on one project folder (host B / C): the spend gate's
// lock is per process, so `LocalHost.writeState` refuses to write over a
// change it has not read (compare-and-swap under a lock file) and the gate
// retries from a fresh read. An overrun becomes a refusal; no ledger entry is
// lost (Wave 3 second-opinion review, finding 1), including when the
// processes start by taking over a stale lock (review of #199, C1).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PendingSpend } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { tinyProject } from '../providers/__fixtures__/fake-host.ts';
import { FAKE_PAID_ID, FAKE_PRICE } from '../spend/__fixtures__/fake-paid.ts';
import { ledgerSummary } from '../spend/ledger.ts';
import { LocalHost, PROJECT_FILE, StateConflictError, serializeProject, withFileLock } from './local.ts';

const WORKER = fileURLToPath(new URL('./__fixtures__/race-worker.ts', import.meta.url));
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const tmpDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmp.push(d); return d; };

const approved = (id: string, unit: string): PendingSpend => ({
  id,
  stage: 'keyframes',
  label: `Key frame ${unit}`,
  units: [unit],
  provider: FAKE_PAID_ID,
  kind: 'image',
  estimate: FAKE_PRICE,
  status: 'approved',
});

const UNITS = ['sc1_sh1', 'sc1_sh2', 'sc1_sh3'];
function project(cap: number, pending: PendingSpend[]): string {
  const dir = tmpDir('akuko-race-');
  const shots = UNITS.map((id) => ({ id, stage: 'sketch' as const, status: 'approved' as const, scene: 'sc1', prompt: `shot ${id}` }));
  writeFileSync(join(dir, PROJECT_FILE), serializeProject(tinyProject({ budget: { cap, currency: 'USD', spent: 0 }, pending_spend: pending, shots })));
  return dir;
}

/** A lock file left by a process that died a minute ago. */
function staleLock(dir: string, content = 'pid 1 (crashed)'): string {
  const lock = join(dir, `${PROJECT_FILE}.lock`);
  writeFileSync(lock, content);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  return lock;
}

interface WorkerOut { job: string; status: string; code?: string; providerCalls?: number; error?: string }

function worker(dir: string, job: string, unit: string, barrier: string, n: number): Promise<WorkerOut> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', WORKER, dir, job, unit, barrier, String(n)], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      try { resolve(JSON.parse(stdout.trim()) as WorkerOut); } catch { reject(new Error(`worker printed no JSON: ${stdout}\n${stderr}`)); }
    });
  });
}

async function race(dir: string, jobs: [string, string][]): Promise<WorkerOut[]> {
  const barrier = join(dir, 'barrier');
  mkdirSync(barrier);
  return Promise.all(jobs.map(([job, unit]) => worker(dir, job, unit, barrier, jobs.length)));
}

describe('two akuko processes on one project folder', { timeout: 120_000 }, () => {
  it('two jobs that each fit but together overrun the cap: one runs, the other is refused over-cap, and the reservation of the one that ran is not clobbered', async () => {
    // cap 0.08: either 0.05 job fits on its own, the two together do not.
    const dir = project(0.08, [approved('job_a', 'sc1_sh1'), approved('job_b', 'sc1_sh2')]);
    const out = await race(dir, [['job_a', 'sc1_sh1'], ['job_b', 'sc1_sh2']]);
    const ran = out.filter((o) => o.status === 'submitted');
    const refused = out.filter((o) => o.status === 'refused');
    assert.equal(ran.length, 1, JSON.stringify(out));
    assert.equal(refused.length, 1, JSON.stringify(out));
    assert.equal(refused[0]!.code, 'over-cap');
    assert.equal(refused[0]!.providerCalls, 0, 'the refused job never reached the provider');

    const p = new LocalHost({ projectDir: dir });
    const state = await p.readState();
    assert.deepEqual(state.ledger.map((e) => e.job), [ran[0]!.job], 'the winner\'s reservation is on disk, not clobbered');
    const s = ledgerSummary(state);
    assert.ok(s.spent + s.sunk + s.reserved <= 0.08 + 1e-9, `committed ${s.reserved} is within the cap`);
    assert.deepEqual(checkIntegrity(state), []);
  });

  it('the same job in two processes runs once: the other sees the reservation and is refused already-submitted', async () => {
    const dir = project(10, [approved('job_a', 'sc1_sh1')]);
    const out = await race(dir, [['job_a', 'sc1_sh1'], ['job_a', 'sc1_sh1']]);
    assert.deepEqual(out.map((o) => o.status).sort(), ['refused', 'submitted'], JSON.stringify(out));
    assert.equal(out.find((o) => o.status === 'refused')!.code, 'already-submitted');
    const state = await new LocalHost({ projectDir: dir }).readState();
    assert.equal(state.ledger.length, 1);
  });
});

describe('three processes that all start by taking over a stale lock (review of #199, C1)', { timeout: 280_000 }, () => {
  it('never two holders: in every trial one job runs, the others are refused over-cap, and its reservation is on disk', async () => {
    const TRIALS = 12;
    const bad: string[] = [];
    for (let t = 0; t < TRIALS; t++) {
      // cap 0.08: any one 0.05 job fits, two do not. Every worker reads, waits for the others, then all
      // reach writeState together and find the same stale lock.
      const dir = project(0.08, UNITS.map((u, i) => approved(`job_${i}`, u)));
      staleLock(dir);
      const out = await race(dir, UNITS.map((u, i) => [`job_${i}`, u]));
      const state = await new LocalHost({ projectDir: dir }).readState();
      const ran = out.filter((o) => o.status === 'submitted').map((o) => o.job);
      const s = ledgerSummary(state);
      const ok = ran.length === 1
        && out.filter((o) => o.status === 'refused' && o.code === 'over-cap' && o.providerCalls === 0).length === 2
        && JSON.stringify(state.ledger.map((e) => e.job)) === JSON.stringify(ran)
        && s.reserved <= 0.08 + 1e-9
        && !existsSync(join(dir, `${PROJECT_FILE}.lock`)) && !existsSync(join(dir, `${PROJECT_FILE}.lock.takeover`));
      if (!ok) bad.push(`trial ${t}: ${JSON.stringify(out)} ledger=${JSON.stringify(state.ledger.map((e) => e.job))}`);
    }
    assert.deepEqual(bad, [], `${bad.length}/${TRIALS} trials overran the cap or lost a reservation`);
  });
});

describe('withFileLock', () => {
  it('many holders in one process, all starting at a stale lock: never two inside at once', async () => {
    const dir = tmpDir('akuko-lock-');
    const path = join(dir, PROJECT_FILE);
    staleLock(dir);
    let inside = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 8 }, () => withFileLock(path, async () => {
      inside++;
      most = Math.max(most, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
    })));
    assert.equal(most, 1);
    assert.equal(existsSync(`${path}.lock`), false);
  });

  it('a holder whose lock was taken over never removes the new holder\'s lock, and knows it lost it', async () => {
    const dir = tmpDir('akuko-lock-');
    const path = join(dir, PROJECT_FILE);
    const lock = `${path}.lock`;
    let lost: boolean | undefined;
    await withFileLock(path, async (held) => {
      writeFileSync(lock, 'someone else'); // as if a successor had taken it over
      lost = !(await held.stillHeld());
    });
    assert.equal(lost, true);
    assert.equal(readFileSync(lock, 'utf8'), 'someone else', 'the new holder\'s lock is left alone');
  });

  it('a stale lock behind a fresh takeover guard waits with sleeps, not a busy loop, and succeeds once the guard goes stale', async () => {
    const dir = tmpDir('akuko-guard-');
    const path = join(dir, PROJECT_FILE);
    const lock = staleLock(dir);
    const guard = `${lock}.takeover`;
    writeFileSync(guard, 'pid 2 (crashed taker)'); // fresh: the takeover step can't proceed yet
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      if (sleeps.length === 3) { const old = new Date(Date.now() - 60_000); utimesSync(guard, old, old); }
      await new Promise((r) => setTimeout(r, 1));
    };
    const t0 = Date.now();
    const ran = await withFileLock(path, async () => 'ok', { waitMs: 1500, staleMs: 1000, sleep });
    assert.equal(ran, 'ok');
    // Three sleeps while the guard was fresh, then the guard went stale and was cleared; a busy loop makes none.
    assert.ok(sleeps.length >= 3 && sleeps.length <= 8, `slept ${sleeps.length} times: ${sleeps.join(',')}`);
    assert.ok(Date.now() - t0 < 1500, 'did not run into the wait deadline');
    assert.equal(existsSync(lock), false, 'lock released');
    assert.equal(existsSync(guard), false, 'guard cleared');
  });

  it('a fresh takeover guard that never clears ends in the "locked by another process" error at the deadline, with sleeps in between', async () => {
    const dir = tmpDir('akuko-guard2-');
    const lock = staleLock(dir);
    writeFileSync(`${lock}.takeover`, 'pid 2 (alive)');
    let sleeps = 0;
    await assert.rejects(
      withFileLock(join(dir, PROJECT_FILE), async () => 'x', { waitMs: 150, staleMs: 30_000, sleep: async () => { sleeps++; await new Promise((r) => setTimeout(r, 10)); } }),
      /locked by another akuko process/,
    );
    assert.ok(sleeps > 0 && sleeps < 100, `slept ${sleeps} times`);
  });

  it('a lock it cannot create for lack of permission is reported as that, not as "locked by another process"', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs a POSIX non-root user' }, async () => {
    const dir = tmpDir('akuko-lock-');
    chmodSync(dir, 0o555);
    try {
      await assert.rejects(withFileLock(join(dir, PROJECT_FILE), async () => undefined), /cannot create .*\.lock \((EACCES|EPERM)\): akuko is not allowed to write/);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('LocalHost.readState hashes the bytes it read (review of #199, C2)', () => {
  it('UTF-8 with non-ASCII text, and with a BOM, reads and writes back without a false conflict', async () => {
    for (const bom of ['', '\ufeff']) {
      const dir = project(10, []);
      const file = join(dir, PROJECT_FILE);
      const p = JSON.parse(readFileSync(file, 'utf8'));
      p.project.title = 'Café — 夜';
      writeFileSync(file, bom + JSON.stringify(p, null, 2));
      const host = new LocalHost({ projectDir: dir });
      const got = await host.readState();
      assert.equal(got.project.title, 'Café — 夜');
      await host.writeState({ ...got, project: { ...got.project, notes: 'written' } });
      assert.equal((await host.readState()).project.notes, 'written');
    }
  });

  it('a Windows-1252 akuko.json is refused with a clear error, not locked out: re-saved as UTF-8 it works again', async () => {
    const dir = project(10, []);
    const file = join(dir, PROJECT_FILE);
    const text = readFileSync(file, 'utf8').replace('"title": "Tiny"', '"title": "Caf\u00e9"');
    writeFileSync(file, Buffer.from(text, 'latin1')); // é as the single byte 0xE9
    const host = new LocalHost({ projectDir: dir });
    await assert.rejects(host.readState(), /is not valid UTF-8.*Re-save it as UTF-8/);
    writeFileSync(file, text, 'utf8');
    const p = await host.readState();
    assert.equal(p.project.title, 'Café');
    await host.writeState({ ...p, project: { ...p.project, notes: 'ok' } });
    assert.equal((await host.readState()).project.notes, 'ok');
  });
});

describe('LocalHost.writeState compare-and-swap', () => {
  it('refuses to write over a change made since this host read, and leaves the file as the other writer left it', async () => {
    const dir = project(10, []);
    const a = new LocalHost({ projectDir: dir });
    const b = new LocalHost({ projectDir: dir });
    const pa = await a.readState();
    const pb = await b.readState();
    await b.writeState({ ...pb, project: { ...pb.project, title: 'B wrote this' } });
    await assert.rejects(a.writeState({ ...pa, project: { ...pa.project, title: 'A, stale' } }), (e: unknown) => e instanceof StateConflictError && /changed on disk/.test(e.message));
    assert.equal((await b.readState()).project.title, 'B wrote this');
    // After a fresh read it writes.
    const again = await a.readState();
    await a.writeState({ ...again, project: { ...again.project, title: 'A, fresh' } });
    assert.equal((await b.readState()).project.title, 'A, fresh');
    assert.equal(existsSync(join(dir, `${PROJECT_FILE}.lock`)), false, 'the lock file is released');
  });

  it('a host that wrote last can write again without re-reading; a host that never read writes as before', async () => {
    const dir = project(10, []);
    const a = new LocalHost({ projectDir: dir });
    const p = await a.readState();
    await a.writeState({ ...p, project: { ...p.project, title: 'one' } });
    await a.writeState({ ...p, project: { ...p.project, title: 'two' } });
    const fresh = new LocalHost({ projectDir: dir });
    await fresh.writeState({ ...p, project: { ...p.project, title: 'three' } });
    assert.equal(JSON.parse(readFileSync(join(dir, PROJECT_FILE), 'utf8')).project.title, 'three');
  });

  it('a lock file left by a crashed process is taken over once it is stale', async () => {
    const dir = project(10, []);
    const lock = staleLock(dir);
    const a = new LocalHost({ projectDir: dir });
    const p = await a.readState();
    await a.writeState({ ...p, project: { ...p.project, title: 'after the crash' } });
    assert.equal((await a.readState()).project.title, 'after the crash');
    assert.equal(existsSync(lock), false);
  });
});
