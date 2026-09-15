# lib: agent return schemas

Canonical structured-output contracts for the agents groundwork spawns. **One definition, two consumers:**

1. **Workflow path** (opt-in: `research --sweep`, `review --panel`, `orchestrate --emit-workflow`) — passed as the `schema` option to `agent(prompt, {schema})`. The Workflow runtime forces the subagent to call its `StructuredOutput` tool and validates the result at the tool layer, retrying on mismatch. The action receives a validated object — no prose parsing.
2. **Single-agent fallback** (default, no flag) — the same shape is the **prose** "RETURN FORMAT (JSON envelope)" the agent briefs ask for, and the action parses the agent's final message. No tool-layer enforcement; the brief is the contract.

The schemas below are the source of truth. The briefs in `agents/*.md` reference them by name; the emitted workflow template (`profiles/_shared/templates/artifact/orchestrate.workflow.js`) and the `--sweep` / `--panel` workflow scaffolds embed them as JSON-Schema literals.

> **Schema authoring note.** Workflow `schema` values are plain JSON Schema. Keep them shallow and `required`-tight — every property the action reads must be `required` so a partial return fails validation and retries rather than silently dropping a field. Use `enum` for status/severity so the model can't invent values the action doesn't handle.

---

## `RESEARCHER_SCHEMA` — one research finder (research action)

A single finder's scoped pass over one angle. Mirrors the existing prose envelope in `agents/researcher.md`; `findings`/`sources` are markdown blocks the action writes into the `findings` / `sources` fences verbatim.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["scope", "findings", "sources", "notes"],
  "properties": {
    "scope":    { "type": "string", "enum": ["external", "internal"] },
    "angle":    { "type": "string", "description": "the finder's lane, e.g. external-precedent / external-library-docs / internal-codebase / internal-constraints" },
    "findings": { "type": "string", "description": "markdown: one `## <topic>` section per finding; every claim cited (URL for external, path:line for internal)" },
    "sources":  { "type": "string", "description": "markdown numbered list: `1. <Title or path> — <URL or path:line> (accessed YYYY-MM-DD)`; empty string for internal-only" },
    "notes":    { "type": "string", "description": "one paragraph: what couldn't be found, what to revisit" }
  }
}
```

## `RESEARCH_SYNTHESIS_SCHEMA` — merge of all finders (`--sweep` synthesis stage)

Dedups + merges the parallel finders into the two fence payloads the `research` action writes. One synthesis agent produces this from the array of `RESEARCHER_SCHEMA` results.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["external_findings", "external_sources", "internal_findings", "stamp", "notes"],
  "properties": {
    "external_findings": { "type": "string", "description": "merged markdown for the 02 `findings` fence; empty if external not in scope" },
    "external_sources":  { "type": "string", "description": "deduped unified source list for the 02 `sources` fence; empty if external not in scope" },
    "internal_findings": { "type": "string", "description": "merged markdown for the 03 `findings` fence; empty if internal not in scope" },
    "stamp":             { "type": "string", "description": "YYYY-MM-DD (pass it in via the prompt; scripts can't read the clock)" },
    "notes":             { "type": "string" }
  }
}
```

---

## `REVIEWER_FINDINGS_SCHEMA` — one reviewer's findings (review action)

