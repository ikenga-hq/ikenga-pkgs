# @ikenga/pkg-engine-gemini

## 0.2.2

### Patch Changes

- [#54](https://github.com/ikenga-hq/ikenga-pkgs/pull/54) [`46a65f8`](https://github.com/ikenga-hq/ikenga-pkgs/commit/46a65f8d3991ab4c68dd4984ec1d5b00c06dfb14) Thanks [@nedjamez](https://github.com/nedjamez)! - Publish the Antigravity CLI engine adapter under its new package name. This supersedes the retired Gemini CLI engine adapter (`@ikenga/pkg-engine-gemini`), which has been delisted from the registry. Users on the old Gemini engine should switch to `@ikenga/pkg-engine-antigravity`.

## 0.2.1

### Patch Changes

- Republish with `manifest.json` version synced to the npm version. Previous
  tarballs shipped a stale manifest version, so the shell recorded the old
  version after every update and re-offered the same update forever.
  (`@ikenga/pkg-tasks` also catches its npm version up to the manifest's 0.8.x
  line — npm history jumps 0.4.1 → 0.8.1.)

## 0.2.0

### Minor Changes

- [`19a48a7`](https://github.com/ikenga-hq/ikenga-pkgs/commit/19a48a7d21679135780296009cfcf487dd0513cf) Thanks [@nedjamez](https://github.com/nedjamez)! - First release. Ships the install-time `GeminiEngineAdapter` (ADR-012 Track G) — materializes pkg-shipped skills, commands, agents, and MCP entries into Gemini CLI's on-disk config tree (`~/.gemini/settings.json`, `~/.gemini/extensions/<slug>/`, `~/.gemini/commands/<slug>/<name>.toml`, `~/.gemini/agents/<slug>/`). Runtime `Engine` is a stub that throws — chat-runtime wiring is a separate slice.
