// Fixture-level tests for the WP-21b noun logic. The NgwaSnapshot fixture
// is the shell's committed golden — copied verbatim from
// `shell/src/lib/ngwa/__fixtures__/ngwa-snapshot.golden.json` (WP-14/WP-17
// shape-locks it) so a wire-shape drift fails here and in iyke-cli's copy.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import golden from './__fixtures__/ngwa-snapshot.golden.json' with { type: 'json' };
import {
  EXPLORER_SECTIONS_PATH,
  NGWA_SNAPSHOT_PATH,
  V16_MODES,
  findNgwaItem,
  isRouteMissing,
  ngwaScopeKey,
  resolveProjectId,
  routeMissingError,
  type NgwaSnapshot,
} from './nouns.js';

const snap = golden as unknown as NgwaSnapshot;

describe('V16_MODES', () => {
  it('is exactly the v16 rail set', () => {
    assert.deepEqual([...V16_MODES], ['project', 'chi', 'ngwa', 'settings']);
  });
});

describe('resolveProjectId', () => {
  const projects = [
    { id: 'default', root_path: null },
    { id: 'proj-royalti', root_path: 'C:\\Users\\ned\\royalti-co' },
    { id: 'proj-ikenga', root_path: 'C:/Users/ned/ikenga' },
  ];

  it('matches a bare id — including `default` which has no root_path', () => {
    assert.equal(resolveProjectId(projects, 'default'), 'default');
    assert.equal(resolveProjectId(projects, 'proj-royalti'), 'proj-royalti');
  });

  it('matches root_path with separator + trailing-slash normalization', () => {
    assert.equal(resolveProjectId(projects, 'C:/Users/ned/royalti-co'), 'proj-royalti');
    assert.equal(resolveProjectId(projects, 'C:\\Users\\ned\\ikenga\\'), 'proj-ikenga');
  });

  it('falls back to a case-insensitive path match', () => {
    assert.equal(resolveProjectId(projects, 'c:/users/NED/royalti-co'), 'proj-royalti');
  });

  it('errors with the candidate list when nothing matches', () => {
    assert.throws(() => resolveProjectId(projects, 'C:/nowhere'), /no project[\s\S]*proj-royalti/);
  });

  it('errors on an ambiguous path', () => {
    const dup = [
      { id: 'a', root_path: '/x' },
      { id: 'b', root_path: '/x/' },
    ];
    assert.throws(() => resolveProjectId(dup, '/x'), /ambiguous/);
  });
});

describe('ngwa snapshot helpers', () => {
  it('the golden fixture is the wire shape the tools pass through', () => {
    assert.equal((snap.items ?? []).length, 13);
    assert.equal(typeof snap.as_of_ms, 'number');
    assert.ok(snap.sources && typeof snap.sources === 'object');
    for (const item of snap.items ?? []) {
      for (const k of ['id', 'kind', 'state', 'scope', 'origin', 'name']) {
        assert.ok(k in item, `item missing ${k}: ${JSON.stringify(item)}`);
      }
    }
  });

  it('findNgwaItem extracts a known item and errors on a missing one', () => {
    assert.equal(findNgwaItem(snap, 'agent:personal:reviewer').kind, 'agent');
    assert.throws(() => findNgwaItem(snap, 'nope:missing'), /no ngwa item[\s\S]*13 items/);
  });

  it('ngwaScopeKey groups personal vs project-scoped items', () => {
    const keys = new Set((snap.items ?? []).map(ngwaScopeKey));
    assert.ok(keys.has('personal'));
    assert.ok([...keys].some((k) => k.startsWith('project:')));
  });
});

describe('missing-route handling', () => {
  it('detects the client\'s HTTP-404 error string', () => {
    assert.ok(isRouteMissing(new Error('/iyke/ngwa/snapshot returned HTTP 404: not found')));
    assert.ok(!isRouteMissing(new Error('/iyke/ngwa/snapshot returned HTTP 500: boom')));
    assert.ok(!isRouteMissing('nope'));
  });

  it('rewrites 404s into an actionable WP-28 error', () => {
    const e = routeMissingError(
      NGWA_SNAPSHOT_PATH,
      'the HTTP twin of ngwa_snapshot',
      new Error('returned HTTP 404'),
    );
    assert.match(e.message, /WP-28/);
    assert.match(e.message, /\/iyke\/ngwa\/snapshot/);
  });

  it('names the pending routes', () => {
    assert.equal(NGWA_SNAPSHOT_PATH, '/iyke/ngwa/snapshot');
    assert.equal(EXPLORER_SECTIONS_PATH, '/iyke/explorer/sections');
  });
});
