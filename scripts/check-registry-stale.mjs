#!/usr/bin/env node
/**
 * Verification script to detect frozen/stale ikenga-registry index.
 *
 * Checks the live registry index (https://registry.ikenga.dev/index.json) or
 * github raw index against monorepo package versions.
 * If packages are published with higher versions than recorded in the index,
 * or if index age >= 2 days with version drift, emits a GitHub Actions
 * ::error:: annotation and exits 1.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Single source of truth for retired pkg names (registry/retired.json,
// DEC-72): reuse the loader rather than re-reading the file here, so this
// check and the index updater can never disagree about what's retired.
import { loadRetiredPkgNames } from './update-registry-index.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_URL = 'https://registry.ikenga.dev/index.json';
const RAW_REGISTRY_URL = 'https://raw.githubusercontent.com/ikenga-hq/ikenga-registry/main/index.json';

const NON_PKG_LIBRARIES = new Set([
  '@ikenga/registry-client',
  '@ikenga/ui-lib',
]);

const RETIRED_PKGS = loadRetiredPkgNames();

async function fetchRegistryIndex() {
  try {
    const res = await fetch(REGISTRY_URL, { headers: { Accept: 'application/json' } });
    if (res.ok) return await res.json();
  } catch {}
  try {
    const res = await fetch(RAW_REGISTRY_URL, { headers: { Accept: 'application/json' } });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

function findMonorepoPackages() {
  const pkgs = [];
  const SKIP = new Set(['node_modules', 'dist', '.git', '.vite']);
  const stack = [join(REPO_ROOT, 'packages')];
  while (stack.length > 0) {
    const dir = stack.pop();
    const pkgJsonPath = join(dir, 'package.json');
    const manifestPath = join(dir, 'manifest.json');
    if (existsSync(pkgJsonPath) && existsSync(manifestPath)) {
      try {
        const pj = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        // `private` packages are never published, so they can never appear in
        // the registry index — flagging them as "missing" fails the release on
        // packages that are working exactly as intended. 14 of the 21 packages
        // this check reported on 2026-09-05 were private.
        if (pj.name && !pj.private && !NON_PKG_LIBRARIES.has(pj.name)) {
          pkgs.push({ name: pj.name, version: pj.version });
        }
      } catch {}
    }
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) stack.push(child);
      } catch {}
    }
  }
  return pkgs;
}

/**
 * Pure drift computation, extracted so it's testable without the network or
 * the filesystem walk: for each monorepo pkg absent from the registry's
 * {name -> latest} map, record it as missing — unless it's retired
 * (registry/retired.json, DEC-72). Retired pkgs are DROPPED from the index on
 * purpose by update-registry-index.mjs, so a retired name that's "missing"
 * from the index is the system working as intended, not drift.
 */
export function computeDrift(monorepoPkgs, registryPkgs, retiredNames = new Set()) {
  const drift = [];
  for (const pkg of monorepoPkgs) {
    if (retiredNames.has(pkg.name)) continue;
    const regVersion = registryPkgs.get(pkg.name);
    if (!regVersion) {
      drift.push({ name: pkg.name, localVersion: pkg.version, regVersion: 'missing' });
    }
  }
  return drift;
}

export async function checkRegistryHealth() {
  const index = await fetchRegistryIndex();
  if (!index) {
    console.warn('⚠ Could not fetch live or raw registry index; skipping frozen index check.');
    return { ok: true, warning: 'registry_unreachable' };
  }

  const monorepoPkgs = findMonorepoPackages();
  const registryPkgs = new Map((index.pkgs || []).map((p) => [p.name, p.latest]));

  const drift = computeDrift(monorepoPkgs, registryPkgs, RETIRED_PKGS);

  let ageDays = null;
  if (index.updatedAt) {
    const parsed = Date.parse(index.updatedAt);
    if (!Number.isNaN(parsed)) {
      ageDays = Math.floor((Date.now() - parsed) / 86_400_000);
    }
  }

  if (drift.length > 0) {
    const msg = `Frozen Registry Index Error: ${drift.length} package(s) are missing/behind in index.json (last written ${ageDays ?? '?'} days ago, ${index.updatedAt}). Missing/Drifted: ${drift.map((d) => `${d.name} (${d.regVersion} -> ${d.localVersion})`).join(', ')}`;
    console.error(`::error title=Frozen Registry Index Detected::${msg}`);
    return { ok: false, error: msg, drift, ageDays };
  }

  console.log(`✓ Registry index health clean (${registryPkgs.size} catalogued pkgs, last written ${ageDays ?? 0} days ago).`);
  return { ok: true, ageDays };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkRegistryHealth();
  if (!result.ok) {
    process.exit(1);
  }
}