The full reviewer envelope from `agents/reviewer.md`, now machine-enforceable. Under `--panel` one of these comes back per lens; under the default a single reviewer returns one.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["round_theme", "findings", "strengths_to_defend", "new_risks",
               "out_of_scope", "deferred", "not_reopened", "locks_introduced", "still_open"],
  "properties": {
    "round_theme": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "severity", "kind", "fold", "touches"],
        "properties": {
          "title":    { "type": "string" },
          "severity": { "type": "string", "enum": ["critical", "important", "nice"] },
          "kind":     { "type": "string", "enum": ["structural-gap", "risk", "contradiction", "design-review", "design-conformance", "readiness"] },
          "fold":     { "type": "string", "description": "one paragraph: what changes in which doc" },
          "touches":  { "type": "array", "items": { "type": "string" }, "description": "every doc whose content changes to apply the fold" },
          "design":   { "type": ["string", "null"], "description": "D-NN the finding is about — set for design-review / design-conformance, null otherwise" },
          "state":    { "type": ["string", "null"], "description": "the design state it concerns (default / empty / loading / error / declined …); null when it applies to the whole design" },
          "location": { "type": ["string", "null"], "description": "file:line — the mockup line for design-review, the implementation line for design-conformance" }
        }
      }
    },
    "strengths_to_defend": { "type": "array", "items": { "type": "string" } },
    "new_risks": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["title", "description", "mitigation"],
        "properties": {
          "title":       { "type": "string" },
          "description": { "type": "string" },
          "mitigation":  { "type": "string" }
        }
      }
    },
    "out_of_scope": { "type": "array", "items": { "type": "string" } },
    "deferred": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["title", "reason", "revisit_at"],
        "properties": {
          "title":      { "type": "string" },
          "reason":     { "type": "string" },
          "revisit_at": { "type": "string", "description": "phase / date / event" }
        }
      }
    },
    "not_reopened": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["lock", "why_still_locked"],
        "properties": {
          "lock":             { "type": "string" },
          "why_still_locked": { "type": "string" }
        }
      }
    },
    "second_pass_audit": { "type": ["string", "null"] },
    "locks_introduced":  { "type": "array", "items": { "type": "string" } },
    "still_open":        { "type": "array", "items": { "type": "string" } }
  }
}
```

> The action still computes `plan_files_touched` itself, from the union of every finding's `touches[]` — the reviewer never emits it (matches `agents/reviewer.md`).

## `VERDICT_SCHEMA` — adversarial verify / freeze-gate sign-off

Used twice: (a) in `review --panel`, each deduped finding is judged by N distinct lenses, each prompted to *refute* it — keep findings where a majority do **not** refute; (b) in the emitted orchestrate workflow, each completed WP's report is verified against its Definition of Done + the freeze-gate sign-off check before the wave barrier is crossed.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["passes", "refuted", "reason"],
  "properties": {
    "passes":  { "type": "boolean", "description": "DoD / gate sign-off met (use for gate verify)" },
    "refuted": { "type": "boolean", "description": "the claim was successfully refuted (use for finding verify); default true when uncertain" },
    "reason":  { "type": "string", "description": "one or two sentences of evidence" }
  }
}
```

## `WP_REPORT_SCHEMA` — one work-package subagent's report (emitted orchestrate workflow)

What each WP agent returns from its run. The workflow aggregates these and returns them; the **orchestrator session** (not the script) then ticks `05` checkboxes, mirrors Tasks, commits, and merges — see `lib/state.md` §"Workflow execution invariants".

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "status", "report", "files_touched", "dod_met", "designs_implemented"],
  "properties": {
    "id":            { "type": "string", "description": "WP-NN" },
    "status":        { "type": "string", "enum": ["done", "blocked", "needs-decision"] },
    "report":        { "type": "string", "description": "what was done; if blocked/needs-decision, what's needed" },
    "files_touched": { "type": "array", "items": { "type": "string" } },
    "dod_met":       { "type": "boolean", "description": "subagent's own DoD self-check (the gate verify re-checks adversarially)" },
    "drift":         { "type": ["string", "null"], "description": "one line if shipped scope diverged from the brief (feeds the Round-8 drift log); null if it matched" },
    "designs_implemented": { "type": "array", "items": { "type": "string" }, "description": "D-NN this change implements, [] when none. The orchestrator records it with `register-design-impl` and copies it to the PR body's \"Designs implemented\" line" }
  }
}
```

---

## Model tiers (per the global subagent-model policy)

Every spawned agent — Workflow `agent(…, {model})` or `Agent`-tool fallback — declares a tier by task weight:

| Tier | Use for |
|---|---|
| `opus` | freeze-gate sign-off, adversarial `VERDICT` verify, architecture / novel / ambiguous WPs |
| `sonnet` | research finders, review-lens finders, synthesis, routine WPs within a known design |
| `haiku` | mechanical / status / file-move WPs, trivial lookups |

`orchestrate` stamps a `tier` on each `WP-NN` in the ID registry (heuristic default, user-overridable via `--field tier=<t>`); `board-data` surfaces it; the emitted workflow passes it through. Research/review fan-outs default their finders to `sonnet` and their verify/sign-off agents to `opus`.
