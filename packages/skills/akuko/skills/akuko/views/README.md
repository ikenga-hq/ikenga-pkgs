# akuko views

A view is a page that shows an akuko project and hands back the person's decisions. The rules are in [`contract.md`](contract.md). This folder holds the contract, its schemas, the one finished board akuko ships, and the fixtures the conformance check is tested against.

| File | What it is |
|---|---|
| `contract.md` | The view contract: required views and fields, the decision format, the five renderer rules, where decisions land per host. |
| `views.schema.json` · `decision.schema.json` | Machine-readable parts of the contract. |
| `default-board.html` | **The default board**: one self-contained page, `default-board@0.3`. |
| `publish.ts` | `node --experimental-strip-types views/publish.ts --project <folder>`: embeds `<folder>/akuko.json` in the board's `akuko-project` block (escaped) and publishes it through `LocalHost.publishView()`; prints the path. With `--signoff <gate id>` it writes that gate's read-only sign-off page instead (below). |
| `signoff.ts` | Builds the read-only sign-off page for one gate (WP-29). |
| `conformed.json` | The list of views that passed `scripts/check-view.mjs`, with the sha256 of the exact HTML. Folding accepts approvals only from views on it. |
| `default-board.test.ts` | Pins the board: its hash is the recorded one, it passes the check, the text is readable in both themes, it reads live data. |
| `__fixtures__/` | The minimal board, the locked design with its marks, one page per broken rule, and `big-project.ts` (a synthetic 211-shot film with parts, cards, rules and gates). |

## The default board

The "script desk": the screenplay on the left with every shot lined to the line it came from, the shot list beside it opening into the shot (framing diagram, camera, action, the script line, draft prompt, bible references, notes, and **Approve / Request changes / Add a note**), and on the right the **spend gate** with the budget meter, then the Bible and the Ledger. The nine pipeline stages run along the top with a "your move" line that counts what is waiting for you.

- **It shows the project; it never writes it.** A person's click writes one decision (the inlined writer, `scripts/check-view/decision-writer.js`) and nothing else. akuko folds decisions into `akuko.json` at the start of its next action.
- **Money is exact.** The estimate, the cap, what is spent and what is left if you approve are printed to up to four decimals, never rounded. `Approve spend` writes the amount it showed (`approve 0.36 USD`), which is what folding checks.
- **Light and dark**, 390 px to wide desktops. The spend gate stays reachable while you read the Bible or the Ledger: once it scrolls away, a bar at the top of the right column keeps the money and the two buttons in view.
- **Undo** reverses exactly the decision you just made.
- **Without a store it still works.** On a plain local file decisions stay in the page's outbox; **Copy decisions for akuko** puts the ones the project does not have yet on the clipboard to paste into chat, and says so on screen ("Copied 3 decisions"). Decisions already in the project's `decisions` are left out of the copy (and counted as "already in your project"); nothing is ever deleted from the outbox.
- **Reading decisions from code.** `window.akukoDecisions.jsonl()` returns every decision this page holds, one JSON object per line (`all()` returns the same as objects). On host B in the Claude desktop app the agent runs it through the built-in browser's JavaScript tool instead of asking for a paste, then appends the lines with `decisions/cli.ts append` (it skips ids already there). That pane has no storage and loads the file as a `data:` URL, so decisions live only until the page reloads: read them before republishing. They are still the person's clicks; the agent never clicks approve. The JavaScript tool (`mcp__Claude_Browser__javascript_tool`, or the linked-cloud variant `mcp__remote-devices__Claude_Browser__*`) is used for exactly one read-only call: `window.akukoDecisions.jsonl()` (or `.all()`). Never call `emit()`, never click or dispatch events on the page, and never change the page, its DOM or its storage through it: a click or `emit()` there would write a decision signed as the person that folding accepts as theirs. Write the returned string to the file as it is and append it with `decisions/cli.ts append`: never edit, add or drop a line.
- **The pipeline strip** is a button only where the board has a section to open: Intake opens the script, Breakdown and Sketch the shots, Bibles the bible, and a stage with a paid job waiting opens the spend gate. A locked or not-started stage is plain text with a tooltip ("Locked: approve Breakdown first", "Not started") and no hover or pointer.

