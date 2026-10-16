---
"@ikenga/pkg-studio": minor
---

Port the locked Studio timeline design system (studio-design-system D-03..D-09) into the Composition view.

- **Seeking and selecting are split:** the playhead seeks from a 24px band over the ruler, and clips are a keyboard-navigable toolbar (arrow keys between clips; Enter selects and seeks a beat into the clip). Previously a full-rail overlay swallowed every clip click.
- **Timecode is accessible:** a `role="timer"` readout with a spoken-form name, announcing on pause and on seek instead of at frame rate. The total moves to a passing contrast colour.
- **Graduated ruler:** whole-second ticks drawn from the frozen step set, thinning automatically in narrow panes.
- **Legible clips:** `--fg` labels on every beat colour, a beat accent rule, distinct selection and cross-link marks, and a typed seam glyph for each transition (smash cuts no longer vanish between same-colour beats).
- **Re-tokened waveform and word strip:** un-played bars are visible, and every state passes contrast.
- **One playhead colour:** a new `--playhead` alias (amber, re-derived for light mode). Beat accents follow the locked F2 map.
- **Single clock formatter:** the Composition clock now uses the frozen `fmtClock` everywhere (the rounding duplicate is gone).
- **Tokens bump:** `@ikenga/tokens` goes to ^0.5.1 for the Dusk Wood `--info` / `--info-soft` role.
