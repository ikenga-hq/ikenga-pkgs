---
name: motion
description: Turn key frames into clips or HTML scenes.
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/motion.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - network
  - secrets
  - sidecar
  - chat
---

# action: `motion` — turn approved key frames into clips

**Loaded when**: every stage through the key frames is approved and the user runs `/akuko motion`.

**Reads first**: `../lib/state.md` (§5 motion, §Status transitions, §Decision folding), `../lib/hosts.md`, `../lib/spend.md`, `../lib/providers.md`.

**Stage**: `motion` (5) · **paid** (spend gate before every generation; video is priced per second) · free with the manual provider. Never approves.

**What is judgement and what is code.** Which clips exist, the start frame, the length, the prompt text, the job id, the retry count and every status move are code in `../motion/` (tested). Yours: the **audit** of each clip before it goes to review, what to tell the person, and handing the person the right thing at each gate. **Never write a status or an id yourself, and never call a provider directly: only `gate.run()` does.**

HTML scenes (titles, graphics) are not part of this action yet. This action makes image-to-video clips only.

## Treatments: which shots get a paid clip

A shot's `treatment` decides its motion (`../motion/treatment.ts`, defined once). **Paid treatments are opt-in.** A shot with no `treatment` gets the default for its tier:

| Tier | Default treatment |
|---|---|
| A | `still-move` (a hero candidate: flagged, never made paid by default) |
| B | `still-move` |
| C | `still` |
| none | a hand-made project: today's behaviour, a clip for every shot. A shot **imported from a sheet** with no (or an unreadable) tier is `still`: never a paid clip by accident (`plan` lists them) |

`plan` makes a `<shot>_clip` unit only for `video` shots, and for shots with no tier and no treatment. `still`, `still-move` and `lipsync` shots get none, and the stage never waits on them. Shots removed from the shot list are skipped.

**`treat` is the person's choice.** `node --experimental-strip-types ../motion/cli.ts treat --project <folder> --shot <id>[,<id>...] --as still|still-move|video|lipsync` records it. It is free, but **run it only on the person's own words** ("make S02-030 a video shot"): never promote a shot to `video` or `lipsync` because it is tier A, looks important, or has a spoken line. You may *say* a tier-A shot is a hero candidate or has a spoken line (a lip-sync candidate), and ask. **Nothing is ever deleted.** Moving a shot away from `video` keeps its planned clip whatever state it is in (a file, a paid attempt, a pending spend, a comment) and marks it idle ("planned clip kept, idle while the shot is `<as>`"). An idle clip is never a candidate for a paid job (an explicit `--units` on it is refused: "treat it `video` first"), never holds the stage back, and `status` shows it as "kept, not a video shot". If the shot goes back to `video`, `plan` reuses it. `plan` and `status` also print the candidate flags ("S02-030: tier A, spoken line, a lip-sync candidate; the person decides"); say them to the person and ask, never act on them. When no shot is a video shot, `plan` says so and plans nothing.

