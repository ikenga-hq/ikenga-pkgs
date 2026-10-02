# @ikenga/skill-thunderbird

## 0.2.1

### Patch Changes

- [`fcebba5`](https://github.com/Royalti-io/ikenga-pkgs/commit/fcebba53599f71b63065b3e66792a19b3132a4ed) Thanks [@nedjamez](https://github.com/nedjamez)! - Drop the `fs.read` and `shell.execute` declarations (ADR-020).

  Thunderbird is skill-only — no `mcp` block, no `sidecars` — so neither scope has
  a consumer: `shell.execute` gates the sidecar spawn that never happens, and
  `fs.read` becomes a live Tauri ACL grant that, with no `remove_capability` in
  Tauri 2.11, outlives the pkg until process exit. The mail-store reads are done
  by Claude Code under its own permission model, not through the kernel's ACL.

  `net` and `vault.keys` are kept: those scopes are not wired to any enforcement
  point and exist to record intent, which is how eleven sibling skills already use
  `sqlite.tables`.

  Strictly reduces granted scope; no behaviour change to the skill.

## 0.2.0

### Minor Changes

- [`2fb5f74`](https://github.com/Royalti-io/ikenga-pkgs/commit/2fb5f74259d1a0746288d30aeddc71e2b5d10a81) Thanks [@nedjamez](https://github.com/nedjamez)! - Initial release of `@ikenga/skill-thunderbird` — the Thunderbird mail skill.

  Operates on the user's local Thunderbird mail store (not `ikenga.db`), so it
  ships as a standalone skill pkg rather than folding into the dispatch-only
  `@ikenga/skill-mail`.

  Two capabilities:

  - **Read (mbox)** — search/extract emails from the local offline-store mbox
    files: by sender / date / subject, large-mailbox tail handling, an inline
    zero-dep mbox parser, and MIME encoded-word (Q/B) header decoding. Never
    modifies the store or syncs IMAP.
  - **Write drafts (IMAP APPEND)** — place a drafted reply into the user's Drafts
    folder by appending it to the IMAP server with the `\Draft` flag, correctly
    threaded via `In-Reply-To` / `References`. Documents why local-mbox writes
    silently fail (server-authoritative `.msf` index → local-only drafts never
    display and are compacted away) and how to resolve the mailbox password from
    the host secret store at run time. The skill never sends mail.

  Portable / project-agnostic: profile via `TBIRD_PROFILE` or per-OS defaults; no
  hardcoded paths or account-specific credential names. Declares the permission
  set the capabilities require — `shell.execute`, `fs.read` (profile mbox globs),
  `net` (IMAP/IMAPS), and `vault.keys` (`*IMAP*`).

  Publish sync deferred (supervised) — held changeset + `"private": true`.
