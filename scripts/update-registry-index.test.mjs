import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  npmDistInfo,
  formatPublishedInput,
  shortName,
  ikengaDeps,
  catalogPackage,
  loadRetiredPkgNames,
  dropRetiredFromIndex,
  reconcileVisibility,
  deriveNgwaKind,
  reconcileNgwaKind,
  detailManifestReader,
  HIDDEN_PKGS,
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

describe('loadRetiredPkgNames (DEC-72)', () => {
  it('reads names out of a retired.json-shaped file', () => {
    const fakeRead = () =>
      JSON.stringify({
        retired: [
          { name: '@ikenga/mcp-meetings', reason: 'r', replaced_by: 'com.ikenga.meetings' },
          { name: '@ikenga/pkg-meetings-bot', reason: 'r', replaced_by: 'com.ikenga.meetings' },
        ],
      });
    const names = loadRetiredPkgNames('/fake/path/retired.json', fakeRead);
    assert.deepEqual([...names].sort(), ['@ikenga/mcp-meetings', '@ikenga/pkg-meetings-bot']);
  });

  it('returns an empty set when the file is missing or unparsable', () => {
    const throwingRead = () => {
      throw new Error('ENOENT');
    };
    const names = loadRetiredPkgNames('/fake/path/retired.json', throwingRead);
    assert.equal(names.size, 0);
  });

  it('returns an empty set when the file has no `retired` array', () => {
    const fakeRead = () => JSON.stringify({});
    const names = loadRetiredPkgNames('/fake/path/retired.json', fakeRead);
    assert.equal(names.size, 0);
  });
});

describe('dropRetiredFromIndex (DEC-72)', () => {
  it('splits index.pkgs into kept and dropped by retired name, preserving order', () => {
    const pkgs = [
      { name: '@ikenga/pkg-studio', latest: '1.0.0' },
      { name: '@ikenga/mcp-meetings', latest: '0.1.0' },
      { name: '@ikenga/pkg-tasks', latest: '0.3.0' },
      { name: '@ikenga/pkg-meetings-bot', latest: '0.1.0' },
    ];
    const retired = new Set(['@ikenga/mcp-meetings', '@ikenga/pkg-meetings-bot']);

    const { kept, dropped } = dropRetiredFromIndex(pkgs, retired);

    assert.deepEqual(
      kept.map((p) => p.name),
      ['@ikenga/pkg-studio', '@ikenga/pkg-tasks'],
    );
    assert.deepEqual(
      dropped.map((p) => p.name),
      ['@ikenga/mcp-meetings', '@ikenga/pkg-meetings-bot'],
    );
  });

  it('is a no-op when nothing in the index is retired', () => {
    const pkgs = [{ name: '@ikenga/pkg-studio', latest: '1.0.0' }];
    const { kept, dropped } = dropRetiredFromIndex(pkgs, new Set(['@ikenga/mcp-meetings']));
    assert.deepEqual(kept, pkgs);
    assert.deepEqual(dropped, []);
  });
});

describe('catalogPackage never re-catalogues a retired pkg (DEC-72)', () => {
  it('skips a retired pkg even when it is freshly published, without touching the index or fs', async () => {
    const mockIndex = { $schemaVersion: 1, updatedAt: 'old', pkgs: [] };
    let findPackageDirCalled = false;

    const result = await catalogPackage(
      { name: '@ikenga/mcp-meetings', version: '0.1.1' },
      {
        registryDir: '/mock/registry',
        index: mockIndex,
        nowIso: '2026-10-01T00:00:00.000Z',
        retiredPkgs: new Set(['@ikenga/mcp-meetings', '@ikenga/pkg-meetings-bot']),
        findPackageDirFn: () => {
          findPackageDirCalled = true;
          return '/mock/packages/mcp-meetings';
        },
        logFn: () => {},
        warnFn: () => {},
        errorFn: () => {},
      },
    );

    assert.deepEqual(result, {
      status: 'skipped',
      name: '@ikenga/mcp-meetings',
      version: '0.1.1',
      reason: 'retired',
    });
    assert.equal(findPackageDirCalled, false, 'retired check must short-circuit before any pkg-dir lookup');
    assert.deepEqual(mockIndex.pkgs, []);
  });
});

