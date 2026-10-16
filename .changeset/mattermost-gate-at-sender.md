---
"@ikenga/pkg-mattermost": patch
---

Gate: match `allowedUsers` against Mattermost's `@`-prefixed `sender_name`. A username listed with or without the `@` was never matched, so every post from that user was refused as `user_not_allowed`.
