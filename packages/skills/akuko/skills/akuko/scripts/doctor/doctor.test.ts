// akuko — doctor (WP-08): orphan reservations, provider config drift, the node half, and doctor.sh exit codes.
//
//   pnpm --filter @ikenga/skill-akuko test

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { AkukoProject } from '../../schema/akuko-project.ts';
import { parseProviderConfig, type AkukoProviderConfig } from '../../providers/config.ts';
import { tinyProject } from '../../providers/__fixtures__/fake-host.ts';
import { run } from './cli.ts';
import { checkProject, orphanReservations, type Finding } from './project-checks.ts';

const NOW = '2026-11-07T12:00:00Z';

const model = (last_verified: string) => ({ price: { amount: 0.04, per: 'image' as const }, last_verified, source: 'test' });
const config = (over: Record<string, unknown> = {}): AkukoProviderConfig =>
  parseProviderConfig({
    format: 'akuko-provider-config',
    version: 1,
    currency: 'USD',
    stale_after_days: 30,
    providers: {
      manual: { label: 'Manual', billing: 'free', default_model: 'm', models: { m: { price: { amount: 0, per: 'job' }, last_verified: '2026-11-07', source: 'test' } } },
      'acme-images': { label: 'Acme', billing: 'direct-api', default_model: 'fresh', models: { fresh: model('2026-11-01'), old: model('2026-08-01') } },
      'example-direct': { label: 'EXAMPLE', billing: 'direct-api', example: true, default_model: 'x', models: { x: model('2026-11-07') } },
      ...over,
    },
  });

/** One orphan (submitted long ago, never settled), one stale model (acme-images / old), one healthy in-flight job. */
function fixtureProject(over: Partial<AkukoProject> = {}): AkukoProject {
  return tinyProject({
    budget: { cap: 10, currency: 'USD', spent: 0 },
    pending_spend: [
      { id: 'job_old', stage: 'keyframes', label: 'Old job', units: ['sc1_sh1'], provider: 'acme-images', estimate: 0.04, status: 'approved' },
      { id: 'job_live', stage: 'keyframes', label: 'Live job', units: ['sc1_sh2'], provider: 'acme-images', estimate: 0.04, status: 'approved' },
    ],
    ledger: [
      { id: 'job_old.sc1_sh1.1', ts: '2026-11-07T08:00:00Z', provider: 'acme-images', unit: 'sc1_sh1', job: 'job_old', estimate: 0.04, status: 'submitted' },
      { id: 'job_live.sc1_sh2.1', ts: '2026-11-07T11:50:00Z', provider: 'acme-images', unit: 'sc1_sh2', job: 'job_live', estimate: 0.04, status: 'submitted' },
    ],
    ...over,
  });
}

const codes = (fs: Finding[]) => fs.map((f) => f.code);

describe('orphan submitted reservations', () => {
  it('lists a submitted entry older than the limit, not one still in flight', () => {
    const orphans = orphanReservations(fixtureProject(), NOW);
    assert.deepEqual(orphans.map((o) => o.entry.id), ['job_old.sc1_sh1.1']);
    assert.match(orphans[0]?.reason ?? '', /240 minutes ago/);
  });

  it('lists a submitted entry with no approved pending spend, however recent', () => {
    const p = fixtureProject({ pending_spend: [] });
    assert.deepEqual(orphanReservations(p, NOW).map((o) => o.entry.id).sort(), ['job_live.sc1_sh2.1', 'job_old.sc1_sh1.1']);
  });

  it('ignores settled entries', () => {
    const p = fixtureProject();
    p.ledger = p.ledger.map((e) => ({ ...e, status: 'done' as const, actual: 0.04 }));
    assert.deepEqual(orphanReservations(p, NOW), []);
  });

  it('the finding says how to clear it, and doctor does not clear it', () => {
    const p = fixtureProject();
    const before = structuredClone(p);
    const f = checkProject(p, config(), { now: NOW }).find((x) => x.code === 'orphan-reservation');
    assert.ok(f);
    assert.match(f.message, /job_old\.sc1_sh1\.1/);
    assert.match(f.message, /0\.04 USD reserved/);
    assert.match(f.fix ?? '', /never clears a reservation on its own/);
    assert.deepEqual(p, before, 'the project is not changed');
  });
});

describe('provider config drift', () => {
  it('flags a model not verified within stale_after_days', () => {
    const f = checkProject(fixtureProject(), config(), { now: NOW }).filter((x) => x.code === 'stale-model');
    assert.equal(f.length, 1);
    assert.match(f[0]?.message ?? '', /acme-images \/ old/);
    assert.match(f[0]?.message ?? '', /2026-08-01/);
  });

  it('notes an example entry that is merely present (info) and warns when the project uses it', () => {
    const quiet = checkProject(fixtureProject(), config(), { now: NOW }).find((x) => x.code === 'example-present');
    assert.equal(quiet?.level, 'info');
    const used = fixtureProject({
      pending_spend: [{ id: 'job_x', stage: 'keyframes', label: 'x', units: ['sc1_sh1'], provider: 'example-direct', estimate: 1, status: 'awaiting-approval' }],
    });
    const f = checkProject(used, config(), { now: NOW }).find((x) => x.code === 'example-in-use');
    assert.equal(f?.level, 'warn');
  });

  it('flags a pending spend whose provider is not in config', () => {
    const p = fixtureProject({
      pending_spend: [{ id: 'job_z', stage: 'keyframes', label: 'z', units: ['sc1_sh1'], provider: 'ghost-provider', estimate: 1, status: 'awaiting-approval' }],
    });
    const f = checkProject(p, config(), { now: NOW }).find((x) => x.code === 'unknown-provider');
    assert.match(f?.message ?? '', /ghost-provider/);
  });

  it('points to setup when there is no cap, and when the currency differs from the config', () => {
    const none = checkProject(fixtureProject({ budget: null }), config(), { now: NOW });
    assert.ok(codes(none).includes('no-budget'));
    assert.match(none.find((x) => x.code === 'no-budget')?.fix ?? '', /\/akuko setup/);
    const gbp = checkProject(fixtureProject({ budget: { cap: 10, currency: 'GBP', spent: 0 } }), config(), { now: NOW });
    assert.ok(codes(gbp).includes('currency-mismatch'));
  });
});

