---
name: intake
description: "Bring in a story, treatment or screenplay and produce a Fountain screenplay."
domain: content
ux_mode: approve
inputs_schema:
  type: object
  properties:
    source:
      type: string
      description: "Path to the story, treatment or screenplay."
  required: []
  additionalProperties: false
run:
  kind: chat_prompt
  prompt: |
    Load actions/intake.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `intake` — bring in a story, treatment or screenplay and produce a Fountain screenplay

> **Stub (WP-02).** Filled by **WP-04**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: the user starts a project from a source text, or runs `/akuko intake`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

**Stage**: `intake` · free.

## What this action will do

- Create the project folder and `akuko.json` if absent (`readState` / `writeState`).
- For prose, **ask each time**: adapt to a screenplay first, or break the prose down directly (Q-06).
- Write `script/source.md` and `script/screenplay.fountain`; set the intake stage to `in-review`.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
