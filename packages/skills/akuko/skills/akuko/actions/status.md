---
name: status
description: Report where the project stands and whose move it is.
domain: content
ux_mode: silent
run:
  kind: chat_prompt
  prompt: |
    Load actions/status.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `status` — report where the project stands and whose move it is

**Loaded when**: the user asks "where are we" or runs `/akuko status`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

Read-only: it never writes `akuko.json` and never folds (folding writes; `review` and the producing actions do it).

## What it reports

Detect the host, read the project with `readState()` (on A: ArtifactData `get` `akuko/project`), and read the decision store without folding (`readDecisions()`; on A, ArtifactData `list` `decisions`). Then report, all **derived from the data**, never typed:

1. **Your move**: the same counts a conforming view shows (`../views/contract.md` §3):
   - shots `pending-review`;
   - spend decisions waiting (`pending_spend` `awaiting-approval`);
   - other units waiting (assets `pending-review`, plus bible entries `pending-review` with no asset refs);
   - units `needs-rework` (back with akuko).
2. **Decisions waiting to be folded**: decisions in the store whose ids are not in `akuko.json.decisions[]`. Count them and say "run `/akuko review` to apply them".
3. **Not applied**: comments starting `Not applied:` and approvals that didn't take (a job still `awaiting-approval` whose latest decision is an `approve-spend`). Say why, from the comment or the spend gate.
4. **Stages**: each stage's state and the current stage.
5. **Money**, exactly, never rounded:
   - the cap, spent, sunk and in flight (`ledgerSummary()`);
   - each waiting job's estimate;
   - **what is left if you approve** them.

   If `budget` is null, say no paid step can run until `/akuko setup` sets a cap.
6. **Next step**: the first of: review the waiting units, decide the spend, run `/akuko review` for unfolded decisions, revise what was sent back, or the next stage's action.

Only when the person asks "how much will it cost" or "what is left to spend": run `../setup/estimate.ts` (see `./setup.md` §Whole-film estimate) and report its low / likely / high exactly, with its warnings. It is free and read-only.

## Rules it inherits

- Detect the host first; read the project only through the host adapter (`../hosts/`).
- Never writes, never folds.
