# Portability notes

`groundwork` is built to scaffold a plan folder into **any** Claude Code
project. A few references in this skill's shipped files point at paths that
only exist in the workspace where the skill was authored
(`ikenga-hq/ikenga`). They are **illustrative**, not requirements — a target
project will not have them, and nothing breaks if they're absent. Per the
locked WP-18 decision this is **document-don't-fix**: the references are
disclosed here rather than rewritten. A future "full-portability" WP can
replace them if adoption warrants.

## 1. `plans/studio` / `plans/groundwork` references in the docs

These are this-workspace examples baked into the skill's prose. Treat any
mention of `plans/studio` or `plans/groundwork` as a sample plan folder —
substitute your own (e.g. `plans/<your-plan>/`). They never need to exist for
the skill to run.

Files carrying these references:

- `SKILL.md` — both `plans/studio` and `plans/groundwork`
- `actions/init.md` — `plans/studio`
- `actions/orchestrate.md` — `plans/studio`
- `actions/review.md` — `plans/studio`
- `actions/subplan.md` — `plans/studio`
- `actions/design.md` — `plans/groundwork`
- `actions/refresh-board.md` — `plans/groundwork`
- `lib/state.md` — `plans/groundwork`
- `profiles/_shared/templates/drafts/README.md` — `plans/studio`
- `profiles/_shared/board/index.html` — both (see runtime fallback below)

## 1b. Commands the skill runs

Every action shells out to `python3 <skill>/scripts/groundwork_state.py <subcommand>`; see "Commands this skill runs" in `skills/groundwork/README.md` for the full list (also `generate_explorer.py`, `generate_plans_index.py`, `watch.py`, and `gh` / `glab` in `issue-sync`).

## 2. Runtime fallback in the standalone board (`profiles/_shared/board/index.html`)

The board template ships with a hardcoded `'plans/groundwork'` **fallback**
used before `groundwork refresh-board` has run against a real plan folder.
Three spots rely on it:

- **`board-meta` fence default** — the `plan_folder` field is seeded with the
  `{{plan_folder}}` mustache placeholder; until `init` / `refresh-board`
  substitutes it, the board has no real plan path.
- **`substituteAction()` fallback** — when building an action card's
  copy-prompt, `{plan_folder}` falls back to `'plans/groundwork'` if the meta
  fence hasn't been refreshed yet.
- **`board-mock-data` block** — the pre-refresh preview data describes the
  authoring workspace's own Studio plan.

**Effect in a target project:** the board still renders standalone and the
copy-prompt floor still works. Until you run `groundwork refresh-board`
against your plan folder, the *cited* path in a copied prompt may read
`plans/groundwork` — illustrative, not a real path in your project. After the
first `refresh-board`, the real `plan_folder` is substituted everywhere and the
fallback is no longer used.

This is recorded as a **known limitation**, deferred to a future portability WP.
