# @ikenga/pkg-meetings

## 0.2.1

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with `pin_on_install: true` (manifest v5).

## 0.2.0

### Minor Changes

- [#93](https://github.com/ikenga-hq/ikenga-pkgs/pull/93) [`dedbd27`](https://github.com/ikenga-hq/ikenga-pkgs/commit/dedbd27f8041581e4e29966e2c0783282a05628f) Thanks [@nedjamez](https://github.com/nedjamez)! - First public release of `com.ikenga.meetings` — a local-first meeting recorder and notetaker.

  - Records both sides of a call from your own machine: the system output monitor (everyone else) and the microphone (you), mixed and also kept as separate channels. It joins nothing — no bot, no calendar account, no meeting invite.
  - Channel-split speaker attribution (WP-21). Turns are labelled **You** and **Them** from the audio channel rather than a speaker model, which is honest about its limit: a group call reads as "me vs everyone else", not names.
  - Pluggable transcription with a first-run backend picker (WP-19): local whisper.cpp by default (audio never leaves the machine), OpenAI, or a shell engine when one accepts audio.
  - Whisper acquisition without a compiler (WP-20) — a pinned, SHA-256-checksummed upstream build plus a model size you choose, fetched on first use.
  - Real summaries as a separate, explicit per-meeting action (WP-22), never automatic, because it sends the whole transcript to OpenAI. The consent gate names the provider before you record.
  - Calendar nudge from a private `.ics` feed (WP-15), surfaced in-pane and through `host.notify` so it reaches you while you are actually in the call. It offers a one-click record with the title filled in; it never starts recording on its own.

  Requires Linux with PulseAudio or PipeWire, `ffmpeg`/`ffprobe` on `PATH`, and Node 20+. Needs shell **v0.9.1 or later** — the pkg's backend database access is scoped by the shell (WP-23, `G-SANDBOX`), and its npm dependencies only materialize correctly from v0.9.1 (ikenga#169).

  Known limits, stated plainly: two-way attribution only, no partial or streaming transcript, the OpenAI key is stored unencrypted at `~/.ikenga/media/.meetings-stt/config.json` (mode 0600) because no pkg can reach the shell's vault yet, and Linux only.

  **Recording other people is regulated.** Several jurisdictions require every participant's consent, and this app cannot announce itself because it is not in the call — telling people is on you.
