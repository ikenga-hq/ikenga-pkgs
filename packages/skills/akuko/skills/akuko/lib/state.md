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
*WP-04 fills this.*

### 1 breakdown
*WP-04 fills this.*

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

*Owner: **WP-07a** — fills this section (folding order, idempotence by decision id, `undo`, `approve-spend` / `decline-spend` → `pending_spend`, comment author, "since" cursor per host store).*

Until it lands, `readDecisions()` throws `NotImplementedError` on every host. Actions catch it, skip folding, tell the person that decisions from a review surface can't be read yet, and must not invent a folding scheme.

## Open questions

*Anyone may append one line per question, with their WP id.*
