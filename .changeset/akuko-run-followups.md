---
"@ikenga/skill-akuko": minor
---

Fixes from the live claude.ai run of 2026-11-11/12.

- **An approved script is never changed by tagging.** `breakdown tag` writes the `[[sc<N>_sh<M>]]` notes into a derived copy (`script/screenplay.tagged.fountain`, or `script/source.tagged.md` on the direct route), recorded as the new optional `script.tagged`. The approved intake asset keeps its file and its approval, and the copy is not a review unit. The same rule applies on claude.ai.
- **Connected-tool allowance is gated like money.** A connector that uses the person's plan allowance instead of money (Canva's monthly AI limit) now needs an explicit OK for every wave. The confirmation line gives the count and the service, and says akuko can't see what is left. Every generation is recorded in the ledger with zero money and an `allowance: { service, units }` count, and those entries need no money budget. `budget.allowance_caps` can cap generations per service. Both fields are new and optional, so older projects stay valid. The new code is in `spend/allowance.ts`, and the rule is §Allowance in `lib/spend.md`. The bible, key frames, motion, lip-sync and sound actions now follow it.
- **`assemble preview`.** A free animatic preview: the approved key frames in film order, each held for its shot's length, with a gentle move only where the shot asks for one, written as one silent MP4 with ffmpeg. It is never a review unit, writes nothing to `akuko.json` and moves no stage. The rough cut and picture lock are still not built.
- **Seedance on fal.** The `fal-video` provider now prices and runs Seedance 2.0 (720p, 1080p), Seedance 2.0 Fast (720p) and Seedance 2.5 (480p, 720p, 1080p) image-to-video. Pricing is per billed second, using fal's prices read on 2026-11-12. Clips can be any whole second from 4 s, up to 15 s on 2.0 and 30 s on 2.5. Sound is off unless asked for, and costs the same either way.
- **Reopening an earlier stage locks the stages after it.** When an undo or send-back takes an approved stage out of `approved`, every later stage that had opened goes back to `locked`. A reopened motion stage leaves sound open, because sound waits only on key frames. Units and files are kept, and the later stage reopens from them once the earlier stage is approved again.
- **Beat boards are also written as SVG.** The claude.ai artifact asset store refuses HTML, so host A stores the SVG instead.
- **Default board `default-board@0.6`.** A note on a shot is labelled "Note on the shot" instead of the shot's stage ("Sketch board"). Decisions from boards `@0.1` to `@0.5` still fold.
