---
name: setup
description: Configure akuko for this project.
domain: skill-core
ux_mode: streaming
run:
  kind: chat_prompt
  prompt: |
    Load actions/setup.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - secrets
  - chat
setup:
  mode: interview
  template_version: 1
  interview_questions:
    - provider_keys
    - budget_cap
    - defaults
    - brand
---

# action: `setup` — configure akuko for this project

> **Stub (WP-02).** Filled by **WP-08**. Until then, tell the person this action is not built yet, offer `/akuko status`, and stop. Do not improvise its behaviour.

**Loaded when**: the user runs `/akuko setup`, or any action finds no budget cap / no project.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

## What this action will do

- Interview in chat (Atelier setup lifecycle, D-02): provider keys, the **required** budget cap and currency, default aspect ratio and runtime, brand (palette, fonts, logo — the only source of branding; no defaults ship).
- Write the instance file `.atelier/akuko/manifest.json` (`template_version` + settings).
- Write the cap to `akuko.json.budget.cap` (G-06) — never to `.atelier/`.
- On Windows, offer to set `HYPERFRAMES_BROWSER_PATH`.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
