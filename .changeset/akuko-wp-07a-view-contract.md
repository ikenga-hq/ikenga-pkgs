---
"@ikenga/skill-akuko": minor
---

akuko view contract and decisions: any agent or tool can now render a review board for an akuko project. `views/contract.md` lists the views a board must offer, the fields each shows and the five renderer rules (only a person approves; money never hidden or rounded; a "your move" summary derived from data; decisions only through the decision format; readability and keyboard access). `views/decision.schema.json` is generated from the `Decision` schema. `scripts/check-view.mjs` checks a board against the contract. People's decisions are read from each host's store (claude.ai artifact database rows, `decisions.jsonl`, Ikenga bridge state mirrored to `decisions.jsonl`) and folded into `akuko.json`, with exact undo. Approvals count only from a person, through a checked view, and a spend approval is bound to the amount the person was shown.
