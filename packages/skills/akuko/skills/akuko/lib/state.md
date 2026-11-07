# akuko — project state

Every action reads this before it writes. The format itself is `../schema/akuko-project.ts` (`akuko.json`, one document per project); cross-references are checked by `../schema/integrity.ts`. This file says how actions **use** that state.

> **Sections are owned.** WP-02 pre-created every section so wave-2 packages fill only their own (R-13). Each section names its owner. Don't edit a section you don't own; add a short note under **Open questions** instead.

---

## Reading and writing the project

*Owner: WP-02.*

- Read and write only through the host adapter (`../hosts/`, `lib/hosts.md`): `readState()` validates against `AkukoProjectSchema`; `writeState()` validates again and refuses an invalid project. On B and C the write is atomic (temp file + rename).
- **Views never write the project.** They write decisions; actions fold them (§Decision folding).
- **Bytes never go in `akuko.json`.** `storeAsset()` stores the file and returns an `Asset` with `file.uri`; the action appends it to `assets[]` and calls `writeState()`.
- Record the host on every run: `host = toHostRecord(level, capabilities)` (`../hosts/detect.ts`).
- Set `project.updated_at` and each touched unit's `updated_at` when writing.
- Read–modify–write in one step: read, change, write. Don't hold a project across a pause for review — re-read after the person comes back.

Project folder (B and C; on A the same paths are asset names):

```
<project>/
  akuko.json                 project, stages, units, ledger, budget
  decisions.jsonl            decisions from local / Ikenga views (WP-07a)
  script/   source.md · screenplay.fountain
  bible/    characters/<id>/refs/*  locations/<id>/refs/*  style/
  board/    panels/<shot>-<stage>.png · beatboards/*.html
  motion/   <shot>/*.mp4 · scenes/<shot>/index.html
  audio/    vo/*.wav · words.json · music/ · sfx/
  cut/      timeline.json · exports/*.mp4
  views/    published local views (default board, freehand views)
```

## Stages

*Owner: WP-02 (the gating rule). Each stage's own entry is filled by the WP that owns its action — see the table.*

Nine stages, `STAGES` in the schema. `stages.<id>.state` is one of `locked · not-started · in-progress · waiting-spend · in-review · approved`.

Gating rule: a stage is `locked` until every earlier stage is `approved`. An action refuses to run on a locked stage and says which earlier stage is waiting. `current_stage` is the earliest stage that is not `approved`.

| # | Stage | Action | Entry filled by |
|---|---|---|---|
| 0 | intake | `intake` | WP-04 |
| 1 | breakdown | `breakdown` | WP-04 |
| 2 | sketch | `board` | WP-21 |
| 3 | bible | `bible` | WP-05 |
| 4 | keyframes | `keyframes` | WP-22 |
| 5 | motion | `motion` | WP-10 · WP-11 |
| 6 | sound | `sound` | WP-12 |
| 7 | assemble | `assemble` | WP-13 · WP-15 |
| 8 | export | `export` | WP-15 |

### 0 intake
*Action: `actions/intake.md`; code `../breakdown/intake.ts`. Free.*

- Produces `script/source.md` (the story as given) and, unless the person chose "break it down directly", `script/screenplay.fountain`. Both are recorded as assets (`script-source`, `script-screenplay`; stage `intake`, kind `other`) at `pending-review`, and `script.source` / `script.screenplay` point at them.
- Stage state: `in-progress` while working, `in-review` once the files are recorded. Intake is `approved` when a person approves every intake asset (assets are units like any other, so decision folding handles them; folding then unlocks breakdown).
- For prose the person chooses **each time**: adapt to a screenplay first (`adapt`), or break the prose down directly (`direct`). The choice is not stored; `script.screenplay` is absent on the direct route.
- Recording is idempotent: re-running `completeIntake()` with the same files adds no second asset.
- Never re-adapts: once `shots[]` is not empty, the action stops and does not replace the source (a rule of `actions/intake.md`, not enforced in code).

### 1 breakdown
*Action: `actions/breakdown.md`; film rules `../profiles/film/breakdown.md`; code `../breakdown/`. Free.*

