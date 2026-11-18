# action: `explorer` — (re)generate `artifact/explorer.html`

**Loaded when**: the user wants to browse the whole plan folder as a file explorer — a left file-tree + a right tabbed, type-dispatched viewer (markdown / iframe / image / pdf / json / code). Triggers: "groundwork explorer", "browse the plan files", "open the plan folder", "make a file explorer for this plan".

**Reads first**: `../lib/state.md`, `.groundwork.json`, and (via the script) the spine + sub-plans + `designs`/`subplans`/`ids` registries.

**Spine-version**: `expected = "1"`. Runs [`../lib/state.md` §"Spine-version preamble gate"](../lib/state.md#spine-version-preamble-gate) as the first step after loading `.groundwork.json` — writing action (rewrites the `explorer-data` + `explorer-meta` fences in `artifact/explorer.html`), so refuses on either direction of mismatch. No-op at v1=current.

**Composition**: `explorer.html` is a self-contained Ikenga artifact with its **own** inline manifest (`id: groundwork-explorer`). It does **not** compose `ikenga-artifact-builder` — there is no file-explorer/explorer+viewer archetype (the closest is `dashboard`, which is the wrong shape), so the static template is the canonical form, exactly as the board falls back. React, `marked` and `DOMPurify` are inlined and the view is pre-transpiled, so unlike the board it needs no CDN at runtime (see §"Automation, offline & live refresh").

---

## Relation to `board.html` (read this first)

The explorer is a **sibling** to `board.html`, **not** a superset and **not** a replacement:

| | `board.html` (`refresh-board`) | `explorer.html` (`explorer`) |
|---|---|---|
| What | Derived **run-state** view (WP / wave / gate · Mission-Control / Kanban / DAG) | **File browser** of the whole plan folder |
| Fences | `board-data` · `board-meta` | `explorer-data` · `explorer-meta` |
| Owns | `board.html` + (first run) `manifest.json` / `data/` / `assets/` | **only** `explorer.html` |

The explorer **opens `board.html` (and the living spec `index.html`, and each `designs/*.html`) as a first-class iframe tab** in its right pane — it never re-implements the board's matrices or DAG. Think of the explorer as the navigational shell that *contains* the board; the board stays the canonical run-time dashboard.

**Ownership boundary (hard):** the explorer action writes **only** the two fences inside `artifact/explorer.html`. It never touches `index.html` (living spec, hand-authored Overview), `board.html` (refresh-board), `09-orchestration.md`, or the `refresh-board`-owned `manifest.json` / `data/` / `assets/` scaffold. If `refresh-board` has never run, those files won't exist — the explorer does **not** depend on or scaffold them (`explorer.html` carries its own manifest).

---

## What it does

1. **Verify** `.groundwork.json`. Refuse if absent ("this folder isn't a groundwork plan yet; run `init` first").
2. **Spine gate**: `python3 <skill>/scripts/groundwork_state.py spine-gate --plan <plan> --expected 1`. Refuse on mismatch.
3. **Resolve the template** for the plan's profile (read `profile` from `.groundwork.json`):
   - `profiles/<profile>/explorer/index.html` if it exists (today: `design-system` → gallery-first, `content` → media-first),
   - else `profiles/_shared/explorer/index.html` (the base — `software` + `general` use it directly; it is fully profile-adaptive and reads the per-plan `#explorer-overlay` config block + `meta.profile` to choose the default left-pane mode).
4. **Ensure `artifact/` exists** (`mkdir -p <plan>/artifact`). Do **not** scaffold `manifest.json` / `data/` / `assets/` — those belong to `refresh-board`.
5. **First run** (when `artifact/explorer.html` is absent): copy the resolved template verbatim to `artifact/explorer.html`. (Its `explorer-meta` fence still carries `{{…}}` placeholders at this point; step 7 overwrites them.) On a **template-version bump** (a new release of this skill), overwrite the scaffold once and note it in the report — but never overwrite hand edits *inside* the two fences without `--force`.
6. **Build the model**: `python3 <skill>/scripts/groundwork_state.py explorer-data --plan <plan>` → a JSON object `{ plan, tree, ids, designs, subplans, research, stats }`. The script walks the folder, **embeds** markdown/text/code under a size budget (planning core first — spine, sub-plans, `quality-gate.md` — then the long tail), and **references** `html` / `design` / `image` / `pdf` by relative path (so the 84-mockup design-system case and `../foundations/tokens/tokens.css` relative imports both stay intact). It flags files on disk that aren't in `.groundwork.json` (`registered:false`) and computes per-doc drift.
7. **Write the two fences** via the script's `write-region` (hash-diff; idempotent). **Always pass `--html-script-safe`** — both fences live inside `<script type="application/json">`, so an embedded file body containing a literal `</script>` (common in code samples / web-artifact markdown) would otherwise terminate the block, break `JSON.parse` (silent fallback to mock), and inject live HTML (XSS). The flag escapes `<`/`>`/`&` to `\uXXXX`, which `JSON.parse` round-trips back to the real characters. **On a (re)scaffold run** — first run, or a template-version bump where step 5 overwrote `explorer.html` — also pass `--force`: the fence currently holds the template's `null` placeholder, which won't match any stale anchor hash, and the scaffold is the action's own output. On a **pure refresh** (existing `explorer.html`, not re-scaffolded) **omit `--force`**, so a genuine hand-edit inside a fence surfaces as `SKIPPED_DIRTY` instead of being clobbered.
   - `explorer-data` ← the model from step 6:
     `write-region --plan <plan> --file artifact/explorer.html --id explorer-data --action explorer --content-file <model.json> --html-script-safe`
   - `explorer-meta` ← `{ "title": "<from 01/anchor>", "profile": "<profile>", "plan_folder": "<e.g. plans/foo>", "plan_slug": "<basename>", "goal": "<from anchor>", "root_rel": "..", "refreshed": "<today>" }`
     `write-region --plan <plan> --file artifact/explorer.html --id explorer-meta --action explorer --content-file <meta.json> --html-script-safe`
   `root_rel` is the path from `explorer.html`'s directory back to the plan root — always `".."` because `explorer.html` lives in `artifact/`. The viewer prefixes every referenced `src` with it, so iframes/images resolve against the real plan folder.
8. **Register**: `write-region` records `artifact/explorer.html` in `.groundwork.json.docs` with the two generated regions automatically — no separate step.
9. **Report**: print the artifact path + `stats` (files · embedded · referenced · any over-budget) + a hint: `open artifact/explorer.html` or paste into the Ikenga shell.

---

## The explorer UI

- **Left pane** — a collapsible file tree grouped by kind (Spine → Sub-plans → Artifact → Designs → Drafts → Parts → Assets → State → Other), with drift dots (in-sync / drift), lock / `wip` badges on designs, sub-plan archetype tags, an `action` flag on actionable docs (`PUBLISH-NOW.md`), and an `unreg` flag on files not in the anchor. Two alternate modes light up when the data warrants: **Gallery** (a grid of live `designs/*.html` iframe thumbnails — the default for `design-system`) and **Media** (a lightbox grid of images / PDFs / slide renderers — the default for `content`).
- **Right pane** — an editor-style **tab bar** (multiple files open at once, closeable) + a **type-dispatched viewer**: Markdown (rendered, with `groundwork:auto` generated regions visibly boxed + a **Raw** sub-tab — never editable), HTML-artifact / design / PDF (sandboxed relative-`src` iframe + a **Source** sub-tab that fetches live), image lightbox, inline SVG, and read-only JSON / code. A metadata **rail** (toggle) shows the selected node's path, size, IDs/badges, fence inventory, drift, and **Copy path** / **Send to chat** actions.
- **Theme** — mirrors the shell's `data-theme` / `data-mode` / `data-density` handshake and re-posts it into every child iframe (the board, the living spec, designs) so nested previews track the shell theme.

**Standalone vs. in-folder** (the hybrid contract): opened from `artifact/explorer.html` (in-shell or `file://`/served), the tree + all embedded markdown render fully **and** the relative-`src` iframes/images preview live. Opened as a **lone uploaded file** (e.g. claude.ai), the embedded text still renders everything; HTML/design/PDF/image nodes detect the missing sibling and show a graceful placeholder card (metadata + copy-path) instead of a blank frame. `explorer-mock-data` keeps the artifact non-empty before the action ever runs.

---

## Re-run semantics

Per `lib/state.md`: the action recomputes the model, and `write-region` writes each fence only when its content hash changed (`WRITTEN`), no-ops when unchanged (`UNCHANGED`, mtime preserved), and refuses on hand-edits inside a fence (`SKIPPED_DIRTY`) without `--force`. Re-running `explorer` with no input-doc changes is a true no-op. The `explorer-data` fence carries the hash; the surrounding HTML scaffold is constant per template version.

---

## Automation, offline & live refresh

- **Run it deterministically**: `python3 <skill>/scripts/generate_explorer.py --plan <plan>` performs this whole action byte-for-byte (template resolve → scaffold → `explorer-data` → write both fences with `--force` on a fresh scaffold). Agents may call it directly instead of hand-running the steps.
- **Bulk / backfill existing plans**: `generate_explorer.py --all-under <plans-dir> [--missing-only]` generates for every plan under a dir; `--missing-only` skips plans that already have one. (`init` does **not** auto-scaffold the explorer — this is how you light up existing plans.)
- **Live refresh**: `python3 <skill>/scripts/watch.py --plan <plan>` watches the folder and regenerates on every edit / new file; the built artifact, served over http(s) as a top-level page, polls its own `Last-Modified` and reloads (no-op on `file://` and inside the shell). Otherwise the tree + embedded text are a **build-time snapshot** — re-run the action (or the watcher) to pick up new files / edits; referenced previews (board, designs, images) always load live.
- **Fully offline**: the template inlines React + `marked` + `DOMPurify` and is pre-transpiled (no Babel/CDN at runtime), so a generated `explorer.html` opens with **zero network** — air-gapped, Claude Desktop, anywhere (only Google Fonts is external, and it falls back to system fonts). Edit the readable JSX in `profiles/<…>/explorer/index.src.html`, then rebuild with `node scripts/build-offline-artifacts.mjs` — **never hand-edit the built `index.html`**.
- **Idempotency note**: `explorer-data` deliberately **excludes `.groundwork.json` and `artifact/explorer.html`** from the model — both are mutated by this very action, so embedding them would make every re-run report drift. With them excluded, re-running on an unchanged plan is a true no-op.

## Edge cases

- **Empty plan (no docs / empty `designs`+`drafts`)** — the tree renders the spine and shows empty dirs as explicit "intentionally empty" stubs; the viewer shows the plan title + an empty-state prompt.
- **`board.html` referenced but never generated** (README/manifest mention it, file absent) — it simply doesn't appear in the tree; nothing breaks. Run `refresh-board` to create it, then re-run `explorer`.
- **Files on disk not in the anchor** (e.g. orphan `13`/`14` sub-plans, root-level `wf-*.js` runners) — shown with an `unreg` flag; the tree reflects actual disk contents, never just the registry.
- **Over the embed budget** (big design-system plans) — low-priority docs (parts specs, fixtures) are referenced instead of embedded; `stats.truncated` lists them and the sidebar shows an "N over budget" note. Never silent.
- **Hand edits inside a fence** — `write-region` returns `SKIPPED_DIRTY`; surface it and offer `--force`.

---

## Click-to-fire prompt

`explorer` is a **read-action** in the WP-21 sense — invoked from the board palette in-shell it routes through `art.sendToActiveSession` (the regeneration lands in the current thread), though the action itself writes to disk. Substitution variables: `{plan_folder}`, `{plan_title}`, `{profile}`.

**Standalone slash form**:

```
/groundwork explorer
```

**Seeded-session form**:

```
Run groundwork explorer on `{plan_folder}` (plan title: {plan_title}).

If the groundwork skill is loaded, follow its `explorer` action verbatim — read `.claude/skills/groundwork/actions/explorer.md`: resolve the profile's explorer template (`profiles/<profile>/explorer/index.html`, else `profiles/_shared/explorer/index.html`), copy it to `{plan_folder}/artifact/explorer.html` on first run, build the model with `groundwork_state.py explorer-data --plan {plan_folder}`, and write it into the `explorer-data` + `explorer-meta` generated-region fences via `write-region`.

If the skill is not loaded: read `{plan_folder}`'s files, hand-build a JSON model { plan, tree, ids, designs, subplans, stats } — recursively listing the folder, embedding markdown/text content inline and referencing html/design/image/pdf by relative path — copy `profiles/_shared/explorer/index.html` to `{plan_folder}/artifact/explorer.html`, and inject the model into the `<!-- groundwork:auto:start explorer-data -->` fence (and a `{ title, profile, plan_folder, plan_slug, goal, root_rel: "..", refreshed }` object into the `explorer-meta` fence). **Both fences live inside `<script type="application/json">`, so before injecting, escape `<`→`<`, `>`→`>`, `&`→`&` in the JSON** (or a literal `</script>` in an embedded file body will break the page).

Never touch `index.html`, `board.html`, `09-orchestration.md`, or the manifest/data/assets scaffold — the explorer owns only `explorer.html`. Preserve hand-authored prose outside fences byte-identical.
```
