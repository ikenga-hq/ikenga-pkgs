# @ikenga/studio-toolchain

## 0.2.2

### Patch Changes

- [#242](https://github.com/ikenga-hq/ikenga-pkgs/pull/242) [`569e751`](https://github.com/ikenga-hq/ikenga-pkgs/commit/569e751d51ccee5c964ba2f038acad1a86d1f647) Thanks [@nedjamez](https://github.com/nedjamez)! - Docs: drop the retired in-house video engine's repository name. The studio-schema provenance comment now says "a retired in-house video engine", and the three skills' commands and file-layout diagrams use a `<video-engine>` placeholder.

## 0.2.1

### Patch Changes

- [#43](https://github.com/Royalti-io/ikenga-pkgs/pull/43) [`55eca7e`](https://github.com/Royalti-io/ikenga-pkgs/commit/55eca7e770e2ba5de470db9fb8670fecbf73a94a) Thanks [@nedjamez](https://github.com/nedjamez)! - Widen the `@ikenga/studio-schema` peer range to `^0.1.0 || ^0.2.0`. schema's
  0.2.0 is purely additive (a new `./fountain` export subpath, nothing removed),
  so the old `^0.1.0` range — which a caret excludes 0.2.0 from on 0.x — was
  needlessly narrow and would have forced a spurious major bump on both packages
  for a change that does not affect them.

## 0.2.0

### Minor Changes

- [`7c3a9eb`](https://github.com/Royalti-io/ikenga-pkgs/commit/7c3a9eb6d09fd174934d9fe6c88e7007b446e19d) Thanks [@nedjamez](https://github.com/nedjamez)! - First published release of the Studio skill family — the archetype catalog
  (7 archetypes, 36 blocks), the SKILL-only toolchain, beat detection, doctor,
  video script structure, and the storyboard workflow — so the Studio pkg's
  manifest `requires` resolve via npx.
