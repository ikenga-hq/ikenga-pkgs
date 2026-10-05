# @ikenga/skill-groundwork

A Claude Code skill that scaffolds and maintains a reusable
**research → design → plan → orchestrate → act** folder for any
non-trivial work — software features, marketing campaigns, org changes.

It drops a domain-agnostic spine (`00-README` · `01-plan` · `02/03`
research · `04-discussion` newest-first · `05-tracking` ·
`09-orchestration`) plus stateless action-skills that augment the docs in
place without clobbering hand-written prose. Profile-driven: `software`,
`general`, `content`, and `design-system`. Each plan also gets self-contained
HTML views — a **board** (`artifact/board.html`), a fully-offline file
**explorer** with search (`artifact/explorer.html`), and a cross-plan
**plans index** (`<plans-dir>/_index.html`).

## Install

```bash
# Global install (recommended — available across all projects)
npx skills add ikenga-hq/groundwork -g

# Project install (committed with your repo)
npx skills add ikenga-hq/groundwork
```

`npx skills add` resolves `skills/groundwork/SKILL.md` and symlinks it into
`~/.claude/skills/groundwork/`.

## Source of truth & publish flow

**There is one editable copy.** As of the 2026-08-21 unification, the dev source moved
into this package — `./skills/groundwork/` **is** the source. Edit it directly.

| Copy | Path | Role |
|---|---|---|
| **Source** (this package) | `ikenga-pkgs/packages/skills/groundwork/skills/groundwork/` | ADR-009 home, Changesets-versioned. **Edit here.** |
| **Workspace dogfood** | `<ikenga-workspace>/.claude/skills/groundwork/` | A **symlink** into the path above — not a copy. |
| **Published mirror** | [`ikenga-hq/groundwork`](https://github.com/ikenga-hq/groundwork) | The `npx skills add` install surface. Built FROM this package. |

Why the change: the previous layout kept the dev source in `ikenga-workspace`, which is
**private**, and copied it into this **public** package via `sync-from-dev.mjs`. Contributors
could read the published skill but not the file anyone actually edited, and every change
needed a sync hop that could silently drift. The script is gone; there is nothing to drift.

Files no longer carry a `GENERATED` banner, because they are no longer generated.
`PORTABILITY.md` was emitted by the old sync script and is now hand-maintained source.

- `pnpm test` — the deterministic hard gate: `skills/groundwork/scripts/test_groundwork_state.py`
  (state machine, profiles, ids, designs) and `test_fence_integrity.py` (fixture plan: writes
  touch only fenced regions, identical re-runs are byte- and mtime-exact no-ops, and
  deliberately broken writers are caught). Python 3 stdlib only. Runs in ikenga-pkgs CI
  (`ci.yml`, on PRs that touch this package and nightly).
- `pnpm build:mirror` — **runs `pnpm test` first and refuses to build if it fails** (no skip
  flag; the mirror push is manual, so this is where the publish depends on the tests), then emits the standalone `ikenga-hq/groundwork` mirror tree
  (package.json + README + install.sh + `skills/groundwork/`) to `./dist-mirror` for review
  before pushing. Note the mirror repo's own `README.md`, `CONTRIBUTING.md`, `.github/` and
  `assets/` are hand-maintained there and are **not** emitted — a blanket sync would delete
  them.

## Portability

The skill's docs and the standalone board carry a few
**this-workspace-internal references** (`plans/studio` / `plans/groundwork`)
that are illustrative in a target project. See
[`skills/groundwork/PORTABILITY.md`](skills/groundwork/PORTABILITY.md) for the
full disclosure.

## License

[Apache-2.0](LICENSE). Copyright © 2026 Royalti.io.
