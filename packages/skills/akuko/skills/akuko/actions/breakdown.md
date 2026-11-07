---
name: breakdown
description: "Break the screenplay into scenes, beats and shots sized to clip limits."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/breakdown.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `breakdown` — break the screenplay into scenes, beats and shots sized to clip limits

<!-- Stub (WP-02): replaced by WP-04. This action is built; the marker stays only because actions.test.ts looks for it. -->

**Loaded when**: intake is approved and the user runs `/akuko breakdown`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`, and **`../profiles/film/breakdown.md`** (the film rules: shot sizing, shot vocabulary, what goes on the checklist).

**Stage**: `breakdown` (1) · free. Never spends, never approves.

**What is judgement and what is code.** Deciding the scenes, where to cut, the shot type and action, and who and what is in frame is **yours**: you write it as one JSON *proposal* (shape below). Everything mechanical is code in `../breakdown/` and tested: checking the proposal, allocating every id (`sc<N>`, `sc<N>_sh<M>`, `sc<N>_b<K>`, `char_*`, `loc_*`, `style_*`), building the units at `pending-review`, lint, writing the `[[sc<N>_sh<M>]]` tags, and the idempotent re-run. **Never write an id or a status yourself.**

## Step 0 — Which branch am I in?

Read the project (`readState()`, after folding decisions). Check it with `alreadyBrokenDown()`; the CLI does this for you.

- **`stages.intake` is not `approved`** → refuse. Say intake is waiting for the person's approval.
- **`shots[]` or `scenes[]` is not empty → TAG ONLY.** Create, delete and reorder nothing. Skip to step 6, which only adds missing tags to the script. Stacking a second set of shots next to an existing one is the one mistake that cannot be undone.
- **Both empty → SCAFFOLD.** Steps 1 to 7.

## Steps (scaffold)

1. **Pick the text.** If `script.screenplay` is set, work from `script/screenplay.fountain` (the adapted or supplied screenplay). If it is not set, intake took the **direct route**: work from `script/source.md`. Both routes end in the same shots; only the text they quote differs.
2. **Read it all, then structure it:** acts, sequences, scenes, beats. Scene numbers follow the screenplay's scene headings in order (`sc1` is the first heading). On the direct route, you decide the scenes from the prose and give each a short heading (`River pier, dusk`).
3. **Cut it into shots**, following `../profiles/film/breakdown.md`. The hard limits (lint refuses the breakdown otherwise): **each shot at most 10 seconds, at most 2 principal characters in frame**. Aim for 5 to 10 s. Copy `script_line` **exactly** from the text; it is how the shot finds its paragraph for the tag. Don't invent dialogue, characters or events.
4. **Fill the checklist:** every character, location and the overall look the shots use, once each, with a role (`Principal`, `Supporting` or `Background`) for characters. Shots refer to these **by name**. Props have no checklist home yet: note a story-critical prop in the shot's `notes`.
5. **Write the proposal** to a file (any path, outside the project folder), as JSON:

```json
{
  "scenes":    [{ "n": 1, "heading": "EXT. RIVER PIER - DUSK", "summary": "…", "act": "I", "sequence": "Arrival" }],
  "checklist": { "characters": [{ "name": "Mara", "role": "Principal", "description": "…" }],
                 "locations":  [{ "name": "River Pier", "description": "…" }],
                 "styles":     [{ "name": "Fog and Lamplight", "description": "…" }] },
  "shots":     [{ "scene": 1, "beat": "Mara arrives", "shot_type": "ws", "camera": "Static, low angle",
                  "camera_move": "static", "action": "…", "duration_s": 6,
                  "script_line": "…exact text…", "characters": ["Mara"], "location": "River Pier" }]
}
```

   `shot_type`: `ews ws ls fs ms cu ecu ots pov insert aerial overhead unset`. `camera_move`: `static pan tilt dolly truck crane handheld zoom-in zoom-out orbit push-in pull-out whip-pan unset`. Use `unset` when the text doesn't say. Unknown fields and unknown names are refused. Fixtures: `../breakdown/__fixtures__/proposal-adapt.json`, `proposal-direct.json`.
6. **Apply, tag, lint** (B and C; on A import the same functions and pass the project read from the artifact database):
   - `cli.ts apply --project <folder> --proposal <file>`: checks the proposal, builds the units, **lints, and writes `akuko.json` only if lint has no errors**. If it prints errors (a shot over 10 s, three principals in frame), **fix the proposal** (split the shot, move a character out of frame) and apply again; nothing was written.
   - `cli.ts tag --project <folder>`: appends `[[sc<N>_sh<M>]]` to the script paragraph each shot came from (to `script/source.md` on the direct route). A shot whose paragraph cannot be matched with confidence is **left untagged and listed**; it is never guessed. A tag that is already somewhere else is never moved: it is reported as a conflict. Several shots from one paragraph sit side by side.
   - `cli.ts lint --project <folder>`: shots plus tags. Warnings are shown to the person; errors are fixed.
7. **Stop at the review gate.** Every new unit is `pending-review` and `stages.breakdown` is `in-review`. Report: the shot count and total running time, the checklist, **which shots could not be tagged and why**, and any lint warnings. Say the person reviews the shots (one at a time on the board) and that sketch opens when breakdown is approved. Don't start the sketch.

## Step 6 on its own (tag only)

When shots exist, run only `cli.ts tag` and `cli.ts lint`. Report what was tagged, what was already tagged, what was left untagged and why, and any conflict, **by shot id**. A partial tagging the person knows about is fine; a partial one presented as complete is not. Re-running on a fully tagged script changes nothing.

## Changing a shot later

A person sends a shot back (`needs-rework`): revise only that shot's fields, add a comment `Revised: …`, set it to `pending-review`. If a shot must be split, give the new shot the next free number in the scene or a letter (`sc3_sh2A`, `insertedShotId()`), so the other shots keep their ids and their tags. Never renumber.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- Free stage: no provider call, no spend gate. Don't generate images or video here.
