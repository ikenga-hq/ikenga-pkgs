/**
 * In-memory host for provider and spend-gate tests (mock contract 4): only
 * the wave-1 subset `readState` / `writeState` / `storeAsset`.
 *
 * `storeAsset` keeps the bytes in memory and returns an Asset with a
 * `mem://assets/<filename>` uri. With `registerOnStore: true` it also adds the
 * asset to state, as a host is allowed to; callers must work either way.
 * Every call is logged, so tests can prove what a code path touched.
 */

import type { AkukoProject, AkukoProjectInput, Asset } from '../../schema/akuko-project.ts';
import { AkukoProjectSchema } from '../../schema/akuko-project.ts';
import type { AssetInput, WaveOneHost } from '../contract.ts';

export interface FakeHost extends WaveOneHost {
  readonly calls: string[];
  readonly files: Map<string, Uint8Array>;
  /** Current state without logging a read. */
  peek(): AkukoProject;
  /** Replace state without logging a write. */
  set(p: AkukoProject): void;
  /** Writes since the last reset. */
  writes(): number;
}

export function createFakeHost(initial: AkukoProject, opts: { registerOnStore?: boolean } = {}): FakeHost {
  let state: AkukoProject = structuredClone(initial);
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>();
  let n = 0;
  return {
    calls,
    files,
    peek: () => structuredClone(state),
    set: (p) => { state = structuredClone(p); },
    writes: () => calls.filter((c) => c === 'writeState').length,
    async readState() {
      calls.push('readState');
      return structuredClone(state);
    },
    async writeState(p) {
      calls.push('writeState');
      state = AkukoProjectSchema.parse(structuredClone(p));
    },
    async storeAsset(a: AssetInput): Promise<Asset> {
      calls.push('storeAsset');
      const id = a.id ?? `asset-${++n}`;
      const uri = `mem://assets/${a.filename}`;
      files.set(uri, a.data);
      const asset: Asset = {
        id,
        kind: a.kind,
        stage: state.current_stage,
        status: 'pending-review',
        comments: [],
        tags: a.tags ?? [],
        file: { uri, mime: a.mime },
        ...(a.owner !== undefined ? { owner: a.owner } : {}),
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.provider !== undefined ? { provider: a.provider } : {}),
        ...(a.model !== undefined ? { model: a.model } : {}),
      };
      if (opts.registerOnStore) {
        state = { ...state, assets: [...state.assets.filter((x) => x.id !== id), asset] };
      }
      return structuredClone(asset);
    },
  };
}

/** A small valid project: two shots in one scene, one character with a planned portrait. */
export function tinyProject(over: Partial<AkukoProjectInput> = {}): AkukoProject {
  return AkukoProjectSchema.parse({
    format: 'akuko',
    schema_version: 1,
    project: { slug: 'tiny', title: 'Tiny', profile: 'film', created_at: '2026-11-01T00:00:00Z' },
    current_stage: 'keyframes',
    scenes: [{ id: 'sc1' }],
    shots: [
      { id: 'sc1_sh1', stage: 'sketch', status: 'approved', scene: 'sc1', prompt: 'A long dark hallway' },
      { id: 'sc1_sh2', stage: 'sketch', status: 'approved', scene: 'sc1', prompt: 'A hand on a latch' },
    ],
    bible: { characters: [{ id: 'char_n', stage: 'bible', status: 'approved', name: 'Narrator' }] },
    assets: [{ id: 'char_n_portrait', stage: 'bible', status: 'pending', kind: 'portrait', owner: 'char_n' }],
    ...over,
  });
}

/** A small PNG-ish payload (contents do not matter to the in-memory host). */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
