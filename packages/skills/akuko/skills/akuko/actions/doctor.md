---
name: doctor
description: Check the toolchain and keys akuko needs on this host.
domain: content
ux_mode: silent
run:
  kind: chat_prompt
  prompt: |
    Load actions/doctor.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - sidecar
  - chat
---

# action: `doctor` — check the toolchain and keys akuko needs on this host

> **Stub (WP-02).** Filled by **WP-08**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: the user runs `/akuko doctor`, or setup/an action needs to know what is installed.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

## What this action will do

- Run host detection and print the level and capabilities.
- Check optional engines (FFmpeg, HyperFrames, a headless browser) and which provider keys are set — names only, never values.
- Exit 0 when only optional dependencies are missing (lifted from `studio-doctor/check.sh` into `scripts/doctor.sh`).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
