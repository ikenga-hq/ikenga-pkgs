---
"@ikenga/skill-akuko": patch
---

Resolve handoff: camera moves on stills are now rendered into short clips with ffmpeg at export (`--moves render`, the default). DaVinci Resolve 19 drops FCPXML transform keyframes and clip markers on import, so a keyframed move arrived static. Without ffmpeg, with `--moves keyframes`, or when a key frame can't be read, the still keeps its keyframes and marker, and a note says to set the move by hand.
