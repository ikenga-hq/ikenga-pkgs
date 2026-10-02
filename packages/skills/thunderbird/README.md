# @ikenga/skill-thunderbird

Thunderbird mail skill for Ikenga — read/search the local Thunderbird mbox
store, and save reply drafts to the IMAP server for the user to review and send.

Portable and project-agnostic: it discovers the profile from `TBIRD_PROFILE`
(or the per-OS defaults) and resolves the mailbox password from the host secret
store at run time. No hardcoded paths or account-specific credential names.

## Install

> **Not separately installable yet.** The thunderbird skill is published deferred (supervised) — held changeset with `"private": true`. The public mirror at `ikenga-hq/skill-thunderbird` will be available once the 3-copy publish sync is wired.

## What it does

| Capability | Path | Description |
|---|---|---|
| **Read** | local mbox | Search and extract emails from the offline-store mbox files (by sender, date, subject; large-mailbox tail handling; MIME header decoding). Never modifies the store or syncs IMAP. |
| **Write drafts** | IMAP APPEND | Place a drafted reply into the user's **Drafts** folder by appending it to the IMAP server with the `\Draft` flag — correctly threaded (`In-Reply-To` / `References`). This is the only write path. |

It does **not** send mail. The draft-write path goes to the **server**, never
the local mbox — writing a draft into the local offline-store mbox does not work
(Thunderbird displays the server view via the `.msf` index, so a local-only
draft never appears and is dropped on compaction). See the skill body for the
full mechanism.

## Why a separate pkg from `@ikenga/skill-mail`

`skill-mail` is **dispatch-only** over `ikenga.db` (`sqlite.tables`, no net, no
fs). This skill operates on the local OS mail store and the IMAP server, so it
needs a different permission set — `fs.read` (profile mbox files),
`shell.execute` (grep/stat/etc.), `net` (IMAP), and `vault.keys` (mailbox
credentials). Keeping it separate preserves `skill-mail`'s tight, sqlite-only
contract.

## Permissions

| Permission | Why |
|---|---|
| `shell.execute` | `grep` / `stat` / `pgrep` / `tail` / `sed` for mbox search; `node` / `npx` to run the IMAP-append draft helper. |
| `fs.read` | Read-only access to the Thunderbird profile mbox files across the per-OS profile locations. |
| `fs.write` | `$pkg_data` scratch for large-mailbox extraction only. |
| `net` | IMAP/IMAPS connection for the draft APPEND. |
| `vault.keys` | Mailbox IMAP credentials (`*IMAP*` key glob), resolved from the host vault at run time — never inlined. |

## License

Apache-2.0 — see [LICENSE](../../LICENSE) (monorepo root).

## Phase

Initial skeleton. Publish sync deferred (supervised) — held changeset + `"private": true`.
