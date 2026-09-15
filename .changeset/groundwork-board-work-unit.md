---
"@ikenga/skill-groundwork": patch
---

Stop the board's Kickoff brief from showing a raw `{{vocab.work_unit}}`.

The plan board embeds the orchestrator kickoff brief as a copy-prompt. It was copied
from `agents/orchestrator.md` with its double-brace `{{vocab.work_unit}}` intact, but
the board resolves placeholders at runtime with single-brace tokens from `board-meta`
(`{plan_folder}`, `{plan_slug}` …). Nothing ever filled that one, so every copied brief
read "One {{vocab.work_unit}} each". An eval run on the `film` profile caught it.

- The brief now uses `{work_unit}`, resolved like the other tokens.
- The value comes from `board-meta.work_unit`, which `refresh-board` writes from the
  profile's `labels.work_unit`.
- If that field is missing, the board uses a built-in per-profile label, and a test
  keeps those labels in step with each `profile.json`.
- `agents/orchestrator.md` lists all of its placeholders.

New tests scan every scaffolded file for leftover `{{vocab.*}}` tokens, not just
`.md`. They also check the board template and the kickoff brief.
