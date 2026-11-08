---
"@ikenga/skill-akuko": patch
---

Fix the bible and key-frame commands failing with a missing-file error when run from outside the project folder. Reference images stored with project-relative paths are now read from the project folder, and a path that points outside it is refused.
