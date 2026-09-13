# @ikenga/pkg-studio

## 0.7.0

### Minor Changes

- [#105](https://github.com/ikenga-hq/ikenga-pkgs/pull/105) [`3ba20cd`](https://github.com/ikenga-hq/ikenga-pkgs/commit/3ba20cd30a8a8166aba8cbc9273f0d0a7c0c0999) Thanks [@nedjamez](https://github.com/nedjamez)! - Studio WP-32 close-out. The node canvas is now the sole Canvas surface (the 1D Rail is retired after the G-61 live re-clear): nodes are positioned and draggable, lane drops write `Cell.index`, groups and per-shot create/delete live on the canvas, posters and render status come from live render records, and the viewport no longer snaps back on every save. Sidecar: the open-project cache re-syncs on out-of-band `storyboard.json` edits; HyperFrames on Windows drives `chrome-headless-shell` (`npx puppeteer browsers install chrome-headless-shell`) and failed renders carry the full command + output tails; Chrome discovery handles win64/mac/linux Puppeteer cache layouts. MCP: `STUDIO_SUPPRESS_EVENTS=1` test knob, shutdown census on stdin EOF, connection-probe retry instead of a silent mock latch. Launcher: `host.openFolder` gets a user-paced timeout with a visible waiting state; Windows-safe fallback names. Sidecar trust: client side of the host-authenticated `/iyke/pkg-trust/project-access` relay (fails closed until the shell endpoint ships).

## 0.6.0

### Minor Changes

- [`ab8f8ad`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ab8f8add71bac2d52c6b32dc554be49172584e8e) Thanks [@nedjamez](https://github.com/nedjamez)! - - Migrate project sidecar and MCP server to Bun runtime with built-in `bun:sqlite`, eliminating external native C++ module dependencies for Tier 1 1-click in-app installation (ADR-017).
  - Phase 4 Blender 3D headless adapter conformance (G-74): FFmpeg frame assembly, 30fps progress envelopes, cancellation, and resolution scaling.
  - Phase 4 DaVinci Resolve NLE exporter (G-75): FCPXML DTD validity, boundary-based G-53 frame quantization without drift, async process spawning, and Purple beat marker support.
  - Phase 5 Node Canvas conformance (G-76): atomic `.studio/canvas.json` persistence and drop-commit reordering.
  - Recents registry (G-47), atomic cell content write-back (G-48), and session state persistence (G-50).
  - Additive renderer enum extension: `blender` and `fal` on `Cell.renderer`, `excalidraw` on `Block.default_renderer` (G-68).

## 0.5.0

### Minor Changes

- [#47](https://github.com/Royalti-io/ikenga-pkgs/pull/47) [`2fc3443`](https://github.com/Royalti-io/ikenga-pkgs/commit/2fc3443cb41a93669ca6669d2d920ebefe90798c) Thanks [@nedjamez](https://github.com/nedjamez)! - Breakdown board thumbs now show the real rendered frame for any shot with a
  finished render, instead of the ember-glow placeholder.

  Reuses the poster seam Canvas already uses — `CellPoster` for the image and
  `prefetchPosters` for a single batched `render.list_posters` round trip on the
  done-render ids. Because the prefetch is driven off `shot.record`, which is
  done-only, it never asks for frames that have not finished. The shot-type label
  is layered above the frame so it stays legible against real imagery.

## 0.4.0

### Minor Changes

- [`44a41b5`](https://github.com/Royalti-io/ikenga-pkgs/commit/44a41b5cb857c125bfc59e5e83ffbb8a2853cb21) Thanks [@nedjamez](https://github.com/nedjamez)! - F-9 — deliver the fal API key to the render sidecar from Stronghold in-shell.

  The render sidecar reads its key from `process.env.FAL_KEY` (the `render-runner`
  vault shim maps `studio.fal` → `process.env.FAL_KEY`), but nothing injected it
  in-shell: it only worked when a launch-env `FAL_KEY` happened to be present, and
  the shell's sanitized dev/reload respawn dropped it. The old comment claiming
  "the real Stronghold vault surface replaces this" was false.

  This declares the mapping on the `fal_api_key` **settings** secret via a new
  `"env": "FAL_KEY"` field. The shell's pkg supervisor resolves that secret from
  Stronghold (studio pkg scope) and injects `FAL_KEY` into the sidecar's env at
  spawn — at BOTH spawn sites, so a dev-reloaded sidecar gets it too. This rides
  the `settings` block, NOT `permissions.vault.keys`, so it introduces no
  permission change and cannot park the pkg. A launch-env `FAL_KEY` remains the
  headless/standalone fallback. The render-runner comment now states the true
  contract.

  Requires the shell-side supervisor injection (shipped separately in the shell).

## 0.3.0

### Minor Changes

- [#43](https://github.com/Royalti-io/ikenga-pkgs/pull/43) [`12f7128`](https://github.com/Royalti-io/ikenga-pkgs/commit/12f7128dad658951e44434e4f796e8dd4dabd9c8) Thanks [@nedjamez](https://github.com/nedjamez)! - Link the script to the storyboard: a deterministic `breakdown.run` verb, a
  hand-off to your Chi for the judgment half, and a Breakdown rail that only
  draws links it can prove.

  - **New `breakdown.run` MCP tool** (+ matching sidecar RPC, registered in all
    three places a method needs: the `RpcMethod` union, the `EXTENDED_METHODS`
    set, and the `extended` switch — `tsc` cannot catch a missing set entry, it
    fails at runtime with `-32601`). It has **two modes, chosen automatically by
    whether the board already has cells**:

    - **Scaffold** (board empty) — mints one rung-0 cell per Fountain action
      paragraph with OTIO ids (`sc<N>` scene, `sc<N>_sh<M>` shot, used as both
      uid and `label`) and writes the matching `[[sc<N>_sh<M>]]` tags back into
      `script.fountain`.
    - **Retag** (board has cells) — creates **nothing**. Matches action
      paragraphs to the cells already there and writes only the tags, using each
      cell's uid as the tag value.

    Retag auto-matches **only when the reading is forced**: one paragraph per
    cell, in order, with no authored tag contradicting that order. Anything else
    returns `outcome: 'ambiguous-needs-chi'` with the real counts and a
    plain-language `detail`, and writes nothing — matching paragraphs to shots is
    judgment, and this server has no LLM. Branch on `outcome`: `scaffolded` |
    `retagged` | `already-tagged` | `ambiguous-needs-chi` | `script-write-failed`
    | `planned` (dry run). `dry_run: true` plans only and touches no disk.

    Mechanical only, by construction: `shot_type` / `camera_move` stay `'unset'`,
    `prompt` is `''`, `anchors` is `[]`, `duration_ms` is `0` — those need the
    `studio-breakdown` skill, and `run` refuses to guess them. Zero spend: the
    handler imports no renderer and no queue, so it can never reach
    `render.enqueue` or `anchor.generate`. Non-destructive: it never deletes or
    overwrites a cell, and never overwrites an authored `[[tag]]` — a tag that
    disagrees with the order match makes the call ambiguous instead of being
    clobbered. Every count it reports is measured; `script_bytes` is `null` when
    nothing was written rather than a placeholder.

  - **The Breakdown rail is now tag-only, and this changes what you see.**
    Previously the rail linked script lines to shots **positionally**, and only
    when the action-paragraph count happened to equal the shot count — on a real
    hard-wrapped script the counts never matched, so no rail drew at all; on a
    script where they did match, the links were positional guesses. Both are
    gone. The rail now links a paragraph to a shot **only** via an explicit
    `[[tag]]` naming that shot's uid or id. A script with no tags yet gets no
    rail and says so ("rail: no `[[tags]]` in this script yet — nothing to
    link"), with a one-click "Send to your Chi" to go tag it. **If your board's
    counts previously lined up and drew a positional rail, it will now draw
    nothing until the script is tagged** — run `breakdown.run` or send it to your
    Chi. A drawn line is now always exact.

  - **`permissions.engine: ["invoke"]`** added to the manifest (the same grant
    tasks/research/content already ship). Without it `host.sendToActiveSession`
    is scope-denied for Studio. This backs the "Send to your Chi" half of the
    Breakdown split CTA (Scaffold shots · Send to your Chi), wired in this same
    change via a typed `sendToChi(prompt, source?)` bridge helper. Refusals are
    surfaced honestly and distinctly: `scope-denied` names the shell's manifest
    check (the Chi never saw the request), `no-active-session` means a shell is
    present but no chat pane is focused, and `no-host` means standalone dev with
    no shell at all — it no longer tells you to focus a pane that cannot exist.

  - **Engine chip now requires a finished render.** It composes `engine ▸ model`
    from a render record whose `status === 'done'` only. A queued, running,
    failed or cancelled render previously chipped "engine that rendered this
    shot" onto a shot that had rendered nothing; those now fall back to the
    labelled Track A/B pill.

  - **Track A/B is labelled as the estimate it is**, and a capability matrix that
    failed to load is now a distinct third state (`unknown`) rather than being
    silently counted as Track B — a failed fetch no longer looks like a genuine
    all-Track-B board, and the tooltip no longer cites a matrix that isn't there.

  - **No money on this board.** The cost strip is gone; the facts strip carries
    counts and the Track split only. The old `est $2.10` had no source — no price
    field exists on `EngineCapability`, and cost is only known post-hoc on a
    `RenderRecord`.

  - **Internal type fix**: `EngineCapability.max_duration_ms` was typed `number`,
    but the fal adapter really reports `null` ("no advertised cap"); it is now
    `number | null`, and callers must read `null` as "unknown / no cap", not as
    zero. This is internal to this pkg's bundle — `@ikenga/pkg-studio` publishes
    a manifest plus built `dist/` and declares no `exports` map, so no consumer
    imports this type and nothing downstream breaks. Noted here because the
    in-repo callers changed, not because it is a public API break.

  - The Fountain parser moved to `@ikenga/studio-schema/fountain` so the sidecar
    and the pane segment a script identically — one parser, no drift between what
    Breakdown shows and what the scaffold generates. The parser now joins
    hard-wrapped lines into whole paragraphs and lifts the title page out of the
    body (it used to leak `Title:` / `Credit:` / `Draft date:` in as the first
    action paragraphs of a phantom `UNTITLED` scene).

  - Demo/standalone mode no longer invents results: `breakdown.run` there returns
    `outcome: 'demo-inert'` with `null` counts and says plainly that it did
    nothing, instead of reporting tags written against a JS template literal.

### Patch Changes

- [`f6d7bfb`](https://github.com/Royalti-io/ikenga-pkgs/commit/f6d7bfba0ae85ec9e85d6d0f1630b1414e87baaf) Thanks [@nedjamez](https://github.com/nedjamez)! - Give an open project a way out, and stop the poster prefetch from degrading to N
  solo fetches.

  - **Project exit / switch (F-2).** `closeProject()` existed but had zero call
    sites and `Launcher` was published only in the no-project menu, so opening a
    project was a one-way door. `buildProjectMenu` now carries a "Close project"
    item (→ `closeProject()`) and a "Switch project" recents section (self-filtering
    the currently-open project), and the standalone App header title is a close
    button. The recents lifecycle was rewired so the switcher is populated even
    when an optimistic resume opens straight into a project. Both affordances
    converge on the verified `openProjectByPath` / `closeProject` paths — clicking
    "Close project" returns the board to the Launcher and republishes the
    no-project menu. (Cross-project switch-while-open is not yet live-verified —
    only one project was available on the test machine; the switcher reuses the
    same verified open path.)

  - **Poster prefetch is authoritative now (Group F).** `prefetchPosters` issues
    one batched `render.list_posters`, but each `CellPoster`'s solo fetch flushed
    child→parent _before_ Canvas's batch effect, so N single-id calls beat the
    batch (observed 8× on one board load). The card's solo fetch is now deferred a
    microtask so the batch reserves its ids first, collapsing the card's call to a
    no-op; genuine post-settle misses still solo-fetch. One board load is now
    +1 `render.list_posters`, +0 per-card `render.read_poster`.

- Updated dependencies [[`12f7128`](https://github.com/Royalti-io/ikenga-pkgs/commit/12f7128dad658951e44434e4f796e8dd4dabd9c8)]:
  - @ikenga/studio-schema@0.2.0

## 0.2.0

### Minor Changes

- [`7c3a9eb`](https://github.com/Royalti-io/ikenga-pkgs/commit/7c3a9eb6d09fd174934d9fe6c88e7007b446e19d) Thanks [@nedjamez](https://github.com/nedjamez)! - First published release of the Studio app pkg: the full UI redesign — Dusk Wood
  theme owned via parent-mirror + self-hosted fonts, L-A production-desk Launcher
  on real seams, C-A broadcast-cockpit Composition with real blob: playback and
  adaptive render polling, CE-A Cell editor on a real content read/write seam
  with loss-proof saves, ArchetypeBuilder on the real catalog, Canvas render
  truth + add/delete cells, draggable pane resizing, Script real hydration +
  Fountain seam, project rehydrate after sidecar restarts, recents hygiene, and
  the M-A production-ledger side menu.

  Note: installing this pkg from the registry requires npm-dependency
  materialization the installer does not do yet (the sidecar needs
  better-sqlite3 + esbuild at runtime) — dev-mounting from a checkout remains
  the supported runtime path for now.
