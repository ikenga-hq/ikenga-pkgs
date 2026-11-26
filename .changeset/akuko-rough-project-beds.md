---
"@ikenga/skill-akuko": minor
---

`assemble rough` now lays the project's own approved music and sound-effect assets without flags, where each records its placement (a shot, a scene's shots, or the whole film), music ducked under the voice and effects at -24 LUFS. `--music` replaces the project's music for that render, `--sfx` adds effects, and the new `--no-project-beds` lays none of them. Assets not approved, or with a missing file or no place in the cut, are listed in the plan as "not laid" and never used. On a master-clock project they stay covered by the master, as in the export. Nothing is written to akuko.json.
