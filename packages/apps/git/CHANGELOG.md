# @ikenga/pkg-git

## 0.2.1

### Patch Changes

- [#114](https://github.com/ikenga-hq/ikenga-pkgs/pull/114) [`ebce0bc`](https://github.com/ikenga-hq/ikenga-pkgs/commit/ebce0bc6eb52f9c31118f88685366d7bbe88a382) Thanks [@nedjamez](https://github.com/nedjamez)! - Migrate app manifest navigation from `ui.nav` to `ui.views` with 5 views, views[0] pinned on install (manifest v5).

## 0.2.0

### Minor Changes

- [#79](https://github.com/ikenga-hq/ikenga-pkgs/pull/79) [`6325895`](https://github.com/ikenga-hq/ikenga-pkgs/commit/6325895d138708eac3d629c30288a159f74ee49b) Thanks [@nedjamez](https://github.com/nedjamez)! - WP-10 fix — commit the INDEX, and make "explicit paths" an assertion.

  `argv.commit` emitted `git commit -F - --only -- <paths>`, reading 01-plan.md's
  "commits only the explicit path list" as a pathspec. A pathspec does not mean
  that: `git commit -- <paths>` (and `--only`, its explicit spelling) commits the
  **working tree** content of those paths and ignores the index for them. So a
  porcelain `MM` file — staged at one revision, then edited again in the editor —
  committed the later, unstaged, unreviewed content, while the pkg's own
  staged-diff pane showed the earlier one. It affected the sidecar and the MCP
  `git_commit` tool alike, and was reproduced end to end against a real repo
  through the real sidecar process.

  `commit` is now `git commit -F -` with no pathspec, and the caller's path list
  is enforced before anything is written: `assertStagedSetMatches`
  (`core/src/staged.ts`) reads `git diff --cached --name-only -z` and refuses with
  the new `staged-set-mismatch` error reason — nothing committed — unless the
  staged set equals the requested set. Containment is unchanged in strength;
  a surprise is now a refusal rather than a silently different commit. `paths: []`
  keeps its UI-only "commit whatever is staged" meaning; the MCP tool still
  requires a non-empty list, so `git_commit` always asserts.

  This is a minimal G-RPC reopen: one added member of `GitErrorReason`. No method
  name, arg shape, result shape or notification changed.

  Also in this fix:

  - The commit box's Commit button now enables and disables as the message is
    typed. `disabled` was computed once at build time while the message was still
    empty, and the `input` listener updated the message without touching the
    button — so the button was permanently disabled and Enter was the only way to
    commit.
  - "Send to your Chi" copies its prompt to the clipboard and says so.
    `host.sendToActiveSession` does not exist in the shell's pkg-iframe dispatcher
    (the cited studio precedent calls the same missing verb), and the button
    previously reported a delivery that never happened. The label is unchanged.
    `permissions.engine` goes back to `[]` — it bought nothing.

- [#79](https://github.com/ikenga-hq/ikenga-pkgs/pull/79) [`07a7f66`](https://github.com/ikenga-hq/ikenga-pkgs/commit/07a7f664bbbdff1d5ab021b44d15bb6ff00ce81b) Thanks [@nedjamez](https://github.com/nedjamez)! - WP-03 — `git-core`, the shared library behind `com.ikenga.git`: repo
  discovery, argv construction, the child-env denylist, and the porcelain
  parsers. Pure TypeScript, no process of its own; the one-shot sidecar, the
  long-lived MCP and the tests all import it and `bun build` inlines it into
  each bundle. Git on disk stays the single owner of repo state (G-03).

  `core/src/rpc.ts` is a byte-verbatim copy of the frozen G-RPC artefact
  (`plans/git/drafts/rpc.ts`) — the contract is edited in the plan folder and
  re-copied, never edited here.

  `core/src/argv.ts` is the real containment boundary (G-02), since the manifest
  allowlist only fires at kernel spawn: a hardcoded subcommand allowlist with
  per-subcommand verb pinning (`worktree list`, `stash create`), structured
  builders that emit `string[]` and take no caller-supplied flags, `--` before
  every pathspec, `^-` / NUL / absolute / `..` rejection, and a forbidden-flag
  rescan of every finished argv. `--no-optional-locks` and `--literal-pathspecs`
  ride on every invocation; commit messages go on stdin via `-F -` so no message
  ever reaches argv; `commit` records the INDEX (`git commit -F -`, no
  pathspec — a pathspec would commit the working tree instead) and the explicit
  path list is enforced as an assertion in `core/src/staged.ts`.

  `core/src/env.ts` builds each child env clear-first — `IKENGA_*` and git's
  repo-targeting/config-injection variables dropped, `GIT_TERMINAL_PROMPT=0`
  forced, and `SSH_AUTH_SOCK` / `GIT_ASKPASS` / credential helpers / signing
  config untouched, so the user's own auth and signature work with zero
  credential code in the pkg.

  `core/src/discover.ts` maps the host context's project root onto the four G-05
  no-root states, walks a bounded nested-repo scan (`.git` files as well as
  directories, dot-directories walked, `node_modules` skipped, breadth-first so
  truncation cuts the deepest repos), and provides the deepest-owner primitive
  behind the G-11 cross-repo staging guard.

  138 tests, including verification 5 (env asymmetry proved by spawning a real
  child and reading its environment back) and verification 6 (option injection),
  plus an end-to-end pass against a real `git` binary that skips itself when git
  is absent.

- [#79](https://github.com/ikenga-hq/ikenga-pkgs/pull/79) [`130b116`](https://github.com/ikenga-hq/ikenga-pkgs/commit/130b1163b0c115a2d75ccf9ef1c52fdf02f90507) Thanks [@nedjamez](https://github.com/nedjamez)! - WP-02 scaffold for `com.ikenga.git`: `manifest.json` with `sidecars[]` (repo
  watch/cache/RPC stub), `mcp[]` (read-first git tool surface stub), and `ui`
  (side-menu nav skeleton — Changes · History · Branches · Worktrees · PRs)
  blocks.

  `shell.execute: ["node", "bun", "git", "gh"]` — `node`/`bun` are the
  kernel-enforced launcher entries, `git`/`gh` are disclosure-only for the
  trust prompt (the real containment boundary is `git-core`'s command
  construction rules, landing in WP-03). `fs.read`/`fs.write` declared
  `$home/**` per D8 — honest disclosure; neither scope has a runtime
  enforcement site today, and a narrower `$project_root` token is deferred
  until one exists. `restart_when_changed` globs on both long-lived processes.

  The sidecar and MCP server are stdio stubs that boot and respond to every
  call without crashing (`{ok:false, reason:"not_implemented"}` / a `ping`
  tool respectively) — the real repo discovery, RPC dispatch, and frozen
  G-MCP tool surface land in WP-03 through WP-06.

- [#79](https://github.com/ikenga-hq/ikenga-pkgs/pull/79) [`5f8ca40`](https://github.com/ikenga-hq/ikenga-pkgs/commit/5f8ca40ef1c7b707725e6dccc8147af6a027cec6) Thanks [@nedjamez](https://github.com/nedjamez)! - WP-08 — the History view: a paginated commit log with a hand-rolled commit
  graph, a commit-detail inspector, and first-class `Co-Authored-By` attribution.

  The graph is built, not bought. `@gitgraph/js` has been archived and unmaintained
  since 2019, so `ui/src/views/history/graph-layout.ts` implements the
  forbidden-columns algorithm (pvigier — the family behind gitk, GitKraken and
  GitHub's own graph) over `%H %P`: for each commit, take the lowest column not
  already carrying an edge that spans its row. First parents keep the mainline
  straight, merge parents fork right and rejoin at the leftmost arriving lane, a
  parent that isn't on the loaded page dangles off the bottom instead of being
  dropped, and lanes are capped so a pathological repo can't push the commit text
  off-pane. It imports nothing — a `CommitSummary[]` satisfies its input type as-is.

  Paging is GitLens's shape: 500 commits, then 200 at a time, by `--skip`. The
  whole layout is recomputed on append rather than patched, because a second page
  resolves edges the first page could only dangle.

  Attribution gets its own treatment because the data demands it: the
  `Co-Authored-By` trailer is user-configurable and can be switched off, so its
  absence is a real state and not evidence that anyone worked alone. Rows badge
  the trailer when it's there; the detail pane always renders an attribution
  block and says in words what an absent trailer does and does not mean. An
  Attribution filter dims non-matching rows instead of removing them, so the one
  true graph survives filtering.

## 0.1.0

### Minor Changes

- WP-02 scaffold: `manifest.json` with `sidecars[]` (repo watch/cache/RPC stub),
  `mcp[]` (read-first tool surface stub), and `ui` (side-menu nav skeleton)
  blocks; `shell.execute: ["node", "bun", "git", "gh"]`; `fs.read`/`fs.write`
  declared `$home/**` per D8 (honest disclosure — no `$project_root` token
  enforcement exists yet); `restart_when_changed` globs on both long-lived
  processes. Sidecar and MCP are stdio stubs that boot and respond without
  crashing — the real repo discovery / RPC dispatch / tool surface land in
  WP-03 through WP-06.
