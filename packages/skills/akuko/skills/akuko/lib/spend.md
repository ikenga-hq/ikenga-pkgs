# Spend: the budget, the gate, the ledger

akuko never spends money a person has not agreed to. This file is the rule
book. The code that enforces it is `spend/gate.ts` and `spend/ledger.ts`; on
host A, where no code runs, you enforce it by following this file to the
letter.

## The three money fields in `akuko.json`

| Field | What it is | Who writes it |
|---|---|---|
| `budget` | `{ cap, currency, spent }`, or `null` | `setup` records the cap. `spent` is recomputed from the ledger, never typed in. |
| `pending_spend[]` | One entry per paid job waiting at the gate: estimate, units, provider, `status` | The gate creates it (`awaiting-approval`); folding a person's `approve-spend` / `decline-spend` decision sets `approved` / `declined`. |
| `ledger[]` | One entry per unit per paid provider call | The gate opens it; `collect()` settles it. |

**There is no default cap.** `budget` is `null` until `/akuko setup` records
one, and while it is `null` every paid job is refused with:

> No budget cap is recorded for this project. Run `/akuko setup` to set one — no paid generation runs until it does.

Free work (the manual provider) never needs a budget.

## What "paid" means

Each provider's `billing` comes from `providers/config.json`, never from the
provider's own code:

- **free**: costs akuko nothing. The manual provider is the only one.
- **direct-api**: akuko calls a paid HTTP API with the person's key.
- **connected-mcp**: a paid generation tool on an MCP server the person has
  connected (e.g. on claude.ai).

`direct-api` and `connected-mcp` are both paid and go through every check below.

