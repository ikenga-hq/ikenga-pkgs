---
"@ikenga/pkg-mattermost": patch
---

Outbox approval cards close with a plain reason when the sender answers `draft_not_approvable` (the draft was rejected, failed or already sent elsewhere), instead of staying open with a raw error code.
