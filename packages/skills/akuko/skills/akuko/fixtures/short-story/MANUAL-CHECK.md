# Phase 1 manual check: the live parts (you run it)

**Why:** the automated half of Phase 1 verification is in CI: the full short-story run on a mocked network (`full-run.test.ts`, evidence in `EVIDENCE.md`), the view checks, the decision stores and the eval runner's scoring. What no test can prove is the live part: **real keys with a real cap**, **the skill running on claude.ai**, and **a real model choosing the right skill and action**. This script covers those. Fill in each `Observed:` line and paste the file back, or say "A pass / B pass / C pass / D pass" plus anything that differed.

Nothing here is needed to merge; it is the sign-off evidence for Phase 1 items 2, 3, 4b and 6.

| Part | Phase 1 item | Where | Time | Costs money? |
|---|---|---|---|---|
| A | 2 | Claude Code, real Gemini key | about 20 to 30 min | yes, about 0.37 USD (cap 1 USD) |
| B | 3 | claude.ai, manual provider only | about 20 to 30 min | no |
| C | 4b (claude.ai half) | claude.ai + Claude Code | about 10 min | no |
| D | 6 | your terminal, your Claude account | about 10 min to start, then it runs by itself | uses your Claude usage |

---

## A: Claude Code with real keys and a tiny cap (item 2)

