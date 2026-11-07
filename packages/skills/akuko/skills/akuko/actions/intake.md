---
name: intake
description: "Bring in a story, treatment or screenplay and produce a Fountain screenplay."
domain: content
ux_mode: approve
inputs_schema:
  type: object
  properties:
    source:
      type: string
      description: "Path to the story, treatment or screenplay."
  required: []
  additionalProperties: false
run:
  kind: chat_prompt
  prompt: |
    Load actions/intake.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `intake` — bring in a story, treatment or screenplay and produce a Fountain screenplay

<!-- Stub (WP-02): replaced by WP-04. This action is built; the marker stays only because actions.test.ts looks for it. -->

**Loaded when**: the user starts a project from a source text, or runs `/akuko intake`.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`. Film rules: `../profiles/film/breakdown.md`.

**Stage**: `intake` (0) · free. Never spends, never approves.

**What is judgement and what is code.** The adaptation of prose into a screenplay is yours (steps 4–5). Everything else is code in `../breakdown/`, run through `cli.ts` or imported: creating the project, detecting a screenplay, recording the files, moving the stage. Don't redo the code's job by hand.

## Steps

1. **Host and state.** Detect the host (`SKILL.md` §Every action starts the same way). `readState()`. Fold decisions first (`../lib/state.md` §Decision folding; if `readDecisions()` still throws `NotImplementedError`, say decisions can't be read yet and go on).
2. **Is there a project already?**
   - **No** → continue. Get the film's **title** from the person (or from the source's title line) and offer a one-line logline; both can be changed later. Create it: `node --experimental-strip-types breakdown/cli.ts new --project <folder> --title "<title>"`. On host A, call `createProject()` from `../breakdown/intake.ts` and `writeState()`.
   - **Yes, and `shots[]` is not empty** → stop. The screenplay is now the source of the shots; replacing it would orphan them. Say so and offer `status`, or a new project for a different story.
   - **Yes, intake already in review or approved** → show what is there and ask whether to replace the source. Don't re-adapt silently.
3. **Read the source.** From the path the person gave, or the text they pasted. Save it unchanged as `script/source.md`. Decide what it is with `detectSourceKind()` (`../breakdown/intake.ts`): `fountain` if it has `INT.` / `EXT.` scene headings, else `prose`. A **treatment** is prose.
4. **Choose the route.**
   - **A screenplay** (`fountain`) → route `screenplay`. No question. Save the same text, unchanged, as `script/screenplay.fountain`.
   - **Prose** → **ask every time**, never remembering an earlier answer, with the host's question tool (`AskUserQuestion` on B and C; a plain question on A): *"Adapt this to a screenplay first, or break the prose down directly?"*
     - **Adapt to a screenplay first** — you write a Fountain screenplay from the prose, the person reviews it, and the breakdown then works from the screenplay. Better when the story needs structure, or the person wants a script they can edit. Route `adapt`.
     - **Break it down directly** — no screenplay. The breakdown works from the prose and the shot tags go into `script/source.md`. Faster; nothing to edit but the shot list. Route `direct`.
5. **Adapt (route `adapt` only).** Write Fountain from the prose into `script/screenplay.fountain`:
   - A title page (`Title:`, `Credit:`, `Author:`), then scenes. Each scene opens with a heading on its own line: `INT.` or `EXT.`, a place, a dash, a time (`EXT. RIVER PIER - DUSK`).
   - Action in the present tense, only what the camera can see. A thought or a feeling becomes something a person does, or voice-over (`MARA (V.O.)`).
   - Keep every story event, in the story's order. Keep dialogue **word for word** where the prose has it. **Do not invent** characters, events or dialogue, and no camera directions or shot numbers; that is the breakdown's job.
   - **One visual idea per paragraph**, two or three lines at most, separated by blank lines. Each paragraph can later carry a shot tag.
   - Name a recurring character the same way every time; introduce them in capitals on first appearance (`MARA`).
   - Show the screenplay to the person in the reply (or its path) and say what you chose to leave out, if anything.
6. **Record it.** Write the script files, then record them:
   - **B and C:** write `script/source.md` and (routes `screenplay`, `adapt`) `script/screenplay.fountain` in the project folder, then run `cli.ts intake --project <folder> --route <route>`. Script text is a project document, not a generated asset: the host adapter stores only `akuko.json` and assets, so the files are written directly. The adapter has no text-file method yet; this is a known gap.
   - **A:** `storeAsset()` each file (kind `other`, filename `source.md` / `screenplay.fountain`), then call `completeIntake(project, { route, sourceUri, screenplayUri })` with the `file.uri` each returned, and `writeState()`. The stored assets are what the person reviews.
   - Result: `script.source` (and `script.screenplay`) set; assets `script-source` (and `script-screenplay`) at `pending-review`; `stages.intake` = `in-review`.
7. **Stop at the review gate.** Tell the person what to review (the screenplay, or on the direct route the source as it stands), and that **breakdown opens when they approve intake**. Don't start the breakdown. Offer `status`.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- Free stage: no provider call, no spend gate.
