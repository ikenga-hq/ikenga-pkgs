---
name: akuko
description: |
  Take a short story, treatment or film script to a finished short film, one
  reviewed stage at a time: screenplay (Fountain), breakdown into scenes and
  shots, sketch board, character / location / style bibles, key frames,
  motion, sound, assembly and export. Works in Claude artifacts (claude.ai),
  Claude Code, and the Ikenga desktop app, detecting the host at the start of
  every action. Nothing is approved except by a person, and nothing paid runs
  without an estimate, a budget cap and an explicit OK.

  TRIGGER when the user wants to turn a story or script into a film, storyboard
  or animatic; mentions an `akuko.json` project; or runs any akuko action:
  setup / doctor / intake / breakdown / bible / board / keyframes / motion /
  sound / assemble / export / review / view / status.

  DO NOT TRIGGER for planning a film without making it (use groundwork's
  `film` profile), one-off image generation, or editing an existing video file.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
---

# akuko — story to film, one reviewed stage at a time

**This file is a router.** Each action lives in its own file under `actions/`; load it on demand and follow it. Do not inline action behaviour here. Shared rules live in `lib/`:

- `lib/state.md` — the project file, stages, status transitions, decision folding. **Read it before anything that writes.**
- `lib/hosts.md` — host detection, what each host can do, the host adapter.
- `lib/spend.md` — the spend gate and cost ledger (WP-03). `lib/providers.md` — providers (WP-03).

The project format is `schema/akuko-project.ts` (`akuko.json`, JSON Schema in `schema/akuko-project.schema.json`).

---

## Every action starts the same way

1. **Detect the host** (`lib/hosts.md` §Detection): A claude-artifact · B local · C ikenga. Run `node --experimental-strip-types hosts/detect.ts --tools <your FULL tool list — every loaded and deferred tool name>`. If the output has a `warning`, or you are in any doubt, treat the host as **A** (artifact DB) and never create a project folder. Record the result in `akuko.json.host`.
2. **Read the project** through the host adapter (`readState()`); if there is none, route to `intake` (or `setup` if the person wants to configure first).
3. **Fold decisions** people made since the last run (`readDecisions()` → `lib/state.md` §Decision folding) before doing anything else.
4. Load the action file and follow it. Write the project only through `writeState()`; store files only through `storeAsset()`.

## Routing

| If the user says… | Load this | Owner |
|---|---|---|
| "set up akuko", "configure", "set a budget", "add my keys" | [`actions/setup.md`](actions/setup.md) | WP-08 |
| "check my setup", "what's missing", "doctor" | [`actions/doctor.md`](actions/doctor.md) | WP-08 |
| "make a film from this story / script", "start a project", "intake" | [`actions/intake.md`](actions/intake.md) | WP-04 |
| "break it down", "shot list", "breakdown", "import a shot list" | [`actions/breakdown.md`](actions/breakdown.md) | WP-04 |
| "characters", "locations", "look / style", "bible" | [`actions/bible.md`](actions/bible.md) | WP-05 |
| "storyboard", "sketch board", "beat board", "board" | [`actions/board.md`](actions/board.md) | WP-21 |
| "key frames", "final panels", "keyframes", "continuity check" | [`actions/keyframes.md`](actions/keyframes.md) | WP-22 |
| "animate", "make the clips", "motion" | [`actions/motion.md`](actions/motion.md) | WP-10 · WP-11 |
| "lip-sync", "make them say the line", "lipsync" | [`actions/lipsync.md`](actions/lipsync.md) | WP-28b |
| "voice-over", "music", "sound effects", "sound" | [`actions/sound.md`](actions/sound.md) | WP-12 |
| "animatic", "rough cut", "assemble" | [`actions/assemble.md`](actions/assemble.md) | WP-13 (stub) |
| "export", "send to Resolve", "give me a timeline" | [`actions/export.md`](actions/export.md) | WP-23 (Resolve handoff) |
| "I reviewed it", "apply my notes", "review" | [`actions/review.md`](actions/review.md) | WP-07a |
| "show me …", "open the board", "view" | [`actions/view.md`](actions/view.md) | WP-07c |
| "where are we", "what's next", "status" | [`actions/status.md`](actions/status.md) | — |

Export hands the approved film to DaVinci Resolve as a timeline plus media. MP4 masters, cutdowns and a Canva deck are parked (plan Round 7): if asked for an MP4, say so and offer the handoff.

If nothing matches, run `status` and offer the next action it suggests. If an action file still says **Stub (WP-02)**, tell the person it is not built yet and stop — do not improvise it.

## Stages

`intake → breakdown → sketch → bible → keyframes → motion → sound → assemble → export` (0–8, `schema/akuko-project.ts#STAGES`; the film profile is `profiles/film/profile.json`). A stage opens only when the stages before it are approved (`lib/state.md` §Stages).

## Review rules

These hold on every host and in every action and view:

1. **Only a person approves.** Actions move units to `pending-review`; only a person's decision moves a unit to `approved`. No action or view auto-approves, pre-ticks or batch-approves.
2. **Never auto-advance past review.** Each stage ends at a review gate (Atelier `ux_mode: approve`): run, then pause on what was produced.
3. **One unit at a time** inside a stage: produce, show, wait — don't regenerate the whole stage because one shot was sent back.
4. **Decisions go through the decision format** (`Decision` in the schema), written by a review surface to the host's store. A view never edits `akuko.json` and never calls `writeState()`.
5. **Requested changes are honoured, then marked**: revise the unit, add a "Revised: …" comment, return it to `pending-review`.

## Spend rules

1. **No paid call without an OK.** Every paid job (image, video, TTS) goes through the spend gate (`lib/spend.md`): show the estimate, the cap, what is spent and **what is left if you approve**, then wait for an explicit approval of that job.
2. **No cap, no spend.** If `akuko.json.budget` is null, refuse paid jobs and point to `setup`.
3. **Never exceed the cap** or a job's `approved_max`; stop and ask instead.
4. **Money is never hidden or rounded.** Every paid call is recorded in `ledger[]`, success or failure.
5. **Keys stay in the environment** (or the host's secret store) — never in `akuko.json`, a view, or a transcript.
6. **House rules come before money.** When the project has `rules`, every job is checked against them before the spend gate, and a breach is refused (`rules-breach`), naming the rule and the offending text or file. Report it and stop; never reword, drop a reference or edit the rules to get past it. Run `rules/cli.ts check` for a free preflight (`lib/state.md` §"Rules guard (WP-26)").

## Hosts in one line each

- **A — claude-artifact (claude.ai):** Bash and files only in a remote workspace that lasts one chat, so no durable project folder. The project lives in the board artifact's database; the agent reads and writes it with tool calls. Generation through connected MCPs (e.g. Canva) and manual prompt packages; MP4 renders locally.
- **B — local (Claude Code):** `akuko.json` on disk, files in the project folder, all providers via env keys, HyperFrames + FFmpeg.
- **C — ikenga:** B plus the Ikenga bridge (and Studio when its MCP is connected); Studio owns render state.

Details and the capability evidence: `lib/hosts.md`.

## Files

```
SKILL.md              this router
actions/*.md          one file per action (Atelier frontmatter)
lib/state.md          project file rules, stages, transitions, decision folding
lib/hosts.md          host detection, capabilities, manual host check
hosts/types.ts        HostAdapter contract (G-HOST)
hosts/{claude-artifact,local,ikenga}.ts   one adapter per host
profiles/film/        the film profile
schema/               akuko.json format (G-SCHEMA)
```
