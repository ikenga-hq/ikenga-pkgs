<!-- LIFTED-FROM: royalti-co/.claude/skills/storyboard-workflow (hard-copied 2026-05-22 for com.ikenga.studio; edit here, do not diff back) -->
---
name: storyboard-workflow
description: Collaborative storyboard production workflow for video compositions. Template → batch fill → review → approve → assets. Use when creating or continuing a storyboard for any video.
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Agent
---

# Storyboard Workflow

## Purpose

Defines the collaborative workflow for creating video storyboards. The storyboard is a **production planning document** — the single source of truth that guides every downstream step: asset generation, React component coding, audio timing, and rendering.

**This is a creative/directorial workflow.** The user directs, Claude executes in batches. Never automate the entire storyboard at once.

---

## Pipeline Position

```
/generate-video-script → STORYBOARD (this skill) → asset generation → rendering
```

The storyboard sits between script creation and asset generation. All beats must be `approved` before moving to asset generation.

---

## 3-Pass Workflow

### Pass 1: Scaffold (automated)

Create the template storyboard with empty frames for all beats.

```bash
cd <video-engine>   # the video-engine repo that holds scripts/ and input/
npx tsx scripts/generate-storyboard-scaffold.ts --script input/scripts/<slug>-script.yaml
```

**Creates:**
- `input/storyboards/<slug>/storyboard.excalidraw` — color-coded grid, 3 beats per row, 1920×1080 per beat, section header frames, transition arrows
- `input/storyboards/<slug>/frames/{beatId}.png` — per-beat placeholder PNGs
- `input/storyboards/<slug>/manifest.json` — tracking with status `scaffold` per beat

**Color coding by visual type:**
- Teal tint (`#c3fae8`) — storyboard_sequence, excalidraw_diagram (needs Excalidraw art)
- Purple tint (`#d0bfff`) — react_diagram (needs React component coding)
- Blue tint (`#a5d8ff`) — text_overlay, counter_animation (simple text/number)
- Orange tint (`#ffd8a8`) — end_screen (CTA)

### Pass 2: Fill (collaborative, in batches)

Fill in scene sketches **one section at a time** with user review after each batch.

```bash
npx tsx scripts/generate-storyboard-fill.ts --script input/scripts/<slug>-script.yaml --beat <id>
```

Or fill manually by editing the Excalidraw JSON directly using `scripts/lib/excalidraw-elements.ts` factory functions.

**Each beat frame must contain:**

1. **Scene sketch** — the actual diagram/illustration composed from Excalidraw primitives (rectangles, text, arrows, ellipses, lines). Shows what the viewer will see on screen.

2. **Annotations** — notes on:
   - Animation direction (what moves, in what order, timing)
   - Transition type (cut/fade/slide)
   - Style notes (chalk-on-charcoal, flat vector, etc.)
   - Color palette for this beat

3. **Asset requirements** — what needs to be produced:
   - `Excalidraw → animated` — diagram rendered natively by video engine
   - `Gemini image` — static image generated via Gemini (include prompt direction)
   - `React component` — coded diagram (component name, data shape, reveal pattern)
   - `Sourced media` — screenshots, logos, photos to download/capture
   - `Built-in` — uses existing text_overlay/counter components

4. **Narration preview** — the voiceover text this beat accompanies

**Batch flow:**
```
Present batch (1 section, ~3-5 beats) to user
  → User reviews each beat
  → User directs changes ("make the chain bigger", "add a warning icon", etc.)
  → Claude updates the specific beats
  → User approves the batch
  → Move to next section
```

### Pass 3: Approve

Mark reviewed beats as `approved` in the manifest.

```bash
# Approve specific beat
npx tsx scripts/approve-storyboard.ts --slug <slug> --beat <beat-id>

# Approve all beats in a section (after section review)
npx tsx scripts/approve-storyboard.ts --slug <slug> --all

# Check status
npx tsx scripts/approve-storyboard.ts --slug <slug> --status
```

