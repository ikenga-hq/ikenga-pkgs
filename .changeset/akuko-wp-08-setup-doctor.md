---
"@ikenga/skill-akuko": minor
---

akuko setup + doctor: `setup` records a required budget cap (no default) in `akuko.json`, in the provider-config currency, and writes `.atelier/akuko/manifest.json` with key presence (names only, never values), defaults and the brand the person supplies (the skill ships no brand values). On Windows it prints instructions for `HYPERFRAMES_BROWSER_PATH` and never changes the environment. `doctor` (`scripts/doctor.sh`) checks Node (required) and FFmpeg / HyperFrames / Chrome (optional), lists orphan `submitted` reservations without clearing them, and flags stale model prices, example provider entries in use, and pending spends for unconfigured providers.
