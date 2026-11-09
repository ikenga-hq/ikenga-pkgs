---
"@ikenga/skill-akuko": minor
---

akuko cleanup after motion, sound, the continuity audit and the Resolve handoff. The eval runner now treats a failed model call (an expired sign-in, an API or rate-limit error, a non-zero exit) as an error instead of a failure: errors are left out of both pass rates and the verdict is INCONCLUSIVE, with the reason printed. Stage routing passes when the first action file opened is the right one and any others are ones it links to. The eval set gains routing evals for motion, sound and export, plus a stub eval for assemble (41 prompts in all). SKILL.md, the README and lib/state.md no longer describe built stages as stubs, the provider contract suite now covers fal-video and elevenlabs, and the manual-check steps match the new numbers.
