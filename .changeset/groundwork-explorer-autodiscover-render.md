---
"@ikenga/skill-groundwork": patch
---

Fix the explorer's auto-discovery of files registered after generation: discovered docs were given a `kind` outside the tree's groups and never re-rendered, so they never appeared. They now land in the tree (and the Gallery/Media lists) as soon as discovery completes.