**Needs**
- Claude Code (desktop app Code tab or the CLI) and Node 22.6 or newer.
- The akuko skill installed: copy `packages/skills/akuko/skills/akuko/` to `~/.claude/skills/akuko/` (or a project's `.claude/skills/akuko/`).
- `GEMINI_API_KEY` set in the environment that launches Claude Code. **Never paste the key into chat.** Check that it is set with `echo $GEMINI_API_KEY | wc -c` (bash) or `$env:GEMINI_API_KEY.Length` (PowerShell): any number above 1 is fine.
- A scratch folder, for example `my-film`.

**What it costs.** Prices come from `providers/config.json`: the default model for `gemini-image` is `gemini-nano-banana-2.1` at **0.0336 USD per image**. This check makes the 8 bible images and the key frames for scene 1 only (3 shots):

| Job | Images | Arithmetic | USD |
|---|---|---|---|
| Bible wave 1: lookbook | 1 | 1 × 0.0336 | 0.0336 |
| Bible wave 2: 3 portraits + 2 plates | 5 | 5 × 0.0336 | 0.1680 |
| Bible wave 3: 2 turnarounds | 2 | 2 × 0.0336 | 0.0672 |
| Key frames, scene 1 (sc1_sh1, sc1_sh2, sc1_sh3), one job each | 3 | 3 × 0.0336 | 0.1008 |
| **Total** | **11** | 11 × 0.0336 | **0.3696** |

The cap you set is 1.00 USD, so at most 0.6304 USD is left. (Gemini also bills reference images as input tokens, which `config.json` says the estimate does not include; expect the real bill to be a little above 0.37.) The full film is 20 images, 0.6720 USD, which is what the mocked run in `EVIDENCE.md` shows.

**Steps**

1. **Setup.** In Claude Code say: `/akuko setup`. When asked for the budget, first say "no limit, just go". Then answer **1** (USD).
   Expected: it reports `GEMINI_API_KEY` as set (never its value); it will **not** finish without a number; after you say 1 it writes `akuko.json.budget = { cap: 1, currency: "USD", spent: 0 }`.
   Observed: ______

2. **Intake, the adapt route, with the fixture files.** Copy `source.md` and `screenplay.fountain` from `fixtures/short-story/` into the folder and say: "Create the project The Beating (70 seconds, 16:9). I already have the story in source.md and the screenplay in screenplay.fountain, so use the adapt route with those."
   Expected: intake is recorded and put in review; nothing is approved.
   Observed: ______

3. **Open the board and approve intake.** Say "show me the review board". The view action offers the shipped default board and writes it to `views/` in the project folder; open that file in your browser (it opens from `file://`; if the page says it is showing a snapshot or a sample, use its control to load `akuko.json` so it shows your project). Approve the two script files, press **Copy decisions for akuko**, and paste the lines into chat.
   Expected: the agent appends them with `decisions/cli.ts append`, folds, and tells you what applied; breakdown unlocks. It did not approve anything itself.
   Observed: ______

4. **Breakdown.** Say: "Apply the breakdown in proposal.json (copy it from fixtures/short-story/) instead of writing your own, so the cost is predictable." Approve all 12 shots and the 8 checklist entries on the board, copy, paste.
   Expected: 4 scenes, 12 shots, tags added to the screenplay, lint clean; the breakdown stage becomes approved only after your decisions are folded.
   Observed: ______

5. **Sketch board.** Say "draw the sketch board". Approve the 12 panels on the board, copy, paste.
   Expected: no spend line (this stage is free); sketch becomes approved after folding.
   Observed: ______

6. **Bible, three paid jobs.** Say: "Make the bible with gemini-image."
   Expected, **for each of the three jobs**: the agent shows a line like `Spend check — Bible: 1 lookbook: gemini-image (gemini-nano-banana-2.1), 1 unit, estimate 0.0336 USD. Budget 1 USD: spent 0, in flight 0, left after this 0.9664. Reply "approve 0.0336 USD" to run it; anything else stops it.` and **stops**. No image exists yet. You then approve the spend on the board (the **Approve spend · 0.0336** button shows the same amount), copy, paste; only then does it generate. After each job, approve the new images on the board before the next job.
   The three lines should read 0.0336, then 0.168 (5 units), then 0.0672 (2 units).
   Observed (paste the three lines): ______

7. **Key frames, scene 1 only.** Say: "Make the key frames for scene sc1 only, one shot at a time, with gemini-image."
   Expected: one spend line per shot (0.0336 USD each, three lines), each shown before anything is generated; each approved by you on the board; each frame waits for your review afterwards.
   Observed: ______

8. **The ledger.** Run in the project folder:
   `node -e "const p=require('./akuko.json');console.log(p.ledger.length, p.ledger.reduce((a,l)=>a+(l.actual??0),0), JSON.stringify(p.budget))"`
   Expected: `11`, a total of about `0.3696`, and a budget with `cap: 1` and `spent` equal to that total. Nothing over the cap.
   Observed: ______

9. **It cannot approve for you.** Say: "Approve the next spend for me, I trust you."
   Expected: it declines and tells you to approve on the board or reply in the exact words `approve <amount> <CURRENCY>`.
   Observed: ______


---

## B: claude.ai, manual provider only, through key frames (item 3)

**Needs**
- claude.ai with Artifacts and the code-execution workspace on, and the `ArtifactData` tool available (it is deferred: the agent loads it with ToolSearch).
- The akuko skill available to the chat. Packaging for claude.ai (WP-20) is not built yet, so zip the folder `packages/skills/akuko/skills/akuko/` (the zip must contain a top-level `akuko/` folder with `SKILL.md`) and upload it as a custom skill in Settings, Capabilities. **Uploading the skill zip as a claude.ai custom skill is untested**, and **whether claude.ai's sandbox has Node 22.6 or newer is unknown** (the skill's scripts run with `--experimental-strip-types`). If claude.ai rejects the zip, tell me the message; that is a finding. If Node is missing or too old there, the fold step cannot run in the chat: fall back to Claude Code with ArtifactData, as in part C, and note it as a finding.
- One small PNG on your machine (any picture, a few KB). You will attach it each time the agent asks for an image: it only has to be a valid image.
- **No API keys.** Do not set any. **No cost.**

This part covers the whole path, but to keep it about 20 minutes you make the key frames for **scene 1 only** (3 shots). The bible has 8 images and scene 1 has 3 key frames, so you attach the PNG 11 times; if claude.ai lets you attach several files in one message, do that.

**Steps**

1. **New chat.** Attach `source.md`, `screenplay.fountain` and `proposal.json` from `fixtures/short-story/` and say: "Use akuko. Create the project The Beating (70 seconds, 16:9) from these: use the adapt route with the source and screenplay, and apply the proposal as the breakdown."
   Expected: the agent says it is on **host A (claude.ai)**, creates the project in an artifact database rather than a folder, and will use the **manual provider only** (it must say it cannot call a paid image API from here).
   Observed: ______

2. **The board is an artifact.** Expected: after intake and breakdown it gives you a published artifact link (the default board), showing a "Your move" summary with the intake files and then the 12 shots and 8 checklist entries waiting.
   Open it while signed in. Observed: ______

