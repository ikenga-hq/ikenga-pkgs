---
"@ikenga/skill-akuko": minor
---

akuko: the `view` action now lets the agent design a view for the question at hand ("show me the cast", "where is the money going", "compare these scenes"). Read-only views publish freely; any view with approve or decline controls is blocked until `check-view` passes and the pass is recorded in the project's own conformed list. The action routes every publish through the host adapter, gives freehand views their own `freehand:<slug>@<n>` ids, and carries the readability floor (light and dark). Adds three worked example views built from the converted *The Beating* fixture, their evals, and a short manual check to run on claude.ai.
