import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  npmDistInfo,
  formatPublishedInput,
  shortName,
  ikengaDeps,
  catalogPackage,
} from './update-registry-index.mjs';

describe('npmDistInfo retry and error handling', () => {
  it('returns dist info immediately when npm returns 200 on first attempt', async () => {
    let callCount = 0;
    const fakeFetch = async (url) => {
      callCount++;
      if (url.endsWith('/0.1.0')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            dist: {
              tarball: 'https://registry.npmjs.org/@ikenga/pkg-test/-/pkg-test-0.1.0.tgz',
              integrity: 'sha512-test',
              unpackedSize: 12345,
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          time: { '0.1.0': '2026-09-13T12:00:00.000Z' },
        }),
      };
    };

    const dist = await npmDistInfo('@ikenga/pkg-test', '0.1.0', {
      fetchFn: fakeFetch,
      maxRetries: 3,
      initialDelayMs: 1,
    });

    assert.equal(callCount, 2); // 1 for version endpoint, 1 for sibling time endpoint
    assert.equal(dist.tarball, 'https://registry.npmjs.org/@ikenga/pkg-test/-/pkg-test-0.1.0.tgz');
    assert.equal(dist.integrity, 'sha512-test');
    assert.equal(dist.size, 12345);
    assert.equal(dist.publishedAt, '2026-09-13T12:00:00.000Z');
  });

  it('retries on 404 and succeeds when subsequent attempt returns 200', async () => {
    let versionAttempts = 0;
    const sleepCalls = [];

    const fakeFetch = async (url) => {
      if (url.endsWith('/0.2.0')) {
        versionAttempts++;
        if (versionAttempts < 3) {
          return { ok: false, status: 404 };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            dist: {
              tarball: 'https://registry.npmjs.org/@ikenga/pkg-test/-/pkg-test-0.2.0.tgz',
              integrity: 'sha512-test2',
              unpackedSize: 20000,
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          time: { '0.2.0': '2026-09-13T12:05:00.000Z' },
        }),
      };
    };

    const dist = await npmDistInfo('@ikenga/pkg-test', '0.2.0', {
      fetchFn: fakeFetch,
      sleepFn: (ms) => sleepCalls.push(ms),
      logFn: () => {},
      maxRetries: 5,
      initialDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 500,
    });

    assert.equal(versionAttempts, 3);
    assert.deepEqual(sleepCalls, [100, 200]);
    assert.equal(dist.tarball, 'https://registry.npmjs.org/@ikenga/pkg-test/-/pkg-test-0.2.0.tgz');
    assert.equal(dist.size, 20000);
  });

  it('fails with clear error when 404 retries are exhausted', async () => {
    let attempts = 0;
    const sleepCalls = [];

    const fakeFetch = async () => {
      attempts++;
      return { ok: false, status: 404 };
    };

    await assert.rejects(
      async () => {
        await npmDistInfo('@ikenga/pkg-test', '0.3.0', {
          fetchFn: fakeFetch,
          sleepFn: (ms) => sleepCalls.push(ms),
          logFn: () => {},
          maxRetries: 4,
          initialDelayMs: 10,
        });
      },
      {
        name: 'Error',
        message: /npm fetch failed for @ikenga\/pkg-test@0\.3\.0: 404 Not Found \(timed out after 4 attempts awaiting npm ingest\)/,
      },
    );

    assert.equal(attempts, 4);
    assert.equal(sleepCalls.length, 3);
  });

  it('fails fast immediately on 401 Unauthorized without retrying', async () => {
    let attempts = 0;
    const sleepCalls = [];

    const fakeFetch = async () => {
      attempts++;
      return { ok: false, status: 401 };
    };

    await assert.rejects(
      async () => {
        await npmDistInfo('@ikenga/pkg-test', '0.4.0', {
          fetchFn: fakeFetch,
          sleepFn: (ms) => sleepCalls.push(ms),
          logFn: () => {},
          maxRetries: 5,
        });
      },
      {
        name: 'Error',
        message: 'npm fetch failed for @ikenga/pkg-test@0.4.0: 401',
      },
    );

    assert.equal(attempts, 1);
    assert.equal(sleepCalls.length, 0);
  });

  it('fails fast immediately on 403 Forbidden without retrying', async () => {
    let attempts = 0;
    const sleepCalls = [];

    const fakeFetch = async () => {
      attempts++;
      return { ok: false, status: 403 };
    };

    await assert.rejects(
      async () => {
        await npmDistInfo('@ikenga/pkg-test', '0.5.0', {
          fetchFn: fakeFetch,
          sleepFn: (ms) => sleepCalls.push(ms),
          logFn: () => {},
          maxRetries: 5,
        });
      },
      {
        name: 'Error',
        message: 'npm fetch failed for @ikenga/pkg-test@0.5.0: 403',
      },
    );

    assert.equal(attempts, 1);
    assert.equal(sleepCalls.length, 0);
  });

  it('fails fast immediately on 500 Server Error without retrying', async () => {
    let attempts = 0;
    const sleepCalls = [];

    const fakeFetch = async () => {
      attempts++;
      return { ok: false, status: 500 };
    };

    await assert.rejects(
      async () => {
        await npmDistInfo('@ikenga/pkg-test', '0.6.0', {
          fetchFn: fakeFetch,
          sleepFn: (ms) => sleepCalls.push(ms),
          logFn: () => {},
          maxRetries: 5,
        });
      },
      {
        name: 'Error',
        message: 'npm fetch failed for @ikenga/pkg-test@0.6.0: 500',
      },
    );

    assert.equal(attempts, 1);
    assert.equal(sleepCalls.length, 0);
  });
});

