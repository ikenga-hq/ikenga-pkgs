---
name: motion
description: Turn key frames into clips or HTML scenes.
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/motion.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - network
  - secrets
  - sidecar
  - chat
---

# action: `motion` — turn key frames into clips or HTML scenes

> **Stub (WP-02).** Filled by **WP-10 · WP-11 (Phase 2)**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: key frames are approved and the user runs `/akuko motion`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`, `../lib/spend.md` (WP-03).

**Stage**: `motion` · **paid** (spend gate before every call).

## What this action will do

- Image-to-video clips through video providers (WP-10), or HyperFrames HTML scenes for titles and graphics (WP-11).
- Preview must equal render: no board shows motion for approval until gap G-01 passes.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person.