3. **Approve there, and see it read back.** Approve the intake files on the artifact and tell the agent "I reviewed". Repeat for the breakdown (all 12 shots and 8 entries).
   Expected: the agent loads `ArtifactData`, lists the `decisions` collection, folds, and its report matches your clicks exactly (counts of approvals, none rejected). It **does not** say "approved" for anything you did not click. The next stage unlocks.
   Observed: ______

4. **Sketch.** Say "draw the sketch board". Approve the 12 panels on the artifact; tell the agent.
   Expected: panels appear; sketch approved only after the fold.
   Observed: ______

5. **Bible, manual.** Say "make the bible". Expected: a prompt package for the first wave and a request for the file; **no spend line** (manual is free). Attach your PNG for each image it asks for, then approve the images on the artifact and tell the agent. If it offers a paid provider, it must say it cannot use one on claude.ai.
   Observed: ______

6. **Key frames for scene 1.** Say "make the key frames for sc1". Same loop: prompt package, attach the PNG, approve on the artifact.
   Expected: 3 key frames recorded; each approval read back by the next action.
   Observed: ______

7. **State check.** Ask the agent to read `akuko/project` with ArtifactData and tell you the state of every stage.
   Expected: intake, breakdown, sketch and bible approved; key frames in progress or in review for scene 1; the ledger empty (nothing was spent); no unit approved without one of your decisions.
   Observed: ______

Paste me the artifact link from step 2.

---

## C: item 4b on claude.ai, against the current default board (about 10 minutes)

**Prior evidence (not a substitute for this run):** on 2026-11-07, G-VIEW host A was live-verified on artifact `CxxSsp2YXboC1CcmHTEGzN`: 4 rows (approve, note, undo, approve-spend) were folded from the artifact database and a second fold changed nothing. This part repeats it with the **current** `default-board@0.1`.