describe('doctor, node half', () => {
  function withProject(p: AkukoProject | string, fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-doctor-'));
    try {
      writeFileSync(join(dir, 'akuko.json'), typeof p === 'string' ? p : JSON.stringify(p));
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('prints the orphan and keeps exit 0 (findings are advice)', () => {
    withProject(fixtureProject(), (dir) => {
      const lines: string[] = [];
      // The committed config is what the CLI reads; --now far in the future makes its dates stale.
      const status = run([dir, '--now', '2027-06-01T00:00:00Z'], (l) => lines.push(l));
      const out = lines.join('\n');
      assert.equal(status, 0);
      assert.match(out, /orphan|still submitted/);
      assert.match(out, /job_old\.sc1_sh1\.1/);
      assert.match(out, /last verified/);
      assert.match(out, /keys \(names only\)|provider keys/);
    });
  });

  it('exit 1 for an akuko.json that is not a valid project, and for broken JSON', () => {
    withProject('{"format":"akuko"}', (dir) => assert.equal(run([dir], () => {}), 1));
    withProject('not json', (dir) => assert.equal(run([dir], () => {}), 1));
  });

  it('exit 0 with no project in the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-doctor-'));
    try {
      const lines: string[] = [];
      assert.equal(run([dir], (l) => lines.push(l)), 0);
      assert.match(lines.join('\n'), /no akuko\.json here/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never prints a key value', () => {
    const secret = 'sk-test-SENTINEL-doctor-0123456789';
    const keep = { ...process.env };
    process.env.ACME_IMAGES_API_KEY = secret;
    process.env.FAL_API_KEY = secret;
    process.env.GEMINI_API_KEY = secret;
    try {
      const lines: string[] = [];
      run([tmpdir()], (l) => lines.push(l));
      assert.equal(lines.join('\n').includes(secret), false);
    } finally {
      for (const k of ['ACME_IMAGES_API_KEY', 'FAL_API_KEY', 'GEMINI_API_KEY']) {
        if (keep[k] === undefined) delete process.env[k];
        else process.env[k] = keep[k];
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// doctor.sh exit codes
// ─────────────────────────────────────────────────────────────────────────

function findBash(): string | null {
  if (process.env.AKUKO_TEST_BASH) return process.env.AKUKO_TEST_BASH;
  if (process.platform !== 'win32') return 'bash';
  // On Windows plain `bash` may be WSL; use Git Bash only.
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) if (existsSync(p)) return p;
  return null;
}

const bash = findBash();
const SCRIPT = fileURLToPath(new URL('../doctor.sh', import.meta.url));

function doctorSh(env: Record<string, string>, projectDir: string) {
  assert.ok(bash);
  const r = spawnSync(bash, [SCRIPT.replaceAll('\\', '/'), projectDir.replaceAll('\\', '/')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('doctor.sh', { skip: bash === null ? 'no bash available' : false }, () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'akuko-doctor-sh-'));
  after(() => rmSync(emptyDir, { recursive: true, force: true }));
  const allOptionalMissing = { AKUKO_DOCTOR_HIDE: 'ffmpeg,hyperframes,browser,browser_path', HYPERFRAMES_BROWSER_PATH: '' };

  it('exits 0 when only optional dependencies are missing', () => {
    const r = doctorSh(allOptionalMissing, emptyDir);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ffmpeg\s+MISSING \(optional\)/);
    assert.match(r.out, /hyperframes\s+MISSING \(optional\)/);
    assert.match(r.out, /chrome \/ chromium\s+MISSING \(optional\)/);
    assert.doesNotMatch(r.out, /MISSING \(required\)/);
    assert.match(r.out, /summary: all required deps present/);
  });

  it('exits non-zero when a required dependency is missing', () => {
    const r = doctorSh({ ...allOptionalMissing, AKUKO_DOCTOR_MIN_NODE: '999.0' }, emptyDir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /node >= 999\.0\s+MISSING \(required\)/);
  });

  it('on Windows checks HYPERFRAMES_BROWSER_PATH and prints setup instructions, never setting it', { skip: process.platform !== 'win32' }, () => {
    const r = doctorSh(allOptionalMissing, emptyDir);
    assert.match(r.out, /HYPERFRAMES_BROWSER_PATH\s+MISSING \(optional\)/);
    assert.match(r.out, /setx HYPERFRAMES_BROWSER_PATH/);
    assert.equal(r.status, 0);
  });

  it('reports orphan reservations and drift from a project folder, exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-doctor-sh-'));
    try {
      const p = fixtureProject({ budget: null });
      p.ledger = [{ id: 'job_old.sc1_sh1.1', ts: '2026-01-01T00:00:00Z', provider: 'acme-images', unit: 'sc1_sh1', job: 'job_old', estimate: 0.04, status: 'submitted' }];
      writeFileSync(join(dir, 'akuko.json'), JSON.stringify(p));
      const r = doctorSh(allOptionalMissing, dir);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /job_old\.sc1_sh1\.1/);
      assert.match(r.out, /No budget cap/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
