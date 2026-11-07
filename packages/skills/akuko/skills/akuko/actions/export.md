---
name: export
description: "Export MP4 masters, cutdowns and optional timelines or decks."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/export.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - sidecar
  - chat
---

# action: `export` — export MP4 masters, cutdowns and optional timelines or decks

> **Stub (WP-02).** Filled by **WP-15 (Phase 3) · WP-17 (Canva)**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: picture lock is approved and the user runs `/akuko export`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

**Stage**: `export` · free.

## What this action will do

- FFmpeg masters + cutdowns; optional DaVinci timeline; Canva deck (WP-17). Show a render-time estimate before full renders.
- On host A, MP4 renders locally — say so and hand over the project (R-3).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
