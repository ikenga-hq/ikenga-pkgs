# @ikenga/studio-schema

## 0.2.1

### Patch Changes

- [#242](https://github.com/ikenga-hq/ikenga-pkgs/pull/242) [`569e751`](https://github.com/ikenga-hq/ikenga-pkgs/commit/569e751d51ccee5c964ba2f038acad1a86d1f647) Thanks [@nedjamez](https://github.com/nedjamez)! - Docs: drop the retired in-house video engine's repository name. The studio-schema provenance comment now says "a retired in-house video engine", and the three skills' commands and file-layout diagrams use a `<video-engine>` placeholder.

## 0.2.0

### Minor Changes

- [#43](https://github.com/Royalti-io/ikenga-pkgs/pull/43) [`12f7128`](https://github.com/Royalti-io/ikenga-pkgs/commit/12f7128dad658951e44434e4f796e8dd4dabd9c8) Thanks [@nedjamez](https://github.com/nedjamez)! - Add a public `./fountain` export subpath (`@ikenga/studio-schema/fountain`),
  backed by the chunk-based Fountain parser moved here from the studio iframe's
  `lib/fountain.ts` (which is now a re-export shim). The studio project sidecar's
  new `breakdown.run` and the Breakdown pane now segment a script through the
  exact same code — one parser, no drift between what the pane shows and what the
  scaffold generates.

  Exports `parseFountain(raw): FountainDoc` and `writeShotTags(raw, tags): string`,
  plus the types `FountainDoc`, `FountainScene`, `FountainBlock` and
  `FountainBlockKind`. `parseFountain` splits on blank lines and classifies whole
  chunks rather than physical lines, so hard-wrapped prose joins into one
  paragraph; it lifts the `Key: Value` title page (terminated by `===`) out of the
  body into `doc.titlePage` instead of leaking it in as action; and it reads a
  Fountain note `[[sc1_sh1]]` off an action chunk onto `block.tag`.
  `writeShotTags` is the write half — it appends tags by paragraph index, is
  idempotent, and leaves paragraphs it wasn't given byte-for-byte alone.

  Additive: the existing `.` export is unchanged. But this is a real new entry in
  the package's `exports` map (and `fountain.ts` is newly added to `files`), so it
  needs its own release — without it the package stays published with no
  `./fountain` key, and any unbundled consumer importing
  `'@ikenga/studio-schema/fountain'` gets `ERR_PACKAGE_PATH_NOT_EXPORTED`, the
  same class of gap as the `@ikenga/contract` `./canvas` export that broke shell
  dev boot.

  Also adds a `test` script (`node --test`) so the parser's unit tests run under
  `pnpm -r test` in CI.
