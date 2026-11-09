---
"@ikenga/skill-akuko": minor
---

Fixes from the first paid manual check. The Gemini image provider now asks for JPEG output (the live API rejected PNG with HTTP 400, so every Gemini image job failed), a test pins the exact request body for each configured model, and a 429 now says "free tier or billing not active". `doctor` checks that `zod`, `@ikenga/studio-schema` and the view-check packages resolve from the skill folder before running anything (an installed skill has no `node_modules`), names what is missing and prints the install command, and reminds you that a set key does not prove the account can buy images. `setup` no longer crashes when there is no `akuko.json`: it creates the minimal project; new projects record the detected host. `collect` prints the cost the ledger recorded instead of "cost 0", `budget.spent` is stored without float noise (0.88, not 0.8799999999999999), and the manual-check script's checklist count is corrected to 6.