**Moves are free.** For `still-move` shots, `moves --project <folder>` lists the camera move parsed from each `motion_note` ("Slow push-in" 1.00 to 1.08, "Slow pull-back" 1.08 to 1.00, "Lateral drift" 40 px at scale 1.06, "Hold" none; anything else is no move, with a warning). `moves --apply` writes them, only onto shots with no `move` yet, and never replaces one. No approval is needed: the person reviews the moves in the editor. Left, right, up and down in a note are the direction the picture drifts in the frame (the schema's sign: negative x is left, negative y is up); a focus pull is not a move; a `still-move` shot with no note gets a warning and no move. Tell the person about every warning.

## The technique

One clip per shot, made one shot at a time. The start frame is the shot's **approved key frame**; the prompt is the shot's own written action, camera and camera move. Nothing is invented: a shot with no written action gets only small natural movement. A shot with no duration is refused (set one on the shot).

## Where the stage is tracked

The unit is one planned asset per shot (`sc1_sh1_clip`, kind `clip`), owned by the shot. The shot and its key frame are never touched. A person approves a clip on the board (a decision, folded); folding is the only thing that writes `approved`. See `../lib/state.md` §5.

## Steps

All commands: `node --experimental-strip-types ../motion/cli.ts <command> --project <folder>` (B and C: the command line uses the local folder host). On host A, Node may run in claude.ai's workspace but the project lives in the board artifact's database (`../lib/hosts.md`): import `plan.ts` and `run.ts` and pass them the `ClaudeArtifactHost` and a gate built with `guardedGate()` from `../rules/guard.ts` (never a bare `createSpendGate`, so the project rules are checked), not this command line. Paid providers are still refused on host A, so use the manual provider and the rules in `../lib/spend.md` §Host A.

0. **Fold decisions first** (`../decisions/cli.ts fold`). Tell the person what the report says, including every rejected decision. If the stage is locked, say which earlier stage is waiting and stop.
1. **`plan`**: one planned clip per shot. Safe to repeat. It also lists any shot already at the retry limit.
2. **`status`**: one line per clip with what it waits for (a shot whose key frame is not approved is `blocked`), its paid attempts and the money spent on it.
3. **Choose the provider** (config and the person decide, not you): `manual` (free; hosts A, B, C) or `fal-video` (paid direct API; hosts B and C only, refused on A; key `FAL_KEY`). A paid provider needs its key and a budget cap from `/akuko setup`. A missing key is reported as a setup problem before anything is estimated, sent or counted; a missing budget is refused with the setup pointer.
4. **`step --provider <id>`** makes the next job, by default **one shot**:
   - **Paid:** it prints the spend line with the arithmetic (for example `5 s x 0.07 USD/s = 0.35`). **Show it to the person and wait.** Nothing has been sent. The person approves on the board (or replies in the exact words of the line, `approve <amount> <CURRENCY>`); fold, then run `step` again. It then runs, records the clip and marks it `pending-review`. A declined spend sends nothing. `--scene <id>` or `--units a,b` batches several clips into one job with one approval for the total, only if the person asks.
   - **Manual:** it prints the prompt package (the prompt, the start-frame file to attach, the length, the camera, the name to save as) and saves the job. Give it to the person. They bring the clip back by attaching it or dropping it in the folder: `ingest --job <id> --unit <clip id> --file <path> [--actual <cost they report>]`. No key or budget is needed.
5. **Say what the command told you.** The `fal-video` models make only 5 or 10 s clips. By default the clip **covers the shot**: the shortest length that is at least as long (a 6 s shot gets a 10 s clip, a 5 s shot a 5 s clip), because a short clip cannot be stretched in the editor while a long one is trimmed there. The spend line shows what is billed beyond the shot ("10 s billed for a 6 s shot"). If the person wants to spend less, `--fit nearest` takes the closest length instead (a 6 s shot gets 5 s); tell them it can be shorter than the shot. A shot longer than the model's longest clip gets the longest, and the command says so. Also pass on that sound is off. Do not choose `--fit nearest` yourself.
6. **Audit each clip** before telling the person it is ready: it starts from the key frame, characters and place do not change, the motion matches the written action and camera move, no morphing, no text. If one fails, say what is wrong and offer another try (paid: a new approval, and it counts against the limit below). Do not hide a bad clip.
7. **Stop at the review gate.** Everything made is `pending-review` and the stage is `in-review`. The person reviews each clip on the board. Don't call anything approved.
8. **After the person's answers**: fold, `sync`, then `step` again for the next shot.

## When a clip is still running: `collect`

A paid job is saved as soon as it is submitted. If `step` ends with "still running" (the provider has not finished, or reading or downloading the result failed for now), the money is reserved and nothing is lost: run `collect --job <id>` (the id is in the message; it is safe to repeat) until it finishes, then tell the person the clips are ready for review. Do not run `step` again for it. If `collect` keeps failing with the same message, stop and tell the person what it says.

## After a failed run

If a run fails (the provider refused it, the request failed, no clip came back), **tell the person what failed, in the command's words, and get their go-ahead before running `step` again.** Running it again retries the same job under the approval the person already gave, with no new spend line, so the person's go-ahead is the only check left. A batch (`--scene` / `--units`) can partly fail: the clips that were made are recorded and billed, and the command prints `NOT MADE: <clips>`. Those stay draft and were not billed. Tell the person which, and only if they agree run `step` for them: that is a new job with its own spend line and approval.

## Sound

Clips are made **silent** by default; sound has its own stage. If the person asks for the model's own sound, pass `--audio`. It costs more (a different price in config), it changes the job, so it needs a fresh approval, and not every model has it (the command says so). Do not turn it on yourself.

## The retry limit

Video is priced per second, so a retry loop is where money goes. Each shot may have **3 paid attempts**. An attempt is a call that **cost money**: a finished clip at its price, or a failed call that reports a cost. A call that never reached the provider (no key, a rejected request, a refused frame) is not an attempt and nothing is said to have been spent on it. Manual takes do not count. The 4th is refused: the message gives the count and the money already spent on that shot. **Stop and tell the person** both numbers. Pass `--max-attempts <n>` (one more than the count, for one more try) **only if the person asked for more tries in their own words**. Never raise it on your own to get past a refusal, and never because a clip looks bad to you.

## When a person sends a clip back

Folding turns it into `needs-rework` with their words. Run `step --units <clip id>` for it: the old file is cleared (it stays stored; the "Revised: ..." comment says where), their words are added to the prompt, the new take fills the same asset (job `..._r<n+1>`), and it goes to `pending-review` again. A paid regeneration needs a new approval and counts toward the limit.

## Rules check

When the project has `rules` (`../lib/state.md` §"Rules guard (WP-26)"), every job is checked against them before the spend gate: banned terms (not in the negative prompt) and required text in the clip prompt (it carries the shot's own `prompt`), and for a paid job the start frame by its content hash. An approved key frame that akuko generated passes; a key frame brought back by hand is an outside file and needs its sha256 in `rules.uploads.allow`. This stage sends the shot's `negative` (when it has one), so a `require` rule on the negative prompt is checked against it. A breach prints `Refused (rules-breach): …`, naming each rule and the offending text or file; `rules-missing` means `rules.required` is set but no rules are recorded. Nothing was priced, sent or spent, and a refused job is not a paid attempt. **Tell the person what it says and stop.** Don't reword a prompt, swap the start frame or edit `rules` to get past it: the person decides. Before a paid run, run the free preflight, `node --experimental-strip-types ../rules/cli.ts check --project <folder>`, and show the person anything it lists.

## Limits to know

- `fal-video` makes clips of fixed lengths (5 or 10 s), takes the key frame as its only start frame and follows the key frame's own aspect ratio. A shot longer than 10 s gets a 10 s clip and needs another clip or a cutaway.
- A key frame that is a local file goes to fal inline, as a base64 data URI. fal documents no limit for data URIs, but a very large PNG may be rejected; if a clip is refused for that reason, tell the person and make the key frame smaller rather than retrying.
- A clip a provider refuses or fails stays `draft`; say so, and nothing is recorded as made.
- A key frame that changes after a clip was made from it is not flagged yet; if the person sends a key frame back, ask whether its clip should be redone.
- Changing the model, length or sound is a new job and needs a new approval.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person; every generation goes through `gate.run()`.
