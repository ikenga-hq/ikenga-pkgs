# action: `orchestrate` — generate `09-orchestration.md` from `05`

**Loaded when**: the user is ready to kick off the build/execution and wants the multi-agent orchestration doc.

**Reads first**: `../lib/state.md`, `../agents/orchestrator.md`, the current `05-tracking.md` and `01-plan.md`, `.groundwork.json.ids` and `.designs`.

**Spine-version**: `expected = "1"`. Runs [`../lib/state.md` §"Spine-version preamble gate"](../lib/state.md#spine-version-preamble-gate) as the first step after loading `.groundwork.json` — writing action (regenerates `09-orchestration.md`, bumps `orchestrate.last_run` + `last_05_hash_seen`), so refuses on either direction of mismatch. No-op at v1=current.

**Pre-step**: runs `clarify` first; refuses on any `fail`, proceeds-with-caveats on `warn`.

**The reference instance is `plans/studio/09-orchestration.md`** — every section structure here is derived from it. Re-read it before changing the template.

---

## What it does

1. **Run `clarify`** as a pre-step. Refuse if any check `fail`s; record warns.
2. **Read inputs**: `05-tracking.md` (work blocks + their dependencies), `01-plan.md` §"Freeze gates" + §"Critical files," `.groundwork.json.ids` (every `WP-NN` + `G-<NAME>`), `.groundwork.json.designs` (locked designs to cite).
3. **Derive the structures**:
   - **Work-package matrix**: one row per `WP-NN` with title, repo/owner, deps, parallel-with, target.
   - **Freeze gates**: each `G-<NAME>` with the WP that owns it, why it gates, and the sign-off check.
   - **Wave plan**: topological sort of WPs over deps + gates; gates are sequential, post-gate WPs fan out in parallel.
   - **Intra-isolation matrix**: for parallel WPs sharing an isolation axis (e.g. same repo), the disjoint scopes (`software`: dir paths; `general`: stakeholder scopes).
   - **Mock contracts**: for cross-boundary WPs where the upstream isn't done yet, the agreed frozen interface so downstream can start.
   - **Per-WP briefs**: one self-contained brief per `WP-NN`, following the brief template.
   - **Model tier per WP**: stamp each `WP-NN` with a `tier` (`opus` / `sonnet` / `haiku`) by task weight (see [`../lib/schemas.md` §"Model tiers"](../lib/schemas.md)). Heuristic default — architecture/novel → `opus`, routine build → `sonnet`, mechanical → `haiku`; user-overridable via `--field tier=<t>`.
   - **Worktree-vs-branch recommendation**: based on parallel WP count and isolation axis.
4. **Link designs to work packages**: read `groundwork_state.py design-data --plan <plan>`. For each `WP-NN` that builds a designed surface, declare the link explicitly: `register-design-impl --plan <plan> --wp WP-NN --designs D-01,D-03`. That link is what later derives each design's build status. The brief's `DESIGNS` field lists each implemented `D-NN` with its locked file, lock round, and the states the spec names. Only a WP with no `implements` falls back to the old phase match (every locked `D-NN` in its phase), marked `(inferred — declare with register-design-impl)`. A WP that implements an unlocked design fails clarify check 3 unless the user opts in, and its brief says so.
5. **Write `09-orchestration.md`** — this is the one file `orchestrate` rewrites whole; the convention is "delete and re-author." Hand-written sections live above an explicit `<!-- groundwork:auto:start orchestration -->` fence and are preserved.
6. **Update `.groundwork.json`**:
   - Bump `docs["09-orchestration.md"]`.
   - Set `orchestrate.last_run` to now.
   - For each `WP-NN`, refresh `wave`, `depends_on`, `gate`, `tier` in the ID registry.
7. **Emit the runnable Workflow** *(opt-in, only when `--emit-workflow` is passed)* — see §"Emitting a runnable Workflow" below. Default (no flag): skip; `09-orchestration.md` is the terminal deliverable exactly as today.
8. **Print next steps** — typically "open the board (`groundwork refresh-board`) and start running WPs," or "kick off Wave 0 first."

---

## `09-orchestration.md` shape

Structure (mirror studio's exactly):

```markdown
# <Plan title> — implementation orchestration

How to drive the build with **one orchestrator agent + per-{{vocab.work_unit}} subagents**…

> **Source of truth**: `05-tracking.md`. At kickoff the orchestrator mirrors each {{vocab.work_unit}} into a harness Task…

---

## Execution model
[ orchestrator / subagent ownership · isolation-axis statement · workspace-link rebuild step ]

## Freeze gates (hard, sequential)
| Gate | {{vocab.work_unit}} | Why it gates | Sign-off check |

## Work-package matrix
| WP | Title | Repo/Owner | Depends on | Parallel with | PR target / Output |

### Wave plan (orchestrator spawn order)
- **Wave 0 (gates)** — …
- **Wave 1 (post-gate fan-out)** — …
…

### Intra-{{vocab.isolation_axis}} isolation
[ per-WP disjoint scope map ]

## Mock contract (so cross-boundary agents don't serialize)
### 1. <seam> (lets WP-X start before WP-Y)
[ contract definition, env flag, owner ]

## Subagent brief template

```
GOAL · REPO/OWNER · BRANCH/SCOPE · DEPENDS-ON · FILES (create/touch) · CONSUMES · PRODUCES ·
DO-NOT-TOUCH · DESIGN REFERENCE (if a locked D-NN applies) · DESIGNS (D-NN implemented) ·
DEFINITION OF DONE · MOCK (if upstream not ready) · REPORT
```

The agent brief in `agents/orchestrator.md` and the per-WP example below use the same shape — `REPO` resolves to `OWNER` under the `general` profile, `BRANCH` resolves to `SCOPE`, and `DESIGN REFERENCE` is omitted when no locked design applies.

---

### WP-NN — <title>
- **GOAL**: …
- **REPO/OWNER**: …
- **BRANCH**: …
- **DEPENDS-ON**: …
- **FILES**: …
- **CONSUMES** / **PRODUCES**: …
- **DO-NOT-TOUCH**: …
- **DESIGN REFERENCE**: <designs/path> (if locked design exists)
- **DESIGNS**: D-01 — <title> · `designs/d-01-….html` · locked Round 3 · states: default, error, declined · (omit when `implements` is empty; mark phase-matched ones `(inferred)`)
- **DEFINITION OF DONE**: … (for a designed surface: "matches the locked mockup of every D-NN above, state by state; PR body names them on its Designs implemented line")
- **REPORT**: … (include `designs_implemented: [D-NN…]`, `[]` when none)
- **MOCK** (if applicable): …

---

[ … one section per WP-NN … ]

---

## PR body
[ the template every WP PR uses — see §"PR body template" below ]

## Tracking protocol
[ kickoff · live run · durable sync · blocked / needs-decision · merge order ]

## Open coordination questions (resolve at kickoff)
[ any `warn` from clarify · plus user-recorded opens from 04 ]
```

The exact section headers + horizontal-rule layout match `plans/studio/09-orchestration.md`. The brief shape is identical.

---

## Profile vocabulary

The `software` profile fills:

- `{{vocab.work_unit}}` → "work package"
- `{{vocab.isolation_axis}}` → "git repo + disjoint dirs"
- `{{vocab.freeze_gate_noun}}` → "interface freeze" (or "schema freeze" / "contract freeze" as appropriate)
- REPO/BRANCH/PR-target language

The `general` profile fills:

- `{{vocab.work_unit}}` → "workstream" or "deliverable"
- `{{vocab.isolation_axis}}` → "owner + non-overlapping scope"
- `{{vocab.freeze_gate_noun}}` → "decision lock"
- OWNER instead of REPO; no PR-target language; "session seeded with this brief" instead of "branch + PR"

The `content` profile fills:

- `{{vocab.work_unit}}` → "piece" (or "asset")
- `{{vocab.isolation_axis}}` → "channel + editorial slot"
- `{{vocab.freeze_gate_noun}}` → "key-art lock" (or "brief/voice lock" for the upstream gate)
- OWNER + CHANNEL instead of REPO; no PR-target language; "session seeded with this brief" instead of "branch + PR"; gates are brief/voice locks and key-art locks, not interface freezes

**No code vocabulary leaks into a `general` *or* `content` orchestration.** This is Verification #8 in `01-plan.md`.

---

## Wave-plan computation

Given a DAG of WP nodes with edges from `depends_on`:

```
Wave 0 = WPs with no deps that produce a freeze gate
Wave N = WPs whose deps are all in waves < N
```

A WP that depends on a gate is in the wave **after** the gate's WP. Gates within a wave are sequential; WPs in the same wave are parallel (subject to intra-isolation-axis disjoint scope).

Ties (multiple valid orderings) break by ID number, ascending.

---

## Brief self-containedness

Each `WP-NN` brief must be a complete subagent prompt — a fresh agent receiving only the brief must be able to execute. **Briefs reference `01` and `05` by section** (e.g. "see `05-tracking.md` §3") so the subagent reads the minimum needed, not the whole plan.

The orchestrator agent (the one driving execution at kickoff) reads the whole `09`; subagents read only their assigned brief.

---

## Hand-written orchestration intro

Users may want a custom intro section in `09` (project-specific context, owner names, repo URLs). The convention:

```markdown
[ optional hand-written intro section ]

<!-- groundwork:auto:start orchestration -->
[ everything generated by orchestrate ]
<!-- groundwork:auto:end orchestration -->
```

The action writes only inside the fence. Hand intro is preserved on re-runs.

---

## PR body template

Every WP pull request (software profile) uses this body; `09` carries it under `## PR body` so subagents copy it verbatim. The **Designs implemented** line is required: list each `D-NN` the change implements, or `none`. `issue-sync` and the orchestrator parse this line into `register-design-impl`; a design-conformance review (`actions/review.md` §"Design reviews") is triggered by any `D-NN` on it.

```markdown
## WP-NN — <title>

Closes #<issue>  ·  Plan: `<plan_slug>`  ·  Wave <n>

Designs implemented: D-01, D-03        <!-- required; `none` when the change builds no designed surface -->

### What changed
- …

### Definition of Done
- [ ] … (copied from 09 §WP-NN)
- [ ] Matches the locked mockup of every design above, state by state (default · empty · loading · error · … as the spec names)

### Drift from the brief
none  <!-- or one line per divergence; feeds the drift log -->
```

A PR that alters a locked design's appearance must cite the unlock Round (`design-unlock`) in "Drift from the brief"; without it the conformance review returns the PR.

---

## Kickoff Task mirror (live status — WP-12)

`orchestrate` itself does **not** create harness Tasks (it only writes `09`). The mirror happens at **kickoff**, driven by the orchestrator brief (`agents/orchestrator.md` §"Execution protocol · KICKOFF"): the orchestrator reads `05-tracking.md` and calls `TaskCreate` once per `WP-NN` (title `WP-NN <title>`, body = the WP's Definition of Done), mirroring wave deps where supported.

The contract this enforces:

- **`05-tracking.md` is the durable cross-session source of truth.** Checkbox writes survive sessions; only the orchestrator writes them.
- **Harness Tasks are the live, in-session view.** They let the shell board reflect the *current run's* status (once the board is seeded via `host.startChatSession` — WP-11) instead of re-parsing markdown that may lag.
- On each WP completion the orchestrator sets the Task `completed` **and** ticks the `05` checkbox, so the live view and the durable SoT stay in lockstep.

So the generated `09` always carries the kickoff Task-mirror instruction in its `## Tracking protocol` section; the orchestrator agent executes it.

---

## Emitting a runnable Workflow (`--emit-workflow`)

**Opt-in.** Without the flag, orchestrate behaves exactly as today — prose `09` only. With `--emit-workflow`, after `09-orchestration.md` is written, also generate its **executable twin**: `artifact/orchestrate.workflow.js`, a Workflow script that fans out the build wave-by-wave instead of leaving execution to an improvising orchestrator agent.

This is worth it because the wave plan orchestrate already computes maps almost 1:1 onto Workflow primitives — **waves → `parallel()` fan-out**, **freeze gates → barriers with adversarial sign-off**, **the worktree-vs-branch recommendation → `isolation:'worktree'`**, **per-WP DoD → a `WP_REPORT_SCHEMA`-validated return**. The prose `09` stays the human-readable source of truth; the `.workflow.js` is the runnable form of the same data.

### How it's generated

1. Read the model with `python3 <skill>/scripts/groundwork_state.py board-data --plan <plan> --with-briefs` — emits each `WP-NN` with `id / title / wave / deps / gate / tier` **plus** its `brief` (parsed from the `09` §WP-NN section just written).
2. Group WPs by `wave`, attach each wave's owning `gate` (from the freeze-gates table), in wave order → the `WAVES` array.
3. Fill the template `profiles/_shared/templates/artifact/orchestrate.workflow.js`:
   - `{{plan_title}}`, `{{slug}}` → string literals.
   - `{{meta_phases}}` → one phase per wave, e.g. `[{title:'Wave 0 · G-CONTRACT'},{title:'Wave 1'}]` (must stay a **pure literal** — `meta` allows no variables).
   - `{{waves_json}}` → the `WAVES` array as a JSON literal (`[{title, gate|null, wps:[{id,title,tier,brief}]}]`).
4. Write `artifact/orchestrate.workflow.js`; register it in `.groundwork.json.docs` (whole-file hash; regenerated, never hand-edited).

### The no-filesystem invariant (why the script returns instead of writes)

Workflow scripts have **no filesystem / `Date` / `Math.random`** access. So the emitted script:

- **Inlines each brief as a string constant at emit time** (that's why `board-data --with-briefs` lifts them now, not at run time).
- **Does the fan-out execution + per-gate adversarial verification, then `return`s the WP reports.** It does **not** tick `05` checkboxes, mirror Tasks, commit, or merge.
- **The orchestrator session reconciles afterward** from the returned reports: tick `05`, mirror/close Tasks, commit `chore({plan_slug}): WP-NN done`, merge in wave order. This preserves the skill's "only the orchestrator writes `05`" invariant and keeps the human in the loop at every freeze gate (a failed gate `return`s `{halted, failed, …}` and the run stops). See [`../lib/state.md` §"Workflow execution invariants"](../lib/state.md).

### Emit + offer to run

After writing the file, **offer to run it** (don't auto-run — Workflow is heavyweight, explicit-opt-in, and billed):

> Wrote `artifact/orchestrate.workflow.js` (N waves, M work packages). Run it now? It'll fan out each wave, verify every freeze gate, and report back — I'll then reconcile `05`/Tasks/merges. (`/workflows` shows live progress.)

On yes, the **calling session** invokes `Workflow({ scriptPath: "<plan>/artifact/orchestrate.workflow.js" })`, then reconciles from the returned `results`. On no, the user can run it themselves anytime. Either way `09-orchestration.md` remains the readable handoff and the single-orchestrator-agent path (`agents/orchestrator.md`) is still available as the no-Workflow fallback.

### Edge cases (emit)

- **Cycle / missing gate** — already refused at the matrix-derivation step; emit never runs on an invalid DAG.
- **A WP is read-only / analysis (no file writes)** — drop `isolation:'worktree'` for that agent at emit time (worktrees cost ~200–500ms + disk; only worth it for parallel mutating WPs).
- **No `--emit-workflow`** — no script written, `.groundwork.json.docs` unchanged for that path. Re-running with the flag later is idempotent (hash-diff on the whole file).

---

## Re-run semantics

Per `lib/state.md`:

- Identical generated content → no write.
- Changed `05` or IDs → re-generate the `09` fence content; whole-file hash bumps.
- Hand-written sections above the fence: byte-identical.

The hash-diff is over the **generated section's** content, not the whole file.

---

## Edge cases

- **Plan has no `WP-NN` IDs yet** — refuse with "no work packages defined; add some to `05-tracking.md` first." The action does not auto-derive WPs from prose — that's a design choice (deterministic IDs need user intent).
- **DAG has a cycle** — refuse, print the cycle.
- **A WP depends on a gate that doesn't exist** — refuse, print the missing gate.
- **Locked design references a phase / WP that's not in the matrix** — write the orchestration, but flag the orphaned design in the report.
- **`clarify` failed** — refuse; print clarify's report and the remediation.

---

## Click-to-fire prompt

The canonical strings the FE emits (palette / Kickoff card per WP-20 / WP-21). Substitution variables: `{plan_folder}`, `{plan_title}`, `{plan_slug}`, `{profile}`.

**Standalone slash form**:

```
/groundwork orchestrate
```

**Seeded-session form** (this is the brief the Kickoff card seeds — the per-action brief here is for *generating* `09-orchestration.md`; the orchestrator-at-kickoff brief that drives the build lives in `agents/orchestrator.md` and is what WP-20's Kickoff card actually seeds):

```
Run groundwork orchestrate on `{plan_folder}` (plan title: {plan_title}, slug: {plan_slug}, profile: {profile}).

If the groundwork skill is loaded in this session, follow its `orchestrate` action verbatim — read `.claude/skills/groundwork/actions/orchestrate.md`, run `clarify` as a pre-step, derive the WP matrix / freeze gates / wave plan / per-WP briefs from `05-tracking.md` + `.groundwork.json.ids`, and write `09-orchestration.md` inside its generated-region fence. If the skill is not loaded, read `{plan_folder}/05-tracking.md` + `01-plan.md` + `.groundwork.json` and produce the equivalent doc by hand — the canonical section layout is documented in `.claude/skills/groundwork/actions/orchestrate.md` §"`09-orchestration.md` shape" (header list, fence convention, brief template).

Do not spawn subagents — orchestrate derives the doc deterministically. The orchestrator-at-kickoff brief (the one that actually drives the build by spawning subagents) is in `.claude/skills/groundwork/agents/orchestrator.md` — that's a separate seeding step, fired by the Kickoff card.
```
