---
name: review
description: "Fold people's decisions into the project and revise what they sent back."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/review.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `review` — fold people's decisions into the project and revise what they sent back

> **Stub (WP-02).** Filled by **WP-07a**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: the user says they reviewed, or any action starts (decisions are always folded first).

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

## What this action will do

- `readDecisions(since)` through the host adapter (`decisions/<store>.ts`), fold them into `status`, `comments[]` and `pending_spend` per `../lib/state.md` §Decision folding.
- Revise units marked `needs-rework` one at a time, add a "Revised: …" comment, move them back to `pending-review`.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
