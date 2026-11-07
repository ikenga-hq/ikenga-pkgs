---
name: view
description: Design and publish a view of the project for a question.
domain: content
ux_mode: confirm
inputs_schema:
  type: object
  properties:
    question:
      type: string
      description: What the person wants to see.
  required: []
  additionalProperties: false
run:
  kind: chat_prompt
  prompt: |
    Load actions/view.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `view` — design and publish a view of the project for a question

> **Stub (WP-02).** Filled by **WP-07c**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: the user runs `/akuko view "<what you want to see>"` or asks to see the board.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

## What this action will do

- Default board (WP-07b) or a freehand view designed from the view contract (`views/contract.md`, WP-07a).
- Read-only views are free-form; a view that writes decisions must pass `scripts/check-view.mjs` before `publishView`.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
