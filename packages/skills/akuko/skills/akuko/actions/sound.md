---
name: sound
description: "Add voice-over with word timings, music bed and SFX."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/sound.md from the akuko skill and follow it.
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

# action: `sound` — voice-over with word timings, music bed and SFX

**Loaded when**: key frames are approved and the user runs `/akuko sound`. Motion does not need to be approved first (shot lengths are set by key frames, and a voice-over only needs a length to fit).

**Reads first**: `../lib/state.md` (§6 sound, §Status transitions, §Decision folding), `../lib/hosts.md`, `../lib/spend.md`, `../lib/providers.md`.

**Stage**: `sound` (6) · voice-over is **paid** (spend gate before every call) or free through the manual provider · music and SFX are person-supplied files, never generated. Never approves.

**What is judgement and what is code.** Which voice-overs exist, the text each speaks, the job id, the word timings, `audio.narration`, the captions and every status move are code in `../sound/` (tested). Yours: asking the person to confirm any text that is not already narration, hearing each take before it goes to review, what to tell the person, and handing them the right thing at each gate. **Never write a status, an id or a timing yourself, and never call a provider directly: only `gate.run()` does.**

## The technique

**Narration text is never yours to write.** It is `shot.narration` when the person set one. A shot with only a script line (the fixture's are Poe's own words) is *proposed*: show the person the lines, and only when they say, in their own words, which shots (name them, or say "all") run `plan --script-lines <shot ids|all>`. Never pass it on your own judgement or on a bare "ok". Each unit planned that way gets the agent comment "Narration from script line, confirmed by you in chat", so the confirmation is on the record. A shot with no text has no voice-over. One voice-over per shot, so each is reviewed, approved and re-made on its own.

**The voice is the person's choice.** For a paid provider pass `--voice <voice id>` (for ElevenLabs they list theirs with `GET /v2/voices`). akuko has no default voice and picks none.

**Timings are real or absent.** A paid take comes back with the provider's own character timings, grouped into words. A take the person records themselves has timings only if they bring a words file. With none, the take is recorded **without timings**, the result says captions need them, and nothing is estimated or spread evenly.

## Where the stage is tracked

The unit is one planned asset per shot with text (`sc1_sh1_vo`, kind `vo`, owner = the shot). Music and SFX the person supplies are `music` / `sfx` assets in the same stage (licence, source and placement in their tags). Folding approves `stages.sound` when every one is approved. See `../lib/state.md` §6.

## Steps

All commands: `node --experimental-strip-types ../sound/cli.ts <command> --project <folder>` (B and C). On host A there is no code: use the manual provider and the rules in `../lib/spend.md` §Host A.

0. **Fold decisions first** (`../decisions/cli.ts fold`). Tell the person what the report says, including every rejected decision. If it is locked, say which earlier stage is waiting and stop.
1. **`plan`**: plans a voice-over for every shot that has narration. It lists the shots that only have a script line. **Show those lines and ask.** If the person confirms, `plan --script-lines sc1_sh1,sc1_sh2` (or `all`). Safe to repeat.
2. **`status`**: one line per voice-over. "the shot's text changed since this take" means the take was spoken from older text: tell the person and let them decide whether to send it back.
3. **Choose the provider** (the person decides): `manual` (free; hosts A, B, C) or `elevenlabs` (paid direct API, needs `ELEVENLABS_API_KEY`; hosts B and C only, refused on A). A paid provider needs a budget cap from `/akuko setup`.
4. **`step --provider <id> --voice <voice>`** makes the next job, by default **one shot**:
   - **Paid:** it prints the spend line (characters × price). **Show it and wait.** Nothing has been sent. The person approves on the board (or replies in the exact words of the line, `approve <amount> <CURRENCY>`); fold, then `step` again. It then runs, records the audio and its words file, and marks the take `pending-review`. `--scene <id>` or `--units a,b` batches several shots into one job with one approval for the total.
   - **Manual:** it prints the exact words and the shot's length. Give them to the person (voice notes are theirs to apply). They bring the audio back: `ingest --job <id> --unit <asset id> --file <audio> [--words <words.json>]`. A words file is `{word, start_ms, end_ms}` in milliseconds from the start of the audio (a bare list, or `{ "words": [...] }`). If the file turns up later: `words --unit <asset id> --file <words.json>` (do not ingest the audio again: that files a second take).
