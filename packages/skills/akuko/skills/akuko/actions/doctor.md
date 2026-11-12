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

**Loaded when**: the user runs `/akuko doctor`, or setup / an action needs to know what is installed.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`.

## Run

1. Detect the host (`../lib/hosts.md` §Detection) and print the level and capabilities.
2. On **B and C** run `bash scripts/doctor.sh [project-dir]` from the skill folder (Git Bash on Windows). On **A** the shell is a cloud workspace, so run the project checks below through the host adapter and tell the person the local toolchain cannot be checked from claude.ai.
3. Read the output back in plain words. Fix nothing unasked.

## What it checks

| Check | Level | Notes |
|---|---|---|
| Node 22.6+ | **required** (exit 1) | akuko's scripts run TypeScript directly |
| FFmpeg, HyperFrames, Chrome / Chromium | optional | needed only from the stage that renders; storyboards and prompt packages work without them |
| `HYPERFRAMES_BROWSER_PATH` (Windows) | optional | must point at a working Chrome (R-9). Instructions only; doctor never sets it |
| Provider keys | info | env var **names** and set / not set (Kling needs both `KLING_ACCESS_KEY` and `KLING_SECRET_KEY`). Never a value. Also lists models marked **price unverified** (never runnable) |
| Network (`--probe` only) | info | `scripts/doctor.sh --probe` (or `scripts/probe.ts --all`) sends one keyless GET to each paid provider's API host, nothing billed, and says reachable or BLOCKED with the domains to allow. Without `--probe` doctor makes no network call. On claude.ai run it before asking for any key |
| Budget cap | warn | none recorded → paid jobs are refused, pointing to `setup`. Also warns when the budget currency differs from the provider config |
| Orphan `submitted` reservations | warn | see below |
| Provider config drift | warn | models whose `last_verified` is older than `stale_after_days`; example entries (info when merely listed, warn when a project uses one); pending-spend provider ids missing from `providers/config.json` |

**Exit code:** 0 when only optional dependencies are missing (warnings are advice); 1 when a required dependency is missing or `akuko.json` is not a valid project.

## Orphan reservations

A ledger entry still `submitted` that either has no matching **approved** pending spend, or was submitted more than 60 minutes ago and never settled. It still counts against the cap. Doctor **lists** them (entry id, amount reserved, why) and never clears one. To clear one: check the provider dashboard. If the job finished, re-run the action that started it (it collects the result and settles the entry). If it never ran, the person tells akuko to mark that entry cancelled (`settleEntry(..., { status: 'cancelled' })`), which frees the money.

## Rules it inherits

- Detect the host first; read the project only through the host adapter (`../hosts/`). Doctor writes nothing.
- Never print or store a key value.
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
