---
"@ikenga/mcp-iyke": minor
---

WP-21b — Project + Ngwa nouns, and the v16 mode set.

- `iyke_mode` now advertises exactly the v16 rail modes: `project`, `chi`, `ngwa`, `settings`. The bridge still accepts pre-v16 names for one compatibility release, but they are no longer in the MCP schema enum.
- New Project tools mirroring `iyke project …`: `iyke_project_show` (alias of `iyke_project_get_active`), `iyke_project_switch` (root-path or id resolution against `iyke_project_list`), `iyke_project_sections` (Explorer section registry).
- New Ngwa tools mirroring `iyke ngwa …`: `iyke_ngwa_installed`, `iyke_ngwa_store`, `iyke_ngwa_scopes`, `iyke_ngwa_health` return the verbatim `NgwaSnapshot` (`{ items, as_of_ms, sources }`); `iyke_ngwa_item` extracts one item by id.

The `GET /iyke/ngwa/snapshot` and `GET /iyke/explorer/sections` bridge routes are pending WP-28 — on shells that don't expose them, the new tools fail with a clear "route missing" error naming the gap rather than a bare 404.
