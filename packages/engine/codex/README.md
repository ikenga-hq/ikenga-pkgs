# @ikenga/pkg-engine-codex

Codex engine pkg for Ikenga. It lets the Ikenga shell run agent sessions on OpenAI's Codex CLI.

| | |
|---|---|
| Pkg id | `com.ikenga.engine-codex` |
| Kind | `engine` |
| Maturity | Beta |
| Requires | The `codex` CLI on `$PATH` |

## What it is

This pkg registers Codex as an engine in the Ikenga shell. It is a thin delegator, not a CLI wrapper:

- `createAcpEngine(host)` returns an engine whose methods (`initialize`, `newSession`, `prompt`, `cancel`, `setMode`, `loadSession`, `forkSession`, plus the session-update, permission-request and notify listeners) forward straight to an `AcpHost` that the shell injects. The host is the shell's Tauri ACP commands. See `src/acp-engine.ts`.
- The shell, not this pkg, starts and talks to the `codex` CLI. The shell's Codex adapter runs one `codex exec` turn per prompt and turns Codex's events into the same session updates every other engine produces. The pkg has no `@tauri-apps/*` dependency and spawns no process of its own.
- A second export, `CodexEngineAdapter`, runs at pkg install time. When you install a pkg that ships MCP servers, subagents or skills, it writes them into Codex's own configuration: MCP entries into `~/.codex/config.toml`, subagents into `~/.codex/agents/<pkg>/`, and skills into the project's `.agents/skills/<pkg>/` (only when `IKENGA_CODEX_PROJECT_ROOT` is set). Secret placeholders become entries in Codex's `env_vars` allowlist, and plaintext secret-shaped values are refused.

The legacy `createEngine` factory is still exported for symmetry with the other engine pkgs. New code should use `createAcpEngine`.

## Install

```bash
ikenga add @ikenga/pkg-engine-codex
```

The pkg is also published to npm as `@ikenga/pkg-engine-codex`. It is listed in the Ikenga registry.

Then:

1. Install the Codex CLI and sign in. The manifest's auth check is `codex login`.
2. Make `OPENAI_API_KEY` available. The manifest's onboarding block lists it as a required vault key.
3. Optionally set the default model in the pkg settings (default `o4-mini`).

## Capabilities

The flags below are what `manifest.json` declares to the shell. Where the shell's Codex adapter is known to do less, the note says so.

| Capability | Declared | Note |
|---|---|---|
| Streaming | Yes | |
| Tool use | Yes | Codex runs its own tools under its own sandbox policy. |
| Thinking | Yes | Model-dependent. |
| Artifacts | Yes | |
| File attachments | Yes | |
| Image input | Yes | The shell adapter is text-only today, so images are not sent. |
| Slash commands | Yes | |
| Model switching | Yes | The shell adapter does not apply a per-turn model or effort change; Codex reads these from its own config. |
| Prompt caching | Yes | |
| MCP | Yes | Via the install-time adapter above. |
| Session resume | Yes | Follow-up turns resume the same Codex thread. |

## Known limits

- **Text only.** Prompts are text in, text out. Image attachments are not forwarded to Codex.
- **No approval round-trips.** Codex applies its own `--sandbox` policy. Ikenga does not bridge Codex's approval prompts into the shell UI, so there is no permission card for Codex tool calls.
- **No per-turn model or effort switching.** The model and effort controls in the chat header have no effect on Codex turns. Change them in Codex's own configuration or the pkg's `model` setting.
- **One process per turn.** Each prompt is a separate `codex exec` run, so there is no long-lived Codex session to attach to.
- **Install-time skill sync needs a project root.** Skills are only written when `IKENGA_CODEX_PROJECT_ROOT` is set; otherwise they are skipped with a warning.

## Maturity

**Beta.** Behaviour and the declared capabilities may change between releases.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `codex_binary` | string | `codex` | Path to the `codex` CLI. Resolved against `$PATH` if not absolute. |
| `model` | string | `o4-mini` | Default model for new sessions. |

## Permissions

Declared in `manifest.json`:

- `shell.execute`: run the `codex` CLI.
- `fs.read` and `fs.write`: `$pkg_data/sessions/**`.

## License

Apache-2.0. See [LICENSE](../../../LICENSE) at the monorepo root.
