# Manual check: the Resolve handoff (user-attested)

Nothing in the automated tests runs DaVinci Resolve. This is the 10-minute check that a real Resolve imports the export the way the tests say it should. **A pass here is the Definition of Done for the handoff; until someone has done it, the format choice is reasoned from documentation, not proven.**

You need DaVinci Resolve (free or Studio). Note the version (Help > About) and fill in the result table at the end.

## 1. Make the fixture export

From `packages/skills/akuko/skills/akuko/handoff/`:

```
node --experimental-strip-types __fixtures__/make.ts <a new, empty folder>
```

It builds the short-story project ("The Last Ferry", 11 shots) with a mix of approved clips, key-frame stills, one gap and some audio, and exports it to `<folder>/export/resolve/`. The media are real and playable: a solid-colour PNG per still (a different colour for each shot), mp4 clips made with `ffmpeg` that show the shot id and a running timecode burned into the picture (so a wrong cut point or a late start is visible on screen), and WAV tones (voice-over 220 Hz, music 110 Hz, effects 880 Hz) so a misplaced sound is audible. **`ffmpeg` must be on your PATH**; without it `make.ts` says so and stops, and you should run this check on a real project instead (below). Nothing should be offline or black: if it is, that is a fail (check 7), not a fixture artefact.

(To check your own project instead: `node --experimental-strip-types handoff/cli.ts export --project <your project folder> --fps 24`, then use the same steps with your own shot list.)

## 2. Import

Follow `export/resolve/README.md`:

1. New project. Project Settings > Master Settings: timeline frame rate **24**, resolution 1920 x 1080.
2. File > Import > Timeline... > `timeline.fcpxml`. Keep "Automatically import source clips into media pool" ticked.

If Resolve shows an error dialog, write down its exact text and the Resolve version. Then try the fallback in the README (`edl/video.edl`) and note what happened. Both outcomes are useful.

## 3. What to look at

Open the new timeline on the Edit page.

| # | Check | Pass | Fail |
|---|---|---|---|
| 1 | **It imports** | A timeline named "The Last Ferry" appears, with no error | Any error dialog, an empty timeline, or a crash |
| 2 | **Order** | Video track 1 runs, left to right: sc1_sh1, sc1_sh2, sc1_sh3, a short gap, sc1_sh4, then five stills (sc2_sh1 to sc3_sh1), a gap (sc3_sh2), one more still (sc3_sh3). Clip names start with 001, 002, 003, 004, 005 ... in order | Any item out of order, missing, or doubled |
| 3 | **Lengths** | Timeline start timecode is 01:00:00:00 and the end is 01:01:09:00. The first clip is 6:00 long, the second 5:00, the third 4:00 then a 1:00 gap, the fourth 8:00. Click a clip and read its duration (Inspector, or the timecode of its start and end). The table in the README lists every shot's start and length | Any clip off by even one frame; a gap where a clip should be; clips overlapping |
| 4 | **Contiguous** | No unexpected gaps: only the two gaps named above | Any other gap or overlap |
| 5 | **Cut, not stretched** | sc1_sh1's clip file is longer than its shot (7 s against 6 s); on the timeline it is cut at 6:00, not sped up (the burned-in timecode on the clip's last frame reads 00:00:05:23) | A clip that plays faster or slower |
| 6 | **Audio** | Track A1 has two voice-over clips: one starting exactly at the first frame of sc1_sh1 (01:00:00:00), one exactly at the start of sc1_sh2 (01:00:06:00). A2 has a music clip from 01:00:00:00, 40:00 long. A3 has a second music clip from 01:00:00:00 that stops at 01:00:24:00 (it is placed on scene 1, which is 24 s, though its file is 40 s). A4 has one short effect starting at the start of sc1_sh4 (01:00:16:00). The sc1_sh4 clip also plays its own 330 Hz tone (it has a sound track of its own) | An audio clip on the wrong track, shifted from its shot's first frame, missing, or running past where it should stop; the clip's own tone missing |
| 7 | **Relink / nothing offline** | **Every clip, still and audio file is online, with a picture and sound.** Select a clip and look at its file path (Media Pool, or Clip Attributes): it points into `export/resolve/media/` or `audio/` with the shot-ordered name. If you then move the export folder, Relink Selected Clips pointing at the new place finds every file by name | **Any "media offline" or black clip straight after import**, paths that point somewhere else, or Relink cannot find files that are in the folder |
| 8 | **Stills** | The six key-frame shots hold for their full length (sc2_sh1 7 s, sc2_sh2 6 s, sc2_sh3 6 s, sc2_sh4 5 s, sc3_sh1 7 s, sc3_sh3 8 s), each in its own colour | A still that is 1 frame, or the wrong length |
| 9 | **Captions** (optional) | File > Import > Subtitle > `captions/captions_timeline_01h.srt`, drag it onto a subtitle track: the first line sits at the very start | Cues an hour late or not importable |

Also open `LEFT-OUT.md` and confirm it names, with the reason: `sc2_sh1_clip` (pending-review), `sc3_sh2` (nothing approved), `sc3_sh2_keyframe` (needs-rework), `sc1_sh3_vo`, `sc2_sfx_2` (pending-review), and `loose_music_2` as copied but not placed. It also notes that sc1_sh3's clip is 1 s short of its shot.

## 4. Things worth a second look

- **Audio under a short clip.** The film-wide music clip is longer than the shot it is attached under. In Resolve it should simply extend along the timeline. If Resolve instead trims it to the first clip's length (6 s), report it: it means the audio must be anchored differently.
- **Other frame rates.** Repeat steps 1 and 2 with `__fixtures__/make.ts <new folder> 25` and a 25 fps timeline (a 6 s shot is 150 frames), then with `23.976`. At 23.976 akuko counts frames in the nominal 24-frame second, so a 6 s shot is 144 frames that last 0.1% longer in real time than the 6.000 s clip file: check the **last frame of sc1_sh2 and sc1_sh4** (their clips are exactly as long as the shot). If the last frame is a hair short or missing, report it with the frame count Resolve shows.
- **EDL fallback** (only if the FCPXML did not import, or you want to know it works): follow the README's EDL section. Say whether clips conformed with the reel names (V001, A001, MUS01, SFX01) and the "Source clip filename" setting, or came in offline.

## Checking a real project instead

`node --experimental-strip-types handoff/cli.ts export --project <your project folder> --fps 24`, then use the same checks with your own shot list (the README in the export folder has the table of every shot's start and length). Without ffmpeg this is the way to run the check.

## What counts as a fail, and what to send back

Any "Fail" cell above. Send: the Resolve version and edition, the exact error text if any, a screenshot of the timeline with the clip names showing, and which check failed. Do not fix it by hand in Resolve first: the point is whether the file is right.

## Result

| Date | Resolve version | Edition | FCPXML import | Checks 1-8 | Notes |
|---|---|---|---|---|---|
| | | | | | |
