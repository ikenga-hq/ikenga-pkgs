# @ikenga/pkg-engine-claude-code

Default engine adapter for Ikenga — wraps the `claude` CLI binary, parses its stream-json output, and persists sessions.

| | |
|---|---|
| Pkg id | `com.ikenga.engine-claude-code` |
| Kind | `engine` |
| Requires | `claude` on `$PATH` (set explicitly via the `claude_binary` setting) |
| Sessions | `/sessions`, `/sessions/by-agent/$agent`, `/sessions/$id` |

## Layout

```
pkgs/engine-claude-code/
├── manifest.json
├── src-tauri/src/
│   ├── claude/          # stream-json parser, jsonl reader, artifact watcher
│   └── commands/claude.rs
└── src/
    ├── chat/            # adapter contract + claude-cli/mock adapters, store, persist, ui
    ├── routes/sessions/ # /sessions tree
    └── shell/claude-config/
```

> **`src-tauri/` is an unbuilt snapshot.** It has no `Cargo.toml`, `tsconfig.json`
> excludes it, it is not in the npm `files`, and no CI job compiles it. The live
> code is the shell's own `src-tauri/src/commands/claude.rs` and
> `src-tauri/src/claude/session.rs` (ikenga-hq/ikenga). The snapshot predates
> the shell's WP-11 launch options (`appendSystemPrompt` →
> `--append-system-prompt`, `pluginDirs` → `CLAUDE_CODE_PLUGIN_DIRS`, `role`)
> and has not been updated to match. Treat the shell as the source of truth and
> resync or delete this copy at the cutover (`HISTORY.md`); don't patch it.

The chat adapter contract (`src/chat/adapter.ts` + `adapters/`) is the foundation for swapping engines. Today it ships only the `claude-cli` adapter; future engine pkgs (Codex, Aider, OpenAI Agents) will implement the same interface.

## Status

`v0.1.0` — initial snapshot carve from `ikenga-hq/ikenga`. The shell still owns these sources at `src/chat/`, `src/routes/sessions/`, etc.; this pkg is a parallel home for ongoing development. See `HISTORY.md` for the cutover plan.
