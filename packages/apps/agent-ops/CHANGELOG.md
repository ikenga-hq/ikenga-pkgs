# @ikenga/pkg-agent-ops

## 0.2.3

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with `pin_on_install: true` (manifest v5).

## 0.2.2

### Patch Changes

- [`3dc1a19`](https://github.com/Royalti-io/ikenga-pkgs/commit/3dc1a197b3f295f4b392170f1d5e352ab2e34064) Thanks [@nedjamez](https://github.com/nedjamez)! - Remove the stray `private: true` that contradicted the package's own
  publishConfig.access:public and kept changesets from ever publishing it —
  the pkg is now on npm like its 8 domain siblings.

- [`70fddec`](https://github.com/Royalti-io/ikenga-pkgs/commit/70fddec5b5ec30324d44d656e0a42b32e120f2d3) Thanks [@nedjamez](https://github.com/nedjamez)! - Outbound: social media/hashtag edits now round-trip (queue + sent mappers read edited_json first, matching the newsletter mapper). Finance/agent-ops: drop the unused engine:invoke grant.

## 0.2.1

### Patch Changes

- [`401232e`](https://github.com/Royalti-io/ikenga-pkgs/commit/401232ec7a7edde928381003ae5ee5b511f385b9) Thanks [@nedjamez](https://github.com/nedjamez)! - CSS moved from 1,424 LOC of hand-escaped strings to a real dist/agent-ops.css
  source with build-time codegen (parity with sibling pkgs); vendored tokens
  refreshed. No behavior change.

- [`ce2e360`](https://github.com/Royalti-io/ikenga-pkgs/commit/ce2e3608d89abcb958c8f47ace6dd3b80b5f5778) Thanks [@nedjamez](https://github.com/nedjamez)! - Declare permissions.engine ["invoke"] in every app manifest (host.sendToActiveSession
  was scope-denied for all pkgs — the field was previously undeclarable). Content gains a
  real dispatch wire (handleAction → sendToActiveSession, lib/dispatch.js); research gains
  working sidebar facet filters (lib/facet-filter.js); sales gains dispatch-seeded create
  buttons (lib/create-dispatch.js) and a bridge source-id fix.

- [`e4266ca`](https://github.com/Royalti-io/ikenga-pkgs/commit/e4266ca4e311399eb151b26481932a9cf8bc4673) Thanks [@nedjamez](https://github.com/nedjamez)! - Runtime extraction: dist/lib bridge/ui/recipe-helper copies are now vendored at
  build from packages/lib/pkg-runtime (single source, per-pkg id injected via a
  generated pkg-id.js; outbound/agent-ops extras appended as fragments). No runtime
  behavior change intended; kills the hand-maintained 9-copy drift and the
  copy-paste source-id bug class.
