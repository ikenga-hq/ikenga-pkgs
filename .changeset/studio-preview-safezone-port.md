---
"@ikenga/pkg-studio": minor
---

Port the locked preview-surface (D-12) and F4 aspect-safe-area (D-13) designs. The preview is a fixed 220px band with the picture fitted inside it. The 9:16 safe-zone overlay is the frozen SMPTE + TikTok/Reels model (`SafeZones`, replacing the two-band `SafeZoneBands`) with a legend outside the frame. A toggle beside the frame turns it on or off; it is on by default and remembered per project. Status text moves from `--fg-faint` to `--fg-muted`.
