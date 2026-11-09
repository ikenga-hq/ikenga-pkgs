# akuko blocks

These are motion blocks for titles and graphics, rendered by HyperFrames. Each block is one
HyperFrames **scene file** in `compositions/`. A film mounts a block from a host element and
sets that mount's variables:

```html
<div id="stat" data-composition-id="stat" data-composition-src="compositions/stat.html"
     data-start="12" data-duration="5" data-track-kind="graphics" data-width="1920" data-height="1080"
     data-variable-values='{"value": 12, "unit": "shots"}'></div>
```

The host id, the scene's `data-composition-id` and the key the block registers in
`window.__timelines` must all be the block's file stem; HyperFrames needs them to match.
The film's root `index.html` loads GSAP (see below), and the project keeps this folder's
layout: `compositions/`, `fonts/`. `index.html` here is a showcase that mounts every block
once, in turn, so `hyperframes lint` and `check` can cover all of them. It is a test bench,
not a film.

## Authoring rules

These rules come from gap G-01 (plan Round 5, R5-3/4/5). Each one is the reason a preview
can be trusted to equal the render (`engines/hyperframes/G-01.md`).

**What G-01 signed, and what it did not.** G-01 passed for its own composition on HyperFrames
0.9.19, on one Windows machine with hardware ANGLE, previewed through HyperFrames' own path
(`snapshot`). That is the preview this sign-off covers. A previewer that does not go through
HyperFrames is covered only for blocks that keep rule 3 (state as a pure function of time)
and rule 2 (fonts that load). The G-01 run showed a naive `tl.seek(t)` preview matching for
a composition that keeps them, and failing for one that does not (NC-1, NC-2). These blocks
were not each frame-measured against a render; they were checked by lint, check and eye.

1. **Preview only through HyperFrames' seek path (R5-3).** Stills come from `hyperframes
   snapshot` and video from `hyperframes render`. Both seek with `__player.renderSeek`, so
   callbacks fire the way the renderer fires them. A board or player that shows a block
   must call that same seek, never `timeline.seek(t)`: GSAP suppresses callbacks on a plain
   seek. That is how the spike's preview showed "0 min" where the render showed "20 min".
2. **Vendored fonts only (R5-4).**
   - Every family a block uses has an `@font-face` in that block, with
     `font-display: block`, pointing at `fonts/<file>.woff2` relative to the project root.
   - No font services, no `@import`, no installed or system fonts.
   - With its own faces declared, HyperFrames fetches nothing (G-01 run: `Fonts: 5 loaded`).
   - The vendored set is Latin only (`fonts/README.md`).
3. **State is a pure function of timeline time (R5-5).**
   - Everything visible at time *t* comes from tweens GSAP renders at *t*.
   - Text that changes over time, such as Stat's digits, is written by the setter of a
     linear "clock" tween, because GSAP writes tweened properties on every render, seeks
     included. Never set state only in `onUpdate`, `onStart` or `onComplete`.
   - Anything fixed for the block, such as which list slots are filled, which bubble sits on
     which side, or where the annotation points, is decided once at load from the
     variables. It must never come from measured text: text size depends on when the fonts
     load.
   - Not allowed: `Date.now`, unseeded `Math.random`, timers, `requestAnimationFrame`,
     `fetch`, `repeat: -1`, `play()`, and CSS `@keyframes`, `transition` or `animation`.
     CSS motion runs on the wall clock, not the timeline.
4. **HyperFrames scene contract.**
   - Styles, markup and script all go inside `<template>`, and the root is styled as `#root`.
   - Element ids carry the block's prefix, since ids must be unique on the assembled page.
   - Use `fromTo`, never `from` (a scene is re-seeked each time it shows).
   - No CSS `transform` on an element GSAP transforms.
   - Register the timeline once, paused, as the last step.
