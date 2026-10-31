---
"@ikenga/pkg-outbound": patch
---

Never show fixture/demo data when mounted in the shell and database read fails (e.g. shared project refusing owner-only DB reads). Fixtures are only used in standalone dev (`isStandalone()` true). When mounted and read fails, surface an error state with "Can't read this project's queue here." and an action navigating host to `/outbox/approvals`.
