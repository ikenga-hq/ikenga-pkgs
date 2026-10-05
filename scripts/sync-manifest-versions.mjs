#!/usr/bin/env node
/**
 * sync-manifest-versions — copy each package's `package.json` version onto its
 * `manifest.json` so the two can never drift.
 *
 * WHY: the npm tarball version (what the registry advertises as `latest`) and
 * the manifest version (what the shell kernel records on install) MUST agree.
 * Changesets bumps only `package.json`; before this script existed, published
 * tarballs shipped stale `manifest.json` versions, so the shell would install
 * an update successfully and still record the old version — re-offering the
 * same update forever ("progress bar completes, version never changes").
 *
 * Wired into `pnpm version-packages` (= `changeset version` + this script) so
 * every Release PR carries synced manifests, and into CI as `--check` so a
 * hand-bumped manifest that drifts from package.json fails fast.
 *
 * Implementation note: manifests are hand-formatted (blank lines between
 * sections), so we do a targeted string replace of the single top-level
 * `"version"` line rather than a JSON.parse/stringify round-trip that would
 * destroy the formatting. A guard asserts each manifest has exactly one
 * `"version"` key before touching it.
 *
 * Also synced, when present (same WHY — every place a pkg states its own version
 * must agree with package.json, or installs/registries show a stale version):
 *   - Claude Code plugin manifests: `<pkg>/.claude-plugin/plugin.json` and
 *     `<pkg>/skills/<name>/.claude-plugin/plugin.json` (layout A — WP-03/WP-04).
 *     A pinned plugin `version` keeps users on it until it changes, so a stale
 *     one silently stops updates.
 *   - MCP registry `server.json`: the top-level `version` and every
 *     `packages[]` entry whose `identifier` is this package (WP-07 found
 *     mcp-iyke's stuck at 0.2.3 while the package was 0.3.0).
 * These files are machine-formatted, so they are rewritten via JSON round-trip
 * (2-space indent, trailing newline).
 *
 * Usage:
 *   node scripts/sync-manifest-versions.mjs           # write
 *   node scripts/sync-manifest-versions.mjs --check   # exit 1 on drift, write nothing
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/** Every packages/<type>/<pkg>/ dir holding both package.json + manifest.json. */
function findPkgDirs() {
  const out = [];
  const packagesRoot = join(REPO_ROOT, 'packages');
  for (const type of readdirSync(packagesRoot)) {
    const typeDir = join(packagesRoot, type);
    if (!statSync(typeDir).isDirectory()) continue;
    for (const pkg of readdirSync(typeDir)) {
      const dir = join(typeDir, pkg);
      if (!statSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'manifest.json'))) {
        out.push(dir);
      }
    }
  }
  return out.sort();
}

let drift = 0;
let synced = 0;

/** Version-bearing JSON files beside manifest.json, keyed by path → setter. */
function extraVersionFiles(dir, pkgName) {
  const out = [];
  const plugins = [join(dir, '.claude-plugin', 'plugin.json')];
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const name of readdirSync(skillsDir)) {
      plugins.push(join(skillsDir, name, '.claude-plugin', 'plugin.json'));
    }
  }
  for (const p of plugins) {
    if (!existsSync(p)) continue;
    out.push({
      path: p,
      versions: (j) => [j.version],
      set: (j, v) => { j.version = v; },
    });
  }
  const server = join(dir, 'server.json');
  if (existsSync(server)) {
    const ours = (j) => (j.packages ?? []).filter((e) => e.identifier === pkgName);
    out.push({
      path: server,
      versions: (j) => [j.version, ...ours(j).map((e) => e.version)],
      set: (j, v) => { j.version = v; for (const e of ours(j)) e.version = v; },
    });
  }
  return out;
}

for (const dir of findPkgDirs()) {
  const rel = relative(REPO_ROOT, dir);
  const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const manifestPath = join(dir, 'manifest.json');
  const manifestRaw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  if (!pkgJson.version) {
    console.error(`✗ ${rel}: package.json has no version`);
    process.exitCode = 1;
    continue;
  }
  for (const f of extraVersionFiles(dir, pkgJson.name)) {
    const json = JSON.parse(readFileSync(f.path, 'utf8'));
    const stale = f.versions(json).filter((v) => v !== pkgJson.version);
    if (stale.length === 0) continue;
    const frel = relative(REPO_ROOT, f.path);
    drift++;
    if (CHECK) {
      console.error(`✗ ${frel}: ${stale.join(', ')} ≠ package.json ${pkgJson.version}`);
      continue;
    }
    f.set(json, pkgJson.version);
    writeFileSync(f.path, JSON.stringify(json, null, 2) + '\n');
    synced++;
    console.log(`✓ ${frel}: ${stale.join(', ')} → ${pkgJson.version}`);
  }

  if (manifest.version === pkgJson.version) continue;

  // Guard: exactly one `"version"` key in the file, so the line replace below
  // can't hit a nested object.
  const matches = manifestRaw.match(/"version"\s*:/g) ?? [];
  if (matches.length !== 1) {
    console.error(
      `✗ ${rel}/manifest.json: expected exactly one "version" key, found ${matches.length} — sync it by hand`
    );
    process.exitCode = 1;
    continue;
  }

  drift++;
  if (CHECK) {
    console.error(
      `✗ ${rel}: manifest.json ${manifest.version} ≠ package.json ${pkgJson.version}`
    );
    continue;
  }

  const updated = manifestRaw.replace(
    /("version"\s*:\s*)"[^"]*"/,
    `$1"${pkgJson.version}"`
  );
  writeFileSync(manifestPath, updated);
  synced++;
  console.log(`✓ ${rel}: manifest.json ${manifest.version} → ${pkgJson.version}`);
}

if (CHECK && drift > 0) {
  console.error(
    `\n${drift} manifest(s) out of sync. Run \`node scripts/sync-manifest-versions.mjs\` (or \`pnpm version-packages\`).`
  );
  process.exit(1);
}
if (!CHECK) {
  console.log(synced > 0 ? `\n${synced} manifest(s) synced.` : 'All manifests in sync.');
}
