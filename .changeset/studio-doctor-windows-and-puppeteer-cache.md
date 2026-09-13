---
"@ikenga/studio-doctor": patch
---

check.sh finds Chromium the way the Studio sidecar does (explicit path, system browser, or the Puppeteer cache incl. `PUPPETEER_CACHE_DIR`), requires `chrome-headless-shell` on Windows (HyperFrames drives the headless shell there) with an install hint, and probes `python3`/`python`/`py` for a real 3.x interpreter before importing `librosa` — on Windows `python3` is frequently the Store alias stub, which made librosa report MISSING while installed.
