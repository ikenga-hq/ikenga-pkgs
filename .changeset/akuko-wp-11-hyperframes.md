---
"@ikenga/skill-akuko": minor
---

Add the HyperFrames video engine for titles and graphics.

- **Preview now equals render.** A HyperFrames preview and its lossless render were compared
  at five times. Every pair showed the same counter and caption and reached 44–48.5 dB, and
  the test catches the earlier failure modes: a counter that never updates, and fallback
  fonts. Evidence and the re-runnable harness are in `engines/hyperframes/G-01.md`.
- **A small wrapper for the HyperFrames CLI** (`engines/hyperframes/cli.ts`). It runs `lint`,
  `check`, `snapshot` and `render` and returns parsed results. It passes
  `HYPERFRAMES_BROWSER_PATH` through on Windows. It has a draft and a final render profile
  and gives a rough render-time estimate before a full render.
- **Eight motion blocks** (`blocks/`): Stat, RevealList, HighlightWords, KenBurns,
  Annotation, ChatBubble, AvatarBadge and CaptionBar. They are HyperFrames scenes with
  vendored OFL fonts and state that depends only on timeline time, and they share one
  motion vocabulary (`settle`, `snap`, `bloom`).
