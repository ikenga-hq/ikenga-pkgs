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

## Where the stage is tracked

The unit is one planned asset per shot (`sc1_sh1_keyframe`), owned by the shot. Shots stay approved at `sketch` and are never touched. A person approves a frame on the board (a decision, folded); folding is the only thing that writes `approved`, and when the last frame is approved the stage is `approved` and motion opens. See `../lib/state.md` §4.

## Steps

All commands: `node --experimental-strip-types ../keyframes/cli.ts <command> --project <folder>` (B and C). On host A the project lives in the board artifact's database, not in a folder, so there is no `--project` folder: follow the same steps with the manual provider and the rules in `../lib/spend.md` §Host A, reading and writing the project with the host adapter (`../lib/hosts.md`). Making the frames with a connected tool that uses the person's plan allowance (Canva on claude.ai) is not free: before **each wave**, post the allowance line and wait for the exact OK, record every generation with zero money and a units count, and keep Canva's own confirmations for the person to answer (`../lib/spend.md` §Allowance). One frame per wave by default, so 12 key frames are 12 OKs unless the person asks for a scene at a time. The audit below has its own host A paragraph.

0. **Fold decisions first** (`../decisions/cli.ts fold`). Tell the person what the report says, including every rejected decision. If the stage is locked, say which earlier stage is waiting and stop.
1. **`plan`**: one planned key frame per shot. Safe to repeat.
2. **`status`**: one line per frame with what it is waiting for. A frame `blocked` on a bible image means that image is not approved yet (or `sync` has not run: `../bible/cli.ts sync`). If a line says "made from a superseded …", tell the person the frame was made from a reference that has since changed and that they may want to send it back. Never regenerate or change it yourself.
3. **Choose the provider** (config and the person decide, not you): `manual` (free; hosts A, B, C), `gemini-image` or `fal` (paid direct API; hosts B and C only, refused on A). A paid provider needs a budget cap from `/akuko setup`; without one the command says so and stops.
4. **`step --provider <id>`** makes the next job, by default **one shot**:
   - **Paid:** it prints the spend line. **Show it to the person and wait.** Nothing has been sent. The person approves on the board (or replies in the exact words of the line, `approve <amount> <CURRENCY>`); fold, then run `step` again. It then runs, records the file and marks the frame `pending-review`. A declined spend sends nothing. `--scene <id>` or `--units a,b` batches several frames into one job with one approval for the total, if the person asks for that.
   - **Manual:** it prints the prompt package (the prompt, the reference files to attach, the name to save as) and saves the job. Give it to the person. They bring the file back by attaching it or dropping it in the folder: `ingest --job <id> --unit <asset id> --file <path> [--actual <cost they report>]`.
5. **Audit each frame** before telling the person it is ready: the characters match their turnarounds (face, hair, clothing), the place matches the plate, the look matches the lookbook, the framing follows the blocking, no stray text or labels, no duplicated figures. If one fails, say what is wrong and offer another try (paid: a new approval). Do not hide a bad frame. Once several frames exist, run the continuity audit (section below) before motion.
6. **Stop at the review gate.** Everything made is `pending-review` and the stage is `in-review`. The person reviews each frame on the board. Don't call anything approved.
7. **After the person's answers**: fold, `sync`, then `step` again for the next shot.

## Audit: continuity across all key frames

Run it after key frames are generated (any number of them), and before motion spends money on the shots. It is advisory: it never changes a status, and only a person sends a frame back.

1. **Structural checks (code, free):** `node --experimental-strip-types ../audit/cli.ts run --project <folder>`. For every made frame it checks: made with each character's approved turnaround (portrait if none), the plate and the lookbook; those references are still the approved, current takes (the same check `status` uses); a character named in the shot is in its refs and so in the prompt; no more than 2 principals in one frame; one provider and model per scene; the lookbook matches the shot's style. Host A: see the host A paragraph at the end of this section.
2. **Look at each frame yourself (free):** open the key frame next to the turnaround, plate and lookbook it was made from (Claude Code reads the image files; on claude.ai they are in the artifact store). Check face, hair, build, clothing, the place and the light. For each problem, record it: `audit/cli.ts record --project <folder> --unit <asset id> --finding "<what differs>" --severity low|medium|high`. These are **your notes, never the person's decision**. Do not use a paid vision provider.
3. **Run `run` again** to publish: it writes `board/audit.json` and `board/audit.md` and puts each finding on the frame as an "Audit: ..." comment from the agent, so it shows on the board's thread. Re-running replaces the audit's own comments and never touches a person's. A note recorded on an earlier take of a regenerated frame is left out; look at the new take.
4. **Tell the person** what it found, high first, with the suggestions ("send back sc2_sh3: hair colour differs from the turnaround"). The person decides on the board: **send back** the frames that matter (the normal `needs-rework` flow below), or approve a flagged frame if they are happy with it. You never send a frame back, approve one, or regenerate one because of the audit.

**Retracting a note:** `audit/cli.ts record --clear --project <folder> --unit <asset id> [--finding "<text>"]` removes your own notes for that frame (or only the one whose text matches); run `run` again to drop its comment. `run` also drops notes on earlier takes of regenerated frames from `board/audit.json`: it reports how many it dropped, once.

**On host A** (claude.ai): there is no `board/audit.json` and no folder. Read the project with the host adapter (ArtifactData `get` of doc `akuko/project`, `../lib/hosts.md`), keep your visual notes in the conversation, and in the workspace's Node call `auditProject(project, { visual })` from `../audit/audit.ts`, with `visual` as `{ unit, text, severity, take }` notes (`take` is `takeOf(asset)`). Then `applyAuditComments(project, report, now)` gives the project with the audit's comments swapped in; write it back with the host's `writeState` (ArtifactData `set` of `akuko/project`), and show the person `renderSummary(report)` in chat. The workspace cannot call the artifact tools itself, so the read and the write are your tool calls, as in the other actions. If no code can run, read the frames and the references, report what you see in chat only, and write nothing. Notes you do not keep in the conversation are lost with it; the "Audit:" comments are the durable record.

## When a person sends a frame back

Folding turns it into `needs-rework` with their words. Run `step --units <asset id>` for it: the old file is cleared (it stays stored; the "Revised: …" comment says where), their words are added to the prompt, the new take fills the same asset, and it goes to `pending-review` again. A paid regeneration is a new job and needs a new approval.

## Rules check

When the project has `rules` (`../lib/state.md` §"Rules guard (WP-26)"), every job is checked against them before the spend gate: banned terms (not in the negative prompt, where listing a word is how a prompt avoids it) and required text in the prompt akuko builds, and for a paid job every reference file by its content hash. The approved bible images were generated by akuko and pass (for a `never_from_photo` character only if their recorded hash still matches the file). A picture the person attached to the shot needs its sha256 in `rules.uploads.allow`, allowed for every character and location in the shot, and is refused for a `never_from_photo` character. This stage sends the shot's `negative` (when it has one), so a `require` rule on the negative prompt is checked against it: a shot with no negative, or one missing the required text, is refused. A shot removed from the shot list (`source.removed_at`) is skipped: no key frame is planned for it and it never holds the stage back. A breach prints `Refused (rules-breach): …`, naming each rule and the offending text or file; `rules-missing` means `rules.required` is set but no rules are recorded. Nothing was priced, sent or spent. **Tell the person what it says and stop.** Don't reword a prompt, drop a reference or edit `rules` to get past it: the person decides. Before a paid run, run the free preflight, `node --experimental-strip-types ../rules/cli.ts check --project <folder>`, and show the person anything it lists.

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
