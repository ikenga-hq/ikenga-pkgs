---
"@ikenga/skill-akuko": minor
---

Add the DaVinci Resolve handoff (`/akuko export`). It writes an export folder with the approved clips and key-frame stills copied in shot order (`media/001_sc1_sh1.mp4`), the approved voice-over, music and SFX, and a `timeline.fcpxml` (FCPXML 1.8) that Resolve imports with every shot in order at its exact length in whole frames. An EDL fallback (`--format edl|both`), a README with the import steps, a list of what was left out and why, checksums and a manifest come with it. Only approved material is used, nothing in the project is changed, and re-running replaces only what akuko wrote. Frame rate is chosen at export (`--fps`, default 24). `handoff/MANUAL-CHECK.md` is the script for confirming it in a real Resolve.