- Opens when intake is `approved`.
- Produces `scenes[]` (`sc<N>`), `script.beats[]` (`sc<N>_b<K>`), `shots[]` (`sc<N>_sh<M>`, at most 10 s and 2 principals) and a bible checklist (`bible.characters|locations|styles[]`, ids `char_*` / `loc_*` / `style_*`). All are stage `breakdown`, status `pending-review`; the stage is `in-review`.
- Writes `[[sc<N>_sh<M>]]` notes into `script/screenplay.fountain` (or `script/source.md` on the direct route).
- Ids are allocated by code, never by the agent; numbers are never reused; a shot inserted later takes a letter (`sc3_sh2A`).
- Idempotent: if `scenes[]` or `shots[]` is not empty, nothing is created and only missing tags are added. Lint errors (over 10 s, over 2 principals, no duration, no action, no scene) stop the write; a shot under 5 s or a non-canonical id is only a warning.
- Hand-off: the checklist entries are units of stage `breakdown`, so the breakdown is `approved` only when every shot **and** every checklist entry is approved. The bible stage (WP-05, not built yet) then starts from the approved entries; the sketch board reads `shots[]`.

### 2 sketch
*WP-21 fills this.*

### 3 bible
*WP-05 fills this.*

### 4 keyframes
*WP-22 fills this.*

### 5 motion
*WP-10 / WP-11 fill this (Phase 2).*

### 6 sound
*WP-12 fills this (Phase 2).*

### 7 assemble
*WP-13 / WP-15 fill this.*

### 8 export
*WP-15 fills this (Phase 3).*

## Status transitions

*Owner: WP-02 (the rules below). WP-07a adds the decision-driven rows in §Decision folding; WP-03 adds the spend-gate rows for `waiting-spend` in `lib/spend.md`.*

Unit status (`UnitStatus`): `pending · draft · pending-review · needs-rework · approved`.

| From | To | Who | When |
|---|---|---|---|
| `pending` | `draft` | action | starts producing the unit |
| `draft` | `pending-review` | action | the unit's output exists (stored via `storeAsset`) |
| `needs-rework` | `draft` → `pending-review` | action | revising after a request for changes; add a "Revised: …" comment |
| `pending-review` | `approved` | **person only** | an `approve` decision, folded |
| `pending-review` | `needs-rework` | **person only** | a `request-changes` decision, folded |
| any | previous value | **person only** | an `undo` decision, folded |

Hard rules:

- **No action writes `approved`.** Only folding a person's `approve` decision does.
- An action never moves a unit backwards except to revise one a person sent back.
- A stage becomes `approved` only when every unit in it is `approved`; it becomes `in-review` when its units wait for a person.

## Decision folding

*Owner: **WP-07a**. Code: `../decisions/fold.ts` (`foldDecisions`). Stores: `../decisions/{artifact-db,jsonl,ikenga}.ts`. View side: `../views/contract.md`.*

Every action starts by folding: `readDecisions(since?)` through the host adapter, then `foldDecisions(project, decisions, {conformed})`, then `writeState()` if `report.changed`. Then tell the person what the report says, including every `rejected` entry and every invalid record. Without code (host A), or from the shell, use `../decisions/cli.ts` (`fold` on B/C, `fold-file` on A; `actions/review.md`).

**What folds into what**

