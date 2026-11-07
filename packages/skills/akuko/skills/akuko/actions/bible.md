---
name: bible
description: "Build the character, location and style bible."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/bible.md from the akuko skill and follow it.
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

# action: `bible` — build the character, location and style bible

> **Stub (WP-02).** Filled by **WP-05**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: breakdown is approved and the user runs `/akuko bible`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`, `../lib/spend.md` (WP-03).

**Stage**: `bible` · **paid** (spend gate before every call).

## What this action will do

- From the asset checklist: character sheets (portrait → labelled turnaround), location plates, style / lookbook.
- Every image goes through the spend gate, then `storeAsset`; refs land in `bible.*[].refs[]`.
- Image providers come from WP-06 (Gemini, fal) or the manual provider (WP-03).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person.
