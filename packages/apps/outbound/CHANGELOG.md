# @ikenga/pkg-outbound

## 0.3.2

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with 2 views, views[0] pinned on install (manifest v5).

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

- [`888be4c`](https://github.com/Royalti-io/ikenga-pkgs/commit/888be4ccb6ef8abfb96a21e6ec164295d2b9ebc7) Thanks [@nedjamez](https://github.com/nedjamez)! - Body editors auto-grow to their content (social base-body, email edit panel) —
  no more fixed 180px/6-row boxes with inner scrollbars; the detail pane scrolls
  as one document. Ships via a new pkg-runtime useAutoGrow hook.

- [`e4266ca`](https://github.com/Royalti-io/ikenga-pkgs/commit/e4266ca4e311399eb151b26481932a9cf8bc4673) Thanks [@nedjamez](https://github.com/nedjamez)! - Runtime extraction: dist/lib bridge/ui/recipe-helper copies are now vendored at
  build from packages/lib/pkg-runtime (single source, per-pkg id injected via a
  generated pkg-id.js; outbound/agent-ops extras appended as fragments). No runtime
  behavior change intended; kills the hand-maintained 9-copy drift and the
  copy-paste source-id bug class.

- [`d53ebef`](https://github.com/Royalti-io/ikenga-pkgs/commit/d53ebeffa946a15eb4d9b595f2a4ee1e348c4c53) Thanks [@nedjamez](https://github.com/nedjamez)! - Fix Social editor silently discarding body edits on Approve: body now persists to
  edited_json on blur and is flushed (blocking on failure) before the approve undo
  countdown arms, so the committed draft always carries the text the user last saw.

## 0.2.0

### Minor Changes

- [`931707d`](https://github.com/Royalti-io/ikenga-pkgs/commit/931707d2c0835321b4fd0347c1d59894ba6e41e4) Thanks [@nedjamez](https://github.com/nedjamez)! - Add `com.ikenga.outbound` domain pkg (WP-19b) — Channels sidebar (Email / Newsletter / Sequences / Social) with approval queue, schedule, and sent views per channel; cooling-period chip; quality score display; A/B variant selector; by-agent filter facets; four `.atelier-state` variants; `host.dbQuery` reads from seven `ikenga.db` tables; `host.dbExec` approve/reject writes; deterministic CSS vendoring via `scripts/build.mjs`.

### Patch Changes

- [#18](https://github.com/Royalti-io/ikenga-pkgs/pull/18) [`913f78f`](https://github.com/Royalti-io/ikenga-pkgs/commit/913f78f1dbf289868eb3de8c653d291131e99ac4) Thanks [@nedjamez](https://github.com/nedjamez)! - Wire `requires: [{ kind: "skill", name: "skill-<domain>" }]` into the finance / sales / outbound / content / tasks pane manifests so each pane's in-shell action bar surfaces its domain skill's actions via `list_skill_actions` → the Ọba store. Extends WP-25's mail-only proof to all six domain panes.
