# @ikenga/pkg-engine-antigravity

Antigravity engine pkg for Ikenga. It lets the Ikenga shell run agent sessions on Google's Antigravity CLI (`agy`) with Gemini models.

| | |
|---|---|
| Pkg id | `com.ikenga.engine-antigravity` |
| Kind | `engine` |
| Maturity | Beta |
| Requires | The `agy` CLI on `$PATH` |

This pkg supersedes the retired `@ikenga/pkg-engine-gemini` (Gemini CLI) adapter. If you used that engine, switch to this one.

## What it is

This pkg registers Antigravity as an engine in the Ikenga shell. It is a thin delegator, not a CLI wrapper:

- `createAcpEngine(host)` returns an engine whose methods (`initialize`, `newSession`, `prompt`, `cancel`, `setMode`, `loadSession`, `forkSession`, plus the session-update and permission-request listeners) forward straight to an `AcpHost` that the shell injects. The host is the shell's Tauri ACP commands. See `src/acp-engine.ts`.
- The shell, not this pkg, starts and talks to the `agy` CLI. The pkg has no `@tauri-apps/*` dependency and spawns no process of its own.
- A second export, `AntigravityEngineAdapter`, runs at pkg install time. When you install a pkg that ships skills, subagents, commands or MCP servers, it writes them into Antigravity's own configuration: skills, agents and commands under `~/.gemini/antigravity-cli/`, and MCP entries into `~/.gemini/config/mcp_config.json`. An MCP entry with a plaintext secret-shaped environment value is refused; secrets must use a `${IKENGA_SECRET:<vault-key>}` placeholder.

The legacy `createEngine` factory is still exported for symmetry with the other engine pkgs. New code should use `createAcpEngine`.

## Install

```bash
ikenga add @ikenga/pkg-engine-antigravity
```

The pkg is also published to npm as `@ikenga/pkg-engine-antigravity`. It is listed in the Ikenga registry.

Then:

1. Install the Antigravity CLI from <https://antigravity.google/>.
2. Check it is authenticated. The manifest's auth check is `agy models`.
3. Make `GEMINI_API_KEY` available. The manifest's onboarding block lists it as a required vault key.
4. Optionally set the default model in the pkg settings (default `gemini-3.5-flash-medium`).

## Capabilities

The flags below are what `manifest.json` declares to the shell. Where the shell's Antigravity adapter is known to behave differently, the note says so.

| Capability | Declared | Note |
|---|---|---|
| Streaming | No | The shell adapter forwards text to the chat as the CLI emits it. |
| Tool use | Yes | |
| Thinking | Yes | Model-dependent. |
| Artifacts | Yes | |
| File attachments | Yes | |
| Image input | No | |
| Slash commands | Yes | |
| Model switching | No | The shell can pass a per-session model to the CLI when one is set. |
| Prompt caching | Yes | |
| MCP | Yes | Via the install-time adapter above. |
| Session resume | Yes | |

## Known limits

- **No image input.** The shell adapter does not send image attachments to `agy`.
- **Manifest flags are conservative.** The declared `streaming: false` and `modelSwitching: false` understate what the shell adapter does today (see the notes above).
- **One process per turn.** Each prompt runs the `agy` CLI as a separate process, so there is no long-lived Antigravity session to attach to.

## Maturity

**Beta.** Behaviour and the declared capabilities may change between releases.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `antigravity_binary` | string | `agy` | Path to the `agy` CLI. Resolved against `$PATH` if not absolute. |
| `model` | string | `gemini-3.5-flash-medium` | Default Gemini model for new sessions. |

## Permissions

Declared in `manifest.json`:

- `shell.execute`: run the `agy` CLI.
- `fs.read` and `fs.write`: `$pkg_data/sessions/**`.

## License

Apache-2.0. See [LICENSE](../../../LICENSE) at the monorepo root.
