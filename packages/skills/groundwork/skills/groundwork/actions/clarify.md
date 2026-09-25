# action: `clarify` — readiness gate before `orchestrate`

**Loaded when**: the user wants to check whether the plan is ready to be orchestrated; or `orchestrate` was invoked and runs clarify first.

**Reads first**: `../lib/state.md`, the current `01-plan.md`, `04-discussion.md`, `05-tracking.md`, and `.groundwork.json`.

**Spine-version**: `expected = "1"`. Runs [`../lib/state.md` §"Spine-version preamble gate"](../lib/state.md#spine-version-preamble-gate) as the first step after loading `.groundwork.json` — read-only-by-default action, so on anchor-too-old **refuses with the migrate hint**, on anchor-too-new **warns and proceeds with read-only semantics** (returns a partial readiness report with the version-skew explicitly flagged). With `--fix` passed it treats itself as a writing action and refuses on either direction of mismatch. No-op at v1=current.

**Read-only by default** — does not write to disk unless `--fix` is passed (and even then, only updates `.groundwork.json` flags; no doc content). spec-kit's `/clarify` precedent: catching ambiguity before planning measurably cuts downstream rework.

---

## What it checks

A seven-point readiness scan:

| # | Check | How |
|---|---|---|
| 1 | **Open questions in `04`** | Scan for "Open questions / not blocking" headings without an answer below; flag each. |
| 2 | **Unspecified IDs in `01`** | Find `G-NN` / `WP-NN` mentions in `01` that have no entry in `.groundwork.json.ids`, or have `status: open`. |
| 3 | **Design readiness for visual profiles** | Run `groundwork_state.py design-data --plan <plan>` and read the phase about to be orchestrated. **`fail`** if any `D-NN` in that phase is not `locked`, or (legacy plans with no `D-NN`) the phase has WPs but no locked design file. **`warn`** for each design warning (locked without a file, locked file missing on disk, built against an unlocked design), each unlinked design file (`design-migrate` links them), and each locked `D-NN` with no implementing WP (orchestrate would fall back to phase matching). A `D-NN` with no file yet is `planned` — reported as not locked, never as "missing". |
| 4 | **`05-tracking.md` drift from `01`** | For every ID in `01`, confirm `05` references it (or the regions covering it are coherent). |
| 5 | **Critical-path freshness** | If `01`/`05` whole-file hashes have changed since the last `orchestrate`, the critical path may be stale. |
| 6 | **Active sub-plans** | Find sub-plans with `status: active` and surface their `ref` WPs. **Not a blocker** — active sub-plans are a normal state during a build. But if `orchestrate` is about to run and a sub-plan's ref WP is `queued`, surface it as a `warn` so the orchestrator's kickoff brief can mention "WP-NN has its own diff-plan at NN-*.md — read it before starting." |
| 7 | **Profile conformance** | The active profile's vocab + required fields are present in the scaffolded docs. Catches drift if a user mucked with profile.json. |

Each check returns `pass` / `warn` / `fail`. The action prints a concise report.

---

## Exit semantics

| Result | Meaning | What `orchestrate` does next |
|---|---|---|
| All `pass` | Ready | Proceeds (when invoked as the pre-step). |
| Any `warn` | Ready with caveats | Proceeds but flags them in `09`'s "Open coordination questions" section. |
| Any `fail` | Not ready | Refuses; lists the failures and the fix for each. |

When invoked standalone (not as `orchestrate`'s pre-step), `clarify` always returns its report — no proceed/refuse decision.

---

## Report shape

```
groundwork clarify · <plan-folder> · profile <profile>
================================================================

  ✓ 1. Open questions          no unresolved open-questions in 04
  ⚠ 2. Unspecified IDs         WP-12 has no 05 section yet
  ✓ 3. Locked designs          P1: 2/2 · P2: 0/0 · P3: 0/0
  ✓ 4. 01 ↔ 05 ID coherence    13 IDs cross-referenced cleanly
  ⚠ 5. Critical-path freshness 01 changed since last orchestrate (run refresh-board)
  ⚠ 6. Active sub-plans         1 · 06-startSeededChat-extraction.md (ref WP-09, status queued)
                                  └─ kickoff brief should reference this sub-plan
  ✓ 7. Profile conformance     software · all required fields present

Summary: 4 pass · 3 warn · 0 fail · READY-WITH-CAVEATS
```

---

## What it does NOT do

- **Does not write to docs.** No fence updates. (The `--fix` flag may update `.groundwork.json` flags only — e.g. mark a `G-NN` as `status: resolved` if the user confirms.)
- **Does not spawn agents.** It's a deterministic scan over existing state.
- **Does not guess answers to open questions.** It surfaces them; the user resolves.

---

## Open-question detection (check #1)

Scan `04-discussion.md` for:

```
## Open questions
- <question> (defaults to <X>)
- <question>
```

and any "(lean: <answer>)" / "(deferred)" markers. Items without resolution markers are considered open. The action also accepts a per-question front-matter `resolved: true` to override the heuristic.

---

## Critical-path freshness (check #5)

The critical-path region in `05-tracking.md` is owned by `orchestrate`. The check is: **does the on-disk whole-file hash of `01` or `05` differ from the value `orchestrate` recorded when it last ran?** If so, those docs changed after the last orchestration and the critical path may be stale — flag `warn`.

The action records `orchestrate.last_run` (and the `01`/`05` hashes as of that run) in `.groundwork.json` and compares against the current on-disk hashes.

---

## Edge cases

- **Plan has never been orchestrated** — checks 5 is `n/a` (not `fail`). The rest still run.
- **`general` profile** — check 3 (locked designs) is `n/a` (`produces_designs: false`).
- **Plan has no IDs yet** — checks 2/4 trivially pass (nothing to verify). Surface as a `note` not `fail`.
- **No `04-discussion.md`** — `init` always creates it; absence is a corrupt state; refuse with a remediation message.

---

## Click-to-fire prompt

The canonical strings the FE emits (palette per WP-21). `clarify` is a **read-action** — when invoked from the palette in-shell, it routes through `art.sendToActiveSession` (per WP-22) rather than minting a fresh session. Substitution variables: `{plan_folder}`, `{plan_title}`.

**Standalone slash form**:

```
/groundwork clarify
```

**Seeded-session form**:

```
Run a groundwork clarify (readiness gate) on `{plan_folder}` (plan title: {plan_title}).

If the groundwork skill is loaded in this session, follow its `clarify` action verbatim — read `.claude/skills/groundwork/actions/clarify.md` and run the seven-point readiness scan, returning per-check pass/warn/fail. If the skill is not loaded, read `{plan_folder}/01-plan.md`, `04-discussion.md`, `05-tracking.md`, and `.groundwork.json` and produce the same seven checks: (1) open questions in 04, (2) unspecified IDs in 01, (3) missing locked designs for visual profiles, (4) 05 drift from 01, (5) critical-path freshness, (6) active sub-plans, (7) profile conformance.

Read-only. Do not write to disk.
```
