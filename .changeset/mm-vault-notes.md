---
"@ikenga/pkg-mattermost": minor
---

Post founder notes for sender credential updates (plan WP-K / decision K-7): add optional `outboxApprovals.vaultNotes` configuration block to poll `vault.events` from the box sender approvals socket. When credentials are set, replaced, or cleared in Settings -> Integrations, the bridge posts a short note to the configured channel with the actor username, action, group label, and timestamp, with sender-provided text escaped against hostile markdown/mentions, cursor persisted across restarts (accepted only if a safe integer that does not go backwards; first-run drain bounded), at-least-once delivery deduplicated by event id, no replay of historical events on initial run, and soft failure on sender errors or unconfigured vault.
