---
"@ikenga/skill-akuko": minor
---

akuko can now turn approved key frames into video clips (the `motion` stage, clips only). Each shot gets one clip, made from its approved key frame, one shot at a time through the spend gate: the spend line shows the per-second arithmetic and an approval binds to that amount. Each shot is limited to 3 paid attempts (the person can raise it); sound is off unless asked for. Adds the `fal-video` provider (Kling image-to-video on fal, with prices and sources in `providers/config.json`) and a no-key manual path.
