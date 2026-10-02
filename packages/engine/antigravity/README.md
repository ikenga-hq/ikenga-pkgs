# @ikenga/pkg-engine-antigravity

Antigravity CLI engine adapter for Ikenga — wraps the `agy` CLI binary and provides a unified interface for running agents with Google Gemini models.

| | |
|---|---|
| Pkg id | `com.ikenga.engine-antigravity` |
| Kind | `engine` |
| Status | Beta (ADR-013) |
| Requires | `agy` CLI on `$PATH` |
| Sessions | `/sessions`, `/sessions/by-agent/$agent`, `/sessions/$id` |

## What it is

This engine lets you run Ikenga agents using the Antigravity CLI, which provides access to Google Gemini models. It wraps the `agy` command-line interface and parses its stream-json output, just like the Claude Code engine wraps the `claude` CLI.

## Install

```bash
# Via Ikenga CLI
ikenga add @ikenga/pkg-engine-antigravity

# Or directly with npm
npm install @ikenga/pkg-engine-antigravity
```

Then configure the engine in Ikenga by:
1. Installing or configuring the `agy` CLI (https://antigravity.google/)
2. Setting `GEMINI_API_KEY` in your vault
3. Optionally customizing the default model in settings (defaults to `gemini-3.5-flash-medium`)

## Capabilities

| Capability | Supported | Note |
|---|---|---|
| Streaming | No | Responses are buffered |
| Tool use | Yes | Native support via Gemini |
| Thinking | Yes | When available in the model |
| Artifacts | Yes | |
| File attachments | Yes | |
| Image input | No | |
| Slash commands | Yes | |
| Model switching | No | Fixed default model |
| Prompt caching | Yes | Gemini native |
| MCP | Yes | Tool use integration |
| Session resume | Yes | Sessions are persisted |

## Known limits

- **No streaming**: responses are fully buffered before being sent to the UI
- **No image input**: the Antigravity CLI does not support image attachments
- **No model switching**: the default model is set at engine startup and cannot change per-session
- **GeminiEngineAdapter only**: this engine does not yet integrate with the full Ikenga runtime; it materializes pkg-shipped skills, commands, agents, and MCP entries into Antigravity's config tree at install time but does not handle agent lifecycle or inter-pkg communication

## Maturity

**Beta** — shipped in v0.2.2. The adapter is feature-complete for skill and command materialization (ADR-012 Track G). Runtime session handling and multi-engine dispatch are stable. See [ADR-013](https://github.com/ikenga-hq/ikenga/blob/main/docs/adr/013-multi-engine-runtime-wire-protocols.md) for the long-term architecture.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `antigravity_binary` | string | `agy` | Path to the `agy` CLI executable. Resolved against `$PATH` if not absolute. |
| `model` | string | `gemini-3.5-flash-medium` | Default Gemini model to use for new sessions. |

## Permissions

- `shell.execute`: run the `agy` CLI
- `fs.read`/`fs.write`: manage session state in `$pkg_data/sessions/`
- `vault.keys`: read `GEMINI_API_KEY` from the vault

## License

Apache-2.0 — see [LICENSE](../../LICENSE) (monorepo root).
