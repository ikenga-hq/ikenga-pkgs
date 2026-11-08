# akuko — view contract (gate G-VIEW)

The board is a contract, not a page. Any agent or tool can render a review surface for an akuko project. akuko depends only on two things: the data it publishes (`akuko.json`), and the decisions it gets back in one format. This file is that contract. Two parts are machine-readable:

| File | What it is | Source |
|---|---|---|
| `views/views.schema.json` | The view manifest, the required views (`ViewName`), the fields each view carries (`fields:<view>`), the controls (`Action`) and the five rules (`Rule`) | Hand-written. This file is the prose. |
| `views/decision.schema.json` | The `Decision` record | **Generated** from `schema/akuko-project.ts#DecisionSchema`. Never edit it by hand. |
| `scripts/check-view.mjs` | The conformance check | `scripts/check-view/` |
| `scripts/check-view/decision-writer.js` | The reference decision writer, inlined verbatim by conforming views | |
| `views/__fixtures__/` | `board-b-instrumented.html` (the locked board B design plus marks), `tiny-board.html` (the smallest conforming page), `readonly-cast-sheet.html` (a read-only view check-view skips), and `bad-*.html` (each breaks one rule) | |

Regenerate the decision schema after any change to `DecisionSchema`:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning decisions/export-decision-schema.ts
```

`decisions/decision-schema.test.ts` fails if the committed file differs from that output.

---

## 1. Data in

- The page holds the project as `<script type="application/json" id="akuko-project">` (an `AkukoProject`, with `<` written as `<`). The publisher writes that block. check-view replaces it with its fixture. The page has **exactly one** such block, `type="application/json"`, with a real `id` attribute (not `data-id`), holding nothing or JSON with no `<!--`; it ends where a browser ends it, at the first `</script`. Anything else (a second opener, even one quoted in a `<textarea>`, `<noscript>`, CDATA or an attribute; an untyped block; non-JSON content) fails `bad-project-block`, because the block's content is left out of the conformance hash (§8).
- Everything shown is **derived from that data**: counts, money, statuses. Nothing is typed in.
- On host A a view may also read the live doc `akuko/project` from the artifact database (`db.doc("akuko/project").get()`) and re-render. It never writes it.
- What the person decided in the page (status overlays, notes) is a local preview of their own decisions. akuko's fold is the record.

## 2. The manifest

Every view embeds:

```html
<script type="application/json" id="akuko-view">
{"contract":"akuko-view@1","id":"default-board","version":"0.1","writes_decisions":true,
 "views":["pipeline","shots","shot-detail","bible","spend-gate","ledger","script-link","your-move"]}
