# @ikenga/studio-doctor

## 0.2.2

### Patch Changes

- [#102](https://github.com/ikenga-hq/ikenga-pkgs/pull/102) [`d1f2efc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/d1f2efc185406ca0eec66b6082e54f8760ede32b) Thanks [@nedjamez](https://github.com/nedjamez)! - check.sh finds Chromium the way the Studio sidecar does (explicit path, system browser, or the Puppeteer cache incl. `PUPPETEER_CACHE_DIR`), requires `chrome-headless-shell` on Windows (HyperFrames drives the headless shell there) with an install hint, and probes `python3`/`python`/`py` for a real 3.x interpreter before importing `librosa` — on Windows `python3` is frequently the Store alias stub, which made librosa report MISSING while installed.

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
