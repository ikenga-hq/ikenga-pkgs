---
"@ikenga/skill-akuko": minor
---

akuko image providers: Gemini ("Nano Banana") and fal can now make reference-aware key frames and stills from your own API key. A shot's bible references (character, location, style) are sent with the prompt, up to each model's documented limit (more is refused with a clear message, never silently trimmed). Both go through the spend gate like every paid provider, run on the local and Ikenga hosts only, and take their model ids and prices from `providers/config.json`, each with the page and date it was verified against. The spend-gate source scan now also catches a one-line `submit` wrapper.
