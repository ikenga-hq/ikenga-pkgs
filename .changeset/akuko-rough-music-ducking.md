---
"@ikenga/skill-akuko": patch
---

akuko: `assemble rough` no longer cuts the music off after the last voice-over line. The ducking filter stopped when its voice key ended, so `--music` (since 0.5.0) and the project's music beds fell silent from there on. The key is now padded to the film's length, and the real-render test listens past the last line.
