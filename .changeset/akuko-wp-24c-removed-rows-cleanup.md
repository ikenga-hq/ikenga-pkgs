---
"@ikenga/skill-akuko": minor
---

Rows that left the shot list no longer hold anything back. `listUnits` and `findUnit` take `{ includeRemoved: false }`, and a new `removedAt` in the schema says when a unit (or its owner) was removed. Bible and sound readiness, the sketch board, the beat boards, the continuity audit, the integrity film-overlap check and the check-view "your move" counts all skip removed units. A re-import that changes an approved bible entry's description sends it back to review with a note, as it already does for shots. Examples and tests now use invented ids and times.