describe('formatPublishedInput', () => {
  it('formats package entries into JSON string for workflow_dispatch published input', () => {
    const list = [
      '@ikenga/pkg-studio@0.7.0',
      '@ikenga/pkg-engine-openrouter@0.1.1',
      '@ikenga/studio-doctor@0.2.2 (extra details)',
    ];
    const json = formatPublishedInput(list);
    assert.equal(
      json,
      JSON.stringify([
        { name: '@ikenga/pkg-studio', version: '0.7.0' },
        { name: '@ikenga/pkg-engine-openrouter', version: '0.1.1' },
        { name: '@ikenga/studio-doctor', version: '0.2.2' },
      ]),
    );
  });
});

describe('partial-batch catalogPackage handling', () => {
  it('catalogues successful packages and isolates failing packages without poisoning the batch', async () => {
    const writtenFiles = new Map();
    const mockIndex = { $schemaVersion: 1, updatedAt: 'old', pkgs: [] };

    const fakeFs = {
      existsSync: (path) => {
        if (path.includes('manifest.json')) return true;
        if (path.includes('pkgs/')) return writtenFiles.has(path);
        return false;
      },
      readFileSync: (path) => {
        if (path.includes('package.json')) {
          return JSON.stringify({ name: 'test-pkg', description: 'test' });
        }
        if (path.includes('manifest.json')) {
          return JSON.stringify({ name: 'test-pkg', kind: 'tool' });
        }
        if (writtenFiles.has(path)) {
          return writtenFiles.get(path);
        }
        throw new Error(`File not found: ${path}`);
      },
      writeFileSync: (path, content) => {
        writtenFiles.set(path, content);
      },
      mkdirSync: () => {},
    };

    const batch = [
      { name: '@ikenga/pkg-failing', version: '1.0.0' },
      { name: '@ikenga/pkg-succeeding', version: '2.0.0' },
    ];

    const catalogued = [];
    const uncatalogued = [];

    for (const item of batch) {
      const res = await catalogPackage(item, {
        registryDir: '/mock/registry',
        index: mockIndex,
        nowIso: '2026-09-13T19:00:00.000Z',
        findPackageDirFn: (name) => `/mock/packages/${name}`,
        npmDistInfoFn: async (name) => {
          if (name === '@ikenga/pkg-failing') {
            throw new Error('npm fetch failed: 404 (timed out awaiting ingest)');
          }
          return {
            tarball: 'https://registry.npmjs.org/@ikenga/pkg-succeeding/-/pkg-succeeding-2.0.0.tgz',
            integrity: 'sha512-ok',
            size: 5000,
            publishedAt: '2026-09-13T19:00:00.000Z',
          };
        },
        readFileFn: fakeFs.readFileSync,
        writeFileFn: fakeFs.writeFileSync,
        existsSyncFn: fakeFs.existsSync,
        mkdirSyncFn: fakeFs.mkdirSync,
        logFn: () => {},
        warnFn: () => {},
        errorFn: () => {},
      });

      if (res.status === 'success') {
        catalogued.push({ name: res.name, version: res.version });
      } else if (res.status === 'failed') {
        uncatalogued.push(`${item.name}@${item.version}`);
      }
    }

    // Assert partial outcomes: failing pkg did not abort succeeding pkg
    assert.deepEqual(catalogued, [{ name: '@ikenga/pkg-succeeding', version: '2.0.0' }]);
    assert.deepEqual(uncatalogued, ['@ikenga/pkg-failing@1.0.0']);

    // Assert index was updated for succeeding pkg and untouched for failing pkg
    assert.equal(mockIndex.pkgs.length, 1);
    assert.equal(mockIndex.pkgs[0].name, '@ikenga/pkg-succeeding');
    assert.equal(mockIndex.pkgs[0].latest, '2.0.0');

    // Assert detail file was written for succeeding pkg
    assert.ok(writtenFiles.has('/mock/registry/pkgs/succeeding.json'));
    assert.ok(!writtenFiles.has('/mock/registry/pkgs/failing.json'));
  });
});

describe('helpers', () => {
  it('shortName derives short name from scoped npm name', () => {
    assert.equal(shortName('@ikenga/pkg-studio'), 'studio');
    assert.equal(shortName('@ikenga/studio-doctor'), 'studio-doctor');
    assert.equal(shortName('@ikenga/pkg-engine-openrouter'), 'engine-openrouter');
  });

  it('ikengaDeps filters to only @ikenga/pkg-* dependencies', () => {
    const pj = {
      dependencies: {
        '@ikenga/pkg-core': '^1.0.0',
        '@ikenga/ui-lib': '^0.2.0',
        react: '^19.0.0',
      },
    };
    assert.deepEqual(ikengaDeps(pj), [{ name: '@ikenga/pkg-core', range: '^1.0.0' }]);
  });
});
