---
"@ikenga/mcp-iyke": patch
---

Ship mcp-iyke as a self-contained Claude Code plugin (WP-07; fixes ikenga#150).

- `pnpm build` now also bundles the server into `dist/plugin/server/index.js` (every dependency inlined; needs only `node` >=20, no `node_modules`) and packs `dist/iyke.mcpb` (MCPB manifest 0.3) for Claude Desktop and for plugins that bundle iyke.
- New `.claude-plugin/plugin.json` declares the bundled server inline (`plugin:iyke:iyke`).
- `server.json` version corrected from 0.2.3 to the package version; `sync-manifest-versions` now keeps `server.json` and Claude plugin manifests in step with `package.json`.
