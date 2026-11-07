---
name: assemble
description: "Assemble the animatic, rough cut and picture lock."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/assemble.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - sidecar
  - chat
---

# action: `assemble` — assemble the animatic, rough cut and picture lock

> **Stub (WP-02).** Filled by **WP-13 (Phase 2) · WP-15 (Phase 3)**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: sound and motion are approved and the user runs `/akuko assemble`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

**Stage**: `assemble` · free.

## What this action will do

- Animatic (panels + VO, timed to words, frame-seek player — WP-13); timeline → rough cut → picture lock (WP-15).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
