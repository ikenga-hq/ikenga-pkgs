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

**Loaded when**: the user runs `/akuko setup`, or any action finds no budget cap / no project (the spend gate's refusal points here).

**Reads first**: `../lib/state.md`, `../lib/hosts.md`, `../lib/spend.md`.

Code: `../setup/setup.ts` (`applySetup`), `../setup/manifest.ts` (`writeManifest`). Read the project and write it only through the host adapter; fold decisions first (`../lib/state.md` §Decision folding).

## Interview (Atelier setup lifecycle, D-02)

Ask in chat, one topic at a time. Skip a topic the person has already answered in this project.

1. **Provider keys.** Say which paid providers need a key and the environment variable each reads (`providersNeedingKeys()` / `keyPresence()`; the name comes from the provider's `key_env` in `providers/config.json`, falling back to `<PROVIDER_ID>_API_KEY`). Report only **set / not set**. Never ask the person to paste a key into chat, never read a value out, never write one to `akuko.json`, the manifest or a view. Keys live in the environment or the host's secret store. The manual provider needs none.
2. **Budget cap — required, no default.** Ask: "What is the most you are willing to spend on this film?" Take a number in the provider-config currency (`providers/config.json` `currency`; say which). Do not suggest or fill in a figure. If the person declines to give one, stop and say no paid generation will run until they do (`0` is a valid answer: manual provider only). `applySetup()` refuses to finish without it.
3. **Defaults.** Aspect ratio (16:9, 9:16, 1:1) and target runtime in seconds. Optional.
4. **Brand.** Palette (hex colours, optional names), fonts (family, optional role) and a logo path or URL. **This is the only source of branding**: akuko ships none, so use exactly what the person gives and nothing else. If they give none, `brand` stays `null` and views use neutral styling.
5. **Windows only — `HYPERFRAMES_BROWSER_PATH`.** HyperFrames' bundled headless shell can crash on Windows; the variable must point at a working Chrome. `applySetup()` returns `browser.instructions`; show them. Offer, never do: do not run `setx`, edit the registry or change the person's environment. Rendering is optional until the assemble stage.

## Write

Say the cap and currency back to the person, then call `applySetup(answers, { host })`. It
- writes `akuko.json.budget = { cap, currency, spent }` through `writeState()` (schema-validated). The currency is the provider-config currency, so the gate never refuses a job for currency mismatch. `spent` is kept on a re-run; a cap below what is already spent or reserved is refused;
- writes the defaults to `project.aspect_ratio` / `project.runtime_s`;
- returns the manifest. On **B and C** call `writeManifest(projectDir, manifest)` to write `.atelier/akuko/manifest.json` (`template_version`, key presence as booleans, defaults, brand, browser status). On **A** there is no durable folder: the cap and defaults are saved in the project (artifact database); tell the person brand is not persisted on this host and will be asked again.

The cap lives in `akuko.json.budget.cap`, never under `.atelier/`.

## Finish

Run `doctor` (`./doctor.md`) once, then offer `/akuko intake` if there is no script yet.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
