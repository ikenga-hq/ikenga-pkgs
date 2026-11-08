---
"@ikenga/skill-akuko": minor
---

akuko bible stage: `/akuko bible` now builds the character, location and style bible. Each principal character gets a portrait and then a labelled five-view turnaround made from the approved portrait; each location gets an empty plate; the film gets a lookbook frame that every later image is made against. Every image goes through the spend gate and waits for a person's approval before the next one that depends on it can be made; each entry's `refs` list holds only approved images. Works with the manual provider (free) or Gemini and fal (paid, local hosts only). Adds the film's character, location and style templates and a small command line (`bible/cli.ts`).
