# @ikenga/pkg-mail

## 0.3.1

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with `pin_on_install: true` (manifest v5).

## 0.3.0

### Minor Changes

- [`410c2cd`](https://github.com/Royalti-io/ikenga-pkgs/commit/410c2cd0b7409ef1beebcb16e0901989eca18d23) Thanks [@nedjamez](https://github.com/nedjamez)! - Parity sweep (atelier-parity WP-14..17): every dead affordance surfaced by the
  2026-07-02 review is wired or honestly disabled. Highlights — mail: 5 sidebar
  items live (group-by-person/tag, snoozed view, deal/overdue facets) + thread-
  collapse rail + Cmd-F; sales: dispatch-wired approve/confirm buttons, working
  facets, error Retry, forecast bar fix; strategy: provenance-aware drag (fallback
  rows read-only), real progress_pct, authored is_low/is_mid honored, data-model
  aggregates; content: dispatch-seeded creation + calendar/published drill-downs;
  research: personas off real rows, hand-to-sales never silently no-ops, fit/tags
  rendered; finance: Paystack splits panel (+ manifest table grant), ledger-
  computed P&L; outbound: editable newsletter subject/preheader with flush-before-
  approve, preview toolbar + anti-pattern list, SVG sent charts (3 channels),
  bulk-select + date sections + J/K nav on cross-channel approvals, deliverability
  strip, and an actionable notice steering dead in-pane paActions writes to the
  working /outbox/approvals surface.

### Patch Changes

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

## 0.2.1

### Patch Changes

- [`e50666b`](https://github.com/Royalti-io/ikenga-pkgs/commit/e50666b4507b08641d3763ec807960bf82c1889c) Thanks [@nedjamez](https://github.com/nedjamez)! - Fix the mail list not scrolling. `.mail-list` is a grid item in `.pane-split` (a `display:grid; height:100%` container); grid items default to `min-height:auto`, so `.mail-list` couldn't shrink below its content and the inner `.mail-list-scroll` (`flex:1; overflow-y:auto; min-height:0`) never received a bounded height. Adds `min-height:0` to `.mail-list` and regenerates the injected `dist/lib/mail-css.js` string.

## 0.2.0

### Minor Changes

- [`18559db`](https://github.com/Royalti-io/ikenga-pkgs/commit/18559dba776e2f086af0d171495ece9d710112c7) Thanks [@nedjamez](https://github.com/nedjamez)! - Add `com.ikenga.mail` domain pkg (WP-17b) — Inbox / Triage / All / Drafts views over the local `ikenga.db` mail schema, deterministic CSS vendoring, thread-state read/write (mark-read, snooze 4h, tag), and AppBridge `host.dbQuery` / `host.dbExec` data path.
