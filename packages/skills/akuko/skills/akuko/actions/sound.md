---
name: sound
description: "Add voice-over with word timings, music bed and SFX."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/sound.md from the akuko skill and follow it.
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

# action: `sound` — add voice-over with word timings, music bed and SFX

> **Stub (WP-02).** Filled by **WP-12 (Phase 2)**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: motion is approved (or in parallel, once the cut is timed) and the user runs `/akuko sound`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`, `../lib/spend.md` (WP-03).

**Stage**: `sound` · **paid** (spend gate before every call).

## What this action will do

- TTS narration with word timings into `audio/vo/` + `audio.narration`; music bed and SFX blocks.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person.
