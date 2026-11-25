---
name: assemble
description: "Preview the film as an animatic, or render a rough cut with sound (both free by-products); picture lock is not built yet."
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

# action: `assemble` — preview the film, render a rough cut; picture lock

**Loaded when**: the person wants to watch the film so far ("make an animatic", "let me see it with the timing", "preview", "make a rough cut", "cut it together with the voice-over"), or runs `/akuko assemble`.

**Reads first**: `../lib/state.md` (§7 assemble), `../lib/hosts.md`.

**Stage**: `assemble` (7) · free. Never spends, never approves, never marks a stage done.

Three parts; the first two are built:

| Route | What | Built |
|---|---|---|
| `assemble preview` | An animatic preview from the approved key frames, timed to the shots, silent | **Yes** (below) |
| `assemble rough` | A rough cut: approved clips, else key frames, conformed to the shots, with the approved voice-over and any music, room tone and effects the person points at | **Yes** (below). A by-product, not a review unit. |
| picture lock | The cut's review and the locked cut (WP-13 · WP-15) | **Stub (WP-02).** Not built: tell the person so, offer `assemble rough` to watch the cut and `/akuko export` (the DaVinci Resolve handoff) to edit it, and stop. Do not improvise a review gate or a locked cut. |

## `assemble preview` — free animatic preview

What it makes: every live shot in film order, holding its **approved** key frame for exactly the shot's `duration_s`, with a gentle move **only where the shot asks for one** (its still move, else its motion note, else its camera move such as `push-in`, else a camera note such as "slow dolly in"; static shots hold, and fast moves such as a whip-pan are never made). A shot whose key frame is not approved yet is **black** for its length, so the timing stays the film's. Silent, 1280 x 720 for 16:9 (two thirds of the export frame), one MP4. The picture comes from the same move renderer as the Resolve export (`../handoff/render-moves.ts`). Code: `../assemble/preview.ts`, `../assemble/cli.ts`.

**It is a preview, not stage output.** It is never a review unit: no unit, asset, decision or ledger entry is made, nothing in `akuko.json` changes, and no stage moves (`stages.assemble` stays as it is). Say that to the person in those words every time, along with which shots were black and why.

Steps:

0. **Fold decisions first** (`../decisions/cli.ts fold`, `../lib/state.md` §Decision folding) so the preview uses what the person approved last. Tell them what the fold reported.
1. **Dry run**: `node --experimental-strip-types ../assemble/cli.ts preview --project <folder> --dry-run`. It prints one line per shot (length; key frame and move, or black and why), anything left out (a shot with no duration), and the notice. Show the person the black shots before rendering.
2. **Render**: the same without `--dry-run` writes `<project>/cut/preview/animatic-preview.mp4` (`--out <file>` to put it elsewhere; `--fps`, default 24). Without ffmpeg it writes nothing and says so; the timing list is still the answer.
3. **Hand it over** with the notice: what it is, that it is not saved to the project or reviewed, and that picture lock is not built yet. Offer `assemble rough` for a cut with clips and sound, and `/akuko export` for an editable timeline.

**Host A (claude.ai).** The workspace has Node and usually ffmpeg, but the project lives in the board's database: read it (ArtifactData `get` of `akuko/project`), save it to a file, download each approved key frame into one folder named `<asset id>.<ext>` (or its file name), and run `../assemble/cli.ts preview --state <file> --media <folder> [--out <file>]`. Hand the MP4 to the person as a download. Do not store it with `storeAsset()` and do not add it to the project.

## `assemble rough` — free rough cut with sound

What it makes: every live shot in film order, each exactly the shot's `duration_s`, as one MP4 with sound. Code: `../assemble/rough.ts`, `../assemble/cli.ts`.

- **Picture**, per shot: the **approved** clip (`<shot>_clip`) when there is one. A clip longer than the shot plays from its start and is cut at the shot's end; a shorter one holds its last frame for the rest. Else the approved key frame, held, with the same gentle move as the preview. Else **black** for its length, with the reason. Same frame as the preview (1280 x 720 for 16:9), 24 fps unless `project.fps` or `--fps` says otherwise. An approved lip-sync clip is not cut in (the export places it); the plan says so.
- **Voice**: each approved voice-over take at its shot's start plus 0.1 s, normalised to -16 LUFS. A take that runs past its shot is kept whole, with a warning. With no approved take, the single `audio.narration` track from the start.
- **Beds** the person points at with flags (they are not stage units here, and approved music or effect assets in the project are not laid unless named with a flag; the plan lists them):
  - `--music <file> [--music-offset <s>]`: from the start of the film, starting `<s>` seconds into the file, at -24 LUFS, ducked under the voice (a compressor keyed from the voice bus), faded out over the last 2 s;
  - `--room-tone <file>`: low under everything (about -36 LUFS), looped to the film's length;
  - `--sfx <file>@<shot id>` (repeat it): at that shot's start, trimmed to the shot, at -24 LUFS.
- **Mix**: everything mixed, cut to the film's length, then a limiter. After the render the integrated loudness is measured and printed (the recipe came out near -16 LUFS).
- **A project with `audio.master`** (locked audio that sets the timing) is cut on that clock instead: each shot at its `film` time, black where no shot is, as long as the master. The master is laid whole and untouched (no loudness change, no limiter when it is alone). Voice-over takes and the narration track are not laid, because the master covers them; beds can still go on top. A shot with no film time is left out and listed.

**It is a by-product, not stage output.** It is never a review unit: no unit, asset, decision or ledger entry is made, nothing in `akuko.json` changes, and no stage moves (`stages.assemble` stays as it is). Say that to the person in those words every time, along with which shots were black and why, which clips were cut or held, and what was left out.

Steps:

0. **Fold decisions first** (`../decisions/cli.ts fold`), as for the preview. Tell the person what the fold reported.
1. **Ask for beds**: music, room tone or effects they want under the cut, and which shot each effect belongs to. They are optional.
2. **Dry run**: `node --experimental-strip-types ../assemble/cli.ts rough --project <folder> --dry-run [--music <file> --music-offset <s>] [--room-tone <file>] [--sfx <file>@<shot id> ...]`. It prints one line per shot (length; clip with what was cut or held, key frame and move, or black and why), one line per sound (where it starts, its level), anything left out, warnings, and the notice. An effect on a shot that does not exist, or a missing master, is a "cannot render" line (exit 2): fix it first. Show the person the plan before rendering.
3. **Render**: the same without `--dry-run` writes `<project>/cut/rough/rough-cut.mp4` (`--out <file>` to put it elsewhere). Without ffmpeg it writes nothing and says so; the plan is still the answer. The command passes the mix to ffmpeg as a file, `-/filter_complex` on FFmpeg 7 and later, `-filter_complex_script` on older builds, and tries the other if the first is refused.
4. **Hand it over** with the notice and the measured loudness. You cannot hear it: say the person must listen for levels, the ducking and anything that clashes. Picture lock is not built yet; offer `/akuko export` for an editable timeline.

**Host A (claude.ai).** As for the preview: save the project to a file, download each approved clip, key frame and voice-over take into one folder named `<asset id>.<ext>` (or its file name), and run `../assemble/cli.ts rough --state <file> --media <folder> [--out <file>]` with any bed flags. Hand the MP4 over as a download; do not store it with `storeAsset()` and do not add it to the project.

## Rules it inherits

- Detect the host first; read the project only through the host adapter (`../hosts/`). The preview and the rough cut write no project state.
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Free: no provider call, no spend gate. It never approves anything and never auto-advances; picture lock, when built, will end at a review gate like every other stage.
