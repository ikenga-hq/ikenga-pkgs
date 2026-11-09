---
"@ikenga/skill-akuko": minor
---

akuko: the default board (now 0.2) has a working pipeline strip: Intake opens the script, Breakdown and Sketch the shots, a stage with spend waiting the spend gate, and locked or not-started stages are plain text that say why. "Copy decisions for akuko" now shows what it copied and leaves out decisions the project already has. On the Claude desktop app the agent opens the board in the built-in browser and reads your clicks directly (`window.akukoDecisions.jsonl()`), with copy and paste as the fallback. New `views/publish.ts --project <folder>` embeds the project into the board and publishes it. Decisions from 0.1 boards still fold.
