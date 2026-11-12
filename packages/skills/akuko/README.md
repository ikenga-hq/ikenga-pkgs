# akuko

An agent skill that takes a short story, treatment or film script to a short film, one reviewed stage at a time:

`intake → breakdown → sketch board → bibles → key frames → motion → sound → assemble → export`

You work with it in chat. Each stage produces something you look at on a review board (an HTML page), and nothing moves on until you approve it. Paid generation (images, video, voice, lip-sync) runs only with your provider keys, under a budget cap you set, and only after you approve that job's estimate.

This is a **v0.x** release: the format and the actions can still change between minor versions.

## What it does today

| Stage | Action | What exists |
|---|---|---|
| Intake | `intake` | Brings in a story, treatment or screenplay and produces a [Fountain](https://fountain.io) screenplay. |
| Breakdown | `breakdown` | Scenes, beats and shots sized to clip limits. Can import an existing shot list (a spreadsheet). |
| Sketch | `board` | Framing panels and 9-panel beat boards (free, no provider). |
| Bibles | `bible` | Character sheets, location plates and a style lookbook. |
| Key frames | `keyframes` | Final panels from the sketch board and bible references, with a continuity check. |
| Motion | `motion` | Image-to-video clips from approved key frames, one shot at a time. Per-shot treatments (`still`, `still-move`, `video`, `lipsync`) keep paid clips opt-in; camera moves on stills are free. You can pilot one part of the film before the rest. |
| Lip-sync | `lipsync` | Makes a speaker say a shot's line on its approved key frame or clip. |
| Sound | `sound` | Voice-over with real word timings (or none), captions, and music / SFX that you supply. akuko never writes narration text or picks a voice for you. |
| Assemble | `assemble` | **`assemble preview`** makes a free animatic preview: the approved key frames in film order, each held for its shot's length, with a gentle move only where the shot's camera note asks for one, as one silent MP4 (needs ffmpeg). It is never a review unit and is not saved to the project. The rough cut and picture lock are **not built**; the action says so and stops. |
| Export | `export` | Hands what is approved to **DaVinci Resolve**: media in shot order plus an FCPXML 1.8 (or EDL) timeline. It does not render an MP4. |

Across every stage:

- `status` reports where the project stands, whose move it is, and a **whole-film cost estimate**.
- `review` folds your decisions from the board back into the project and revises what you sent back.
- `view` designs a read-only page for a question ("who is in scene 3", "what has this cost"), or a decision page that must pass the bundled conformance check (`scripts/check-view.mjs`) before its approvals count.
- `setup` and `doctor` configure and check keys, budget and tools.
- **House rules**: a project can carry rules (for example "no real brand names in prompts"); every paid job is checked against them before the spend gate, and a breach is refused, never reworded to get past it.
- **Sign-off gates**: milestones (a look, a pilot) that only a named sign-off person can pass. akuko records a sign-off on that person's word; the agent never signs.

Not built: the in-house FFmpeg cut, MP4 masters and cutdowns, and decks. HTML title / graphics scenes are not part of `motion` yet.

## The two rules

1. **Only a person approves.** Actions move work to "pending review". Only a person's decision on a review surface moves it to approved. No action or view auto-approves, pre-ticks or batch-approves, and no stage advances past its review.
2. **Nothing paid runs without an estimate, a cap and an OK.** With no budget cap set, paid jobs are refused. Each paid job shows its estimate, the cap, what is spent and what would be left, and waits for an explicit yes. Every paid call, successful or not, is written to the project's ledger. The `manual` provider is free on every stage: it writes prompt packages you can run anywhere.

## Hosts

akuko detects where it is running at the start of every action (`hosts/detect.ts`):

| Host | Where the project lives | Notes |
|---|---|---|
| **claude.ai** (Claude artifacts) | In the review board artifact's database; claude.ai's workspace lasts one chat, so no project folder is kept there | Generation through connected MCP servers and the manual provider. Export and HyperFrames renders are routed to Claude Code. |
| **Claude Code** | `akuko.json` plus files in a project folder on disk | All providers, through keys in your environment. |
| **Ikenga** desktop app | As Claude Code | Adds the Ikenga bridge, and the Studio app when its MCP server is connected. |

## Providers and keys

| Provider | Used for | Key (environment variable) |
|---|---|---|
| `manual` | every paid stage, free: prompt packages you run yourself | none |
| Google Gemini image | bible and key frames | `GEMINI_API_KEY` |
| fal.ai | images, image-to-video clips, lip-sync | `FAL_KEY` |
| ElevenLabs | voice-over with character timings | `ELEVENLABS_API_KEY` |

Keys are yours. They stay in your environment (or your host's secret store) and are never written to `akuko.json`, a view or a transcript. Model ids and prices live in `skills/akuko/providers/config.json`; check them against the provider's own pricing before you set a budget.

## Install

### Claude Code: `npx skills`

```bash
npx skills add ikenga-hq/akuko -g      # global
npx skills add ikenga-hq/akuko         # this project only
```

Then install the skill's runtime packages once, in the installed skill folder (for a global install, `~/.claude/skills/akuko`):

```bash
cd ~/.claude/skills/akuko && npm install
```

### Claude Code: install script

```bash
curl -sSL https://raw.githubusercontent.com/ikenga-hq/akuko/main/install.sh | bash
```

Clones into `~/.cache/ikenga-skills/akuko`, symlinks `~/.claude/skills/akuko` to it, and runs `npm install` in the skill folder. Re-run it to update.

### claude.ai

Upload `akuko.zip` from the release (a runtime-only build, under claude.ai's 200-file limit) in Settings → Capabilities → Skills.

### Requirements

- Node.js 22.6 or newer (the actions are TypeScript run with `--experimental-strip-types`).
- `npm install` in the skill folder: it installs `zod` (pinned) and a vendored copy of `@ikenga/studio-schema`, plus `jsdom` / `ajv` as optional packages for the view conformance check.
- Optional, from the stage that renders: FFmpeg, HyperFrames and Chrome / Chromium. On Windows, set `HYPERFRAMES_BROWSER_PATH` to your Chrome executable.

Check the setup:

```bash
bash ~/.claude/skills/akuko/scripts/doctor.sh [project-folder]
```

## Usage

In a Claude Code session:

```
/akuko setup                  set a budget cap, say which keys you have
/akuko intake story.md        start a project from a story or script
/akuko status                 where are we, what's next, what will it cost
```

then `breakdown`, `board`, `bible`, `keyframes`, `motion`, `lipsync`, `sound`, `export` as each stage is approved. The agent-facing spec is [`skills/akuko/SKILL.md`](skills/akuko/SKILL.md); each action is a file in `skills/akuko/actions/`. The project format is `skills/akuko/schema/akuko-project.ts` (JSON Schema: `skills/akuko/schema/akuko-project.schema.json`).

## Source

The source is [`ikenga-hq/ikenga-pkgs`](https://github.com/ikenga-hq/ikenga-pkgs) at `packages/skills/akuko/`. `ikenga-hq/akuko` is a generated mirror of it; see [PUBLISHING.md](https://github.com/ikenga-hq/ikenga-pkgs/blob/main/packages/skills/akuko/PUBLISHING.md) for how it is built.

## License

[Apache-2.0](LICENSE).
