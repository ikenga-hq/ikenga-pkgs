---
"@ikenga/skill-akuko": patch
---

akuko: continuity lessons for interior sets and repeated camera angles.

- `actions/keyframes.md` "Continuity rules": blocking render first, a set reference that shows the layout, set geography, edit a still rather than regenerate it, crop references, a per-frame audit checklist, retakes.
- `actions/motion.md` "Same-angle continuity chain": group shots by angle, check each still against the last frame of the previous approved clip in that angle, Start + End frames for hidden faces, a clip prompt template, length and post-download checks.
- `lib/providers.md`: Google Flow (video) and AI Studio / Nano Banana 2.1 (stills) as manual tools.
- Shots may carry an optional `angle` (a camera-angle group id) in `akuko.json`, so motion can work out the reference chain. Optional, so existing projects load unchanged.
