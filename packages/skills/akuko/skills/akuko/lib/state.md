# akuko — project state

Every action reads this before it writes. The format itself is `../schema/akuko-project.ts` (`akuko.json`, one document per project); cross-references are checked by `../schema/integrity.ts`. This file says how actions **use** that state.

> **Sections are owned.** WP-02 pre-created every section so wave-2 packages fill only their own (R-13). Each section names its owner. Don't edit a section you don't own; add a short note under **Open questions** instead.

---

## Reading and writing the project

*Owner: WP-02.*

- Read and write only through the host adapter (`../hosts/`, `lib/hosts.md`): `readState()` validates against `AkukoProjectSchema`; `writeState()` validates again and refuses an invalid project. On B and C the write is atomic (temp file + rename).
- **Views never write the project.** They write decisions; actions fold them (§Decision folding).
- **Bytes never go in `akuko.json`.** `storeAsset()` stores the file and returns an `Asset` with `file.uri`; the action appends it to `assets[]` and calls `writeState()`.
- Record the host on every run: `host = toHostRecord(level, capabilities)` (`../hosts/detect.ts`).
- Set `project.updated_at` and each touched unit's `updated_at` when writing.
- Read–modify–write in one step: read, change, write. Don't hold a project across a pause for review — re-read after the person comes back.

Project folder (B and C; on A the same paths are asset names):

```
<project>/
  akuko.json                 project, stages, units, ledger, budget
  decisions.jsonl            decisions from local / Ikenga views (WP-07a)
  script/   source.md · screenplay.fountain
  bible/    characters/<id>/refs/*  locations/<id>/refs/*  style/
  board/    panels/<shot>-<stage>.{svg,png} · beatboards/*.html
  motion/   <shot>/*.mp4 · scenes/<shot>/index.html
  audio/    vo/*.wav · words.json · music/ · sfx/
  cut/      timeline.json · exports/*.mp4
  views/    published local views (default board, freehand views)
```

## Stages

*Owner: WP-02 (the gating rule). Each stage's own entry is filled by the WP that owns its action — see the table.*

Nine stages, `STAGES` in the schema. `stages.<id>.state` is one of `locked · not-started · in-progress · waiting-spend · in-review · approved`.

Gating rule: a stage is `locked` until every earlier stage is `approved`. An action refuses to run on a locked stage and says which earlier stage is waiting. `current_stage` is the earliest stage that is not `approved`.

| # | Stage | Action | Entry filled by |
|---|---|---|---|
| 0 | intake | `intake` | WP-04 |
| 1 | breakdown | `breakdown` | WP-04 |
| 2 | sketch | `board` | WP-21 |
| 3 | bible | `bible` | WP-05 |
| 4 | keyframes | `keyframes` | WP-22 |
| 5 | motion | `motion` | WP-10 · WP-11 |
| 6 | sound | `sound` | WP-12 |
| 7 | assemble | `assemble` | WP-13 (stub) |
| 8 | export | `export` | WP-23 (Resolve handoff) |

### 0 intake
*Action: `actions/intake.md`; code `../breakdown/intake.ts`. Free.*

- Produces `script/source.md` (the story as given) and, unless the person chose "break it down directly", `script/screenplay.fountain`. Both are recorded as assets (`script-source`, `script-screenplay`; stage `intake`, kind `other`) at `pending-review`, and `script.source` / `script.screenplay` point at them.
- Stage state: `in-progress` while working, `in-review` once the files are recorded. Intake is `approved` when a person approves every intake asset (assets are units like any other, so decision folding handles them; folding then unlocks breakdown).
- For prose the person chooses **each time**: adapt to a screenplay first (`adapt`), or break the prose down directly (`direct`). The choice is not stored; `script.screenplay` is absent on the direct route.
- Recording is idempotent: re-running `completeIntake()` with the same files adds no second asset.
- Never re-adapts: once `shots[]` is not empty, the action stops and does not replace the source (a rule of `actions/intake.md`, not enforced in code).

### 1 breakdown
*Action: `actions/breakdown.md`; film rules `../profiles/film/breakdown.md`; code `../breakdown/`. Free.*

- Opens when intake is `approved`.
- Produces `scenes[]` (`sc<N>`), `script.beats[]` (`sc<N>_b<K>`), `shots[]` (`sc<N>_sh<M>`, at most 10 s and 2 principals) and a bible checklist (`bible.characters|locations|styles[]`, ids `char_*` / `loc_*` / `style_*`). All are stage `breakdown`, status `pending-review`; the stage is `in-review`.
- Writes `[[sc<N>_sh<M>]]` notes into `script/screenplay.fountain` (or `script/source.md` on the direct route).
- Ids are allocated by code, never by the agent; numbers are never reused; a shot inserted later takes a letter (`sc3_sh2A`).
- Idempotent: if `scenes[]` or `shots[]` is not empty, nothing is created and only missing tags are added. Lint errors (over 10 s, over 2 principals, no duration, no action, no scene) stop the write; a shot under 5 s or a non-canonical id is only a warning.
- Hand-off: the checklist entries are units of stage `breakdown`, so the breakdown is `approved` only when every shot **and** every checklist entry is approved. The bible stage then starts from the approved entries; the sketch board reads `shots[]`.

### 2 sketch
*Action: `actions/board.md`; code `../board/`. Free.*

