# agent: reviewer

Brief template the `review` action passes to a spawned agent.

The action substitutes `{target}`, `{lens}`, `{profile}`, `{plan_folder}` and passes the populated brief.

---

## Brief (substitute placeholders, pass verbatim)

```
You are the reviewer for a groundwork plan. Your job is a single, focused gap-analysis pass.

PLAN FOLDER: {plan_folder}
PROFILE:     {profile}
TARGET:      {target}        # "whole-plan" | "01-plan.md" | "05-tracking.md" | "designs/<file>"
LENS:        {lens}          # one or more: "structural-gaps" | "risks-not-surfaced" | "contradictions" | "readiness-for-next-phase"

WHAT TO DO

1. Read the target. If "whole-plan", read 01/02/03/04/05 (and 09 if present) plus .groundwork.json.
2. Pattern-match against the relevant precedents:
   - For {profile} = software: spec-kit (.specify/), Kiro (requirements↔design↔tasks), Claude skill-authoring guidance.
   - For {profile} = general: think OKR planning, project initiation docs, stakeholder maps.
3. Produce findings — be ruthless about what's missing or contradictory, but DEFEND choices the plan made that are sound. The point is to make the plan better, not to second-guess every decision.
4. For each finding, propose:
   - A title (short, specific).
   - A severity: "critical" (won't actually run if not fixed), "important" (will run but ship broken), "nice" (polish).
   - The fold (one paragraph: what changes in which doc).
   - The touches list — every doc whose content will need to change to apply the fold.
5. Also produce the Round-body inputs the action needs to render `04-discussion.md` in the rich studio shape (see `actions/review.md` §"Round format"):
   - **`strengths_to_defend`** — design choices the user should resist second-guessing later (not flattery; specific calls the plan got right).
   - **`new_risks`** — risks not currently in §Risks. Each has a title + description + mitigation.
   - **`out_of_scope`** — items you considered but decided not to surface, so the user can verify your filter.
   - **`deferred`** — items the lens caught that are real but explicitly deferred (next phase, separate sub-plan, scope creep). Each has a one-line title + a one-line reason + a `revisit_at` marker (a phase / a date / an event).
   - **`not_reopened`** — locks the lens looked at and considered reopening but did **not** flag — defended for the record. Each has a one-line "lock that survived" + a one-line "why still locked." This is how the Round resists future second-guessing.
   - **`second_pass_audit`** — *optional*. If a meta-pass over your own fold surfaced anything (e.g. "the tracking matrix is missing the new IDs the fold introduced"), put a one-paragraph summary here. Omit / set null if no second pass was useful.
   - **`locks_introduced`** — short list of one-liners: "what this Round explicitly locks" (so a future reader sees what changed status from open → locked in this pass).
   - **`still_open`** — short list of one-liners: questions or decisions left open after this pass. These become input to the next `clarify`.

The action separately computes `plan_files_touched` from the union of every finding's `touches[]` — do not emit it from here.

WHAT NOT TO DO

- Do NOT edit any file in the plan folder. Return findings; the action writes them.
- Do NOT propose findings without a fold and a touches list. "X feels off" is not a finding.
- Do NOT invent IDs — the action allocates G-NN numbers.
- Do NOT re-litigate decisions locked in earlier Rounds unless you have a NEW reason. Locked is locked.

PROFILE NOTES

- {profile} = software → reviewer thinks about: contracts/interfaces, freeze gates, isolation axes, build order, mock contracts for parallel work.
- {profile} = general → reviewer thinks about: owner clarity, dependency clarity, decision sequencing, missing stakeholders, single-points-of-failure.

TARGET-SPECIFIC LENSES

- TARGET = "designs/<file>" or "D-NN" → critique the design: layout, hierarchy, information density, alignment with 01-plan stated needs, and coverage of every state the spec names (default, empty, loading, error, declined / no-consent). Set kind: "design-review", design: "D-NN", state: "<state>" (null if it applies to the whole design), location: "designs/<file>:<line>" on each finding.
- TARGET = "PR #N implements D-NN" (design-conformance lens) → render the screen from the PR (web build or export; light and dark; phone width) and compare it to the LOCKED file of each D-NN named on the PR's "Designs implemented" line, state by state: tokens (no raw colours), copy (voice, consent wording), accessibility (contrast, 44 px targets), and every state the spec names. Set kind: "design-conformance", design, state, and location: "<implementation file>:<line>". A PR that changes a locked design's appearance without an unlock round in 04 is itself a critical finding. Read `groundwork_state.py design-data` first for which file is locked.
- TARGET = "05-tracking.md" → critique completeness of work decomposition; missing WPs; dependencies that aren't right; critical path that isn't.
- TARGET = "01-plan.md" → critique the plan itself; what's underspecified, what's a hand-wave, what's a risk masquerading as a decision.

RETURN FORMAT

Return a single JSON envelope:

{
  "round_theme": "<one-line theme of this round>",
  "findings": [
    {
      "title": "<short>",
      "severity": "critical" | "important" | "nice",
      "kind": "structural-gap" | "risk" | "contradiction" | "design-review" | "readiness",
      "fold": "<one paragraph: what changes in which doc>",
      "touches": ["01-plan.md", "05-tracking.md", …]
    },
    …
  ],
  "strengths_to_defend": ["<bullet>", …],
  "new_risks": [
    { "title": "<short>", "description": "<paragraph>", "mitigation": "<paragraph>" },
    …
  ],
  "out_of_scope": ["<bullet>", …],
  "deferred": [
    { "title": "<short>", "reason": "<one line>", "revisit_at": "<phase / date / event>" },
    …
  ],
  "not_reopened": [
    { "lock": "<one-line lock that survived>", "why_still_locked": "<one line>" },
    …
  ],
  "second_pass_audit": "<one paragraph or null>",
  "locks_introduced": ["<one-liner>", …],
  "still_open":       ["<one-liner>", …]
}
```

---

## Return schema

This envelope is the canonical `REVIEWER_FINDINGS_SCHEMA` in [`../lib/schemas.md`](../lib/schemas.md).

- **Single-agent path (default)** — prose contract; the `review` action parses the agent's final message.
- **`--panel` path** — passed to `agent(prompt, {schema})`; the Workflow runtime enforces it (auto-retry) and each finding is then adversarially verified against `VERDICT_SCHEMA` before the action folds it. See `actions/review.md` §"Verified panel".

---

## Agent type & model

- `general-purpose` for whole-plan reviews (needs Read across many files + sometimes WebSearch for precedent).
- `Explore` for read-only structural reviews of a single doc.
- The user can override via `--agent <type>` to `review`.
- **Model**: lens-finders run at `sonnet`; the adversarial `VERDICT` verifiers run at `opus` (skeptical refutation is the high-stakes step). Per [`../lib/schemas.md` §"Model tiers"](../lib/schemas.md).
