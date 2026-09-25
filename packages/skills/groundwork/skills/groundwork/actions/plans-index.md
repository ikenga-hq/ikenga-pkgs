# action: `plans-index` — (re)generate `<plans-dir>/_index.html`

**Loaded when**: the user wants a **cross-plan** overview — one card per groundwork plan under a `plans/` directory, with status rollups and drill-in to each plan's explorer / board. Triggers: "groundwork plans-index", "index all the plans", "plans overview", "show me every plan in this project", "plan dashboard".

**Reads first**: `../lib/state.md`, and each child plan's `.groundwork.json` (via the script — read-only; the index never writes into any plan).

**Spine-version**: this action does not touch any single plan's anchor, so there is no per-plan spine gate. It reads each plan's anchor defensively (skips corrupt/foreign dirs).

**Composition**: self-contained Ikenga artifact (own inline manifest, `id: groundwork-plans-index`). Like the per-plan explorer, it does **not** compose `ikenga-artifact-builder` — no matching archetype; the static template is canonical.

---

## Relation to the per-plan `explorer`

The cross-plan index is the **zoom-out sibling** of `groundwork explorer`:

| | `explorer` (per-plan) | `plans-index` (cross-plan) |
|---|---|---|
| Scope | one plan folder | every plan under a `plans/` dir |
| Output | `<plan>/artifact/explorer.html` | `<plans-dir>/_index.html` |
| Owned by | that plan's `.groundwork.json` (`explorer-data`/`explorer-meta` fences, via `write-region`) | **no anchor** — it spans many plans; written via `write-region-plain` |
| Drill-in | opens board/spec/designs as tabs | each card opens that plan's **Explorer / Board / Spec** |

Because `_index.html` belongs to no single plan, it is **not** recorded in any `.groundwork.json` and uses the anchorless `write-region-plain` (idempotent: skips the write when the rollup is unchanged). It never modifies the plans it lists.

---

## What it does

1. **Resolve the plans dir** — the argument (`groundwork plans-index <dir>`) or the current directory if it directly contains plan folders (child dirs with a `.groundwork.json`). If no child is a groundwork plan, say so and stop.
2. **Build the model** — `python3 <skill>/scripts/groundwork_state.py plans-index-data --plans-dir <dir>` → `{ root, plans[], stats }`. Each `plans[]` entry is a metadata-only rollup (no doc embedding — cheap even for 28-plan dirs): `slug` · `title` · `profile` · `goal` · `updated` · `wps{total,done,in_progress,blocked,queued}` · `gates{total,…}` · `designs{total,locked,…}` (counts `D-NN` when the plan has any: `total, locked, planned, drafted, in_progress, implemented, verified, unlinked`; plans with only legacy file registrations keep `{total, locked}` over files) · `subplans{total,active}` · `research` · `drift` (any tracked doc whose on-disk hash diverged) · `has{board,explorer,livingspec}`.
3. **First run** (when `<dir>/_index.html` is absent): copy `profiles/_shared/plans-index/index.html` → `<dir>/_index.html`. The `plans-index-meta` fence carries `{{index_title}}`; step 4 fills it.
4. **Write the two fences** via the anchorless writer, **always with `--html-script-safe`** (the fences sit inside `<script type="application/json">`, so a plan title/goal containing `<`/`</script>` must be escaped or it breaks the page):
   - `write-region-plain --file <dir>/_index.html --id plans-index-data --content-file <model.json> --html-script-safe`
   - `write-region-plain --file <dir>/_index.html --id plans-index-meta --content-file <meta.json> --html-script-safe` where meta = `{ "title": "<project> · plans", "root_rel": ".", "refreshed": "<today>" }`. `root_rel` is `"."` because `_index.html` sits at the plans-dir root and each plan is a child dir, so a card's links are `<slug>/artifact/explorer.html` etc.
5. **Report** the path + `stats` (N plans · WPs done/total · drifted) + a hint: `open <dir>/_index.html`.

