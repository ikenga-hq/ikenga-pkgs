---
name: keyframes
description: Render final key frames from sketch panels and bible refs.
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/keyframes.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - network
  - secrets
  - chat
---

# action: `keyframes` — render final key frames from sketch panels and bible refs

> **Stub (WP-02).** Filled by **WP-22**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: sketch board and bible are approved and the user runs `/akuko keyframes`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`, `../lib/spend.md` (WP-03).

**Stage**: `keyframes` · **paid** (spend gate before every call).

## What this action will do

- One shot at a time: sketch panel + bible refs → final key frame through the spend gate.
- Basic continuity check only; the at-scale audit is WP-14 (Phase 2).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person.
