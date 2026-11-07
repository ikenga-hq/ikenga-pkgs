---
name: breakdown
description: "Break the screenplay into scenes, beats and shots sized to clip limits."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/breakdown.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `breakdown` — break the screenplay into scenes, beats and shots sized to clip limits

> **Stub (WP-02).** Filled by **WP-04**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: intake is approved and the user runs `/akuko breakdown`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

**Stage**: `breakdown` · free.

## What this action will do

- Screenplay → acts → sequences → scenes → beats → shots (`sc<N>_sh<M>`, ~5–10 s each) plus an asset checklist.
- Write `scenes[]`, `script.beats[]`, `shots[]` with status `pending-review`; lint with `breakdown/lint.ts`.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
