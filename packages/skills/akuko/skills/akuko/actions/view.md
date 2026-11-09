---
name: view
description: Design and publish a view of the project for a question.
domain: content
ux_mode: confirm
inputs_schema:
  type: object
  properties:
    question:
      type: string
      description: What the person wants to see.
  required: []
  additionalProperties: false
run:
  kind: chat_prompt
  prompt: |
    Load actions/view.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - chat
---

# action: `view` — design and publish a view of the project for a question

**Loaded when**: the user runs `/akuko view "<what you want to see>"`, asks to see something about the film ("show me the cast", "where is the money going", "compare these two scenes"), or asks to see the board.

**Reads first**: `../lib/state.md`, `../lib/hosts.md`, `../views/contract.md` (all of it: the manifest §2, the marks §3, the controls §4, the rules §6, conformance §8).

This action designs a page for the question at hand. It never weakens the review loop: a page may show anything, but a page that lets someone **decide** something must pass the conformance check first.

## 1. Start the same way as every action

1. Detect the host (`../lib/hosts.md`): A claude-artifact, B local, C ikenga.
2. `readState()`, then fold decisions (`./review.md` §1) so the page shows what is true now.
3. Read the question. If there is none, ask what the person wants to see. If they just want the board to review things, offer the default board (`default-board`, the shipped view) instead of designing one.

## 2. Pick the kind of view

| The question is about | Kind | What it needs |
|---|---|---|
| Looking: who is in it, what it costs, how two scenes differ, what changed since yesterday | **Read-only** (the default) | `writes_decisions: false`. `check-view` SKIPs it. |
| Deciding: approve this shot, approve this spend, send this back | **Decision-writing** | `writes_decisions: true`, all eight required views, the decision writer, and a passing `check-view`. |

Prefer read-only. A page that answers a question and sends the person to the board to decide is the cheaper, safer design. Design a decision-writing view only when the person asked to decide in it.

## 3. Design the page

- **One page, one question.** Lead with the answer, then the detail. Derive every number, name and count from the `akuko-project` data block; never type a project fact into the page.
- **The page holds its data** as `<script type="application/json" id="akuko-project">` (an `AkukoProject`, with `<` written as `\u003c`). The publisher writes that block. On host A the page may also read `akuko/project` live and re-render. It never writes it.
- **The manifest** (`views/contract.md` §2):
  `{"contract":"akuko-view@1","id":"freehand:<slug>","version":"1","title":"…","writes_decisions":false,"views":[…]}`
  - **The id is yours: `freehand:<slug>@<n>`** (for example `freehand:cast-sheet@1`). Never reuse a shipped or fixture id (`default-board`, `test-board`, `board-b-instrumented`): `check-view` fails the page with `id-collision`. If you start from `views/__fixtures__/tiny-board.html`, rename its id first.
  - **Bump `version` whenever the page changes.** A conformance record covers one `id@version` and one exact page.
- **Marks.** Mark what you show with `data-akuko-view` and `data-akuko-field` where one exists (`views/contract.md` §3), so a reader or the checker can find it. A read-only view may offer any subset.
- **Money** is shown exactly, to at most four decimals, as the spend gate prints it: `0.36` is `0.36`, `0.4125` is `0.4125`, never rounded to cents. Show the estimate, the cap, what is spent and what is left if everything waiting is approved whenever you show a spend at all.
- **Readability floor** (`views/contract.md` rule 5, `designs/_spec.md`): body text at least 14px (use 16px), labels at least 12px, all sizes in px; text contrast at least 4.5:1; every control reachable by keyboard with a `:focus-visible` style; `prefers-reduced-motion` respected. **The page must be readable in light and dark**: define colours as variables under `:root`, redefine them for `prefers-color-scheme: dark` (and `:root[data-theme="dark"]`), set `color-scheme: light dark`, and give `body` an explicit background and colour. Check both palettes before publishing: a dark-only page is a near-invisible page in the other theme. Never size text from a variable (`font-size: var(--x)`); sketch panels and charts are drawn on their own dark ground so they read in both themes.
- **Never hide or shrink what the person must see**: no `display:none`, off-screen, zero-height, transparent or clipped money, "your move" or spend gate.

### Decision-writing views, additionally

- **Start from `views/__fixtures__/tiny-board.html`** (the smallest conforming page). Rename its id, set a version, restyle, add what the question needs. Keep every required view, mark and control. `evals/views/build.ts` is a worked example: the spend-breakdown page is that starter, restyled, with a read-only breakdown added above the spend gate.
- **Inline the current block from `scripts/check-view/decision-writer.js` verbatim** and call `akukoDecisions.emit(…)` only from a person's click, submit or key press, once per unit. Copy the file as it is now, not from memory or from an older page.
- **One decision per explicit action, per unit.** No batch approve, no pre-ticked box, no approval from a timer, a hover, a focus or a page event. Specifically avoid:
  - a `<select>`, radio, range or checkbox that writes when it changes (unless it is a marked per-unit control);
  - writing a decision from `pointerdown`, `mousedown` or `touchstart` (use `click`);
  - writing anything on `beforeunload`, `pagehide`, `visibilitychange` or any timer.
