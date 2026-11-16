---
"@ikenga/skill-akuko": minor
---

akuko: confirmed batch approval on the default board (`default-board@0.7`).

- **"Approve all N shots in P7"** on a one-part view and **"Approve all bible entries (N)"** in the Bible (rail and stage lens) open a confirm dialog that lists every unit and the count and says what it leaves out. Only the person's click on Confirm writes: one ordinary `approve` per listed unit, all with the same text ending ` · batch <uuid>`. Cancel, Escape and a click outside write nothing; nothing is pre-ticked, and no timer or page event opens or confirms it.
- A batch never includes a unit sent back (`needs-rework`) or an asset with no file. **"Undo batch (N)"** reverses the whole batch in one click, as one ordinary `undo` per approval.
- `views/contract.md` §4 "Batch approval" defines the pattern (marks `data-akuko-batch`, `data-akuko-batch-panel`, `data-akuko-batch-unit`, `data-akuko-batch-count`, `data-akuko-batch-confirm`, `data-akuko-batch-undo`), and R1 now allows a confirmed batch. The decision schema is unchanged. SKILL.md review rule 1, `actions/view.md`, `actions/review.md` and `lib/state.md` say the same.
- Folding accepts batch-tagged approvals like any other from a conformed view, and refuses one on a unit that was sent back or an asset with no file (`batch-ineligible`, with a notice), applying the rest.
- check-view opens, cancels, confirms and undoes every batch a view offers, on a copy of the fixture with parts, and fails `unconfirmed-batch`, `batch-unlisted`, `batch-ineligible`, `batch-incomplete`, `batch-count`, `batch-no-id` and `batch-undo`. New bad fixtures: `bad-unconfirmed-batch.html`, `bad-batch-ineligible.html`.

`default-board@0.8`: bible images can be sent back.

- Every reviewable bible image, bible entry, card and intake document gets **Request changes** ("Reopen · request changes" once approved) and **Add a note** beside its Approve, in the Bible column and the stage lens, with the shot's composer ("Send back to akuko"): one `request-changes` or `note` per unit, written only on the person's submit. **Undo** reverses the latest approval or send-back there. A unit sent back stays out of every batch.
- `actions/review.md`: a send-back may also be typed in chat, naming one unit and what should change (recorded as `request-changes`, `view: "chat@1"`). `actions/bible.md` §When a person sends an image back and `views/README.md` say how.
