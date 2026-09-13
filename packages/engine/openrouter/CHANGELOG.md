# @ikenga/pkg-engine-openrouter

## 0.1.1

### Patch Changes

- [#100](https://github.com/ikenga-hq/ikenga-pkgs/pull/100) [`bd1ac3b`](https://github.com/ikenga-hq/ikenga-pkgs/commit/bd1ac3b7735d030e5ad725833271f6f636543c73) Thanks [@nedjamez](https://github.com/nedjamez)! - Fix manifest correctness bugs (WP-20).

  **Network allowlist is now pkg-controlled.** The permission key was spelled `net.http`, which is not a key the shell/contract permission schemas define, so it was dropped on parse and `permissions.net` came back empty. That did not break anything at runtime: `openrouter_http::server::resolve_net_allowlist` falls back to its built-in `DEFAULT_NET_ALLOWLIST` (`https://openrouter.ai/api/`) when the pkg declares nothing, and that fallback allowed the public endpoint. The behavioural change in this release is that the key is now spelled `net`, so the pkg's own `https://openrouter.ai/api/**` glob is honoured and becomes the sole gate on where the API bearer token may be sent — the built-in fallback no longer applies to this pkg.

  **`permissions["vault.keys"]` now declares `OPENROUTER_API_KEY`.** `engine.onboarding.requiredVaultKeys` already listed it and the shell resolves it out of Stronghold, but the permission list was empty, so the install-time trust disclosure showed this engine as requesting no vault access.

  **Default model slug** `anthropic/claude-3.7-sonnet` was stale; replaced with `openrouter/auto`.

  **`engine.capabilities` no longer overclaims.** `artifacts`, `fileAttachments`, `imageInput`, `slashCommands`, `promptCaching`, `agenticTools` and `mcp` are now all `false`, matching what `openrouter_http::server` implements: text-only prompts (image and audio blocks are refused, not dropped), no structured-artifact channel, no MCP transport (tool definitions arrive via `set_tools`, which is a different thing), no slash-command vocabulary, no prompt caching, and no agentic loop — the adapter executes no tools itself, it reports the calls the model asked for and ends the turn. `streaming`, `toolUse`, `thinking`, `modelSwitching` and `sessionResume` stay `true`. The same block is declared a second time in `OpenRouterEngine.metadata` (a sanctioned read path per the `EngineMetadata` contract) and was corrected there too; a new test asserts the two copies stay identical, that the declared `permissions.net` actually admits the default endpoint, and that every required vault key is declared.
