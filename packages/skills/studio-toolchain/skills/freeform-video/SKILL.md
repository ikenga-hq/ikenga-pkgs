<!-- LIFTED-FROM: royalti-co/.claude/skills/freeform-video (hard-copied 2026-05-22 for com.ikenga.studio; edit here, do not diff back) -->
---
name: freeform-video
description: Bespoke freeform video pipeline — multi-rung storyboard authoring (beat sheet → lo-fi TSX + stills → hi-fi TSX + stills → final video). Invoked by /video-bespoke. Resume-aware via storyboard.json — works one rung at a time and pauses for human review in the storyboard app.
---

# Freeform Video Pipeline

Bespoke video authoring for the Royalti video engine. Replaces the deprecated YAML-driven `/video-pipeline` for short, design-led clips (Ask Roy, marketing announcements, founder updates).

## Trigger

Invoked by `/video-bespoke {slug}` or `/video-bespoke continue {slug}`. Never run unprompted.

## Three-Rung Workflow

The storyboard system has three progressive fidelity rungs, mirrored in `compositions/{slug}/storyboard.json` under `current_rung`:

| Rung | Key | Output | Review gate |
|------|-----|--------|-------------|
| 0 | `0_beat_sheet` | Text only — id, label, time, narration_excerpt, intent | Human approves each beat in storyboard app |
| 1 | `1_lofi` | Wireframe still PNG via `BrandProvider lofi={true}` | Human reviews layout/copy fidelity |
| 2 | `2_hifi` | Production still PNG with full palette + glows | Human approves final look |

When every beat at the current rung has `status: "approved"`, the pipeline advances to the next rung. The skill never auto-advances past `pending-review` — the human in the storyboard app drives every transition.

## Resume Contract

Always start by reading `compositions/{slug}/storyboard.json`. Then:

1. Find the current rung (`storyboard.current_rung`).
2. Find the next beat at that rung whose status is `pending` or `needs-rework`.
3. Work on ONE beat at a time. Never batch-update an entire rung in one call.
4. After producing the output, set status to `pending-review` and stop.

If every beat at the current rung is `approved`, advance `current_rung` by 1 and start the next rung's first pending beat.

If every beat at every rung is `approved`, render the final mp4 (Final Video phase below) and exit.

## Phase A — Beat Sheet (Rung 0)

**Input:** blog post or brief (path passed as arg, or inferred from slug).

**Steps:**
1. Read the source content. Identify 6-8 narrative beats:
   - id (kebab-case, unique)
   - label (1-3 words, human-readable)
   - time range in seconds (cumulative, no gaps)
   - narration_excerpt (1-2 sentences, lifted from blog or rewritten for spoken cadence)
   - intent (free-form note: visual treatment, animation cues, palette)
2. Write `compositions/{slug}/storyboard.json` with all beats at `rungs["0_beat_sheet"].status = "pending-review"`.
3. Run `/generate-voiceover` over the concatenated narration. Save audio to `public/{slug}/narration.mp3` and word timestamps to the storyboard's `narration.words` array.
4. Stop. Tell the human to review in the storyboard app.

## Phase B — Lo-fi TSX + Stills (Rung 1)

**Pre-condition:** every beat's rung-0 status is `approved`.

**Steps for each pending rung-1 beat:**
1. If the composition file does not yet exist, create `src/compositions/{Slug}ClipVideo.tsx` (PascalCased slug + `ClipVideo.tsx`). Required structure (verbatim from `AskRoyClipVideo.tsx`):
   - `defineBeats([...], { fps: 30 })` at module top, exported as `{slug}Beats`.
   - Brand palette as `const {slug}Palette: BrandPaletteWithMode = {...}` — never inline hex.
   - Inner component reads `usePalette()` + `useStoryboard()`.
   - Composition root wraps with `<BrandProvider palette={...} lofi={renderRung === "1_lofi"}>` and `<StoryboardProvider slug={...} beats={...} narration={...}>`.
   - Caption phrases passed to `<CaptionBar phrases={CAPTIONS} />` at composition root (NOT inside any Sequence).
   - `defineComposition({ id: "{Slug}Clip", ..., schema, beats, narrationFile })` at module bottom.
   - Schema includes `renderRung: z.enum(["1_lofi", "2_hifi"]).default("2_hifi")`.
