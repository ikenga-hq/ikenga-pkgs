# action: `refresh-living-spec` — regenerate the artifact/index.html spec-state fence

**Loaded when**: the user runs `groundwork refresh-living-spec`, or any time the Phasing / Decisions / Risks tabs in `artifact/index.html` have fallen behind the docs.

**Reads first**: `../lib/state.md` (state machine spec — every write obeys it).

**Spine-version**: `expected = "1"`. Runs [`../lib/state.md` §"Spine-version preamble gate"](../lib/state.md#spine-version-preamble-gate) as the first step after loading `.groundwork.json`. On anchor-too-old refuse with the migrate hint; on anchor-too-new warn and proceed read-only (we'd still emit a useful skeleton). No-op at v1=current.

---

## What it does

Regenerates **one fenced region** — `spec-state` in `artifact/index.html` — from the plan's anchor + markdown sources. Everything else in `artifact/index.html` is hand-authored and never touched (just the plan-specific Overview tab).

The fence holds a JSON document parsed by the React app to render three tabs:
- **Phasing** — per-phase status + KPI cards (derived from `05-tracking.md` `## Phase N` headers + WP statuses rolled up from `.groundwork.json.ids`)
- **Decisions** — newest-first round entries (derived from `04-discussion.md` rounds-index fence + round bodies)
- **Risks** — risk cards with mitigations (derived from `01-plan.md §Risks` bullets + any "New risks folded" rounds)

The scaffolded living spec carries exactly four tabs — **Overview** (hand-authored, plan-specific) plus the three above. It deliberately does **not** explain the groundwork methodology (spine / actions / profiles / state machine / board): a plan's living spec is about the plan, not the tool that made it — that documentation lives in the skill (`SKILL.md` + `lib/state.md`) with `plans/groundwork/` as the worked showcase. The Overview tab is never touched by this action.

---

## Mechanics

Three steps. The deterministic parts go through the state script; the narrative synthesis (one-line round summaries, one-line risk mitigations) is the action's job — Claude reads the markdown and crafts the prose.

### 1. Get the structured skeleton

```bash
python3 <skill>/scripts/groundwork_state.py living-spec-data --plan <plan>
```

Returns JSON with:
- **`phases`**: `[{ id, title, status, shipped_at?, next_pull?, round? }]` — one entry per `## Phase N — title` heading in `05-tracking.md`, with `status` rolled up from the WP statuses recorded in `.groundwork.json.ids` (all WPs done → `shipped`; any in_progress → `in_progress`; mix → `queued`; no WPs yet → `stub`).
- **`rounds`**: `[{ round, date, topic, status, heading_line, body_anchor }]` — one entry per row in the `04-discussion.md` rounds-index fence (newest first).
- **`risks_raw`**: `[{ raw_line, severity_hint, source }]` — one entry per bullet under `01-plan.md §Risks` (and any `### New risks folded` rounds), with the leading `**R<n> —**` / `**G-<NN> —**` prefix stripped and a severity hint (`critical` / `important` / `nice`) inferred from any tag in the bullet.
- **`ids_summary`**: gates/gaps/WP counts by status — for cross-checking against what the round summaries say.
- **`designs`**: one entry per `D-NN` — `{ id, title, phase, design_state, build_state, locked_in, verified_in, wps }` (the same derivation as `design-data`). Each `phases[]` entry also carries `design_ids` (the `D-NN` whose `phase` matches). Use them in the per-phase `note` ("D-01..D-03 locked, D-01 verified") and in round summaries. The template doesn't yet render a dedicated designs panel.

The script does NOT synthesize prose. It hands back the **raw materials**; the action's job is to craft the human-readable summary for each round and each risk.

### 2. Synthesize the prose (the part Claude does)

For each round entry, read the corresponding section of `04-discussion.md` (the heading line points you to it). Write a single-sentence `title` (≤ 100 chars; the heading line minus the date is usually fine) and a single-paragraph `summary` (≤ 400 words; the gist of what was locked, with the key gate/WP/G-NN references inline). Do not invent content — the summary must be defensible against the round body. If a round is too short to summarize (e.g. just folds in a sub-plan), say so plainly.

For each risk, read the bullet body and any cross-referenced round-folds. Write a `title` (the headline phrase), a single-sentence `mitigation`, and a `source` (e.g. `"01-plan §Risks (R6)"` or `"Round 8 §New risks folded"`). Severity defaults to the hint but you can override based on context.

For phases, the script already gives you status + headline; the action's job is the per-phase `note` (≤ 300 chars). This is usually a one-sentence "what's done / what's open" line derived from the WPs in that phase.

### 3. Write the fence

The fence wraps the full `<script type="application/groundwork+json" id="groundwork-spec-state">…</script>` block in `artifact/index.html` — the `<script>` tags are inside the fenced region (the React app uses `getElementById('groundwork-spec-state')` to read the JSON, so the tags MUST be present in the fence content). Your content payload is the full block:

```
<script type="application/groundwork+json" id="groundwork-spec-state">{...JSON...}</script>
```

Write the full block in one go:

```bash
python3 <skill>/scripts/groundwork_state.py write-region \
  --plan <plan> --file artifact/index.html --id spec-state \
  --action refresh-living-spec --content-file /tmp/spec-state-block.html
```

The script does hash-diff: byte-identical no-op on re-run; refuses if the on-disk content has been hand-edited inside the fence (use `--force` to overwrite). It updates `.groundwork.json.docs["artifact/index.html"]` with the new whole-file + region hashes, and records `refresh_living_spec.last_run` in the anchor.

Reminder — the **JSON payload inside the `<script>` tag** must follow exactly this shape (the React app parses it via `JSON.parse(el.textContent)`):

```json
{
  "version": 1,
  "generated_at": "2026-05-27T16:00:00Z",
  "generated_by": "refresh-living-spec",
  "phases":    [{ "id": "P1", "title": "…", "status": "shipped", "shipped_at": "2026-05-22", "note": "…" }],
  "decisions": [{ "round": 18, "date": "2026-05-27", "title": "…", "summary": "…" }],
  "risks":     [{ "title": "…", "severity": "important", "mitigation": "…", "source": "01-plan §Risks (R6)" }]
}
```

The JSON can be either compact (one-line) or pretty-printed — `JSON.parse` accepts both, and the fence hash treats them as different content (pretty-printing is fine but means future regenerations will keep producing diffs unless the format is stable; we recommend pretty-print with 2-space indent for diff-readability).

---

## What it does NOT do

- **Does not touch the hand-authored Overview tab.** Only the `spec-state` fence is written.
- **Does not modify `04-discussion.md` / `01-plan.md` / `05-tracking.md`**. Read-only from those.
- **Does not allocate new IDs**. Reads existing IDs from `.groundwork.json.ids`.
- **Does not run `clarify`**. This action is a pure regenerate; it doesn't gate on readiness.

If the user asks for risk/decision/phase data not present in the source docs, refuse and point them at `groundwork review` (to add a round) or hand-editing `01-plan.md`.

---

## Drift detection

The Phasing/Decisions/Risks tabs render an empty-state if the fence is at its init scaffold value (`generated_at: null`, all arrays empty). When you run `refresh-living-spec` and the on-disk fence content differs from the recomputed one, the script emits `result: "WRITTEN"`; if identical, `result: "UNCHANGED"`. Surface both in the action's user-facing output so the user knows whether the regenerate moved the file or was a no-op.

If the user has hand-edited the fence content, the script emits `result: "SKIPPED_DIRTY"` — do **not** silently force; ask the user whether to overwrite their edits (typically: no — they have a reason; resolve by hand-merging or telling them to use `--force`).

---

## Edge cases

- **`artifact/index.html` doesn't exist** — refuse with `"artifact/index.html missing — run groundwork init or copy the template from profiles/_shared/templates/artifact/index.html."` Don't scaffold it implicitly; that's `init`'s job.
- **The `spec-state` fence is missing from `artifact/index.html`** — refuse with `"spec-state fence not found in artifact/index.html — file is out of spine; copy the current template from profiles/_shared/templates/artifact/index.html."` (Most likely the user has a pre-template hand-authored index.html from before this action existed.)
- **`05-tracking.md` has no `## Phase N` headers** — emit empty `phases: []` and tell the user. The Phasing tab renders an empty-state.
- **`04-discussion.md` rounds-index fence is empty** — emit empty `decisions: []` and tell the user the plan hasn't accumulated any rounds yet.
- **`01-plan.md` has no `## Risks` section** — emit empty `risks: []` and tell the user there's nothing to extract.

---

## Output to the user

After a successful write:

```
✓ refresh-living-spec · artifact/index.html
  phases:    5    (3 shipped · 1 in_progress · 1 stub)
  decisions: 18   (newest: Round 18 · 2026-05-27)
  risks:     8    (3 critical · 4 important · 1 nice)

  generated_at: 2026-05-27T16:00:00Z
  result:       WRITTEN  (content_hash changed)
```

If unchanged:

```
✓ refresh-living-spec · artifact/index.html
  no changes — anchor + docs match the rendered fence
  last_run: 2026-05-27T16:00:00Z
```

If dirty:

```
⚠ refresh-living-spec · artifact/index.html
  SKIPPED — the spec-state fence was hand-edited
  Use --force to overwrite, or reconcile by hand.
```

---

## Click-to-fire prompt

The canonical strings the FE emits (palette per WP-21). `refresh-living-spec` is a **regenerate-action** — when invoked from the palette in-shell, it routes through `art.sendToActiveSession` (per WP-22) so the result lands in the active chat thread rather than minting a fresh session. Substitution variables: `{plan_folder}`, `{plan_title}`.

**Standalone slash form**:

```
/groundwork refresh-living-spec
```

**Seeded-session form**:

```
Run groundwork refresh-living-spec on `{plan_folder}` (plan title: {plan_title}).

If the groundwork skill is loaded in this session, follow its `refresh-living-spec` action verbatim — read `.claude/skills/groundwork/actions/refresh-living-spec.md` and regenerate the `spec-state` fence in `{plan_folder}/artifact/index.html` from the plan's anchor + 04 + 05 + 01 §Risks. If the skill is not loaded, refuse and tell the user to install groundwork first — this action requires the state script.

Do not touch any tab in artifact/index.html except via the spec-state fence.
```
