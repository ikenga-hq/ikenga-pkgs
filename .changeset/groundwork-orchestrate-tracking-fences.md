---
"@ikenga/skill-groundwork": patch
---

`orchestrate` now fills the work-package matrix, wave plan and critical path in `05-tracking.md`. `lib/state.md` already gave it those three fences, but the action never said to write them, so they kept their "No workstreams defined yet" placeholder. They are written through `write-region`, so a hand edit inside one is reported as skipped and kept, never overwritten without `--force`. Also corrects `actions/explorer.md`, which still said the explorer loads its libraries from a CDN; it has been fully offline since 0.7.
