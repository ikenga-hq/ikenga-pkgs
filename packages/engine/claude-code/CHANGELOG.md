# @ikenga/pkg-engine-claude-code

## 0.2.2

### Patch Changes

- [#129](https://github.com/ikenga-hq/ikenga-pkgs/pull/129) [`eb66c16`](https://github.com/ikenga-hq/ikenga-pkgs/commit/eb66c16c5dc75bbff41ad1c3ccd53b23f99aee9f) Thanks [@nedjamez](https://github.com/nedjamez)! - Default model setting is now `claude-sonnet-5-5` (was `claude-sonnet-4-6`).

- [#129](https://github.com/ikenga-hq/ikenga-pkgs/pull/129) [`0034a66`](https://github.com/ikenga-hq/ikenga-pkgs/commit/0034a665d91a424ee4d68f5f2490ccc09eee744d) Thanks [@nedjamez](https://github.com/nedjamez)! - Stop dropping the session system prompt. `startSession` now sends `systemPrompt` to the host as `appendSystemPrompt` (the shell's `ClaudeOpts` name, which becomes `--append-system-prompt`), and also passes through `model` and `resumeSessionId`, which were dropped the same way. New optional `role` (`chi` | `pane` | `plan`) and `pluginDirs` session options are forwarded when set. Unset options are omitted, so existing sessions spawn unchanged.

## 0.2.1

### Patch Changes

- Republish with `manifest.json` version synced to the npm version. Previous
  tarballs shipped a stale manifest version, so the shell recorded the old
  version after every update and re-offered the same update forever.
  (`@ikenga/pkg-tasks` also catches its npm version up to the manifest's 0.8.x
  line — npm history jumps 0.4.1 → 0.8.1.)

## 0.2.0

### Minor Changes

- [`8a5d923`](https://github.com/Royalti-io/ikenga-pkgs/commit/8a5d923a6181125bc125c5642c81dba4faf053e1) Thanks [@nedjamez](https://github.com/nedjamez)! - Port 5 commits of engine adapter evolution from the now-archived `Royalti-io/ikenga-pkg-engine-claude-code` standalone clone, which had diverged after the original subtree-add at `6a53f810`.

  Bumps `@ikenga/contract` dep from `^0.4.0` to `^0.6.0` to pick up the new multi-file `./engine` subpath module that exports `AcpHost`, `HostBridge`, `AcpUnlisten`.

  Original commits preserved by ref: `18fa4e0 a692db9 36f3d68 f5914b1 d9b1705`.

  Substantive changes:

  - `refactor(engine)` import `Engine` + ACP types from `@ikenga/contract/engine` (#1) — replaces local interface duplication with the canonical contract surface.
  - `fix(engine)` satisfy new `Engine.metadata` required field.
  - `feat(acp)` host-injected `AcpEngine` factory.
  - `refactor` collapse pkg to headless engine adapter.
  - `chore` genericize slug-derivation example.

  Brings the canonical monorepo copy up to date so the legacy `pkgs/engine-claude-code/` workspace-link source in the meta-repo can be retired (separate step — requires shell to repoint from `workspace:*` to the published `@ikenga/pkg-engine-claude-code@0.2.0`).
