---
"@ikenga/skill-akuko": minor
---

akuko v0.x public release. The package is no longer private, and `build:mirror` emits the standalone `ikenga-hq/akuko` tree (`npx skills add ikenga-hq/akuko`) with the skill's runtime dependencies: a `package.json` in the skill folder pinning zod (and jsdom / ajv as optional, for `check-view`) and a vendored build of `@ikenga/studio-schema`, so `npm install` in the installed skill makes every action runnable. `build:claudeai` emits `dist-claudeai/akuko.zip` for a claude.ai upload: runtime files only, and the build fails above claude.ai's 200-file limit. Both builds run the test suite first and refuse to build if it fails. `doctor` now prints `npm install` for the skill folder when the skill ships a `package.json`. New public README and PUBLISHING.md.
