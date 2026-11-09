---
"@ikenga/skill-akuko": minor
---

Add the sound stage to akuko: voice-over with real word timings, plus music and sound-effect ingest. `/akuko sound` makes one voice-over per shot that has narration (a script line is only used when the person confirms it), through the spend gate with an ElevenLabs text-to-speech provider (priced per character, timings from the provider, hosts B and C) or the free manual path. Approved takes are placed on the film's timeline as `audio.narration` with composition-absolute word timings, and WebVTT and SRT captions are written from those timings. Music and SFX are person-supplied files recorded with the licence the person states; akuko generates none. Sound opens once key frames are approved, without waiting for motion.
