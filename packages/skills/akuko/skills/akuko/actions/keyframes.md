---
name: keyframes
description: Render final key frames from sketch panels and bible refs.
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/keyframes.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - network
  - secrets
  - chat
---

# action: `keyframes` — render final key frames from sketch panels and bible refs

**Loaded when**: every earlier stage is approved (breakdown, sketch and bible) and the user runs `/akuko keyframes`.

**Reads first**: `../lib/state.md` (§4 keyframes, §Status transitions, §Decision folding), `../lib/hosts.md`, `../lib/spend.md`, `../lib/providers.md`.

**Stage**: `keyframes` (4) · **paid** (spend gate before every generation) · free with the manual provider. Never approves.

**What is judgement and what is code.** Which key frames exist, the references each gets, the prompt text, the job id and every status move are code in `../keyframes/` (tested). Yours: the **audit** of each frame before it goes to review, what to tell the person, and handing the person the right thing at each gate. **Never write a status or an id yourself, and never call a provider directly: only `gate.run()` does.**

## The technique

One frame per shot, made one shot at a time. Each is generated against the **approved** bible images of what is in it (plan E-3): the turnaround of each character in frame, the plate of the location, and the lookbook. The sketch board's composition goes in as **text** (thirds and size from the shot's blocking), because the sketch panel is an SVG and the image providers do not accept SVG. If the shot has no blocking the prompt says so; do not invent any.

**What the prompt carries, and what it doesn't:**

