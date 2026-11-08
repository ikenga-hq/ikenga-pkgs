---
"@ikenga/skill-akuko": patch
---

The review-board project data block now fails check-view (`bad-project-block`) if it holds any raw `<`, which closes a hole where a page could hide the block in a `<textarea>` and swap in different code after it was checked. Publishers already write `<` as `\u003c`; check-view now uses one shared helper for that. Also fixes two doc slips (the escape in the view contract, and sketch panels being `.svg` in the project-folder layout). No recorded conformance hash changes.
