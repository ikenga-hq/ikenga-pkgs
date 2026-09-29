#!/usr/bin/env node
/**
 * Scan ikenga-registry for packages that declare `ui.nav` without `ui.views`.
 *
 * G-26 / WP-30 / WP-31a gate:
 * Asserts that all published pkgs sourced from ikenga-pkgs have migrated to
 * manifest v5 `ui.views[]`.
 *
 * Usage:
 *   node scripts/scan-nav-only.mjs [--report-only] [--registry-dir <path>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_URL = 'https://registry.ikenga.dev/index.json';
const RAW_REGISTRY_BASE = 'https://raw.githubusercontent.com/ikenga-hq/ikenga-registry/main';

function resolveLocalRegistryDir(customDir) {
  if (customDir && existsSync(customDir)) return customDir;
  if (process.env.IKENGA_REGISTRY_DIR && existsSync(process.env.IKENGA_REGISTRY_DIR)) {
    return process.env.IKENGA_REGISTRY_DIR;
  }
  const candidates = [
    join(REPO_ROOT, '../ikenga-registry'),
    join(REPO_ROOT, '../../ikenga-registry'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.json'))) return c;
  }
  return null;
}

async function loadIndex(localDir) {
  if (localDir) {
    const indexPath = join(localDir, 'index.json');
    if (existsSync(indexPath)) {
      return JSON.parse(readFileSync(indexPath, 'utf8'));
    }
  }
  try {
    const res = await fetch(REGISTRY_URL, { headers: { Accept: 'application/json' } });
    if (res.ok) return await res.json();
  } catch {}
  try {
    const res = await fetch(`${RAW_REGISTRY_BASE}/index.json`, { headers: { Accept: 'application/json' } });
    if (res.ok) return await res.json();
  } catch {}
  throw new Error('Could not load registry index from local disk or remote URLs');
}

async function loadPkgDetail(localDir, detailRelPath) {
  if (localDir) {
    const detailPath = join(localDir, detailRelPath);
    if (existsSync(detailPath)) {
      return JSON.parse(readFileSync(detailPath, 'utf8'));
    }
  }
  const url = `${RAW_REGISTRY_BASE}/${detailRelPath}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function scanNavOnly(options = {}) {
  const {
    registryDir: customDir,
    reportOnly = false,
  } = options;

  const localDir = resolveLocalRegistryDir(customDir);
  const index = await loadIndex(localDir);

  const ikengaNavOnly = [];
  const thirdPartyNavOnly = [];
  let totalChecked = 0;

  for (const pkg of index.pkgs || []) {
    totalChecked += 1;
    let detail;
    try {
      detail = await loadPkgDetail(localDir, pkg.detail);
    } catch (err) {
      console.warn(`⚠ Could not load detail for ${pkg.name}: ${err.message}`);
      continue;
    }

    const latestVer = pkg.latest;
    const versionEntry = Array.isArray(detail.versions)
      ? detail.versions.find((v) => v.version === latestVer) || detail.versions[0]
      : null;

    if (!versionEntry || !versionEntry.manifest) {
      continue;
    }

    const manifest = versionEntry.manifest;
    const ui = manifest.ui;
    const hasNav = Array.isArray(ui?.nav) && ui.nav.length > 0;
    const hasViews = Array.isArray(ui?.views) && ui.views.length > 0;

    if (hasNav && !hasViews) {
      const isIkenga = (pkg.name && pkg.name.startsWith('@ikenga/')) ||
        (manifest.author?.key === 'royalti') ||
        (manifest.id && manifest.id.startsWith('com.ikenga.'));

      const entry = {
        name: pkg.name,
        id: manifest.id,
        version: versionEntry.version,
        isIkenga,
      };

      if (isIkenga) {
        ikengaNavOnly.push(entry);
      } else {
        thirdPartyNavOnly.push(entry);
      }
    }
  }

  const ok = ikengaNavOnly.length === 0;

  return {
    ok,
    totalChecked,
    ikengaNavOnly,
    thirdPartyNavOnly,
    reportOnly,
    localDir,
  };
}

// CLI entry point
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report-only');
  const regDirIdx = args.indexOf('--registry-dir');
  const customDir = regDirIdx !== -1 ? args[regDirIdx + 1] : undefined;

  scanNavOnly({ registryDir: customDir, reportOnly })
    .then((result) => {
      console.log(`\n── scan-nav-only report ──`);
      console.log(`Source: ${result.localDir ? `local (${result.localDir})` : 'remote registry'}`);
      console.log(`Total packages checked: ${result.totalChecked}`);
      console.log(`ikenga-pkgs nav-only count: ${result.ikengaNavOnly.length}`);
      console.log(`third-party nav-only count: ${result.thirdPartyNavOnly.length}`);

      if (result.ikengaNavOnly.length > 0) {
        console.error('\n❌ ikenga-pkgs entries with ui.nav and no ui.views:');
        for (const item of result.ikengaNavOnly) {
          console.error(`  - ${item.name} (${item.id}) @ ${item.version}`);
        }
      }

      if (result.thirdPartyNavOnly.length > 0) {
        console.log('\nℹ Third-party entries with ui.nav and no ui.views:');
        for (const item of result.thirdPartyNavOnly) {
          console.log(`  - ${item.name} (${item.id}) @ ${item.version}`);
        }
      }

      if (result.ok) {
        console.log('\n✓ Clean: 0 ikenga-pkgs-sourced entries are ui.nav-only.\n');
        process.exit(0);
      } else {
        if (result.reportOnly) {
          console.warn('\n⚠ Exiting 0 due to --report-only flag.\n');
          process.exit(0);
        } else {
          process.exit(1);
        }
      }
    })
    .catch((err) => {
      console.error(`scan-nav-only error: ${err.message}`);
      process.exit(1);
    });
}
