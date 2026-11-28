<!-- LIFTED-FROM: royalti-co/.claude/skills/video-script-structure (hard-copied 2026-05-22 for com.ikenga.studio; edit here, do not diff back) -->
---
name: video-script-structure
description: Video script YAML schema V3 with beats[], storyboard[] sentence-level sync, progressive reveals, annotated images, screen mockups, and word-level subtitles for the Remotion video engine. Use when creating video scripts or converting blog content to video format.
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
---

# Video Script Structure Skill V3

## Purpose

Defines the structure and conventions for creating video scripts with **multi-beat visual cuts** that render in the Royalti Remotion video engine. Scripts are YAML files consumed by `BlogExplainerVideo` composition.

---

## Fireship.io Style Principles

1. **Rapid-fire delivery** — Dense information, no filler
2. **Visual-first** — Every concept gets multiple visual beats, never static for >4 seconds
3. **Humor and personality** — Not dry or corporate
4. **Time-constrained** — 3-8 minutes for educational content
5. **Fast cuts** — Average shot length 2-4 seconds, alternating visual types

### Timing Conventions

| Section Type | Duration | Beats |
|--------------|----------|-------|
| Hook | 10-15 seconds | 1 visual (short, impactful) |
| Main Section | 30-60 seconds | 5-6 beats (cut every 3-5s) |
| CTA | 10-20 seconds | 1 visual (end_screen) |

---

## YAML Schema V2

### Canonical Field Names

