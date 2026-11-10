---
"@ikenga/skill-akuko": minor
---

akuko can now import a shot list you already have. `breakdown/cli.ts import --sheet <xlsx|csv>` reads a spreadsheet (no new dependency), rebuilds each full prompt from its tokens, lighting and house style, and writes the scenes, parts, shots with film times, bible entries, ready-made cards, dialogue lines and the master audio clock. Everything arrives waiting for your review; nothing is approved. Re-importing updates text and timing by sheet id and never touches approvals. Lint knows imported shots (no 10 second cap, no screenplay tags), and intake has a new `import` route that needs no source text.
