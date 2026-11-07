---
"@ikenga/skill-akuko": minor
---

akuko intake + breakdown: bring in a story, treatment or screenplay (for prose, the skill asks each time whether to adapt it to a Fountain screenplay or break it down directly), then break it into scenes, beats and shots no longer than 10 seconds with at most two principal characters in frame, plus a character / location / style checklist. Shot ids (`sc<N>_sh<M>`) are allocated by code and written back into the script as `[[sc<N>_sh<M>]]` notes; lint explains any shot that breaks the limits; re-running a breakdown on a project that already has shots creates nothing and only adds missing tags. Includes a small command line (`breakdown/cli.ts`) for hosts B and C.
