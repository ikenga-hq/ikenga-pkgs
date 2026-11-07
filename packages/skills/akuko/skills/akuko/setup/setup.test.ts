// akuko — setup (WP-08): the required cap, currency, manifest, Windows browser advice,
// and the end-to-end "refused before setup, allowed past the budget check after".
//
//   pnpm --filter @ikenga/skill-akuko test

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { Budget, PendingSpend } from '../schema/akuko-project.ts';
import type { Job } from '../providers/contract.ts';
import { parseProviderConfig } from '../providers/config.ts';
import { createFakeHost, tinyProject } from '../providers/__fixtures__/fake-host.ts';
import { SETUP_POINTER, createSpendGate } from '../spend/gate.ts';
import { FAKE_PAID_ID, FAKE_PRICE, createFakePaid, testConfig } from '../spend/__fixtures__/fake-paid.ts';
import { ManifestSchema, serializeManifest, writeManifest } from './manifest.ts';
import { SetupError, applySetup, browserAdvice, defaultKeyEnvName, keyPresence } from './setup.ts';

const NOW = '2026-11-07T10:00:00Z';
const SECRET = 'sk-test-SENTINEL-do-not-leak-0123456789';
const realConfig = parseProviderConfig({
  format: 'akuko-provider-config',
  version: 1,
  currency: 'USD',
  stale_after_days: 30,
  providers: {
    manual: { label: 'Manual', billing: 'free', default_model: 'm', models: { m: { price: { amount: 0, per: 'job' }, last_verified: '2026-11-07', source: 'test' } } },
    'acme-images': { label: 'Acme', billing: 'direct-api', default_model: 'a', models: { a: { price: { amount: 0.04, per: 'image' }, last_verified: '2026-11-07', source: 'test' } } },
  },
});

describe('setup: the cap is required and has no default', () => {
  for (const [label, cap] of [['undefined', undefined], ['NaN', Number.NaN], ['a string', '5'], ['negative', -1], ['Infinity', Number.POSITIVE_INFINITY], ['null', null]] as const) {
    it(`refuses a cap that is ${label} and writes nothing`, async () => {
      const host = createFakeHost(tinyProject());
      await assert.rejects(applySetup({ cap } as never, { host, config: realConfig, now: () => NOW }), SetupError);
      assert.equal(host.writes(), 0);
      assert.equal(host.peek().budget, null);
    });
  }

  it('records the cap in akuko.json.budget through writeState, in the provider-config currency', async () => {
    const host = createFakeHost(tinyProject());
    const r = await applySetup({ cap: 12.5 }, { host, config: realConfig, now: () => NOW });
    assert.deepEqual(host.peek().budget, { cap: 12.5, currency: 'USD', spent: 0 });
    assert.equal(host.writes(), 1);
    assert.deepEqual(r.project.budget, host.peek().budget);

    const eur = parseProviderConfig({ ...realConfig, currency: 'EUR' });
    const host2 = createFakeHost(tinyProject());
    await applySetup({ cap: 3 }, { host: host2, config: eur, now: () => NOW });
    assert.equal(host2.peek().budget?.currency, 'EUR');
  });

  it('a cap of 0 is allowed when the person says so (nothing paid may run)', async () => {
    const host = createFakeHost(tinyProject());
    await applySetup({ cap: 0 }, { host, config: realConfig, now: () => NOW });
    assert.equal(host.peek().budget?.cap, 0);
  });

  it('re-running keeps what was already spent, and refuses a cap below what is committed', async () => {
    const base = tinyProject({
      budget: { cap: 5, currency: 'USD', spent: 1 } satisfies Budget,
      ledger: [{ id: 'j.u.1', ts: NOW, provider: 'acme-images', unit: 'sc1_sh1', job: 'j', estimate: 1, actual: 1, status: 'done' }],
    });
    const host = createFakeHost(base);
    await applySetup({ cap: 8 }, { host, config: realConfig, now: () => NOW });
    assert.deepEqual(host.peek().budget, { cap: 8, currency: 'USD', spent: 1 });
    await assert.rejects(applySetup({ cap: 0.5 }, { host, config: realConfig, now: () => NOW }), /below/);
    assert.equal(host.peek().budget?.cap, 8);
  });

  it('refuses to change currency under recorded spend', async () => {
    const base = tinyProject({
      budget: { cap: 5, currency: 'GBP', spent: 1 },
      ledger: [{ id: 'j.u.1', ts: NOW, provider: 'acme-images', unit: 'sc1_sh1', job: 'j', estimate: 1, actual: 1, status: 'done' }],
    });
    const host = createFakeHost(base);
    await assert.rejects(applySetup({ cap: 8 }, { host, config: realConfig, now: () => NOW }), /currency/);
    assert.equal(host.writes(), 0);
  });

  it('defaults go to the project (aspect ratio, runtime) and the manifest', async () => {
    const host = createFakeHost(tinyProject());
    const r = await applySetup({ cap: 5, defaults: { aspect_ratio: '9:16', runtime_s: 90 } }, { host, config: realConfig, now: () => NOW });
    assert.equal(host.peek().project.aspect_ratio, '9:16');
    assert.equal(host.peek().project.runtime_s, 90);
    assert.deepEqual(r.manifest.settings.defaults, { aspect_ratio: '9:16', runtime_s: 90 });
  });
});

