# @ikenga/pkg-tasks

## 0.8.4

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with `pin_on_install: true` (manifest v5).

## 0.8.3

### Patch Changes

- [`ce2e360`](https://github.com/Royalti-io/ikenga-pkgs/commit/ce2e3608d89abcb958c8f47ace6dd3b80b5f5778) Thanks [@nedjamez](https://github.com/nedjamez)! - Declare permissions.engine ["invoke"] in every app manifest (host.sendToActiveSession
  was scope-denied for all pkgs — the field was previously undeclarable). Content gains a
  real dispatch wire (handleAction → sendToActiveSession, lib/dispatch.js); research gains
  working sidebar facet filters (lib/facet-filter.js); sales gains dispatch-seeded create
  buttons (lib/create-dispatch.js) and a bridge source-id fix.

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

- [`e4266ca`](https://github.com/Royalti-io/ikenga-pkgs/commit/e4266ca4e311399eb151b26481932a9cf8bc4673) Thanks [@nedjamez](https://github.com/nedjamez)! - Runtime extraction: dist/lib bridge/ui/recipe-helper copies are now vendored at
  build from packages/lib/pkg-runtime (single source, per-pkg id injected via a
  generated pkg-id.js; outbound/agent-ops extras appended as fragments). No runtime
  behavior change intended; kills the hand-maintained 9-copy drift and the
  copy-paste source-id bug class.

## 0.8.2

### Patch Changes

- [#18](https://github.com/Royalti-io/ikenga-pkgs/pull/18) [`913f78f`](https://github.com/Royalti-io/ikenga-pkgs/commit/913f78f1dbf289868eb3de8c653d291131e99ac4) Thanks [@nedjamez](https://github.com/nedjamez)! - Wire `requires: [{ kind: "skill", name: "skill-<domain>" }]` into the finance / sales / outbound / content / tasks pane manifests so each pane's in-shell action bar surfaces its domain skill's actions via `list_skill_actions` → the Ọba store. Extends WP-25's mail-only proof to all six domain panes.

- [`e0f89ad`](https://github.com/Royalti-io/ikenga-pkgs/commit/e0f89adc7b0e522e3d50d8dc9fd39ad00b8206d1) Thanks [@nedjamez](https://github.com/nedjamez)! - Publish the mounted view + open-task selection to the shell's iyke iframe-state registry (`{__iyke, kind:'state'}` postMessage), so `iyke state` / `iyke iframe-state` report what's open in the pane without DB spelunking. New `publishIykeState(key, value)` helper in lib/bridge.js.

## 0.8.1

### Patch Changes

- Republish with `manifest.json` version synced to the npm version. Previous
  tarballs shipped a stale manifest version, so the shell recorded the old
  version after every update and re-offered the same update forever.
  (`@ikenga/pkg-tasks` also catches its npm version up to the manifest's 0.8.x
  line — npm history jumps 0.4.1 → 0.8.1.)

## 0.4.1

### Patch Changes

- [#15](https://github.com/Royalti-io/ikenga-pkgs/pull/15) [`8f9cf3f`](https://github.com/Royalti-io/ikenga-pkgs/commit/8f9cf3f396c06064a876409e2325f42c3262b225) Thanks [@nedjamez](https://github.com/nedjamez)! - P3 increment 2: automate the token vendoring (kill the drift inc-1 only moved).

  `dist/lib/tokens-css.js` and `dist/lib/tasks-css.js` are no longer hand-maintained.
  A new `scripts/build.mjs` (wired as the pkg `build`) **copies** `tokens-css.js` from the
  installed `@ikenga/tokens` — now a real `^0.3.0` devDependency, so it can never drift from
  the published tokens — and **codegens** `tasks-css.js` from `dist/tasks.css` via one
  `JSON.stringify` escape (replacing the hand-escaped mirror). A CI `git diff --exit-code`
  drift-guard (after `pnpm -r build`) fails any pkg whose committed `dist/` diverges from a
  fresh build. No visual change: the generated `tokens-css.js` is byte-identical to the
  published `@ikenga/tokens@0.3.0`, and the regenerated `tasks-css.js` decodes to the same CSS.

- [#17](https://github.com/Royalti-io/ikenga-pkgs/pull/17) [`271253f`](https://github.com/Royalti-io/ikenga-pkgs/commit/271253fc214aff2c65325db4be6f5682d664d49a) Thanks [@nedjamez](https://github.com/nedjamez)! - P3 retrofit (increment 3): adopt the @ikenga/tokens app-kit primitives; delete the
  33 KB tasks-css.js mirror's primitive bulk.

  `scripts/build.mjs` now also vendors `@ikenga/tokens/app-kit-css` into `dist/lib/`
  (the same deterministic copy as `tokens-css.js`), and `app.js` injects it in cascade
  order tokens → app-kit → tasks-residue. The pixel-identical `.tk-*` primitives are
  renamed to their canonical kit classes in the markup and their (now duplicate) rules
  removed from `tasks.css`:

  - `.tk-frame*` → `.frame*` (pkg-pane-frame)
  - `.tk-det-head/topline/title/body` → `.ip-head/topline/title/body`, `.tk-desc` →
    `.ip-desc`, `.tk-progress` (+span) → `.ip-progress`/`.ip-progress-fill`,
    `.tk-action-bar` → `.ip-action-bar` (inspector-detail)
  - `.tk-row` + children → `.dense-row.dense-row--task` + `.dense-row-{dot,body,title,right,due}`
  - `.tk-badge` and `.tk-execmode` are byte-identical in the kit, so their tasks-local
    copies are removed (markup unchanged)

  Conservative / pixel-exact: only primitives whose kit rule renders byte-identical to
  the shipped `.tk-*` were adopted. The divergent ones stay as labelled domain residue
  (the local button, filter bar, master/detail split shell, group divider, the inspector
  field-grid / meta-row / timeline, and the inline feedback states), so there is no
  visible delta. Verified live in the running shell (iyke before/after, dark + light;
  the pane is density-insensitive) — pixel-identical.

  `tasks.css`: 1048 → 774 lines; the regenerated `dist/lib/tasks-css.js` drops
  33,453 → 26,542 bytes. Build is deterministic (`pnpm -r build && git diff --exit-code`).

- [#15](https://github.com/Royalti-io/ikenga-pkgs/pull/15) [`a1546f4`](https://github.com/Royalti-io/ikenga-pkgs/commit/a1546f487ca3bd398a0e6a73741e08e628ae3e2f) Thanks [@nedjamez](https://github.com/nedjamez)! - P3 retrofit (increment 1): consume the reconciled @ikenga/tokens; drop the aliasCss shim.

  `dist/lib/tokens-css.js` is updated to @ikenga/tokens@0.3.0 (the atelier-design-system
  P0 reconciliation — warm `--live`/`--agent`, `--live-fg`, `data-density`, motion,
  Fraunces/Inter). With those tokens defined natively, the hand-maintained `aliasCss`
  shim in `app.js` (`--live`→`--success`, `--font-body`→`--font-sans`, `--motion-fast:120ms`, …)
  is no longer needed and is removed. Verified rendering in the running shell (Dusk Wood;
  `--live` green / danger / systemic all resolve correctly).

  Follow-up (increment 2): automate the tokens vendoring (build-time copy from
  `@ikenga/tokens/dist`) and adopt the app-kit primitives (replace the tasks.css `.tk-*`
  primitives with the kit + a slim domain residue).

## 0.4.0

### Minor Changes

- [`7ba2d0f`](https://github.com/Royalti-io/ikenga-pkgs/commit/7ba2d0f44303c82db92c730e41c5d669d07e8602) Thanks [@nedjamez](https://github.com/nedjamez)! - Add a real Create form and wire up Reassign in the Tasks pkg, both writing to
  the local pa.db via `host.dbExec`.

  - **Create**: a new inline form (title / owner / priority / due + optional
    description) does a parameterized `INSERT INTO tasks` (client uuid, ISO
    stamps, status `pending`). The old agent-dispatch path is kept as a secondary
    "Send to your Chi" action alongside the direct create.
  - **Reassign**: the previously dead Reassign button now opens an assignee picker
    that `UPDATE`s `assigned_to` / `assignee_type` (and bumps `updated_at`).
  - New `lib/assignees.js` centralises the assignee roster (`CURRENT_USER` +
    `AGENT_ROSTER`) shared by the create owner field and the reassign picker — the
    seam the accompanying skill's setup step will configure per project.

  No manifest change: both writes target only `tasks`, already declared in
  `permissions["sqlite.tables"]`.

- [`5f4a605`](https://github.com/Royalti-io/ikenga-pkgs/commit/5f4a605ec7ab9e2e2c2b678ee219890a21124608) Thanks [@nedjamez](https://github.com/nedjamez)! - Remove the supabase-js dependency from the Tasks pkg. The status-update write
  now goes through the host's `host.dbExec` verb (local pa.db) like the reads
  already do via `host.dbQuery`, so the pkg no longer declares the `supabase`
  capability, `supabase.tables` permission, or supabase network/CSP access.
