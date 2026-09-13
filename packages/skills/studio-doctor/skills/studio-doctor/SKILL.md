---
name: studio-doctor
description: Preflight the Studio toolchain — checks ffmpeg, a Chromium for HyperFrames, and bun (required), plus python3 + librosa (optional, music-video only). Warns rather than fails when an optional dependency is missing.
---

# studio-doctor

Toolchain preflight for `com.ikenga.studio`. Run it before `studio-init` / `studio-oneshot`.

## What it checks

| Dependency | Required? | Used by |
|------------|-----------|---------|
| `ffmpeg` | **required** | exporter (stitch/encode) |
| Chromium / Chrome | **required** | HyperFrames renderer (Puppeteer) |
| `bun` | **required** | sidecar / CLI runtime |
| `chrome-headless-shell` | **required on Windows**, reported elsewhere | HyperFrames CLI (drives the headless shell, not full Chrome, on win32) |
| `python3` | optional | `studio-beat-detect` |
| `librosa` (python import) | optional | `studio-beat-detect` (beat/onset detection) |

`python3` and `librosa` are **warn-not-fail**: only the music-video archetype needs beat detection. A box without them can still build the other six archetypes, so `studio-doctor` reports them as warnings and **exits 0**.

## Running

The skill invokes the bundled check script:

```
bash skills/studio-doctor/check.sh
```

It prints a table of `ok` / `MISSING` per dependency and a one-line summary. Exit code is `0` unless a **required** dependency is missing (then `1`). Missing optional deps never fail the check.

## Interpreting output

- All `ok` → you're clear to build anything, including music videos.
- `python3`/`librosa` `MISSING (optional)` → everything works except `studio-beat-detect`; install with `pip install librosa` when you need music-video beat-snapping. The check probes `python3`, `python` and `py` in turn and imports `librosa` with the interpreter it actually found (on Windows `python3` is often the Store alias stub).
- `chrome-headless-shell` `MISSING (required)` on Windows → `npx puppeteer browsers install chrome-headless-shell`. Chromium itself is found via `PUPPETEER_EXECUTABLE_PATH`, a system browser, or the Puppeteer cache (`~/.cache/puppeteer`, or `PUPPETEER_CACHE_DIR`).
