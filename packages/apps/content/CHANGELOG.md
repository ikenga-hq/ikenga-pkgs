# @ikenga/pkg-content

## 0.4.1

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with `pin_on_install: true` (manifest v5).

## 0.4.0

### Minor Changes

- [`4c6a2b4`](https://github.com/Royalti-io/ikenga-pkgs/commit/4c6a2b4b608b41cd4ebaed5a1426d4f2463c4db6) Thanks [@nedjamez](https://github.com/nedjamez)! - Operator identity now comes from hostContext.operator instead of a hardcoded handle. "Mine" filters, owner fallbacks, and avatar initials derive from the shell-provided operator; when absent, dispatch ux_mode fails safe to 'confirm' (never 'silent' for an unknown operator).

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

- [#18](https://github.com/Royalti-io/ikenga-pkgs/pull/18) [`913f78f`](https://github.com/Royalti-io/ikenga-pkgs/commit/913f78f1dbf289868eb3de8c653d291131e99ac4) Thanks [@nedjamez](https://github.com/nedjamez)! - WP-21b: Add `com.ikenga.content` domain pkg — Pipeline (kanban default + list toggle), Calendar, Published views over `content_pieces` / `content_calendar` / `social_queue` / `calendar_events`. Owns migration 0047_content_domain.sql (STRICT, no FK). Implements the `kind:'seg'` contract (second consumer after sales).

### Patch Changes

- [#18](https://github.com/Royalti-io/ikenga-pkgs/pull/18) [`913f78f`](https://github.com/Royalti-io/ikenga-pkgs/commit/913f78f1dbf289868eb3de8c653d291131e99ac4) Thanks [@nedjamez](https://github.com/nedjamez)! - Wire `requires: [{ kind: "skill", name: "skill-<domain>" }]` into the finance / sales / outbound / content / tasks pane manifests so each pane's in-shell action bar surfaces its domain skill's actions via `list_skill_actions` → the Ọba store. Extends WP-25's mail-only proof to all six domain panes.
