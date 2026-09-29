# @ikenga/pkg-finance

## 0.3.2

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with `pin_on_install: true` (manifest v5).

## 0.3.1

### Patch Changes

- [`70fddec`](https://github.com/Royalti-io/ikenga-pkgs/commit/70fddec5b5ec30324d44d656e0a42b32e120f2d3) Thanks [@nedjamez](https://github.com/nedjamez)! - Outbound: social media/hashtag edits now round-trip (queue + sent mappers read edited_json first, matching the newsletter mapper). Finance/agent-ops: drop the unused engine:invoke grant.

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

## 0.2.0

### Minor Changes

- [#18](https://github.com/Royalti-io/ikenga-pkgs/pull/18) [`913f78f`](https://github.com/Royalti-io/ikenga-pkgs/commit/913f78f1dbf289868eb3de8c653d291131e99ac4) Thanks [@nedjamez](https://github.com/nedjamez)! - WP-20b: Add com.ikenga.finance domain pkg — Overview / Transactions / Receivables / Inter-Company / Reports.

  - No-build srcdoc iframe pkg at packages/apps/finance/
  - Views: Overview (KPI strip + waterfall + treemap + alert strip) / Transactions (ledger + confirm/dispute) / Receivables (aging buckets + invoice table) / Inter-Company (pair queue) / Reports (period summary, export deferred WP-23)
  - Kit classes from the start: .frame* · .stat-card.is-warn/.is-danger · .frame-tab* · .pane-toolbar* · .pane-filterbar* · .badge* · .atelier-state.is-* · .btn\*
  - Domain residue (.fin-\*): KPI internals · runway gauge SVG · treemap · alert strip · ledger table · aging buckets · inter-company queue · entity-switch · btn-confirm/btn-dispute
  - Runway warn at < 12 mo threshold; .is-danger at < 6 mo
  - Deterministic CSS vendoring via scripts/build.mjs (tokens → app-kit → finance-css)
  - Mock contract 1: alert-strip seeded from overdue receivables + unreconciled inter-company entries until 0046 migration lands
  - Owns migration 0046_finance_domain.sql — finance_alerts table (STRICT, no FK, soft TEXT links)
  - data-workspace="files" (dusty warm); tracked gap until dedicated finance tint extended in @ikenga/tokens
  - Depends on: @ikenga/tokens@^0.3.0, 0046_finance_domain.sql (shell WP-20b-schema)

### Patch Changes

- [#18](https://github.com/Royalti-io/ikenga-pkgs/pull/18) [`913f78f`](https://github.com/Royalti-io/ikenga-pkgs/commit/913f78f1dbf289868eb3de8c653d291131e99ac4) Thanks [@nedjamez](https://github.com/nedjamez)! - Wire `requires: [{ kind: "skill", name: "skill-<domain>" }]` into the finance / sales / outbound / content / tasks pane manifests so each pane's in-shell action bar surfaces its domain skill's actions via `list_skill_actions` → the Ọba store. Extends WP-25's mail-only proof to all six domain panes.

- [#18](https://github.com/Royalti-io/ikenga-pkgs/pull/18) [`913f78f`](https://github.com/Royalti-io/ikenga-pkgs/commit/913f78f1dbf289868eb3de8c653d291131e99ac4) Thanks [@nedjamez](https://github.com/nedjamez)! - fix(finance): pane content now scrolls and the sidebar entity filter works.

  - **Scroll**: add `height: 100%` to the root `.frame`. It mounts directly in `#root` without the `.frame-pane-slot` wrapper that supplies `flex: 1`, so the `.frame` had no bounded height and `.frame-body`'s `overflow-y: auto` never engaged — content overflowed the fixed `#root` and was clipped. Mirrors the working sales pane.
  - **Filter**: the `activeFeature` effect only handled view ids and ignored the sidebar `ent-*` Accounts facet items, so the sidebar entity filter was dead. Route `ent-{all,royalti,dixtrit,personal}` → `setEntity`, and reflect the selected entity as the active menu item in `buildFinanceMenu`.
