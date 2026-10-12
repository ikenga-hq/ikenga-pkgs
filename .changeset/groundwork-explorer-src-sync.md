---
"@ikenga/skill-groundwork": patch
---

Port the explorer's live file reads (v0.7.5) and auto-discovery of newly registered files (v0.7.6) into `index.src.html`, which had only ever been hand-edited in the built files, and rebuild. The content and design-system explorers now include both features; a future rebuild no longer deletes them.
