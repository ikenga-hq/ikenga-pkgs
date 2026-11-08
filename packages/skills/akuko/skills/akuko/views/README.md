# akuko views

A view is a page that shows an akuko project and hands back the person's decisions. The rules are in [`contract.md`](contract.md). This folder holds the contract, its schemas, the one finished board akuko ships, and the fixtures the conformance check is tested against.

| File | What it is |
|---|---|
| `contract.md` | The view contract: required views and fields, the decision format, the five renderer rules, where decisions land per host. |
| `views.schema.json` · `decision.schema.json` | Machine-readable parts of the contract. |
| `default-board.html` | **The default board**: one self-contained page, `default-board@0.1`. |
| `conformed.json` | The list of views that passed `scripts/check-view.mjs`, with the sha256 of the exact HTML. Folding accepts approvals only from views on it. |
| `default-board.test.ts` | Pins the board: its hash is the recorded one, it passes the check, the text is readable in both themes, it reads live data. |
| `__fixtures__/` | The minimal board, the locked design with its marks, and one page per broken rule. |

## The default board

The "script desk": the screenplay on the left with every shot lined to the line it came from, the shot list beside it opening into the shot (framing diagram, camera, action, the script line, draft prompt, bible references, notes, and **Approve / Request changes / Add a note**), and on the right the **spend gate** with the budget meter, then the Bible and the Ledger. The nine pipeline stages run along the top with a "your move" line that counts what is waiting for you.

- **It shows the project; it never writes it.** A person's click writes one decision (the inlined writer, `scripts/check-view/decision-writer.js`) and nothing else. akuko folds decisions into `akuko.json` at the start of its next action.
- **Money is exact.** The estimate, the cap, what is spent and what is left if you approve are printed to up to four decimals, never rounded. `Approve spend` writes the amount it showed (`approve 0.36 USD`), which is what folding checks.
- **Light and dark**, 390 px to wide desktops. The spend gate stays reachable while you read the Bible or the Ledger: once it scrolls away, a bar at the top of the right column keeps the money and the two buttons in view.
- **Undo** reverses exactly the decision you just made.
- **Without a store it still works.** On a plain local file decisions stay in the page's outbox; **Copy decisions for akuko** puts them on the clipboard to paste into chat.

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

- **Host A (claude.ai):** publish `default-board.html` **unchanged**, so the hash on `conformed.json` names exactly what was published, with
  `capabilities: {db: {rules: [{path: "", read: "view", write: "owner"}, {path: "decisions", read: "view", write: "interact"}]}, user: {}}`.
  Then write the project to the doc `akuko/project`; the board reads it and replaces the sample.
- **Host B / C:** write the current project into the `<script id="akuko-project">` block (the schema's project, without `_sample`) and save the page next to `akuko.json` (`<project>/views/default-board.html`). Changing the block changes the file's hash; folding accepts the board by its view id (`default-board@0.1`), so approvals still count.

### Changing the board

The hash on `conformed.json` covers the whole file, so any edit has to be recorded again:

1. Edit `default-board.html`. Bump `"version"` in its `akuko-view` manifest (`default-board@0.2`, …).
2. `node scripts/check-view.mjs views/default-board.html` must pass.
3. Record it: `node scripts/check-view.mjs views/default-board.html --record views/conformed.json`.

`check-view` reserves the `default-board@` ids: a page whose id is not on `conformed.json` fails with `id-collision`. For the **first** record of a new `default-board@<version>`, add its entry by hand with the file's sha256 (`node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('views/default-board.html','utf8')).digest('hex'))"`), then run the check with `--record`: it only keeps the entry if the page really passes, and re-writes it with the check's own timestamp. `default-board.test.ts` fails whenever the file and its recorded hash disagree.

### Design notes

- Built from the locked design D-01, option B "script desk", on `@ikenga/tokens` theme A "Dusk Wood". Colours are defined under `--ak-*` names on purpose: a host that injects its own `--bg-base` or `--fg` (the Ikenga viewer does) must not be able to mix its palette into the page.
- The page follows the host's theme in Ikenga until the person picks one with the Light / Dark button.
- Body text is 14 px or larger, labels 12 px or larger. Every control is reachable by keyboard and shows focus. Motion respects `prefers-reduced-motion`.
- Bible images and key frames do not exist at this stage, so their frames are labelled placeholders, never made-up art.
