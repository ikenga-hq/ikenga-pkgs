# @ikenga/skill-groundwork

**Groundwork: research → design → plan → orchestrate for Claude Code, with plan folders that don't rot.**

A Claude Code skill that scaffolds and maintains a reusable
**research → design → plan → orchestrate → act** folder for any
non-trivial work — software features, marketing campaigns, org changes.

It drops a domain-agnostic spine (`00-README` · `01-plan` · `02/03`
research · `04-discussion` newest-first · `05-tracking` ·
`09-orchestration`) plus stateless action-skills that augment the docs in
place without clobbering hand-written prose. Profile-driven: `software`,
`general`, `content`, and `design-system`. Each plan also gets self-contained
HTML views — a **board** (`artifact/board.html`), a file
**explorer** (fully offline) with search (`artifact/explorer.html`), and a cross-plan
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

## How it compares

groundwork is one option among several planning skills. Superpowers and `etr/groundwork` are different tools; the points below describe only what this repo implements and make no claims about their internals.

- Plan state lives in a `.groundwork.json` anchor plus fenced generated regions in the markdown docs; re-runs write only inside fences, and `test_fence_integrity.py` checks this.
- Stable IDs (`WP-NN`, `G-NN`, `D-NN`) link plan, tracking, orchestration and the HTML views.
- Profiles (`software`, `general`, `content`, `design-system`, `film`) change vocabulary and optional docs without changing the spine.
- Produces standalone HTML views (board, explorer, plans index) per plan, plus an optional `orchestrate --emit-workflow` multi-agent kickoff.
- State logic is stdlib-only Python with a deterministic test suite (`npm test`).

## Commands this skill runs

For users who want to allowlist rather than blanket-approve `Bash`. Derived from `SKILL.md` and `actions/*.md`; `<skill>` is the installed `skills/groundwork/` directory.

```text
python3 <skill>/scripts/groundwork_state.py <subcommand> --plan <plan>
    scaffold, spine-gate, resolve-profile, next-id, write-region, stamp-research,
    status-data, board-data, explorer-data, living-spec-data, plans-index-data,
    register-subplan, register-id, register-design, register-design-impl,
    design-data, design-lock, design-migrate,
    issue-sync-data, register-issue, register-milestone, apply-issue-sync
python3 <skill>/scripts/generate_explorer.py --plan <plan> | --all-under <plans-dir> [--missing-only]
python3 <skill>/scripts/generate_plans_index.py --plans-dir <plans-dir>
python3 <skill>/scripts/watch.py --plan <plan> | --plans-dir <plans-dir>
node    <skill>/scripts/build-offline-artifacts.mjs     # maintainers only
```

`issue-sync` additionally runs `gh repo view`, `gh issue create|close|reopen|list`, `gh pr list`, `gh api repos/{owner}/{repo}/milestones` and `glab repo view`, `glab issue create|list`, `glab api projects/:id/milestones` with your credentials. It asks for confirmation (target repo, visibility, exact text) before any write.

## Security notes

- **Web research is untrusted data.** The `research` action writes fetched web content into `02-research-external.md`, and plan docs later become briefs for build agents. Fetched text is kept in the delimited research section, cited, and must be treated as data, never instructions, when briefing agents. Review `02` before orchestrating.
- **`issue-sync` writes to your Git forge** with your credentials and publishes plan text to the repo. It confirms the target repo, its visibility and the exact text before any write.
- **CDN scripts.** `board.html` and the living spec (`artifact/index.html`) load React and `@babel/standalone` from `cdn.jsdelivr.net`, pinned to exact versions with SRI (`integrity`) hashes. They need network on first open; only the explorer and plans index are fully offline.
- **Explorer iframes.** Gallery thumbnails use `sandbox="allow-scripts"` (opaque origin, no access to the explorer). The full viewer keeps `allow-same-origin` because previewed plan artifacts (the board, living spec) use `localStorage` and fetch sibling plan files; the explorer only talks to them via `postMessage` (theme push). Plan folders from untrusted clones are untrusted input: previewed HTML runs scripts, so do not open them in the viewer.

## Portability

The skill's docs and the standalone board carry a few
**this-workspace-internal references** (`plans/studio` / `plans/groundwork`)
that are illustrative in a target project. See
[`skills/groundwork/PORTABILITY.md`](skills/groundwork/PORTABILITY.md) for the
full disclosure.

## License

[Apache-2.0](LICENSE). Copyright © 2026 Royalti.io.
