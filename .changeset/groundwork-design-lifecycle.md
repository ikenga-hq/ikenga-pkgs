---
"@ikenga/skill-groundwork": minor
---

Track the design lifecycle — produce, review, lock, implement, verify — with the same
ID discipline as gaps, gates and work packages.

Designs used to live in two unlinked places: `designs[<path>]` held the lock on a file,
while `D-NN` in `ids` was allocated after the lock and never used again. Locking meant
hand-editing the anchor, which the skill forbids everywhere else. There was no unlock,
and nothing let a PR say which design it built. A plan that registered `D-NN` before
drawing any mockup showed zero designs on the board and the plans index.

`ids[D-NN]` is now the canonical design record. `designs[<path>]` stays as the variant
registry and links back with `design: "D-NN"`. New commands, all idempotent (a re-run
writes nothing):

- `register-design` links a variant file to a design.
- `design-lock` and `design-unlock` record the round; unlock also clears any verification.
- `register-design-impl` records which designs a WP implements, plus PR records.
- `design-verify` records a clean conformance pass.
- `design-migrate` links legacy anchors by `d-NN` filename token and lifts old
  file-level locks onto the ID.
- `design-data` emits the derived model.

Build status (`unbuilt` / `in_progress` / `implemented` / `verified`) is derived from
WP status, PR records and `verified_in`, never hand-kept. `board-data`, `status-data`,
`living-spec-data` and `plans-index-data` carry the model; existing keys keep their shape.
The board rail gets a per-design lifecycle card. The review action gains a design-review
finding shape (`D-NN · state · file:line`) and a design-conformance lens. `orchestrate`
now emits a `DESIGNS` brief field and a PR-body template with a required
"Designs implemented" line, and `WP_REPORT_SCHEMA` gains `designs_implemented`.
