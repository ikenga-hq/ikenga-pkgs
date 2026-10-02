# @ikenga/pkg-engine-openrouter

OpenRouter engine pkg for Ikenga. It lets the Ikenga shell run chat sessions on any model available through [OpenRouter](https://openrouter.ai/), using a single API key.

| | |
|---|---|
| Pkg id | `com.ikenga.engine-openrouter` |
| Kind | `engine` |
| Maturity | Beta |
| Requires | An OpenRouter API key, and network access to `https://openrouter.ai/api/` |

## What it is

OpenRouter is a hosted API that fronts many model providers behind one OpenAI-compatible endpoint. This pkg registers it as an engine in the Ikenga shell. Unlike the Codex and Antigravity engines there is no CLI to install: the engine talks to OpenRouter over HTTPS.

Two surfaces ship from this pkg:

- `createAcpEngine(host)` (and the legacy `createEngine(host)`): the engine the manifest declares. Its methods forward to a host the shell injects (the shell's Tauri ACP commands), and the shell makes the HTTPS requests. See `src/acp-engine.ts`.
- `OpenRouterHttpEngine` / `createHttpEngine(config)`: a self-contained, in-process HTTP engine for places with no shell host, such as Node tooling and tests. It streams the OpenAI-compatible `/chat/completions` endpoint, normalizes reasoning tokens (both the `reasoning` / `thinking` delta fields and inline `<think>` tags), and accumulates streamed tool calls. It reads the key from `OPENROUTER_API_KEY` unless you pass `apiKey`.

Model selection is free text, forwarded as written. There is no pinned model list.

## Install

```bash
ikenga add @ikenga/pkg-engine-openrouter
```

The pkg is also published to npm as `@ikenga/pkg-engine-openrouter`. It is listed in the Ikenga registry.

Then:

1. Create an API key at <https://openrouter.ai/keys>.
2. Set it in the pkg's `openrouter_api_key` setting. It is stored in the vault, not in plain settings.
3. Optionally set the default model (default `openrouter/auto`).

## Capabilities

| Capability | Supported | Note |
|---|---|---|
| Streaming | Yes | Server-sent events from `/chat/completions`. |
| Tool use | Yes | Model-dependent. The engine reports the tool calls the model asks for and ends the turn. It does not run tools itself. |
| Thinking | Yes | When the model returns reasoning tokens. |
| Artifacts | No | |
| File attachments | No | |
| Image input | No | Prompts are text only. Image and audio blocks are refused. |
| Slash commands | No | |
| Model switching | Yes | Any OpenRouter model id. |
| Prompt caching | No | |
| MCP | No | |
| Session resume | In-process only | History is held in memory by the running shell. A session can be replayed while that process is alive. It does **not** survive a restart. |

## Known limits

- **Cannot resume after a restart.** OpenRouter's endpoint is stateless and the conversation history lives only in the shell process that created it. After the shell restarts, an earlier OpenRouter session cannot be resumed. The shell returns an error rather than opening an empty transcript.
- **No agentic loop.** The engine reports tool calls but never executes them, so it suits chat and simple function-calling flows rather than autonomous multi-step work.
- **Text only.** No image input, file attachments, artifacts, slash commands or MCP.
- **Model behaviour varies.** Tool use and reasoning output depend on the model you choose.

## Maturity

**Beta.** Behaviour and capabilities may change between releases.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `openrouter_api_key` | secret | none | Your OpenRouter API key. Stored in the vault and passed to the adapter as `OPENROUTER_API_KEY`. |
| `model` | string | `openrouter/auto` | Default model id, for example `openrouter/auto`, `anthropic/claude-3.7-sonnet` or `deepseek/deepseek-r1`. `openrouter/auto` lets OpenRouter choose. |
| `base_url` | string | `https://openrouter.ai/api/v1` | API endpoint. Usually left unchanged. |

## Permissions

Declared in `manifest.json`:

- `net`: `https://openrouter.ai/api/**`. This is the only place the API key may be sent.
- `vault.keys`: `OPENROUTER_API_KEY`.
- `fs.read` and `fs.write`: `$pkg_data/sessions/**`.

## License

Apache-2.0. See [LICENSE](../../../LICENSE) at the monorepo root.
