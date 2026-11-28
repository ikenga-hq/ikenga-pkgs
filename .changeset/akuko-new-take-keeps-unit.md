---
"@ikenga/skill-akuko": patch
---

akuko: a manual `ingest --new-take` now leaves the planned unit alone (its file, status and comments) and keeps the file as an extra take of its own (`<unit>-<stage>`, `-2`…, tag `extra-take`) waiting for review. An extra take is reviewed like any asset but never holds its stage open, and approving it does not replace the unit. It is also stored under a file name of its own, so it can no longer land on the unit's file.
