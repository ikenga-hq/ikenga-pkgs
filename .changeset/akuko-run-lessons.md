---
"@ikenga/skill-akuko": patch
---

akuko: docs from a real film run.

- `actions/motion.md`: the same-angle chain now edits the previous approved clip's last frame by default (only the action changes); tools with a 3 s floor (shorter shots cut from the start, longer shots end on a held frame); keep each clip's original with its audio before making the silent copy.
- `actions/keyframes.md` "Continuity rules": points new same-angle shots at that edit.
- `actions/sound.md`: the agent cannot hear audio (what it can measure, what needs the person's ears); fitting a take to its shot (trim silence, then up to about 1.15x tempo); room tone from kept clip audio; manual takes block captions (transcription untested).
- `lib/providers.md`: who presses generate (the person, unless they allowed it this session); Flow's 3 s floor, timing and audio; AI Studio's 1920 px attachment limit and blob: read-back; AI Studio speech and music as manual sound tools; driving the person's Chrome over CDP from WSL.
- `lib/hosts.md`: FFmpeg from WSL (Windows ffmpeg.exe, `-/filter_complex`, drawtext font).
