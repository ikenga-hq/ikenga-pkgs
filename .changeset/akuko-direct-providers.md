---
"@ikenga/skill-akuko": minor
---

akuko: direct provider APIs, and paid direct calls on claude.ai with a key pasted per chat.

- New direct providers, priced from each provider's own docs (read 2026-11-12, cited in `providers/config.json`) and tested against mocked HTTP only:
  - `gemini-video`: Google's Gemini Omni Flash image-to-video on the Gemini API (`GEMINI_API_KEY`). Veo is no longer on the Gemini API (its last ids were shut down on 2026-10-22).
  - `kling-video`: Kling's own API, image-to-video, with an HS256 JWT from `KLING_ACCESS_KEY` + `KLING_SECRET_KEY`.
  - `byteplus-video` (Seedance) and `byteplus-image` (Seedream) on BytePlus ModelArk (`ARK_API_KEY`).
  - OpenAI Sora is not added: OpenAI shut the Sora 2 models and the Videos API down on 2026-09-24.
- Models with no published per-unit price go under `unverified_models` and are never runnable ("price unverified").
- Motion, setup and the whole-film estimate (`--video-provider`) price the new video models with each model's clip lengths (`providers/video-limits.ts`).
- R-11 rewritten: on claude.ai a paid direct API may run with a key the person pastes into that chat after a plain disclosure and an explicit "use my key for this chat". The spend gate applies in full; on host A it requires `--key-source pasted-this-chat` and runs in phases (`--phase reserve`, save to the board, `--phase send`, save the result; `--phase release` cancels an unsent reservation). Ledger entries gain an optional `reserved` flag.
- `scripts/probe.ts` (and `doctor --probe`): a keyless, no-cost reachability check of each provider's API host that names the domains to allow in claude.ai's network settings.
- `hosts/workcopy.ts`: maps a host-A working copy's file uris to downloaded files and back to artifact asset urls.
- setup and doctor report every key by name only (Kling needs both variables), and doctor lists price-unverified models.