On a **(re)scaffold** run, both `write-region-plain` calls write cleanly (no anchor, no dirty check beyond content equality). On a pure refresh, each fence is rewritten only if the rollup changed; the meta line's timestamp is excluded from the equality check, so an unchanged project is a true no-op.

---

## The index UI

- **Cards** — one per plan: title + profile chip + drift dot, goal (2-line clamp), a **WP progress bar** (done / in-progress / blocked / queued segments), a meta row (gates · designs+locked · subplans · updated), and three drill-in buttons: **Explorer** (→ `<slug>/artifact/explorer.html`), **Board** (→ `artifact/board.html`), **Spec** (→ `artifact/index.html`) — each disabled if that artifact doesn't exist yet (run `groundwork explorer` / `refresh-board` in that plan to light it up). In-shell the buttons route an "open this" note to the active session; standalone they open the artifact in a new tab.
- **Header** — project name, aggregate stats (N plans · WPs done/total · drifted count), a **search** box (title/slug/goal), profile **filter chips**, a **drift-only** toggle, and **sort** (recent / progress / name).
- **Theme** — the same `data-theme`/`data-mode` shell handshake as the board and explorer.

Standalone vs. in-folder: opened from `<plans-dir>/_index.html` (served or in-shell) the drill-in links resolve to the real plan artifacts. As a lone uploaded file the cards + rollups still render fully (all data is embedded); only the drill-in links need the real folder.

---

## Automation & live refresh

- **Run it deterministically**: `python3 <skill>/scripts/generate_plans_index.py --plans-dir <dir>` performs this action byte-for-byte (model → scaffold → both fences via `write-region-plain`).
- **Backfill the per-plan explorers first** so every card's **Explorer** button is live: `python3 <skill>/scripts/generate_explorer.py --all-under <dir> --missing-only`, then regenerate the index.
- **Live refresh**: `python3 <skill>/scripts/watch.py --plans-dir <dir>` keeps the index (and any changed plan's explorer) fresh as files change; the served page live-reloads itself.
- **Fully offline**: the template inlines its libs and is pre-transpiled (no CDN at runtime); rebuild from `profiles/_shared/plans-index/index.src.html` via `node scripts/build-offline-artifacts.mjs` — never hand-edit the built `index.html`.

## Edge cases

- **Empty / no groundwork plans under the dir** — render the empty state ("No groundwork plans … under this directory yet").
- **A plan with a corrupt or foreign `.groundwork.json`** — skipped silently (not a groundwork plan).
- **A plan with no `artifact/explorer.html` yet** — its Explorer button is disabled; Board/Spec likewise. Nothing breaks.
- **Nested plans dirs** (`.company/technical/plans/…`) — point the action at the dir whose *immediate children* are the plans; the scan is one level deep by design.

---

## Click-to-fire prompt

Substitution variables: `{plans_dir}`, `{project}`.

**Standalone slash form**:

```
/groundwork plans-index {plans_dir}
```

**Seeded-session form**:

```
Run groundwork plans-index on `{plans_dir}`.

If the groundwork skill is loaded, follow its `plans-index` action verbatim — build the model with `groundwork_state.py plans-index-data --plans-dir {plans_dir}`, copy `profiles/_shared/plans-index/index.html` to `{plans_dir}/_index.html` on first run, and write the model into the `plans-index-data` + `plans-index-meta` fences via `write-region-plain` (anchorless).

If the skill is not loaded: for each immediate child dir of `{plans_dir}` that contains a `.groundwork.json`, read it and build a rollup { slug, title, profile, goal, updated, wps{done/total/…}, gates, designs, subplans, drift, has{board,explorer,livingspec} }; copy the template to `{plans_dir}/_index.html`; inject `{ root, plans[], stats }` into the `<!-- groundwork:auto:start plans-index-data -->` fence and `{ title, root_rel: ".", refreshed }` into `plans-index-meta`.

The index never writes into the plans it lists. Preserve hand-authored prose outside fences byte-identical.
```
