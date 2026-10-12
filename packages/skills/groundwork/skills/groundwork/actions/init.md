# action: `init` — scaffolder

**Loaded when**: the user wants to scaffold a new groundwork plan folder, or runs an action against a folder that has no `.groundwork.json`.

**Reads first**: `../lib/state.md` (state machine spec — every write obeys it).

**Spine-version**: produces (and `--migrate` upgrades to) `spine_version: "1"`. **Owns** the `--migrate` path described in [`../lib/state.md` §"Per-version transform table"](../lib/state.md#per-version-transform-table-deferred-until-v2) — bare `init` against an existing older anchor declines and points the user at `init --migrate`; `init --migrate` walks the transform table forward. At v1=current the migrate path is a no-op.

**Idempotent**: re-running `init` on an already-initialized folder is a no-op (per hash-diff semantics in `lib/state.md`). Re-running with `--force` only re-renders the *inside of fences* in existing spine files (hand-written prose outside fences and all anchor state are kept; fences that look hand-edited are skipped and reported). A destructive full reset exists as the separate `--reset-all` flag (ask the user first; never suggest it to restore one file).

---

## What it does

1. **Locate the target folder.** Accept it as an argument (`groundwork init plans/my-feature/`) or, if absent, ask the user. When you **derive** a default folder (the user gave a goal but no path), date-prefix the slug: `plans/<today>-<slug>/` where `<today>` is the current UTC date as `YYYY-MM-DD` (e.g. `plans/2026-05-28-checkout-redesign/`). This keeps sibling plans chronologically sortable, matching the `YYYY-MM-DD-slug` convention used elsewhere in the workspace. An **explicit** path passed by the user is used verbatim — never rewrite or re-date a path the user typed.
2. **Query project memory for similar prior plans** *(G5 — composition with project memory)*. If a project-memory MCP is available (mempalace is the reference implementation; any equivalent KG/semantic-search server works the same way), derive the project root (parent of the target plan folder, or its grandparent — whichever is a git root). Then, using mempalace's tools as the concrete example:
   - `mempalace_kg_query({ entity: <project-root-path> })` — walk triples for facts like `(<root>, has_plan, <slug>)` or `(<root>, last_profile, software)`.
   - `mempalace_search({ query: '<project-root> plan' })` — semantic hits for prior plan structures + lessons.
   Surface up to **three hits** with one-liners and ask whether to riff on any of them (e.g. "use the same Phase shape as `plans/studio`?" / "lift the Round-2 risk-fold pattern from `plans/foo`?"). If memory has nothing, proceed with the blank template — *don't fabricate* hits. **If mempalace MCP isn't available**, skip this step silently; init still works on a virgin project.
3. **Run the discovery interview** (see "Interview" below) — captures goal, profile, optional spine overrides. Use `AskUserQuestion`. Skip questions whose answers were passed on the command line.
4. **Scaffold via the state script** — run one command; it resolves the profile (overlay over `_shared`), runs the conformance gate (refusing on any rule 1–9 failure), renders every spine template (substituting `{{vocab.*}}`/`{{goal}}`/`{{profile}}`/`{{date}}`/`{{plan_slug}}`, down-converting any human-fill `{{…}}` to `<…>`), writes each file *only if absent* (so hand edits and the `{{date}}` stamp never churn), creates `designs/` + `drafts/`, and drops a fully-formed `.groundwork.json` (spine_version, profile, goal, created/updated, docs map with per-region hashes, empty `ids`/`designs`/`subplans`/`research`):

   ```bash
   python3 <skill>/scripts/groundwork_state.py scaffold \
     --plan <target-folder> --profiles-root <skill>/profiles \
     --profile <profile> --goal "<goal>"
   ```

   `<skill>` is this skill's root (the parent of `actions/`). The command is idempotent — re-running it over an existing plan is a no-op (it reconciles, skipping every existing file). Parse the JSON result for `written` / `skipped_existing`. Do **not** hand-write `.groundwork.json` or hand-render templates — the script is the executor (see [`../lib/state.md` §"The executor"](../lib/state.md#the-executor-scriptsgroundwork_statepy)).
7. **Record the new plan in project memory** *(closing the loop)* — if a project-memory MCP is available, write the plan back so the next `init` in this project sees it as a hit. With mempalace: `mempalace_kg_add({ subject: <project-root>, predicate: 'has_plan', object: <plan-slug>, attrs: { profile, created } })`. **Skip if no project-memory MCP is available.**
8. **Print next-step guidance** — typically "run `groundwork research` to fill 02/03," or for visual profiles "run `groundwork design` once 01 has enough to mock against."

---

## Interview (discover path)

Use `AskUserQuestion`. Skip any question already answered.

| # | Question | Header | Options |
|---|---|---|---|
| 1 | Where should this plan live? | Target folder | (free-text, default `plans/<today>-<derived-from-goal>/` — date-prefixed `YYYY-MM-DD-slug`, see step 1) |
| 2 | What's the one-sentence goal? | Goal | (free-text) |
| 3 | Which profile? | Profile | `software` (Recommended) — code/feature work, produces designs · `general` — non-code, lean, no designs · `content` — editorial/marketing work, produces designs (key art) · `design-system` — component/token systems, produces designs (adds parts + quality-gate docs) · `film` — filmmaking pre-production (short film, music video, trailer, AI-generated film): logline, treatment, character/location bible, lookbook, shot ledger + render budget · _or a custom profile name dropped under `.claude/skills/groundwork/profiles/<name>/` — the conformance gate in `../lib/state.md` §"Profile contract" validates it before scaffolding_ |
| 4 | Will this produce visual / UX surfaces? | Visual? | Yes (Recommended for `software` if UI is involved) · No (skips the `design` action) |
| 5 | Drop a starter sub-plan stub now (`NN-*.md`)? | Sub-plans | Yes — give me a name · No (Recommended for first-pass) |

Q4 only fires when the chosen profile's `produces_designs` is ambiguous — `general` defaults to `false` without asking; `software` defaults to `true` but the user can override (e.g. pure-backend work); `content` defaults to `true` (key art is in scope) and doesn't ask; `film` defaults to `true` (the lookbook + reference frames are the designs) and doesn't ask.

**Picking the profile when the user doesn't name one** (Q3 skipped, or a fast-path caller inferring): match on the *shape of the work*, not on "is it code or not."

- Has **shots** — a short film, music video, trailer, spot, any AI-generated film → **`film`**. Wants a treatment, a look locked before generation, or per-shot/render-cost tracking? That's `film`.
- **Editorial** — articles, a content series, a campaign, key art → `content`.
- **Components/tokens** — a design language, a component library → `design-system`.
- **Code/features** → `software`. **Everything else non-code** (org changes, ops, research) → `general`.

Do not reason "it's creative rather than code, so `content`" — that misroutes film work into a profile with no shot ledger, no picture-lock gate, and no Studio handoff.

If invoked with the fast path (`groundwork init <dir> --profile <p> --goal "…"`), skip the interview entirely and use the args.

---

## Files written (initial state)

| File | Generated regions (initial) | Hand-authored regions |
|---|---|---|
| `00-README.md` | `status-block`, `spine-index` | Title + read-order + how-this-folder-updates prose |
| `01-plan.md` | `goal`, `ids` (empty registry block) | Context, all body sections (placeholders) |
| `02-research-external.md` | `findings` (empty), `sources` (empty) | Title + how-to-use intro |
| `03-research-internal.md` | `findings` (empty) | Title + how-to-use intro |
| `04-discussion.md` | `rounds-index` (empty) | "Rounds — newest first" header |
| `05-tracking.md` | `wp-matrix` (empty), `wave-plan` (empty), `critical-path` (empty) | Workstream descriptions |
| `artifact/index.html` | `spec-state` (empty JSON: phases/decisions/risks all `[]`) | A stub Overview tab the user customizes |
| `artifact/manifest.json` | whole file (rendered from template) | n/a |
| `designs/.gitkeep` | — | — |
| `drafts/README.md` | whole file (rendered from template) | — |
| `.groundwork.json` | whole file | n/a |

`artifact/index.html` (the living spec) is scaffolded **from the template** at `profiles/_shared/templates/artifact/index.html` — substituting `{{plan_title}}` / `{{plan_slug}}` / `{{profile}}` / `{{goal}}`. It is a **lean, plan-specific spec** of four tabs: a hand-authored Overview stub the user replaces with plan framing, plus the volatile Phasing/Decisions/Risks tabs that render from the `spec-state` fence (populated on first run of `refresh-living-spec`). It deliberately carries no methodology-explainer tabs — a plan's living spec is about the plan, not about groundwork; the tool's own docs are `SKILL.md` + `lib/state.md`, with `plans/groundwork/` as the worked showcase.

`artifact/board.html` is **not** written at init — `refresh-board` creates it on first run.

`09-orchestration.md` is **not** written at init — `orchestrate` creates it.

---

## Profile resolution

Resolution follows the algorithm in [`../lib/state.md` §"Profile contract"](../lib/state.md#profile-contract). Before merging, `init` runs the **conformance gate** (rules 1–10 in the same section) against the chosen overlay; **any rule 1–9 failure refuses the scaffold** with the canonical error message — no folder is touched. This is why a custom profile dropped at `profiles/<name>/` only "works" once it parses against the contract: the gate is what makes the drop-in safe.

```
1. Load profiles/_shared/profile.json                → base
2. Load profiles/<profile>/profile.json              → overlay (must declare `extends: "_shared"`)
   ↳ run conformance gate (lib/state.md §"Profile contract" rules 1–10) — refuse on any rule 1–9 failure
3. Merge:
   - labels:           overlay wins per-key
   - optional_blocks:  union, overlay-deduped
   - produces_designs: overlay wins (boolean)
   - spine_overrides:  overlay wins per-key (file-level overrides)
4. Materialize templates:
   - For each file in the spine list, look in profiles/<profile>/templates/<file> first; fall back to profiles/_shared/templates/<file>.
   - Substitute {{vocab.work_unit}}, {{vocab.isolation_axis}}, {{vocab.freeze_gate_noun}}, {{goal}}, {{profile}}, {{date}} (UTC ISO date).
```

Unknown placeholders are an error — they indicate a typo, not a feature.

---

## After init

Print:

```
✓ groundwork scaffolded in <path>
  profile: <profile> · goal: <goal>
  spine_version: 1

Next:
  groundwork research        — fill 02/03 with a cited research pass
  groundwork design          — produce ≥2 comparable mockups (visual profiles)
  groundwork review          — first gap-analysis pass against 01
  groundwork status          — see what's in the folder
```

If the profile is `general`, omit the `design` line from the printed guidance.

---

## Edge cases

- **Folder exists and contains files but no `.groundwork.json`** — refuse, surface the contents, ask the user to confirm before scaffolding (existing files would gain a `.groundwork.json` sibling — they're treated as hand-authored and never touched).
- **Folder is already a groundwork plan** — refuse with "this folder is already groundwork; use other actions or `--force` to re-scaffold."
- **`--force`** — re-runs the scaffolder, re-rendering *only fence interiors* of spine files that already exist, per `lib/state.md` rules. Hand-edited prose outside fences is preserved byte-for-byte, and `.groundwork.json` is kept as-is (IDs, designs, sub-plans, research stamps); the anchor is recreated only if it is corrupt. A fence whose on-disk content differs from what was last written (a hand edit) is skipped and listed in `skipped_dirty_regions`. Missing files are always (re)created, with or without `--force`. The output lists `refreshed_regions`, `skipped_dirty_regions` and `missing_fences`.
- **`--reset-all`** — DESTRUCTIVE and separate from `--force`: overwrites every spine file with its blank template and replaces the anchor (all prose, IDs, designs, sub-plans and research stamps are lost). Only on the user's explicit request; never offered as a way to restore a missing file.
- **Workspace-root invocation without target dir** — refuse, ask for a target. Don't scaffold into the cwd by accident.

---

## Click-to-fire prompt

The canonical strings the FE emits (palette / Kickoff card / argument-picker per WP-21..WP-23). Substitution variables: `{target_folder}`, `{goal}`, `{profile}`.

**Standalone slash form** (when copied to clipboard outside the shell, or when piped into a fresh `claude` session that has the skill loaded):

```
/groundwork init {target_folder} --profile {profile} --goal "{goal}"
```

**Seeded-session form** (self-contained brief sent into a fresh chat that may not have the skill loaded — typically via `art.startChatSession` from the WP-23 init picker):

```
Scaffold a new groundwork plan folder at `{target_folder}`.

Profile: {profile} (one of: software, general, content, design-system, film). Goal: {goal}.

If the groundwork skill is loaded in this session, follow its `init` action — read `.claude/skills/groundwork/actions/init.md`, run the discovery interview (skipping questions already answered above), and scaffold the spine. If the skill is not loaded, treat this as a plain instruction: create the folder, write the standard 6-doc spine (00-README through 05-tracking), the living-spec artifact (`artifact/index.html` + `artifact/manifest.json`), and an empty `.groundwork.json` anchored at `spine_version: "1"` with the profile and goal, and report back the file list.

Do NOT scaffold outside `{target_folder}`. Preserve any existing files there as hand-authored.
```