| Decision | Effect (when accepted) |
|---|---|
| `approve` | unit → `approved` (+ the person's comment if it has text) |
| `request-changes` | unit → `needs-rework` + the person's comment |
| `note` | the person's comment; status unchanged |
| `approve-spend` | `pending_spend[].status = 'approved'`, `.decision = <id>`; only if `canApprove(project, job, decision)` passes (budget, cap, **amount shown ≥ the job's bound**: `../views/contract.md` §7) |
| `decline-spend` | `pending_spend[].status = 'declined'`, `.decision = <id>` |
| `undo` | reverses exactly the decision named in `undoes` |

- **Comments.** A person's comment is `{ts: at, stage, author: by, text, decision: id}`.
  - Every status change folding makes also leaves a trail comment, `{author: 'agent', text: 'Status: <was> → <now>', decision: id}`. The trail is how `undo` knows the status the unit had just before that decision, even if an action revised it in between. Don't edit or delete trail comments.
  - Actions add their own "Revised: …" comments without a `decision` id, as before.
- **Stages.** When a stage's last unit is approved, the stage becomes `approved`. The next stage unlocks (`locked → not-started`) and `current_stage` moves on. If an undo un-approves a unit, its stage goes back to `in-review`.
- **Time.** `updated_at` on a unit and the project follow the decisions' `at`, never the clock.

**Properties**

- **Idempotent by decision id.** Pass everything the store holds every time if you like. Ids already in `decisions[]` are skipped, and a re-fold changes nothing.
- **Order-independent.** Decisions apply in one total order: `at` as an instant, then `id`. `decisions[]` is kept in that order. A decision that arrives late is slotted into its place: an older decision never overrides a later one on the same unit or job. The arrival order and the batching do not change the result.
- **`undo`.**
  - Reverses the named decision: its status change (back to the trail's `<was>`, repairing the trail if it was not the latest) and its comment.
  - An undo of an undo re-applies the original.
  - An undo must be later than its target and on the same unit.
  - An undo whose target hasn't arrived is not stored. It is reported as `unknown-target` and tried again on the next read. **Don't advance a `since` cursor past a read that reported `unknown-target`.**
  - An undo of a decision on a stage the unit has left, or of an approval whose job has run, is refused.
- **Only a person approves (R-12).** `approve`, `approve-spend` and `undo` count only when both hold:
  - `by` is not an agent name (`fold.ts#AGENT_AUTHOR`);
  - `view` is on the conformed-views list (`../decisions/conformed.ts`), or is `chat@1` in the exact words akuko asked for: `approve <amount> <CURRENCY>` for a spend, `approve <unit id>` for one unit (first word any case). A chat `undo` is always refused (`chat-undo`).

  Notes, requests for changes and declines are accepted from any view. No action, and nothing folding writes for itself, ever sets `approved`.
- **Rejected decisions stay visible.**
  - They stay in `decisions[]` (apart from unknown units and early undos, which integrity forbids storing).
  - They are listed in `report.rejected` with a reason. Tell the person.
  - Their unit gets a `Not applied: …` agent comment.
  - A rejected unit decision stays rejected. A refused `approve-spend` is visible as a waiting job whose latest decision is that approval. The person approves again.
- **Stale decisions.** A unit decision for a stage the unit has left (`stale-stage`), or on a unit with nothing produced yet (`not-reviewable`), is refused, with a notice.

**Cursors (`since`)** are per store. They only save reading; correctness never depends on them, and none is stored in `akuko.json`.

| Host | Store | Cursor |
|---|---|---|
| A | DB collection `decisions`, one row per decision | `db:<updatedAt>` of the newest row (rows at or after it are re-read) |
| B | `<project>/decisions.jsonl` | `jsonl:<byte offset>` after the last complete line (a half-written last line is left for next time) |
| C | `iyke iframe-state` → mirrored into `decisions.jsonl` | the mirror's `jsonl:<offset>`. Always mirror before reading: a pane reload clears the iframe state |

**Decision-driven status rows** (adds to §Status transitions)

| From | To | Who | When |
|---|---|---|---|
| `pending-review` / `needs-rework` / `approved` | `approved` | person | `approve` folded |
| `pending-review` / `needs-rework` / `approved` | `needs-rework` | person | `request-changes` folded |
| any | the trail's `<was>` | person | `undo` of that decision folded |
| `pending_spend` `awaiting-approval` / `declined` | `approved` | person | `approve-spend` folded and `canApprove` passed |
| `pending_spend` `awaiting-approval` / `approved` | `declined` | person | `decline-spend` folded (not after the job ran) |
| `pending_spend` `approved` / `declined` | `awaiting-approval` | person | `undo` of the spend decision folded (not after the job ran) |

## Open questions

*Anyone may append one line per question, with their WP id.*
