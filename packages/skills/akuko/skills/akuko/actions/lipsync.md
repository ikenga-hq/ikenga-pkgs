---
name: lipsync
description: Lip-sync a shot's spoken line onto its approved key frame.
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/lipsync.md from the akuko skill and follow it.
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

# action: `lipsync` — make a shot's speaker say its line

**Loaded when**: the motion stage is open (every stage through the key frames approved), a shot's treatment is `lipsync` (or `video` with a spoken line), and the user asks for lip-sync.

**Reads first**: `../lib/state.md` (§5 motion, §"Real projects", its `#### Lip-sync step (WP-28b)` and `#### Rules guard (WP-26)`), `../lib/providers.md` §"The fal lip-sync provider", `../lib/spend.md`, `../lib/hosts.md`.

**Stage**: `motion` (5) · **paid** (spend gate before every lip-sync; priced per second of the line) · free with the manual provider. Never approves.

**What is judgement and what is code.** Which shots get a lip-sync, the line audio (which file, the cut, the 16-bit copy), the model, the job id, the retry count and every status move are code in `../lipsync/` (tested). Yours: telling the person what each command said, putting the spend line (with the files it uploads) in front of them, and looking at the result before it goes to review. **Never write a status, an id, a treatment or `rules` yourself; never call a provider directly: only `gate.run()` does.**

## The technique

One lip-sync per shot, one shot per job. The picture is the shot's **approved key frame** (image mode). The sound is the shot's **spoken** line, as a 16-bit PCM WAV:

1. the line's own clip (`audio.lines[].clip_uri`), as it is, when it is a 16-bit PCM WAV that can be read (a clip in another WAV format is copied to 16-bit first);
2. else a slice of the master (`audio.master`), from 0.2 s before the line to 0.3 s after it, kept inside the shot.

