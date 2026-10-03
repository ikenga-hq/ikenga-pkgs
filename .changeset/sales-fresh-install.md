---
'@ikenga/pkg-sales': minor
---

Sales now starts honestly on a fresh install.

- No more invented deals. An empty pipeline shows "No deals yet" and a failed
  load shows an error with a Retry, instead of a made-up pipeline. Deals no
  longer pick up invented next actions or win probabilities.
- A New deal form adds a deal directly to your database. Only the company is
  required; stage, title, value and expected close date are optional. It needs
  no AI engine.
- "Ask the companion to add it" is still there as a second option. When no chat
  session is open, or no engine is available, the pane now says so instead of
  failing silently. "Approve & run" does the same.
- The Forecast is worked out from your own deals. Expected close by month comes
  from each deal's expected close date (weighted by win probability where one is
  set), and asks you to add dates when none are set. The fixed quarter target,
  the fixed months and the fixed average cycle and win rate are gone; win rate is
  now won deals out of won plus lost.
- An opt-in "Load sample pipeline" adds a small, clearly labelled set of made-up
  deals, with "Remove sample data" to take them all out again. Nothing is loaded
  unless you ask.
- Sales no longer declares a dependency on the unpublished `skill-sales`
  package, so installing it never reports an unmet requirement.
- The README now describes where deals are stored (a local SQLite database, no
  account), how adding a deal works, how the forecast is calculated, and which
  actions need an AI engine.
