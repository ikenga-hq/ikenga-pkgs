---
name: board
description: "Draw the sketch board: framing panels and 9-panel beat boards."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/board.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `board` — draw the sketch board: framing panels and 9-panel beat boards

> **Stub (WP-02).** Filled by **WP-21**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: breakdown is approved and the user runs `/akuko board`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

**Stage**: `sketch` · free.

## What this action will do

- Framing-diagram panels from each shot's blocking (`board/panels.ts`) and 9-panel beat boards (`board/beatboard.ts`).
- No paid calls. Panels are stored with `storeAsset` (kind `panel`) and shots move to `pending-review`.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
