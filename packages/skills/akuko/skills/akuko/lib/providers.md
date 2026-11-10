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

**A job item** carries:

| ref role | meaning |
|----------|---------|
| `audio` | the spoken line, already cut to the shot (exactly one) |
| `start-frame` | a still: image + audio mode |
| `source-video` | an approved clip: video + audio mode (exactly one of the two pictures) |

`duration_s` is the length of that segment in seconds. It is checked against the
model's limits and priced from config. A path ref is read from disk and sent as a
`data:` URI; an `https:` URI is passed to fal as is (same as `fal` / `fal-video`;
the loader is `mediaRefLoader`, because the shared one only knows image types).
No new upload mechanism. The audio of the returned file is the supplied line:
keep this video's sound out of the edit if a master track is used.

**Models** (ids and prices in `providers/config.json`, read from fal's own pages on 2026-11-10):

| mode | role | endpoint | price | limits akuko enforces |
|------|------|----------|-------|------------------------|
| image + audio | default | `minimax/h3-max/lip-sync/image-to-video` (768P) | $0.08 / s | audio 5-15 s (fal allows 15 min, but over 15 s bills 1.2x) |
| image + audio | fallback | `veed/fabric-1.0` as `#480p` / `#720p` | $0.08 / $0.15 per s | none stated by fal |
| video + audio | default | `fal-ai/kling-video/lipsync/audio-to-video` | $0.014 / s, rounded up to 5 s | segment 2-10 s, audio 5 MB, video 100 MB |
| video + audio | fallback | `veed/lipsync/v2` | $0.07 / s of output | none stated by fal |

With no `model` on the job, a still job uses `default_model` and a clip job the
first video model in config order (`defaultLipsyncModel`). A model must match the
picture kind; a mismatch is refused. A fallback is chosen by naming another
configured model, which is a different job hash and so needs its own approval.
The Kling price is the dearer of two readings on fal's own pages (see the
config `source`); the estimate rounds each segment up to a 5 s step.
Over-limit audio is refused with the limit, never trimmed.
