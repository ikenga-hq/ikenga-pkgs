---
name: export
description: "Hand the approved film to DaVinci Resolve: media in shot order plus an FCPXML/EDL timeline."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/export.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - sidecar
  - chat
---

# action: `export` — hand the approved film to DaVinci Resolve

**Loaded when**: the user runs `/akuko export` (or says "export", "send to Resolve", "give me a timeline"). It does not wait for picture lock: it exports what is approved **now** and lists the rest.

**Reads first**: `../lib/state.md` (§8 export), `../lib/hosts.md`.

**Stage**: `export` (8) · free (no provider, no spend). The export is a by-product, not a review unit: it moves no stage or unit status and writes nothing to `akuko.json`. Never approves.

**What is judgement and what is code.** Which shot shows what, every length, the timeline files, the copies and the lists of what was left out are code in `../handoff/` (tested). Yours: choosing the frame rate with the person (the project records none), reading them the summary and the "left out" list, and walking them through the import in `README.md`.

## What it writes

`node --experimental-strip-types ../handoff/cli.ts export --project <folder> [--out <folder>] [--format fcpxml|edl|both] [--fps 24] [--timeline-only] [--link-media]` (hosts B and C). Default folder `<project>/export/resolve/`:

```
media/      001_sc1_sh1.mp4 ...   approved clips and key-frame stills, copied, named in shot order
audio/      001_sc1_sh1_vo.wav    approved voice-over, music, SFX
captions/   captions.srt .vtt     and captions_timeline_01h.srt (the cues moved to the timeline's 01:00:00:00 start)
timeline.fcpxml                   the main file: shots in order, each at its own length
edl/        video.edl audio-N.edl fallback (--format edl or both)
README.md  LEFT-OUT.md  checksums.sha256  export-manifest.json
```

