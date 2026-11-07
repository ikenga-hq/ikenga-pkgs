---
"@ikenga/skill-akuko": minor
---

akuko providers + spend gate: one provider contract (`Provider`, `Job`, `Cost`, `JobHandle`) with a contract test suite every provider must pass, the no-key manual provider (emits a prompt package, ingests the returned file into `akuko.json`), the cost ledger, and the spend gate (no paid call without a recorded budget cap, a fresh estimate and an approved spend; no paid direct APIs on host A). Model ids and prices live only in `providers/config.json`, each with a `last_verified` date.
