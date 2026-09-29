import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanNavOnly } from './scan-nav-only.mjs';

describe('scanNavOnly', () => {
  it('runs against registry and confirms 0 ikenga-pkgs entries are nav-only', async () => {
    const result = await scanNavOnly();
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.totalChecked, 'number');
    assert.ok(result.totalChecked > 0, 'should check at least one package');
    assert.equal(result.ikengaNavOnly.length, 0, 'ikenga-pkgs entries must have 0 nav-only');
    assert.equal(result.ok, true, 'scan result must be ok');
  });
});
