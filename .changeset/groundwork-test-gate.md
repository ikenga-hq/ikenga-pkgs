---
"@ikenga/skill-groundwork": patch
---

Add a deterministic test gate and a minimal Claude Code plugin manifest.

- `pnpm test` now runs `test_groundwork_state.py` plus a new `test_fence_integrity.py` fixture-plan suite: `write-region` changes only fenced bytes (hand-written prose around and between fences stays byte-identical), identical re-runs report `UNCHANGED` with every file's bytes and mtime untouched, and deliberately broken writers (whitespace-stripping, off-by-one end fence) are caught. CI runs it; `build:mirror` refuses to build the `ikenga-hq/groundwork` mirror unless it passes.
- `skills/groundwork/.claude-plugin/plugin.json` (layout A): the skill folder is now also a Claude Code plugin. `agents: []` keeps the `agents/*.md` brief templates from loading as plugin agents. No hooks module yet.
