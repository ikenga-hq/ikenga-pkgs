---
name: board
description: "Draw the sketch board: framing panels and 9-panel beat boards."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/board.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `board` — draw the sketch board: framing panels and 9-panel beat boards

**Loaded when**: breakdown is approved and the user runs `/akuko board`.

**Reads first**: `../lib/state.md` (§2 sketch, §Decision folding), `../lib/hosts.md`.

**Stage**: `sketch` (2) · free. Never spends, never approves.

**What is judgement and what is code.** Deciding where each character or object sits in frame is **yours**, and only from what the script and the shot's `action` say. Drawing, storing, status changes, lint, the beat boards and the idempotent re-run are code in `../board/` and tested. A panel is a *framing diagram* (labelled boxes on a thirds grid), not an illustration: no figures, no faces, no image generation, no provider call.

## Steps

1. **Fold decisions first** (`actions/review.md`; `../lib/state.md` §Decision folding), and tell the person what changed, including anything rejected.
2. **Gate.** If `stages.breakdown` is not `approved`, refuse and say which units are waiting. Never start the sketch early.
3. **Blocking (judgement).** Look at the shots that have no `blocking`, or that a person sent back with a comment about placement. For each, write a proposal file (outside the project folder):
   `{ "sc1_sh1": [ { "who": "M", "shape": "rect", "x": 0.2, "y": 0.35, "w": 0.12, "h": 0.5 } ] }`
   - `who` is a short label, the character's initials (`M`, `O`) or an object (`lantern`). `shape` is `rect` (x/y = top-left) or `ellipse` (x/y = centre). Numbers are 0-1 of the frame.
   - Place only what the shot's text states (who is in frame, left or right, near or far). **Never invent blocking.** If the text doesn't say, leave the shot without it: its panel says "NO BLOCKING" and lint warns, which is the honest state.
   - `cli.ts blocking --project <folder> --file <proposal>` applies it. It refuses unknown shots, bad numbers, and a panel already under review or approved (the person sends it back first).
4. **Draw.** `node --experimental-strip-types board/cli.ts draw --project <folder>`: draws a panel for each shot that needs one, stores it through the host adapter, moves those shots to `pending-review`, and writes the beat boards to `board/beatboards/`. On host A import `drawSketchPanels()` and `buildBeatBoards()` from `../board/` and pass the project read from the artifact database; store the boards as assets.
   - A shot a person sent back is redrawn only when its blocking or camera changed. If it did not, the run lists it as still sent back: change something real (step 3) and draw again, or ask the person what they want different.
5. **Stop at the review gate.** Report: panels drawn and redrawn, shots left as they were, lint warnings **by shot id** (shots with no blocking, boxes outside the frame), and where the beat boards are. The person reviews the shots on the board; the stage is approved when every shot is. Don't start the bible.

## Notes

- The review unit is the **shot at stage `sketch`**; the panel file is linked from `by_stage.sketch.output`. Panels are not separate assets (`../lib/state.md` §2).
- Beat boards are derived and rewritten every run; nothing to review there.
- Free stage: no provider call, no spend gate (`../lib/spend.md` does not apply).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
