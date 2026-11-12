# Providers

A provider is anything that makes an image, clip, sound or layout for a unit:
a paid HTTP API, a paid tool on a connected MCP, or a person (the manual
provider). All of them have one shape (`providers/contract.ts`), so every
stage can swap one for another. Every stage also has a no-key path, because
the manual provider can do any kind of job.

## The contract

```ts
interface Provider {
  id: string;                          // 'gemini-image', 'fal', 'canva', 'manual', …
  kinds: ('image' | 'video' | 'audio' | 'layout')[];
  hosts: ('A' | 'B' | 'C')[];          // where it can run
  capabilities: { refImages?; maxSeconds?; nativeAudio?; i2v? };
  readonly billing: 'free' | 'direct-api' | 'connected-mcp';  // from config.json
  estimate(job: Job): Promise<Cost>;   // pure; feeds the spend gate; no paid endpoint
  submit(job: Job): Promise<JobHandle>;  // only via gate.run()
  poll(h: JobHandle): Promise<JobStatus>;
  fetch(h: JobHandle): Promise<Asset[]>; // files via host.storeAsset()
}
```

- **`Job`**: `{ id, stage, kind, provider, model?, label, items[] }`. Each
  item is one unit: `{ unit, prompt, output (asset kind), refs?, count?,
  duration_s?, aspect_ratio?, seed?, negative?, camera? }`. For a paid
  provider, `id` is also the id of the job's `pending_spend` entry.
- **`Cost`**: `{ amount, currency, per_unit, model?, basis, last_verified? }`.
  `per_unit` must cover every unit and add up to `amount`.
- **`JobHandle`**: plain JSON (`job`, `provider`, `ref`, `stage`, `units`,
  `submitted_at`, `ledger`, `handoff?`), so a job can be picked up in a later
  session.
- **`JobStatus`**: `queued | running | waiting-for-input | done | failed |
  cancelled`, plus an optional per-unit `actual` cost.

Providers use only the wave-1 host subset: `readState`, `writeState`,
`storeAsset`.

## Model ids and prices live only in `providers/config.json`

Each provider has an entry there: `label`, `billing`, `default_model`, and
`models`. Each model has a `price` (`{ amount, per: job | image | second |
call | character }`), a `source`, and a `last_verified` date. `doctor` reports
models older than `stale_after_days` (`staleModels()`).

- Don't write a model id or a price in code. A test fails if a configured
  model id appears in any non-test source file.
- `estimateFromConfig(config, job)` prices flat-rate providers. Use it unless
  the provider's pricing really is more complex.
- Entries marked `example: true` are placeholders with illustrative prices.
  `priceFor()` refuses them outside tests. WP-06 replaces them with real
  entries, taken from each provider's own pricing page, and gives each the
  date it checked.

## Writing a provider

1. Add its entry to `providers/config.json`, with `billing`, models, prices
   and today's `last_verified`.
2. Write a `ProviderImpl` under `providers/<id>/` and wrap it with
   `sealProvider(impl)` from `spend/gate.ts`. The seal reads `billing` from
   config and makes `submit()` refuse anything that did not come through
   `gate.run()`. Never export the unsealed impl. The id `manual` is
   reserved: only `providers/manual` may seal it, and config may mark only
   `manual` as free.
3. `estimate()` must not call a paid endpoint or write state.
4. `fetch()` writes files through `host.storeAsset()`. Give each file an
   `owner` (its unit). The gate records the outputs: the asset goes into
   `assets[]`, and the unit moves to `pending-review`.
5. A `direct-api` provider must not list host `A` (R-11).
6. Add a spec to `PROVIDERS` in `providers/contract.test.ts`. The contract
   suite checks the shape, the seal, the config entry, estimate purity,
   direct-submit refusal, refusal without a cap, and a full run through the
   gate.

## Allowance tools on a connected MCP (Canva and similar)