- **A decision control is a real control** (`button`, link or input) marked `data-akuko-action` with one `data-akuko-unit`. `approve-spend` carries the amount shown in its text (`approve 0.36 USD`).
- A view never calls `writeState()` and never edits `akuko.json` (`SKILL.md` review rule 4).

## 4. Check, then publish

**Run `node scripts/check-view.mjs <view.html>` on every view, read-only or not.**

- **Read-only view.** The check probes the page on every host and, if it writes nothing, prints `SKIP <file> (<id>@<version>) · read-only (not applicable)` and exits 0. Publish it freely. Nothing is recorded for it.
- **A page that claims read-only but writes** (a decision writer, a store write, a bridge post, even from a delayed or host-specific branch) fails with `read-only-writes`. It is then held to the whole contract: make it truly read-only, or make it a decision-writing view and take the path below.

**Decision-writing view.** It is blocked until `check-view` passes and the pass is recorded:

1. `node scripts/check-view.mjs <view.html>` (add `--project <akuko.json>` to check against the real project). Fix every failure it lists (each has a rule and a code, `views/contract.md` §6) and run it again. Never weaken the page to get past a failure: no removing the "your move" summary, no shrinking text, no loosening a control.
2. Record the pass in the **project's** list, never in the skill's shipped list:
   - B / C: `node scripts/check-view.mjs <view.html> --record <project>/views/conformed.json`
   - A: record into a workspace file, then ArtifactData `set` the doc `akuko/conformed` on the board artifact (owner only; `views/contract.md` §8).

   Never write into the skill's own `views/conformed.json`: that list belongs to the views the skill ships. `--record` refuses to replace an `id@version` already recorded for different HTML: bump `version`.
3. Publish (next section). The page you publish must be byte for byte the page that passed.

## 5. Publish through the host adapter

Every publish goes through `publishView({name, html, title, writesDecisions})` (`../hosts/types.ts`). Never use a raw Artifact publish or write the file yourself: that skips the gate the adapter applies, and a page with decision controls published around it would collect approvals nobody can trust. Set `writesDecisions: true` for a decision-writing view.

| Host | What `publishView()` does | Notes |
|---|---|---|
| **A** claude.ai | Publishes the HTML as a Claude artifact → `{url}` | **Read-only:** no capabilities are needed (the page holds a snapshot). **Decision-writing:** publish with `capabilities: {db: {rules: [{path: "", read: "view", write: "owner"}, {path: "decisions", read: "view", write: "interact"}]}, user: {}}` so reviewers can add decisions, and only the owner writes `akuko/project` and `akuko/conformed`. Load ArtifactData with ToolSearch; write `akuko/conformed` and seed `akuko/project` after publishing. |
| **B** Claude Code | Writes `<project>/views/<name>.html` → `{path}` | **Default board:** `node --experimental-strip-types views/publish.ts --project <folder>` embeds the current `akuko.json` into the board and publishes it through `publishView()`, then prints the path. In the Claude desktop app, when the built-in browser tools (`mcp__Claude_Browser__*`) are available, open the file in that pane by default and read the person's clicks with `window.akukoDecisions.jsonl()` (`./review.md` §1; read them before you republish or reload: the pane keeps no storage). Otherwise tell the person to open the file in a browser. A local file can't write files: its decisions stay in the page's outbox, and the page's **Copy decisions for akuko** control (the decision writer's `data-akuko-export` pattern) gives them lines to paste into chat. A B project may also publish through host A's artifact path when the desktop app has ArtifactData. |
| **C** Ikenga | Same as B now; opens in an Ikenga pane | Build the page to the `ikenga-artifact-builder` pattern when that skill is present (a self-contained HTML file that also lights up with live data in the shell). The decision writer already posts `akuko.decisions` to the bridge; the agent mirrors it into `decisions.jsonl` on read (`./review.md` §1). |

**Inline views.** Where a chat can render HTML inline, a read-only view may be shown there, still through `publishView()`'s output, never as a one-off paste. A decision-writing view is never inline: decisions need a store (the host's DB, file or bridge).

**Canva** (when the Canva connector is available) is for a read-only picture of the project: a cast sheet or a scene board as a design. It cannot write decisions. It is optional, and akuko does not depend on it.

### If the gate refuses

`publishView()` refuses an HTML view with `data-akuko-action` controls unless the page's `id@version` and exact hash are on the conformed list. If the gate refuses:

