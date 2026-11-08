---
"@ikenga/skill-akuko": patch
---

Fixes from a second-opinion review. Two akuko runs on one project folder can no longer overrun the budget cap or lose each other's spend records: the project file is written only if nobody changed it in between, and the spend check is redone from the current file. A spend approval refused because the cap was too low now says to approve again once the cap is raised. The view checker also tries key presses by key code, wheel turns and right clicks. On Windows, saving retries briefly while another program has the file open, device names like `con.png` and trailing dots are made safe, and every file checks out with LF line endings so akuko's own board still matches its recorded check.
