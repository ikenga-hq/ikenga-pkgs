# @ikenga/storyboard-workflow

## 0.2.2

### Patch Changes

- [#242](https://github.com/ikenga-hq/ikenga-pkgs/pull/242) [`569e751`](https://github.com/ikenga-hq/ikenga-pkgs/commit/569e751d51ccee5c964ba2f038acad1a86d1f647) Thanks [@nedjamez](https://github.com/nedjamez)! - Docs: drop the retired in-house video engine's repository name. The studio-schema provenance comment now says "a retired in-house video engine", and the three skills' commands and file-layout diagrams use a `<video-engine>` placeholder.

## 0.2.1

### Patch Changes

- [`e8ec1a6`](https://github.com/Royalti-io/ikenga-pkgs/commit/e8ec1a64749b0e026796e8cdcb88a8478f34d74d) Thanks [@nedjamez](https://github.com/nedjamez)! - Republish to get these five into the registry catalog.

  All five are on npm but absent from `index.json`, so `ikenga add` cannot see
  them. Registry membership is driven entirely by "appeared in a changesets
  publish AND has a manifest.json", and there is no backfill path other than
  publishing again — the index updater only ever acts on `publishedPackages`.

  Groundwork additionally could not have been catalogued even if it had been in
  a batch: it had no `manifest.json` at all, and its `files` list omitted the
  manifest so the tarball would not have carried one either. Both are fixed here;
  the manifest matches the shape its seven sibling skill pkgs use and validates
  against the contract's `ManifestSchema`.

  No functional change to any of the five — this is a version bump to give the
  release workflow something to publish.

## 0.2.0

### Minor Changes

- [`7c3a9eb`](https://github.com/Royalti-io/ikenga-pkgs/commit/7c3a9eb6d09fd174934d9fe6c88e7007b446e19d) Thanks [@nedjamez](https://github.com/nedjamez)! - First published release of the Studio skill family — the archetype catalog
  (7 archetypes, 36 blocks), the SKILL-only toolchain, beat detection, doctor,
  video script structure, and the storyboard workflow — so the Studio pkg's
  manifest `requires` resolve via npx.
