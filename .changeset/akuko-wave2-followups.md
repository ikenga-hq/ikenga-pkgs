---
"@ikenga/skill-akuko": patch
---

akuko: each provider's API key variable is now named once, in `providers/config.json` (`key_env`: `GEMINI_API_KEY` for Gemini, `FAL_KEY` for fal), and the providers, `setup` and `doctor` all read it. Before, `doctor` looked for `FAL_API_KEY` and reported a correctly set fal key as missing. Also fills the intake and breakdown entries in `lib/state.md` and corrects a header note in the Ikenga decision store.
