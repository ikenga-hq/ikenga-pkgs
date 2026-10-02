# @ikenga/pkg-engine-openrouter

OpenRouter unified LLM engine adapter for Ikenga — provides a unified interface for running agents with any model available on OpenRouter, from Anthropic, OpenAI, Google, DeepSeek, Meta, and more.

| | |
|---|---|
| Pkg id | `com.ikenga.engine-openrouter` |
| Kind | `engine` |
| Status | Beta (ADR-013) |
| Requires | Network access to `https://openrouter.ai/api/` |
| Sessions | `/sessions`, `/sessions/by-agent/$agent`, `/sessions/$id` |

## What it is

This engine lets you run Ikenga agents using OpenRouter, a unified API that provides access to hundreds of LLM models across multiple providers. Instead of managing separate API keys and endpoints for each provider, you use a single OpenRouter API key to access models from Anthropic, OpenAI, Google, DeepSeek, Meta, Mistral, and others.

## Install

```bash
# Via Ikenga CLI
ikenga add @ikenga/pkg-engine-openrouter

# Or directly with npm
npm install @ikenga/pkg-engine-openrouter
```

Then configure the engine in Ikenga by:
1. Creating an OpenRouter account at https://openrouter.ai/
2. Generating an API key and storing it in your vault as `OPENROUTER_API_KEY`
3. Optionally customizing the default model in settings (defaults to `openrouter/auto`)

## Capabilities

| Capability | Supported | Note |
|---|---|---|
| Streaming | Yes | Real-time token streaming |
| Tool use | Yes | Model-dependent; most modern models support it |
| Thinking | Yes | When available in the model (o1, o4) |
| Artifacts | No | OpenRouter does not support artifact attachments |
| File attachments | No | OpenRouter does not support file attachments |
| Image input | No | Currently not supported |
| Slash commands | No | Restricted capability set |
| Model switching | Yes | Swap models per-session from hundreds of options |
| Prompt caching | No | Not supported by OpenRouter API |
| MCP | No | Restricted capability set |
| Session resume | Yes | Sessions are persisted |

## Known limits

- **Cannot resume after restart**: sessions are stored locally and can be resumed within the current session, but restarting Ikenga will not be able to resume previous OpenRouter sessions (they are abandoned on restart)
- **No artifacts or file attachments**: OpenRouter does not support artifact or file attachment features
- **No image input**: image attachments are not yet supported
- **No MCP**: OpenRouter's current tooling integration is for basic function calls only
- **Limited to text and basic tools**: this engine is best suited for text-based workflows and simple function calling

## Maturity

**Beta** — shipped in v0.2.0. The adapter provides basic streaming chat and model switching. Tool use works for models that support it natively. See [ADR-013](https://github.com/ikenga-hq/ikenga/blob/main/docs/adr/013-multi-engine-runtime-wire-protocols.md) for the runtime protocol specification.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `openrouter_api_key` | secret | — | Your OpenRouter API key. Required. Stored in the vault; injected into the adapter process as `OPENROUTER_API_KEY`. Get one at https://openrouter.ai/keys. |
| `model` | string | `openrouter/auto` | Default model identifier. Use any model slug from https://openrouter.ai/models (e.g., `anthropic/claude-3.7-sonnet`, `openai/gpt-4o`, `deepseek/deepseek-r1`, `meta-llama/llama-3.3-70b-instruct`). `openrouter/auto` selects the best model by cost/performance. |
| `base_url` | string | `https://openrouter.ai/api/v1` | API endpoint. Usually not changed. |

## Permissions

- `net`: HTTPS access to OpenRouter API (`https://openrouter.ai/api/**`)
- `fs.read`/`fs.write`: manage session state in `$pkg_data/sessions/`
- `vault.keys`: read `OPENROUTER_API_KEY` from the vault

## License

Apache-2.0 — see [LICENSE](../../LICENSE) (monorepo root).