- **Order and length.** Shots in document order (the order `sound` uses). A shot lasts its `duration_s`, in whole frames: seconds x frame rate, rounded to the nearest frame (halves up, at least one), shot by shot, so the timeline is exactly the sum of its shots. The timeline starts at 01:00:00:00.
- **Video, per shot:** the approved clip, cut to the shot (a longer clip is cut at the shot's end; a shorter one is followed by a gap and named, never stretched); else the approved key frame as a still held for the shot; else a gap, listed as missing.
- **Audio:** each approved voice-over at its shot's first frame; if there are none, the single `audio.narration` track from the start. Approved music and SFX where their `placement:` tag says (film, scene or shot); without one they are copied and listed "not placed". Overlapping music or SFX go on separate tracks.
- **Only `approved` material** is used. Everything else, with its status, is in `LEFT-OUT.md` (a unit that was planned but never made is not listed). A shot with no `duration_s` is left off the timeline and listed.
- **Re-runs.** The manifest (written before the first copy, so an interrupted run is still recognised) lists what the tool wrote. A re-run of an unchanged project writes nothing; it replaces its own files, removes ones the new export no longer includes, and never touches anything else in the folder. **A file of akuko's that the person has edited since (a graded clip, notes in the README) is kept as it is, even at a path the new export would write**, and the summary names it: tell them. A file of the person's own at one of akuko's paths stops the export before anything is written.
- **Warnings to pass on.** Shots that share a `beat` in a Studio import (cells under one beat can be alternates of one moment, not successive shots; all are placed); a clip whose length could not be read; captions and narration come from the latest `sound sync`. Music or SFX placed on a scene or shot stops where that scene or shot ends.

## Steps

0. **Fold decisions first** (`../decisions/cli.ts fold`) so the export sees what the person has approved.
1. Ask the frame rate if they have not said (24 is the default; 23.976, 25, 29.97, 30, 50, 59.94 and 60 also work). It sets the timeline and the clip lengths.
2. Run `export`. Read the person the summary line, **every item in "left out"** and every Note: a clip shorter than its shot, a shot with a gap, a voice-over still waiting for review.
3. Point them at `README.md` in the export folder and walk the import with them. Do not tell them it imported: you cannot see Resolve. The check is `../handoff/MANUAL-CHECK.md`.

## A project with a master clock (`audio.master`)

When the project has locked audio (`audio.master`, set by the sheet import or by the person), the export is on **that clock** instead of end to end. Everything below replaces the "Order and length / Video / Audio" rules above; the rest (re-runs, only-approved, left-out) is the same. Projects without a master are exported exactly as before.

`node --experimental-strip-types ../handoff/cli.ts export --project <folder> [--link-media] [--fps 24 ...]`

- **Clock and rate.** The timeline starts at `audio.master.start_tc` (the FCPXML `tcStart` and every record timecode follow it) and is as long as the master, in whole frames (the master's length rounded **up**, so none of the sound is cut). The frame rate is `project.fps`; if the project has none, `--fps`. A `--fps` that disagrees with `project.fps`, or a `start_tc` frame the rate does not have (`00:00:00:24` at 24 fps), stops the export with a plain message.
- **Placement.** Each shot sits at its `film.in_s` and runs to `film.out_s`, each end rounded to the nearest frame, so shots that touch in film time touch on the timeline. Gaps are kept as gaps (a scene-start pause is empty video). A shot with no `film` time is left out and listed.
- **Picture per shot**, first that exists: an approved `<shot>_lipsync`; else an approved `<shot>_clip`; else the approved key frame as a still held for the slot; else a gap, listed as left out. A clip longer than its slot is cut at the slot's end; **a clip shorter than its slot is followed by a gap** (akuko never stretches or freezes a frame; the person may hold the last frame in Resolve) and named in the notes.
- **Cards.** Approved `card` assets are placed at their film times on V1 (a PNG is held for its slot; a video, e.g. rolling credits, is cut or followed by a gap like a clip). An unapproved card is left out and listed with its status.
- **Audio.** The master WAV is on A1, whole, from its first sample, never cut. **It is copied** into `audio/` by default; `--link-media` references it in place instead (the timeline points at the original file, nothing is copied or listed in `checksums.sha256`), which is what to use for a large file. Voice-over, music, SFX and the narration track are **not laid**: they are listed in LEFT-OUT.md as "covered by the master". **The sound of a picture file is never used**: a clip made with its own sound is muted in the FCPXML and named in the README.
- **Camera moves on stills.** A still whose shot has a `move` gets an `adjust-transform` with scale and position keyframes across its slot (position in percent of frame height, y up, as Apple documents; `ease` mapped to keyframe interpolation), **and a marker** carrying the same numbers in words. The EDL cannot carry a move: it has a `* MOVE` comment, and the README lists every move in a table.
- **What to tell the person.** Read them the summary, the left-out list and the **moves table**, and say plainly that whether Resolve imports the keyframes is **unverified**: they should open one still after import, and if it does not move, apply the move by hand from the table (the marker names it). Walk them through `../handoff/MANUAL-CHECK.md` part 5 once, and ask them to report what M7 showed.

**Sources for the transform keyframes** (read 2026-11-10): the structure is Apple's FCPXML reference, "Animation" (<https://developer.apple.com/documentation/professional-video-applications/animation>: `param` > `keyframeAnimation` > `keyframe`, position in percent of the project's height) and the `FCPXMLv1_8.dtd` content models (`adjust-transform` before anchored items, then `marker`). **Whether Resolve imports them is not settled by Blackmagic's own documentation**: its manual says an XML import can bring in position, scale and rotation from the source NLE ("Use sizing information", DaVinci Resolve 18.6 manual, "Importing and Conforming Timelines") and does not mention keyframed animation. User reports are mixed: a 2023 Creative COW thread says keyframed position and scale on **stills** did not come across from Final Cut Pro XML while video clips kept theirs (<https://creativecow.net/?p=2448032>; I saw this in a search result and did not open the thread), and older threads report static results where a move was keyframed. So the markers and the README table are the working route until the person's M7 check says otherwise.

## Why FCPXML 1.8 (and EDL as the fallback)

Chosen from what Blackmagic documents, read 2026-11-09:

- Resolve imports **AAF, EDL, XML, FCPXML, DRT, ADL and OTIO** timelines: Resolve's own scripting README, `ImportTimelineFromFile` (the v21.0 and v20.3 copies: <https://gist.github.com/X-Raym/2f2bf453fc481b9cca624d7ca0e19de8>).
- Resolve's manual, "Importing and Conforming Timelines" (the Resolve 21 manual, mirrored at <https://docs.imaster.org/davinci-resolve-21-manual/part-3-ingest-and-organize-media/ch.-22-importing-and-conforming-timelines>): an XML or AAF import can **import the source clips themselves from the file paths in the file** ("Automatically import source clips into media pool"); the **Relink** command matches on file name and timecode and searches subfolders; for an **EDL**, "file names are never used when conforming": it is timecode and reel names, and the media must be imported first. That is why FCPXML is the main file (the media comes with it, matched by file) and the EDL a fallback.
- **Why version 1.8.** Blackmagic does not say which FCPXML versions it reads, not in anything I could open. User reports: Resolve Studio 18.6.6 rejects 1.12 and opens 1.11 (<https://github.com/CommandPost/CommandPost/issues/3370>); a Blackmagic forum thread on 1.9 and 1.10 exists (<https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=151297>) but would not load for me. So the file is 1.8, the newest version whose `asset` carries a plain `src` file URL (1.9 moved it into `media-rep`), which a newer Resolve is expected to read. The DTD is Apple's `FCPXMLv1_8.dtd` (<https://github.com/CommandPost/CommandPost/tree/develop/src/extensions/cp/apple/fcpxml/dtd>); the tests validate the output against it when `AKUKO_FCPXML_DTD` points at the file.
- **Not chosen:** OTIO (Resolve lists it, but I found no Blackmagic text on what it relinks or carries); AAF (a binary format that needs a writer library, with no clear gain here); Premiere-style XML (older, weaker on stills and gaps).
- **Unverified:** that Resolve imports this exact file cleanly. Nothing here ran Resolve. `../handoff/MANUAL-CHECK.md` is how the person confirms it, and what to report if it does not.

## Host A (claude.ai)

There are no local files to copy there, and the workspace lasts one chat, so **the main route is: the person runs `/akuko export` in Claude Code with the project folder** (`../lib/hosts.md`: the project never lives in claude.ai's workspace). Say that and stop unless they ask for more.

If they want a timeline from claude.ai anyway, there is one narrow route: read the project from the artifact database, put it in a **throwaway, read-only scratch copy** (never keep it, never write back, delete it when done; it is not the project), run `handoff/cli.ts export --timeline-only` on that copy, and **hand the person the `timeline.fcpxml` text itself plus `DOWNLOAD-LIST.md`** (every asset file to download from the artifact store and the name to save it under in `media/` and `audio/`). Tell them what the timeline-only README says: nothing was copied, clip lengths were not checked, and the clips will open **offline** in Resolve until they relink them to the folder where they saved the downloads. Do not invent another mechanism.

## Parked

Not built (plan Round 7): the in-house FFmpeg cut with MP4 masters and cutdowns, the Canva deck, and a host C bridge to Studio. If the person asks for an MP4, say it is not part of akuko yet and offer this handoff.

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Only a person moves a unit to `approved`. The export never does, and it never changes a status.