5. **GSAP is referenced, not shipped.** The film's `index.html` loads
   `https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js`. HyperFrames 0.9.19 answers
   that exact URL from its own vendored copy, so renders need no network.
   - **The version must match the HyperFrames pin.** HyperFrames serves only the GSAP it
     vendors: 0.9.19 vendors 3.15.0 (`HYPERFRAMES_GSAP_VERSION` in `engines/hyperframes/cli.ts`).
     Any other version's URL is fetched from the network at render time. The two are bumped
     together; `blocks.test.ts` checks every composition names the pinned version, and
     `g01.ts` refuses a HyperFrames install that lacks it.
   - GSAP's files say "Subject to the terms at https://gsap.com/standard-license". That is a
     no-charge licence but not an OSI one.
   - Whether it allows redistribution inside this Apache-2.0 repo was not established, so no
     copy is committed.
6. **Parameters are HyperFrames variables.**
   - Each block declares `data-composition-variables` on its root, binds plain text with
     `data-var-text`, and reads the rest once with `window.__hyperframes.getVariables()`.
   - Defaults are neutral placeholder copy.
7. **Check before use.** Run `hyperframes lint` and `check` on the project
   (`engines/hyperframes/verify-blocks.ts` does it per block) and look at a snapshot.
   `engines/hyperframes/blocks.test.ts` enforces rules 2–6 in CI without a browser.

## Motion vocabulary

Defined in `vocabulary.json`. Every block carries it verbatim as `const MOTION = {...}`, and
the test checks that the copy matches.

| word | ease | duration | for |
|---|---|---|---|
| `settle` | `back.out(1.5)` | 0.9 s | an arrival that overshoots a little and rests: cards, bubbles, a portrait |
| `snap` | `power3.out` | 0.3 s | a quick, clean arrival with no bounce: labels, lines of text, highlight bars |
| `bloom` | `sine.inOut`, scale 1.06, yoyo once | 0.2 s out + 0.2 s back | one emphasis on something that has just landed: a final number, a ring |

Derived uses, stated in each block:

- **Exits** are half the entrance and accelerate out (`power3.in`, 0.15 s): CaptionBar.
- **A line draw** (the Annotation arrow, the AvatarBadge ring) uses the `snap` ease over
  0.6 s, because a stroke needs longer than a snap.
- **KenBurns is linear** (`ease: "none"`). Constant speed is the point of the move, so it
  uses none of the three words.

## Blocks

| block | file | variables | motion |
|---|---|---|---|
| Stat | `compositions/stat.html` | kicker, value, from, decimals, unit, context, countStart, countDuration | card `settle`; kicker, unit and context `snap`; digits counted as a pure function of time (`power2.out`); number `bloom`s on landing |
| RevealList | `compositions/reveal-list.html` | title, item1–item4 (empty items are left out), at, stagger | title `snap`; items `settle`, staggered |
| HighlightWords | `compositions/highlight-words.html` | text (`*marked*` phrases), at, gap | line `snap`; per mark: bar grows `snap`, text turns accent, phrase `bloom`s |
| KenBurns | `compositions/ken-burns.html` | src (empty means a built-in plate), fromScale, toScale, x, y, duration | linear push and drift on a wrapper |
| Annotation | `compositions/annotation.html` | label, targetX, targetY, labelX, labelY, at | label `settle`; arrow draws on the snap ease over 0.6 s; target ring `snap` then `bloom` |
| ChatBubble | `compositions/chat-bubble.html` | msg1–msg4, sides, at, gap | each bubble `settle`s from its own corner |
| AvatarBadge | `compositions/avatar-badge.html` | name, role, initials, src, at | portrait `settle` (scale and turn); ring draws then `bloom`s; name and role `snap` |
| CaptionBar | `compositions/caption-bar.html` | phrase1–phrase3, t1–t3 (0.2, 1.4, 2.6 s) | each phrase `snap`s in; exits at half length, accelerating; the last phrase stays |

## Verification (HyperFrames 0.9.19, Windows, system Chrome)