### Real projects: a long shot list, cards, rules and gates (@0.3, WP-29)

The look is D-01's; only behaviour was added, and only where the project has the data (a breakdown project such as *The Beating* shows exactly what it did before).

- **Parts.** When shots carry a `part`, a **Part** filter (P1…P10 and "All parts") shows one part at a time: its scenes, shots, cards and script tags, with the part's film span and how much of it is approved. A link opens one part directly: `default-board.html#part=P7`. The status filter counts within the part; "your move" always counts the whole film.
- **Film time.** Shots with `film` are placed and labelled on the master clock (`m:ss.ss`); the header says how long the film is. A sheet scene keeps its own id (`S11`).
- **What the sheet gave a shot** is in its detail: part, tier, framing, motion note, lighting (with its phrase), dialogue lines, the negative prompt, the sheet row, and "Left the sheet" for a row that was removed. A shot with no script line shows its dialogue (or its action) on the script paper.
- **Cards** (title, part cards, credits) sit in the shot list at their film time, in the part that follows them. A person approves each one once (**Approve card**, then **Undo**); folding records it like any asset.
- **Removed from the sheet.** Shots and cards whose row left the imported shot list (`source.removed_at`) are listed in a collapsed "Removed from the sheet" group at the end of the shot list, with no decision control; they can't be opened for review and are not counted in "your move" or the filters. A removed bible entry or image shows "Removed from the sheet" instead of an Approve button. (Folding refuses a decision on a removed unit; `lib/state.md` §Sign-off gates.)
- **Rules** and **Gates** are two more tabs beside Bible and Ledger (shown only when the project has them). Both are read-only. A gate shows its scope, its progress (approved / waiting / sent back / not made), and, once recorded, who signed it, how and when, with "attested, not proven". The units a gate covers follow `decisions/gates.ts#unitsInGate`; `default-board.test.ts` checks the panel agrees with it. **No control on the board signs a gate or is aimed at one**: a sign-off is recorded by `decisions/cli.ts signoff` (`actions/review.md` §4).
- **211 shots stay responsive.** Each click re-renders the board, but a container is re-parsed only when its HTML changed, and the shot list replaces only the scene sections that changed. Measured with the synthetic 211-shot film (`__fixtures__/big-project.ts`), 2026-11-10:

  | | Chromium (Claude desktop app's browser pane) | jsdom (`default-board.test.ts`, quiet machine · busy machine) |
  |---|---|---|
  | open a shot, every part shown | 87–118 ms | — |
  | approve a shot, one part shown | — | 0.7 s · 1.5 s |
  | approve a card, every part shown | — | 1.4 s · 2.9 s |
  | show one part (P7) | 197 ms | 1.0 s · 4.3 s |
  | back to every part (rebuilds 211 rows and the script) | 585 ms | 1.9 s · 8.9 s |

  jsdom parses HTML many times slower than a browser; the test prints its numbers and only fails on a click slower than 30 s.

### The sign-off page (WP-29)

`node --experimental-strip-types views/publish.ts --project <folder> --signoff <gate id> [--out <file>] [--images embed|link|none] [--max-image-mb <n>] [--max-total-mb <n>]` writes `<folder>/views/signoff-<gate>.html` (through `publishView()`) or `--out`, and prints what it did as JSON.

- **What it shows:** the gate, what signing it means, its progress, every unit in scope (picture, id, kind, approval status, film time), rows removed from the sheet, the house rules, who can sign, and how to sign (tell the person who sent it; they record it). Already signed: who, how, when.
- **Read-only by construction:** no executable script (only the `akuko-view` manifest, `writes_decisions: false`), no button, form or link, no external font or stylesheet. `check-view` reports it `SKIP … read-only (not applicable)`. Text from the project is escaped, and the few words that mark a decision-writing page are written as character references, so a project's own text can never make the page look like one.
- **Pictures:** embedded as `data:` URIs up to 3 MiB each and 12 MB in all (the page then fits a 16 MB artifact or a mail attachment); past either limit, or with `--images link`, a picture is referenced by its path relative to the page and the page says so. A video, a missing file or a remote URI is never loaded: its path is printed. akuko has no image codec, so it can't shrink a picture: for a large gate use `--images link` and share the folder, or make smaller previews first.

### How it gets its data, and why it never needs republishing

The page carries a snapshot of the project (`<script id="akuko-project">`, written by the publisher). On top of that it only **reads**:

| Host | Live source | Decisions go to |
|---|---|---|
| **A** claude.ai artifact | the artifact database: doc `akuko/project`, collection `decisions` (snapshot events, plus a 20 s poll) | one row per decision in `decisions` |
| **B** a local file | `akuko.json` next to the page when it is served over http; otherwise **Load akuko.json** (file picker) | the page's outbox, copied to chat |
| **C** Ikenga | `akuko.json` through the viewer (`akuko.json` or `../akuko.json` relative to the page) | the Ikenga bridge, which akuko mirrors to `decisions.jsonl` |

Decisions akuko has not folded in yet are shown as a preview (a shot you approved shows approved, the "your move" count drops), derived again on every render from the project plus the decisions it can see. Once akuko folds them into the project the preview and the folded state agree, and nothing is counted twice. Another reviewer's decisions on claude.ai show up the same way.

The footer says where the data came from and when it was last read.

### Publishing it

The file opens offline on a **sample project** (the project block carries `"_sample": true`). While it shows the sample it says so at the top and its Approve / note / spend buttons do nothing, so nobody can approve a unit of a real project by clicking through the sample.

- **Host A (claude.ai):** publish `default-board.html` **unchanged**, so the hash on `conformed.json` names what was published, with
  `capabilities: {db: {rules: [{path: "", read: "view", write: "owner"}, {path: "decisions", read: "view", write: "interact"}]}, user: {}}`.
  Then write the project to the doc `akuko/project`; the board reads it and replaces the sample.
- **Host B / C:** run `node --experimental-strip-types views/publish.ts --project <folder>`. It writes the current project into the `<script id="akuko-project">` block (the schema's project, without `_sample`) and saves the page as `<project>/views/default-board.html`. Changing the block does not change the conformance hash, and folding accepts the board by its view id (`default-board@0.3`; decisions written by `@0.1` and `@0.2` boards still fold, because every id stays on `conformed.json`).

### Changing the board

The conformance hash covers the page but ignores the content of the `akuko-project` block, so publishing the board with a real project in that block keeps it conformed. Any other edit has to be recorded again:

1. Edit `default-board.html`. Bump `"version"` in its `akuko-view` manifest (`default-board@0.4`, …). Keep the earlier ids on `conformed.json`: decisions already written by an older board have to keep folding.
2. From the skill folder: `node scripts/check-view.mjs views/default-board.html --ship views/conformed.json`. It runs the check and, only if the page passes, writes the `default-board@<version>` entry (this is also how a shipped id is recorded the first time).

`default-board.test.ts` fails whenever the file and its recorded hash disagree.

### Design notes

- Built from the locked design D-01, option B "script desk", on `@ikenga/tokens` theme A "Dusk Wood". Colours are defined under `--ak-*` names on purpose: a host that injects its own `--bg-base` or `--fg` (the Ikenga viewer does) must not be able to mix its palette into the page.
- The page follows the host's theme in Ikenga until the person picks one with the Light / Dark button.
- Body text is 14 px or larger, labels 12 px or larger. Every control is reachable by keyboard and shows focus. Motion respects `prefers-reduced-motion`.
- Bible images and key frames do not exist at this stage, so their frames are labelled placeholders, never made-up art.