- Opens when breakdown is `approved`. Produces one framing-diagram panel per shot (plain SVG drawn from the shot's `blocking`, `shot_type`, `camera`, `camera_move`, `duration_s`; thirds grid, labelled boxes, move arrow; no figures or faces) and 9-panel beat boards (`board/beatboards/beatboard-<scene>[-<n>].html`).
- **The review unit is the shot at stage `sketch`**, not a panel asset. Each drawn shot becomes `stage: sketch`, `status: pending-review`, with `by_stage.sketch.output` pointing at the stored file (`board/panels/<shot>-sketch.svg`, via `storeAsset`, kind `panel`; the SVG is not a PNG). The panel is **not** added to `assets[]`: a second unit per panel would need its own approval, and the stage could never reach `approved` from the shot decisions the boards write. The stage is `in-review`; it is `approved` when a person approves every shot. Decisions fold unchanged.
- Deterministic and free: the same shot gives the same bytes; no provider, no spend gate, no network. All text from the script is escaped.
- Blocking is never invented. A shot with none still gets a panel (grid, camera note, "NO BLOCKING") and lint warns. Blocking enters the project only through `applyBlocking` (a proposal the agent writes from what the script says; rect `x`/`y` = top-left, ellipse `x`/`y` = centre, all 0-1 of the frame). It is refused for a panel under review or approved: a person sends it back first.
- Idempotent: a second run draws and stores nothing. A shot sent back (`needs-rework`) is redrawn only if its panel would differ (new blocking or camera); it then returns to `pending-review` with a "Revised: ..." comment. If nothing changed it stays sent back and the run says so.
- Beat boards group by scene (a scene with more than nine shots spills to a second board), are derived and regenerated each run, and show no review status.

### 3 bible
*Action: `actions/bible.md`; film templates `../profiles/film/templates/{character,location,style}.md`; code `../bible/`. Paid, or free through the manual provider.*

- **Opens** when every earlier stage is approved (the gating rule: intake, breakdown **and** sketch) and every checklist entry is approved. `plan` refuses otherwise and names the stage that is waiting.
- **Tracked on assets, not on the entries.** The checklist entries (`char_*`, `loc_*`, `style_*`) stay `approved` at stage `breakdown`; nothing here moves one backwards or re-opens it. The stage's units are **assets**, one planned per image, at stage `bible`, status `pending`, owner = the entry, no file yet: `<entry>_portrait` and `<entry>_turnaround` (Principal; a Supporting character gets a portrait only; Background gets none), `<entry>_plate` (each location), `<entry>_lookbook` (each style). The provider fills them **in place** (manual `ingest()` or the gate's `collect()`): the asset becomes `pending-review` with its file, and `stages.bible` is `approved` once a person has approved every one (decision folding, as for any stage).
- **Order**, enforced in code (`buildBibleJob`): lookbook first; then portraits and plates, each with the **approved** lookbook attached; then turnarounds, each with the **approved** portrait (first) and the lookbook. A unit whose references are not approved is refused, not generated. At most 14 references per unit (the image providers' limit); per-role sublimits are not enforced yet.
- **Every image goes through `gate.run()`.** One job per wave, id `job_bible_w<wave>_<hash of units + provider + model>_r<n>`, so a different provider or model is a new job with its own approval. Paid: the gate writes the `pending_spend` entry, the person approves the amount (`approve-spend`), then it runs and `collect()` records the files. Manual: free; the prompt package goes out and files come back through `ingest()`. `stages.bible` is `waiting-spend` while an approval is awaited, `in-progress` while images are being made, `in-review` once everything made is waiting for a person.
- **A frame that cannot be built is skipped, not fatal.** If the next ready frame cannot be built (for example more than 14 references), `step` reports its unit id and why and moves on to the next ready frame; a `--scene` batch builds the frames it can and reports the rest. If none can be built it says why for each. A frame a person names with `--units` that cannot be built is an error.
- **Status moves** (the only ones this stage makes): `pending → draft` when a job is cleared to run. A unit a person sent back (`needs-rework`) becomes `draft` with its old file cleared (the old file stays stored and the "Revised: …" comment names it), the person's words are added to the prompt, and the new take fills the same asset; a regeneration is a new job id (`…_r<n+1>`) with its own approval. `pending-review` is set by the gate or the manual provider on output. If the gate does not accept the run (refused, awaiting approval, failed), the units are put back exactly as they were, old file included. **Nothing here writes `approved`.**
- **One code-side repair.** A bible image that is `approved` or `pending-review` must have a file. If one has none (an `undo` restored its status after a revision had cleared the file), `finalizeBible()` sets it back to `pending` with the comment "Revised: restored without an image; needs generating", and `stages.bible` leaves `approved`. This is the only time code lowers an `approved` unit, and it is allowed only because the unit has no image: nothing a person approved still exists. Readiness never reports `approved` without a file, so dependents are not blocked behind a ghost approval.
- **Superseded references are flagged, never rewritten.** Each generated image carries `from:<ref id>@<fingerprint>` tags naming the reference files it was made from. `bible status` (and the action) flag an image whose portrait or lookbook has since been sent back, un-approved or replaced: "generated against a superseded …, consider sending it back". Code never changes the dependent; only a person sends it back.
- **Known gap (fold-level, WP-07a area, not fixed here):** an `undo` that spans a regeneration restores the old approval onto the new take.
- **Produces** `bible.characters|locations|styles[].refs[]`: after folding, `syncRefs()` sets each entry's `refs` to its **approved** images (lookbook, portrait, turnaround, plate order), keeps any ref that is not a bible image, and drops one a person un-approves. Later stages reuse `refs`, and still check the asset is `approved`.
- Idempotent: `plan` adds only missing assets; asking for a job twice before its files are back gives the same job id and one pending entry.

### 4 keyframes
*Action: `actions/keyframes.md`; code `../keyframes/`. Paid, or free through the manual provider.*

- **Opens** when every earlier stage is approved (the gating rule: intake, breakdown, sketch **and** bible) and every shot is approved. `plan` refuses otherwise and names the stage that is waiting.
- **The review unit is one planned asset per shot**, not the shot: `<shot>_keyframe`, kind `keyframe`, stage `keyframes`, owner = the shot, status `pending`, no file yet. Why: providers and the manual `ingest()` record a finished image as an asset unit moving to `pending-review`; making the shot the unit too would be two approvals for one frame, and would pull the shot off stage `sketch`, where its approval lives. With the asset as the unit the shot is never touched, the provider fills the asset **in place**, and folding approves `stages.keyframes` when a person has approved every key frame. Contrast §2 (the sketch panel is a free by-product, so the shot is its unit) and §3 (assets, as here).
- **References.** Each key frame is made from the **approved** bible images of the entries the shot names in `refs[]`: every character's turnaround (the portrait if the character has none), the location's plate, and the lookbook (a shot naming no style gets every style's lookbook). They are read from the entries' `refs[]` (what `syncRefs()` set), and each asset is still checked to be `approved` with a file; one that is not (or is not yet in `refs[]`) makes the key frame `blocked`, listing it, and `step` refuses it. At most 14 references per frame (the providers' limit); per-role sublimits (for example 4 character references on a Gemini Flash model) are **not** enforced. Pictures the person supplied for the shot (`reference` assets owned by it) are added.
- **The sketch panel is not attached.** It is an SVG and neither image provider accepts SVG (`providers/gemini-image/image-common.ts` lists png, jpeg, webp, gif), and akuko adds no rasteriser. The composition travels as text instead: shot type, camera, move, action, the scene heading and the shot's `blocking` boxes as thirds and size ("Mara: left third, lower third, medium"). Blocking is never invented; with none the prompt says so.
- **Every image goes through `gate.run()`.** The default job is **one shot** (the next one ready), id `job_kf_<hash>_r<n>`, so each `approve-spend` binds to the amount shown for that one frame (`approve <amount> <CUR>`). The hash covers the **units, the provider and the model**: asking again with another model (even a cheaper one) is a new job and needs a fresh approval, and the gate refuses another provider under an approved id. `--scene <id>` or `--units a,b` makes one job for several frames and one approval for the total. Paid: the gate writes the `pending_spend` entry, a person approves, then it runs and `collect()` records the file. Manual: free; the prompt package goes out and the file comes back through `ingest()`. `stages.keyframes` is `waiting-spend` while an approval is awaited, `in-progress` while frames are being made, `in-review` once everything made waits for a person.
- **Status moves** (the only ones this stage makes): `pending → draft` when a job is cleared to run; a frame a person sent back (`needs-rework`) becomes `draft` with its old file cleared (it stays stored; the "Revised: …" comment names it), the person's words go into the prompt, the new take fills the same asset, and a regeneration is a new job id (`…_r<n+1>`) with its own approval. `pending-review` is set by the gate or the manual provider on output. If the gate does not accept the run, the units are put back exactly as they were. **Nothing here writes `approved`.**
- **One code-side repair** (as in §3). A key frame that is `approved` or `pending-review` must have a file. If one has none (an `undo` restored its status after a revision cleared the file), `finalizeKeyframes()` sets it back to `pending` with "Revised: restored without an image; needs generating", and the stage leaves `approved`. Allowed only because no image exists; readiness never reports `approved` without a file.
- **Superseded references are flagged, never rewritten.** Each take carries `from:<bible asset id>@<fingerprint>` tags (the bible stage's format) for the images it was made from. `status` flags a key frame whose turnaround, plate or lookbook has since been sent back, un-approved or replaced. Code never changes the key frame; only a person sends it back. The at-scale continuity audit is built: see `actions/keyframes.md` §Audit and `../audit/` (below).
- **Produces** a key-frame asset (`<shot>_keyframe`, `file`, `by_stage.keyframes.output`) owned by each shot. Motion (stage 5) reads the approved asset.
- Idempotent: `plan` adds only missing assets; asking for a job twice before its file is back gives the same job id and one pending entry.
- **Continuity audit (WP-14, advisory).** `audit/` (`auditProject(project) → AuditReport`, pure) checks every made key frame structurally (references used, references still current, characters in the prompt, at most 2 principals, one model per scene, the right lookbook) and takes the agent's own visual notes (`audit record`). It writes `board/audit.json` and `board/audit.md`, and the agent's `Audit: ... (audit <run>)` comments on the frames; re-running swaps only those. **It moves no status**: only a person sends a frame back, into the normal `needs-rework` flow. Motion may call the summary.

### 5 motion
*Action: `actions/motion.md`; code `../motion/`. Paid, or free through the manual provider. WP-10 (clips). HTML scenes are WP-11's: the HyperFrames engine (`../engines/hyperframes/`) and `../blocks/` are built, but this action does not use them yet.*

- **Opens** when every earlier stage, through `keyframes`, is approved. `plan` refuses otherwise and names the stage that is waiting.
- **The review unit is one planned asset per shot**: `<shot>_clip`, kind `clip`, stage `motion`, owner = the shot, status `pending`, no file yet (the same shape as §4). The shot and its key frame are never touched; the provider fills the asset in place; folding approves `stages.motion` when a person has approved every clip.
- **Start frame and prompt.** The start frame is the shot's approved key frame (`JobRef role: 'start-frame'`); a clip whose key frame is not approved with a file is `blocked`. The length is the shot's `duration_s` (a shot with none is refused), made the shortest length the model makes that is at least as long (`cover`, the default: a short clip cannot be stretched in the editor), or the closest one with `--fit nearest`; the spend line shows the seconds billed beyond the shot and a note says so. The prompt is the shot's written action, camera and move; nothing is invented.
- **Every clip goes through `gate.run()`.** Default job is one shot, id `job_mo_<hash>_r<n>`; the hash covers units, provider, model, each clip's seconds and the sound choice, so any of them changing is a new job with a fresh approval. The job label carries the per-second arithmetic the spend line shows. `--scene` / `--units` give one approval for several clips.
- **Retry cap per shot** (in `motion/`, not the spend gate): paid attempts = ledger entries for the clip, from a paid provider, that cost money by the ledger's rules (`done`: actual else estimate; `failed`/`cancelled`: actual else 0), so a call that never reached the provider is not an attempt (manual takes excluded). A batch that partly fails is recorded for the clips that were made; the others settle at 0, stay draft and are remade by a new job with its own approval. Default 3; at the cap `step` refuses with the count and the money spent on that shot. `--max-attempts N` raises it, and an agent passes it only when the person asked in their own words.
- **Sound is off by default.** Where a model can make sound it is a separate model id in config (`...#audio`) with its own price; `--audio` selects it.
- **Stage state**: `waiting-spend` while an approval is awaited, `in-progress` while clips are being made, `in-review` once everything made waits for a person; `approved` only by folding. Status moves, send-back handling and the fileless repair are as in §4. **Nothing here writes `approved`.**
- **Produces** a clip asset (`<shot>_clip`, `file`, `by_stage.motion.output`) owned by each shot.

### 6 sound
*Action: `actions/sound.md`; code `../sound/`; provider `../providers/tts/elevenlabs/`. Paid, or free through the manual provider.*

- **Opens** when every stage **up to and including keyframes** is approved (and every shot is approved). **Motion need not be approved.** This differs from the strict order in §Stages (sound after motion): shot lengths are fixed by key frames, and a voice-over needs only a length to fit, not a clip. `assertOpen` checks exactly this; `plan` moves `stages.sound` from `locked` to `not-started` itself (folding never unlocks it while motion is open). If motion later changes a shot's length, `sync` re-checks every take against its shot. Recorded as drift from the §Stages gating rule (WP-12).
- **The review unit is one planned asset per shot that has narration text**: `<shot>_vo`, kind `vo`, stage `sound`, owner = the shot, status `pending`. Same reasoning as §4: the shot stays approved at `sketch`, the provider or manual `ingest()` fills the asset in place, and folding approves `stages.sound` when every sound unit (voice-over, music, sfx) is approved.
- **Narration text is never invented.** It is `shot.narration` when set. A shot with only a `script_line` is *proposed*, not planned: `plan --script-lines <ids|all>` is the person's explicit confirmation and is recorded as the tag `text:script_line` on that unit plus the agent comment "Narration from script line, confirmed by you in chat". A shot with no text has no unit. `narration` always wins over a script line.
- **Every voice-over goes through `gate.run()`.** Default job is **one shot**, id `job_snd_<hash>_r<n>`; the hash covers the units, the provider, the model, the voice and the exact text, so changing any is a new job with a fresh approval (`…_r<n+1>` for a re-record after a send-back). `JobItem.prompt` is the text exactly, so the per-character price multiplies the real characters (`ElevenLabs`: `<n> characters × <price> USD/character`). The voice travels as a ref `{role: 'voice', id}`; there is no default voice, the person chooses. Paid: hosts B and C only.
- **Word timings are real or absent.** The provider returns per-character times; `sound/words.ts` groups them into words (ms). A take recorded without them carries the tag `no-words`; nothing is estimated. Each take has a words file next to its audio (shot-relative ms, format `akuko-vo-words`); the audio asset points at it with the tag `words:<uri>`. Words files are stored files, not assets (they are not units).
- **`audio.narration`** (`NarrationBlock`) is rebuilt by `sync` from the **approved** takes only: each placed at its shot's start (sum of the `duration_s` of every earlier shot, shot order), words moved to composition-absolute ms, laid on one silent WAV (`audio/vo/narration.wav`), `duration_ms` = film length, `voice_id` when all takes share one, `generated_at` = the build time. It is cleared when no take is approved. It is refused for a shot with no duration. A take whose audio (compared in sample frames) or last word runs past its shot is **skipped** with a named warning (take, shot, lengths) and the rest is still built; it is also reported as soon as it comes back, as the agent comment "Audio runs 8.4 s; the shot is 6 s" on the `<shot>_vo` asset and in the command output. akuko changes neither the shot nor the text. If any approved take is not a 16-bit PCM WAV of one format, no block is written (assemble joins audio then) but captions still are.
- **Captions** (`audio/vo/captions.vtt`, `.srt`) are a pure function of the words (`sound/captions.ts`): max 42 characters and 5 s per cue, a break at a pause of 1 s or more and after a sentence end; cue times equal word times.
- **Music and SFX** are person-supplied (`add-music` / `add-sfx`): `music` / `sfx` assets at `pending-review` in this stage, tags `supplied`, `licence:<their words>` (required), `source:<…>`, `placement:film|scene:<id>|shot:<id>` (a shot placement also sets `owner`). akuko generates none and cannot verify the licence.
- **Status moves** (the only ones this stage makes): `pending → draft` when a job is cleared to run; a take a person sent back (`needs-rework`) becomes `draft` with its old file and words stamp cleared (the "Revised: …" comment names the old file), the new take fills the same asset under a new job id and approval. `pending-review` is set by the gate or the manual provider on output. If the gate does not accept the run, units are put back exactly as they were. One repair as in §3/§4: a sound unit `approved` or `pending-review` with no file goes back to `pending`. **Nothing here writes `approved`.**
- **Text drift is flagged, never rewritten.** A take is stamped `text-hash:<h>` and `voice:<id>`; `status` says "the shot's text changed since this take" when they differ. Only a person sends a take back.
- Known edges: ingesting a second audio file for a unit that already has one files a separate asset (the manual provider's rule; use `words` to add timings later); on host A, where `storeAsset` may register every stored file as an asset, the words, narration and caption files would show up as units (follow-up).

### 7 assemble
*Not built: `actions/assemble.md` is still a stub (WP-13). It tells the person so and stops.*

### 8 export
*Action: `actions/export.md`; code `../handoff/` (WP-23). Free.*

- **A by-product, not a review unit.** The export moves no stage or unit status and writes nothing to `akuko.json`. It does not wait for `assemble` or `sound` to be approved: it exports what is `approved` now and lists the rest. `stages.export` is left as it is; nothing sets it `approved` yet (that belongs to the parked FFmpeg master, plan Round 7).
- Writes `<project>/export/resolve/` (media in shot order, `timeline.fcpxml`, optional EDLs, README, LEFT-OUT, checksums, `export-manifest.json`). A re-run replaces only the files the manifest lists.
- The frame rate is not in the project; it is chosen at export (`--fps`, default 24).

## Status transitions

*Owner: WP-02 (the rules below). WP-07a adds the decision-driven rows in §Decision folding; WP-03 adds the spend-gate rows for `waiting-spend` in `lib/spend.md`.*

Unit status (`UnitStatus`): `pending · draft · pending-review · needs-rework · approved`.

| From | To | Who | When |
|---|---|---|---|
| `pending` | `draft` | action | starts producing the unit |
| `draft` | `pending-review` | action | the unit's output exists (stored via `storeAsset`) |
| `needs-rework` | `draft` → `pending-review` | action | revising after a request for changes; add a "Revised: …" comment |
| `pending-review` | `approved` | **person only** | an `approve` decision, folded |
| `pending-review` | `needs-rework` | **person only** | a `request-changes` decision, folded |
| any | previous value | **person only** | an `undo` decision, folded |

Hard rules:

- **No action writes `approved`.** Only folding a person's `approve` decision does.
- An action never moves a unit backwards except to revise one a person sent back.
- A stage becomes `approved` only when every unit in it is `approved`; it becomes `in-review` when its units wait for a person.

## Decision folding

*Owner: **WP-07a**. Code: `../decisions/fold.ts` (`foldDecisions`). Stores: `../decisions/{artifact-db,jsonl,ikenga}.ts`. View side: `../views/contract.md`.*

Every action starts by folding: `readDecisions(since?)` through the host adapter, then `foldDecisions(project, decisions, {conformed})`, then `writeState()` if `report.changed`. Then tell the person what the report says, including every `rejected` entry and every invalid record. Without code (host A), or from the shell, use `../decisions/cli.ts` (`fold` on B/C, `fold-file` on A; `actions/review.md`).

**What folds into what**

| Decision | Effect (when accepted) |
|---|---|
| `approve` | unit → `approved` (+ the person's comment if it has text) |
| `request-changes` | unit → `needs-rework` + the person's comment |
| `note` | the person's comment; status unchanged |
| `approve-spend` | `pending_spend[].status = 'approved'`, `.decision = <id>`; only if `canApprove(project, job, decision)` passes (budget, cap, **amount shown ≥ the job's bound**: `../views/contract.md` §7) |
| `decline-spend` | `pending_spend[].status = 'declined'`, `.decision = <id>` |
| `undo` | reverses exactly the decision named in `undoes` |

- **Comments.** A person's comment is `{ts: at, stage, author: by, text, decision: id}`.
  - Every status change folding makes also leaves a trail comment, `{author: 'agent', text: 'Status: <was> → <now>', decision: id}`. The trail is how `undo` knows the status the unit had just before that decision, even if an action revised it in between. Don't edit or delete trail comments.
  - Actions add their own "Revised: …" comments without a `decision` id, as before.
- **Stages.** When a stage's last unit is approved, the stage becomes `approved`. The next stage unlocks (`locked → not-started`) and `current_stage` moves on. If an undo un-approves a unit, its stage goes back to `in-review`.
- **Time.** `updated_at` on a unit and the project follow the decisions' `at`, never the clock.

**Properties**

- **Idempotent by decision id.** Pass everything the store holds every time if you like. Ids already in `decisions[]` are skipped, and a re-fold changes nothing.
- **Order-independent.** Decisions apply in one total order: `at` as an instant, then `id`. `decisions[]` is kept in that order. A decision that arrives late is slotted into its place: an older decision never overrides a later one on the same unit or job. The arrival order and the batching do not change the result.
- **`undo`.**
  - Reverses the named decision: its status change (back to the trail's `<was>`, repairing the trail if it was not the latest) and its comment.
  - An undo of an undo re-applies the original.
  - An undo must be later than its target and on the same unit.
  - An undo whose target hasn't arrived is not stored. It is reported as `unknown-target` and tried again on the next read. **Don't advance a `since` cursor past a read that reported `unknown-target`.**
  - An undo of a decision on a stage the unit has left, or of an approval whose job has run, is refused.
- **Only a person approves (R-12).** `approve`, `approve-spend` and `undo` count only when both hold:
  - `by` is not an agent name (`fold.ts#AGENT_AUTHOR`);
  - `view` is on the conformed-views list (`../decisions/conformed.ts`), or is `chat@1` in the exact words akuko asked for: `approve <amount> <CURRENCY>` for a spend, `approve <unit id>` for one unit (first word any case). A chat `undo` is always refused (`chat-undo`).

  Notes, requests for changes and declines are accepted from any view. No action, and nothing folding writes for itself, ever sets `approved`.
- **Rejected decisions stay visible.**
  - They stay in `decisions[]` (apart from unknown units and early undos, which integrity forbids storing).
  - They are listed in `report.rejected` with a reason. Tell the person.
  - Their unit gets a `Not applied: …` agent comment.
  - A rejected unit decision stays rejected. A refused `approve-spend` is visible as a waiting job whose latest decision is that approval. The person approves again. A refused approval is not revived when the cap is raised later (consent is to the amount shown, at the time); the over-cap and no-budget refusals say so.
- **Stale decisions.** A unit decision for a stage the unit has left (`stale-stage`), or on a unit with nothing produced yet (`not-reviewable`), is refused, with a notice.

**Cursors (`since`)** are per store. They only save reading; correctness never depends on them, and none is stored in `akuko.json`.

| Host | Store | Cursor |
|---|---|---|
| A | DB collection `decisions`, one row per decision | `db:<updatedAt>` of the newest row (rows at or after it are re-read) |
| B | `<project>/decisions.jsonl` | `jsonl:<byte offset>` after the last complete line (a half-written last line is left for next time) |
| C | `iyke iframe-state` → mirrored into `decisions.jsonl` | the mirror's `jsonl:<offset>`. Always mirror before reading: a pane reload clears the iframe state |

**Decision-driven status rows** (adds to §Status transitions)

| From | To | Who | When |
|---|---|---|---|
| `pending-review` / `needs-rework` / `approved` | `approved` | person | `approve` folded |
| `pending-review` / `needs-rework` / `approved` | `needs-rework` | person | `request-changes` folded |
| any | the trail's `<was>` | person | `undo` of that decision folded |
| `pending_spend` `awaiting-approval` / `declined` | `approved` | person | `approve-spend` folded and `canApprove` passed |
| `pending_spend` `awaiting-approval` / `approved` | `declined` | person | `decline-spend` folded (not after the job ran) |
| `pending_spend` `approved` / `declined` | `awaiting-approval` | person | `undo` of the spend decision folded (not after the job ran) |

## Real projects: sheet, master clock, rules, sign-off

*Owner: **WP-24** (gate G-SCHEMA-2). The fields below are in the schema; the packages named in "Read by" build the behaviour. Every field is optional, so a project made by breakdown, or converted from Studio or freeform, is unchanged.*

A real project can arrive with its own shot list (a spreadsheet), locked audio that sets the timing, house rules, and a second person who signs milestones. These fields carry that. "Writes" is who sets the field; "Read by" is who acts on it.

**Shot ids from a sheet.** An imported shot keeps the sheet's id: `S02-030`, `S07b-010`, `S03-020` (`SHEET_SHOT_ID`), beside breakdown's `sc<N>_sh<M>`. A sheet id has exactly one `-` and no `_`, so it can't be confused with a canonical id, a unit built from a shot id (`<shot>_keyframe`, `<shot>_clip`, `<shot>_vo`, `<shot>_lipsync`: `shotUnitId()` / `parseShotUnitId()`), a provider output id (`<unit>-<stage>`, `-2`) or a job id. `isSheetShotId()` tests the **pattern** only; it does not mean "this is a shot" (a ready-made row can have the same form, see cards). Writes: WP-25. Read by: every stage, unchanged.

**Sheet source** (`source {kind: "sheet", id, row?, removed_at?}`, on shots, scenes, assets and bible entries). `id` is the sheet's own id for the row (no `_`); `row` is the 1-based spreadsheet row. Re-import is keyed by `id` (WP-25): text and timing are refreshed, approvals and assets never touched. A row that has left the sheet gets `removed_at` (a timestamp) and is kept, never deleted. Writes: WP-25. Read by: WP-25, WP-29 (shows removed rows). A unit counts as removed when it, or its owner, has `removed_at` (`removedAt(p, u)` in the schema). `listUnits(p, { includeRemoved: false })` and `findUnit(p, id, { includeRemoved: false })` give the live set; the defaults keep removed units, because lookups and the decision folder still need them. Bible and sound readiness, the sketch and beat boards, the continuity audit, the integrity film-overlap check and check-view's "your move" counts skip removed units. A re-import that changes an approved bible entry's `description` sends it back to `pending-review` with an agent comment, as it does for a shot (WP-24c).

**Imported bible entries.** A sheet token becomes a bible entry **whose id is the token** (`ADA-NOW` is a valid id: letters, digits, `.`, `_`, `-`), with the token in `source.id`. A lighting code becomes a `bible.styles` entry whose id is the code and whose `description` holds the lighting phrase; `shot.lighting` names it (integrity). The style block and negative become the house style entry (WP-25).

**Shot** (`shots[]`)

| Field | Meaning | Writes | Read by |
|---|---|---|---|
| `source` | The sheet row the shot came from (above). | WP-25 | WP-25 (re-import) |
| `film {in_s, out_s}` | Where the shot sits on the master clock, in seconds; `out_s > in_s`. Shots in one scene must not overlap (a shot inside a longer one counts); touching (in = previous out) and gaps are fine. Within the master's length when `audio.master` is set. | WP-25 | WP-23b (timeline), WP-27, WP-28b, WP-29, WP-30 |
| `duration_s` (existing) | When `film` is set too, it must equal `film.out_s − film.in_s` (integrity, to 1 µs). | WP-25 | every stage |
| `part` | Part of the film, e.g. `P7`. Also on the scene. | WP-25 | WP-26 (scope), WP-29 (filter, gate scope), WP-30 (per part) |
| `lighting` | The sheet's lighting code: a `bible.styles` id (integrity). | WP-25 | WP-25 (prompt rebuild), WP-26 |
| `negative` | The shot's negative prompt, rebuilt per shot like `prompt` (the sheet's NEGATIVE). | WP-25 | key frame and motion providers, WP-26 (`require.applies_to: "negative"`) |
| `tier` | `A` hero, `B` standard, `C` simple. | WP-25 | WP-27 (default treatment), WP-30 |
| `framing`, `motion_note` | Free text from the sheet. | WP-25 | WP-27 (moves parsed from the note) |
| `lines[] {id, kind}` | Dialogue lines the shot covers; `id` is an `audio.lines[].id` of the same `kind`. | WP-25 (linked by film time) | WP-28b (spoken lines only), WP-29 |
| `treatment` | `still` · `still-move` · `video` · `lipsync`. **Absent = today's behaviour: every shot gets a `<shot>_clip` unit.** | WP-27 (default from tier; the person picks the video shots) | WP-27 (motion planning), WP-28b, WP-30, WP-23b |
| `move {from_scale, to_scale, x, y, ease?}` | A camera move on the still, in KenBurns's terms (`blocks/compositions/ken-burns.html`): scales are a factor of the frame (1 = whole frame, 0.5–3); `x`/`y` are the drift in pixels of a 1920×1080 frame over the move (negative = left / up). Runs for the shot's whole length. `ease` is `none` · `ease-in` · `ease-out` · `ease-in-out`, absent = `none` (constant speed). **The KenBurns block ignores `ease` today** (always constant speed); a renderer with eases maps them (GSAP `sine.in` / `sine.out` / `sine.inOut`; FCPXML keyframe ease in / out / in and out). | WP-27 | WP-27 (preview), WP-23b (FCPXML keyframes, EDL note) |

**Scene** (`scenes[]`): `part` and `source` as on the shot (a sheet scene: `S02`, `S07b`). Writes: WP-25. Read by: WP-29, WP-30.

**Project**

| Field | Meaning | Writes | Read by |
|---|---|---|---|
| `project.fps` | The timeline frame rate: one of `handoff/timecode.ts`'s labels (`23.976`, `24`, `25`, `29.97`, `30`, `50`, `59.94`, `60`). Absent: chosen at export (`--fps`, default 24). | WP-25 / the person | WP-23b |
| `audio.master {uri, duration_s, sample_rate, start_tc, sha256?}` | Locked audio that is the master clock: every `film` time is seconds on it, 0 = its first sample. `uri` is relative to the project folder and **may go up out of it** (`../Audio/mix.wav`, when the project folder sits next to the audio), or absolute; akuko only reads it. `start_tc` is `HH:MM:SS:FF` (e.g. `00:00:00:00`); when `project.fps` is set, `FF` is below the rate (integrity; without `project.fps`, WP-23b checks it against `--fps`). Every shot, card, line and word time must lie within `duration_s` (integrity). `sha256` notices a changed master. | WP-25 / the person | WP-23b (laid uncut from frame 0), WP-28b (slices), WP-30 |
| `audio.lines[] {id, character?, kind, film_in_s, film_out_s, clip_uri?, text?, words?}` | Dialogue on the master: `spoken` (lip-sync candidate) or `thought` (needs nothing). `clip_uri` is the line's own clip, a path like `audio.master.uri`. `words[] {w, t_s}`: each word's start, seconds on the master clock. Ids are unique. | WP-25 (from the quotes file) | WP-28b, WP-29, WP-30 |

**Assets**

- **`card`**: finished, ready-made material (title, part cards, credits). Not generated, never planned or priced by a stage, placed by `film` time. A card must have `film` and a `file` (integrity).
  - **Id:** `card_<sheet id>`, with the sheet id in `source.id` (`card_S04-020` for `S04-020`, `card_P1-CARD` for `P1-CARD`, `card_CREDITS-010` for `CREDITS-010`). A card's id must not have the sheet-shot form (integrity), so it never looks like a shot.
  - **Status:** recorded at stage `export`, status `pending-review`. **A person approves each card once on the board**, like any other material; code never writes `approved`.
  - **Handoff:** cards are treated like everything else: approved cards are placed at their film time, and the rest are listed as left out with their status.
  - Stored under `cut/cards/` when akuko stores one (`hosts/shared.ts`). Writes: WP-25. Read by: WP-23b, WP-29.
  - *Why a kind, not an origin flag on another kind:* code finds assets by kind or by stage + tag (key frames and clips by stage and tag, references sent to providers by `kind: "reference"`, music and SFX placement by kind). A flag on an existing kind would put finished material in those paths (a "finished" reference would be uploaded to a provider; a "finished" key frame used as a shot's still). A new kind is skipped by every existing path, and every exhaustive map over kinds has to place it explicitly (the compiler checks it).
- **`lipsync`**: the `<shot>_lipsync` unit (stage `motion`, owner = the shot), the same shape as `<shot>_clip`. Writes: WP-28b. Read by: WP-23b (on the shot's slot), WP-29, WP-30.
- `film {in_s, out_s}` may be set on any asset; a card needs it. `source` may be set on any asset (a card's sheet row).

**`rules`** (top level; absent = no rules, read through `rulesOf(p)`, which fills the empty defaults). Declarative data only; WP-26 checks every paid job against it **before** the spend gate and refuses a breach. Writes: the person (WP-25 may seed it from the house rules). Read by: WP-26 (guard, `rules/cli.ts check`, doctor); WP-28b (audio uploads).

| Field | Meaning |
|---|---|
| `required` | `true`: a paid call refuses when the rules are missing or invalid. |
| `banned[] {term, scope?, except?, note?}` | A term that must not appear in a prompt or negative (whole word, any case); `except` lists words that contain it and are allowed (e.g. `Gore-Tex`). |
| `require[] {text, applies_to: prompt\|negative, scope?, note?}` | Text that must be in every prompt (`shot.prompt`) or negative (`shot.negative`) in scope. |
| `uploads.allow[] {sha256, label, consent_ref?, for?, slices?, note?}` | Files akuko did not generate may be uploaded only if their **content hash** is listed (64 lowercase hex). `consent_ref` names a `consent[].id`. `for` (bible ids) limits the file to references for those entries, so an allowed photo of one person can't be used for another (absent = any use; WP-26 enforces). `slices: true` also allows time-slices cut from this exact file, e.g. a line cut from the master WAV (WP-28b checks the source file's hash, then uploads the slice). |
| `never_from_photo[]` | Bible entry ids that may only use generated references, never a photo. |
| `exempt[] {shots, skip, note?}` | Shots that skip some rules, e.g. `skip: ["house-style"]` for reference shots. Rule names are WP-26's. |
| `consent[] {id, who, what, date, note?}` | Consents the person holds. Recorded, not verified. |

`scope` is `{shots?, scenes?, parts?}` (any match; the same names as a gate's scope); absent = the whole film. Every id named must exist (integrity; a part exists when a shot or scene carries it).

**People and gates** (R9-5, R9-11). Writes: the person (people, gates); the sign-off record, WP-29's sign-off command. Read by: WP-29 (board, sign-off page).

- `people[] {id, name, role}`: `approver` approves day to day; `signoff` alone passes a gate. The role is `signoff`, not "host": a host is where akuko runs (A/B/C). Ids are unique.
- `gates[] {id, title?, scope {stage?, shots?, scenes?, parts?}, needs: "signoff", signed?}`: a milestone such as `G-LOOK` or `G-PILOT`. Scope ids must exist. Gate ids share the unit-id namespace.
- `gates[].signed {by, role, at, via, note?}` **is the sign-off record**, written by a command (WP-29), never by a view or the fold: `by` is a `people[].id` whose role is the gate's `needs`, `role` is that role, `via` says how it was given (`email`, `in person`, `shared page`). The person running akuko records it on the signer's word: **attested, not proven**. The agent never signs.
- **No decision variant carries a sign-off** (decided for G-SCHEMA-2): the board's decision format, `views/decision.schema.json`, stays as it is. Today's fold ignores `people`, `gates` and `rules`; a board decision aimed at a gate id is refused as `unknown-unit` and not stored (`schema/real-project.test.ts`).

#### Rules guard (WP-26)

*Owner: WP-26. Code: `../rules/` (`check.ts` the checks, `refs.ts` provenance and hashes, `text.ts` matching, `guard.ts` the gate wrapper, `cli.ts` the preflight).*

**Where it runs.** The four paid-stage command lines build their gate as `guardGate(createSpendGate(…), reader, {projectDir, providers})`. `guardedGate({host, providers, level, now, reader?, projectDir?})` does the same in one call; any TypeScript caller that hands a gate to a stage's `run.ts` (host A with the `ClaudeArtifactHost` included) builds it that way, never with a bare `createSpendGate`. The guard's `quote()` and `run()` check the job first. On a breach they return an ordinary refusal and **the wrapped gate is never called**: nothing is priced, reserved, written or sent. `collect()` passes through.
- The codes live in `rules/guard.ts`, not in the frozen gate: `rules-breach` (a rule was broken) and `rules-missing` (rules required but empty, or invalid).
- The callers (`*/run.ts`) report any refusal's `code` and `message` the same way, before reading the cost. The command line prints `Refused (rules-breach): …`, one line per breach.
- The guard reads the project fresh on every call. On B and C it reads through its own host on the same folder: an extra read on the gate's host would move that host's conflict mark. It checks a copy of the job, and hands that same copy to the gate.

**When.**
- No `rules` block: nothing is checked. A `rules` block, even one with only banned terms, turns on every rule below.
- **Text rules run on every job**, manual ones too: a prompt package is what the person pastes into a generator.
- **Reference rules run on paid jobs only** (billing from `providers/config.json`; an unknown provider counts as paid). They are about what akuko itself uploads, and the manual provider uploads nothing.

**What is checked, per job item:**
- banned terms: the `prompt` (for an audio job this is the spoken text: sound puts the narration in `prompt`), the `camera` note, and each ref's `note` (providers put notes into the prompt). **Not the `negative`**: listing a word there is how a prompt avoids it;
- required text: the `prompt` or the `negative`, as the rule says;
- for a paid job, every `ref`: its `uri` (or its asset's `file.uri`) is resolved relative to the project folder (it may go up out of it) and hashed (sha256, streamed). A ref with no file at all (a provider voice id) has nothing to upload and is skipped.

**What an item is about.** A unit that is a shot, or an asset owned by a shot (`<shot>_keyframe`, `<shot>_clip`, a later take), is that shot: its scene, its part (`shot.part`, else the scene's), its bible ids (`refs[]` plus `lighting`) and its subjects (the characters and locations among them). A bible entry, or an asset owned by one, is about that entry.

**Text is normalised before matching** (`rules/text.ts` `foldText`): text, terms and exceptions alike go through Unicode NFKC (fullwidth letters become ASCII, composed and decomposed accents compare equal, a no-break space is a space), lose invisible characters (`\p{Default_Ignorable_Code_Point}`: zero-width spaces and joiners, soft hyphens, the combining grapheme joiner, variation selectors, Hangul fillers), have every dash (`\p{Pd}`) mapped to `-`, and are case-folded in full (`ß` = `ss`, `İ` = `i`). Breach messages quote the folded text.

**Rule semantics**

- **`banned`**: whole word. A match may not touch a letter, digit or combining mark. Spaces, dashes, apostrophes, underscores and punctuation are boundaries: `gore` matches `Gore-Tex` and `GORE's`, not `gorey`. A multi-word term matches across any run of whitespace, dashes or underscores (`kelvo dyne` matches `Kelvo–Dyne`). A match inside a whole-word match of an `except` entry is allowed (`except: ["Gore-Tex"]`). **Plurals and other inflections are separate words: list each form as its own term** (`zorbex`, `zorbexes`). Unscoped terms apply to every job, bible jobs included; a scoped term applies only to shots in its scope.
- **`require`**: the text must be in what is sent, the item's `prompt` (`applies_to: prompt`) or `negative`. Folded substring, whitespace collapsed, the required text's own closing full stop ignored. It applies to **picture outputs of shots** (`keyframe`, `clip`) in scope, not to voice text, bible images or lip-sync. A job that sends no negative breaks a `negative` requirement. *Today the key-frame and motion plans don't send `shot.negative`, so a `negative` requirement refuses every such job until they do.*
- **`scope`** `{shots, scenes, parts}`: any match; absent = the whole film. A scoped rule never applies to a bible job.
- **`exempt[] {shots, skip}`**: the skip names are `banned`, `banned:<term>`, `require`, `require:<text>` and `house-style`.
  - `house-style` skips the `require` rules whose text is part of the house style: the description and notes of the bible style entry `house-style` (the id WP-25 imports the sheet's style block under).
  - Every other `require` still applies to an exempt shot, and so do the banned terms.
  - Reference rules can't be skipped. The preflight and doctor report a skip name that does nothing.
- **`required`**: `true` with nothing to enforce (no banned terms, required text, allowed files or never-from-photo entries) refuses every paid job as `rules-missing`; manual jobs still run. Rules that fail `RulesSchema`, or have a blank term or text, refuse every job.
- **`uploads.allow`**: a ref that is not generated (below) is **external**. It may be sent only if its sha256 is listed. The name and path don't matter: a renamed copy of an allowed file is the allowed file. A remote (`https:`, `mem:`…), missing or unreadable file can't be hashed, and is refused.
- **What a ref is a reference for** is read from the project state, never from the job (a ref's `id` naming a bible entry counts for nothing):
  - in a **bible job**: the entry the job is for, always, plus the entry that owns the ref's asset if that is another one;
  - in a **shot**: the bible entry that owns the ref's asset; else every subject of the shot (a picture attached to a shot counts for every character and location in it).
- **`for`**: an allowed file may be a reference only for those bible ids. With `for` set, every target above must be listed (a ref that is for nothing is refused too).
- **`never_from_photo`**: an external ref whose targets include such an entry is refused, even when its hash is allowed. A **generated** ref for such an entry must also be **verified**: its asset has a sha256 `file.hash` and the bytes on disk still match it. A generated ref without one is treated as unverifiable and refused.

**"Generated", precisely** (`rules/refs.ts` `generatingJob`). A ref is generated when it resolves to an asset whose id is `ref.id`, and whose `file.uri` is the ref's `uri` when the ref has one, and:
- the asset's kind is not `reference` or `card`;
- its `provider` is set and is not `manual`;
- it carries a `job:<id>` tag (`providers/outputs.ts`), and the ledger has an entry with that `job`, the same `provider`, status `done`, and `unit` equal to the asset's id or its owner. The gate writes that entry in `collect()`, after the provider returned the file.

A file brought back by hand is never generated, whatever the ledger says: the person made it somewhere akuko didn't see. When `file.hash` is a sha256 (the local host records one in `storeAsset`) and the file is readable, the bytes must still match it; a swapped file is refused as `generated-changed`.

**Slices: the contract for WP-28b.** A time-slice akuko cuts from an allowed file (a line from the master WAV) is a new file with a new hash. Its provenance lives **in the project state, never in the job**. The cutter records each slice as an asset:
- `provider: "akuko-cut"` (`SLICE_PROVIDER`);
- a tag `slice-of:sha256:<64 hex of the source file>@<in_s>-<out_s>` (`sliceTag()` / `parseSliceTag()`), seconds on the source;
- `file: {uri, hash}` with the slice's own sha256. **The cutter must record `file.hash`** (the local host's `storeAsset` does); a slice without one is refused.

The lip-sync job's ref then names that asset (`ref.id` = its id, `ref.uri` = its `file.uri`). The guard accepts the slice when all of these hold:
- the source hash is in `rules.uploads.allow` with `slices: true` (that entry's `for` then applies);
- the slice's bytes are audio or video **by content** (RIFF/WAVE, ID3 or an MPEG frame, an MP4/MOV `ftyp` box, FLAC, Ogg, WebM/Matroska), whatever the extension;
- its `file.hash` is a sha256 and matches the bytes;
- `0 ≤ in_s < out_s`, the source's length is known, and `out_s` is within it: `audio.master.duration_s` when `audio.master.sha256` is the source hash, else the WAV header of a project file (the master, a line clip, an asset) with that hash. An unknown length is refused, so record `audio.master.sha256` (or keep the source among the project's files);
- a WAV slice's own length is within 0.5 s of `out_s − in_s` (lead-in and tail allowed). The lengths of other formats are not measured.

An MP4/MOV file counts as video only for audio/video `ftyp` brands (`isom`, `iso2`, `mp41`, `mp42`, `M4A `, `M4V `, `qt  `, `avc1`, `dash`); image brands such as HEIC and AVIF are refused. The allow-list check comes first, then these.

A `slice-of` note, or anything else in the job, makes nothing a slice. `providers/contract.ts` is unchanged.

**Free preflight:** `node --experimental-strip-types rules/cli.ts check --project <dir> [--json]` checks:
- every shot's own `prompt` (banned and required text), `negative` (required text only), `camera`, `narration` and `script_line` (banned); rows with `source.removed_at` are skipped;
- every dialogue line's `text` (`audio.lines[]`) against the banned terms in scope for the shot that carries it;
- every bible entry's name, description and notes, against the unscoped banned terms;
- every listed reference file as if it were about to be uploaded: each entry's `refs[]`, and the `reference` assets attached to an entry or a shot.

It prints one line per breach with its shot id (`bible:<id>` for an entry, `line:<id>` for a line no shot carries), and exits 1 on any breach. At run time the guard sees the full prompt a stage builds (its framing text, the bible descriptions, the look), so a run can still refuse what the preflight passed. `rules/cli.ts hash <file…>` prints the sha256 an allow entry takes.

**Doctor** prints the rules line (present or not, the counts, required or not) and how many allowed files are not among the files the project points at: every non-card asset's file, the master and each line's clip, matched by hash. It warns about required-but-empty rules and skip names that do nothing.

**Known limits**
- **Check to read.** The guard hashes a file, then the provider reads it again to upload it. A file swapped in between is sent unchecked. `providers/**` is frozen, so a loader that checks the hash as it reads is a follow-up.
- **Doctor trusts `audio.master.sha256`.** When the master's file is there, doctor uses the recorded hash without re-hashing it (a master can be hundreds of MB). The guard itself hashes whatever a job sends.
- **Look-alike letters** from other scripts (a Cyrillic `о` inside a Latin word) are not mapped, accents still count (`cafe` ≠ `café`), and HTML entities are not decoded: prompts are plain text.

#### Sign-off gates (WP-29)

*Owner: WP-29. Code: `../decisions/gates.ts`, `../decisions/cli.ts` (`signoff`, `signoff-file`, `gates`), `../views/signoff.ts`. Agent rules: `../actions/review.md` §Sign-off.*

- **Two levels.** A person approves units day to day (decisions, folded as above). A gate is passed only when `gates[].signed` names a person whose role is the gate's `needs` (`signoff`). An approver's approvals never pass a gate; a signoff person's sign-off never approves a unit.
- **Only a command writes `gates[].signed`**: `decisions/cli.ts signoff --project <dir> --gate <id> --by <person id> --via "<how>" [--note …] [--at <ISO>] [--replace]` (host A: `signoff-file`, on the saved `akuko/project` doc). It refuses, writing nothing, when the gate is unknown (`unknown-gate`), the person is unknown (`unknown-person`) or has not the gate's role (`wrong-role`), the gate is already signed (`already-signed`), or `via` / `at` is unusable (`bad-input`). `at` defaults to now. Folding never writes it, and no view can (`decisions/gates.test.ts`).
- **Re-signing** (`--replace`) keeps the old record: the new `note` ends with `Replaces: signed by <by> (<role>) at <at> via <via>; note: <old note>`, so a chain of re-signs stays readable in `akuko.json`. There is no unsign command; replacing is the only change.
- **Attested, not proven.** The person running akuko records the sign-off on the signer's word. On host B nothing checks who the signer is; the record says how it was given (`via`).
- **What a gate covers** (`unitsInGate`, used by `gateStatus`, the board and the sign-off page):
  1. In-scope shots: every shot when the scope names no `shots` / `scenes` / `parts`; else a shot whose id, scene, or part (its own, else its scene's) is named.
  2. With no shot filter, every shot, asset and bible entry; with one, the in-scope shots, the assets they own, the bible entries they name (`refs`, `lighting`), the assets those entries own, and the cards whose part is named. A card's part is the part of the first shot that starts at or after it (else the last shot's: end credits).
  3. `scope.stage` keeps only units at that stage: G-LOOK `{stage: "bible"}` is the bible images; G-PILOT `{stage: "keyframes", parts: ["P7"]}` the P7 key frames.
  Rows with `source.removed_at` are never counted; they are listed as removed.
- **Gate status** (`gateStatus`, `decisions/cli.ts gates`): the units in scope, how many are approved / waiting / sent back / not made, and the state: `signed`, `ready` (all approved, not signed), `open`, or `empty` (nothing at that stage yet). It notes a gate signed while units were still open, and units changed (`updated_at`) after the sign-off. **Gates are informational: they never lock or unlock a stage.** The person decides when to move on.
- **Units removed from the sheet** (`source.removed_at`, set by WP-25's re-import; never deleted) are kept for the record and leave review. "Removed" means the unit's own `source.removed_at`, **or its owner's** (the `<shot>_keyframe` of a removed shot; one rule, `decisions/fold.ts#removedAt`). The stage roll-up in folding (`recomputeStages`) **excludes them**, so a removed shot still waiting for review never keeps its stage from `approved`; every fold also re-rolls each stage that holds a removed unit, so a removal alone (a re-import, with no decision) releases the stage on the next fold; a new decision aimed at one is refused (`removed-from-sheet`, with a `Not applied: …` notice) and changes nothing; gates don't count them; the board lists them in a collapsed "Removed from the sheet" group with no decision control and leaves them out of "your move". A decision folded before the row was removed stays as it was. Each paid stage's own readiness check (`bible/plan.ts`, `keyframes/plan.ts`, `sound/plan.ts`: "every shot / entry approved") still counts them; that is outside WP-29 and is a follow-up.
- **The sign-off page** (`views/publish.ts --project <dir> --signoff <gate> [--out <file>] [--images embed|link|none]`) is read-only: no script, no button, no network; check-view reports it SKIP. It shows the units in scope with their pictures, ids and statuses, the house rules, and what signing means, and is sent as a file or a private link. Pictures are embedded up to 3 MiB each and 12 MB in all, then referenced by a path relative to the page; only pictures inside the project folder or its parent (after resolving links) with an image extension are read, anything else is listed as not loaded (`views/signoff.ts`).

## Open questions

*Anyone may append one line per question, with their WP id.*
