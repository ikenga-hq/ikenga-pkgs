---
'@ikenga/mcp-meetings': patch
---

Final patch for existing installs before retirement (DEC-72, Round 58):
fixes the Windows entry-point check that made the 0.1.0 server exit silently
("stdout closed before id=1") because `` `file://${process.argv[1]}` `` never
equals `import.meta.url` on a Windows drive-letter path. The check now
compares against `pathToFileURL(process.argv[1]).href`, keeping the existing
`.endsWith('index.js')` fallback.

`@ikenga/mcp-meetings` is retired from the registry as of this release —
`com.ikenga.meetings` 0.2.1 bundles its own `meetings` MCP server, so there
is no reason to install this standalone package alongside it. See
`registry/retired.json`.