describe('reconcileVisibility hides apps held back from the catalogue', () => {
  const HELD_APPS = [
    '@ikenga/pkg-finance',
    '@ikenga/pkg-mail',
    '@ikenga/pkg-content',
    '@ikenga/pkg-research',
    '@ikenga/pkg-strategy',
    '@ikenga/pkg-outbound',
    '@ikenga/pkg-agent-ops',
  ];
  const PUBLIC_APPS = ['@ikenga/pkg-tasks', '@ikenga/pkg-sales'];

  const entry = (name) => ({ name, latest: '1.0.0', detail: `pkgs/${name}.json` });

  it('stamps visibility "hidden" on all seven held apps', () => {
    const pkgs = [...HELD_APPS, ...PUBLIC_APPS].map(entry);
    reconcileVisibility(pkgs);
    for (const name of HELD_APPS) {
      assert.equal(pkgs.find((e) => e.name === name).visibility, 'hidden', `${name} should be hidden`);
    }
  });

  it('leaves Tasks and Sales public, with no visibility field at all', () => {
    const pkgs = [...HELD_APPS, ...PUBLIC_APPS].map(entry);
    reconcileVisibility(pkgs);
    for (const name of PUBLIC_APPS) {
      const e = pkgs.find((x) => x.name === name);
      assert.ok(!('visibility' in e), `${name} must stay public (visibility omitted)`);
    }
  });

  it('keeps every earlier hidden entry hidden', () => {
    const earlier = ['@ikenga/pkg-hello', '@ikenga/pkg-engine-noop', '@ikenga/pkg-engine-cursor-agent'];
    const pkgs = earlier.map(entry);
    reconcileVisibility(pkgs);
    for (const e of pkgs) assert.equal(e.visibility, 'hidden');
  });

  it('un-hides an entry that is no longer in the hidden set, so removing a name here re-publishes it', () => {
    const pkgs = [{ ...entry('@ikenga/pkg-finance'), visibility: 'hidden' }];
    reconcileVisibility(pkgs, new Set());
    assert.ok(!('visibility' in pkgs[0]));
  });

  it('the shipped HIDDEN_PKGS set names the seven held apps and neither public app', () => {
    for (const name of HELD_APPS) assert.ok(HIDDEN_PKGS.has(name), `${name} missing from HIDDEN_PKGS`);
    for (const name of PUBLIC_APPS) assert.ok(!HIDDEN_PKGS.has(name), `${name} must not be hidden`);
  });
});

