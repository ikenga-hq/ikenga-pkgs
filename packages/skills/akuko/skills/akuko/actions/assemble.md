---
name: assemble
description: "Preview the film as an animatic (free); the rough cut and picture lock are not built yet."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/assemble.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - sidecar
  - chat
---

# action: `assemble` — preview the film; rough cut and picture lock

**Loaded when**: the person wants to watch the film so far ("make an animatic", "let me see it with the timing", "preview"), or runs `/akuko assemble`.

**Reads first**: `../lib/state.md` (§7 assemble), `../lib/hosts.md`.

**Stage**: `assemble` (7) · free. Never spends, never approves, never marks a stage done.

Two parts, and only the first is built:

| Route | What | Built |
|---|---|---|
| `assemble preview` | An animatic preview from the approved key frames, timed to the shots | **Yes** (below) |
| rough cut, picture lock | The timeline, its review, the locked cut (WP-13 · WP-15) | **Stub (WP-02).** Not built: tell the person so, offer `assemble preview` and `/akuko export` (the DaVinci Resolve handoff), and stop. Do not improvise a rough cut. |

## `assemble preview` — free animatic preview

What it makes: every live shot in film order, holding its **approved** key frame for exactly the shot's `duration_s`, with a gentle move **only where the shot asks for one** (its still move, else its motion note, else its camera move such as `push-in`, else a camera note such as "slow dolly in"; static shots hold, and fast moves such as a whip-pan are never made). A shot whose key frame is not approved yet is **black** for its length, so the timing stays the film's. Silent, 1280 x 720 for 16:9 (two thirds of the export frame), one MP4. The picture comes from the same move renderer as the Resolve export (`../handoff/render-moves.ts`). Code: `../assemble/preview.ts`, `../assemble/cli.ts`.

**It is a preview, not stage output.** It is never a review unit: no unit, asset, decision or ledger entry is made, nothing in `akuko.json` changes, and no stage moves (`stages.assemble` stays as it is). Say that to the person in those words every time, along with which shots were black and why.

Steps:

0. **Fold decisions first** (`../decisions/cli.ts fold`, `../lib/state.md` §Decision folding) so the preview uses what the person approved last. Tell them what the fold reported.
1. **Dry run**: `node --experimental-strip-types ../assemble/cli.ts preview --project <folder> --dry-run`. It prints one line per shot (length; key frame and move, or black and why), anything left out (a shot with no duration), and the notice. Show the person the black shots before rendering.
2. **Render**: the same without `--dry-run` writes `<project>/cut/preview/animatic-preview.mp4` (`--out <file>` to put it elsewhere; `--fps`, default 24). Without ffmpeg it writes nothing and says so; the timing list is still the answer.
3. **Hand it over** with the notice: what it is, that it is not saved to the project or reviewed, and that the rough cut and picture lock are not built yet. Offer `/akuko export` for an editable timeline.

**Host A (claude.ai).** The workspace has Node and usually ffmpeg, but the project lives in the board's database: read it (ArtifactData `get` of `akuko/project`), save it to a file, download each approved key frame into one folder named `<asset id>.<ext>` (or its file name), and run `../assemble/cli.ts preview --state <file> --media <folder> [--out <file>]`. Hand the MP4 to the person as a download. Do not store it with `storeAsset()` and do not add it to the project.

## Rules it inherits

- Detect the host first; read the project only through the host adapter (`../hosts/`). The preview writes no project state.
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Free: no provider call, no spend gate. It never approves anything and never auto-advances; rough cut and picture lock, when built, will end at a review gate like every other stage.
