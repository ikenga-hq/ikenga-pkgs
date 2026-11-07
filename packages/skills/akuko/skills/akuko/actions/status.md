---
name: status
description: Report where the project stands and whose move it is.
domain: content
ux_mode: silent
run:
  kind: chat_prompt
  prompt: |
    Load actions/status.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `status` — report where the project stands and whose move it is

> **Stub (WP-02).** No work package owns this action yet (not assigned in `09`). Until one does, it may do only the read-only summary below, straight from `akuko.json` through `readState()`; it never writes.

**Loaded when**: the user asks "where are we" or runs `/akuko status`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

## What this action will do

- Read-only: stages, units waiting for a person, pending spend with estimate / cap / spent / left if approved, ledger total.
- Never writes `akuko.json`.

## Rules it inherits

- Detect the host first; read the project only through the host adapter (`../hosts/`).
- Read-only: report unfolded decisions as "waiting to be folded" instead of folding them (folding writes; `review` and the producing actions do it).