describe('setup: a paid call before a cap is refused with a pointer to setup; after setup it is not', () => {
  const job: Job = {
    id: 'job_kf_sc1',
    stage: 'keyframes',
    kind: 'image',
    provider: FAKE_PAID_ID,
    label: 'Key frames for scene 1',
    items: [
      { unit: 'sc1_sh1', prompt: 'A long dark hallway', output: 'keyframe' },
      { unit: 'sc1_sh2', prompt: 'A hand on a latch', output: 'keyframe' },
    ],
  };
  const approved: PendingSpend = {
    id: job.id,
    stage: 'keyframes',
    label: job.label,
    units: ['sc1_sh1', 'sc1_sh2'],
    provider: FAKE_PAID_ID,
    estimate: 2 * FAKE_PRICE,
    status: 'approved',
  };

  it('end to end through the setup flow', async () => {
    const host = createFakeHost(tinyProject({ pending_spend: [approved] }));
    const fake = createFakePaid(host);
    const gate = createSpendGate({ host, providers: [fake.provider], level: 'B', now: () => NOW });

    const before = await gate.run(job);
    assert.equal(before.status, 'refused');
    if (before.status !== 'refused') return;
    assert.equal(before.refusal.code, 'no-budget');
    assert.equal(before.refusal.message, SETUP_POINTER);
    assert.match(before.refusal.message, /\/akuko setup/);
    assert.deepEqual(fake.log.filter((l) => l.startsWith('submit:')), [], 'nothing reached the provider');

    // The same config the gate prices with: setup's currency is the config currency.
    await applySetup({ cap: 5 }, { host, config: testConfig(), now: () => NOW });

    const after = await gate.run(job);
    assert.equal(after.status, 'submitted', JSON.stringify(after));
  });
});

