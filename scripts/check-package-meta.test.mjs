import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPackage, REPO_URL } from './check-package-meta.mjs';

const dir = 'packages/sidecars/example';
const good = { name: '@ikenga/x', repository: { type: 'git', url: REPO_URL, directory: dir } };

test('a package with matching repository metadata passes', () => {
  assert.deepEqual(checkPackage(good, dir), []);
});

test('private packages are skipped', () => {
  assert.deepEqual(checkPackage({ name: '@ikenga/x', private: true }, dir), []);
});

test('a missing repository is reported (the pkg-mattermost E422)', () => {
  const problems = checkPackage({ name: '@ikenga/x' }, dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no "repository"/);
});

test('a wrong url or directory is reported', () => {
  const problems = checkPackage(
    { name: '@ikenga/x', repository: { url: 'https://github.com/other/repo', directory: 'packages/x' } },
    dir,
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /repository\.url/);
  assert.match(problems[1], /repository\.directory/);
});
