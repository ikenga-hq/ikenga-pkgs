---
"@ikenga/pkg-studio": minor
---

Port the locked transport-bar (D-10) and scrubber-playhead (D-11) designs.

- **Transport is a real toolbar:** one tab stop, with ←/→/Home/End across its buttons (including the mute and re-render controls).
- **Truthful state:** play state lives in the Play/Pause label alone (no `aria-pressed`). Loop and mute are true toggles: a stable label plus `aria-pressed`.
- **Mute toggle repaired:** SVG speaker glyphs replace the emoji, and the inverted `aria-pressed` is fixed.
- **Playhead colour:** play uses the `--playhead` colour; on-states use `--info`; the focus ring is `--info`.
- **Edges:** step buttons disable at the start and end.
- **Narrow panes:** the strip yields under 520px (counter first, then text buttons). Adds a compact `size="sm"` instance.
- **Frame-step keys:** `,` / `.` now actually step a frame, as the tooltips always claimed.
- **No double-fired keys:** Space on a focused clip no longer also toggles playback.
- **Scrubber:** D-01's round playhead cap, held still; a 2px line while dragging; a hover ghost line showing where a click would land.