describe('deriveNgwaKind, one test per rule step', () => {
  it('1: an engine block makes an engine, ahead of everything else', () => {
    assert.equal(deriveNgwaKind({ engine: {}, kind: 'bundle', ui: {}, mcp: [{}], sidecars: [{}] }), 'engine');
  });

  it('2: kind "bundle" makes a bundle, ahead of ui, mcp and sidecars', () => {
    assert.equal(deriveNgwaKind({ kind: 'bundle', ui: {}, mcp: [{}], sidecars: [{}] }), 'bundle');
  });

  it('3: any ui block makes an app, even an empty one, ahead of mcp and sidecars', () => {
    assert.equal(deriveNgwaKind({ kind: 'embedded', ui: { routes: [] }, mcp: [{}], sidecars: [{}] }), 'app');
    assert.equal(deriveNgwaKind({ ui: {} }), 'app');
  });

  it('4: one or more mcp servers makes a tool, ahead of sidecars and the skill hint', () => {
    assert.equal(deriveNgwaKind({ kind: 'skill', mcp: [{}], sidecars: [{}] }), 'tool');
  });

  it('5: one or more sidecars makes a sidecar, ahead of the skill hint', () => {
    assert.equal(deriveNgwaKind({ kind: 'skill', sidecars: [{}] }), 'sidecar');
  });

  it('6: kind "skill" with nothing else makes a skill', () => {
    assert.equal(deriveNgwaKind({ kind: 'skill' }), 'skill');
    assert.equal(deriveNgwaKind({ kind: 'skill', mcp: [], sidecars: [] }), 'skill');
  });

  it('7: anything else is an app', () => {
    assert.equal(deriveNgwaKind({}), 'app');
    assert.equal(deriveNgwaKind({ kind: 'windowed' }), 'app');
    assert.equal(deriveNgwaKind(undefined), 'app');
  });

  it('compares kind case-insensitively', () => {
    assert.equal(deriveNgwaKind({ kind: 'Bundle' }), 'bundle');
    assert.equal(deriveNgwaKind({ kind: 'SKILL' }), 'skill');
  });

  it('treats null as absent', () => {
    assert.equal(deriveNgwaKind({ engine: null, ui: null, kind: 'skill' }), 'skill');
  });

  it('matches the shell on the two cases that used to disagree: skill hint with ui {} is an app, requires alone is an app', () => {
    assert.equal(deriveNgwaKind({ kind: 'skill', ui: {} }), 'app');
    assert.equal(deriveNgwaKind({ requires: [{ name: 'x' }] }), 'app');
  });
});

describe('reconcileNgwaKind', () => {
  const entry = (name, extra = {}) => ({ name, latest: '1.0.0', detail: `pkgs/${name}.json`, ...extra });

  it('stamps every row from its manifest and leaves kind alone', () => {
    const pkgs = [entry('a', { kind: 'skill' }), entry('b', { kind: 'embedded' })];
    const manifests = { a: { kind: 'skill', mcp: [{}] }, b: { kind: 'embedded', ui: {} } };
    const res = reconcileNgwaKind(pkgs, (e) => manifests[e.name]);
    assert.deepEqual(res, { stamped: ['a', 'b'], unresolved: [] });
    assert.equal(pkgs[0].ngwaKind, 'tool');
    assert.equal(pkgs[0].kind, 'skill');
    assert.equal(pkgs[1].ngwaKind, 'app');
  });

  it('back-fills rows that predate the field and corrects a stale value', () => {
    const pkgs = [entry('a'), entry('b', { ngwaKind: 'app' })];
    reconcileNgwaKind(pkgs, () => ({ kind: 'bundle' }));
    assert.equal(pkgs[0].ngwaKind, 'bundle');
    assert.equal(pkgs[1].ngwaKind, 'bundle');
  });

  it('leaves a row alone when its manifest cannot be read, and reports it', () => {
    const pkgs = [entry('a', { ngwaKind: 'engine' }), entry('b')];
    const res = reconcileNgwaKind(pkgs, () => null);
    assert.deepEqual(res, { stamped: [], unresolved: ['a', 'b'] });
    assert.equal(pkgs[0].ngwaKind, 'engine');
    assert.ok(!('ngwaKind' in pkgs[1]));
  });
});

describe('detailManifestReader', () => {
  const detail = {
    versions: [
      { version: '2.0.0', manifest: { kind: 'skill' } },
      { version: '1.0.0', manifest: { kind: 'bundle' } },
    ],
  };
  const fakeRead = (path) => {
    if (path.split('\\').join('/').endsWith('pkgs/x.json')) return JSON.stringify(detail);
    throw new Error('ENOENT');
  };

  it('reads the manifest of the latest version', () => {
    const read = detailManifestReader('/mock/registry', fakeRead);
    assert.deepEqual(read({ name: 'x', latest: '1.0.0', detail: 'pkgs/x.json' }), { kind: 'bundle' });
  });

  it('falls back to the newest version when latest is not listed', () => {
    const read = detailManifestReader('/mock/registry', fakeRead);
    assert.deepEqual(read({ name: 'x', latest: '9.9.9', detail: 'pkgs/x.json' }), { kind: 'skill' });
  });

  it('returns null for a missing or broken detail file', () => {
    const read = detailManifestReader('/mock/registry', fakeRead);
    assert.equal(read({ name: 'y', latest: '1.0.0', detail: 'pkgs/y.json' }), null);
  });
});

