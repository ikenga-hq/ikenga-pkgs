---
"@ikenga/skill-akuko": minor
---

akuko: files from a connected allowance tool (Canva) count as generated in the rules, and an explicit allow-list command.

- `ingest … --via <service>` (bible, key frames, motion; `ingest({ via })` in code) takes a file made with a connected tool on the person's plan. It is accepted only when the ledger holds a done allowance entry of that service for the unit, free for the job; the entry is linked to the job (new optional `ledger[].allowance.job`), the asset is recorded with the service as its provider, the tag `allowance:<service>`, and the file's sha256.
- `rules/refs.ts` counts such a file as generated (§3b) when that linked entry exists; without it the file stays external. For a `never_from_photo` entry it is trusted only if its job gave the tool no reference akuko did not generate (otherwise ingest tags it `refs:external` and the check refuses it there).
- `spend/cli.ts allowance --project <dir> --service <id> --units <unit[:n]>,… [--tool] [--job] [--failed]` records allowance generations from the command line (`recordAllowance()` now takes `job`).
- `rules/cli.ts allow --project <dir> --file <path> --label "…" [--for <entry> …]` hashes a file and appends it to `rules.uploads.allow`, refusing duplicates; run only on the person's explicit word (`actions/bible.md`, `actions/keyframes.md`).
- `rules/cli.ts adopt-allowance --project <dir> --service <id> [--apply]`: a one-time back-fill that brings files ingested by hand before `--via` over to generated, in generation order; a dry run unless `--apply`.
- Docs: `lib/providers.md` §Allowance tools, `lib/spend.md` §Allowance, `lib/state.md` ("Generated", precisely), `actions/bible.md` step 4 and Rules check, `actions/keyframes.md` Rules check.
