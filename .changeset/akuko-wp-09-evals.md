---
"@ikenga/skill-akuko": minor
---

akuko Phase 1 verification: the short-story fixture now runs end to end in a test (intake, breakdown, sketch board, bibles, key frames) through each stage's command line, once with the manual provider and once with a paid provider on a mocked network. It checks that every paid call is preceded by a spend line with an estimate, that nothing is sent before the person's approval is folded, that the ledger matches, and that a second breakdown run creates nothing. Adds `EVIDENCE.md` (generated from those runs), a manual-check script for the live parts, and an eval runner (`evals/run-evals.mjs`) that scores skill triggering and stage routing through a command you supply.
