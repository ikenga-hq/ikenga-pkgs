---
"@ikenga/skill-akuko": minor
---

Resolve handoff on the master clock. When a project has locked audio (`audio.master`), `export` now places every approved shot and card at its film time (gaps kept as gaps), starts the timeline at the master's start timecode, and lays the master WAV whole on its own audio track instead of laying shots end to end. Picture per shot is the approved lip-sync clip, else the approved clip, else the approved key frame. Stills with a camera move get FCPXML transform keyframes plus a marker (whether Resolve imports the keyframes is not verified: the README and a manual check cover it). `--link-media` references a large master in place instead of copying it. Projects without a master export exactly as before.