2. For the specific beat being worked on, author its `<Sequence>` block using ONLY primitives:
   - **Stat** for callout numbers ("20 min", "126 tools")
   - **RevealList** for staggered card reveals
   - **HighlightWords** for accent-coloured words inside body copy
   - **KenBurns** to wrap any `<Img>` with slow zoom
   - **Annotation** for arrow + label callouts
   - **ChatBubble** for messaging UI
   - **AvatarBadge** for persona reveals
   - **CaptionBar** for the bottom phrase pill
   - Motion vocabulary: `settle`, `snap`, `bloom` for entrances; `lag`/`lead` for offsets; `applyOffset` to combine with cue frames.
   - Anchor reveal cues to narration words via `useNarrationSync(...).frameForWord("...")` whenever possible.
3. Add the new composition to `scripts/render-beat-still.ts`'s `SLUG_TO_COMPOSITION_ID` map and import it at the top of the file.
4. Add the import to `src/Root.tsx` so Studio picks it up: `import "./compositions/{Slug}ClipVideo";`
5. Render the still: `npm run still:beat -- --slug {slug} --beat {beat-id} --rung lofi`
6. The CLI updates `storyboard.json` with `still_path` + `status: "pending-review"`. Tsx_anchor should be set manually if not present (`src/compositions/{Slug}ClipVideo.tsx:{line}` — point at the Sequence opening).
7. Stop. Tell the human to review in the storyboard app.

## Phase C — Hi-fi TSX + Stills (Rung 2)

**Pre-condition:** every beat's rung-1 status is `approved`.

**Steps for each pending rung-2 beat:**
1. The composition file already exists (built in Phase B). Modifications are limited to:
   - Tweaks that need real palette/glows (these are gated by `palette.lofi` checks already inside primitives — usually no change required).
   - Adding emphasis / motion polish via `bloom`, secondary `lag()` cues, or new highlight words.
   - Never restructure the beat — Phase B's layout is what the human approved.
2. Render the hi-fi still: `npm run still:beat -- --slug {slug} --beat {beat-id} --rung hifi`
3. Stop. Tell the human to review in the storyboard app.

## Phase D — Final Video

**Pre-condition:** every beat's rung-2 status is `approved`.

**Steps:**
1. Render: `npx remotion render {Slug}Clip output/videos/{slug}.mp4`
2. Confirm duration + dimensions with `ffprobe`.
3. Mark the storyboard's `current_rung` as 2 and exit. Tell the human the mp4 is ready.

## Comment Handling (any rung)

A beat with `status: "needs-rework"` AND comments means the human left feedback. Process:

1. Read `comments[]` (each has `{ ts, rung, text }`).
2. Filter for comments where `rung === current_rung`.
3. Apply the changes:
   - Rung 0: rewrite the beat's `content` field.
   - Rung 1+: edit the beat's Sequence block in the composition TSX. Re-render the still.
4. Append a new comment: `{ ts: Date.now(), rung: current_rung, text: "Revised: <one-line summary>" }`
5. Set status back to `pending-review`.
6. Stop. Tell the human to re-review.

## Important Constraints

- **Never advance a beat past `pending-review` automatically.** Only the human (via the storyboard app) can mark a beat `approved`.
- **Never modify approved beats** unless the user passes `--reset` to /video-bespoke.
- **Always work one beat at a time.** Don't batch multiple beats in a single tool call.
- **Never inline hex colors** in composition body. Use `usePalette()` + the composition's palette constant.
- **Never write raw `spring()` calls.** Use `settle`, `snap`, `bloom` from `@/motion`.
- **Never inline cards/bubbles/badges/captions.** Use the primitives.
- **Always render stills via the CLI**, not direct `npx remotion still` invocations — the CLI handles composition-id lookup and atomic storyboard.json writeback.

## Reference Implementation

`src/compositions/AskRoyClipVideo.tsx` is the canonical exemplar. Crib structure, palette pattern, scene composition, and Sequence layout from there. Do not deviate from its shape unless a primitive papercut requires it (in which case log to `experiments/freeform-rewrite/03-primitive-papercuts.md`).

## File Layout

```
<video-engine>/
├── compositions/{slug}/
│   ├── storyboard.json          ← single source of truth (read + write)
│   └── stills/
│       ├── {beat}-1_lofi.png    ← rendered by Phase B
│       └── {beat}-2_hifi.png    ← rendered by Phase C
├── src/compositions/
│   └── {Slug}ClipVideo.tsx      ← composition source (created in Phase B)
├── public/{slug}/
│   ├── narration.mp3            ← TTS output
│   └── narration-words.json     ← word timestamps
└── output/videos/
    └── {slug}.mp4               ← Phase D render
```
