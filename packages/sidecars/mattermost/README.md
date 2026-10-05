# com.ikenga.mattermost

Mattermost bridge sidecar for Ikenga (B1 read-only echo bridge).

## Overview

Connects to a Mattermost instance over WebSocket, receives post events, gates incoming messages based on `allowed_users` and `allowed_channels` (deny by default), and replies with an echo message over the Mattermost REST API (`POST /api/v4/posts`).

## Gating Rules (Deny by Default)

1. **Deny by default:** If `allowed_users` or `allowed_channels` is empty, all messages are dropped.
2. **User gating:** Sender user ID or username must be listed in `allowed_users`.
3. **Channel gating:** Channel ID or channel name must be listed in `allowed_channels`.
4. **Loop prevention:** The bot's own posts are discarded immediately.
5. **System messages:** System/membership events (`system_*`) are ignored.

## Configuration

Set via environment or vault keys:
- `MATTERMOST_URL`: Base HTTP(S) URL of Mattermost server (e.g. `https://mattermost.example.com`).
- `MATTERMOST_TOKEN`: Bot access token.
- `MATTERMOST_ALLOWED_USERS`: Comma-separated user IDs or usernames.
- `MATTERMOST_ALLOWED_CHANNELS`: Comma-separated channel IDs or channel names.

## Testing

Hermetic tests run against an in-memory mock Mattermost server without external dependencies:

```bash
pnpm test
```
