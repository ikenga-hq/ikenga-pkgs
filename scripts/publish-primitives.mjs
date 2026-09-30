#!/usr/bin/env node
/**
 * Sign and publish the Ọba primitive catalog (`registry/primitives.json`) to
 * ikenga-registry, the same way update-registry-index.mjs signs `index.json`.
 *
 * Invoked by .github/workflows/sign-primitives.yml (workflow_dispatch). The
 * catalog source of truth is `registry/primitives.json` in this repo; regenerate
 * its pins with the shell's `scripts/primitives-catalog-pin.ts` (Round 57 · N-C).
 *
 * Env:
 *   REGISTRY_REPO_PAT             — contents:write on ikenga-hq/ikenga-registry
 *   REGISTRY_SIGNING_PRIVATE_KEY  — minisign secret key file contents (unencrypted, -W)
 *   DRY_RUN=1                     — sign + verify, but don't commit or push
 *
 * Assumes `minisign` is on PATH (the workflow installs it).
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_REPO = 'ikenga-hq/ikenga-registry';
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'registry', 'primitives.json');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

for (const k of ['REGISTRY_REPO_PAT', 'REGISTRY_SIGNING_PRIVATE_KEY']) {
  if (!process.env[k]) fail(`missing env ${k}`);
}

// Validate the source before touching the registry.
const catalog = JSON.parse(readFileSync(source, 'utf8'));
if (catalog.$schemaVersion !== 1 || !Array.isArray(catalog.primitives)) {
  fail('registry/primitives.json: expected {$schemaVersion: 1, primitives: [...]}');
}
for (const e of catalog.primitives) {
  for (const f of ['kind', 'name', 'source', 'url']) {
    if (typeof e[f] !== 'string' || !e[f]) fail(`catalog entry ${JSON.stringify(e.name)} is missing "${f}"`);
  }
}
catalog.updatedAt = new Date().toISOString();

const tmp = mkdtempSync(join(tmpdir(), 'ikenga-registry-'));
const registryDir = join(tmp, 'ikenga-registry');
const cloneUrl = `https://oauth2:${process.env.REGISTRY_REPO_PAT}@github.com/${REGISTRY_REPO}.git`;
execSync(`git clone --depth=1 ${cloneUrl} ${registryDir}`, { stdio: ['ignore', 'inherit', 'inherit'] });
execSync(`git -C ${registryDir} config user.name "ikenga-pkgs[bot]"`);
execSync(`git -C ${registryDir} config user.email "ikenga-pkgs+bot@users.noreply.github.com"`);

const out = join(registryDir, 'primitives.json');
writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');

const keyPath = join(tmp, 'registry.key');
writeFileSync(keyPath, process.env.REGISTRY_SIGNING_PRIVATE_KEY);
execSync(`chmod 600 ${keyPath}`);
execSync(`minisign -Sm ${out} -s ${keyPath} -W`, { stdio: ['ignore', 'inherit', 'inherit'] });

// Verify against the registry's published public key, so a wrong secret can
// never push a catalog the shell will reject.
const pub = readFileSync(join(registryDir, 'REGISTRY_PUBLIC_KEY.txt'), 'utf8').trim().split('\n').pop().trim();
execSync(`minisign -Vm ${out} -P ${pub}`, { stdio: ['ignore', 'inherit', 'inherit'] });

const names = catalog.primitives.map((e) => `${e.kind}:${e.name}${e.ref ? `@${e.ref.slice(0, 7)}` : ''}`);
if (process.env.DRY_RUN === '1') {
  console.log(`✓ DRY RUN — signed + verified, not pushed: ${names.join(', ')}`);
  process.exit(0);
}

execSync(`git -C ${registryDir} add primitives.json primitives.json.minisig`);
const status = execSync(`git -C ${registryDir} status --porcelain`).toString().trim();
if (!status) {
  console.log('✓ catalog unchanged — nothing to publish');
  process.exit(0);
}
const msg = `chore: publish Ọba primitive catalog (${catalog.primitives.length} entries)\n\n${names.map((n) => `- ${n}`).join('\n')}\n`;
execSync(`git -C ${registryDir} commit -F -`, { input: msg, stdio: ['pipe', 'inherit', 'inherit'] });
execSync(`git -C ${registryDir} push origin main`, { stdio: ['ignore', 'inherit', 'inherit'] });
console.log(`✓ published primitives.json: ${names.join(', ')}`);
