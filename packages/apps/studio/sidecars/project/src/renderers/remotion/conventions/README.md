# Remotion Cell Conventions

Authoring conventions for Remotion (`.tsx`) cells in `com.ikenga.studio` (Phase 3, WP-14).

## Binding Precedent

Per `.company/learnings/2026-04-26-video-engine-rewrite.md`:
> *A discriminated union is a creative ceiling.*

These components and timing helpers are **adapter-side authoring conventions**, **NEVER an enum or schema the API accepts**. Studio's `Cell` schema accepts arbitrary `.tsx` code at `content_path`. The conventions here provide a shared visual foundation, palette discipline, and physics-based motion vocabulary without restricting filmmakers or agents to a rigid template DSL.

---

## 1. Palette Contract (`theme/`)

All primitives read color tokens via `usePalette()` from `<BrandProvider>`.

### 8-Key Colour Tokens

| Token | Description | Ask Roy Default | Lo-Fi Wireframe |
|---|---|---|---|
| `bg` | Outermost background | `#002626` | `#fafafa` |
| `surface` | Card / panel background | `#003333` | `#eeeeee` |
| `border` | Hairline / stroke | `#004d4d` | `#cccccc` |
| `accent` | Interactive / brand color | `#00807f` | `#888888` |
| `highlight` | Accent highlight / glow | `#66cccc` | `#555555` |
| `textPri` | Primary body text | `#f0f5f5` | `#222222` |
| `textSec` | Muted / label text | `#b3c4c4` | `#666666` |
| `accent2` | Optional secondary accent | — | — |

### Lo-Fi Wireframing (`lofi={true}`)

Wrap your cell or preview in `<BrandProvider lofi={true}>` for instant grayscale wireframing. In lo-fi mode:
- Glows (`boxShadow`) and text shadows are suppressed.
- Rounded corners collapse from pill/card radii to hairline wireframe borders.
- Stills render cleanly for fast Rung 1 beat-sheet review.

---

## 2. Motion Vocabulary (`motion/`)

Pure timing and physics functions wrapping spring curves. Compositions import these instead of guessing damping/stiffness values:

### Entrance Helpers

- `settle({ frame, fps, startAt })`: Heavy, deliberate landing (`damping: 18, stiffness: 90, mass: 1.0`). Settle time ~35 frames. Ideal for body text, cards, paragraphs.
- `snap({ frame, fps, startAt })`: Crisp, punctuated entrance (`damping: 12, stiffness: 130, mass: 0.6`). Ideal for headlines, single-word callouts, badges.
- `bloom({ frame, fps, startAt })`: Playful entrance with ~8% overshoot (`damping: 9, stiffness: 150, mass: 0.5`). Ideal for avatars, stat numerals, burst animations.

### Timing Helpers

- `lag(ms)`: Delay entrance by `ms` milliseconds after the cue.
- `lead(ms)`: Anticipate entrance by `ms` milliseconds before the cue.
- `applyOffset(frame, offset, fps)`: Computes the target frame (clamped to $\ge 0$).

---

## 3. Video Primitives (`primitives/`)

Eight tree-shakeable, palette-aware components:

1. **`Stat`**: High-impact numeric callouts ("$1.2M", "20 min", "126 tools") with optional subline and label.
2. **`RevealList`**: Vertical or horizontal lists whose items reveal with staggered spring entrances.
3. **`HighlightWords`**: Renders text with selected phrases styled in the accent highlight, strictly preserving inter-word whitespace.
4. **`KenBurns`**: Subtle, cinematic camera pan and zoom (1.08 → 1.0 over duration; auto-disabled in lo-fi).
5. **`Annotation`**: Text callout connected to a target point by an animated SVG arrow (curved or straight).
6. **`ChatBubble`**: Chat UI metaphor with user (accent) and assistant (surface) styling.
7. **`AvatarBadge`**: Circular character/persona reveal badge with radial glow and custom glyph.
8. **`CaptionBar`**: Root-anchored subtitle pill synced to absolute video timestamps.