On host A the person may make images or video with a tool on a connector they
connected, such as Canva's `generate-image`. Such a tool is not a provider in
`providers/config.json`: akuko does not call it from code, has no price for it,
and cannot see the person's allowance. It is still not free. Every wave goes
through the allowance gate in `lib/spend.md` §Allowance (the allowance line,
the exact reply `approve <n> <service> generations`, an optional per-service cap
in `budget.allowance_caps`) and every generation is recorded in the ledger with
`estimate`/`actual` 0 and `allowance: { service, units }` (`spend/allowance.ts`).
Keep the service's own confirmations (Canva asks before a video uses the
monthly AI limit) for the person to answer. The files come back like a manual
take: through `ingest()` (or the host's `storeAsset()`), to `pending-review`.
Canva hands back only a small preview (199 x 112 seen on 2026-11-11); ask the
person for the full-size file before review, and say so.

## The manual provider (`providers/manual/`)

This is the no-key path. It is lifted in shape from Studio's
`export.prompt_package` / `render.ingest_external` pair.

- **estimate**: 0, from its config entry (billing `free`). It still goes
  through the gate, so it gets the same ticket and the same checks, minus the
  money ones. It needs no budget and runs on every host, A included.
- **submit**: returns a handle whose `handoff` is a **prompt package**. For
  each unit, the package gives the prompt shaped for the target (`generic`,
  `flow`, `higgsfield`, `veo`, as in Studio), the references to attach, and
  the name to save the result under (`<unit>-<stage>.<ext>`). It also lists
  which file types will be accepted. Show `handoff.text` to the person.
  Nothing is written to `akuko.json` yet.
- **ingest** (`manual.ingest({ job, unit, file, actual?, model? })`): takes
  the file the person brings back. It checks the unit is in the job and the
  file type fits the job's kind, then stores the file with
  `host.storeAsset()`. Then it records the asset: a planned asset unit with
  no file yet (a portrait, a plate) is filled in place, and anything else gets
  a new asset `<unit>-<stage>`, then `-2`, and so on for later takes. The
  unit moves to `pending-review`. If the person reports what it cost them
  and a budget exists, that amount goes into the ledger.
- **poll / fetch**: a job is done when every unit has an ingested file
  tagged `job:<id>`. The state lives in `akuko.json`, so this works across
  sessions.

The person brings files back by attaching them in chat, or by dropping them
in the project folder. Never mark the result approved: the person approves
it on the board.

## The fal lip-sync provider (`providers/lipsync/fal/`)

Id `fal-lipsync`; paid direct API (key `FAL_KEY`); hosts B and C only (R-11); kind `video`.
It turns a picture plus a spoken line into a lip-synced video. One request per
unit (`<shot>_lipsync`); the output is a `lipsync` asset, `pending-review`.

### Job contract (what WP-28b's planner must build)

Each `JobItem` has `output: 'lipsync'`, `count` 1, and refs:

| ref | meaning |
|-----|---------|
| `role: 'audio'` | the spoken line: a **16-bit PCM WAV file in the project folder** (an `https:` or `data:` audio ref is refused), already cut to the shot. `note: 'seconds=<n>'` declares its length (`secondsNote(n)`). In image mode the note may be left out and `duration_s` stands for it. |
| `role: 'start-frame'` | a still (image + audio mode): a png/jpg/webp file, `data:image/…`, or `https:` URL |
| `role: 'source-video'` | an approved clip (video + audio mode): an mp4/mov/m4v **file in the project folder**. `note: 'seconds=<n>'` is required. |

Exactly one audio ref and exactly one of the two picture refs.

**`duration_s` is the billing basis in seconds, before the model rounds it.**
It is not "the audio length" in video mode:

| mode | model | `duration_s` | the model then bills |
|------|-------|--------------|----------------------|
| image | any | audio seconds | audio seconds (floor 1 s for fabric) |
| video | Kling lipsync | the **source clip's** seconds | clip seconds rounded up to 5 s |
| video | veed lipsync v2 | the **longer of** clip and audio | output seconds |

Limits are checked per input: the clip's own limit (Kling 2-10 s) is on the
clip; the audio's own limit (Kling 2-60 s and 5 MB; h3-max 5-15 s) is on the
line. A 2.3 s line on a 10 s clip bills 10 s; a 12 s line on a 10 s clip is
accepted and also bills 10 s.

### Measure, don't trust

Before the first request the provider reads the real length of every audio file
(16-bit PCM WAV only; anything else is refused with a message to convert) and, in video
mode, of every clip (mp4/mov header, never loaded whole; uses `handoff/probe.ts`
and `sound/wav.ts` read-only). A declared length more than 0.05 s from the
measured one, or outside the model's limits, is refused and nothing is sent.
The 0.05 s tolerance applies only to declared-versus-measured; **a model's
maximum has no tolerance** (a 15.04 s line does not reach h3-max's 15 s limit,
where fal bills 1.2x; it goes to fabric, or is refused if h3-max is named).
Pricing uses the larger of declared and measured. Every unit is fully checked
(paths, sizes, lengths, limits) before unit 1 is queued, so a bad unit 2 cannot
be refused after unit 1 is already in fal's queue.

### Files are confined

`createFalLipsyncProvider(host, { projectDir, allowRoots?, maxUploadBytes? })`.
`projectDir` is required. Every file ref (relative, `../`, absolute or
`file://`) must resolve, symlinks included, inside `projectDir` or one of
`allowRoots`, or the job is refused. `allowRoots` is passed only by the caller,
and only after the person has confirmed each folder; nothing in a job, a ref or
`akuko.json` can add one. Extensions are allow-listed (audio `.wav`; video `.mp4`
`.mov` `.m4v`; images `.png` `.jpg` `.jpeg` `.webp`). Plain `http:` is refused;
`https:` is passed through for a still only. **Audio and clips must be project
files**: an `https:` or `data:` audio ref is refused, because fal would fetch
the URL after it was measured and the bill would have no bound.

Files go to fal inline as `data:` URIs, capped at `maxUploadBytes` (default
4 MB), checked from `stat` before the file is read. Over the cap the job is
refused with a message naming fal CDN upload as the follow-up.

### Models (ids and prices in `providers/config.json`, read from fal's own pages on 2026-11-10)

| mode | role | endpoint | price | limits akuko enforces |
|------|------|----------|-------|------------------------|
| image + audio | default for a line of 5-15 s | `minimax/h3-max/lip-sync/image-to-video` (768P) | $0.08 / s | audio 5-15 s (fal allows 15 min, but over 15 s bills 1.2x) |
| image + audio | default for a line under 5 s (and the fallback otherwise) | `veed/fabric-1.0` as `#480p` / `#720p` | $0.08 / $0.15 per s, priced at max(audio, 1 s) | none stated by fal; fal does not say whether it bills audio or output seconds |
| video + audio | default | `fal-ai/kling-video/lipsync/audio-to-video` | $0.014 / s of clip, rounded up to 5 s | clip 2-10 s, audio 2-60 s and 5 MB |
| video + audio | fallback (line under 2 s or clip outside 2-10 s) | `veed/lipsync/v2` | $0.07 / s of output | none stated by fal |

With no `model` on the job each unit gets the first configured model of its
mode (`default_model` first, then config order) whose limits admit its measured
line (and clip) length: `chooseLipsyncModel`. Spoken lines are mostly short
(median about 2.3 s), so most stills go to fabric 480p; there is no silence
padding. A model must match the picture kind. The Kling price is the dearer of
two readings on fal's own pages (see the config `source`).

### For WP-28b

- **Per-shot audio cut:** cut the line to the shot as a WAV (16-bit PCM) and
  declare its seconds; do not pass a master track. The line's length picks the
  model, so the planner should call `chooseLipsyncModel` and **set `job.model`
  itself**, one model per job.
- **Hash the model into the job id.** The gate matches an approval on the job
  id, not on the model, so a fallback model with the same id would reuse the
  first model's approval. `motion/plan.ts` hashes units + provider + model into
  the id; do the same.
- **Roots:** pass `projectDir`, and `allowRoots` only for folders the person
  confirmed (for example a media folder outside the project).
- **Uploading the person's clips and lines to fal is the person's call.** Say
  so in the spend line before approval.
- **Refusals at estimate time surface from `gate.run` as an exception**, not as
  `{ status: 'refused' }` (the gate quotes first, and the provider throws on a
  bad file, length or path). Catch them and show the message.
- Only **16-bit PCM WAV** audio is accepted; convert anything else before the job.
- **Video mode is, in practice, unusable for typical approved clips** until fal
  CDN upload exists: clips go inline under the 4 MB data-URI cap, and an
  approved clip is usually bigger. Plan stills + audio (image mode) for now.
- The returned video carries the line as its audio; leave that audio out of the
  edit when a master track is used.

### Known gaps

- Whether these endpoints accept `data:` URIs is **unverified**: fal's docs say
  only that some models do and call them not recommended above a few KB, and no
  model page confirms it. The first real call should be tiny and
  person-approved. If one is refused, fal CDN upload is the follow-up (not
  built; the 4 MB cap exists for that reason).
- Kling's price is read two ways on fal's own pages; the config takes the dearer.
- Audio is WAV only, clips mp4/mov only.