5. **Listen to each take** before telling the person it is ready: it says the right words, at a pace that fits the shot, with no clipped ends or stray sounds. If one is wrong, say what and offer another try (paid: a new approval). A take longer than its shot is flagged for you: `step`/`ingest`/`words` print "Audio runs 8.4 s; the shot is 6 s" and the same sentence is an agent comment on the `<shot>_vo` asset, so the person sees it at review. Tell them. They can shorten the line, pick a faster voice or model, or lengthen the shot in breakdown. You change neither the text nor the shot. Such a take is left out of the film's narration until it fits (step 8).
6. **Music and SFX**, only if the person supplies them: `add-music` / `add-sfx --file <audio> --licence "<their words>" [--source "<where from>"] [--shot <id> | --scene <id>]` (the film by default). **Ask for the licence**: it is required, akuko records what they say and cannot check it. Nothing is generated.
7. **Stop at the review gate.** Everything made is `pending-review`; the stage is `in-review`. The person reviews each take on the board. Don't call anything approved.
8. **After the person's answers**: fold, then `sync`. It rebuilds `audio.narration` from the **approved** takes only (each placed at its shot's start on the film's timeline, words in composition-absolute milliseconds) and writes `audio/vo/captions.vtt` and `captions.srt`. Tell the person what it reports: takes without timings, takes it left out because they overrun their shot (named with shot, take length and shot length; the rest is still built), or "no single narration track".

## When a person sends a take back

Folding turns it into `needs-rework` with their words. `step --units <asset id>` for it: the old file is cleared (it stays stored; the "Revised: …" comment says where), the new take fills the same asset, and it goes to `pending-review` again. A paid re-record is a new job (`…_r2`) and needs a new approval. `sync` then rebuilds without the take until it is approved again.

## Captions

A pure function of the word timings: a cue starts at its first word's start and ends at its last word's end. A cue holds at most 42 characters and 5 seconds, breaks at a pause of 1 second or more, and always ends at the end of a sentence (`.`, `!`, `?`, `…`).

## Rules check

When the project has `rules` (`../lib/state.md` §"Rules guard (WP-26)"), every voice-over job is checked against them before the spend gate: the spoken text against the banned terms. Required text doesn't apply to voice-over, and the voice is a provider id, not a file, so there is no reference check. A breach prints `Refused (rules-breach): …`, naming the term and the line it is in; `rules-missing` means `rules.required` is set but no rules are recorded. Nothing was priced, sent or spent. **Tell the person what it says and stop.** Narration is never rewritten by you, and neither are the rules: the person decides. Before a paid run, run the free preflight, `node --experimental-strip-types ../rules/cli.ts check --project <folder>`: it also reads each shot's narration and script line, and the text of the dialogue lines, and lists any banned term in them.

## Limits to know

- **One track needs WAV.** `audio.narration` points at one narration file. akuko can join takes into it only when every approved take is a 16-bit PCM WAV of one sample rate (what ElevenLabs returns here). If the person brought an mp3 or m4a, there is no `audio.narration` block yet, the captions are still written from the timings, and assemble (WP-13) joins the files with its own tools.
- **A take must fit its shot.** If the audio, or its last word, runs past the shot, `sync` leaves that take out (its words would run into the next shot), names it with a warning, and builds the rest. At a natural reading pace (about 70 ms per character) many long lines overrun short shots: expect it, and let the person choose between a shorter line, a faster voice or model, and a longer shot in breakdown.
- **Every shot needs a duration** for its voice-over to be placed on the timeline.
- Character prices count the characters of the text; the provider bills its own count, so a small difference is possible.
- A paid response with no word timings still records the audio (it was paid for), marked as having none.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person; every generation goes through `gate.run()`.
