# action: `design` — produce ≥2 comparable mockups, lock one

**Loaded when**: the user wants to mock up UI/UX options for a phase, compare them, and lock a direction.

**Reads first**: `../lib/state.md`, the current `01-plan.md` (for what's being designed), and `.groundwork.json.designs` (existing coverage).

**Spine-version**: `expected = "1"`. Runs [`../lib/state.md` §"Spine-version preamble gate"](../lib/state.md#spine-version-preamble-gate) as the first step after loading `.groundwork.json` — writing action (registers designs in `.groundwork.json` + appends design-lock to `04`), so refuses on either direction of mismatch. No-op at v1=current.

**Profile-gated**: runs only when `profile.json.produces_designs === true`. For `general` profile (default `false`), refuses with "this profile isn't visual; skip the design action." If a user on `general` insists, they can opt in for one run with `--allow-non-visual`.

**Composes** (in invocation order):
1. **`design-language`** *(first — G9)* — discovers the project's existing tokens / palette / typography / spacing / radii surface, produces a portable design contract. The downstream artifact skill applies this so mockups *match the rest of the app* instead of inventing fresh styling.
2. **`huashu-design`** *(always — the design-quality spine, step 2 regardless of surface kind)* — engaged on **every** design run. It carries the design-direction reasoning, anti-AI-slop discipline, hi-fi craft, expert review, and animation/video export. It is **composed *with*** the skills below, never replaced by them. The goal is impeccable output — huashu is the floor for that on every variant.
3. **In conjunction with `huashu-design`, Claude freely layers in whatever else the surface warrants — no fixed list, no limits.** Claude decides the blend *while doing the work*, based on surface, brief, and what's installed:
   - **`ikenga-artifact-builder`** — interactive / data-bearing mockups. Ships notes-back loop + `publishState` + Ikenga-aware fallback baked in.
   - **`scrollytelling`** — scroll-driven narrative, pinned sections, progressive reveals, parallax, story-driven landing.
   - **`example-skills:frontend-design`** — production-grade, distinctive frontend craft.
   - **`impeccable`** — design-vocabulary pass (polish / audit / critique / distill / bolder / quieter / animate / colorize) with deterministic anti-pattern rules; layer it to push any variant past generic AI aesthetics.
   - **`example-skills:web-artifacts-builder`** — multi-component React/Tailwind/shadcn artifacts needing state or routing.
   - **any other installed skill** that raises the mockup's quality, in any combination.

   Fall back to plain self-contained HTML (still under huashu's quality direction) only when no artifact/visual skill is installed.

---

## What it does

1. **Verify** `.groundwork.json` and the profile's `produces_designs`. Refuse if not visual.
2. **Detect Ikenga context** *(G9 step 1)*. Before invoking `design-language`, decide whether this plan is targeting an Ikenga app/feature. Auto-detect signals (any one is enough):
   - The plan folder sits under a directory whose `pnpm-workspace.yaml` lists a `tokens` package whose `package.json` declares `"name": "@ikenga/tokens"`.
   - A `CLAUDE.md` at the workspace root mentions Ikenga as the workspace identity (`/home/nedjamez/royalti-co/ikenga/CLAUDE.md` is the canonical example).
   - The workspace has a `tokens/tokens.css` exporting the `@ikenga/tokens` token surface.
   - The user explicitly says so (`--workspace=ikenga` flag, or the goal in `.groundwork.json` names an Ikenga pkg / surface).
   Record the result as `ikenga_context: true|false`. Falls through transparently for non-Ikenga plans — no warning, no nag.
3. **Discover the design language** *(G9 step 2)*: invoke the `design-language` skill via the `Skill` tool. design-language doesn't take a `destination` parameter directly — its workspace-fallback triggers (see its SKILL.md §"Workspace fallback") fire on (a) a `manifest.json` declaring `capabilities.tokens: "@ikenga/tokens"`, (b) a destination path under `ikenga-pkgs/packages/`, or (c) **explicit user opt-in in the prompt**. When `ikenga_context: true`, groundwork includes the explicit opt-in language in the call ("use Ikenga tokens — this plan targets the Ikenga workspace at `<workspace-root>`"). design-language walks the project for `tokens.json` / `tailwind.config` / theme files / CSS custom properties / StyleSeed / `@ikenga/tokens` / `design/` docs, **detects and BLOCKS on conflicts** between sources, and returns a *portable design contract* (token map + provenance) — **or `null` if it found nothing**, or **a structured conflict report** if it blocked.
4. **Resolve the contract** through this fallback chain (the answer to "which tokens get used"):

   | design-language result | `ikenga_context` | Outcome |
   |---|---|---|
   | Tokens found (project-specific or `@ikenga/tokens`) | either | **Use those** — design-language is authoritative when it found something |
   | **BLOCKED on conflict** (multiple sources, design-language refuses to silently pick) | either | **Surface the conflict report verbatim** via `AskUserQuestion`; user picks the winning source (or asks design-language to ignore one); re-invoke `design-language` once. If the user defers, refuse `design` until resolved — the conflict report is the answer, not a warning. |
   | `null` (no contract) | `true`  | **Use `@ikenga/tokens` explicitly** — synthesize a contract from `tokens/tokens.css` at the workspace root, pass to the artifact skill |
   | `null` (no contract) | `false` | Fall through to the artifact skill's built-in defaults (Tailwind for `ikenga-artifact-builder`, philosophy library for `huashu-design`) |
   | skill not installed     | `true`  | **Use `@ikenga/tokens` explicitly** — same as the `null` + Ikenga case |
   | skill not installed     | `false` | Fall through to built-in defaults |

   Net guarantee: **for Ikenga work, Ikenga tokens are used unconditionally** — whether design-language detects them, requests them via workspace hint, or is bypassed entirely. For non-Ikenga work, the project's own tokens win, with the artifact's built-in defaults as the floor. **Conflicts are never silently resolved** — design-language's block is the contract; groundwork honors it.

5. Capture the resolved contract; pass it to whichever artifact skill we end up calling.
6. **Scope the mockup**: read `groundwork_state.py design-data --plan <plan>`. `planned` designs are registered `D-NN` with no mockup yet, and they're the natural next targets. Then ask the user (`AskUserQuestion`):
   - **Which design** is this? An existing `D-NN` (preferred), or a new surface (allocate the `D-NN` now: `next-id --kind design` + `register-id`).
   - **Which phase / WP** is being designed? (P1 / P2 / P3 / cross-cutting)
   - **What's the surface**? (a screen, a flow, a board, a single component)
   - **What does the surface need** — interactive / data-bearing? scroll-driven narrative? pure visual craft? (this informs which skills get layered *with* huashu-design, not a single pick)
7. **Compose the skill blend.** `huashu-design` is always engaged (step 2). On top of it, Claude layers whichever skills the surface warrants — `ikenga-artifact-builder`, `scrollytelling`, `frontend-design`, `web-artifacts-builder`, or any combination — using the *Composed-skill selection* guide below as a starting map, not a single-pick table. Pass every engaged skill the design contract resolved in step 4. Claude decides the final blend while building; no limits.
8. **Produce ≥2 comparable variants** as `designs/<surface>-<variant>.html`. Each variant should be a real working file, not a sketch — the studio's Pattern C lock came from comparing complete mockups, not lo-fi wireframes.
9. **Register** each variant against its design, through the script: `groundwork_state.py register-design --plan <plan> --file designs/<surface>-<variant>.html --id D-NN --phase <P> [--wp WP-NN]`. The `D-NN` is the surface being designed. Reuse the one already in `ids` if the plan registered it (plans often register `D-NN` before any mockup exists); otherwise allocate it now with `next-id --kind design` + `register-id --id D-NN --doc 01-plan.md --field kind=design --field title=<surface> --field phase=<P>`. The command writes `designs[<file>]` (`phase`, `wp`, `locked: false`, `pane_ids: null`, `design: "D-NN"`) and adds the file to `ids[D-NN].files`. Re-running it is a no-op.
10. **Open them — host-aware** *(G3)*. The action checks for an in-shell signal (presence of `iyke` CLI on PATH + `IYKE_BRIDGE_URL` env var) before falling back to system open:
    - **In Ikenga** (`iyke` available) → `iyke open <path>` for each variant; capture returned pane IDs into `.groundwork.json.designs.<file>.pane_ids` so the action can later read iframe-state.
    - **Standalone terminal / browser** → `xdg-open` / `open` (Linux/macOS) — the previous behavior.
11. **Hand off to the user**. The action's first interactive turn is just "Both mockups are open. Leave inline comments via the 💬 button if you want granular feedback on either, then come back and run `groundwork design --check-notes`. Or pick a winner directly:"
    - `AskUserQuestion`: which one wins? · revise (re-invoke with edits) · I left comments — run `--check-notes` first · cancel
12. **`--check-notes` mode** *(G1)*: when the user opts into this, the action:
    - For each pane ID it captured at mount time, calls `iyke iframe-state <pane>` to read the artifact's published state + any element-attached notes routed back via the chat session marker
    - Surfaces every comment verbatim (`"button too small here" — on selector .start-btn, file: designs/board-b.html`)
    - Re-asks the lock question with the comments visible — user may pick a winner *with caveats* the action then folds into the Round, or ask the action to revise mockups based on the comments (re-invokes the artifact skill with the comments as additional brief input)
13. **Capture the lock** — `AskUserQuestion` for the chosen variant + a one-line rationale. The action does **not** auto-lock without confirmation.
14. **Fold the lock**:
    - Append a "Round N — design lock for D-NN (<surface>)" entry to `04-discussion.md` (newest first, above existing rounds).
    - Update `01-plan.md`'s relevant section to cite the chosen design by `D-NN` and path.
    - Lock it through the script — never by editing the anchor: `groundwork_state.py design-lock --plan <plan> --id D-NN --round N --file designs/<file>`. This sets `ids[D-NN].locked / locked_files / locked_file / locked_in`, appends to `history[]`, and mirrors `locked` onto every variant in `designs` (chosen `true`, the rest `false`). When the lock covers complementary variants rather than rival options (a main screen plus a returning-member path), repeat `--file` for each. Re-running it is a no-op; locking a *different* file while locked refuses (unlock first, see §"Unlocking a design").
    - If `--check-notes` surfaced comments, include them under a "**Considered (from inline notes)**" sub-section in the Round body so the design rationale captures them.
15. **The `D-NN` already exists** — it was allocated at scope time (step 6), so a design has one ID from planning through verification. For a legacy plan that locked files without IDs, run `design-migrate` (see [`../lib/state.md` §"Design lifecycle"](../lib/state.md#design-lifecycle)).
16. **Print next steps** — typically "run `groundwork orchestrate` once you've locked all P1 designs," or "design the next phase when you reach it." Once a WP implementing the design merges and a design-conformance review passes, `design-verify` closes the loop (`actions/review.md` §"Design reviews").

### Unlocking a design

A locked design's appearance never changes silently. When a review finding, a notes pass or a product decision needs the locked mockup to change:

1. Append a Round to `04` that says *why* (cite the `G-NN` or decision).
2. `design-unlock --plan <plan> --id D-NN --round N --reason "<one line>"` — records `unlocked_in`, clears `verified_in`, keeps the prior lock in `history[]`, and warns if WPs already build against it.
3. Revise the variant (or produce a new one), then `design-lock` again in the same or a later Round.

An implementation PR that changes a locked design's look *without* this unlock round is a critical design-conformance finding.

---

## Composed-skill selection

**`huashu-design` is always engaged** (step 2) — it is the quality spine on every run, regardless of surface kind. The table below is a guide to which skills to **layer *with* huashu**, not a single-pick decision. Claude composes freely — multiple skills at once is expected and encouraged — and decides the final blend while building. No limits.

| Surface kind | Layer *with huashu-design* | Why |
|---|---|---|
| Plan-board, dashboard, status view, anything that needs to render real data | `ikenga-artifact-builder` | Self-contained HTML + auto-wired notes-back + `art.publishState` + Ikenga-aware fallback baked in |
| Scroll-driven narrative, story landing, pinned/parallax reveals | `scrollytelling` | Scroll-linked animation, pinned sections, progressive reveals |
| Hi-fi marketing page, brand-driven visual prototype | huashu-design alone is enough | Multi-variant exploration + Playwright validation + design philosophy library |
| Production-grade frontend (component, dashboard, landing) | `example-skills:frontend-design` | Distinctive UI, avoids generic AI aesthetics |
| Any variant that needs an anti-slop polish / critique / audit pass | `impeccable` | Design-vocabulary commands + deterministic anti-pattern rules; layers on top of any other skill |
| Multi-component React artifact (state / routing / shadcn) | `example-skills:web-artifacts-builder` | Elaborate claude.ai artifacts with real component architecture |
| Pure layout exploration, no data | huashu-design + plain self-contained HTML | huashu directs the craft; no extra artifact skill needed |

The action **invokes each engaged skill via the `Skill` tool**, passing the discovered context (phase, surface, profile) **+ the design contract from `design-language`**. The skills return paths; the action moves/copies them into `designs/` and registers them.

---

## How mockups should leverage the artifact-builder surface

When `ikenga-artifact-builder` is the composed skill, the action's brief to it explicitly asks for these features (otherwise they get omitted and the design-action loses leverage):

**`art.publishState` patterns** *(G2)* — every mockup should publish:
- `art.publishState('leaning', <user-signal>)` — boolean / score / null. Surface from in-mockup affordances (a "👍 this" pin button, a per-section thumbs cluster, dwell-time hover). The action reads this via `iyke iframe-state <pane>` to know what the user is gravitating toward *without re-asking*.
- `art.publishState('annotations', [...])` — array of `{ selector, note, severity }` for in-mockup checkbox or sticky-note affordances. Element-attached.
- `art.publishState('preview_state', { tab, layout, scrolled_to })` — for mockups with internal tab/scroll state, so the agent can reason about what the user has looked at.

**`art.notes`** — keep it on (default; manifest's `notes.enabled` should be `true` or absent). The 💬 button auto-renders in the artifact's bottom-right. In Ikenga, comments route back to the originating chat session with a marker linking artifact + selector. The action picks them up via `--check-notes`.

**`art.host.kind`** — mockups should declare a host badge ("live in shell" / "static · browser") and gracefully degrade when out-of-shell. The artifact-builder's template covers this; the design action should remind in its brief.

**`art.pin()`** — the *locked* mockup should call `art.pin()` on first mount post-lock (one-shot, idempotent flag in `art.state`). Suggests pinning it to the activity bar so the user can return to the locked design easily during the build.

---

## `--check-notes` mode in detail

```
$ groundwork design --check-notes

Reading notes from 2 pane(s)…
  pane-3a (designs/board-b-mission-control.html):
    leaning:  'b' · annotations: 2
    notes (2):
      [.detail-card]      "Brief panel is great but the buttons are too small at this density"
      [.kanban-col-head]  "Status columns make more sense than waves for ongoing tracking"

  pane-3b (designs/board-a-waveboard.html):
    leaning:  null · annotations: 0
    notes (0): —

Folded:
  · 2 notes captured on board-b
  · No notes on board-a; user spent 0.0min there (per state)

Next:
  1. Pick a winner now (with notes recorded as Round-body context)
  2. Revise board-b based on the 2 notes (re-invokes artifact-builder)
  3. Defer the decision
  4. Cancel

[1/2/3/4]
```

The action wraps the per-pane state reads + per-pane notes into a single decision-time view. The Round body's "**Considered (from inline notes)**" section captures verbatim quotes so the lock decision is anchored in the user's words.

---

## Iterate-on-comments loop *(G4)*

The path from "user left N notes" to "revised mockup" runs through the same composed-skill invocation as the initial production, but with the notes as additional brief input. Specifically:

1. `--check-notes` collects all notes per variant.
2. If the user picks option `2. Revise based on comments`, the action invokes the artifact skill (e.g. `ikenga-artifact-builder`) with:
   - Original brief context
   - **PLUS** `notes: [{ selector, note, file }, ...]` for the variant being revised
   - Plus a directive: "Address each note in the revised mockup. Keep the variant's name and registration so it stays comparable to the other variant. Preserve everything not addressed by a note."
3. The skill returns the revised file; the action overwrites `designs/<surface>-<variant>.html` and bumps a `revision: N` counter in `.groundwork.json.designs`.
4. The action re-opens both mockups (same pane IDs in-shell, fresh in browser) for another round.

Three iterations is usually enough; if a user is on revision 4+ of the same variant, the action suggests "try a fresh variant `<surface>-<variant>2.html`" — sunk-cost reset.

---

## Per-phase production

> Designs are produced **per phase, as a phase is approached** — not all upfront.

This is a Round-3 lock. The action's interview deliberately asks "which phase" rather than "design everything." `status` reports per-phase design coverage and flags gaps (`P2 has no designs yet`); `clarify` uses the coverage to gate `orchestrate` (locked design required for any phase that's about to be orchestrated).

---

## What "comparable" means

Two mockups are comparable when they exercise the **same content** in **different approaches** — not different content. The studio Pattern C / D mockups both rendered the five sub-views; the difference was layout. If you produce mockups with different data, the user can't compare them.

The action enforces this gently: the brief to the composed skill says "produce N variants showing the SAME surface, varying the approach." If a variant comes back with substantively different content, ask the composed skill to revise before registering.

---

## Output layout

```
designs/
├── <surface>-<variant>.html      # one file per variant
└── <surface>-<variant>.html
```

Naming convention (suggested, not enforced): `<surface>-<variant>.html` where surface is a kebab-case noun (`board`, `pattern-c-split`, `landing-hero`) and variant is the differentiator (`mission-control`, `wave-board`, `dense`, `airy`).

---

## Lock recording in `04-discussion.md`

Newest-first append. Example shape:

```markdown
## Round <N> — design lock for <surface> (<date>)

Built two comparable mockups in `designs/`, both rendering …
- `designs/<surface>-<variantA>.html` — <one-liner>
- `designs/<surface>-<variantB>.html` — <one-liner>

**Locked (user):** **<chosen>** as <role>. Rationale: <user-supplied>.

**Considered (from inline notes):** _(only if `--check-notes` surfaced any)_
- [<file> · <selector>] "<verbatim note>" — <how it was addressed in the lock or revision N>
- …

**Considered, not built:** <variants the user rejected and why, if surfaced>

**Out of scope:** <anything the user explicitly deferred>
```

This format mirrors `plans/groundwork/04-discussion.md` §"Round 4 — plan-board design lock" exactly — the lock IS recorded as a round. The "Considered (from inline notes)" sub-section is new in Round 5+ (post-notes-loop wiring); earlier rounds didn't have it.

---

## Review-pass integration

A `review` pass can target a design, not just the plan. `groundwork review --target D-NN` (or `designs/<file>`) critiques the mockup. Findings go into a Round as `G-NN` with `kind: design-review`, `design: D-NN`, a `state` and a `file:line` location, and they attach to the design in `design-data` and on the board. The design action can then iterate: revise → re-present → re-lock (unlocking first if the design was locked).

After the build, `groundwork review --target "PR #N"` runs the **design-conformance** lens: it compares the PR against the locked mockup state by state, records the implementation with `register-design-impl`, and, once the PR has merged clean, closes the loop with `design-verify`. See `actions/review.md` §"Design reviews".

The notes-back loop (G1) and the review-pass are *complementary*: notes are the user's voice on specific elements; review is the agent's critique of the whole. Both can run on a single design; both can feed the iterate loop.

---

## Edge cases

- **One mockup only** — refuse. The point is comparison. Produce a second variant.
- **User passes a single hi-fi mock and wants to "lock it"** — accept by allocating a `D-NN` ID, but flag in `04` that no comparison was performed. This is a downgrade.
- **No display available (headless)** — print paths + suggest `xdg-open`/`open` after the user is at a desktop; lock can be deferred.
- **Design skill not installed AND user wants interactive** — fall back to plain HTML; warn that data binding will be static-mock until the user wires it.
- **No `design-language` skill installed / no contract returned** (G9 fallback) — handled by the resolve-the-contract table in step 4. For Ikenga work (auto-detected via `tokens/package.json` named `@ikenga/tokens` etc.) the action falls back to `@ikenga/tokens` directly, synthesizing a contract from `tokens/tokens.css` at the workspace root. For non-Ikenga work, the artifact uses its built-in defaults (Tailwind for ikenga-artifact-builder, philosophy library for huashu-design). The Round body notes which path was taken.
- **`--check-notes` invoked but no notes found** — surface "no notes on any variant; you can either pick a winner now or come back after leaving inline comments via 💬." Don't force a re-ask.
- **`iyke` not on PATH but the user is in Ikenga** — treat as standalone (fall back to `xdg-open`). The user can manually paste the path into a shell pane.
- **All P1 designs locked, user runs `design` again** — ask which phase next; if none, suggest moving to `clarify` → `orchestrate`.

---

## Click-to-fire prompt

The canonical strings the FE emits (palette / WP-card per WP-21). Substitution variables: `{plan_folder}`, `{plan_title}`, `{phase}` (the phase being designed for — e.g. `P1`, `P2`).

**Standalone slash form**:

```
/groundwork design --phase {phase}
```

**Seeded-session form**:

```
Run a groundwork design pass on `{plan_folder}` (plan title: {plan_title}) for phase {phase}.

If the groundwork skill is loaded in this session, follow its `design` action verbatim — read `.claude/skills/groundwork/actions/design.md`, invoke the `design-language` skill first to discover the project's design contract, then engage `huashu-design` as the quality spine (always, regardless of surface) composed with whatever else the surface warrants — `ikenga-artifact-builder`, `scrollytelling`, `frontend-design`, `impeccable`, etc., your call, no limits — to produce ≥2 comparable mockups under `{plan_folder}/designs/`, surface them for comparison, and lock one. If the skill is not loaded, read `{plan_folder}/01-plan.md` §"Phase {phase}" for what's being designed, produce 2-3 self-contained HTML mockups under `{plan_folder}/designs/`, and present them side-by-side with a one-paragraph rationale per option.

Refuse if the plan profile's `produces_designs` is false unless the user explicitly opted in.
```
