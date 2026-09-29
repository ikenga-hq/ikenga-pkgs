# @ikenga/mcp-iyke

[![npm](https://img.shields.io/npm/v/@ikenga/mcp-iyke.svg)](https://www.npmjs.com/package/@ikenga/mcp-iyke)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the [Ikenga](https://github.com/ikenga-hq/ikenga) desktop app's **iyke control bridge** — so any MCP client (Claude Code, Cursor, custom agents) can drive a running Ikenga session the same way a developer types into the `iyke` CLI at a shell.

## What this is

Ikenga is a Tauri-based AI workspace shell with a manifest-driven package kernel. While the app is running, it exposes a localhost HTTP server (with a bearer token in `control.json`) that lets external tools introspect and drive the live UI: switch panes, navigate routes, take DOM snapshots, click elements, read logs, capture screenshots.

This package wraps that HTTP server in MCP so an LLM agent can use it natively. Tools mirror the `iyke` CLI subcommands.

## Install

### Via Claude Code (recommended)

```bash
npm install -g @ikenga/mcp-iyke
claude mcp add iyke -s user -- iyke-mcp
```

After that, any Claude Code session can call `iyke_state`, `iyke_go`, `iyke_mode`, `iyke_open`, `iyke_split`, `iyke_focus`, `iyke_close`, plus the runtime-inspection tools (`iyke_dom`, `iyke_logs`, `iyke_network`, `iyke_screenshot`, `iyke_wait`, `iyke_click`, `iyke_type`, `iyke_key`, `iyke_query_cache`, `iyke_devtools`) and iframe tools (`iyke_iframe_state`, `iyke_iframe_send`).

### Via npx (no install)

```bash
claude mcp add iyke -s user -- npx -y @ikenga/mcp-iyke
```

### From source (for contributors)

```bash
git clone https://github.com/Royalti-io/ikenga-pkg-mcp-iyke.git
cd ikenga-pkg-mcp-iyke
npm install
npm run build
```

Then point your MCP client at `node /path/to/ikenga-pkg-mcp-iyke/dist/index.js`.

## Tools

### Layout & navigation

| Tool          | Purpose                                                                 |
|---------------|-------------------------------------------------------------------------|
| `iyke_state`  | Show current sidebar mode + focused pane's route + full pane tree.      |
| `iyke_go`     | Navigate the focused pane to a route path.                              |
| `iyke_mode`   | Switch sidebar activity mode.                                           |
| `iyke_open`   | Open a new tab in the focused pane (route, terminal, chat, artifact, mini-app). |
| `iyke_split`  | Split a pane horizontally or vertically.                                |
| `iyke_focus`  | Focus a pane by id or 1-based DFS leaf index (⌃1..⌃6).                  |
| `iyke_close`  | Close a pane (focused if `pane_id` omitted).                            |

### Runtime inspection & driving

| Tool                | Purpose                                                                |
|---------------------|------------------------------------------------------------------------|
| `iyke_dom`          | Accessibility-tree snapshot of the focused pane (Playwright-style refs). |
| `iyke_logs`         | Last 500 console + error logs from the running webview.                 |
| `iyke_network`      | Last 100 fetch/XHR network entries with status + duration.              |
| `iyke_screenshot`   | PNG screenshot of the window or a specific pane.                        |
| `iyke_wait`         | Wait until a predicate is satisfied (text/selector/ref/gone).           |
| `iyke_click`        | Click an element by ref, selector, or text.                             |
| `iyke_type`         | Type into an input/textarea/contenteditable.                            |
| `iyke_key`          | Dispatch a keyboard combo (e.g. `Ctrl+S`, `Meta+K`).                    |
| `iyke_query_cache`  | Dump the TanStack Query cache for the focused pane.                     |
| `iyke_devtools`     | Open Chrome DevTools (debug builds only).                               |

### Iframe runtime state

| Tool                | Purpose                                                                |
|---------------------|------------------------------------------------------------------------|
| `iyke_iframe_state` | Read the latest published state object for an iframe pane.              |
| `iyke_iframe_send`  | Send a fire-and-forget postMessage to an iframe pane.                   |

### Project noun (`iyke project …`)

| Tool                     | Purpose                                                            |
|--------------------------|--------------------------------------------------------------------|
| `iyke_project_list`      | List projects in switcher order.                                   |
| `iyke_project_get_active` / `iyke_project_show` | The shell's active project.          |
| `iyke_project_switch`    | Switch the active project by root path (or bare id).               |
| `iyke_project_sections`  | Explorer sidebar section registry — pending a WP-28 bridge route.  |
| `iyke_project_create` / `update` / `archive` / `set_active` | Project lifecycle writes. |

### Ngwa noun (`iyke ngwa …`)

All five tools read the same payload — `GET /iyke/ngwa/snapshot`, the bridge twin of the shell's `ngwa_snapshot` command — so the facet tools return the verbatim `NgwaSnapshot` (`{ items, as_of_ms, sources }`) the `/ngwa/*` surfaces render. The route is **pending WP-28**: shells that don't expose it return a clear "route missing" error naming the gap.

| Tool                  | Purpose                                                        |
|-----------------------|----------------------------------------------------------------|
| `iyke_ngwa_installed` | Every installed NgwaItem (pkgs + primitives).                  |
| `iyke_ngwa_store`     | The store catalogue facet of the snapshot.                     |
| `iyke_ngwa_scopes`    | Scope matrix facet — items carry `scope` for grouping.         |
| `iyke_ngwa_health`    | Health facet — `sources` rollup + broken/orphaned items.       |
| `iyke_ngwa_item`      | One item's full detail by namespaced id.                       |

## Trust boundary

The MCP server reads `control.json` from the platform-specific app-local-data directory (`~/Library/Application Support/app.ikenga/control.json` on macOS, `$XDG_DATA_HOME/app.ikenga/control.json` on Linux, `%APPDATA%/app.ikenga/control.json` on Windows). The control file contains:

- `port` — localhost port the in-app HTTP server is listening on
- `token` — bearer token required on every request
- `pid` — owning process PID (used to detect stale files)

A stale `control.json` left behind by `kill -9` is auto-deleted once it's at least 5 minutes old; younger stale files are reported (likely a launch race) so we don't clobber a starting app.

If the Ikenga desktop app isn't running, every tool call fails with a structured error rather than hanging — your agent reads the failure and reports it instead of silently waiting.

The MCP server **only ever talks to `127.0.0.1`** on the port from `control.json`, with the bearer token from the same file. No outbound network, no telemetry.

## Compatibility

- **Ikenga shell:** any version exposing the v1 `control.json` schema.
- **Node.js:** ≥ 20.
- **Bun:** runs without compilation (`bun src/index.ts`).
- **MCP SDK:** `@modelcontextprotocol/sdk` ^1.23.0.

## Versioning

This package follows [SemVer 2.0.0](https://semver.org/). Major-version bumps may break MCP tool names or argument shapes; minor bumps add new tools or non-breaking improvements; patches fix bugs.

The `iyke` HTTP protocol version (the in-app server's API surface) is independent — it's pinned via `schema_version: 1` in `control.json`. This package currently supports protocol v1 only.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and the DCO. By contributing, you agree your contributions are licensed under Apache 2.0 (matching the repo).

For bugs or feature requests, open an [issue](https://github.com/Royalti-io/ikenga-pkg-mcp-iyke/issues).
For security issues, see [SECURITY.md](SECURITY.md) — please don't open a public issue.

## License

[Apache License 2.0](LICENSE) — Copyright (c) 2026 Royalti, Inc.

## Related

- **[Ikenga shell](https://github.com/ikenga-hq/ikenga)** — the desktop app this drives.
- **[@ikenga/contract](https://www.npmjs.com/package/@ikenga/contract)** — shared manifest + iyke runtime constants.
- **[Model Context Protocol](https://modelcontextprotocol.io/)** — the protocol this server speaks.