1. Read why. Usually the page was never checked, the list you recorded into is not the one the host reads (A reads the artifact's `akuko/conformed`; B and C read `<project>/views/conformed.json`), or you edited the page after the check.
2. Run `check-view` on the exact HTML you are about to publish, record it into the project's list, and publish again.
3. If `check-view` fails, fix the page (not the checker) and bump `version`.

Never bypass the gate: no raw publish, no hand-edited conformed list, no stripping `data-akuko-action` from a page that still writes decisions, no copying an old page's id or hash. If the person asks you to skip the check, say that approvals from an unchecked view are rejected when folded (`view-not-conformed`) and offer a read-only view or the default board instead.

## 6. Tell the person

- What the view shows and where it is (link or path).
- Whether it can record decisions. If yes: it passed `check-view` (name the view id and version) and its decisions reach akuko the way the host stores them (`views/contract.md` §5). If no: say it only shows things and decisions are made on the board.
- On host B (local file): if the board is open in the desktop app's built-in browser, say you will read their clicks from it when they tell you they are done. Otherwise remind them to use **Copy decisions for akuko** (it says how many it copied, and leaves out decisions the project already has) and paste the lines back.

Stop. Never approve anything yourself, and do not run the next stage.

## Worked examples

`evals/views/<ask>/view.html`, built from the converted *The Beating* fixture by `evals/views/build.ts` (`node --experimental-strip-types evals/views/build.ts`), pinned by `evals/views/views.test.ts`:

| Ask | Page | Kind | `check-view` |
|---|---|---|---|
| "show me the cast" | `evals/views/cast-sheet/view.html` (`freehand:cast-sheet@1`) | read-only | SKIP (exit 0) |
| "compare the bedroom scenes" | `evals/views/scene-comparison/view.html` (`freehand:scene-comparison@1`) | read-only | SKIP (exit 0) |
| "where is the money going, and what is waiting on me?" | `evals/views/spend-breakdown/view.html` (`freehand:spend-breakdown@1`) | **writes decisions** (per-job approve / decline) | **PASS** |

## Manual host-A check

Depends on the hardened check-view and the `publishView` gate (WP-07a2, PR #195) being merged.

For the person. About 15 minutes. **Environment:** run it in a session that has the akuko skill loaded and the Artifact tool, ArtifactData and a shell (for example Claude Code with the skill). A plain claude.ai chat has neither the skill nor the publish gate, so it cannot show steps 3 to 6. Each step says what to do and what to expect; copy this section into a reply with the `Observed:` lines filled in. The three pages are in `evals/views/` of `ikenga-hq/ikenga-pkgs` (use the commit the PR merged as, or later).

1. In a claude.ai chat, ask: *"Fetch `evals/views/cast-sheet/view.html` from ikenga-hq/ikenga-pkgs (packages/skills/akuko/skills/akuko/evals/views/cast-sheet/view.html) and publish it unchanged as an artifact called akuko-cast-sheet, with no capabilities."*
   Expected: an artifact link. The page reads "Cast sheet: The Beating", with "2 of 6 bible entries and 2 images are waiting for your review", cards for 3 characters, 2 locations and the look, and no buttons. Readable with the browser in light and in dark.
   Observed: ______
2. Do the same with `evals/views/scene-comparison/view.html`.
   Expected: two scenes side by side (sc2 left, sc4 right), the line "sc4 runs 3 s longer than sc2 (4 shots against 4)", and scene buttons that change the columns when pressed. Nothing else changes; reloading resets it.
   Observed: ______
3. Ask: *"Publish `evals/views/spend-breakdown/view.html` as akuko-spend-breakdown with db and user capabilities (db rules: root read view / write owner; `decisions` read view / write interact), without running the check."*
   Expected: **refused** by the host's publish gate (a page with decision controls and no conformance record), naming the page as not conformed. If it publishes anyway, that is a finding: say so.
   Observed: ______
4. Now ask the agent to run `node scripts/check-view.mjs` on that page with `--record conformed.json`, then ArtifactData `set` the doc `akuko/conformed` with that file, then publish again.
   Expected: `PASS … (freehand:spend-breakdown@1)`; the doc is written; the page publishes. It shows "Where the money goes" above the spend gate: Spent USD 0.84, Waiting or approved USD 0.36, Left if you approve USD 13.80, cap USD 15.00; and the spend gate's **Approve spend · USD 0.36** and **Not now** buttons.
   Observed: ______
5. Open the artifact signed in and click **Approve spend · USD 0.36**. In Claude Code, load ArtifactData and list the artifact's `decisions` collection.
   Expected: one row whose `data` is `action: "approve-spend"`, `unit: "job_kf_sc1"`, `text: "approve 0.36 USD"`, `view: "freehand:spend-breakdown@1"`, `by` your viewer id. The page now shows the job as approved (use **Undo approve-spend** to take it back; that writes a second row with `action: "undo"`).
   Observed: ______
6. Fold it: save the rows and the `akuko/conformed` doc to files, then `node --experimental-strip-types decisions/cli.ts fold-file --project fixtures/the-beating/akuko.json --rows rows.json --conformed conformed.json --out folded.json`.
   Expected: the report applies the approve-spend (`rejected` is empty); the same command with the conformed list left out rejects it with `view-not-conformed`.
   Observed: ______

**Report:** paste the filled-in steps back. Any "Expected" that doesn't hold is a WP-07c finding: say which step.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- A view never writes `akuko.json`; decisions go through the decision format, from a view that passed the check.
- Only a person approves. Nothing paid runs from a view: spend is approved on the gate (`../lib/spend.md`), and the paid call happens later through `gate.run()`.