Run on 2026-11-09:

```bash
export HYPERFRAMES_BROWSER_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
node --experimental-strip-types engines/hyperframes/verify-blocks.ts --hf <hyperframes.mjs> --out <scratch> --snapshot
```

Each block was mounted alone in a 5 s slot (`hostHtml`), and then all eight together in the
showcase. Counts are errors/warnings/infos:

| block | `lint` | `check` | runtime | layout | contrast | craft warnings |
|---|---|---|---|---|---|---|
| stat | ok 0/0/0 | ok | ok | ok | ok | `first_frame_empty` |
| reveal-list | ok 0/0/0 | ok | ok | ok | ok | `first_frame_empty` |
| highlight-words | ok 0/0/0 | ok | ok | ok | ok | `first_frame_empty` |
| ken-burns | ok 0/0/0 | ok | ok | ok | ok | `first_frame_empty` |
| annotation | ok 0/0/0 | ok | ok | ok | ok | none |
| chat-bubble | ok 0/0/0 | ok | ok | ok | ok | `first_frame_empty` |
| avatar-badge | ok 0/0/0 | ok | ok | ok | ok | none |
| caption-bar | ok 0/0/0 | ok | ok | ok | ok | `first_frame_empty`, `line_unread` (#cap-phrase-2) |
| showcase (all eight) | ok 0/0/0 | ok | ok | ok | ok | `first_frame_empty`, `film_silent`, `dead_stretch`, `line_unread` |

What the warnings mean here:

- **`first_frame_empty`**: the block enters from nothing at 0 s. Blocks are inserts inside a
  film, not stand-alone films whose first frame is a thumbnail, so this is by design.
- **`line_unread` on CaptionBar**: HyperFrames wants 0.5 s + 0.3 s per word for each phrase,
  and at least 2 s for a closing line. The three default phrases need about 6.5 s, and the
  test slot is 5 s. Set `t1`–`t3` for the real copy and slot length.
- **`film_silent` and `dead_stretch`**: these apply only to the 40 s showcase, which is a
  test bench with no sound and with gaps between blocks.

Each block's `audio_none` info is the same point as `film_silent`. The scratch snapshot
contact sheets were checked by eye: every block draws its default copy in the vendored
fonts.

Render time for the same setup (6 s 1920×1080 G-01 composition, MP4 through
`engines/hyperframes/cli.ts` `render()` with `HYPERFRAMES_BROWSER_PATH` set):

| profile | output | wall clock | HyperFrames "rendered in" | breakdown |
|---|---|---|---|---|
| final (`--quality delivery`, 30 fps) | 180 frames | 72.5 s | 57.1 s | setup 15.8 s, capture 36.7 s, encode 0.8 s |
| draft (`--quality draft --fps 15`) | 90 frames | 55.2 s | 41.6 s | setup 15.4 s, capture 22.7 s, encode 0.8 s |

`estimateRender()` is fitted to the **wall clock** of these two runs: 0.2 s per frame plus
38 s. `secondsPerFrameFrom()` recalibrates from a render's wall clock too, at the frame rate
of the profile used, never from HyperFrames' shorter "rendered in" figure.

- Draft saves capture time, because it renders half the frames. Encode is under a second
  either way, and setup (about 15 s inside HyperFrames, about 38 s of wall clock in all) is
  fixed. On short clips that fixed cost is most of the wait, so draft saves only about a
  quarter here.
- The estimate is rough (R-10). The spike measured 2–3 minutes for the same length on the
  same machine under different load.
- Telemetry: the wrapper sets `HYPERFRAMES_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` unless the
  caller passes `telemetry: true`.

## Out of scope here

- Studio's archetype blocks (`studio-archetypes`, explainer and product-narrative blocks)
  are Phase 4 profiles.
- The `animation-patterns` placeholder skill belongs to another package.
- Wiring blocks into `actions/motion.md` comes later.
