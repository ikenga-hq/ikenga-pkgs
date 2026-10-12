---
"@ikenga/skill-groundwork": patch
---

Security and docs review fixes. `scaffold --force` no longer destroys hand-written prose, registered IDs or generated fences (full wipe is now the explicit `--reset-all`). The explorer walk and status/plans-index reads no longer follow symlinks out of the plan folder or read non-regular files; scaffold no longer writes through a symlink; board/spec-state data is escaped for `<script>` (`--html-script-safe`, new `write-region --wrap-script`). issue-sync now asks before writing to a repo, uses a per-run temp file, and the README documents the commands the skill runs, security notes and a comparison.
