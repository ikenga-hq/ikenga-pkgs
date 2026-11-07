// akuko — every file the image providers own, and providers/config.json, must be valid UTF-8.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PROVIDERS = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? (n === 'node_modules' ? [] : files(full)) : [full];
  });
}

describe('image providers: UTF-8 only', () => {
  it('providers/config.json and everything under providers/gemini-image and providers/fal decode as UTF-8', () => {
    const all = [join(PROVIDERS, 'config.json'), ...files(join(PROVIDERS, 'gemini-image')), ...files(join(PROVIDERS, 'fal'))];
    assert.ok(all.length >= 8);
    for (const f of all) {
      assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(f)), `${relative(PROVIDERS, f)} is not valid UTF-8`);
    }
  });
});