describe('setup: instance manifest', () => {
  it('lists keys as names and booleans only; a key value never appears anywhere', async () => {
    const host = createFakeHost(tinyProject());
    const env = { ACME_IMAGES_API_KEY: SECRET, UNRELATED_TOKEN: SECRET };
    const r = await applySetup({ cap: 5 }, { host, config: realConfig, env, platform: 'linux', now: () => NOW });
    assert.deepEqual(r.manifest.settings.keys_present, { 'acme-images': { env: 'ACME_IMAGES_API_KEY', present: true } });
    assert.equal(serializeManifest(r.manifest).includes(SECRET), false);
    assert.equal(JSON.stringify(r.project).includes(SECRET), false);
    assert.equal(JSON.stringify(r.browser).includes(SECRET), false);
  });

  it('reports an absent key as present: false; example and free providers are not asked about', () => {
    const cfg = parseProviderConfig({
      ...realConfig,
      providers: {
        ...realConfig.providers,
        'example-direct': { label: 'EXAMPLE', billing: 'direct-api', example: true, default_model: 'x', models: { x: { price: { amount: 1, per: 'image' }, last_verified: '2026-11-07', source: 'test' } } },
      },
    });
    assert.deepEqual(keyPresence(cfg, {}), { 'acme-images': { env: 'ACME_IMAGES_API_KEY', present: false } });
    assert.deepEqual(keyPresence(cfg, { MINE: 'v' }, { 'acme-images': 'MINE' }), { 'acme-images': { env: 'MINE', present: true } });
    assert.equal(defaultKeyEnvName('fal'), 'FAL_API_KEY');
  });

  it('brand is null unless the person gives one; nothing ships as a default', async () => {
    const host = createFakeHost(tinyProject());
    const r = await applySetup({ cap: 5 }, { host, config: realConfig, now: () => NOW });
    assert.equal(r.manifest.settings.brand, null);
    assert.deepEqual(r.manifest.settings.defaults, {});
  });

  it('stores the brand exactly as given (palette, fonts, logo)', async () => {
    const host = createFakeHost(tinyProject());
    const brand = {
      palette: [{ name: 'ink', hex: '#101820' }, { hex: '#f2aa4c' }],
      fonts: [{ role: 'heading', family: 'Example Serif' }, { family: 'Example Sans' }],
      logo: 'brand/logo.svg',
    };
    const r = await applySetup({ cap: 5, brand }, { host, config: realConfig, now: () => NOW });
    assert.deepEqual(r.manifest.settings.brand, brand);
  });

  it('refuses a brand colour that is not a hex value, writing nothing', async () => {
    const host = createFakeHost(tinyProject());
    await assert.rejects(applySetup({ cap: 5, brand: { palette: [{ hex: 'teal' }] } }, { host, config: realConfig, now: () => NOW }), SetupError);
    assert.equal(host.writes(), 0);
  });

  it('the manifest has template_version and no cap (the cap lives in akuko.json)', async () => {
    const host = createFakeHost(tinyProject());
    const r = await applySetup({ cap: 5 }, { host, config: realConfig, now: () => NOW });
    assert.equal(r.manifest.template_version, 1);
    assert.equal(JSON.stringify(r.manifest).includes('cap'), false);
    assert.throws(() => ManifestSchema.parse({ ...r.manifest, settings: { ...r.manifest.settings, api_key: SECRET } }));
  });

  it('writeManifest puts the instance file at .atelier/akuko/manifest.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-setup-'));
    try {
      const host = createFakeHost(tinyProject());
      const r = await applySetup({ cap: 5 }, { host, config: realConfig, now: () => NOW });
      const path = await writeManifest(dir, r.manifest);
      assert.equal(path, join(dir, '.atelier', 'akuko', 'manifest.json'));
      assert.deepEqual(ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8'))), r.manifest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setup: Windows HYPERFRAMES_BROWSER_PATH', () => {
  it('offers instructions when unset on Windows, without touching the environment', async () => {
    const before = process.env.HYPERFRAMES_BROWSER_PATH;
    const env: Record<string, string | undefined> = {};
    const a = browserAdvice('win32', env, () => false);
    assert.equal(a.applies, true);
    assert.equal(a.ok, false);
    assert.match(a.instructions.join('\n'), /setx HYPERFRAMES_BROWSER_PATH/);
    assert.deepEqual(env, {});
    assert.equal(process.env.HYPERFRAMES_BROWSER_PATH, before);
  });

  it('is satisfied when set to a file that exists; flags a path that does not', () => {
    assert.equal(browserAdvice('win32', { HYPERFRAMES_BROWSER_PATH: 'C:\\x\\chrome.exe' }, () => true).ok, true);
    const bad = browserAdvice('win32', { HYPERFRAMES_BROWSER_PATH: 'C:\\x\\chrome.exe' }, () => false);
    assert.equal(bad.ok, false);
    assert.match(bad.instructions[0] ?? '', /does not exist/);
  });

  it('does not apply off Windows', () => {
    assert.deepEqual(browserAdvice('linux', {}, () => false), { applies: false, set: false, ok: true, instructions: [] });
  });

  it('is recorded in the manifest on Windows only', async () => {
    const host = createFakeHost(tinyProject());
    const win = await applySetup({ cap: 5 }, { host, config: realConfig, env: {}, platform: 'win32', now: () => NOW });
    assert.deepEqual(win.manifest.settings.hyperframes_browser, { env: 'HYPERFRAMES_BROWSER_PATH', set: false });
    const nix = await applySetup({ cap: 5 }, { host, config: realConfig, env: {}, platform: 'linux', now: () => NOW });
    assert.equal(nix.manifest.settings.hyperframes_browser, null);
  });
});

describe('the public skill ships no brand values', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  // Built from parts so this file does not contain the word it searches for.
  const needle = ['roy', 'alti'].join('');

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...files(full));
      else out.push(full);
    }
    return out;
  }

  it('no file in the skill mentions the company that publishes it (the licence copyright line excepted)', () => {
    const hits: string[] = [];
    for (const f of files(ROOT)) {
      const rel = relative(ROOT, f).split(sep).join('/');
      if (rel === 'LICENSE' || /\.(png|jpe?g|gif|webp|mp4|woff2?)$/i.test(rel)) continue;
      if (readFileSync(f, 'utf8').toLowerCase().includes(needle)) hits.push(rel);
    }
    assert.deepEqual(hits, []);
    assert.ok(existsSync(join(ROOT, 'LICENSE')));
  });
});