- **`narration`** — Voiceover text (NOT `script`)
- **`beats`** — Array of visual beats per section (NOT singular `visual`)
- **Hook and CTA** keep single `visual` (they're short enough)

### Root Structure

```yaml
video:
  title: string          # Video title (60 chars max for YouTube)
  slug: string           # URL-friendly identifier
  duration: string       # "M:SS" format (informational)
  style: string          # "educational" | "tutorial" | "explainer"

hook:
  narration: string      # Spoken content (multiline)
  visual: Visual         # ONE visual for the hook
  duration: number       # Optional, in seconds

sections:
  - id: string           # Unique section identifier
    title: string        # Section heading (shown as LowerThird)
    narration: string    # Spoken content for the full section
    beats:               # Array of visual beats (REQUIRED, min 1)
      - visual: Visual
        duration: number     # Seconds (2-8). Optional, auto-distributed if omitted.
        transition: string   # See Beat Transitions below. Default: "cut"
        emphasis: boolean    # Extra visual punch. Default: false
    duration: number     # Optional total section duration override

cta:
  narration: string
  visual: Visual         # Should be type: end_screen
  duration: number       # Optional

metadata:               # Optional
  source: string
  date: string
  tags: string[]
```

### Beat Transitions

| Transition | Effect | Frames |
|-----------|--------|--------|
| `cut` | Instant switch (default) | 0 |
| `fade` | Cross-dissolve | 8 |
| `slide_left` | Content slides from left | 10 |
| `slide_right` | Content slides from right | 10 |
| `push_left` | Both contents push left | 10 |
| `push_right` | Both contents push right | 10 |
| `zoom_in` | Scale + fade in | 10 |
| `zoom_out` | Scale + fade out | 10 |
| `wipe_left` | Wipe reveal from left | 10 |
| `clock_wipe` | Radial clock reveal | 12 |

---

## V3: Storyboard (Sentence-Level Visual Sync)

Beats can optionally include a `storyboard[]` that maps narration segments to visual actions. This enables Vox Media-style progressive reveals and annotated overlays synced to voiceover.

### Beat with Storyboard

```yaml
- visual:
    type: react_diagram
    diagram_type: flowchart
    diagram_data:
      steps:
        - label: "ISRC"
          description: "Recording ID"
        - label: "ISWC"
          description: "Composition ID"
        - label: "UPC"
          description: "Album ID"
      direction: horizontal
  duration: 8
  transition: slide_right
  storyboard:
    - segment: "ISRC identifies the recording."
      action:
        type: highlight_step
        index: 0
    - segment: "ISWC identifies the composition."
      action:
        type: highlight_step
        index: 1
    - segment: "UPC identifies the album."
      action:
        type: highlight_step
        index: 2
  subtitles: true    # Optional: word-level subtitle overlay
```

### Storyboard Action Types

| Action | Visual Type | Effect |
|--------|------------|--------|
| `highlight_step` | FlowChart | Highlight step at `index`, auto-reveal up to that step |
| `reveal_spoke` | HubSpoke | Reveal spoke at `index`, highlight it |
| `reveal_up_to` | Any diagram | Show first `count` elements |
| `highlight_stat` | StatGrid | Highlight stat at `index` with glow ring |
| `reveal_annotation` | annotated_image, screen_mockup | Show annotation at `index` |
| `reveal_all_annotations` | annotated_image, screen_mockup | Show all remaining annotations |
| `mask_reveal` | annotated_image | Reveal image from dark via mask |
| `zoom_to` | generated_image | Ken Burns zoom to `{x, y, scale}` |
| `emphasize_words` | text_overlay | Highlight specific `words[]` |
| `swap_text` | text_overlay | Replace text with new `content` |

### Subtitles

Set `subtitles: true` on a beat to show word-by-word highlighted captions at the bottom of the screen. Uses ElevenLabs character timestamps + @remotion/captions for precise word timing.

---

## V3: New Visual Types

### `annotated_image`

Base image with timed annotation overlays (Vox style: "here's the document, THIS is the part that matters").

```yaml
visual:
  type: annotated_image
  base_image: "royalty-statement-closeup"   # Asset ID in visual manifest
  annotations:
    - label: "Reporting Period"
      x: 25        # Percentage (0-100)
      y: 15
      style: highlight   # circle | arrow | highlight
    - label: "Track IDs"
      x: 50
      y: 40
      style: circle
  mask_reveal: true    # Optional: image hidden until first annotation
```

### `screen_mockup`

App screenshot or recording with browser chrome frame + annotations. Supports Playwright auto-capture.

```yaml
visual:
  type: screen_mockup
  src: "royalti-dashboard.png"    # Static asset (when no capture)
  capture:                         # Optional: Playwright auto-capture
    url: "https://app.royalti.io/statements"
    mode: screenshot               # screenshot | recording
    viewport: { width: 1920, height: 1080 }
    wait_for: "[data-testid=table]"
    actions:
      - { click: ".upload-btn" }
      - { wait: 1000 }
    auth:
      cookie_file: ".env.playwright-cookies"
  annotations:
    - label: "Upload Button"
      x: 30
      y: 50
      style: circle
  device: browser                  # browser | mobile | tablet | none
```

---

## Visual Types

### `react_diagram`

```yaml
visual:
  type: react_diagram
  diagram_type: flowchart | timeline | comparison | hubspoke | statgrid
  diagram_data: { ... }
```

**Diagram data shapes:**

- **flowchart**: `{ steps: [{ label, description?, icon? }], direction?: "horizontal"/"vertical" }`
- **timeline**: `{ events: [{ date, label, description? }], direction? }`
- **comparison**: `{ left: { title, items: string[] }, right: { title, items: string[] }, vsLabel? }`
- **hubspoke**: `{ center: { label, icon? }, spokes: [{ label, icon? }] }`
- **statgrid**: `{ stats: [{ value, label, prefix?, suffix? }], columns?: 2/3/4 }`

### `generated_image`

```yaml
visual:
  type: generated_image
  prompt: "Descriptive Gemini prompt — specific composition, lighting, mood"
  style: cinematic  # optional
```

### `text_overlay`

```yaml
visual:
  type: text_overlay
  content: "40% of Revenue Left on the Table"
  highlight_words: ["40%"]  # optional — words that get color/scale emphasis
```

### `counter_animation`

```yaml
visual:
  type: counter_animation
  content: "$3,000,000,000+"
```

### `code_snippet`

```yaml
visual:
  type: code_snippet
  code: |
    const royalties = await api.getRoyalties(artistId);
  language: typescript
```

### `end_screen`

```yaml
visual:
  type: end_screen
  headline: "Track All 7 Royalty Types"
  cta: "Try Royalti Free"
```

---

## Beat Composition Rules

1. **5-6 beats per 30 seconds** of narration
2. **Never repeat visual type** in adjacent beats (text -> diagram -> image -> text)
3. **Never repeat transition** more than twice in a row
4. **1-2 emphasis beats** per section for key moments
5. **First beat transition is ignored** (it's the section entry)
6. **At least 3 different visual types** per section

---

## Visual Type Decision Tree

Choose the right visual type based on content:

| Content Pattern | Visual Type | When to Use |
|----------------|-------------|-------------|
| Steps, workflows, pipelines | `react_diagram` (flowchart) | Structured data with clear sequence |
| Timelines, chronologies | `react_diagram` (timeline) | Date-ordered events |
| A vs B comparisons | `react_diagram` (comparison) | Two-sided analysis |
| Central concept + related items | `react_diagram` (hubspoke) | Relationship mapping |
| Key metrics, numbers | `react_diagram` (statgrid) | Dashboard-style stat cards |
| Hand-drawn / whiteboard feel | `excalidraw_diagram` | Sketchy, informal explanations |
| Conceptual illustrations | `generated_image` | Abstract concepts, metaphors |
| Real app screenshots | `screen_mockup` | Product demos, UI walkthroughs |
| Bold statements, key quotes | `text_overlay` | Emphasis moments, pull quotes |
| Dramatic statistics | `counter_animation` | Single big number reveals |
| Code examples | `code_snippet` | Technical tutorials |
| Final call-to-action | `end_screen` | Last beat of CTA section |

### `excalidraw_diagram` (Animated Hand-Drawn)

```yaml
visual:
  type: excalidraw_diagram
  diagram_type: flowchart | timeline | comparison | hubspoke | statgrid | process | mindmap | wireframe
  diagram_data: { ... }  # Same shapes as react_diagram equivalents
  roughness: 1           # 0=clean, 1=sketchy (default), 2=rough
  theme: dark            # light or dark (default: dark)
```

Renders as **animated SVG** in the composition (shapes spring in, arrows draw on, text fades). Supports storyboard actions (`highlight_step`, `reveal_up_to`) for progressive reveal.

Use `excalidraw_diagram` when you want a **casual, whiteboard-style** look. Use `react_diagram` for **polished, branded** diagrams.

---

## Complete Example

```yaml
video:
  title: "7 Types of Music Royalties Explained"
  slug: understanding-royalty-types
  duration: "5:30"
  style: educational

hook:
  narration: |
    You're leaving money on the table.
    Most independent artists collect only ONE of the SEVEN royalty types
    they're entitled to. That's up to 40% of your potential revenue—gone.
  visual:
    type: text_overlay
    content: "40% Revenue Left Behind"

sections:
  - id: intro
    title: "The Problem"
    narration: |
      Here's the thing—the music industry has SEVEN different ways
      to pay you, but they're spread across different organizations,
      different platforms, and different payment schedules.
      [BEAT]
      Let's break down each one in 5 minutes.
    beats:
      - visual:
          type: text_overlay
          content: "7 Ways The Industry Pays You"
        duration: 3
        transition: cut
      - visual:
          type: react_diagram
          diagram_type: hubspoke
          diagram_data:
            center:
              label: "YOUR MUSIC"
            spokes:
              - label: "Mechanical"
              - label: "Performance"
              - label: "Sync"
              - label: "Print"
              - label: "Digital Perf."
              - label: "Neighbouring"
              - label: "Micro-Sync"
        duration: 6
        transition: slide_left
        emphasis: true
      - visual:
          type: generated_image
          prompt: "Scattered US dollar bills on dark surface, music notes overlay, teal accent lighting"
        duration: 3
        transition: push_right
      - visual:
          type: text_overlay
          content: "Let's break it down"
        duration: 2
        transition: fade

  - id: mechanical
    title: "Mechanical Royalties"
    narration: |
      First up: Mechanical royalties.
      Every time your song is REPRODUCED—streamed, downloaded,
      or pressed to vinyl—you earn mechanical royalties.
      [BEAT]
      In the US, the MLC collects these from streaming platforms.
      Since 2021, they've distributed over 3 BILLION dollars.
      Are you registered?
    beats:
      - visual:
          type: text_overlay
          content: "1. Mechanical Royalties"
        duration: 2
        transition: cut
      - visual:
          type: react_diagram
          diagram_type: flowchart
          diagram_data:
            steps:
              - label: "Song"
                description: "Your original work"
              - label: "DSP"
                description: "Spotify, Apple Music"
              - label: "MLC"
                description: "Mechanical Licensing Collective"
              - label: "Artist"
                description: "Your wallet"
        duration: 5
        transition: slide_left
      - visual:
          type: generated_image
          prompt: "Vinyl record pressing machine close-up, dark industrial setting"
        duration: 3
        transition: push_right
      - visual:
          type: counter_animation
          content: "$3,000,000,000+"
        duration: 3
        transition: zoom_in
        emphasis: true
      - visual:
          type: text_overlay
          content: "Are YOU registered?"
          highlight_words: ["YOU"]
        duration: 2
        transition: fade

cta:
  narration: |
    That's 7 royalty types in 5 minutes.
    Stop leaving money on the table.
    Link in description to track all 7 in one dashboard.
  visual:
    type: end_screen
    headline: "Track All 7 Royalty Types"
    cta: "Try Royalti Free"

metadata:
  source: .company/content/blog-drafts/2026-01-06-understanding-royalty-types/06-final.md
  date: "2026-01-07"
  tags: [royalties, education]
```

---

## Script Writing Guidelines

**Spoken vs Written:**
- Blog: "Mechanical royalties are generated when your song is reproduced."
- Video: "Mechanical royalties. Every time your song is REPRODUCED—streamed, downloaded, pressed to vinyl—you earn these."

**Rules:**
- Remove passive voice, add emphasis with CAPS and dashes
- Break long sentences into fragments
- Include [BEAT] markers for pauses (+0.5s each)
- No sentences longer than 20 words
- Use `narration` (not `script`), `beats` (not `visual` singular)

---

## Timing Estimation

```
Total Duration ≈ (Source Word Count / 150) minutes
Section: 30-60s → 5-6 beats
Hook: 10-15s → 1 visual
CTA: 10-20s → 1 visual (end_screen)
```

## File Placement

```
.company/content/blog-drafts/YYYY-MM-DD-slug/
├── 06-final.md
├── video-script.yaml        # Generated by /generate-video-script

<video-engine>/
├── input/scripts/<slug>-script.yaml    # Copied for rendering
```