A shot with several spoken lines gets **one** slice of the master covering all of them (clips can't be joined without the gaps between them). Thought lines need nothing. A shot whose treatment is `still` or `still-move` never gets a lip-sync; only the person changes a treatment.

Clip mode (lip-syncing an approved video clip) is not used yet: fal would need the clip uploaded through its CDN, which akuko doesn't do yet. The provider's model is chosen from the line's **measured** length (`chooseLipsyncModel`): a line of 5–15 s gets the default model, a shorter or longer one the fallback.

## Where the stage is tracked

- `<shot>_lipsync` (kind `lipsync`, stage `motion`, owner = the shot): the video, reviewed on the board like a clip.
- `<shot>_linecut` (kind `vo`, stage `motion`, provider `akuko-cut`): the cut line audio, in `lipsync/cuts/`. It is recorded `pending-review`. **The board has no audio player**: the person listens by opening the file itself, `lipsync/cuts/<shot>_linecut.wav` (give them the path), then approves or sends it back on the board. **Every line cut must be approved before the motion stage can be.** Its approval is not what lets the lip-sync run.
- A lip-sync whose shot **no longer asks for one** (the person changed its treatment, or its spoken line went away) is kept, never deleted. `plan` and `status` list it as "no longer asked for (treatment …); kept", and nothing is cut, priced or made for it. It is **idle**, like its line cut: shown, never counted, and it does not hold the motion stage open.
- The stage state is motion's one roll-up (`../motion/stage.ts` `refreshMotionStage`), whichever step ran last.

## Piloting one part first (`--part`)

`plan --part P7`, `status --part P7` and `step --part P7 …` work on one part only, once its own key frames and the bible entries they use are approved (motion's rule: `../actions/motion.md` §Piloting one part first; `motion/cli.ts parts` lists every part). Planning, cutting, pricing and making touch only that part's live shots; paid jobs still go through the rules guard and the spend gate. A part that is not open is refused with what is missing: pass it on and stop. The motion stage stays `locked` until the whole film opens; the part's progress is on its units.

## Steps

All commands: `node --experimental-strip-types ../lipsync/cli.ts <command> --project <folder>`. On host A, import `plan.ts`, `cut.ts` and `run.ts`, pass the `ClaudeArtifactHost` and a gate built with `guardedGate()` (`../rules/guard.ts`); paid providers are refused there, so use the manual provider.

0. **Fold decisions first** (`../decisions/cli.ts fold`). If the stage is locked, say which earlier stage is waiting and stop, unless the person asked to pilot one part (`--part`, above).
1. **`plan`**: plans a lip-sync for every shot that needs one and cuts the line audio each needs (free, local; the master is read once, never loaded whole). Safe to repeat. Pass on everything it prints:
   - which shots were passed over and why (a thought line, no spoken line);
   - which line audio was cut and which clips are used as they are. Give the person the path of each new cut (`lipsync/cuts/…`) to listen to: the board can't play it;
   - which lip-syncs are no longer asked for (kept, nothing done for them);
   - **the master hash.** If `audio.master.sha256` is not recorded, it prints the hash it computed. Tell the person; recording it is their command: `record-master-hash` (it never overwrites a different recorded hash without `--replace`). If the project has rules, slices of the master can be uploaded only when that hash is in `rules.uploads.allow` with `slices: true`; the person adds that entry, not you;
   - a master that no longer matches its recorded hash is refused: nothing is cut. Tell the person the film times may no longer match the file.
2. **`status`**: one line per lip-sync with its lines, what it waits for (the approved key frame, the line audio), its paid attempts and money spent.
3. **Choose the provider** (config and the person decide, not you): `manual` (free; hosts A, B, C) or `fal-lipsync` (paid direct API; hosts B and C only; key `FAL_KEY`; needs a budget cap from `/akuko setup`). A missing key is reported before anything is estimated, sent or counted.
4. **`step --provider <id> [--shot <id>]`** makes the next lip-sync (one shot):
   - **Paid:** it prints the spend line: the arithmetic (`2 s x 0.08 USD/s = 0.16`) **and the files it would upload to fal** (the still and the audio, with where the audio came from). **Uploading the person's audio and picture is their call: show them the whole line and wait.** When the audio is a file outside the project, the line says so: "a file outside the project; check it holds only speech that may leave your machine (line clips can be cut from an unbleeped reference)". **Read that sentence to the person, word for word**, and let them choose: approve, or ask for the master cut instead (`step --from master`, after `plan --from master` has cut it). Nothing has been sent. They approve on the board (or reply in the line's exact words, `approve <amount> <CURRENCY>`); fold, then run `step` again. It then runs, records the video and marks it `pending-review`.
   - **Manual:** it prints the prompt package (the still and the audio to take to their tool). They bring the video back: `ingest --job <id> --unit <shot>_lipsync --file <path> [--actual <cost they report>]`.
   - Leave `--model` out: akuko picks the model that fits the measured line. Name one only if the person asked; a model that can't take the line is refused.
5. **Say where the video belongs.** The lip-sync video starts with its audio, which usually starts a little after the shot does; `step` prints "belongs at <n> s on the master". akuko records that span on the lip-sync as the job starts, and the Resolve handoff places the video there, holding the shot's approved key frame (with its camera move) before and after it. A lip-sync whose audio was the line's own clip has no recorded span (the clip's lead-in is not known): the handoff places it by the lines and says so; tell the person to check its lips in Resolve.
6. **Look at it** before telling the person it is ready: the face, framing and look match the key frame, the mouth follows the line, nothing morphs. If it fails, say what is wrong and offer another try (a new approval; it counts against the limit below). Do not hide a bad take.
7. **Stop at the review gate.** The lip-sync is `pending-review`. The person reviews it on the board. Its own audio is never used: the edit keeps the master for sound.

## Files outside the project folder

A line clip often lives outside the project folder (a media folder next to it). akuko reads such a file **only** when the person names its folder for that run: `--allow-root <folder>` (repeatable) on `plan`, `status` or `step`. **Pass it only with a folder the person named in their own words; never pick one yourself.** It is not remembered: the next run without it does not read that folder (the master slice is used instead, and `plan` says why). A bare `--allow-root` with no folder is refused.

The spend line names the clip it would upload and adds: "a file outside the project; check it holds only speech that may leave your machine (line clips can be cut from an unbleeped reference)". **Read it to the person.** Line clips are often cut from a reference track that was never meant to leave the edit (an unbleeped mix, a guide track), so only the person can say whether that clip may be uploaded. If they would rather not, `--from master` (on `plan`, `status` and `step`, for that run) uses a slice of the master instead of the clip; `plan --from master` cuts it first.

## When it is still running: `collect`

A paid job is saved as soon as it is submitted. If `step` ends with "still running", run `collect --job <id>` (safe to repeat) until it finishes. Do not run `step` again for it.

## After a refusal or a failed run

- `Refused (rules-breach)` / `Refused (rules-missing)`: the project rules refused the job before anything was priced (a banned word in the line, an audio or still file whose hash is not allowed, a slice whose master is not allowed with `slices: true`). Nothing was priced, sent or spent. **Tell the person what it says and stop.** Don't edit `rules`, the line text or the files to get past it.
- `Refused (provider-refused)`: the provider checked the files when pricing and refused (a missing file, a file outside the allowed folders, a line too long or short for the model, a file over the 4 MB inline cap). Nothing was priced or sent. Tell the person, in the command's words.
- A failed run: tell the person what failed and get their go-ahead before running `step` again (it retries under the approval already given).

## The retry limit

Each shot may have **3 paid attempts** (calls that cost money, counted from the ledger; manual takes and refused calls don't count). The 4th is refused with the count and the money spent. Stop and tell the person. Pass `--max-attempts <n>` **only if the person asked for more tries in their own words**.

## When a person sends something back

- A lip-sync sent back: `step --shot <id>` again. The old file stays; their words go into the prompt (used on the manual path; fal's lip-sync takes no prompt); it is a new job with a new approval.
- A line cut sent back: the cut was wrong. Its lip-sync waits. The fix is the line's times or clip (the person's sheet), then `plan` cuts it again.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before anything else.
- Ends at a review gate: only a person moves anything to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person; every generation goes through `gate.run()`.
