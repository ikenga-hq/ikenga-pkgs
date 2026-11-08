---
"@ikenga/skill-akuko": minor
---

akuko default board: the finished review page. A "script desk": the screenplay beside the shot list, every shot lined to the script line it came from, with Approve / Request changes / Add a note on each shot, an Approve on every bible item and document waiting for review, the spend gate with the budget meter ("left if you approve"), and the Bible and Ledger beside it. Light and dark, from 390 px phones to wide desktops, keyboard friendly. It reads the project live (the artifact database on claude.ai, `akuko.json` as a local file or in Ikenga) so it never has to be republished to show new state, previews decisions akuko has not folded in yet, and writes decisions only through the decision format, with undo. Ships as `default-board@0.1` on `views/conformed.json`; a test fails if the page and its recorded hash drift apart.