</script>
```

- `Decision.view` is `<id>@<version>`, e.g. `default-board@0.1` or `freehand:cast-sheet@1`.
- **Bump `version` whenever the page changes.** A conformance record covers one `id@version` and one page, by its conformance hash (§8).
- A view with `writes_decisions: true` must list all eight views. A read-only freehand view may list any subset, and needs no check: check-view reports it `SKIP` once it has seen it write nothing (§10).

## 3. Required views and fields

Mark each view's container `data-akuko-view="<name>"`. Mark each field `data-akuko-field="<name>"`. Scope it to a unit or job with `data-akuko-unit="<id>"`, or to a stage with `data-akuko-stage="<id>"`. Give status fields the machine value in `data-akuko-status`. A field may be visually styled any way you like. The mark only tells the check where it is.

| View | Must show | Marks |
|---|---|---|
| `pipeline` | All nine stages with their state, and which one is current | `stage` × 9 (`data-akuko-stage`, `data-akuko-status` = `stages.<id>.state`); one `current-stage` (`data-akuko-stage` = `current_stage`) |
| `shots` | Every shot, grouped by scene, each with its sketch panel, id, shot type, duration and review status | `scene` per scene; `shot` per shot (`data-akuko-unit`) holding `status` (`data-akuko-status`), `shot-type`, `duration`, `panel` |
| `shot-detail` | For the selected shot: panel, camera, action, duration, the screenplay line, draft prompt, bible refs, comment thread, status. If it is `pending-review` or `needs-rework`, also **Approve / Request changes / Add a note** | The view element has `data-akuko-unit` = the shot; fields `status`, `panel`, `camera`, `action`, `duration`, `script-line`, `prompt`, `refs`, `comments` |
| `bible` | Characters, locations, styles with status; an Approve on every asset waiting for review | `bible-entry` per entry (`data-akuko-unit`, `data-akuko-status`) |
| `spend-gate` | Every `pending_spend` job with its estimate and status; the cap, what is spent and **what is left if you approve**; sunk and in-flight money when not zero; **Approve spend / Not now** on each job waiting | `job` (`data-akuko-unit`, optional `status`), `estimate` (`data-akuko-unit`), `cap`, `spent`, `left-if-approved`, `sunk`, `in-flight` |
| `ledger` | Every paid call, and the total | `ledger-entry` per entry, `ledger-total` |
| `script-link` | The screenplay with a tag per shot. Activating a tag selects that shot in `shot-detail` | `script-tag` per shot with a `script_line` (`data-akuko-unit`) |
| `your-move` | Always visible: what is waiting for the person, counted from the data | `waiting-shots`, `waiting-spend`, `waiting-other` (each element's text starts with the number; omit a zero count if you like) |

The numbers check-view expects (`scripts/check-view/expected.mjs`):

- `waiting-shots` = shots with status `pending-review`.
- `waiting-spend` = jobs `awaiting-approval`.
- `waiting-other` = assets `pending-review`, plus bible entries `pending-review` whose refs include no asset.
- `left-if-approved` = cap − spent − sunk − in flight − (bounds of approved jobs not yet run) − (estimates of jobs waiting). This is what is left if you approve everything waiting.
- Every amount is shown **exactly**, to at most four decimals, as the spend gate prints it. Never round to cents: 0.4125 is `0.4125`, not `0.41`.

## 4. Controls and the decision format

A control that writes a decision is marked `data-akuko-action="<action>"` with `data-akuko-unit="<unit or job id>"`. It must be a real control: a `button`, link, or input reachable by keyboard.

| Action | On | Decision written | Notes |
|---|---|---|---|
| `approve` | a unit `pending-review` / `needs-rework` | `{action: "approve"}` | One click, one unit |
| `request-changes` | same | `{action: "request-changes", text}` | May open a composer: `textarea[data-akuko-text]` + a `[data-akuko-submit]` control. Writes nothing until submitted |
| `note` | any unit | `{action: "note", text}` | Same composer pattern |
| `approve-spend` | a job `awaiting-approval` | `{action: "approve-spend", text: "approve <amount> <CUR>"}` | **The text is the amount the person was shown**: see §7 |
| `decline-spend` | same | `{action: "decline-spend"}` | |
| `undo` | the unit or job of an earlier decision | `{action: "undo", undoes: <that decision's id>}` | Reverses exactly that decision |

Every record validates against `views/decision.schema.json`:

```ts
{ id: uuid, action, unit, stage /* the unit's or job's stage */, text?, undoes?,
  by: /* viewer id when the host knows it, else "you" — never an agent name */,
  at: /* ISO timestamp with seconds and zone */, view: "<manifest id>@<version>" }
```

`schema/akuko-project.ts#DecisionSchema` is frozen (G-SCHEMA). This contract adds rules **on** its fields and adds no fields.

### The decision writer

Inline `scripts/check-view/decision-writer.js` verbatim, then call `akukoDecisions.emit({action, unit, stage, text?, undoes?})` from a person's click, submit or key press, **once per unit**. It fills `id`, `by`, `at` and `view`. It keeps every decision in a localStorage outbox (`akuko-outbox:<slug>`) and sends each one to the host's store. It also offers `all()`, `jsonl()`, `store()` and `onChange(fn)`. A view may write the stores itself instead, as long as what lands in each store is the same.

**The current writer is v2** (its first line says `akuko-decision-writer v2`). v2 changes one thing from v1: on load it re-posts the outbox to the Ikenga bridge **only when the outbox holds something** (`if (outbox.length) toIkenga();`). v1 posted on every load, so after a pane remount it posted an empty list over the shell's stored one (§5 Host C). A page that inlines the writer must inline the **current canonical block byte for byte** (line endings aside): check-view fails a stale or edited copy with `stale-writer`, naming the version it found. When the writer changes, every board re-inlines it, bumps its `version` and is checked again. The writer is inlined **once**; `stale-writer` also fails a page that inlines it twice, defines a second writer beside it, or defines `window.akukoDecisions` without the canonical block (a view that writes the stores itself must not use that name).

## 5. Where decisions land, per host

| Host | Store the view writes | How akuko reads it | Reader |
|---|---|---|---|
| **A** claude.ai artifact | DB collection `decisions`, **one row per decision**: `db.collection("decisions").doc(d.id).set(d)` | The agent lists `decisions` with the **ArtifactData** tool (rows `{id, data, version, updatedAt}`) | `decisions/artifact-db.ts` |
| **B** Claude Code | `<project>/decisions.jsonl`, one decision per line | `readDecisions()` reads the file | `decisions/jsonl.ts` |
| **C** Ikenga | `window.parent.postMessage({__iyke: true, kind: "state", payload: {key: "akuko.decisions", value: [every decision this page holds]}}, "*")` | The agent runs `iyke iframe-state <pane>` and **mirrors** what it finds into `decisions.jsonl` | `decisions/ikenga.ts` |

**Host A.**

- Publish the view with `capabilities: {db: {rules: [{path: "", read: "view", write: "owner"}, {path: "decisions", read: "view", write: "interact"}]}, user: {}}`.
  - Reviewers (Contributors and up) can add decisions.
  - Only the owner (the agent's user) writes `akuko/project` and `akuko/conformed`.
- Add `assets: {}` only if the view uploads files.
- The agent writes `akuko/project` with `if_version` (compare-and-swap).
- Keep the project doc and each decision in their own documents. A per-document size limit is unverified, so never put all decisions in one doc. A view that needs big lists (shots, assets) can get them in their own collections.
- An `add()` row with its own row id is read too: the decision id is `data.id`.
- **The agent must load ArtifactData explicitly** (ToolSearch). It is often deferred, sometimes absent, and named differently between chats. Detection's `artifactDb` is not reliable on A.

**Host B.**

- A view opened as a local file can't write files. The writer keeps decisions in its outbox, and the page shows a visible **"Copy decisions for akuko"** control (`data-akuko-export`).
- The person pastes the copied lines into chat. The agent appends them as given: `node --experimental-strip-types decisions/cli.ts append <project> -` (it validates and de-duplicates).
- A B project can also publish its board as a claude.ai artifact (the desktop app has ArtifactData) and use store A.

**Host C.**

- `art.state` is **not** the store. Per the shell's source (`shell/src/lib/artifact/bridge.ts`), it is iframe localStorage the agent can't read, and the shell's injected `art` has no `publishState`. Both facts come from source: the runtime checks for them (G-HOST C4(a)/(c)) were not run.
- What *was* observed: a raw bridge post reaches `iyke iframe-state` (C4(b)), and a pane reload clears it (C5). The plan's "decisions land in `art.state`" is replaced by the raw bridge post above.
- The shell keeps only the latest value per key, so the page posts its whole outbox every time, and again on load when the outbox is not empty. A page that posts an **empty** `akuko.decisions` list with nothing decided fails `empties-ikenga-store`.
- A pane reload clears that state, so the agent mirrors to `decisions.jsonl` on every read. The mirror is the durable store.
- **Remount finding (live check, Ikenga 0.31.2).** After every decision the pane re-mounts the page, and the page's localStorage outbox does not survive the remount. The v1 writer then re-posted on load, sending an **empty** list that overwrote the shell's latest value for `akuko.decisions` before any agent read it: the decision was lost. Writer v2 never posts an empty list on load (§Decision writer), so the last non-empty post stays in the shell until the next decision or the agent's read. **v2 does not close the gap fully:** with the outbox wiped by each remount, the next decision posts a list holding only itself, which replaces the one before it in the shell. Until the shell keeps iframe storage across a remount, the agent reads (`iyke iframe-state`) and mirrors after each decision, and a person deciding several units in a row on host C may lose all but the last. The root cause (remount on decision, no persistent iframe storage) is a shell issue, owned by WP-16.

Approvals typed in chat: on any host, the person can reply in chat with exactly `approve <amount> <CURRENCY>` (the spend gate's line asks for it, e.g. `approve 0.36 USD`) or exactly `approve <unit id>` (one unit per reply). The agent records that one reply in the host's store with `view: "chat@1"`, `by: "you"` and `text` = the reply. It never infers an approval from "yes", "go ahead" or "approve all". See §8 for what folding accepts from that source.

## 6. Renderer rules

| Rule | What it says | What check-view enforces |
|---|---|---|
| **R1** Only a person approves | No auto-approve, pre-tick or batch approval; one explicit action per unit | Nothing is written while the page opens and idles, **on every host** (claude.ai, Ikenga and a local file, so a page that behaves differently where it runs is caught): the page's timers, animation frames, `Date.now()` and `performance.now()` are fast-forwarded ten minutes, and pointer moves, scrolls, wheel and touch, focus, tab hide/show, leaving the page (`visibilitychange` to hidden, `pagehide`, `beforeunload`, `unload`) and common key presses must write nothing. The check runs with a browser user agent and `window.chrome`, and `IntersectionObserver` / `ResizeObserver` report every observed element at once, on screen and sized, so a page cannot behave differently under it (`auto-approve`, `decision-without-action`). **Every** clickable element is clicked, one at a time, on claude.ai and in Ikenga, and ten minutes of the page's clock run after each click, so a write it schedules for later is the click's; each click fires the events a real click fires (`pointerdown`, `mousedown`, focus, `pointerup`, `mouseup`, `click`): one not marked `data-akuko-action` writes nothing (`unmarked-control-writes`; a composer's `[data-akuko-submit]` may write the one decision it was opened for). Every unmarked `select`, checkbox, radio and range is also set to each of its values, with `input` and `change`, and every unmarked element is double-clicked; every view, field, card and the page body itself is single-clicked too: none of these writes anything (`unmarked-control-writes`); a marked one writes at most one decision, for its own unit, with its own action (`writes-other-unit`, `batch-approve`, `wrong-action`). No `data-akuko-action` control without a single `data-akuko-unit` (`batch-approve`); no approval checkbox ticked at load (`pre-ticked`); no decision signed with an agent name (`signed-by-agent`) |
| **R2** Money is never hidden or rounded | Every paid job shows its estimate, the cap, what is spent, what is left if you approve | Each amount is present, visible and exactly equal to the data as the spend gate prints it, to at most four decimals (`hidden-estimate`, `hidden-money`, `rounded-money`, `wrong-money`). Hidden means any of: `hidden`, `aria-hidden`, `inert`, a closed `<details>`, `display:none`, `visibility:hidden`, `content-visibility:hidden`, opacity ≈ 0 (also compounded down the tree, or through `filter: opacity()`), visually-hidden 1px boxes, off-screen positioning (≤ −999px through `left`/`top`/…, a negative margin, `translate()` or `text-indent`), `clip`/`clip-path` that removes it, `transform: scale(0)`, a height or width under 8px with overflow hidden on it or any ancestor, `font-size` 0, transparent text colour, or text the colour of its background (contrast under 1.5:1). Values set through custom properties (`font-size: var(--x)`) are resolved first. The spend gate is visible while a job waits (`hidden-spend-gate`); `approve-spend` text names the amount shown (`spend-amount-not-bound`) |
| **R3** A "your move" summary is always visible, derived from data | | The view exists (`no-your-move`) and is visible (`hidden-your-move`); its counts equal the data on the fixture **and** on a changed copy of it, and drop after an approval (`your-move-not-derived`) |
| **R4** Decisions only through the decision format | Never edit `akuko.json` from the view | The fake host records every write: any DB write outside `decisions/<id>`, any non-GET `fetch`/XHR, a bridge post under another key, or an artifact self-publish fails (`writes-project`); a static scan catches `writeState(`, file writes and `"akuko/project"` writes. A view embeds no frame: an `<iframe>`, `<frame>`, `<object>` or `<embed>` in its markup, or one it creates while it runs, fails `iframe-in-view` (its code runs where the check cannot see) |
| **R5** Readability floor and keyboard access (`designs/_spec.md`) | Body ≥ 14px, labels ≥ 12px, contrast ≥ 4.5:1; every control keyboard-reachable and focus-visible; reduced motion respected | No text under 12px in style sheets, inline styles or style strings in scripts, in any unit (px, pt, em, rem, %, vw, vh, keywords, unitless 0, the `font:` shorthand), also through a custom property, judged by the smallest value the page ever gives it (`text-below-floor`). SVG text is exempt: rules for `svg`/`text`/`tspan`, or a class the page puts on an `<svg>`, are sized in viewBox units. Every decision control focusable (`not-keyboard-reachable`); a `:focus-visible` style (`no-focus-style`); `prefers-reduced-motion` when the page animates (`no-reduced-motion`). **By eye:** contrast and the 14px body |

It also checks the contract itself:

- the manifest validates;
- an inlined decision writer is the current canonical one (`stale-writer`, §Decision writer);
- every required view and field is there;
- statuses match the data;
- every control in §4 exists;
- each one writes a schema-valid decision with the right action, unit, stage and `view`;
- undo names the decision just made;
- a script tag selects its shot;
- in Ikenga the decision reaches the bridge post;
- with no host store it stays in the outbox, with a copy control.

The page's scripts run inside jsdom with fake host stores, so nothing leaves the machine. Only check views you would open in a browser anyway.

## 7. Spend: binding an approval to the amount shown

`Decision` has no amount field (and is frozen). So an `approve-spend` carries the amount in `text`, in the exact words the spend gate's confirmation line asks for: `approve <amount> <CURRENCY>`. The amount is printed as the gate prints money (`String(Number(n.toFixed(4)))`), e.g. `approve 0.36 USD`.

The amount is the job's bound: `approved_max` when set, else `estimate`. Folding passes the decision to `spend/gate.ts#canApprove(project, jobId, decision)`, which refuses with `approval-mismatch` when:

- the text has no amount;
- the text names another currency;
- the text names **less** than the job's current bound *as printed* (`money(bound)`, the very words the gate asked for, so an estimate of 0.41254 is approved by `approve 0.4125 USD`). This catches a stale approval after `quote()` raised the estimate.

The first word may be any case (`Approve 0.36 USD`); the currency code may not.

The person then sees the new amount and approves again. Approving more than the bound is fine: the gate still never runs above the bound.

## 8. Conformance and provenance (R-12)

- **Conformed views.** `node scripts/check-view.mjs <view.html> --record <conformed.json>` adds `{view: "<id>@<version>", sha256: <conformance hash>, checked_at, checker: "check-view@2"}` for each file that passes. The list lives:
  - on B/C in `<project>/views/conformed.json`, plus the skill's own `views/conformed.json` for shipped views (the default board, WP-07b);
  - on A in the DB doc `akuko/conformed`, written by the owner only.
- **The conformance hash** (`scripts/check-view/hash.mjs#conformanceHash`, re-exported as `decisions/conformed.ts#viewHash`) is the sha256 of the page with the **content of its `<script type="application/json" id="akuko-project">` block removed**, the block found exactly as §1 says (one real opener; comments ignored; it ends at the first `</script`, so code after an early `</script >` is hashed). If the block is missing or not exactly that, nothing is removed: the raw page is hashed (fail closed), and check-view fails `bad-project-block`. check-view injects its fixture through the same finder. That block is what the publisher fills (§1), so a page checked with the fixture still conforms when it is published with the real project; every other byte counts: scripts, controls, CSS, the manifest, comments. check-view `--record`, `isConformedHtml()` and every host's publish gate use this one function. `check-view@2` introduced it; `check-view@1` hashed the raw page, so its entries no longer match and must be recorded again (an `@1` entry may be replaced by re-recording the same `id@version`).
- **Before publishing** a view that writes decisions: check it, record it, and publish only a page whose conformance hash is on the list (`decisions/conformed.ts#isConformedHtml`). Change the page → bump `version` → check again.
- **The hosts enforce this (C8).** Every host's `publishView()` (`hosts/shared.ts#assertPublishable`) refuses a view that writes decisions unless its conformance hash is on the skill's `views/conformed.json` or the project's list: `<project>/views/conformed.json` on B and C, the board's `akuko/conformed` doc on A. A missing list counts as empty. The error names the view's `id@version` and says to run `check-view --record`. "Writes decisions" is one predicate shared with check-view (`scripts/check-view/predicates.mjs#decisionWriteSigns`): a `data-akuko-action` control (or `dataset.akukoAction`), the decision writer (`akukoDecisions`), the outbox key (`akuko-outbox`), the Ikenga key `akuko.decisions` or an `__iyke` state post, an `add`/`set`/`update`/`delete` on the `decisions` collection or a `decisions/<id>` doc, or a manifest saying `writes_decisions: true`. HTML comments don't count, and **reading** decisions (`collection("decisions").get()`) is not writing them. Anything else is read-only and publishes freely, with no record. The predicate is static: a page that hides its writes (a key built at run time) gets past the gate, which is why check-view also watches what a page does (§10) and the gate is a guard against honest mistakes, not a sandbox.
- **One id@version, one page.** `--record` refuses to replace an `id@version` already recorded (by `check-view@2`) for different HTML: bump `version`. check-view fails a page with `id-collision` if it reuses, for different HTML, an `id@version` already recorded, or if it takes the **id** of a view the skill ships (any id on `views/conformed.json`, its fixtures `test-board` and `board-b-instrumented`, and `default-board`) at a version not recorded for this very page.
- **Recording the skill's own views: `--ship`.** A new version of a shipped view (or the first one) is checked and recorded with `node scripts/check-view.mjs views/default-board.html --ship views/conformed.json`. `--ship` records **only** into the skill's own `views/conformed.json` (any other path is refused, exit 2; project views use `--record <project>/views/conformed.json`) and lets the page take a shipped id at a **new** `id@version`. It still fails an `id@version` already recorded there for different HTML (bump `version`), and it refuses `freehand:` ids. Without `--ship`, no page can take a shipped id, so a freehand or project view can never borrow the default board's record. To re-record a page after the hash change: run the same `--ship` (or `--record`) command on the unchanged page; its `check-view@1` entry is replaced.
- **Which lists folding reads.** `decisions/cli.ts` always reads the skill's shipped `views/conformed.json`, plus `--conformed` (default `<project>/views/conformed.json`). A missing file counts as an empty list and is named in the output's `warnings`.
- **Folding** (`decisions/fold.ts`) accepts `approve`, `approve-spend` and `undo` only when:
  - `view` is on the conformed list (or is the built-in `chat@1`);
  - `by` is not an agent name (`agent`, `akuko`, `claude`, `assistant`, `system`, `ai`, `bot`, `llm`, alone or as a prefix like `claude-code` / `agent:x`).

  `note`, `request-changes` and `decline-spend` are accepted from any view: they never approve anything.
- **`chat@1`** is a person's chat reply written down by the agent. It is accepted only in the exact words akuko asks for (the first word in any case):
  - for `approve-spend`, the text is exactly `approve <amount> <CURRENCY>`, and `canApprove` then binds the amount;
  - for `approve`, the text is exactly `approve <that decision's unit id>`, one record per unit;
  - **`undo` is never accepted from chat** (`chat-undo`): only a checked view can undo.

  This rests on the agent being honest about what the person typed, exactly as anything in chat does. It is the one approval path that doesn't come from a page.
- **Rejected decisions stay visible.**
  - They stay in `akuko.json.decisions[]`.
  - They are listed in the fold report, which `review` tells the person.
  - Their unit gets a comment `{author: "agent", text: "Not applied: <why>"}`.
  - A unit rejection is final: a view conformed later does not revive it. The person approves again.
- **Limits.** `view` is self-reported by the page, so provenance stops honest mistakes: an unchecked agent-built view, or an agent approving for the person. It does not stop a page deliberately forging a conformed id. On claude.ai the DB rules, and in Ikenga the pane, decide who can write at all.

## 9. Folding

Rules: `lib/state.md` §Decision folding. Code: `decisions/fold.ts`. CLI for every host: `decisions/cli.ts`.

## 10. Running the check

```bash
node scripts/check-view.mjs views/__fixtures__/board-b-instrumented.html     # PASS
node scripts/check-view.mjs views/__fixtures__/bad-*.html                     # each FAILs, with the reason
node scripts/check-view.mjs views/__fixtures__/readonly-cast-sheet.html       # SKIP (read-only, not applicable)
node scripts/check-view.mjs my-view.html --project path/to/akuko.json --json
node scripts/check-view.mjs my-view.html --record <project>/views/conformed.json
node scripts/check-view.mjs views/default-board.html --ship views/conformed.json  # the skill's own views (§8)
```

Exit code 0 only if every file passes or is skipped.

**Read-only views are skipped.** A page whose manifest says `writes_decisions: false` and that shows no sign of writing decisions (the predicate the publish gate uses, §8; HTML comments aside) is opened on every host (claude.ai, Ikenga, a local file), left idle with ten minutes of its clock, and has everything clicked, set, double-clicked and its clock run again on each host. It must also embed no frame. If nothing is written (no decision in any store, no project write), it prints `SKIP <file> (<id@version>) · read-only (not applicable)` and counts as a pass; `--record` never records it. A page that says `writes_decisions: false` but shows a sign of writing fails `read-only-writes` at once. If anything is written, the page fails with `read-only-writes` and is held to the whole contract: a manifest can't buy a page out of the check (`bad-readonly-writes-decision.html`).

`scripts/check-view.test.ts` pins:

- the two passing fixtures, and the skipped read-only one (`readonly-cast-sheet.html`);
- the reason each bad fixture fails;
- that removing one mark from the instrumented board makes it fail.

`scripts/check-view/hardening.test.ts` pins the decision writer v2 guard, `stale-writer`, and each way of hiding text on small pages, without a whole check run.

| Fixture | Breaks | Expected failure |
|---|---|---|
| `bad-hidden-estimate.html` | R2 | `hidden-estimate` |
| `bad-auto-approve.html` | R1 | `auto-approve` |
| `bad-no-your-move.html` | R3 | `no-your-move` |
| `bad-writes-project.html` | R4 | `writes-project` (DB update of `akuko/project`, `PUT akuko.json`) |
| `bad-pre-ticked.html` | R1 | `pre-ticked` |
| `bad-batch-approve.html` | R1 | `batch-approve` |
| `bad-rounded-money.html` | R2 | `rounded-money` |
| `bad-typed-summary.html` | R3 | `your-move-not-derived` (on the changed project) |
| `bad-signed-by-agent.html` | R1 / R-12 | `signed-by-agent` |
| `bad-transparent-estimate.html` · `bad-offscreen-estimate.html` · `bad-zero-font-estimate.html` · `bad-scaled-estimate.html` | R2 | `hidden-estimate` (transparent ink; `left: -9999px`; `font-size: 0`, also `text-below-floor`; `scale(0)`) |
| `bad-clipped-spend-gate.html` · `bad-collapsed-spend-gate.html` | R2 | `hidden-spend-gate` (`clip-path: inset(100%)`; height 0 + overflow hidden) |
| `bad-tiny-text.html` | R5 | `text-below-floor` (6pt, 0.5vw) |
| `bad-timer-auto-approve.html` · `bad-mousemove-auto-approve.html` · `bad-microtask-auto-approve.html` · `bad-keyboard-approve-all.html` · `bad-ua-sniff-auto-approve.html` | R1 | `auto-approve` (after 1.5 s; on pointer/scroll/focus; in a microtask; on the `a` key; unless the user agent says jsdom) |
| `bad-unmarked-approve-all.html` · `bad-select-approves.html` | R1 | `unmarked-control-writes` |
| `bad-decline-approves-spend.html` | R1 / R2 | `wrong-action` ("Not now" writes an approve-spend) |
| `bad-approves-other-unit.html` | R1 | `writes-other-unit` |
| `bad-select-change-approves.html` | R1 | `unmarked-control-writes` (an unmarked dropdown approves on `change`) |
| `bad-pointerdown-approve-all.html` | R1 | `batch-approve`, `unmarked-control-writes` (the first `pointerdown`/`mousedown` approves everything) |
| `bad-unload-approve-all.html` | R1 | `auto-approve` (approves everything on `beforeunload`/`pagehide`) |
| `bad-var-zero-font-estimate.html` | R2 / R5 | `hidden-estimate`, `text-below-floor` (`font-size: var(--z)`, `--z: 0px`) |
| `bad-raf-auto-approve.html` | R1 | `auto-approve` (after 150 animation frames) |
| `bad-dblclick-approves.html` | R1 | `unmarked-control-writes` (double-clicking a shot approves it) |
| `bad-readonly-writes-decision.html` | R1 | `read-only-writes` (says `writes_decisions: false`, writes the Ikenga store directly) |
| `bad-hostc-auto-approve.html` | R1 | `auto-approve` (only when `window.__ikenga_host__` is set) |
| `bad-delayed-other-unit.html` | R1 | `writes-other-unit` (approving one shot approves another five seconds later) |
| `bad-observer-auto-approve.html` | R1 | `auto-approve` (from an `IntersectionObserver` callback) |
| `bad-card-click-approves.html` | R1 | `unmarked-control-writes` (clicking a shot card, not a control) |
| `bad-early-close-project-block.html` | R1 | `auto-approve` (code after `</script >` closing the project block) |
| `bad-project-block-decoy.html` | §1 / §8 | `bad-project-block` (a second opener quoted in a `<textarea>`) |
| `bad-empties-ikenga-store.html` | §5 | `empties-ikenga-store` (posts an empty list on load in Ikenga) |
| `bad-iframe-in-view.html` | R4 | `iframe-in-view` (a zero-size iframe whose script approves through the parent) |
| `bad-readonly-hostc-delayed-post.html` | R1 | `read-only-writes` (no static sign; in Ikenga, half a second after a click) |

All but the first nine and the two read-only liars are the G-VIEW reviewer's variants of `tiny-board.html` (the later ones from the WP-07a2 hardening pass and its review), kept so the check can never lose them. Every bad fixture has its own view id.

---

## §Manual decision-store check

**For the person (G-VIEW, user-attested).** About 10 minutes per host. Each step says what to do and what to expect, with a line for what you saw. Copy this section into a reply with the `Observed:` lines filled in. The test page is `views/__fixtures__/tiny-board.html`: it is small, conforming, and already holds *The Beating*.

### A — claude.ai (artifact database)

Every file is pinned to commit `071189ff52fd0c753875de3a30580e548a95c6e0` of the public repo, so the check runs against exactly the code that was reviewed. Steps 1–2 happen on claude.ai. Steps 3–5 run from **Claude Code with the ArtifactData tool** (the desktop app has it; G-HOST check B4), in a checkout of `ikenga-hq/ikenga-pkgs` at `071189ff52fd0c753875de3a30580e548a95c6e0` or later. That is the main path, because folding needs the whole skill and its dependencies.

1. In a claude.ai chat, ask: *"Fetch `https://raw.githubusercontent.com/ikenga-hq/ikenga-pkgs/071189ff52fd0c753875de3a30580e548a95c6e0/packages/skills/akuko/skills/akuko/views/__fixtures__/tiny-board.html` and publish it unchanged as an artifact named akuko-store-check, with capabilities `{db: {rules: [{path: "", read: "view", write: "owner"}, {path: "decisions", read: "view", write: "interact"}]}, user: {}}`."*
   Expected: an artifact link. The page shows "Your move: 2 shots waiting for you · 1 spend decisions · 2 bible items".
   Observed: ______
2. Open the artifact, signed in. Click **Approve sc2_sh4**. Then click **Add a note**, type `store check`, and press **Send**. Then click **Undo note** (the Undo control reverses the latest decision on sc2_sh4).
   Expected: "Your move" drops to 1 shot waiting after the approval; the note appears in the thread, then disappears; no error.
   Observed: ______
3. In Claude Code, ask: *"Load your ArtifactData tool (use ToolSearch if it is deferred), list the `decisions` collection of <the artifact link>, and save the result as rows.json."*
   Expected: three rows, each `{id, data, version, updatedAt}`. `data` is an approve, a note (`store check`), and an undo whose `undoes` is the note's id. Each has `view: "test-board@1"` and `by` your viewer id (`u_…`).
   Observed: ______
4. In the checkout, from `packages/skills/akuko/skills/akuko/`, write `conformed.json` = `{"format":"akuko-conformed-views","version":1,"views":[{"view":"test-board@1"}]}`. Then run `node --experimental-strip-types decisions/cli.ts fold-file --project fixtures/the-beating/akuko.json --rows rows.json --conformed conformed.json --out folded.json` and look at the report and shot `sc2_sh4` in folded.json.
   Expected:
   - the report lists 3 new decisions; `applied` is the approve alone (the note was undone in the same batch, so it never lands); `rejected` is empty;
   - `sc2_sh4` is `approved`, with one trail comment `Status: pending-review → approved` and **no** `store check` comment.
   Observed: ______
5. Run the same command again with `--project folded.json --out folded2.json`.
   Expected: `"changed": false`; nothing new.
   Observed: ______

**Optional: steps 3–5 on claude.ai itself.** Step 3 works there: load ArtifactData with ToolSearch and list the collection. That alone shows the agent can read the board's rows on host A. Folding there needs the **whole skill** fetched into the workspace (`decisions/`, `schema/`, `spend/`, `providers/`, `hosts/`, `views/`, `fixtures/`), plus its npm dependencies `zod` and `@ikenga/studio-schema`. The latter is not yet published outside the monorepo; bundling is WP-20. Fetching `decisions/` alone does not run.

### C — Ikenga (bridge post + jsonl mirror)

Needs a running Ikenga whose file allowlist includes the folder holding the page (Ikenga ≥ the fs-roots fix, or a temporary root). Use a scratch project folder holding a copy of `fixtures/the-beating/akuko.json`.

1. Open `tiny-board.html` in an Ikenga artifact pane (or the instrumented board, `board-b-instrumented.html`).
   Expected: the page renders, and the footer says "Your decisions reach akuko on its next action" (the Ikenga host was detected).
   Observed: ______
2. Click **Approve sc2_sh4**. In a terminal run `iyke iframe-state <pane>` (or `GET /iyke/iframe-state`) and save the output to a file.
   Expected: the state has `akuko.decisions`, an array holding one decision with `action: "approve"`, `unit: "sc2_sh4"`, `view: "test-board@1"`.
   Observed: ______
3. Run `node --experimental-strip-types decisions/cli.ts fold <scratch project> --iframe-state <that file> --conformed <a list naming test-board@1>`.
   Expected: the report applies the approval; `<scratch project>/decisions.jsonl` now has one line; `akuko.json` shows `sc2_sh4` approved.
   Observed: ______
4. Reload the pane (`POST /iyke/refresh`, or close and reopen it). Run `iyke iframe-state <pane>` again.
   Expected: either the state is empty, or the page re-posted its outbox on load and the approval is back. Either way, `decisions.jsonl` still has the line.
   Observed: ______
5. Run the fold command again without `--iframe-state`.
   Expected: `"changed": false`. The mirror alone carries the decision.
   Observed: ______

**Report:** paste the filled-in steps to the orchestrator. Any "Expected" that doesn't hold is a G-VIEW finding: say which step.