- **The look is the shot's own.** The `Look` line names only the style entries the shot's `refs[]` names (on an imported sheet, its lighting code and the house style), or every style entry if it names none. It never carries the film's other lighting looks. A style whose wording the shot's own prompt (the `Director's note`) already holds is named once ("L-WARM (worded in the director's note)"), not repeated. "Use for:" notes are scheduling and stay out.
- **The lookbook is attached only with a location plate.** A lookbook is a picture of some place. With a plate, the plate fixes the room and the lookbook is labelled "for light, palette and grain only; do not copy its room, objects or people". With no plate (a close-up of fabric, a blurred memory, a shot with no location), no lookbook image is sent: the look goes in as text only (`Look (no lookbook attached; from this text only)`), and the frame does not wait for the lookbook. Why: given a lookbook as the only picture of a place, the model paints that place, and sometimes invents people in it (E01: the lookbook's room and its furniture appeared in frames that had no location, along with people who are not in the film). A label alone does not stop that reliably.
- **Things to avoid are the shot's `negative` merged with the film's** (every style entry's `Negative prompt:` note, the house style's on an imported sheet), with repeats dropped. So a term added to either reaches every frame as `Avoid: …`. Removing a term takes it out of both: on an imported sheet, edit the sheet's NEGATIVE and re-import (that rewrites the shots and the house style).
- **A frame of another frame (`source_frame`).** When a shot shows the same picture as another shot (say a later shot shows the first one's picture as a printed photograph), set `"source_frame": "<that shot's id>"` on the shot in `akuko.json`. A sheet re-import keeps it. The other shot's **approved** key frame is attached (role `frame`) and the prompt says to show that same picture, changing only what the action says. Until a person has approved that frame, this one is `blocked`, waiting for `<id>_keyframe`. A chain is fine (a third shot can name the second); a loop, or an id that is not a shot, never becomes ready, and `doctor`'s integrity check names it. The take is stamped with the source frame, so if the source is later sent back or replaced, `status` flags this frame as made from a superseded reference.

## Layout from a 3D blockout

**When it helps.** When the same room or place recurs across shots and the frames disagree about it (the bed moves wall, the door changes side, a lamp comes and goes, a figure is twice the size it was), the image model is inventing the space each time. Text blocking and a location plate don't fix that: the plate shows the room from one angle, and the model rearranges it for every other camera. A layout fixes the space: build the place once as a plain 3D blockout, put one camera per shot, render one still from each, and give each shot its render. Its key frame is then made from the render in one of three modes (below), chosen per shot or per step.

**The blockout lives in the project, not the skill.** It is the film's own material: for example, a Blender script in the film's folder builds the set (`blender --background --python <script>`) and writes one render per shot. akuko has no 3D code and never runs Blender; it only records and sends the renders. Keep the blockout plain: untextured grey surfaces, simple box or capsule stand-ins for people (grey or blue), the shot's lens and framing, no lighting style. Anything the render shows besides position (a colour, a material) the model may copy. **For mode two-step, model the set dressing in the blockout.** Its step 1 attaches no plate, so the room is only as detailed as the blockout: what isn't modelled isn't there. In E01 the result looked bare until the room's fixed details were modelled. This matters most for a shot whose location plate carried the look of the place (a location in its `refs`): with a layout the plate is not attached, and only its description goes in, in words.

**Set a shot's layout** (B and C):

```
node --experimental-strip-types ../keyframes/cli.ts layout --project <folder> --shot <shot id> --file <render.png> [--from "<what made it>"]
```

It checks the file is a PNG, JPEG or WebP by content, stores a copy through the host (`refs/<shot>_layout.png` on B and C), and records `shot.layout = { uri, sha256, mime, from, set_at }`. Setting the same bytes again changes nothing; a new render replaces the record (the old file stays). `--clear` in place of `--file` removes it. A sheet re-import keeps it, as it keeps `source_frame`. On host A, call `setLayout(host, shot, file, { now, from })` from `../keyframes/layout.ts` with the host adapter.

**Layout modes.** How a key frame uses its shot's layout is a choice. Nothing changes for anyone who doesn't make it: the default is `attach`, what a layout always did.

| Mode | What is sent | Generations per take | When it fits |
|---|---|---|---|
| `attach` (default) | one job: the layout **first** (role `layout`), then the turnarounds, plate and lookbook as usual; the prompt says to keep the layout's camera, composition and every position and size, and to take only the look from the other pictures; the plate's note says "for the look of the place only" | 1 | cheapest; fine when the other pictures don't fight the layout. In E01 they did: with the shot's finished frame or other pictures of the place attached, the model copied those and ignored the blockout (3 of 3) |
| `two-step` | the layout restyled alone, then each character put on model (below) | 1 + characters in frame | when the space must hold (the room keeps shifting between shots); costs more generations, and the blockout must carry the set dressing |
| `off` | the layout is ignored: the job is built as if the shot had none | 1 | to compare, or when the layout is wrong for this take |

Choose it per shot with `layout --shot <id> --mode attach|two-step|off` (stored as `layout.mode`; `--mode` alone changes only the mode, and a new render keeps it), or for one job with `step … --layout-mode attach|two-step|off` (it overrides every shot's own mode in that job). `status` shows, for a key frame still to make, its mode and how many generations that is; the job's label, which the spend line and the allowance line print, ends with the mode and the generations ("…; layout two-step, 2 generations"). A take made with `off` is reported as made without the layout the shot has.

**Mode two-step, the steps** (`layoutStepPlan` in `../keyframes/plan.ts`):

1. **Restyle.** The layout is the **only** picture. The prompt says to restyle this plain 3D blockout into the finished frame, keep the camera, the composition and the position and size of every wall, object and figure exactly, change only materials, light and style, and add and move nothing. Then, in words: what each shape is (the shot's action, the sketch board's blocking when it has any, each character's and the location's description), the look (the shot's styles and the house style, as text), the director's note, and the negative prompt. No turnaround, plate, lookbook, source frame or supplied picture is attached.
2. **Identity, one step per character in frame** with an approved image (their turnaround, their portrait if they have none). Each step attaches the result of the step before **first**, then that character's image, and says: keep everything in the first picture exactly; change only that character so they are the character on the sheet; use the sheet for identity only, not its layout, background, labels or multiple views; they appear once. A shot with no character image has no identity step: the restyle is the take.

**Why.** Tested in E01 with image-reference generation (no depth or ControlNet): the layout with the shot's finished frame, or with other pictures of the place, reproduced those pictures and ignored the blockout (3 of 3). The layout alone was followed closely, but the face was generic. An edit of that result with the turnaround put the character on model and kept the composition: that is the frame the person approved.

**What two-step costs.** One generation per step: **1 + the number of characters put on model** (2 for a shot with one character, 3 with two). The take is the last step's file. The earlier steps' files are kept on the take (`layout_steps`) so `status` and the audit can say what it was made from; they are not units and nobody reviews them. A shot whose own mode is two-step does not wait for its plate or lookbook (they are not attached), only for its characters' images (a `--layout-mode attach` on such a shot is refused until they are approved). A two-step shot with a paid provider is always a job of its own, never batched with other shots in a `--scene` step.

- **A paid provider** (`step --provider gemini-image …`): each step is its own job (`<take job>_s1`, … , the last one is the take's job `<take job>`) with its own `pending_spend` entry. The first `step` prices every step at once and prints one spend line: the number of generations in all, the total, and one "approve <amount> <CURRENCY>" per step. Put it to the person; nothing is sent until every step is approved, then they run in order, each recorded in the ledger as it finishes. If a later step fails or is refused, the earlier steps stay made and in the ledger; run `step` again and it starts at the next step (the step that failed keeps its approval). A new layout, or another provider or model, starts again at step 1. On host A each step is reserved and sent on its own (`--phase reserve`, then `send`, per step).
- **The manual provider and connected tools** (Canva on claude.ai): one package prints every step in order and says which step needs which result. Bring back the **last** step's file with `ingest --file <last>`, and the earlier ones with `--step-files <step 1>[,<step 2>…]` (in order; they are kept on the take). For a connected tool, `step --provider manual --allowance canva` also prints the allowance line with **every** generation counted (a one-character shot is "approve 2 canva generations") and the record command with the count per unit (`--units <key frame>:2`). Ingest with `--via canva` warns if the ledger records fewer generations for the job than the steps took.

**The rules guard.** A layout is a file you made, not a person's upload and not a generation, so it is not added to `rules.uploads.allow`: you don't ask the person to allow each render. Its record on the shot is its provenance, and it is hash-checked every time: a paid job sends it only while the file's bytes still match the recorded sha256 (a changed file is refused as `layout-changed`, a missing one as `uploads`), and only for its own shot. It is accepted for a `never_from_photo` character, because it shows a box, not a person. **Never set a photo, a frame from another film, or any picture of a real person as a layout**: the guard trusts the record, so that rule is yours to keep. An earlier step's file (`<key frame>_step<n>`) is sent on only for its own key frame, only when the ledger shows the generation that made it, and only while its bytes match the sha256 recorded when it was made (else `generated-changed`). A required-text rule (`rules.require`) applies to the prompt of each paid step job; the identity prompt is short and carries none of the shot's text, so a shot under such a rule is refused at that step: tell the person, who decides.

**After a layout changes.** Changing or removing a shot's layout never moves a status, the same as replacing a bible image: an approved key frame stays approved. Each take is stamped with the layout it was made from, so `status` says "made from its layout", "made from an earlier layout" (and lists `<shot>_layout` as superseded), or "made without the layout the shot now has", and the continuity audit reports the last two. Tell the person; only they send a frame back. The shot itself (approved at `sketch`) is not touched: the layout is an input to its key frame, not part of the shot's reviewed text.

**Look at the result against the layout** when you audit the frame: the camera, the size and place of each object and figure, that no grey box or blockout surface is left in the picture, that each character appears once and is on model, and that the room is not barer than the plate (if it is, the blockout needs more set dressing).

## Where the stage is tracked

The unit is one planned asset per shot (`sc1_sh1_keyframe`), owned by the shot. Shots stay approved at `sketch` and are never touched. A person approves a frame on the board (a decision, folded); folding is the only thing that writes `approved`, and when the last frame is approved the stage is `approved` and motion opens. See `../lib/state.md` §4.

## Steps

All commands: `node --experimental-strip-types ../keyframes/cli.ts <command> --project <folder>` (B and C). Paid image providers: `gemini-image` (`GEMINI_API_KEY`), `fal` (`FAL_KEY`) and `byteplus-image` (Seedream on BytePlus ModelArk, `ARK_API_KEY`, up to 14 references, or 10 on 5.0 flash).

**On host A** the project lives in the board artifact's database; with the manual provider follow the same steps, reading and writing the project with the host adapter (`../lib/hosts.md`). A paid direct image API runs there only under R-11, in the order of `../actions/motion.md` §Steps "On host A" with `../keyframes/cli.ts` in place of the motion command (probe, disclose, pasted key; `--phase reserve`, save to the board, `--phase send`, save the result; `../lib/spend.md` §Host A). Making the frames with a connected tool that uses the person's plan allowance (Canva on claude.ai) is not free: before **each wave**, post the allowance line and wait for the exact OK, record every generation with zero money and a units count, and keep Canva's own confirmations for the person to answer (`../lib/spend.md` §Allowance). One frame per wave by default, so 12 key frames are 12 OKs unless the person asks for a scene at a time. The audit below has its own host A paragraph.

0. **Fold decisions first** (`../decisions/cli.ts fold`). Tell the person what the report says, including every rejected decision. If the stage is locked, say which earlier stage is waiting and stop.
1. **`plan`**: one planned key frame per shot. Safe to repeat.
2. **`status`**: one line per frame with what it is waiting for. A frame `blocked` on a bible image means that image is not approved yet (or `sync` has not run: `../bible/cli.ts sync`). If a line says "made from a superseded …", tell the person the frame was made from a reference that has since changed and that they may want to send it back. Never regenerate or change it yourself.
3. **Choose the provider** (config and the person decide, not you): `manual` (free; hosts A, B, C), `gemini-image` or `fal` (paid direct API; hosts B and C only, refused on A). A paid provider needs a budget cap from `/akuko setup`; without one the command says so and stops.
4. **`step --provider <id>`** makes the next job, by default **one shot**:
   - **Paid:** it prints the spend line. **Show it to the person and wait.** Nothing has been sent. The person approves on the board (or replies in the exact words of the line, `approve <amount> <CURRENCY>`); fold, then run `step` again. It then runs, records the file and marks the frame `pending-review`. A declined spend sends nothing. `--scene <id>` or `--units a,b` batches several frames into one job with one approval for the total, if the person asks for that.
   - **Manual:** it prints the prompt package (the prompt, the reference files to attach, the name to save as) and saves the job. Give it to the person. They bring the file back by attaching it or dropping it in the folder: `ingest --job <id> --unit <asset id> --file <path> [--actual <cost they report>]`. After an ingest, look at the frame against the bible; flag each clear problem (`review/flags.ts add`) and put it to the person in chat at once (`actions/review.md` §3b "In chat").
5. **Audit each frame** before telling the person it is ready: the characters match their turnarounds (face, hair, clothing), the place matches the plate, the look matches the lookbook, the framing follows the blocking, no stray text or labels, no duplicated figures. If one fails, say what is wrong and offer another try (paid: a new approval). Do not hide a bad frame. Once several frames exist, run the continuity audit (section below) before motion.
6. **Stop at the review gate.** Everything made is `pending-review` and the stage is `in-review`. The person reviews each frame on the board. Don't call anything approved.
7. **After the person's answers**: fold, `sync`, then `step` again for the next shot.

## Audit: continuity across all key frames

Run it after key frames are generated (any number of them), and before motion spends money on the shots. It is advisory: it never changes a status, and only a person sends a frame back.

1. **Structural checks (code, free):** `node --experimental-strip-types ../audit/cli.ts run --project <folder>`. For every made frame it checks: made with each character's approved turnaround (portrait if none), the plate and the lookbook; those references are still the approved, current takes (the same check `status` uses); a shot with a layout had its frame made from that layout, not an earlier one or none (`layout`, medium); a character named in the shot is in its refs and so in the prompt; no more than 2 principals in one frame; one provider and model per scene; the lookbook matches the shot's style. Host A: see the host A paragraph at the end of this section.
2. **Look at each frame yourself (free):** open the key frame next to the turnaround, plate and lookbook it was made from, and its layout when the shot has one (positions, sizes, camera; no blockout left in the picture) (Claude Code reads the image files; on claude.ai they are in the artifact store). Check face, hair, build, clothing, the place and the light. For each problem, record it: `audit/cli.ts record --project <folder> --unit <asset id> --finding "<what differs>" --severity low|medium|high`. These are **your notes, never the person's decision**. Do not use a paid vision provider.
3. **Run `run` again** to publish: it writes `board/audit.json` and `board/audit.md` and puts each finding on the frame as an "Audit: ..." comment from the agent, so it shows on the board's thread. Re-running replaces the audit's own comments and never touches a person's. A note recorded on an earlier take of a regenerated frame is left out; look at the new take.
4. **Tell the person** what it found, high first, with the suggestions ("send back sc2_sh3: hair colour differs from the turnaround"). The person decides on the board: **send back** the frames that matter (the normal `needs-rework` flow below), or approve a flagged frame if they are happy with it. You never send a frame back, approve one, or regenerate one because of the audit.

**Retracting a note:** `audit/cli.ts record --clear --project <folder> --unit <asset id> [--finding "<text>"]` removes your own notes for that frame (or only the one whose text matches); run `run` again to drop its comment. `run` also drops notes on earlier takes of regenerated frames from `board/audit.json`: it reports how many it dropped, once.

**On host A** (claude.ai): there is no `board/audit.json` and no folder. Read the project with the host adapter (ArtifactData `get` of doc `akuko/project`, `../lib/hosts.md`), keep your visual notes in the conversation, and in the workspace's Node call `auditProject(project, { visual })` from `../audit/audit.ts`, with `visual` as `{ unit, text, severity, take }` notes (`take` is `takeOf(asset)`). Then `applyAuditComments(project, report, now)` gives the project with the audit's comments swapped in; write it back with the host's `writeState` (ArtifactData `set` of `akuko/project`), and show the person `renderSummary(report)` in chat. The workspace cannot call the artifact tools itself, so the read and the write are your tool calls, as in the other actions. If no code can run, read the frames and the references, report what you see in chat only, and write nothing. Notes you do not keep in the conversation are lost with it; the "Audit:" comments are the durable record.

## Continuity rules

Wide shots of one set drift unless the blocking, the set reference and the prop counts are pinned. These hold for any interior or repeated set (example: a one-table café scene). They add to the audit above; none of them changes who approves.

1. **Blocking first.** Each interior frame uses the Blender blocking render as Image 1: "keep camera, framing, object positions and counts; add nothing". Anything that recurs in the background (staff, counter props, plates, lamps) goes into the blockout, never into prompt-only edits.
2. **The set reference must show the layout.** Attach one clean "hero" frame of the set, such as the empty table, as the reference for furniture and props. Close-ups only fix the look, so wide shots drift: extra placemats, a second chair, a longer table. Name counts in the prompt: "exactly two slate placemats, one napkin holder, one armchair, no other tables or chairs".
3. **Set geography.** Record in the location bible what sits behind each character from each side (example: the booth and mural are behind the first character; the window wall is behind the second). Check every still against it. For a shot facing a wall, say which landmarks are NOT in frame, or the model moves them onto that wall.
4. **Edit, don't regenerate.** To fix an approved frame, edit that still with a minimal prompt: "ONE change only… keep everything else exactly", plus "do not brighten or relight". Attach the reference for the missing thing (for example the shot that shows the napkin holder). The same goes for a new shot from an angle that already has an approved clip: its start still is an edit of that clip's last frame, changing only the action, not a fresh generation from the blocking and references (`motion.md` §Same-angle continuity chain). In one run this held the set, props and faces across eleven shots in a row.
5. **If the model copies the reference image wholesale,** attach only a tight crop of the element to add (the waitress, the food) and say it is "only a reference for X".
6. **Audit checklist for every frame before asking for approval:**
   - prop count and presence (placemats, holder, handbag, plates);
   - the background wall on each side;
   - no second table or chair;
   - light matches its neighbours;
   - recurring facial traits (beard length, glasses);
   - no readable text.

   Show before and after side by side.
7. **Retakes.** Request-changes → fold → `step` for a new job → ingest once. Never ingest twice into the same job.

## When a person sends a frame back

Folding turns it into `needs-rework` with their words. Run `step --units <asset id>` for it: the old file is cleared (it stays stored; the "Revised: …" comment says where), their words are added to the prompt, the new take fills the same asset, and it goes to `pending-review` again. A paid regeneration is a new job and needs a new approval.

## Rules check

When the project has `rules` (`../lib/state.md` §"Rules guard (WP-26)"), every job is checked against them before the spend gate: banned terms (not in the negative prompt, where listing a word is how a prompt avoids it) and required text in the prompt akuko builds, and for a paid job every reference file by its content hash. The approved bible images were generated by akuko and pass (for a `never_from_photo` character only if their recorded hash still matches the file). A picture the person attached to the shot needs its sha256 in `rules.uploads.allow`, allowed for every character and location in the shot, and is refused for a `never_from_photo` character. This stage sends the shot's `negative` (when it has one), so a `require` rule on the negative prompt is checked against it: a shot with no negative, or one missing the required text, is refused. A shot removed from the shot list (`source.removed_at`) is skipped: no key frame is planned for it and it never holds the stage back. A breach prints `Refused (rules-breach): …`, naming each rule and the offending text or file; `rules-missing` means `rules.required` is set but no rules are recorded. Nothing was priced, sent or spent. **Tell the person what it says and stop.** Don't reword a prompt, drop a reference or edit `rules` to get past it: the person decides. Before a paid run, run the free preflight, `node --experimental-strip-types ../rules/cli.ts check --project <folder>`, and show the person anything it lists.

Key frames made with a connected tool on the person's plan (Canva) come back with `ingest … --via canva` after their generations are recorded (`../spend/cli.ts allowance … --job <job>`); they then count as generated (`../lib/providers.md` §Allowance tools).

**Allowing a file (`rules/cli.ts allow`).** `node --experimental-strip-types ../rules/cli.ts allow --project <folder> --file <path> --label "<what it is>" [--for <entry> …]` hashes a file and adds it to `rules.uploads.allow` (a hash already there is refused). Run it **only when the person has said, in their own words, that this file may be used** (and for which entries). Never run it on your own to get past a breach, and never to make an allowance-tool file pass: that is what `ingest --via` is for.

## Limits to know

- **Background characters get no reference image** (the bible plans none for them). If one is in a shot's `refs`, it is named in the prompt text only; look at that figure in the audit and say so if it drifts.
- A frame that cannot be built (for example over 14 references) is skipped and reported with its reason; `step` moves to the next ready frame. Tell the person which frame was skipped and why. Changing the model or provider is a new job and needs a new approval.
- At most **14** reference images per frame (the providers' limit). A frame sends a turnaround per character, a plate and a lookbook, so normally four or fewer. Per-role sublimits (for example 4 character references on a Gemini Flash model) are **not** enforced yet.
- Continuity per frame comes from sending the same approved references every time. Checking it across all frames is the **continuity audit** (above).
- A frame a provider refuses or fails stays `draft`; say so, and nothing is recorded as made. Money a failed call cost is counted against the cap (`../lib/spend.md`).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person; every generation goes through `gate.run()`.
