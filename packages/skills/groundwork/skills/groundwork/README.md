# groundwork

**Groundwork: research → design → plan → orchestrate for Claude Code, with plan folders that don't rot.** (Not to be confused with other plugins of the same name, e.g. `etr/groundwork`.)

Groundwork turns "plan this" into a folder of living documents — a plan, research, a discussion log, a tracking file, and standalone HTML views — and gives you a small set of actions you can re-run any time. The defining property: **re-runs augment your work, they never overwrite it.** A checksum decides what changes on disk, not the model.

It's an open skill (Apache-2.0). It runs in plain Claude Code with nothing else installed, and because it ships in the open `npx skills` format it also works with Codex, Gemini, Cursor and other agents. The [Ikenga](https://ikenga.dev) shell is optional — it adds live in-shell views — but the skill, the folder, and the multi-agent kickoff all work without it.

## Install

```bash
npx skills add ikenga-hq/groundwork
```

Project install (committed with the repo). Add `-g` for a global install. Needs a Claude Code environment and Node ≥ 18.

## The folder

`groundwork init` interviews for a goal + profile and drops a domain-agnostic spine:

```
plans/my-feature/
├── .groundwork.json        ← identity + state anchor
├── 00-README.md
├── 01-plan.md
├── 02-research-external.md
├── 03-research-internal.md
├── 04-discussion.md        ← rounds, newest-first
├── 05-tracking.md          ← work packages + gates
├── 09-orchestration.md     ← generated multi-agent kickoff
└── artifact/
    ├── board.html          ← standalone plan board
    └── explorer.html       ← standalone file explorer (on `groundwork explorer`)
```

Every doc uses **generated-region fences** — actions write only inside them; your hand-authored prose is never touched. Stable IDs (`WP-NN`, `G-NN`, gates, `D-NN`) thread plan → tracking → orchestration → views, so re-syncs are deterministic, not guesswork.

## Actions

| Action | What it does |
| --- | --- |
| `init` | First-run interview (goal + profile); scaffolds the spine + `.groundwork.json`. |
| `research` | Researcher agent fills `02`/`03` in place. `--sweep` fans out finders via a Workflow. |
| `design` | Produces ≥2 comparable `designs/*.html` for the current phase; locks one. |
| `subplan` | Scaffolds a focused `NN-*.md` (diff-plan · decision-doc · bug-doc). |
| `review` | Reviewer agent appends a dated Round to `04`, allocates gap IDs, re-syncs by ID. `--panel` runs an adversarial panel. |
| `clarify` | Readiness gate before orchestrate. |
| `orchestrate` | Generates `09-orchestration.md` (waves, gates, briefs). `--emit-workflow` writes a runnable Workflow. |
| `refresh-board` | (Re)generates `artifact/board.html`. |
| **`explorer`** | (Re)generates `artifact/explorer.html` — a fully-offline file tree + tabbed viewer with search. |
| **`plans-index`** | (Re)generates `<plans-dir>/_index.html` — a cross-plan dashboard, one card per plan. |
| `status` | Read-only freshness + ID + design-coverage report. |

The core loop is **init → research → review → orchestrate**, with `review` re-run whenever the plan changes.

## Profiles

A profile swaps vocabulary and optional blocks without changing the spine: `software` (features/PRs), `general` (campaigns/org changes), `content` (editorial + key art), `design-system` (component/token libraries — adds a parts gallery + quality gate).

## Three HTML views

All three are self-contained Ikenga artifacts: they open standalone in any browser. The explorer and plans index are fully offline; the board and living spec load pinned React/Babel from jsDelivr with SRI hashes, so they need network on first open and light up with live status inside the Ikenga shell.

- **Board** (`artifact/board.html`) — Mission Control, Kanban, and dependency-graph views of one plan's execution state.
- **Explorer** (`artifact/explorer.html`) — a file tree + tabbed viewer (Markdown, live previews, images, code) with **full-text search**, profile-adaptive (gallery for `design-system`, media for `content`). **Fully offline** — React, the Markdown renderer, and the sanitizer are inlined and the view is pre-transpiled, so it runs air-gapped, in Claude Desktop, or as a bare upload with no network.
- **Plans index** (`<plans-dir>/_index.html`) — a cross-plan dashboard: one card per plan with a progress bar, drift indicator, and drill-in to each explorer / board.

### Tooling

The explorer and index are also scriptable for automation:

```bash
python3 scripts/generate_explorer.py --all-under plans/ --missing-only   # backfill every plan
python3 scripts/watch.py --plan plans/my-feature                          # live-refresh on change
node    scripts/build-offline-artifacts.mjs                               # rebuild the offline HTML from *.src.html
```

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

## How it works

The state machine (the `.groundwork.json` anchor, generated-region fences, the hash-diff that makes "augment, never overwrite" a guarantee) is specified in [`lib/state.md`](lib/state.md) and executed by the stdlib-only `scripts/groundwork_state.py`. Each action lives in its own file under [`actions/`](actions); `SKILL.md` is the router.

## Docs

- Full documentation: **[ikenga.dev/docs/groundwork](https://ikenga.dev/docs/groundwork)**
- The skill dogfoods itself — `plans/groundwork/` is the canonical worked example of every artifact in the spine.

## License

Apache-2.0.
