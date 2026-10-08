# com.ikenga.mattermost

Mattermost bridge sidecar for Ikenga. It replaces the Rex/Ruby Mattermost bots of `royalti-agents`: each
Mattermost thread is a **Chi run** on an `ikenga-server` daemon, under the bot's own Ikenga account.

- **B1** (still the fallback): read-only echo bridge. A bot with no `daemon` + `chi` config echoes.
- **B2** (this): sessions + threading. New thread starts a run, replies resume it, "stop" cancels it.
- B3 approvals, B4 scheduled posts, B5 rails/audit are not here yet. The bridge has no tool beyond the Chi run.

## How a thread maps to a run

| Mattermost event (after the gate) | Daemon call | Result in the thread |
|---|---|---|
| New root post | `chi_run` with the bot's `engine`, `cwd`, `model`, `mode`; `systemPrompt` is prepended to the first prompt only | "Working…" reply, edited in place while polling `chi_status`; on `done` it becomes "Done in Ns." and the result is posted as a new reply (a new post notifies, an edit does not) |
| Reply in a thread the bridge knows | `chi_resume(runId, prompt)` on the stored run | same progress / result flow |
| Reply in a thread with no stored run | fresh `chi_run`, and the thread is told "no earlier run" | same |
| Reply while a turn is still running | none | "Still working… reply `stop`". It is never resumed on top of a live turn |
| Reply that is just `stop` / `cancel` | `chi_cancel` | "Run cancelled." |
| Resume fails with "chi run not found" or "no engine session id" | fresh `chi_run` | notice: started a fresh run, it will not remember earlier messages |

A leading `@botname` is stripped from the prompt.

The mapping `root_id -> { run_id, bot, channel_id, created_at, updated_at, brief, active? }` lives in
`<dataDir>/threads-<bot>.json` (mode 0600, written to a temp file then renamed, entries idle for 30 days dropped).
`active` records the turn in flight (progress post id), so after a bridge restart the bridge re-attaches to the run and
finishes the same progress post.

The gate from B1 sits in front of everything: deny by default, `allowedUsers` and `allowedChannels` both required,
own posts and `system_*` posts ignored. A denied post never reaches the daemon (it does not even trigger a login).

## Configuration

Set `MATTERMOST_BRIDGE_CONFIG=/path/to/bridge.json`. Secrets are never inline: each is `{"env":"NAME"}` or `{"file":"/path"}`.

```json
{
  "mattermostUrl": "https://mm.example.com",
  "dataDir": "/var/lib/ikenga/mattermost",
  "bots": {
    "rex": {
      "mattermostToken": { "env": "MM_REX_TOKEN" },
      "allowedUsers": ["alice", "bob"],
      "allowedChannels": ["engineering", "rex-alerts"],
      "daemon": {
        "url": "https://ikenga.example.com",
        "auth": { "kind": "session", "username": "rex", "password": { "file": "/etc/ikenga/rex.pw" } }
      },
      "chi": { "engine": "claude-code", "cwd": "~/work/royalti", "systemPrompt": "You are Rex, ...", "persistent": true },
      "progress": { "pollMinMs": 1000, "pollMaxMs": 10000, "editIntervalMs": 5000 }
    },
    "ruby": { "...": "own entry, own credentials" }
  }
}
```

- `daemon.auth.kind: "session"` is **T1** (production): `POST /auth/login`, `ikenga_session` cookie, one re-login on a 401.
  `"bearer"` is **T0** (local testing): `Authorization: Bearer`. Under T1 the daemon refuses bearer tokens.
- No `Origin` header is sent (the daemon allows a missing one for non-browser clients). Set `daemon.origin` only if needed.
- Passwords, tokens and the session cookie are redacted from every error and log line.
- `persistent` (default true) starts the first turn as a detached chi-runner so it survives a daemon restart. Resumed
  turns run in-process (see gaps).
- Without `MATTERMOST_BRIDGE_CONFIG`, the legacy env vars (`MATTERMOST_URL`, `MATTERMOST_TOKEN`,
  `MATTERMOST_ALLOWED_USERS`, `MATTERMOST_ALLOWED_CHANNELS`) start a single B1 echo bot.

### Can Rex and Ruby share an account or workspace?

Technically yes: every bot has its own `daemon` entry, and two entries may name the same username and password (and the
same `cwd`). The bridge assumes neither. What sharing costs: both bots then run as one Unix uid with one set of engine
logins, files and `chi_list`, so Ruby's read-only guarantee would rest on the prompt alone, not on the account. Do not
point a bot at an admin account; give it an ordinary one. Separate accounts are the recommended default.

## Daemon contract used

`POST /api/rpc {cmd, args}` -> `{ok:true,data}` | `{ok:false,error:"<cmd>: <msg>"}` (verified against shell `origin/main` a9f88d2e):

- `chi_run` args `{opts:{engineId, prompt, cwd?, model?, mode?, timeoutSeconds?, persistent?}}` -> `{run_id, status, output, output_truncated, error}`
- `chi_resume` args `{runId, prompt}` -> same shape, status `running`
- `chi_status` args `{runId}` -> same shape. Statuses: `queued running awaiting_auth done failed cancelled timed_out`
- `chi_cancel` args `{runId}` -> `{status:"cancelled"}`

The result text is `chi_status.output` once the status is `done`.

## Known gaps

- **`output` is the whole final text**, not a stream. Progress is only a status line plus elapsed time; there is no
  token streaming and no partial text (partial output exists in the run's output file but `chi_status` is only trusted
  here once the run is terminal).
- **A run that writes nothing reports `output` = its original prompt** (the cache row's `brief`). The bridge recognises
  that and posts "no result text" with the run id instead of echoing the prompt.
- **Resumed turns are not durable.** `chi_resume` always runs in-process; only the first turn can be a detached
  chi-runner. A daemon restart mid-resume ends that turn, and the bridge reports the failure.
- **Run rows may expire.** The daemon stamps each cache row `expires_at` one hour ahead (`chi_exec.rs`
  `one_hour_from_now_iso`); I did not verify what deletes expired rows or whether a resume refreshes the stamp. If a row
  is gone, the reply starts a fresh run with no memory of the thread (the bridge says so). Threads idle for hours may
  therefore always restart.
- **No resume while a turn is live**; a second message is refused with a notice, not queued.
- **Replies in a thread the bridge never saw** (e.g. a human thread in an allowed channel) start a fresh run.
- `awaiting_auth` (the engine needs a human to sign in on the host) is reported but the bridge cannot fix it.
- Daemon login is throttled server-side; a wrong password is retried only once per request.
- Not here: approvals (B3), scheduled posts (B4), audit and branch rails (B5), DMs, files, slash commands.

## Testing

Hermetic: an in-memory Mattermost mock (`mock-server.ts`) and a fake daemon (`mock-daemon.ts`) with the real
`/auth/login` + `/api/rpc` shapes.

```bash
pnpm typecheck && pnpm test
```
