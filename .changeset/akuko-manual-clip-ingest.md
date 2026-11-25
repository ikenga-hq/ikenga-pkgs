---
"@ikenga/skill-akuko": patch
---

akuko: safer manual ingest, and clip checks at ingest.

- A planned asset that a person sent back (`needs-rework`) and still holds its old file now takes a manually ingested file in place (a new file name, the old file kept, a "Revised: …" comment), in every stage. Before, it got a separate `<unit>-<stage>` asset that waited for review and held the stage open while the unit kept its old file. A file for an asset that was not sent back is still refused, and the message now says to send it back and ingest again.
- Motion `ingest` reads the clip's length from its header and compares it with the shot: a shorter clip, or one more than 0.5 s longer, gets an agent comment and a line in the output ("Clip runs 3 s; the shot is 3.5 s: …"). It never refuses.
- Motion `ingest` keeps a clip's sound: the clip is stored unchanged, and with ffmpeg its sound is also copied to `sound-incoming/clip-audio/<shot>_clip-audio.wav` (not an asset). `--no-keep-audio` skips the copy. The continuity chain no longer says to strip a clip's sound after download.
