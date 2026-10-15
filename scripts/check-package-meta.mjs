#!/usr/bin/env node
/**
 * check-package-meta.mjs — every publishable package under packages/ must
 * carry the repository metadata npm needs to accept a provenance publish.
 *
 * Release publishes with provenance, and npm rejects (E422) a package whose
 * `repository.url` doesn't match this repo. That failure only shows up on
 * main, after the version PR merges, and leaves the package unpublished while
 * later release runs go green. @ikenga/pkg-mattermost 0.2.0 and 0.3.0 both
 * failed that way and never reached npm. Catch it on the PR instead.
 *
 * Exits 1 on any problem.
 */

import { readFileSync, globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_URL = 'git+https://github.com/ikenga-hq/ikenga-pkgs.git';

/** Problems with one package.json; [] when it is fine or not published. */
export function checkPackage(pkg, dir) {
  if (pkg.private) return [];
  const problems = [];
  const repo = pkg.repository;
  if (!repo || typeof repo !== 'object') {
    problems.push(`no "repository" object (npm provenance rejects the publish)`);
  } else {
    if (repo.url !== REPO_URL) {
      problems.push(`repository.url is ${JSON.stringify(repo.url ?? '')}, expected ${JSON.stringify(REPO_URL)}`);
    }
    if (repo.directory !== dir) {
      problems.push(`repository.directory is ${JSON.stringify(repo.directory ?? '')}, expected ${JSON.stringify(dir)}`);
    }
  }
  return problems;
}

function main() {
  const root = join(fileURLToPath(import.meta.url), '../..');
  const paths = globSync('packages/**/package.json', {
    cwd: root,
    exclude: (p) => p.includes('node_modules'),
  })
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !p.includes('/node_modules/') && !p.includes('/dist/'))
    .sort();

  let failures = 0;
  let checked = 0;
  for (const rel of paths) {
    const pkg = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    if (pkg.private) continue;
    checked++;
    for (const problem of checkPackage(pkg, dirname(rel))) {
      console.error(`✗ ${rel} (${pkg.name}): ${problem}`);
      failures++;
    }
  }
  if (failures) {
    console.error(`\n${failures} problem(s) in publishable package repository metadata.`);
    process.exit(1);
  }
  console.log(`✓ ${checked} publishable package.json files have repository metadata`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