describe('catalogPackage stamps ngwaKind on the entry it writes', () => {
  it('writes the derived kind next to the manifest hint', async () => {
    const files = new Map();
    const index = { $schemaVersion: 1, updatedAt: 'old', pkgs: [] };
    const res = await catalogPackage(
      { name: '@ikenga/mcp-example', version: '1.2.3' },
      {
        registryDir: '/mock/registry',
        index,
        nowIso: '2026-10-03T00:00:00.000Z',
        findPackageDirFn: (name) => `/mock/packages/${name}`,
        npmDistInfoFn: async () => ({ tarball: 't', integrity: 'i', size: 1, publishedAt: '2026-10-03T00:00:00.000Z' }),
        readFileFn: (path) => {
          if (path.includes('package.json')) return JSON.stringify({ name: '@ikenga/mcp-example', description: 'd' });
          if (path.includes('manifest.json')) return JSON.stringify({ kind: 'skill', mcp: [{ name: 'x' }] });
          throw new Error(`File not found: ${path}`);
        },
        writeFileFn: (path, content) => files.set(path, content),
        existsSyncFn: (path) => path.includes('manifest.json'),
        mkdirSyncFn: () => {},
        logFn: () => {},
        warnFn: () => {},
        errorFn: () => {},
      },
    );
    assert.equal(res.status, 'success');
    assert.equal(index.pkgs[0].kind, 'skill');
    assert.equal(index.pkgs[0].ngwaKind, 'tool');
  });
});

describe('ngwaKind over the 38 latest manifests at index updatedAt 2026-10-01T12:39Z', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./testdata/registry-kind-manifests.json', import.meta.url), 'utf8'),
  );
  const pkgs = fixture.manifests.map((m) => ({ name: m.name, latest: '0.0.0', detail: `pkgs/${m.name}.json` }));
  const byName = new Map(fixture.manifests.map((m) => [m.name, m]));
  reconcileNgwaKind(pkgs, (e) => byName.get(e.name));

  it('covers the 38 rows of that index', () => {
    assert.equal(fixture.indexUpdatedAt, '2026-10-01T12:39:14.137Z');
    assert.equal(pkgs.length, 38);
  });

  it('counts app 17, engine 8, skill 7, tool 3, bundle 2, sidecar 1', () => {
    const counts = {};
    for (const e of pkgs) counts[e.ngwaKind] = (counts[e.ngwaKind] ?? 0) + 1;
    assert.deepEqual(counts, { app: 17, engine: 8, skill: 7, tool: 3, bundle: 2, sidecar: 1 });
  });

  it('keeps pkg-hello (skill hint, empty ui) an app and pkg-browser (no ui, one sidecar) a sidecar', () => {
    const hello = fixture.manifests.find((m) => m.name === '@ikenga/pkg-hello');
    assert.deepEqual(hello, { name: '@ikenga/pkg-hello', kind: 'skill', ui: {} });
    assert.equal(pkgs.find((e) => e.name === '@ikenga/pkg-hello').ngwaKind, 'app');
    assert.equal(pkgs.find((e) => e.name === '@ikenga/pkg-browser').ngwaKind, 'sidecar');
  });

  it('makes the three MCP servers tools although their hint says skill', () => {
    for (const name of ['@ikenga/mcp-browser', '@ikenga/mcp-devin', '@ikenga/mcp-iyke']) {
      assert.equal(pkgs.find((e) => e.name === name).ngwaKind, 'tool', name);
    }
  });
});
