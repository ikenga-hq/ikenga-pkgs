# action: `status` — read-only health report

**Loaded when**: the user asks "where are we" / runs `groundwork status`.

**Reads first**: `../lib/state.md`, `.groundwork.json`, every doc in the spine.

**Spine-version**: `expected = "1"`. Runs [`../lib/state.md` §"Spine-version preamble gate"](../lib/state.md#spine-version-preamble-gate) as the first step after loading `.groundwork.json` — read-only action, so on anchor-too-old it **refuses with the migrate hint** (status of a not-yet-migrated folder isn't meaningful), but on anchor-too-new it **warns and proceeds with read-only semantics** (the report degrades gracefully and explicitly tags fields it can't interpret). No-op at v1=current.

**Read-only.** Never writes to disk. The cheapest possible action — makes the stateless-invocation problem legible to the user.

**Mechanics**: don't recompute hashes or conformance by hand — get the computed model from the script and format it:

```bash
python3 <skill>/scripts/groundwork_state.py status-data --plan <plan> --profiles-root <skill>/profiles
```

It returns per-doc sync/drift + dirty-region lists (real sha256 diff), ID counts, sub-plan/design/research state, and the conformance verdict for **every** profile on disk. Render the report below from that JSON; the freshness ("X days old") and the suggested-actions ranking are the action's to compute from the returned stamps.

---

## What it reports

```
groundwork status · <plan-folder>
================================================================
Profile:        software (extends _shared)         spine_version: 1
Goal:           Lift the share-card renderer into a pkg
Created:        2026-05-20 · Updated: 2026-05-20

Documents
  01-plan.md                ✓ in sync
  02-research-external.md   ⚠ stamped 2026-04-15 (35d old)
  03-research-internal.md   ✓ stamped 2026-05-20
  04-discussion.md          ✓ in sync (last round: 4)
  05-tracking.md            ✗ hand edit inside `wp-matrix` fence — re-run orchestrate to overwrite
  09-orchestration.md       — not generated yet (run orchestrate)
  artifact/board.html       ⚠ stale: 3 input docs changed since refresh (run refresh-board)
  artifact/index.html       ⚠ spec-state fence empty (run refresh-living-spec)

IDs (13 total)
  G-NN gaps:       2 open · 6 folded · 0 retired
  WP-NN packages:  13 defined · 1 in_progress · 12 queued · 0 blocked · 0 done
  G-<NAME> gates:  3 declared · 1 passed · 2 pending
  D-NN designs:    7 total · 2 locked · 1 drafted · 4 planned

Design coverage                              (from status-data .design_lifecycle.coverage)
  P1: 2/7 locked · 1 implemented · 1 verified  ⚠ (5 not locked — design before P1 orchestration)
  P2: 0/0 locked  — not yet approached

Design lifecycle                             (one line per D-NN; design_state · build_state)
  D-01  Identity & consent   locked Round 3 · verified Round 6   WP-01 · PR #42 merged
  D-02  Profile              locked Round 3 · in progress        WP-01
  D-03  Deal-breakers        drafted        · unbuilt            ⚠ 1 open finding (G-14 · error · app/…/DealBreakers.tsx:88)
  D-04  Assessment           planned        · unbuilt
  ⚠ 1 design file not linked to a D-NN — run `groundwork_state.py design-migrate`

Sub-plans
  active:  1 · 06-startSeededChat-extraction.md (diff-plan · ref WP-09 · G-VERB)
  landed:  0
  abandoned: 0
  deferred:  0
  ⚠ 1 active sub-plan tracks in-flight work — check if its WP is ready to flip from `queued` to `in_progress`

Profile conformance
  ✓ all required vocab present
  ✓ all spine files present
  ✓ no profile-format drift

Next suggested actions
  • Run `groundwork research --external` — research stamp is 35 days old
  • Resolve 2 open G-NN findings (see 04-discussion.md Round 4)
  • Run `groundwork refresh-board` to refresh artifact
```

The exact icon set: `✓` pass · `⚠` warn · `✗` fail · `—` n/a.

---

## How it computes each line

| Line | Source |
|---|---|
| Profile / goal / version | `.groundwork.json` direct read |
| Doc "in sync" | On-disk whole-file hash == `.groundwork.json.docs[file].hash` |
| Doc "hand edit inside fence" | Inner-fence hash on disk != recorded region hash for any region |
| Doc "stamped X days old" | `.groundwork.json.research[file].stamped` vs today |
| "Stale: N input docs changed since refresh" | Whole-file hash drift count of `01`/`04`/`05`/`09` vs `refresh-board.last_run` |
| G-NN counts | `.groundwork.json.ids` filter by kind + status |
| WP-NN status counts | Same; cross-check against `05-tracking.md` checkboxes if present |
| Design coverage | `status-data` → `design_lifecycle.coverage` (locked / planned `D-NN` per phase, plus implemented, verified, unlinked files). Plans with no `D-NN` fall back to `designs` files grouped by `phase` |
| Design lifecycle | `status-data` → `design_lifecycle.designs[]`: `design_state` (planned / drafted / locked), `build_state` (unbuilt / in_progress / implemented / verified), implementing WPs + PRs, open findings, warnings. Suggest `design-migrate` when `summary.unlinked > 0` |
| Sub-plans | `.groundwork.json.subplans` grouped by `status` (active / landed / abandoned / deferred); flags actives whose `ref` WP is still `queued` (signal: implementation hasn't started but the plan-for-it has been drafted — fine, but worth confirming) |
| Profile conformance | Walk profile-required keys against rendered template state |

---

## Profile conformance check

The full profile contract — file layout, schema, resolution algorithm, validation rules — is specified in [`../lib/state.md` §"Profile contract"](../lib/state.md#profile-contract). `status` is the gate that enforces it.

On every run, `status` validates **every** profile on disk under `.claude/skills/groundwork/profiles/<name>/` — not just the active one — so a hand-dropped invalid profile surfaces before the next `init` tries to use it. Rules 1–9 from the contract are **hard rejections** (the profile is reported ✗ with the canonical error message and is unselectable by `init`); rule 10 (unknown top-level key) is a **warn** with the offending key named.

Sample output:

```
Profile conformance
  ✓ _shared           — base
  ✓ software          — extends _shared
  ✓ general           — extends _shared
  ✓ content           — extends _shared
  ✗ ops               — extends must be "_shared" (got undefined)        [rule 4]
  ⚠ research          — unknown top-level key "owner" (allowed: name,…)   [rule 10]
```

Each line carries one of:

| Glyph | Meaning | Trigger |
|---|---|---|
| `✓` | Conformant | Every rule passes |
| `✗` | Rejected | Any of rules 1–9 fail; profile is excluded from `init` selection |
| `⚠` | Warn | Rule 10 only — profile is still usable; preserves forward-compat |
| `—` | n/a | `_shared` base (no `extends` rule applies) |

When the **active** plan's profile is `✗`, every action other than `status` refuses with `plan uses non-conformant profile "<name>": <error>. Fix profile.json or run init --migrate.` (Migrate path is gated on a v2 spine — until then, fixing the profile.json is the only remediation.)

The user-facing error messages are the canonical strings from `lib/state.md` §"Profile contract" rule table — do not paraphrase. They're load-bearing for users grepping logs or matching against documented failures.

### What it does NOT check

- **Template substitution rendering** — `status` doesn't render the spine templates to validate `{{vocab.*}}` placeholders resolve. That happens at `init` time (and a missing `vocab.*` is already caught by rule 6).
- **Optional-block fence presence in already-scaffolded plans** — a profile that declares `optional_blocks: ["risks"]` doesn't require every existing plan to carry a `risks` fence. Optional means optional.
- **Cross-profile uniqueness** — two profiles with the same `labels.work_unit` is fine; `name` is the only unique key (enforced by directory layout).

---

## Output modes

- **Default** — human-readable text as shown above. Suitable for terminal.
- **`--json`** — emit a machine-readable JSON with the same fields, for piping into other tools.
- **`--quiet`** — only print warnings + failures + suggested actions; suppress green-pass lines.

---

## Suggested actions

The "Next suggested actions" section is rule-based, not heuristic:

| Trigger | Suggestion |
|---|---|
| Research stamp > 30 days | `groundwork research --external` (or `--internal`) |
| Any `G-NN` with `status: open` | "resolve N open findings (see <doc> Round <N>)" |
| Any `D-NN` undesigned for a phase about to be orchestrated | `groundwork design --phase <P>` |
| Any sub-plan with `status: active` whose ref WP is `queued` | "kick off <WP-NN> — its sub-plan is ready" |
| Whole-file drift of `01`/`05` since last `orchestrate` | `groundwork orchestrate` |
| Whole-file drift of inputs since last `refresh-board` | `groundwork refresh-board` |
| `spec-state` fence in `artifact/index.html` is empty (`generated_at: null`) or its inputs drifted since `refresh_living_spec.last_run` | `groundwork refresh-living-spec` |
| `artifact/explorer.html` exists and ≥1 spine/sub-plan doc shows whole-file drift (its embedded snapshot is behind) | `groundwork explorer` |
| `clarify` would `fail` | "fix `<N>` blockers before orchestrating" |
| Plan has never been orchestrated and clarify passes | `groundwork orchestrate` |

Print at most three suggestions, prioritized in the order above. The `explorer` suggestion sits **below** board + living-spec staleness on purpose — it's a convenience view, not a gate, so it never crowds out a more important refresh in the three-suggestion cap.

---

## Edge cases

- **No `.groundwork.json`** — refuse with "not a groundwork plan folder; run `groundwork init` first."
- **`.groundwork.json` references a file that doesn't exist** — report it as `✗ missing — restore or run init --force`.
- **`.groundwork.json` is corrupt** — refuse, suggest restoring from git.
- **Workspace context with multiple groundwork folders** — status scans only the folder argument (or cwd); never recurses into subdirs. Multi-plan reporting is out of scope for P1.

---

## Click-to-fire prompt

The canonical strings the FE emits (palette per WP-21). `status` is a **read-action** — when invoked from the palette in-shell, it routes through `art.sendToActiveSession` (per WP-22) so the report lands in the active chat thread rather than minting a fresh session. Substitution variables: `{plan_folder}`, `{plan_title}`.

**Standalone slash form**:

```
/groundwork status
```

**Seeded-session form**:

```
Run groundwork status on `{plan_folder}` (plan title: {plan_title}).

If the groundwork skill is loaded in this session, follow its `status` action verbatim — read `.claude/skills/groundwork/actions/status.md` and produce the standard health report (profile, spine version, doc freshness, ID summary, sub-plan status, suggestions). If the skill is not loaded, read `{plan_folder}/.groundwork.json` and the docs it tracks, then produce the same report shape by hand.

Read-only. Do not write to disk.
```