**Status lifecycle:** `scaffold` → `sketch` → `approved`

---

## Asset Manifest

After all beats are approved, compile the master asset manifest. This goes at the bottom of the storyboard or in a separate `asset-manifest.md` file.

**7 categories:**

| # | Category | Description |
|---|----------|-------------|
| 1 | **Excalidraw diagrams** | Diagrams that render natively via `excalidraw_diagram` visual type |
| 2 | **Gemini image generation** | Static images with style/prompt specs. Run sequentially (avoid rate limits) |
| 3 | **React components** | Coded diagram components with data shape and animation pattern |
| 4 | **Audio assets** | ElevenLabs voiceover (voice clone), BGM preset, SFX from library |
| 5 | **Brand assets** | Logo, fonts, color palette, video dimensions |
| 6 | **Sourced media** | Platform logos, screenshots, photos — things to download/capture/license |
| 7 | **Production notes** | Total beats, duration, special patterns (progressive reveal, etc.) |

---

## Existing Scripts

| Script | Purpose |
|--------|---------|
| `scripts/generate-storyboard-scaffold.ts` | Pass 1 — empty frame grid |
| `scripts/generate-storyboard-fill.ts` | Pass 2 — geometric sketches per visual type |
| `scripts/approve-storyboard.ts` | Pass 3 — mark beats approved |
| `scripts/lib/excalidraw-elements.ts` | Factory: `makeRect`, `makeText`, `makeArrow`, `makeFrame`, `makeEllipse`, `makeLine` |
| `scripts/lib/excalidraw-svg-renderer.ts` | Render Excalidraw → SVG → PNG via sharp |
| `scripts/generate-storyboard-images.ts` | Post-approval: Gemini image gen from approved storyboard entries |
| `scripts/generate-storyboard-videos.ts` | Post-approval: AI video gen from storyboard images |

---

## Handoff to Asset Generation

Only after **all beats are approved** (`npx tsx scripts/approve-storyboard.ts --slug <slug> --status` shows all `●`):

1. Generate images: `npx tsx scripts/generate-storyboard-images.ts --script <path>`
2. Generate videos: `npx tsx scripts/generate-storyboard-videos.ts --script <path>`
3. Generate voiceover: `npm run voice:generate -- <script-path>`
4. Continue with `/video-pipeline` from step 3 onward

---

## Rules

- **Never generate all storyboard content at once.** Work in section-sized batches.
- **Never skip user review.** Every batch needs explicit approval before proceeding.
- **Scene sketches are directorial.** The user decides what goes on screen — Claude executes the vision.
- **Annotation panels are for Claude.** They guide downstream production steps.
- **Asset requirements are binding.** If the storyboard says "Gemini image", that's what gets generated — not a React component or Excalidraw diagram.
- **The manifest is the contract.** All parties (image generation, component coding, audio) reference it.
- **Use existing factory functions.** Don't write raw Excalidraw JSON — use `scripts/lib/excalidraw-elements.ts`.
- **Excalidraw Live** (`npm run storyboard:live -- <path>`) can be used for real-time visual editing alongside programmatic changes.

---

## `--mode personal` (com.ikenga.studio)

When run inside `com.ikenga.studio`, this skill operates in **personal mode** (`--mode personal`):

- The lifted 7-state approval machine collapses to a single `Cell.approved` boolean (Round 2 schema decision). The skill writes `approved: true/false`, not `pending-review`/`needs-rework`.
- No multi-party review handoff: there is one author. The "review → approve" loop becomes a self-review pause in the studio canvas.
- Per-rung inline `comments[]` stay available for self-notes but are not surfaced as threaded/attributed comments.
- Rung directory tokens follow `rungDir()` (`beatsheet` / `lofi` / `hifi`), not the enum strings.

Invoke as `storyboard-workflow --mode personal` (the default inside the studio shell).
