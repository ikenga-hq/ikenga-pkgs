---
name: groundwork
description: |
  Scaffold and maintain a reusable research → design → plan → orchestrate → act
  folder for any non-trivial work — software features, marketing campaigns,
  org changes. Drops a domain-agnostic spine (00-README · 01-plan · 02/03
  research · 04-discussion newest-first · 05-tracking · 09-orchestration ·
  artifact/board.html plan-board) plus stateless action-skills that augment
  the docs in place without clobbering hand-written prose. Composes
  ikenga-artifact-builder, huashu-design, frontend-design, ikenga-pkg-builder
  when present; degrades gracefully when not. Profile-driven: `software`
  (rich default, code work), `general` (lean, non-code — campaigns, org
  changes), `content` (editorial/marketing with key art), `design-system`
  (component/token systems — adds parts + quality-gate docs to the spine),
  and `film` (filmmaking pre-production — logline, treatment, character /
  location bible, lookbook, shot ledger + render budget; hands off to Studio
  for execution). Pick `film` over `content` for anything shot-based — a
  short film, music video, trailer, or any AI-generated film work.

  TRIGGER when the user asks to start a real plan for non-trivial work
  ("plan a feature," "scaffold a plan folder," "set up groundwork for…"),
  references an existing plans/ folder by groundwork structure, or runs
  any of these actions: groundwork init / research / design / subplan /
  review / clarify / orchestrate / refresh-board / refresh-living-spec /
  explorer / plans-index / status.

  DO NOT TRIGGER for one-off code changes, single-document writeups, ADRs,
  or content that fits in a single markdown file — those don't need a
  multi-doc plan folder. If the user just wants a single artifact
  (dashboard, mockup), route to ikenga-artifact-builder instead.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent, Skill, Workflow, TaskCreate, TaskUpdate, TaskList, TaskGet
---

# groundwork — research → plan → orchestrate → act, packaged

**This file is a router.** Each action and each agent role lives in its own file under `actions/` and `agents/`; load on demand. The state mechanism (`.groundwork.json`, fences, hash-diff, IDs) is fully specified in `lib/state.md` — every action obeys it. **Read `lib/state.md` before doing anything that writes to disk.**

The full design lives in `plans/groundwork/01-plan.md`; locked decisions in `plans/groundwork/04-discussion.md` (Rounds 1–4). This skill is the executable form of that plan.

---

## What groundwork is for

Stripped to one sentence: **a stateless action-set that scaffolds and maintains a folder of living planning documents, with traceable IDs threading plan → tracking → orchestration → board, so re-runs augment instead of clobber and a multi-agent kickoff falls out the back end.** Originated from the `com.ikenga.studio` planning workflow; generalized so it works for non-code, non-Ikenga work too.

Surface model:

| Surface | What it is | Trigger |
|---|---|---|
| Scaffolder (`init`) | First-run interview + folder skeleton drop | User has a goal but no plan folder |
| Action: `research` | Researcher agent fills `02`/`03` | After scaffolder, or to refresh |
| Action: `design` | Produces ≥2 comparable `designs/*.html` for the current phase, locks one (`design-lock`); each `D-NN` is then tracked through implement → verify | Visual/UX work, profile-gated |
| Action: `subplan` | Scaffolds a focused `NN-*.md` from one of three archetypes (diff-plan / decision-doc / bug-doc) | A hard piece needs its own focused doc (critical-path PR plan, between-round deliberation, postmortem) |
| Action: `review` | Reviewer agent → new Round in `04` → re-sync via IDs | Recurring, highest-value |
| Action: `clarify` | Readiness gate before `orchestrate` | Before kickoff |
| Action: `orchestrate` | Generates `09-orchestration.md` from `05` | When ready to kick off |
| Action: `refresh-board` | (Re)generates `artifact/board.html` & `artifact/explorer.html` and opens/returns `artifact/explorer.html` | Whenever board falls behind |
| Action: `refresh-living-spec` | Regenerates the `spec-state` fence inside `artifact/index.html` (Phasing/Decisions/Risks tabs) from `.groundwork.json` + `04` + `05` + `01 §Risks` | When the living-spec's auto tabs fall behind |
| Action: `explorer` | (Re)generates `artifact/explorer.html` — a file-tree + tabbed viewer (with **search**) of the whole plan folder; sibling to the board (opens it as a tab) | Browse the plan's files as one navigable view |
| Action: `plans-index` | (Re)generates `<plans-dir>/_index.html` — a **cross-plan** dashboard: one card per plan with status rollups + drill-in to each plan's explorer/board | See every plan in a project at once |
| Action: `issue-sync` | Provisions & syncs native Git forge issues (GitHub/GitLab) for `WP-NN`s | Remote status tracking & PR integration |
| Action: `status` | Read-only freshness + ID + design-coverage + sub-plan report | Anytime |

