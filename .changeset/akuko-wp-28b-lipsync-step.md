---
"@ikenga/skill-akuko": minor
---

akuko: a lip-sync step (`lipsync/cli.ts`, action `lipsync`). A shot whose treatment is `lipsync`, or `video` with a spoken line, gets a `<shot>_lipsync` unit: its approved key frame, made to say its line by fal's lip-sync models, one shot per job, through the project rules and the spend gate, with a 3-attempt cap per shot and review on the board. The line audio is the line's own clip when it can be read, else a 16-bit slice of the master WAV cut by the line's film times; the master is streamed once (never loaded whole), a 24-bit file is converted, and each cut is recorded as an `akuko-cut` slice so the rules guard checks it before upload. The spend line names the files that would go to fal; a folder outside the project is read only when you name it with `--allow-root` for that run. New `record-master-hash` command, and a streaming WAV slicer in `sound/wav.ts`.
