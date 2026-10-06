---
"@ikenga/mcp-iyke": patch
---

Pack `dist/iyke.mcpb` on Windows without `zip`: fall back to System32 `tar.exe` (bsdtar), which writes zip archives. Unblocks the desktop release's Windows build.