`init` is the one entry point that doesn't require an existing `.groundwork.json`. Every other action refuses to run without one (and tells the user to run `init` first).

---

## Routing

Match the user's request against the table; load the matching action file and follow it. **Do not inline action behavior in this file** — the actions are the source of truth.

| If the user says… | Load this | Then |
|---|---|---|
| "scaffold groundwork", "init", "new plan folder", "start groundwork in X/" | [`actions/init.md`](actions/init.md) | Interview goal + profile, scaffold, write `.groundwork.json` |
| "groundwork research", "do a research pass", "fill 02/03" | [`actions/research.md`](actions/research.md) | Spawn researcher; write inside fences (`--sweep` → multi-modal Workflow fan-out) |
| "groundwork design", "design pass", "mock up the UI options" | [`actions/design.md`](actions/design.md) | Profile-gated; compose design skill or plain HTML; lock one |
| "groundwork subplan", "scaffold an NN-*.md", "new diff-plan / decision-doc / bug-doc" | [`actions/subplan.md`](actions/subplan.md) | Scaffold a focused sub-plan from one of three archetypes; register in `.groundwork.json.subplans`; cross-link from 00-README |
| "groundwork review", "review pass", "gap analysis" | [`actions/review.md`](actions/review.md) | Spawn reviewer; append Round; re-sync via IDs (`--panel` → verified Workflow panel) |
| "groundwork clarify", "ready to orchestrate?" | [`actions/clarify.md`](actions/clarify.md) | Scan for open questions + unspecified IDs + missing locked designs |
| "groundwork orchestrate", "generate 09", "wave plan" | [`actions/orchestrate.md`](actions/orchestrate.md) | Runs clarify first; emits `09-orchestration.md` (`--emit-workflow` → runnable `.workflow.js` + offer to run) |
| "refresh the board", "update artifact/board.html" | [`actions/refresh-board.md`](actions/refresh-board.md) | Re-derive board data from current docs, sync explorer.html, and return/open explorer board |
| "groundwork explorer", "browse the plan files", "view/open the plan folder", "file explorer for this plan" | [`actions/explorer.md`](actions/explorer.md) | Build the typed file-tree model + write `artifact/explorer.html` (sibling to the board) |
| "groundwork plans-index", "index all the plans", "plans overview/dashboard", "every plan in this project" | [`actions/plans-index.md`](actions/plans-index.md) | Scan a `plans/` dir + write the cross-plan `<plans-dir>/_index.html` |
| "refresh the living spec", "update artifact/index.html", "the Phasing/Decisions/Risks tabs are stale" | [`actions/refresh-living-spec.md`](actions/refresh-living-spec.md) | Regenerate only the `spec-state` fence (Phasing/Decisions/Risks); the hand-authored Overview tab is never touched |
| "groundwork issue-sync", "sync git issues", "export wps to issues", "pull issue status" | [`actions/issues.md`](actions/issues.md) | Detect gh/glab CLI; provision missing issues & perform bi-directional status sync |
| "groundwork status", "where are we" | [`actions/status.md`](actions/status.md) | Read-only report |

### Discover vs. fast path

- **Discover path** — invoked cold ("scaffold a plan for X"). Run the `init` interview to capture goal + profile, then suggest `research` as the next step.
- **Fast path** — invoked in an existing groundwork folder ("groundwork review"). Read `.groundwork.json`, dispatch to the named action immediately. No interview unless the action itself needs one.

If invoked from inside a folder with no `.groundwork.json`, treat as discover even if the action name was given — refuse the action with a one-line "this folder isn't a groundwork plan yet; run `init` first."

### Click-to-fire prompts (per-action)

