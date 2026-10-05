---
"@ikenga/pkg-engine-claude-code": patch
---

Stop dropping the session system prompt. `startSession` now sends `systemPrompt` to the host as `appendSystemPrompt` (the shell's `ClaudeOpts` name, which becomes `--append-system-prompt`), and also passes through `model` and `resumeSessionId`, which were dropped the same way. New optional `role` (`chi` | `pane` | `plan`) and `pluginDirs` session options are forwarded when set. Unset options are omitted, so existing sessions spawn unchanged.