A connected tool that bills the person's **plan allowance** rather than money
(Canva's monthly AI limit) is neither free nor priced: it goes through the
allowance gate (§Allowance), which asks for an OK of every wave the same way.

## The gate, in order

`gate.run(job)` is the only code that calls a provider's `submit()`. Every
provider is sealed (`sealProvider()`), so calling `submit()` directly throws
`SpendGateBypassError`. A test scans every non-test source file, fixtures
included, for any way of reaching `submit`: a call, `.call` / `.apply` /
`.bind`, destructuring, `['submit']`, `Reflect.get`. Only an allow-listed
set of lines may touch it.

Only `providers/manual` may seal a provider with the id `manual`, using a
key it alone imports. Config must mark `manual` as free, and no other id may
be free. This stops a paid implementation from borrowing the manual
provider's free billing and running with no budget.

The gate first takes a **deep-frozen copy of the job**. It estimates, checks
and submits that copy only, so changing the caller's object afterwards
changes nothing. Then, for each job, it:

1. Checks the job is well formed, the provider is registered, makes this
   kind, and runs on this host level.
2. **Host A, R-11:** refuses any `direct-api` provider. In v0.x host A uses
   only the manual provider and connected MCPs.
3. **Always calls `provider.estimate(job)`.** Estimates come from config
   prices and never call a paid endpoint.
4. For paid jobs only:
   1. `budget` must be set, in the estimate's currency. If not: refuse and point to setup.
   2. A `pending_spend` entry with the job's id must exist. If it doesn't, the
      gate writes one (`awaiting-approval`), returns the confirmation line and
      stops.
   3. The entry must be `approved`, for the same provider, stage and units.
      `declined` or `awaiting-approval` means stop.
   4. No earlier attempt of the job may still be `submitted` or `done`.
      Failed attempts can be retried.
   5. The fresh estimate must be no more than the approved bound
      (`approved_max` if set, else the approved `estimate`). If it is more,
      the approval no longer covers the job; `quote()` sends it back to
      `awaiting-approval` at the new estimate.
   6. The fresh estimate must fit in **cap − committed**, where committed =
      spent + sunk + reserved. Sunk is the `actual` cost of failed or
      cancelled calls. Reserved is the sum of estimates still `submitted`.
   7. The gate opens one `submitted` ledger entry per unit (the reservation)
      and writes state **before** calling the provider.
5. Mints a one-shot ticket from the same frozen copy and calls `submit()`.
   If `submit()` throws, the reservation is settled `failed`.

Steps 1–4, from the read of state through the check to the reservation
write, run under a lock held by the gate instance. Concurrent `run()` /
`quote()` / `collect()` calls on one gate are serialised, so two runs of one
job submit once, and two jobs cannot overrun the cap together. The lock is
not held during `submit()`, because the reservation is already written by
then.

**Other processes and other gates on the same project** are covered by the
host, not the lock. On B and C, `writeState` takes `akuko.json.lock` and
writes only if the file's bytes are still the ones that host last read or
wrote; otherwise it writes nothing and throws `StateConflictError`
(`hosts/conflict.ts`). Each step the gate runs under its lock reads state
first and writes once, at the end, so on a conflict the gate runs that step
again from a fresh read. The other process's reservation is then counted:
two jobs that together overrun the cap end as one run and one `over-cap`
refusal, and the same job started twice runs once (`already-submitted`).
Any other writer of `akuko.json` (the manual provider's `ingest()`, an
action's own write) gets the same error instead of overwriting a change it
never saw; the step is simply run again.

The lock file holds its owner's pid and a random nonce and is removed only
by that owner. A lock older than 30 s was left by a process that died; it is
taken over under a second lock (`akuko.json.lock.takeover`), and only if it
is still the same stale file, so several processes meeting one stale lock
still enter one at a time (`hosts/state-race.test.ts`: three processes on a
stale lock, many trials, no overrun, no lost entry). What is not covered:

- **One host instance per gate.** What `writeState` compares against is
  the last read *by that host instance*. Two gates sharing one
  `LocalHost`, or another caller interleaving its own read-modify-write on
  the gate's host, defeat the check. No shipped caller does either: each CLI
  run makes one host and one gate.
- A writer that holds the lock longer than 30 s can have it taken over; it
  checks just before writing and then refuses (`StateConflictError`), but a
  write already under way is not stopped. A crash during the brief takeover
  step itself leaves `.takeover` behind for 30 s.
- `akuko.json` must be UTF-8. A file saved in another encoding is refused
  on read with a clear error (re-save it as UTF-8), never read lossily.

`gate.collect(handle)` polls. When the job finishes it records the outputs
(see below) and settles the job's ledger entries. It only touches
entries that are still `submitted` and whose `job` and `provider` match the
handle, so a stale or forged handle cannot release another job's
reservation. A done entry takes the
provider's reported actual cost; if the provider reports none, it settles at
the estimate, which is the honest figure to plan against.

### Approving (for decision folding)

> `canApprove()` is not part of the G-ADAPTER freeze; WP-07a owns it
> (decision folding, `decisions/fold.ts`).

An `approve-spend` decision folds to `status: 'approved'` only when
`canApprove(project, jobId, decision)` returns `null`. That means:

- a budget exists;
- the decision's `text` is the gate's own reply words, `approve <amount>
  <CURRENCY>` (first word any case), in the budget currency;
- that amount is at least the job's bound (`approved_max`, else `estimate`)
  **as printed** by `money()`, so the exact words the confirmation line asks
  for always pass;
- the bound fits in cap − committed.

This binds every approval to the amount the person was shown. `quote()`
rewrites an awaiting entry's estimate in place, so a stale approval for a
lower amount is refused with `approval-mismatch` and the person approves the
new amount. The `Decision` schema is unchanged: the amount travels in `text`
(views/contract.md §7).

Approvals come from people only. Folding rejects agent-authored approvals and
approvals from views that are not on the conformed-views list (R-12). A chat
reply counts only in those exact words (`view: "chat@1"`, lib/state.md
§Decision folding).

## The ledger rule

The schema doc calls the ledger "append-only". The real rule is narrower:

- **One entry per unit per provider call.** Its `id` is
  `<job>.<unit>.<attempt>`, e.g. `job_kf_sc1.sc1_sh2.1`.
- An entry is opened as `submitted` (carrying `estimate`) and is **updated in
  place, matched by `id`**, to `done` (with `actual`), `failed` or
  `cancelled`. It is not appended twice: the integrity check rejects
  repeated ids.
- Entries are never deleted, and ids are never reused. A retry opens new
  entries with the next attempt number.
- `budget.spent` always equals the sum of `actual` over `done` entries,
  which is how the WP-01 schema and integrity check define it. Every ledger
  change recomputes it, summed in whole micro-units so it is stored as 0.88,
  not 0.8799999999999999.
- A `failed` or `cancelled` entry can still carry a real `actual`: a call
  that cost money and produced nothing. That money is **sunk**. It is not in
  `budget.spent`, but it counts against the cap exactly like spent money
  (`committedFromLedger()`, `remainingBudget()`), and the board shows it.
- If a person reports what a manual job cost them (credits on a tool they
  ran themselves), that amount is recorded as one `done` entry with no `job`.
  This needs a budget. Without one, the amount is not recorded and the person
  is pointed to setup.

The board shows `ledgerSummary(project)`: cap, spent, sunk, reserved,
remaining (cap − spent − sunk − reserved), and the entries, newest first.

## Outputs

Every output, paid or manual, lands the same way (`providers/outputs.ts`):

- the file goes through `host.storeAsset()` (bytes never go into `akuko.json`);
- the asset is added to `assets[]` (or updated, if the host already added it),
  tagged `job:<id>`;
- the unit moves to the job's stage as **`pending-review`**, with the file as
  that stage's output.

Nothing akuko produces is ever `approved`. Recording the same file twice
changes nothing, so a second `collect()` never undoes a person's approval.

## Allowance: connected tools billed against the person's plan (B-10)

Some connected tools cost no money per call but use up the person's own plan
allowance: **Canva** on claude.ai (`generate-image`, video) draws on the
person's monthly Canva AI limit. akuko cannot price that and cannot see how
much of it is left, but it is still the person's to spend: on 2026-11-11 one
run made 21 Canva images with no warning and used up a whole month's
allowance. So allowance generations get their own gate, the same shape as the
money gate. Code: `spend/allowance.ts` (the line, the exact reply, the cap, the
ledger record); on host A you follow it by hand.

1. **Before each wave** (one job: one shot by default, or the scene or units the
   person named), post the allowance line and **wait for the person's reply**:

   > Allowance check — Key frames for scene 1: 3 generations with Canva (generate-image). They use your Canva plan's AI allowance, not money; akuko can't see how much of it is left. Used through akuko in this project: 21. Reply "approve 3 canva generations" to run it; anything else stops it.

   Count every generation the wave will make: one per image, and every retry
   you plan (a "try again" is a new wave and a new line). The tally is what the
   ledger records for that service in this project, never a guess at the
   service's own balance.
2. **Run the wave only on that exact reply** (`approve <n> <service>
   generations`, first word any case) or a plain yes to this line. Silence, a
   change of subject, or "go on" in reply to something else is not a yes. One
   reply covers one wave; more generations, a new wave or a retry need a new
   line. Never batch several waves under one OK.
3. **The service's own confirmations stay.** When the tool itself asks (Canva's
   "this may use your monthly AI limit" before a video), pass it to the person
   and let them answer it; never answer it for them.
4. **Record every generation** in the ledger, success or failure: one entry per
   unit, `provider` = the service id (`canva`), `model` = the tool, `estimate`
   and `actual` **0**, and `allowance: { service, units }` with how many
   generations it used (`recordAllowance()`). A call that the service charged
   but that made nothing is `failed` with the units it used; a call it refused
   without charging is not recorded. Allowance entries need no money budget
   (integrity allows them with `budget: null`) and never change `budget.spent`.
5. **A cap, if the person wants one.** `budget.allowance_caps` holds the most
   generations they allow per service in this project (`{"canva": 20}`; set it
   on their words). A wave that would pass it is not run: say how many are used
   and stop. With no cap the per-wave OK is the only limit, and the line shows
   the running total.
6. **Running out.** If the service says the allowance is used up, stop, tell the
   person, and offer the manual prompt package instead. Do not switch to a paid
   provider or another account on your own.

This is not the money gate: no `pending_spend` entry is written, no `approve
<amount> <CURRENCY>` is asked for, and the money rules (no cap, no spend) do not
apply. But "nothing runs without an explicit OK" applies exactly as for money.

## Host A: the gate is prompt-only (R-11)

On claude.ai there is no code execution, so `gate.ts` cannot run. You are the
gate. In v0.x:

1. **Never call a paid direct API on host A.** Use the manual provider, or a
   connected MCP.
2. **Before any generation call on a connected MCP that costs money**, check, in this order (a connected tool that uses the person's plan allowance instead, such as Canva, goes through §Allowance: its own line, an OK of every wave, and a ledger entry with zero money and a units count):
   - `budget` is set. If it isn't, stop and point to `/akuko setup`.
   - The estimate (from `providers/config.json` prices) fits in cap − spent.
   - Then post the confirmation line and **wait for the person's reply**.
     The line has the same wording as `confirmationLine()`:

     > Spend check — Key frames for scene 1: canva (model), 3 units, estimate 0.36 USD. Budget 15 USD: spent 0.84, in flight 0, left after this 13.8. Reply "approve 0.36 USD" to run it; anything else stops it.

   - Run the call only on an explicit yes that names the amount (or plainly
     approves this spend). Silence, a change of subject, or "go on" in reply
     to something else is not a yes.
3. After the call, record it in the ledger as one `done` entry per unit (or
   `failed`), and recompute `budget.spent`.
4. One confirmation covers one job. A new job, or a higher estimate, needs a
   new line.