Each action file under `actions/` carries a `## Click-to-fire prompt` section at the bottom with two flavors: a **standalone slash form** (`/groundwork <action> [args]`) and a **seeded-session form** (a self-contained brief that works even in a chat where the skill isn't loaded). The Phase-4 board surfaces (Kickoff card / ⌘K palette / argument pickers) read these as their canonical strings — they are the single source of truth shared between the FE and the orchestrator agent. Substitution variables are documented inline per action (typically `{plan_folder}`, `{plan_title}`, `{plan_slug}`, `{profile}`).

---

## Profiles

A profile swaps **vocabulary** and **optional blocks**, not the spine. Templates use `{{vocab.*}}` placeholders (same substitution convention as `ikenga-pkg-builder`'s `{{id}}`/`{{slug}}`).

| Profile | Default for | `05` work-unit | `produces_designs` | Optional `01` blocks |
|---|---|---|---|---|
| `software` | Ikenga features, any code work | "work package" / PR | `true` | schema, manifest, adapter contracts, critical files |
| `general` | Non-code work — campaigns, org changes, research | "workstream" / "deliverable" | `false` | stakeholders, deliverables, success metrics |
| `content` | Editorial/marketing — content series, campaigns with key art | "piece" / "asset" | `true` | editorial standards, distribution plan |
| `design-system` | Component/token systems — design-language work | "part" | `true` | mode, taxonomy, tokens, fixtures, gallery, quality_gate |
| `film` | Filmmaking pre-production — short films, music videos, trailers, AI-generated film | "sequence" | `true` | treatment, lookbook, shotlist, shot_tracker, budget, schedule |

**Choosing between `content` and `film`**: both are creative and both produce designs, so the split is *shot-based vs not*. If the work has shots — a short film, music video, trailer, any AI-generated film — use `film`; its vocabulary (sequence / scene + reel / picture lock) and its shot ledger + render budget are what that work actually needs. Use `content` for editorial: articles, campaigns, key art. "It's creative, not code" is **not** a reason to reach for `content` — that reasoning lands film work in the wrong profile.

**Maintenance model**: a single `profiles/_shared/` base + thin per-profile overlays. `profile.json` declares `extends: "_shared"`; only diffs need to live in the overlay. Format spec in `01-plan.md` §"Domain profiles." `design-system` additionally declares its own `spine` (adding `parts-template.md` + `quality-gate.md` to the standard six docs).

**`film` hands off, it does not execute**: the profile owns creative development and production management (logline → treatment → bible → lookbook → schedule → budget). It does **not** own the shot board — `com.ikenga.studio` holds the authoritative per-shot render/approval state, and `05-tracking.md` is only a status mirror of it. When the two disagree, Studio wins.

`status` runs a profile-conformance check to catch drift in user-dropped profiles.

---

## State, identity & idempotency

The contract that makes stateless actions safe over an existing folder:

1. **`.groundwork.json`** at the folder root is the identity + state anchor every action reads first.
2. **Generated-region fences** (`<!-- groundwork:auto:start ID -->` … `<!-- groundwork:auto:end ID -->`) demarcate the only blocks an action may write. Everything outside a fence is hand-authored and never touched.
3. **Re-runs diff, not overwrite** — an action recomputes a region, hashes it, and writes only when the hash differs.
4. **Stable IDs** (`G-NN` gaps, `WP-NN` work packages, `G-<NAME>` gates, `D-NN` designs) thread `01` → `05` → `09` → board; the review action computes the affected-doc set from IDs + hashes, not from guessing.
5. **Designs are a tracked loop** — produce → review → lock → implement → verify. `ids[D-NN]` is the canonical design (linked to its `designs/*.html` variants). Every transition is a script command (`design-lock` / `design-unlock` / `register-design-impl` / `design-verify`), and build status is derived from WP status + PR records, never hand-kept. See `lib/state.md` §"Design lifecycle".

The full schema, fence grammar, hash-diff algorithm, and a worked example: **[`lib/state.md`](lib/state.md)**. Read it before any action that writes.

---

## Composition

groundwork *composes* existing skills rather than reimplementing them. Soft dependencies — every composed skill has a fallback:

| Capability | Preferred skill | Fallback |
|---|---|---|
| Plan-board artifact | `ikenga-artifact-builder` | Self-contained template at `profiles/_shared/board/index.html` |
| Plan-explorer artifact | — *(no file-explorer archetype fits; always the static template)* | Self-contained template at `profiles/_shared/explorer/index.html` (+ `design-system` / `content` overlays). **Fully offline** — React + `marked` + `DOMPurify` are inlined and the JSX is pre-transpiled (no Babel/CDN at runtime; rebuild from `*.src.html` via `scripts/build-offline-artifacts.mjs`) |
| Cross-plan dashboard | — *(static template)* | Self-contained template at `profiles/_shared/plans-index/index.html`; **fully offline** (inlined libs, pre-transpiled); written anchorless (`write-region-plain`) since it spans many plans |
| Design-quality spine (every `design` run) | `huashu-design` *(always engaged at step 2, regardless of surface)* | Plain self-contained HTML under Claude's own craft direction |
| Interactive / data-bearing design mockup | `ikenga-artifact-builder` *(layered with huashu)* | Plain self-contained HTML (studio's mockups needed nothing more) |
| Scroll-driven narrative mockup | `scrollytelling` *(layered with huashu)* | Plain self-contained HTML |
| Hi-fi / production frontend | `example-skills:frontend-design` / `web-artifacts-builder` *(layered with huashu)* | huashu-design alone |
| Anti-slop polish / critique / audit pass | `impeccable` *(layered with huashu)* | huashu's own expert-review pass |
| Build handoff for Ikenga pkgs | `ikenga-pkg-builder` | `09-orchestration.md` is the terminal deliverable |
| Multi-agent execution / fan-out (opt-in) | **`Workflow`** *(via `orchestrate --emit-workflow`, `research --sweep`, `review --panel`)* | Single `Agent` spawn + prose `09` handoff (today's default) |
| Requirements interviews | `AskUserQuestion` (global planning rule) | n/a — always present in Claude Code |

The `design` action does **not** pick one skill from this list — `huashu-design` is the always-on quality spine and Claude layers any combination of the others on top, deciding the blend while building (no limits). If `ikenga-artifact-builder` is absent, `refresh-board` writes the self-contained fallback template. If no design skill at all is installed, `design` falls back to plain HTML.

### Workflow (opt-in execution layer)

Three actions can deepen into a Workflow fan-out when the user asks for it — never by default, because Workflow is heavyweight, explicit-opt-in, and billed:

| Flag | Action | What it does |
|---|---|---|
| `--emit-workflow` | `orchestrate` | Also writes `artifact/orchestrate.workflow.js` — the runnable twin of `09`: waves → `parallel()` fan-out, freeze gates → adversarial sign-off barriers, WPs → worktree-isolated, schema-validated runs. Then **offers to run it**. |
| `--sweep` | `research` | Fans out finders by angle (precedent / library-docs / codebase / constraints) → synthesis. |
| `--panel` | `review` | Diverse-lens reviewer panel → dedup → perspective-diverse adversarial verify (kills plausible-but-wrong findings). Implements the old `--multi` stub. |

All three **return** schema-validated results (contracts in [`lib/schemas.md`](lib/schemas.md)) and the **calling session does every write** — Workflow scripts have no filesystem, so fences, IDs, `05` checkboxes, Tasks, commits, and merges stay in the action's hands, exactly as in the single-agent path. Drop the flag (or run without Workflow) and behavior is byte-identical to today. Each agent declares a `model` tier (haiku/sonnet/opus) per the global subagent-model policy.

---

## Portability

`groundwork` is a portable Claude Code skill. The Ikenga coupling is an additive layer:

| Capability | In Ikenga shell | Plain Claude Code / terminal | Any browser |
|---|---|---|---|
| Scaffold + actions | ✅ | ✅ | n/a |
| Research / review / orchestrate | ✅ | ✅ | n/a |
| Plan-board (view) | ✅ live status | ✅ open file | ✅ static |
| Copy brief from board | ✅ | ✅ | ✅ |
| Start session (click-to-implement) | ✅ _(Phase 2)_ | ➖ copy-prompt | ➖ copy-prompt |
| Live tracking binding | ✅ _(Phase 2)_ | ➖ reads `05` | ➖ |

**Phase 1 (this skill)** ships everything in the "Plain Claude Code / terminal" column and the static-board column. The `host.startChatSession` verb + live-tracking binding land in Phase 2 and are explicitly out of scope here — do not modify `shell/` or `contract/`.

---

## Critical files (this skill)

```
groundwork/
├── SKILL.md                                  ← you are here (router only)
├── lib/
│   ├── state.md                              ← state machine spec — every action obeys
│   └── schemas.md                            ← Workflow result contracts + model tiers
├── actions/
│   ├── init.md
│   ├── research.md
│   ├── design.md
│   ├── subplan.md                            ← scaffold NN-*.md sub-plans (diff-plan / decision-doc / bug-doc)
│   ├── review.md
│   ├── clarify.md
│   ├── orchestrate.md
│   ├── refresh-board.md
│   ├── refresh-living-spec.md                ← regenerate the spec-state fence in artifact/index.html
│   ├── explorer.md                           ← (re)generate artifact/explorer.html (file-tree + viewer + search)
│   ├── plans-index.md                        ← (re)generate <plans-dir>/_index.html (cross-plan dashboard)
│   └── status.md
├── agents/
│   ├── researcher.md                         ← brief template the research action spawns
│   ├── reviewer.md                           ← brief template the review action spawns
│   └── orchestrator.md                       ← brief template the orchestrate action spawns
├── scripts/
│   ├── groundwork_state.py                   ← byte-exact state executor (all subcommands)
│   ├── generate_explorer.py                  ← automate `explorer` for one plan / all plans (--all-under --missing-only)
│   ├── generate_plans_index.py               ← automate `plans-index` for a plans/ dir
│   ├── watch.py                              ← live-refresh an explorer / index as files change
│   └── build-offline-artifacts.mjs           ← rebuild the offline index.html from *.src.html (inlines libs, transpiles JSX)
└── profiles/
    ├── _shared/
    │   ├── profile.json                      ← base vocab + spine list
    │   ├── templates/                        ← spine docs with {{vocab.*}} + fences
    │   │   ├── 00-README.md
    │   │   ├── 01-plan.md
    │   │   ├── 02-research-external.md
    │   │   ├── 03-research-internal.md
    │   │   ├── 04-discussion.md
    │   │   ├── 05-tracking.md
    │   │   ├── subplans/                     ← NN-*.md archetype templates
    │   │   │   ├── diff-plan.md
    │   │   │   ├── decision-doc.md
    │   │   │   └── bug-doc.md
    │   │   └── artifact/                     ← scaffolded into <plan>/artifact/
    │   │       ├── index.html                ← living spec (Overview + Phasing/Decisions/Risks)
    │   │       ├── manifest.json
    │   │       ├── orchestrate.workflow.js   ← runnable twin of 09 (--emit-workflow)
    │   │       └── data/                     ← optional external data sources
    │   ├── board/index.html                  ← self-contained Mission Control + Wave-toggle
    │   ├── explorer/                         ← index.src.html (readable JSX source) → index.html (built, offline)
    │   │   └── …                              ← file-tree + tabbed viewer + search; base, profile-adaptive
    │   └── plans-index/                       ← index.src.html → index.html (built, offline); cross-plan dashboard
    ├── software/                             ← `extends: _shared`, produces_designs: true
    │   ├── profile.json
    │   └── templates/                        ← thin overlays (only the docs that differ)
    ├── general/                              ← `extends: _shared`, produces_designs: false
    │   ├── profile.json
    │   └── templates/
    ├── content/                              ← `extends: _shared`, produces_designs: true (key art)
    │   ├── profile.json
    │   ├── templates/
    │   └── explorer/index.html               ← media-first explorer overlay
    ├── design-system/                        ← `extends: _shared`, +parts-template + quality-gate docs
    │   ├── profile.json
    │   ├── templates/
    │   └── explorer/index.html               ← gallery-first explorer overlay
    └── film/                                 ← `extends: _shared`, produces_designs: true (lookbook / key frames)
        ├── profile.json
        └── templates/                        ← 01-plan (pre-production bible) + 05-tracking (shot ledger, Studio mirror)
```

The reference instance — the canonical worked example of every artifact in this spine — is `plans/studio/` in this workspace. Re-derive the spine from it on major `spine_version` bumps.

**Caveat on the studio reference**: studio predates two later locks — the living-spec / tracking-board split (commit `a6bc357`: studio's `artifact/index.html` is a single tabbed artifact, not the `index.html` living-spec + `board.html` tracking-board pair this skill scaffolds) and the `.groundwork.json` state anchor (studio has none). Read studio for the *spine shape and the prose conventions* (Round bodies, WP briefs, lifted-from headers, per-phase design discipline) — not as a literal current-shape template. The dogfood at `plans/groundwork/` is the up-to-date worked example of the post-split, anchored layout.

---

## What this skill does NOT do (in P1)

- **No shell or contract changes.** `host.startChatSession` is Phase 2 — board actions are copy-prompt only.
- **No live tracking binding.** The board reads markdown; harness-Tasks mirroring is Phase 2.
- **No board "Start session" button beyond copy-prompt.** Same reason.
- **No automatic renumbering of IDs.** Once allocated, an ID stays — retire instead of free.
- **No `groundwork kickoff` action.** The dogfood at `plans/groundwork/KICKOFF.md` is a hand-authored cross-session resumption snapshot (phase scope, locked decisions, what's-next) — useful, but a dogfood-specific artifact, not part of the scaffolded spine. A `kickoff` action that auto-snapshots the current phase boundary is a **deferred stretch idea** (Phase 2+, once `host.startChatSession` makes a snapshot worth seeding a session from); it is not in P1 and `init` does not scaffold a KICKOFF.md.

If the user asks for any of the above, say so explicitly and route them to the right phase.