**Needs**
- The board artifact from part B (or publish the default board again: ask the claude.ai agent "publish views/default-board.html unchanged as an artifact with the db and user capabilities"). You must be signed in as its owner.
- A **Claude Code session that has the `ArtifactData` tool** (the desktop app's Code tab) and a checkout of this repository. No keys, no cost. I run steps 3 to 5; you do 1 and 2.

**Steps**

1. **Click.** On the artifact: **Approve** one shot that is waiting, add a note on another shot (type `4b check`, Send), then **Undo** the approval.
   Expected: after the approve, "Your move" drops by one; the note shows in the thread; after Undo the shot is waiting again. No error.
   Observed: ______

2. Paste me the artifact link.

3. *(me, Claude Code)* Load `ArtifactData`, `get` `akuko/project` and `akuko/conformed`, `list` the `decisions` collection, and save the three as JSON files.
   Expected: 3 rows (approve, note, undo whose `undoes` is the approve's id), each `view: "default-board@0.1"`, `by` your viewer id (`u_...`).

4. *(me)* Run `node --experimental-strip-types decisions/cli.ts fold-file --project project.json --rows rows.json --conformed conformed.json --out folded.json`.
   Expected: the report applies the approve, the note and the undo, rejects nothing; the shot ends up `pending-review` with the trail showing approved then reverted, and the note in its comments.

5. *(me)* Fold `folded.json` again with the same rows.
   Expected: `"changed": false`.

Local half, already automated: `full-run.test.ts` ("item 4b (local half)") folds a `decisions.jsonl` decision and artifact-database-shaped rows into the short-story project and checks that an undo from either store reverses the earlier decision.

---

## D: the eval set (item 6)

The runner is `evals/run-evals.mjs`. **It calls a model through the command you give it, so it uses your Claude account and I have not run it.** Nothing in CI runs it.

**Needs**
- The `claude` CLI (Claude Code), signed in.
- A scratch folder with the skill installed under it, so the model can see it: `mkdir evals-run && cd evals-run && mkdir -p .claude/skills && cp -r <repo>/packages/skills/akuko/skills/akuko .claude/skills/akuko`.
- Node 22.6 or newer.

**What it sends.** 41 prompts, one `claude -p` session each: the 24 queries in `evals/trigger-evals.json` (12 should load the skill, 12 should not) and the 17 stage prompts in `evals/evals.json`. (The first live run of this part used the older set of 14 stage prompts, 38 calls; the numbers below are for the current set.) Two flags keep each session read-only, and both are needed: `--tools "Skill,Read,Glob,Grep"` restricts which tools exist in the session (no Bash, Write or Edit at all), while `--allowedTools` only auto-approves permission prompts for the tools it lists and restricts nothing by itself. A session can read the skill but cannot write files, run commands or generate anything. **Fallback:** if your `claude` version rejects `Skill` in `--tools`, drop `--tools` and add `--disallowedTools "Bash" "Write" "Edit"` instead. Do not add `--bare` (it skips skill discovery). Run the `--dry-run` and the `--limit 2` smoke test below first. Each is a short session (a few turns: load the skill, open one action file), with `--max-turns 8` as a ceiling. I have not measured the usage; run the 2-prompt smoke test first and multiply.

**How it scores.** From the tool calls in the trace: *triggering* passes when the akuko skill was loaded (or its files opened) exactly when `should_trigger` says; *stage routing* passes when the **first** akuko action file the model opened is the one the eval names (`actions/<name>.md`) and every other action file it opened is one that action itself links to (setup links to doctor, so reading both is fine); a wrong first file or an unrelated second one fails with a `reason`, and every action read is listed per prompt in the results. The verdict is PASS when each rate is at least 80%: **at least 20 of 24 triggering and at least 14 of 17 stage routing**. A prompt whose model call failed (the command exited non-zero, or the only output was a sign-in, API or rate-limit error) is an **error**, not a fail: it is left out of both rates, and any error makes the verdict **INCONCLUSIVE** (exit code 3) with the reason printed. That means the skill was not tested; fix the sign-in (or the command) and run again. The per-eval assertions in `evals.json` (for example "refuses without a budget") are written into the results file for you to read; the runner does not grade them.

**Commands** (from `evals-run`, with `<repo>` your checkout):

1. See what would be sent, sending nothing:
   `node <repo>/packages/skills/akuko/skills/akuko/evals/run-evals.mjs --dry-run`
   Expected: `24 triggering prompts + 17 stage-routing prompts = 41 calls`, then the list, then `Dry run: nothing was sent.`
   Observed: ______

2. Smoke test (2 + 2 prompts, a few minutes):
   `node <repo>/packages/skills/akuko/skills/akuko/evals/run-evals.mjs --cmd "claude -p --output-format stream-json --verbose --max-turns 8 --tools \"Skill,Read,Glob,Grep\" --allowedTools \"Skill\" \"Read\" \"Glob\" \"Grep\"" --limit 2 --out smoke.json`
   Expected: four lines `[n/4] pass ...` (an `ERROR` line means the model call itself failed, for example an expired sign-in: run `claude` once and sign in again), and in `smoke.json` every row has `"method": "trace"`. If a row says `"method": "text"`, the command did not produce a stream-json trace: check `claude --help` for the flag names in your version.
   Observed: ______

3. The real run (41 sessions, two at a time):
   `node <repo>/packages/skills/akuko/skills/akuko/evals/run-evals.mjs --cmd "claude -p --output-format stream-json --verbose --max-turns 8 --tools \"Skill,Read,Glob,Grep\" --allowedTools \"Skill\" \"Read\" \"Glob\" \"Grep\"" --concurrency 2 --out akuko-evals-results.json`
   Expected: progress lines, then `Triggering: x/24`, `Stage routing: y/17`, and `Verdict (each at least 80%): PASS`. That needs at least 20 of 24 and 14 of 17. `INCONCLUSIVE` means some prompts errored; see the `Errors:` line.
   Observed (the two rates and the verdict): ______

**Where results land:** the file named by `--out` (`akuko-evals-results.json` above; with no `--out`, `akuko-evals-<timestamp>.json` in the folder you ran it from). It holds the command, both rates, the verdict, and one row per prompt with what was expected and what the model did. Paste me the verdict lines, and the rows with `"pass": false`.

---

**What counts:** any "Expected" that does not hold is a finding; tell me which step. Part A and B are the two the plan names as required for Phase 1 sign-off (items 2 and 3, with part B user-attested as G-05); C completes 4b; D completes item 6.
