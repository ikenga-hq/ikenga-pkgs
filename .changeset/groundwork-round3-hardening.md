---
"@ikenga/skill-groundwork": patch
---

Fence handling is stricter and safer: re-running `init` no longer re-baselines a region you hand-edited, fence markers inside markdown code blocks are ignored, malformed or duplicated fences (and content that contains a marker line) are refused with a clear error and shown as `malformed` by `status`, and CRLF files keep their line endings. `orchestrate --emit-workflow` now renders the workflow script with a deterministic `emit-workflow` command that inserts every title, slug, gate and brief as a JSON literal and refuses invalid WP ids, tiers or missing briefs, and it needs an explicit merge confirmation before the orchestrator merges or runs `pnpm install`. The explorer and plans-index generators and the watcher also survive a malformed `.groundwork.json`, keep file modes, handle dash-leading paths and no longer drop edits made during a regenerate.
