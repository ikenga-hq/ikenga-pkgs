# groundwork — plan state, identity & idempotency

The reference every action obeys. If two actions disagree about what is "generated" versus "hand-written," the bug is here, not in the actions. Read this once; the action files are thin and assume these rules.

**Contents** — jump to what you need:
- [`.groundwork.json` — the identity + state anchor](#groundworkjson--the-identity--state-anchor) — schema, fields, atomic writes, spine-version gate
- [Profile contract](#profile-contract) — file layout, `profile.json` schema, resolution algorithm, the 10 conformance rules, worked example
- [Generated-region fences](#generated-region-fences) — syntax, rules, reserved fence IDs by action
- [Hash-diff re-run semantics](#hash-diff-re-run-semantics) — the per-region algorithm, idempotency definition, the whole-file hash
- [Stable IDs (Round 2 traceability)](#stable-ids-round-2-traceability-backbone) — formats, threading rules, discovery
- [Worked example](#worked-example) — init → research → review, end to end

---

## The executor: `scripts/groundwork_state.py`

**The mechanics in this file are implemented by a script, not performed by hand.** `scripts/groundwork_state.py` (Python 3, stdlib only — runs anywhere `python3` is, no install) is the authoritative executor for everything that must be byte-exact: fence read/write, sha256 hash-diff, atomic anchor writes, the spine gate, the 10 profile-conformance rules, ID allocation, template scaffolding, and the board/status data models.

This matters because the skill's central promise is **byte-exact idempotency** (a re-run changes nothing on disk, mtimes preserved). An agent hand-computing sha256 and hand-reproducing fenced content cannot reliably deliver that; the script can. So: **actions call the script for state mechanics; they never hand-compute a hash or hand-edit `.groundwork.json`.** This file is the *spec* for what the script does — read it to understand the contract; call the script to execute it.

Invoke it from any action with Bash. The skill dir is the parent of `lib/`; the script is at `<skill>/scripts/groundwork_state.py` and the built-in profiles at `<skill>/profiles`. Command surface:

```
python3 <skill>/scripts/groundwork_state.py <subcommand> [args]

  spine-gate       --plan DIR --expected 1 [--readonly]      # 3-clause version gate (exit 3 = refuse)
  validate-profile --profiles-root DIR (--name N | --all)    # 10 rules, canonical error strings
  resolve-profile  --profiles-root DIR --name N              # merged labels + spine + overrides
  scaffold         --plan DIR --profiles-root DIR --profile N --goal STR [--force]
  read-anchor      --plan DIR
  read-region      --file PATH --id ID
  write-region     --plan DIR --file REL --id ID --action NAME (--content STR | --content-file P) [--force]
                       # prints WRITTEN | UNCHANGED | SKIPPED_DIRTY
  next-id          --plan DIR --kind gap|wp|gate|design [--name NAME]
  register-id      --plan DIR --id ID --doc DOC [--field k=v ...]
  board-data       --plan DIR
  status-data      --plan DIR [--profiles-root DIR]
  explorer-data    --plan DIR                                # typed file-tree model for artifact/explorer.html
  plans-index-data --plans-dir DIR                           # cross-plan rollup of every plan under a plans/ dir
  write-region-plain --file PATH --id ID (--content STR | --content-file P)  # anchorless fence write (plans-index)
  register-issue   --plan DIR --id ID --number N --url URL [--provider P] [--labels L]
  register-milestone --plan DIR --phase P1 --title T --id ID --url URL
  issue-sync-data  --plan DIR                                # JSON model for issue sync & export
  apply-issue-sync --plan DIR --updates-file PATH            # apply batch status updates from git issue sync

  # design lifecycle — see §"Design lifecycle" (every command is idempotent: a no-op writes nothing)
  register-design  --plan DIR --file designs/X.html [--id D-NN] [--phase P] [--wp WP-NN]
  design-lock      --plan DIR --id D-NN --round N [--file designs/X.html ...] # --file repeats; LOCKED | UNCHANGED | NORMALIZED
  design-unlock    --plan DIR --id D-NN --round N --reason STR             # clears verified_in
  design-verify    --plan DIR --id D-NN --round N [--force]                # needs locked + implemented
  register-design-impl --plan DIR --wp WP-NN --designs D-01,D-02|none [--replace]
                       [--pr N [--url URL] [--pr-state open|merged|closed]]
  design-migrate   --plan DIR [--dry-run] [--include-unregistered]         # link legacy designs[path] to D-NN
  design-data      --plan DIR                                               # derived lifecycle + coverage model
```

Every subcommand prints a JSON result to stdout (parse it to report back). Exit codes: `0` ok · `1` hard error/refusal · `2` missing/corrupt anchor · `3` spine-gate refusal. The contract details below define *why* each behaves as it does; the script is *how*.

The seeded-session forms in each action (the "skill not loaded" fallback) still describe the by-hand method, because a fresh chat without the skill won't have the script either — that's the documented degraded path, not the primary one.

---

## `.groundwork.json` — the identity + state anchor

Lives at the root of every groundwork plan folder (alongside `00-README.md`). Its **presence is what marks a directory as a groundwork plan** and pins its profile. Without it, every action refuses to run except `init`. Analogous to spec-kit's `.specify/memory/constitution.md`.

### Schema (v1)

```jsonc
{
  "spine_version": "1",                 // bump when the spine layout changes incompatibly
  "profile": "software",                // "software" | "general" | "<user-dropped>"
  "created": "2026-05-20T14:30:00Z",
  "updated": "2026-05-20T14:30:00Z",
  "goal": "One-sentence goal captured at init.",
  "docs": {
    "01-plan.md": {
      "hash": "sha256:abc123…",         // hash of the whole file as last written by groundwork
      "generated_regions": [
        { "id": "goal", "hash": "sha256:def456…", "last_action": "init",     "last_written": "2026-05-20T14:30:00Z" },
        { "id": "ids",  "hash": "sha256:789abc…", "last_action": "review",   "last_written": "2026-05-20T15:10:00Z" }
      ]
    },
    "05-tracking.md": {
      "hash": "sha256:…",
      "generated_regions": [
        { "id": "wp-matrix",  "hash": "…", "last_action": "orchestrate", "last_written": "…" },
        { "id": "critical-path", "hash": "…", "last_action": "orchestrate", "last_written": "…" }
      ]
    }
    // … one entry per groundwork-touched file
  },
  "ids": {                              // global ID registry (Round 2 traceability)
    "G-01": { "doc": "04-discussion.md", "round": 2, "status": "folded",   "touches": ["01-plan.md", "05-tracking.md"] },
    "WP-01": { "doc": "05-tracking.md",  "wave": 0,  "status": "queued",   "depends_on": [], "gate": "G-CANVAS", "tier": "opus", "issue": { "provider": "github", "number": 42, "url": "https://github.com/org/repo/issues/42", "last_synced": "2026-08-23T12:34:00Z" } },
    "G-SCHEMA": { "kind": "freeze_gate", "wp": "WP-02", "status": "pending" }
  },
  "designs": {                          // Round 3 — design coverage tracking
    "designs/pattern-c-split.html":  { "phase": "P1", "wp": "WP-07", "locked": true,  "locked_in": "Round 5" },
    "designs/pattern-d-daw.html":    { "phase": "P2", "wp": "WP-07-layout", "locked": false }
  },
  "subplans": {                         // Studio-parity — NN-*.md focused sub-plans
    "06-canvas-extraction.md": { "archetype": "diff-plan",    "topic": "Canvas extraction PR",       "ref": "WP-01", "status": "active",   "hash": "sha256:…", "created": "2026-05-15T…" },
    "07-monaco-swap.md":       { "archetype": "decision-doc", "topic": "Monaco → CodeMirror 6 swap", "ref": null,    "status": "active",   "hash": "sha256:…", "created": "2026-05-16T…" },
    "08-tsserver-stdin-eof.md":{ "archetype": "bug-doc",      "topic": "tsserver bridge stdin EOF",  "ref": null,    "status": "landed",   "hash": "sha256:…", "created": "2026-05-20T…" }
  },
  "research": {
    "02-research-external.md": { "stamped": "2026-05-20" },
    "03-research-internal.md": { "stamped": "2026-05-20" }
  }
}
```

### Fields

- **`spine_version`** — the convention version this plan was scaffolded against. A newer skill seeing an older version offers a `migrate` step or operates read-only. Never silently mis-writes.
- **`profile`** — the active profile name. Templates resolve from `profiles/<profile>/` with `_shared` as the base.
- **`goal`** — the one-sentence answer captured at `init`. Surfaced in the board header + clarify gate.
- **`docs.<path>.hash`** — sha256 of the whole file's bytes as last written by a groundwork action. If the current on-disk hash differs, hand edits exist somewhere — actions still honor fences but `status` reports the drift.
- **`docs.<path>.generated_regions[]`** — one entry per `<!-- groundwork:auto:start ID -->` block in that file. The `hash` is over the **inner content only** (excluding the fence comments themselves) so a fence-position move counts as a hand edit, not a regenerated block.
- **`ids`** — the **traceability backbone** (Round 2). Every `G-NN` / `WP-NN` / `G-<NAME>` ID lives here with its origin doc and the set of docs it touches. The review action computes the affected-doc set from this registry + region hashes — no guessing.
- **`ids[WP-NN].tier`** — *optional* model tier (`opus` / `sonnet` / `haiku`) by task weight, stamped by `orchestrate` (heuristic default, user-overridable via `--field tier=<t>`). Surfaced by `board-data` and consumed by the emitted Workflow (`agent(…, {model})`) and the orchestrator's improvised spawns. See [`schemas.md` §"Model tiers"](schemas.md). Absent → consumers default to `sonnet`.
- **`ids[WP-NN].drift_log[]`** (Round 8 · G-13) — *optional* per-WP audit trail of in-flight scope changes. Empty by default; only present when the shipped code diverged from the WP's sub-plan or brief. Each entry: `{round: <N>, commit: "<sha>", scope_change: "<one line>", justification: "<one line>", subplan_section: "<§ name>" | null}`. Populated by the orchestrator when a WP report mentions a "beyond the diff plan" decision (mirrors the matching `## Drift log` row in the diff-plan sub-plan). Surfaces in `review` and `status`: a future review pass greps `drift_log[]` for "shipped code matches plan?" verification. WPs that match plan keep the field absent — empty `drift_log[]` is a positive signal, not noise.
- **`designs`** — the design **variant-file** registry, keyed by path. Each entry links to its design with `design: "D-NN"`; `locked` / `locked_in` on an entry are a **mirror** of the design's lock, kept for older readers (explorer badges, plans-index). The design itself — and every lifecycle field — lives on `ids[D-NN]`. See [§"Design lifecycle"](#design-lifecycle).
- **`ids[D-NN]`** — the canonical design record: `title`, `phase`, `files[]` (linked variants), `locked`, `locked_files[]` (the locked variant set — usually one), `locked_file` (its first entry), `locked_in`, `unlocked_in`, `verified_in`, `history[]` (`{action: lock|unlock|verify, round, file, reason, at}`). A `D-NN` may exist with no files (a planned surface). Written only by the design commands, never by hand.
- **`ids[WP-NN].implements[]` / `.prs[]`** — the designs a work package builds (`register-design-impl`) and its PR records `{number, url, state: open|merged|closed, designs[]}`. Design build status is derived from these plus WP `status`.
- **`ids[G-NN].design` / `.state` / `.location`** — set on `design-review` and `design-conformance` findings, so a finding reads `G-NN · D-NN · state · file:line` and attaches to its design.
- **`subplans`** — Focused `NN-*.md` sub-plans (numbered ≥ 06). `subplan` action creates them; `status` lists them; `review` notes when a finding touches one. **No `SP-NN` ID** — sub-plans are file-numbered, not ID-allocated; cross-references happen by filename (and by the optional `ref` field linking to a WP / gap / section). `status` field is hand-edited: `active` / `landed` / `abandoned` / `deferred`.
- **`research`** — freshness stamps surfaced on the board.

### Atomic writes

Every write to `.groundwork.json` is `write tmp → rename` so a crash mid-write never leaves a corrupt anchor. The script does this for every anchor and file write (`atomic_write`); actions never write the anchor directly.

### Spine-version preamble gate

Every action — read-only and writing alike — runs the **spine-version gate** as its first step after reading the anchor. The gate makes the "newer skill sees older anchor → offer migrate or operate read-only" promise enforceable instead of aspirational. **At spine_version=1=current, the gate is a no-op** (every check passes); it earns its keep the moment the first incompatible v2 spine bump lands.

Each action declares its `expected_spine_version` (currently `"1"` for all nine). The gate's contract:

```
gate(anchor.spine_version, action.expected_spine_version):
    if anchor.spine_version == action.expected_spine_version:
        proceed                                                     # the v1=v1 common case
    elif anchor.spine_version < action.expected_spine_version:
        refuse with: "plan is on spine_version={anchor}, this skill expects {expected}.
                      Run `groundwork init --migrate` to bring the folder forward."
    elif anchor.spine_version > action.expected_spine_version:
        if action is read-only (status, clarify):
            warn: "plan is on spine_version={anchor}, this skill is on {expected} — running read-only."
            proceed with read-only semantics
        else:
            refuse with: "plan is on spine_version={anchor}, this skill is on {expected}.
                          Upgrade the groundwork skill (`npx skills add ikenga-hq/groundwork`) before writing."
```

Three clauses, hence three failure modes: **anchor-too-old** (most common at first v2 bump), **anchor-too-new + writing action** (user is on a newer plan than the installed skill), **anchor-too-new + read-only action** (degrade gracefully, return what we can).

The gate **never silently mis-writes** — refusal is the only behavior on incompatibility. It is intentionally implemented at the preamble of every action rather than at a central dispatcher, because each action file is the canonical home of its own behavior and the gate is part of that behavior.

#### Per-version transform table (deferred until v2)

When the first incompatible v2 spine lands, `actions/init.md` gains a `--migrate` path whose transform table is keyed by version pairs:

```
transforms = {
  ("1", "2"): [
    add_fence("01-plan.md", "risks-index", anchor_after="goal"),
    rename_fence("artifact/board.html", "board-data", "tracking-data"),
    add_doc("10-metrics.md", from_template="profiles/_shared/templates/10-metrics.md"),
    add_anchor_key("metrics", default={}),
  ],
  # ("2", "3"): [ … ],
}
```

Each transform is **structural** (insert / rename / scaffold) and **fence-preserving** — hand-authored prose outside every fence is byte-identical post-migration. No transform may invoke an agent; if a hypothetical future migration needs semantic re-flow of prose, it earns its own verb instead of riding `init --migrate`.

The transform table format is deliberately out of scope for v1 — the gate alone is enough to keep us honest until there is something to transform. See [`plans/groundwork/07-spine-version-migration.md`](../../../../plans/groundwork/07-spine-version-migration.md) for the full decision history.

---

## Profile contract

A **profile** governs the vocabulary and spine a plan resolves against. It is the second identity input (after `.groundwork.json`) — `init` writes the profile name into the anchor, and every action reads `profiles/<name>/profile.json` from the skill source to look up labels, spine list, and overrides.

The five built-ins (`software`, `general`, `content`, `design-system`, `film`) are the canonical worked examples. **Users may drop their own profile under `.claude/skills/groundwork/profiles/<name>/`** and `init --profile <name>` will resolve it like a built-in, provided it satisfies the contract below. `status`'s profile-conformance check (`actions/status.md` §"Profile conformance check") is the gate that validates this on every read.

### File layout

```
profiles/<name>/
  profile.json          ← required
  templates/            ← optional — only files that override _shared
    01-plan.md
    05-tracking.md
    …
```

`profile.json` is the only required file. A profile that overrides no templates carries just `profile.json` and inherits every spine doc from `_shared`.

### `profile.json` schema (v1)

```jsonc
{
  "name":            "<name>",                  // required · string · must equal the directory name
  "extends":         "_shared",                 // required for non-_shared profiles · string · currently must be "_shared"
  "spine_version":   "1",                       // required · string · must satisfy spine_version <= current
  "labels": {                                   // required · object · all three keys non-empty strings
    "work_unit":         "<noun>",              // e.g. "work package" | "deliverable" | "piece"
    "isolation_axis":    "<phrase>",            // e.g. "git repo + disjoint dirs"
    "freeze_gate_noun":  "<noun>"               // e.g. "interface freeze" | "decision lock"
  },
  "optional_blocks":  ["<key>", …],             // required · array of strings · may be empty
  "produces_designs": true | false,             // required · boolean
  "spine_overrides":  { "<file>": "templates/<file>", … }  // required · object · may be empty
}
```

`_shared/profile.json` is the **base**: it carries `name: "_shared"` and no `extends` field. Every other profile sets `extends: "_shared"`; nested chains are not supported in v1.

### Resolution algorithm

1. Load `profiles/_shared/profile.json` → base.
2. Load `profiles/<profile>/profile.json` → overlay.
3. Merge: overlay's `labels`, `optional_blocks`, `produces_designs`, `spine_overrides` win; missing keys fall through to the base.
4. For each spine file (the union of `_shared.spine` + any keys in the overlay's `spine_overrides`), look in `profiles/<profile>/templates/<file>` first; fall back to `profiles/_shared/templates/<file>`. Render with the substituted `{{vocab.*}}` map.

### Validation rules (the conformance gate)

`status` rejects an invalid profile with a specific error per violated rule — see `actions/status.md` §"Profile conformance check" for the user-facing error catalog. The rules:

| # | Rule | Failure message (canonical) |
|---|---|---|
| 1 | `profile.json` exists | `profile "<name>": profile.json missing at profiles/<name>/profile.json` |
| 2 | Parses as JSON | `profile "<name>": profile.json is not valid JSON (<parser error>)` |
| 3 | `name` equals directory name | `profile "<name>": profile.json declares name="<other>" but lives in profiles/<name>/` |
| 4 | `extends` is `"_shared"` (for non-_shared profiles) | `profile "<name>": extends must be "_shared" (got <value>)` |
| 5 | `spine_version` ≤ current | `profile "<name>": spine_version=<v> exceeds skill's current spine_version=<current>` |
| 6 | All three `labels.*` keys present + non-empty strings | `profile "<name>": labels.<key> missing or empty` |
| 7 | `optional_blocks` is an array of strings | `profile "<name>": optional_blocks must be an array of strings` |
| 8 | `produces_designs` is a boolean | `profile "<name>": produces_designs must be true or false` |
| 9 | `spine_overrides` is an object; every value resolves to an existing template file | `profile "<name>": spine_overrides["<file>"] points to <path>, which does not exist` |
| 10 | No unknown top-level keys outside the schema | `profile "<name>": unknown top-level key "<key>" (allowed: name, extends, spine_version, labels, optional_blocks, produces_designs, spine_overrides)` |

Rules 1–9 are hard rejections — `init --profile <name>` refuses to scaffold and every other action refuses to read. Rule 10 is a **warn** (forward-compat — mirrors studio's Zod `.passthrough()` lesson; the spine schema may grow and we don't want a stale skill to break a newer profile). Unknown keys are preserved on disk and surfaced in the warning.

The gate runs in two places: at `init` time (refuse the scaffold if the user passed `--profile <name>` and `<name>` fails any hard rule), and on every `status` run (report every loaded profile's conformance, not just the active one — so dropping an invalid profile is noticed before the next `init`).

### Worked example

A user drops `profiles/ops/`:

```
profiles/ops/
├── profile.json
└── templates/
    └── 05-tracking.md
```

with `profile.json`:

```jsonc
{
  "name": "ops",
  "extends": "_shared",
  "spine_version": "1",
  "labels": {
    "work_unit": "runbook step",
    "isolation_axis": "owner + environment",
    "freeze_gate_noun": "rollout lock"
  },
  "optional_blocks": ["runbook", "rollback_plan"],
  "produces_designs": false,
  "spine_overrides": { "05-tracking.md": "templates/05-tracking.md" }
}
```

`groundwork init plans/incident-2026-05-22/ --profile ops --goal "Stand up the GCS-failover runbook"` resolves the profile, materializes 01–05 (only 05 from the ops overlay; the other four from `_shared`), and writes a `.groundwork.json` with `profile: "ops"`. The next `groundwork status` reports `ops` alongside the five built-ins as ✓ conformant.

If the user typos `extneds: "_shared"`, rule 4 fires: `profile "ops": extends must be "_shared" (got undefined)` and `init` refuses.

---

## Generated-region fences

This is **the only mechanism** by which an action modifies an existing file. Outside the fences is hand-written prose; inside is owned by exactly one action.

### Syntax

```markdown
Hand-written introduction paragraph.

<!-- groundwork:auto:start research-summary -->
<!-- last_action: research · 2026-05-20T14:30:00Z -->

(generated content — actions overwrite this block byte-for-byte on re-run)

<!-- groundwork:auto:end research-summary -->

Hand-written follow-up.
```

Inside HTML, JSON, or any non-markdown file, use the same `<!-- … -->` form when comments are valid, or the file-type's equivalent line-comment (`// groundwork:auto:start ID`, `# groundwork:auto:start ID`). All variants are recognized by the same parser; templates use markdown comments.

### Rules

1. **Fence IDs are unique per file.** Reuse across files is fine.
2. **Actions only ever write the inner block.** Outer content + the fence comments themselves are immutable.
3. **Unrecognized fences are left untouched** — even by the action that "owns" the file. A user can introduce their own fences with IDs like `notes-<anything>` and groundwork won't fight them.
4. **A fenced block missing from `.groundwork.json`** is a new fence; on first action run, it's recorded.
5. **A fence present in `.groundwork.json` but not in the file** is treated as a hand-removal — `status` reports it; the next action run does not re-create it.

### Reserved fence IDs (by action)

| File | Fence ID | Owner action |
|---|---|---|
| `00-README.md` | `status-block` | `status`, `init` (initial) |
| `00-README.md` | `spine-index` | `init`, `subplan` (appends sub-plan rows) |
| `01-plan.md` | `goal` | `init` |
| `01-plan.md` | `ids` | `init`, `review` (re-syncs the ID index) |
| `02-research-external.md` | `findings` | `research` |
| `02-research-external.md` | `sources` | `research` |
| `03-research-internal.md` | `findings` | `research` |
| `04-discussion.md` | `rounds-index` | `review` |
| `05-tracking.md` | `round-fold` | `review` |
| `05-tracking.md` | `wp-matrix` | `orchestrate` |
| `05-tracking.md` | `critical-path` | `orchestrate` |
| `05-tracking.md` | `wave-plan` | `orchestrate` |
| `09-orchestration.md` | `*` (whole-file) | `orchestrate` |
| `artifact/orchestrate.workflow.js` | `*` (whole-file) | `orchestrate --emit-workflow` |
| `artifact/board.html` | `board-data` | `refresh-board` |
| `artifact/board.html` | `board-meta` | `refresh-board` |
| `artifact/explorer.html` | `explorer-data` | `explorer` |
| `artifact/explorer.html` | `explorer-meta` | `explorer` |
| `artifact/index.html` | `spec-state` | `refresh-living-spec` |

`artifact/index.html` is the **living spec** — scaffolded from `profiles/_shared/templates/artifact/index.html` at `init` and updated only inside the `spec-state` fence by `refresh-living-spec`. Everything outside the fence (the hand-authored Overview tab) is preserved across re-runs. `artifact/board.html` is the generated tracking board — `refresh-board` owns it. `artifact/explorer.html` is the generated file-explorer — `explorer` owns its two fences (`explorer-data`/`explorer-meta`) and nothing else; it *opens* `board.html`, `index.html`, and `designs/*.html` as iframe tabs but never writes them. Both `explorer-data` and `explorer-meta` use the `<!-- … -->` comment fence form (they live inside `<script type="application/json">` blocks, like `board-data`). Because they sit inside a `<script>` element, every write to them passes **`write-region --html-script-safe`** (and `write-region-plain --html-script-safe` for the plans-index), which escapes `<`/`>`/`&` to `\uXXXX` so an embedded file body containing a literal `</script>` can't terminate the block (a JSON-parse break → silent mock fallback, and an HTML-injection → XSS). The escapes round-trip through `JSON.parse` to the original characters. *(The pre-existing `board-data` fence shares this latent exposure for `--with-briefs`; a follow-up should apply the same flag there.)*

The cross-plan **`plans-index`** action is the one writer that is **not** anchor-scoped: its output `<plans-dir>/_index.html` spans many plans and belongs to no single `.groundwork.json`, so it is not listed in any `docs` map and uses the anchorless `write-region-plain` (idempotent by content-equality, no hash registry) on the `plans-index-data` / `plans-index-meta` fences. It only ever reads the plans it lists — never writes into them.

`09-orchestration.md` is the one file an action may rewrite whole. It is *generated*; the convention is "delete and re-author from `05` + `.groundwork.json`," not "edit in place." If the user has added hand-written sections, they go above an explicit `<!-- groundwork:auto:start orchestration -->` fence; everything outside survives.

`artifact/orchestrate.workflow.js` is the *executable twin* of `09-orchestration.md`, emitted only under `--emit-workflow`. Like `09` it is whole-file generated (never hand-edited) and re-derived from the wave plan on each run; its whole-file hash lives in `docs`. It is filled from `profiles/_shared/templates/artifact/orchestrate.workflow.js`.

---

## Hash-diff re-run semantics

The contract: **an action that touches a region recomputes that region's content, hands it to the script, and the script writes only if the new hash differs from the recorded hash.** Equal content is a no-op (no `updated` bump, no file write). This is exactly what `write-region` does — the action computes *what the region should say*; the script decides *whether and how to write it*.

### Algorithm (per region — what `write-region` implements)

```
old_hash = .groundwork.json.docs[file].generated_regions[id].hash
new_hash = sha256(strip_meta(new_content))            # excludes the last_action: line

if new_hash == old_hash and on_disk == old_hash:
    return UNCHANGED                                  # leave the file alone, mtime intact

if on_disk_hash != old_hash and not --force:
    return SKIPPED_DIRTY                              # user hand-edited inside the fence; never clobber

# else: rewrite the inner block (refresh the last_action stamp), recompute the whole-file
# hash, update the region entry + doc hash in the anchor, atomic-write both.
return WRITTEN
```

The dirty clause is the safety: **if the bytes inside a fence don't match what we last wrote, the script assumes the user edited them** and refuses unless the action passes `--force`. The content hash deliberately excludes the `last_action:` metadata line, so a refreshed timestamp never counts as a change — that's what keeps re-runs from churning. Most users edit *outside* fences (always safe); the dirty path matters for the rare inside-fence edit.

### Idempotency, defined

A user runs a generating action twice with no other state change:

- **Generated regions** — byte-identical on disk; `last_written` unchanged; `.groundwork.json.updated` unchanged; `mtime` unchanged.
- **Hand-written prose** — byte-identical (it was never read into the action's working set).

This is **Verification #10** in `01-plan.md`. Dogfooding (Verification #2) is the forcing test: re-running `init` over an already-initialized `plans/groundwork/` must produce zero changes to disk.

### The whole-file hash

Tracks "did any byte of this file change since groundwork last touched it." Drift indicators on the board read this, not the per-region hashes. A region overwrite by an action updates both the region hash and the whole-file hash in the same write.

---

## Stable IDs (Round 2 traceability backbone)

IDs thread `01-plan.md` → `05-tracking.md` → `09-orchestration.md` → board. The review action computes the affected-doc set from the ID registry + region hashes, not from guessing. The studio second-pass caught `05` drifting precisely because traceability was ad hoc; the registry fixes that.

### Format

| ID kind | Format | Example | Where it originates |
|---|---|---|---|
| **Gap** | `G-NN` | `G-12` | Review pass — a finding folded into a Round |
| **Work package** | `WP-NN` (+ optional letter slice) | `WP-05`, `WP-05a` | Orchestrate — derived from `05-tracking` sections |
| **Freeze gate** | `G-<NAME>` (uppercase, kebab) | `G-SCHEMA`, `G-ADAPTER` | Orchestrate — declared in plan §Freeze gates |
| **Design** | `D-NN` | `D-01` | Design pass or plan authoring — one per designed surface (its `designs/*.html` variants link to it) |

`G-` is reused intentionally: a freeze gate is uppercase + name, a gap is uppercase + number. They never collide.

A `D-NN` names a **designed surface or decision**, not a file: it may be registered before any mockup exists, and it links to one or more `designs/*.html` variants (see §"Design lifecycle").

---

## Design lifecycle

Designs run the same traceable loop as the rest of the plan: **produce → review → lock → implement → verify**. One model, two linked registries:

| Registry | Keyed by | Holds |
|---|---|---|
| `ids[D-NN]` — **canonical** | design | `title`, `phase`, `files[]`, `locked`, `locked_file`, `locked_in`, `unlocked_in`, `verified_in`, `history[]` |
| `designs[<path>]` | variant file | `phase`, `wp`, `pane_ids`, `revision`, `design: "D-NN"`, and a **mirror** of `locked` / `locked_in` for older readers |

```jsonc
"ids": {
  "D-03":  { "doc": "01-plan.md", "kind": "design", "title": "Deal-breakers", "phase": "P1",
             "files": ["designs/d-03-cards.html", "designs/d-03-list.html"],
             "locked": true, "locked_file": "designs/d-03-cards.html", "locked_in": "Round 4",
             "verified_in": "Round 7",
             "history": [{ "action": "lock", "round": "Round 4", "file": "designs/d-03-cards.html", "at": "…" },
                         { "action": "verify", "round": "Round 7", "at": "…" }] },
  "WP-02": { "doc": "05-tracking.md", "status": "done", "implements": ["D-03"],
             "prs": [{ "number": 42, "url": "…", "state": "merged", "designs": ["D-03"] }] },
  "G-14":  { "doc": "04-discussion.md", "kind": "design-conformance", "status": "resolved",
             "design": "D-03", "state": "error", "location": "app/onboarding/DealBreakers.tsx:88" }
},
"designs": {
  "designs/d-03-cards.html": { "phase": "P1", "wp": "WP-02", "design": "D-03", "locked": true, "locked_in": "Round 4" },
  "designs/d-03-list.html":  { "phase": "P1", "wp": "WP-02", "design": "D-03", "locked": false }
}
```

### Transitions (script commands — never hand-edit)

| Step | Command | Records |
|---|---|---|
| produce | `register-design --file designs/X.html --id D-NN` | the variant in `designs`, the link both ways |
| review | `review --target D-NN` → `register-id … --field design=D-NN --field state=… --field location=file:line` | findings attached to the design |
| lock | `design-lock --id D-NN --round N [--file X]` | `locked`, `locked_file`, `locked_in`, history; mirror on variants |
| unlock | `design-unlock --id D-NN --round N --reason S` | `unlocked_in`, clears `verified_in`, history |
| implement | `register-design-impl --wp WP-NN --designs D-NN [--pr N --url U --pr-state open\|merged\|closed]` | `ids[WP].implements[]`, `ids[WP].prs[]` |
| verify | `design-verify --id D-NN --round N` | `verified_in`, history (refuses unless locked + implemented) |

Every command is idempotent: re-running with nothing new prints `UNCHANGED` and leaves the anchor — `updated` included — byte-identical.

### Derived state (computed by `design-data`, `board-data`, `status-data`; never stored)

| Field | Values | Rule |
|---|---|---|
| `design_state` | `planned` → `drafted` → `locked` | locked if the design is locked; else drafted if it has files; else planned |
| `build_state` | `unbuilt` · `in_progress` · `implemented` · `verified` | **implemented** if a `merged` PR lists the design, or every implementing WP is `done`; else **in_progress** if an implementing WP is `in_progress`/`done` or a listed PR is `open`; else **unbuilt**. **verified** = implemented + locked + `verified_in` set |
| `warnings[]` | — | built against an unlocked design · locked without a file · locked file missing on disk · `verified_in` set but no longer locked + implemented |
| `coverage[]` | per phase | `{phase, designs: locked, of: D-NN count, implemented, verified, unlinked, unlinked_locked, ok}` |

WP `status` already tracks forge issue state through `issue-sync`, so issues feed build status without a separate path; PR records come from the orchestrator (at PR open / merge) or from `issue-sync` parsing each PR body's `Designs implemented:` line.

### Migration (legacy anchors)

A design may lock **several** complementary variants (a main screen plus a returning-member path, say): pass `--file` more than once. `locked_files[]` holds the set, and `locked_file` is its first entry for readers that want one path.

Older anchors come in three shapes, all **read as-is**:
- locks on `designs[<path>]` with no `D-NN` link;
- `D-NN` in `ids` with no files;
- a hand-rolled lock: variants linked with `id: "D-NN"` (read as an alias of `design`) and `locked: true` on the ID with no file named. The locked files are then the linked variants that carry `locked: true`.

A file-level lock counts for its design once linked, and unlinked files are reported under `unlinked` (with a `suggested_id` from a `d-NN-…` filename). `design-migrate [--dry-run] [--include-unregistered]` brings an anchor forward: links files to `D-NN` by an existing `design` field or a filename token, lifts legacy locks onto the ID, copies `phase`, and optionally registers matching `designs/*.html` found on disk. It never allocates IDs; unmatched files are listed for a deliberate `next-id` + `register-design`.

### Threading rules

- An ID first appears in **exactly one originating doc** (`doc:` field in `ids[ID]`).
- Mentions in other docs are *references*, not declarations.
- When the originating doc's section for an ID changes (different hash inside the relevant fence), `ids[ID].touches[]` lists every dependent doc whose region must be re-synced. The review action follows the list — no guessing.
- Renumbering is not supported in P1. Once an ID is allocated, it stays. Deletion sets `status: "retired"` rather than freeing the number.

### Discovery

`status` parses all known docs, extracts every `G-NN` / `WP-NN` / `G-<NAME>` mention, and compares to the registry. Orphans (in prose, not registered) and ghosts (registered, no prose) both surface as warnings.

---

## Worked example

A user runs `groundwork init plans/my-feature/ --profile software --goal "Lift the share-card renderer into a pkg"`.

After init:

```
plans/my-feature/
├── .groundwork.json            # spine_version=1, profile=software, goal=…, docs={…}
├── 00-README.md                # hand intro + <!-- start status-block --><!-- end --> fence
├── 01-plan.md                  # hand structure + goal + ids fences
├── 02-research-external.md     # hand intro + findings + sources fences (empty)
├── 03-research-internal.md     # hand intro + findings fence (empty)
├── 04-discussion.md            # hand "Rounds — newest first" + rounds-index fence
├── 05-tracking.md              # hand intro + wp-matrix + wave-plan + critical-path fences
├── designs/                    # empty
└── drafts/                     # empty
```

Now the user runs `groundwork research`. The researcher agent fills `02`/`03` inside the `findings` + `sources` fences. After:

- `.groundwork.json.docs["02-research-external.md"]` carries the new region hashes + `last_action: "research"`.
- `02-research-external.md` outside the fences is byte-identical to the template.

The user adds three paragraphs of hand commentary between `<!-- end findings -->` and `<!-- start sources -->`. They re-run `groundwork research` because a new source came up. The action:

1. Recomputes `findings` content — same as before → **no write**, hash unchanged.
2. Recomputes `sources` content — new source → **write**, hash updated.
3. The user's three paragraphs between the fences are byte-identical.
4. `.groundwork.json.docs["02-research-external.md"].hash` updates to reflect the new whole-file content.

Now the user runs `groundwork review`. The reviewer agent produces three findings: `G-08`, `G-09`, `G-10`. The review action:

1. Appends a new "Round N" section to `04-discussion.md` **above** the `rounds-index` fence (newest first); the fence's index entry updates inside the fence.
2. Registers `G-08`/`G-09`/`G-10` in `.groundwork.json.ids`.
3. Reads each gap's `touches[]` list (computed from the finding's references) and re-syncs the named regions in `01`/`05`.
4. Bumps every changed file's whole-file hash.

The user re-runs `groundwork review` immediately, no change. All three regions recompute to identical bytes → no writes, mtimes preserved. **Idempotent.**

---

## Workflow execution invariants

The opt-in Workflow paths (`research --sweep`, `review --panel`, `orchestrate --emit-workflow`) are an *execution* layer over the same state machine — they never bypass it. Two hard constraints, because **Workflow scripts have no filesystem, `Date`, or `Math.random`**:

1. **The script computes; the calling session persists.** A Workflow `agent()` fan-out fans out and *returns* structured results (validated against the [`schemas.md`](schemas.md) contracts). It writes nothing to the plan folder. The **action / orchestrator session** then applies every result through the ordinary path — `write-region` into fences, `next-id` + `register-id` for the registry, `05` checkbox ticks, Task mirroring, commits. So the "fences are the only writable blocks" and "only the orchestrator writes `05`" invariants hold unchanged; Workflow just produces *better inputs* (fanned-out, schema-valid, adversarially verified) to the same writes.
2. **Anything time- or randomness-dependent is passed in, not read.** The emit step inlines WP briefs as string constants and substitutes a literal `meta`; the synthesis stamp (`research --sweep`) is passed into the prompt. This is also why emitted scripts are deterministic to resume (Workflow caches unchanged `agent()` calls).

Net: opt-in Workflow changes *how candidate content is produced and verified*, never *how state is recorded*. Disable the flags (or run without Workflow available) and behavior is byte-identical to the single-agent / prose-handoff path.

---

## What this enables

- Stateless actions: every action reads `.groundwork.json` first, does its thing, writes atomically. No in-memory state survives between invocations.
- Honest "augments, never clobbers": fences are the contract; hand-written prose outside is sacred.
- Deterministic re-sync after review: the IDs say which docs to touch; the registry tracks the touches; the action follows the list.
- Profile portability: nothing in this file assumes code. The state mechanism works identically for a marketing campaign or an org change — the templates change, the state machine does not.
- Optional Workflow execution: when the user opts in, the same state machine takes fanned-out, schema-validated, gate-verified inputs instead of single-agent ones — without changing what gets written or how.
