# @ikenga/pkg-engine-codex

Codex CLI engine adapter for Ikenga — wraps the `codex` CLI binary and provides a unified interface for running agents with OpenAI models through Codex.

| | |
|---|---|
| Pkg id | `com.ikenga.engine-codex` |
| Kind | `engine` |
| Status | Beta (ADR-013) |
| Requires | `codex` CLI on `$PATH` |
| Sessions | `/sessions`, `/sessions/by-agent/$agent`, `/sessions/$id` |

## What it is

This engine lets you run Ikenga agents using the Codex CLI, which provides access to OpenAI models. It wraps the `codex` command-line interface, parses its stream-json output, and manages sessions — similar to how the Claude Code engine wraps the `claude` CLI but for OpenAI.

## Install

```bash
# Via Ikenga CLI
ikenga add @ikenga/pkg-engine-codex

# Or directly with npm
npm install @ikenga/pkg-engine-codex
```

Then configure the engine in Ikenga by:
1. Installing or configuring the `codex` CLI
2. Setting `OPENAI_API_KEY` in your vault
3. Optionally customizing the default model in settings (defaults to `o4-mini`)

## Capabilities

| Capability | Supported | Note |
|---|---|---|
| Streaming | Yes | Real-time token streaming |
| Tool use | Yes | Native support via OpenAI |
| Thinking | Yes | When available in the model (o1, o4) |
| Artifacts | Yes | |
| File attachments | Yes | |
| Image input | Yes | Codex supports image attachments |
| Slash commands | Yes | |
| Model switching | Yes | Change models per-session |
| Prompt caching | Yes | OpenAI native for larger contexts |
| MCP | Yes | Tool use integration |
| Session resume | Yes | Sessions are persisted |

## Known limits

- **ADR-013 still Proposed**: the runtime completeness and inter-engine protocol are still being finalized. See [ADR-013](https://github.com/ikenga-hq/ikenga/blob/main/docs/adr/013-multi-engine-runtime-wire-protocols.md) for current status.
- **CodexEngineAdapter only**: this engine materializes pkg-shipped skills, commands, agents, and MCP entries into Codex's config tree at install time but does not yet handle full agent lifecycle or inter-pkg communication

## Maturity

**Beta** — shipped in v0.2.1. The adapter is feature-complete for skill and command materialization (ADR-012 Track G). Runtime streaming and session handling are functional but may evolve with ADR-013. See [ADR-013](https://github.com/ikenga-hq/ikenga/blob/main/docs/adr/013-multi-engine-runtime-wire-protocols.md) for the long-term architecture.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `codex_binary` | string | `codex` | Path to the `codex` CLI executable. Resolved against `$PATH` if not absolute. |
| `model` | string | `o4-mini` | Default OpenAI model to use for new sessions (e.g., `o4-mini`, `gpt-4o`, `gpt-4-turbo`). |

## Permissions

- `shell.execute`: run the `codex` CLI
- `fs.read`/`fs.write`: manage session state in `$pkg_data/sessions/`
- `vault.keys`: read `OPENAI_API_KEY` from the vault

## License

Apache-2.0 — see [LICENSE](../../LICENSE) (monorepo root).
