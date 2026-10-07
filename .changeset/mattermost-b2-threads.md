---
"@ikenga/pkg-mattermost": minor
---

B2 sessions and threading: a bot configured with a `daemon` and a `chi` section runs each Mattermost thread as a Chi run on the Ikenga daemon (`chi_run` for a new thread, `chi_resume` for replies, `chi_cancel` for "stop"), keeps `root_id -> run_id` in a JSON store across restarts, and reports progress and the result back in the thread. Bots without those sections keep the B1 echo behaviour.
