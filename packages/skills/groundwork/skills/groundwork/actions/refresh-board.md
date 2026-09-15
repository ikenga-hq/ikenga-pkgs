# action: `refresh-board` — (re)generate `artifact/board.html`

**Loaded when**: the user wants to (re)render the plan-board artifact reflecting current `05` / `09` / `.groundwork.json` state.

**Reads first**: `../lib/state.md`, `05-tracking.md`, `09-orchestration.md` (if it exists), `.groundwork.json`.

**Spine-version**: `expected = "1"`. Runs [`../lib/state.md` §"Spine-version preamble gate"](../lib/state.md#spine-version-preamble-gate) as the first step after loading `.groundwork.json` — writing action (rewrites `board-data` + `board-meta` fences in `artifact/board.html`), so refuses on either direction of mismatch. No-op at v1=current.

**Composes**: `ikenga-artifact-builder` when present (the board is itself a proper Ikenga artifact). Falls back to the self-contained template at `profiles/_shared/board/index.html` when absent — that template is fully working: opens in any browser, renders the plan, copy-prompt works.

---

## What it does

1. **Verify** `.groundwork.json`.
2. **Ensure the `artifact/` skeleton exists.** On first run (when `artifact/` is absent), scaffold:
   - `artifact/manifest.json` from `profiles/_shared/templates/artifact/manifest.json`, substituting `{{plan_slug}}` (derived from the plan folder name) + `{{goal}}` from `.groundwork.json`. **The manifest should leave `notes.enabled` unset (defaults to `true`)** so the auto-wired 💬 comment button appears on the board — users can leave element-attached notes that route back to the chat session in-shell (G7).
   - `artifact/data/` (empty dir, `.gitkeep` placeholder) — for optional external data sources referenced via `manifest.dataSources`.
   - `artifact/assets/` (empty dir, `.gitkeep` placeholder + a one-line `README.md`) — for non-code artifacts the living spec or the board embeds: logos, screenshots, brand marks, exported diagrams. `general` profile plans use it more than `software` ones; the directory is cheap to scaffold regardless.
   - The board template itself is written to `artifact/board.html` (not `index.html` — `index.html` is reserved for the *living spec*, which is hand-authored).
   Register all four in `.groundwork.json.docs` with their initial hashes (assets/README.md tracked as a hand-authored file).
3. **Build the board data model** — get the base model from the script (`groundwork_state.py board-data --plan <plan>`), which derives `plan` / `gates` / `wps` / `designs` / `subplans` / `research` from the anchor + `01`. Enrich it with the per-WP `brief` text extracted from `09-orchestration.md` and the `decisions`/`coverage`/`waves` views the board needs. The shape:
   ```json
   {
     "plan": { "title": "<from 01>", "profile": "software", "goal": "<from .groundwork.json>" },
     "gates":   [{ "id": "G-SCHEMA", "wp": "WP-02", "label": "Schema frozen", "status": "passed" }, …],
     "wps":     [{ "id": "WP-01", "title": "…", "repo": "…", "wave": 0, "deps": [], "status": "in_progress", "gate": "G-CANVAS", "brief": "<extracted from 09 §WP-01>" }, …],
     "waves":   [{ "n": 0, "label": "Wave 0 · Gates", "sub": "sequential" }, …],
     "subplans": [{ "path": "06-canvas-extraction.md", "archetype": "diff-plan", "ref": "WP-01", "status": "active" }, …],
     "decisions": [{ "round": 4, "n": 1, "note": "Board B locked as default + A toggle" }, …],
     "coverage":  [{ "phase": "P1", "designs": 1, "of": 1, "ok": true }, …],
     "research":  { "external_stamped": "2026-05-20", "internal_stamped": "2026-05-20" }
   }
   ```
   The `subplans` array mirrors `.groundwork.json.subplans`. It surfaces two ways on the board: (a) a sub-plan whose `ref` matches the selected WP appears inside that WP's detail card ("WP-09 has a diff-plan at `06-startSeededChat-extraction.md`"); (b) **every** sub-plan — including `ref: null` cross-cutting ones (decision-docs / bug-docs not tied to a WP) — appears in the right-rail "Sub-plans" cross-cutting section, archetype-tagged, with its `ref` (or "cross-cutting") and a status badge for non-active ones. Pass the full list including `landed` / `abandoned` sub-plans so the rail can show them with a status badge; don't pre-filter.
4. **Render the board**:
   - **If `ikenga-artifact-builder` is installed** → invoke it via the `Skill` tool with archetype `dashboard` and the data model as `provided_data`. Place the output at `artifact/board.html`.
   - **Else** → copy `profiles/_shared/board/index.html` (the canonical template) to `artifact/board.html` and inject the data model into the `board-data` fenced block.
   The artifact's `index.html` (living spec) is NEVER touched by this action — that's a hand-authored doc; `refresh-board` only owns `board.html` + `manifest.json` (initial scaffold) + `data/` + `assets/` (initial scaffold).
5. **Register** `artifact/board.html` in `.groundwork.json.docs` with two fenced regions: `board-data` (the JSON model) and `board-meta` (plan title, profile, `plan_folder` (e.g. `plans/groundwork`), `plan_slug` (basename of `plan_folder`), goal, `orchestrated_at`, last-refresh stamp). `plan_folder` + `plan_slug` are read by the board's Kickoff card (WP-20) for orchestrator-brief placeholder substitution; the canonical template carries `{{plan_folder}}` / `{{plan_slug}}` placeholders that `refresh-board` substitutes at write-time. Also write **`work_unit`** — the profile's `labels.work_unit` from `groundwork_state.py resolve-profile --profiles-root <skill>/profiles --name <profile>` (e.g. `"sequence"` for film). The board fills `{work_unit}` in the Kickoff brief from it at runtime, the same single-brace way it fills `{plan_folder}`, and falls back to a built-in per-profile label when the field is absent. The template's copy-prompts must use single-brace runtime tokens only: a `{{vocab.*}}` token in `board.html` is never substituted and reaches the user verbatim. **`orchestrated_at`** (Round 8) is the date-portion of `.groundwork.json.orchestrate.last_run` (or omitted/null if orchestrate has never run); the board's PageHead collapses the full Kickoff card to a slim "Re-kickoff" button when it's present, saving header real estate on warm boards.
6. **Show drift indicator**: compute "files changed since last refresh" by comparing the docs' on-disk hashes against the values from the last `refresh-board.last_run`. Embed in the board's right rail.
7. **Sync Explorer & Open/Return Artifact**:
   - If `artifact/explorer.html` exists (or `--explorer` is passed), also run `python3 <skill>/scripts/groundwork_state.py explorer-data --plan <plan>` and update the `explorer-data` fence in `artifact/explorer.html`.
   - **Open/Return**: Output the clickable links `file://<absolute-path>/artifact/explorer.html` and `file://<absolute-path>/artifact/board.html`. In the shell / webview host, open `artifact/explorer.html` (or `artifact/board.html`) so the user immediately views the refreshed plan board.

---

## The board UI (locked Round 4)

**Default layout — Mission Control (B):**
- Dense per-WP table: id · title · repo/owner · wave · needs · status · actions.
- Freeze-gate banner across the top.
- Status filter chips (`all` / `in_progress` / `blocked` / `queued` / `done`).
- Right rail: decisions log · design-coverage by phase · research freshness.

**Toggle layout — Wave Board (A):**
- Waves as columns, cards flow L→R, gates as checkpoint chips.
- Same WP data; different framing.

The toggle is a button in the header; layout choice persists in `art.publishState` (`{ board: { layout: 'mission-control' | 'waveboard' } }`).

**Both layouts are in the same single-file artifact.** The fallback template at `profiles/_shared/board/index.html` ships both views side-by-side; the user switches with a click.

---

## Per-WP card actions (P1)

- **Copy brief** — copies the WP brief (extracted from `09-orchestration.md` §WP-NN) to clipboard. Works everywhere. **The floor.**
- **Start session** — Ikenga-only, lights up if the host advertises `host.startChatSession`. **Phase 2.** In P1 the button is rendered but disabled with a tooltip "click-to-implement lands in Phase 2; for now, copy the brief and paste into a session."

The fallback template's "Start session" button defensively no-ops outside the shell — when there's no parent or the parent doesn't acknowledge the `host.startChatSession` postMessage, it falls back to copy-prompt and flashes a toast. Phase 2 wires the verb; nothing in the template needs to change.

---

## In-shell behavior (today, even before Phase 2)

The board is a normal Ikenga artifact. It reads `art.publishState`, so the shell can already inspect its current `{ filter, selected, layout }` via `iyke iframe-state <pane>`. The Phase-2 work adds the *action* channel (`host.startChatSession`); the *view* channel works today.

---

## Re-run semantics

Per `lib/state.md`:

- The whole-file artifact is rewritten when any input doc's hash changes; otherwise it's a no-op.
- The `board-data` fence content is what carries the hash; the surrounding HTML scaffold is constant per template version.
- Bumping the template version (a new release of this skill) triggers a one-time scaffold rewrite — the action notes it in the report.

---

## Where the briefs come from

The board's "Copy brief" button needs each WP's brief text. The data model carries `wps[i].brief` extracted from `09-orchestration.md` §WP-NN. If `09` doesn't exist yet, the brief defaults to a stub (`"Run groundwork orchestrate to generate the full brief for <WP>."`). The board is still useful pre-orchestrate — it shows the plan even without briefs.

---

## Notes on the board *(G7 — element-attached feedback)*

In-shell, the artifact-builder's auto-wired 💬 button lets the user click any element of the board (a WP row, a gate chip, a decision entry) and attach a free-form note. Notes route back to the originating chat session with a marker linking artifact + element selector. **The board's manifest leaves `notes.enabled` unset (defaults to `true`)** so this is on by default.

There's no "check-notes" action mode for the board (unlike the design action) — board notes are conversational by nature; the agent sees them in the chat thread as they arrive. The board's job is to make leaving notes *easy*; the agent's job is to react to them in chat.

For users who want to disable comments (e.g. a printable / read-only board), set `manifest.notes = { "enabled": false }` by hand after `refresh-board` runs. The action won't reset it on next refresh.

## Pin-on-first-mount *(G8)*

The locked board calls `art.pin()` once on first mount (idempotent via `art.state.get('pinned')` check). This nudges the shell to surface the board in the activity bar — useful since the board is meant to be returned to throughout a run. Outside the shell, `art.pin` is a no-op (the bridge polyfill stubs it).

## Edge cases

- **No `05-tracking.md` WPs yet** — render the board with zero WPs and a "no work packages defined" empty state. Plan title + goal still render.
- **No `09` yet** — see above; briefs degrade to a stub.
- **`ikenga-artifact-builder` invocation fails** — fall back to the static template; warn the user.
- **`artifact/board.html` exists with hand edits outside fences** — preserve them (the template's HTML scaffold is the "outside" — but in practice users won't edit a generated artifact; the safe default is to refuse with a `--force` escape hatch if hand edits are detected inside the scaffold).

---

## Click-to-fire prompt

The canonical strings the FE emits (palette per WP-21). `refresh-board` is a **read-action** in the WP-21 sense — when invoked from the palette in-shell, it routes through `art.sendToActiveSession` (per WP-22) rather than minting a fresh session, so the user sees the regeneration land in the current thread. (Note: the action *itself* writes to disk; it's a "read" only from the palette's session-routing perspective.) Substitution variables: `{plan_folder}`, `{plan_title}`.

**Standalone slash form**:

```
/groundwork refresh-board
```

**Seeded-session form**:

```
Run groundwork refresh-board on `{plan_folder}` (plan title: {plan_title}).

If the groundwork skill is loaded in this session, follow its `refresh-board` action verbatim — read `.claude/skills/groundwork/actions/refresh-board.md`, build the board data model from `05-tracking.md` + `09-orchestration.md` + `.groundwork.json`, and write it into the `board-data` generated-region fence inside `{plan_folder}/artifact/board.html` (scaffolding the artifact directory on first run). If the skill is not loaded, read those same files, construct the board JSON, and inject it into the `<!-- groundwork:auto:start board-data -->` fence in `artifact/board.html` directly.

Preserve hand-authored prose outside fences byte-identical.
```
