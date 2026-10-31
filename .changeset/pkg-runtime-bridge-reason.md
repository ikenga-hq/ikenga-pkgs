---
"@ikenga/pkg-content": patch
"@ikenga/pkg-research": patch
"@ikenga/pkg-agent-ops": patch
"@ikenga/pkg-tasks": patch
"@ikenga/pkg-sales": patch
"@ikenga/pkg-mail": patch
"@ikenga/pkg-strategy": patch
"@ikenga/pkg-finance": patch
---

Shared bridge: a refused `host.dbQuery` now throws an error carrying the host's `reason` and `code`, so a pkg can tell a permission refusal from other failures. Also adds a test hook (`setBridgeAppForTesting`). Moves the change made in outbound's vendored copy (#175) into `@ikenga/pkg-runtime`, the source every pkg vendors, which CI's dist drift check requires.
