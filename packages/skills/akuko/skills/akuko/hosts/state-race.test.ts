// akuko — two processes on one project folder (host B / C): the spend gate's
// lock is per process, so `LocalHost.writeState` refuses to write over a
// change it has not read (compare-and-swap under a lock file) and the gate
// retries from a fresh read. An overrun becomes a refusal; no ledger entry is
// lost (Wave 3 second-opinion review, finding 1).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PendingSpend } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { tinyProject } from '../providers/__fixtures__/fake-host.ts';
import { FAKE_PAID_ID, FAKE_PRICE } from '../spend/__fixtures__/fake-paid.ts';
import { ledgerSummary } from '../spend/ledger.ts';
import { LocalHost, PROJECT_FILE, StateConflictError, serializeProject } from './local.ts';

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

function project(cap: number, pending: PendingSpend[]): string {
  const dir = tmpDir('akuko-race-');
  writeFileSync(join(dir, PROJECT_FILE), serializeProject(tinyProject({ budget: { cap, currency: 'USD', spent: 0 }, pending_spend: pending })));
  return dir;
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
    const lock = join(dir, `${PROJECT_FILE}.lock`);
    writeFileSync(lock, 'pid 1 (crashed)');
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(lock, old, old);
    const a = new LocalHost({ projectDir: dir });
    const p = await a.readState();
    await a.writeState({ ...p, project: { ...p.project, title: 'after the crash' } });
    assert.equal((await a.readState()).project.title, 'after the crash');
    assert.equal(existsSync(lock), false);
  });
});
