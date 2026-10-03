# @ikenga/pkg-engine-codex

## 0.2.2

### Patch Changes

- [#124](https://github.com/ikenga-hq/ikenga-pkgs/pull/124) [`cb8a411`](https://github.com/ikenga-hq/ikenga-pkgs/commit/cb8a4116a68cf31ce67da0951485b9021b8fd96b) Thanks [@nedjamez](https://github.com/nedjamez)! - Clearer package description in the registry and on the packages page. No change to how the engine behaves.

## 0.2.1

### Patch Changes

- Republish with `manifest.json` version synced to the npm version. Previous
  tarballs shipped a stale manifest version, so the shell recorded the old
  version after every update and re-offered the same update forever.
  (`@ikenga/pkg-tasks` also catches its npm version up to the manifest's 0.8.x
  line — npm history jumps 0.4.1 → 0.8.1.)

## 0.2.0

### Minor Changes

- [`19a48a7`](https://github.com/Royalti-io/ikenga-pkgs/commit/19a48a7d21679135780296009cfcf487dd0513cf) Thanks [@nedjamez](https://github.com/nedjamez)! - First release. Ships the install-time `CodexEngineAdapter` (ADR-012 Track C) — materializes pkg-shipped MCP entries into `~/.codex/config.toml` as `[mcp_servers.ikenga.<slug>.<name>]` tables, subagents into `~/.codex/agents/<slug>/<name>.toml` via the ADR §5 MD→TOML transcoder, and skills + commands into `<IKENGA_CODEX_PROJECT_ROOT>/.agents/skills/<slug>/` (gated on env var; the shell seeds it from the active project).

  Per ADR §7 closure (2026-05-18): `${IKENGA_SECRET:...}` placeholders in env values translate to entries in Codex's `env_vars = [...]` allowlist (forwards from parent process env); plaintext secret-shaped keys are refused. Runtime `Engine` is a stub — chat-runtime wiring is a separate slice.
