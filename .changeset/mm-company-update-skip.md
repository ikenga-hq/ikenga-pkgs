---
"@ikenga/pkg-mattermost": patch
---

Never post the founder-only monthly `company-update` draft (investor figures) as an outbox approval card: the card flow now skips it by id, `actionId` or `sourceKind` (any casing, whitespace, underscore or space variant), without rendering, storing, acking or posting about it, so it is approved only in the Ikenga Outbox; the newsletter draft still gets its card.
