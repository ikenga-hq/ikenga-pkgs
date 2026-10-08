---
"@ikenga/pkg-mattermost": minor
---

B3 approvals: a bot with an `approvals` block runs each thread turn in the daemon's read-only `plan` mode, posts the plan, and only a 👍 from a configured approver (deny by default, separate from `allowedUsers`) starts a second run in `approvals.actingMode` (`auto` by default). 👎, or no decision within `approvals.timeoutMs` (default 15 min), denies. Pending approvals are persisted (mode 0600) and survive a bridge restart, including their expiry. The Chi run has no pause-for-permission, so per-action prompts are not possible; the README says what the daemon enforces and what the bridge does.
