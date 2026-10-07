# com.ikenga.mattermost

Mattermost bridge sidecar for Ikenga. It replaces the Rex/Ruby Mattermost bots of `royalti-agents`: each
Mattermost thread is a **Chi run** on an `ikenga-server` daemon, under the bot's own Ikenga account.

- **B1** (still the fallback): read-only echo bridge. A bot with no `daemon` + `chi` config echoes.
- **B2**: sessions + threading. New thread starts a run, replies resume it, "stop" cancels it.
- **B3** (this): approvals. Optional per bot: plan first, an approver's reaction decides whether it is carried out.
- B4 scheduled posts, B5 rails/audit are not here yet. The bridge has no tool beyond the Chi run.

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

## Approvals (B3)

**What the daemon offers.** Nothing per action. A Chi run is a headless `claude --print` with its stdin closed right after
the prompt (`chi_exec.rs` `write_prompt`), so Claude Code's permission prompt has nobody to answer it: a tool that needs
permission fails closed with `Tool permission request failed: AbortError: Stream closed` (observed against claude 2.1.293,
mode `default`). I found no producer that records a permission row (`notifications_list` kind `permission`) for a Chi run, and
`permission_decide` only resolves desktop asks (`permission:hook|acp|relay:`); on a T1 child it is wired to `NoResolvers`
("no daemon engine raises asks yet"). `chi_run`'s `mode` maps to `--permission-mode`: `plan`, `default` (also what an unknown
or absent mode becomes), `auto` = `acceptEdits`, `bypassPermissions`. A resume reuses the mode stored on the run row, so a run
cannot change mode. Source references are at the end of this section.

So "Rex wants to run X, react to allow" cannot be built on today's daemon. What this does instead is a **two-phase flow**:

1. With an `approvals` block, every thread turn runs in `plan` mode (read-only, enforced by Claude Code via the daemon). The
   bridge appends a note telling the model to answer or give its plan as the final message and not to call `ExitPlanMode`.
2. When the turn finishes, the result is posted as before, then a second post asks the approvers:
   `Approval needed: rex proposes the plan above ... React 👍 ... or 👎`.
3. A 👍 from an approver edits that post to "Approved by @x" and starts a **new** `chi_run` in `approvals.actingMode`, parented
   to the plan run. Its prompt is the approved plan text exactly as posted (a fresh run has no memory; the bridge does not rely on
   session continuity). Progress and result are posted in the thread like any run.
4. A 👎 edits the post to "Denied by @x". No decision within `timeoutMs` edits it to "Expired" and counts as a denial.

The thread stays mapped to the **plan** run, never to the acting run. A later reply therefore resumes the read-only run, gets
planned again and needs a new approval; an approved run's write access is never inherited by a follow-up message. The approved
run's report is handed to that next plan turn (it cannot remember it). A thread whose stored run was not started in plan mode (a
B2 thread from before approvals were switched on) is not resumed; a fresh plan run starts and says so.

Rules (each has a test in `src/approvals.test.ts`):

- **Approvers** are `approvals.approvers`: usernames, `@usernames` or user ids. Required and non-empty (the bot refuses to load
  otherwise). Separate from `allowedUsers`: being allowed to talk to the bot does not let you approve, and an approver need not be
  allowed to talk to it. The reactor's username comes from `GET /users/{id}`, never from the event; a failed lookup is "not an approver".
- Only 👍 / 👎 (`+1`, `thumbsup`, `-1`, `thumbsdown`, any skin tone) on a **pending approval post** count. Reactions by the bot
  itself, by non-approvers, other emoji, and reactions on any other post are ignored silently.
- **First decision wins.** The pending record is taken synchronously before anything else happens, so a second reaction (or
  the timer) finds nothing. A reaction on an expired, decided, withdrawn or unknown approval does nothing (the post already says
  what happened).
- **Timeout = deny**, `approvals.timeoutMs` (default 15 minutes, max 7 days). The clock is checked on every reaction, not only by
  the timer.
