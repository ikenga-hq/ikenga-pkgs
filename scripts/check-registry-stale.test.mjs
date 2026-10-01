import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRegistryHealth, computeDrift } from './check-registry-stale.mjs';

describe('checkRegistryHealth', () => {
  it('runs cleanly against live or raw registry index', async () => {
    const result = await checkRegistryHealth();
    assert.equal(typeof result.ok, 'boolean');
  });
});

describe('computeDrift', () => {
  it('flags a monorepo pkg missing from the registry index', () => {
    const monorepoPkgs = [{ name: '@ikenga/pkg-studio', version: '1.2.0' }];
    const registryPkgs = new Map();
    const drift = computeDrift(monorepoPkgs, registryPkgs);
    assert.deepEqual(drift, [
      { name: '@ikenga/pkg-studio', localVersion: '1.2.0', regVersion: 'missing' },
    ]);
  });

  it('does not flag a pkg the registry already carries', () => {
    const monorepoPkgs = [{ name: '@ikenga/pkg-studio', version: '1.2.0' }];
    const registryPkgs = new Map([['@ikenga/pkg-studio', '1.2.0']]);
    assert.deepEqual(computeDrift(monorepoPkgs, registryPkgs), []);
  });

  it('does not flag a retired pkg missing from the registry index (DEC-72)', () => {
    const monorepoPkgs = [
      { name: '@ikenga/mcp-meetings', version: '0.1.1' },
      { name: '@ikenga/pkg-meetings-bot', version: '0.1.0' },
      { name: '@ikenga/pkg-studio', version: '1.2.0' },
    ];
    const registryPkgs = new Map(); // retired names were dropped by update-registry-index.mjs
    const retired = new Set(['@ikenga/mcp-meetings', '@ikenga/pkg-meetings-bot']);

    const drift = computeDrift(monorepoPkgs, registryPkgs, retired);

    assert.deepEqual(drift, [
      { name: '@ikenga/pkg-studio', localVersion: '1.2.0', regVersion: 'missing' },
    ]);
  });

  it('defaults to an empty retired set when none is given', () => {
    const monorepoPkgs = [{ name: '@ikenga/mcp-meetings', version: '0.1.1' }];
    const drift = computeDrift(monorepoPkgs, new Map());
    assert.deepEqual(drift, [
      { name: '@ikenga/mcp-meetings', localVersion: '0.1.1', regVersion: 'missing' },
    ]);
  });
});
