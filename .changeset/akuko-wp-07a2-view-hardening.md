---
"@ikenga/skill-akuko": minor
---

akuko: harden the view conformance check (G-VIEW). check-view now clicks the way a browser does (pointer and mouse down/up before the click), sets every value of unmarked dropdowns, checkboxes, radios and ranges, double-clicks, fires the page-leaving events, and runs animation frames and the page clock on its fake timer, so pages that approve on those all fail. Hidden-money checks resolve CSS custom properties and catch more ways of hiding text. The decision writer is now v2: it no longer posts an empty list on load, which overwrote decisions in Ikenga after a pane remount, and pages must inline the current writer (`stale-writer`). Every host's `publishView` now refuses a decision-writing view whose exact HTML is not on a conformed list; read-only views publish freely, and check-view reports them SKIP.