- A **new message** in the thread, or `stop`, **withdraws** a pending plan ("Withdrawn").
- **Persistence.** Pending approvals live in `<dataDir>/approvals-<bot>.json` (mode 0600, temp file + rename). Each holds request
  id, plan run id, thread, channel, approval post id, the plan text, created and expiry time. After a restart the bridge re-arms
  each clock with the **remaining** time, expires the ones that ran out while it was down, and applies a decision made while it was
  down (reactions on the post are fetched; the earliest approver reaction wins, as it would have live). An approval that expired
  during downtime stays expired even if an approver reacted before the deadline.
- `approvals.actingMode` is `auto` (default; Claude Code `acceptEdits`) or `bypassPermissions`. `plan` and `default` are
  refused, and so is `chi.mode` when approvals are on (it would be ignored).

What is enforced where:

| Rule | Enforced by |
|---|---|
| Plan turns cannot write | the daemon / Claude Code (`--permission-mode plan`); verified: no tool ran, no plan file written, final text is the plan |
| What the approved run may do | the daemon / Claude Code, by `actingMode`. In `auto`, edits and simple filesystem commands (`touch`) ran; `python3 -c ...` failed closed |
| Who may approve, first decision, timeout, withdrawal, restart | the bridge only; the daemon does not know an approval exists |
| That the approved run does what the plan said | **nobody.** The run gets the plan as text and a mode; it can do anything the mode allows, including things the plan did not list |
| The approver's identity in the daemon's audit | **not recorded.** The daemon sees the bot's account starting a run; the approver appears only in the Mattermost post |

Daemon source (shell `origin/main` 60c720e9, `src-tauri/src/`): `server/shared/chi_exec.rs` 962-990 (argv, `--permission-mode`,
`--permission-prompt-tool stdio`), 1192-1225 and 1314-1322 (prompt written, stdin closed), 1389-1397 (control request only sets
`awaiting_auth`), 1972-2040 (`resume_run` uses the row's mode); `server/shared/acp_mode.rs` 45-58; `server/rpc_local.rs`
404-448 (`chi_run` options); `server/shared/notifications/routing.rs` 20-24, 559-600, 672-684.

Known limits of this approach:

- **Every plan-phase turn that finishes gets an approval request**, including a plain answer. The bridge cannot tell an answer from
  a plan that needs approval (`chi_status` does not expose Claude's `permission_denials`). A Q&A thread therefore also gets an
  approval post that expires as a denial; leave `approvals` off for a bot that only answers.
- The old Rex gate escalated only **risky commands** (`approval-handler.ts`: `sudo`, destructive SQL, ...) and auto-allowed the rest.
  That per-command classification is not reproducible; here the whole plan is the unit of approval.
- The acting run starts with only the plan text, not the planning run's context.
- A plan longer than the daemon's 100 KB output limit is not offered for approval.
- Reactions made while the WebSocket is down but the bridge is up are not seen until the next restart (the client does not reconnect).

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
      "approvals": { "approvers": ["alice"], "timeoutMs": 900000, "actingMode": "auto" },
      "progress": { "pollMinMs": 1000, "pollMaxMs": 10000, "editIntervalMs": 5000 }
    },
    "ruby": { "...": "own entry, own credentials" }
  }
}
```

- `daemon.auth.kind: "session"` is **T1** (production): `POST /auth/login`, `ikenga_session` cookie, one re-login on a 401.
  `"bearer"` is **T0** (local testing): `Authorization: Bearer`. Under T1 the daemon refuses bearer tokens.
- `approvals` is optional. Without it the bot behaves as in B2 (`chi.mode`, no gate). With it, see "Approvals (B3)".
  Do not set `chi.mode` together with it.
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
- Not here: scheduled posts (B4), audit and branch rails (B5), DMs, files, slash commands.

## Testing

Hermetic: an in-memory Mattermost mock (`mock-server.ts`) and a fake daemon (`mock-daemon.ts`) with the real
`/auth/login` + `/api/rpc` shapes.

```bash
pnpm typecheck && pnpm test
```
