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

## Import a shot list (the person already has one)

**Loaded when**: the person brings a spreadsheet of shots ("import my shot list"). This replaces steps 1 to 5: **no judgement is needed, so no proposal is written**, and none of the sizing rules apply (the sheet decides each shot's length). Code does all of it, in `../breakdown/import/`:

```
node --experimental-strip-types breakdown/cli.ts import --project <folder> --sheet <xlsx|csv> \
  [--lines <quotes.csv>] [--film-script <md>] [--master <wav>] [--mapping <json>] \
  [--cards-dir <dir>] [--clips-dir <dir>] [--tokens <csv>] [--lighting <csv>] \
  [--fps 24] [--start-tc 00:00:00:00] [--hash] [--title <t>] [--dry-run]
```

1. **Dry run first**: `--dry-run` reads everything, writes nothing, and prints the counts, the parts with their film spans, anything it left out, the warnings, the integrity result and the lint counts. Show it to the person. If the headers differ from the default layout, it says which column it could not find: write a mapping JSON (`--mapping`) naming the headers; anything it leaves out keeps the default. Columns are found **by header name**, never by position. A CSV is the shot sheet alone: pass the tokens and the lighting as CSVs (`--tokens`, `--lighting`).
2. **Then run it without `--dry-run`.** It creates the project if there is none (`--title`, default the folder name). What it writes, all at `pending-review` (**nothing is approved**; only a person approves):
   - **Prompts.** The sheet's "full prompt" column is a formula with no saved value, so each prompt is rebuilt: the shot's own text with `[TOKEN]` expanded from the Tokens sheet, then `", "` and the lighting phrase (by the lighting code), then `", "` and the house style block. A reference shot (its lighting code is `REF`, or its ref moment starts `REF-`) gets no house style; a text that starts with "(" is used as written. `shot.negative` is the NEGATIVE text. Unknown tokens are left as written and listed.
   - **Bible.** Each token is a character or a location whose **id is the token** (`ADA-NOW`); each lighting code is a style whose id is the code and whose description is the phrase; the style block is the `house-style` style (the negative is in its notes). Each has `source`. A shot's `refs` are its characters, then its location(s), then its lighting style, then `house-style`.
   - **Scenes and shots.** The sheet's scene and shot ids are kept (`S11`, `S11-010`), with `part`, `lighting`, `tier`, `framing`, `motion_note`, `film {in_s, out_s}` (from `mm:ss.ss`), `duration_s = out - in`, and `source {kind: "sheet", id, row}`. Gaps between shots are kept; times are never snapped. No `treatment` is set. A part name that is not a valid id is cleaned (`Cold open` becomes `Cold-open`; `partIds` in the mapping renames it). A scene holds one part: if its shots are in two, it keeps the first and says so.
   - **Ready-made rows** (status `n/a`) are `card` assets, `card_<sheet id>`, at stage `export`, with `film`, `source` and a `file` found in `--cards-dir` by the id's words and numbers (`P7-CARD` finds `..._P07_Part-Card.png`) or named in the mapping (`cards.files`). A row whose file is not found is **left out and listed** (a card must have a file): re-run once the file exists.
   - **Lines** (`--lines`, the quotes file) become `audio.lines`, with words from `word_times` and `clip_uri` relative to the project. A line belongs to the shot it **starts in** (a cut mid-line leaves it with the first shot, as a sheet's own lines column does); one that starts in a gap goes to the shot it overlaps most. The sheet's own lines column is cross-checked: a difference is a warning.
   - **Master** (`--master`): `audio.master` with its length and rate read from the WAV header (the samples are never loaded), `uri` relative to the project, `start_tc` (default `00:00:00:00`), `project.fps` (default 24), and `sha256` only with `--hash`.
3. **Re-importing is safe.** Run it again after the sheet changes: rows are matched by sheet id, text and timing are updated, and it prints what was added, changed and removed. It **never** touches status, approvals, comments, assets other than cards, the ledger, or what a later stage added (`treatment`, `move`, lines you did not re-supply). A changed shot that is already approved is flagged in the diff: its approval stands, so tell the person to look at it again. A row that left the sheet is kept and flagged (`source.removed_at`; a shot also loses its film time so it no longer clashes with what replaced it), never deleted.
4. **Lint** (`cli.ts lint`) knows imported shots: no 10 s cap, no 5 s floor, no canonical-id warning, no script-tag warnings. A `SPLIT` note, more than two principals, or a shot that starts before the previous scene ended is a warning; each sheet id missing from the film script is a warning.
5. **Stop at the review gate.** Report the counts, what was left out and why, the warnings, and that **intake is waiting for the person** (the shot list file, and the film script), and that breakdown opens when they approve it. Say that nothing is approved. Don't start the sketch board.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- Free stage: no provider call, no spend gate. Don't generate images or video here.
