---
"@ikenga/pkg-mattermost": minor
---

Add a bridge-wide cap on Chi runs in flight: top-level `limits.maxConcurrentRuns` (integer 1 to 32, default 4), shared by every bot in the process. Thread runs, resumes, approved runs and scheduled runs each take a slot before `chi_run` / `chi_resume` and give it back when the bridge sees a terminal status, the call fails, the thread is stopped, the bridge gives up following the run, or the bridge stops. When full, requests queue first-in-first-out across bots; a queued thread's "Working…" post says it is queued (once) and `stop` leaves the queue. Runs still going after a restart (thread and schedule runs, for every bot) are counted against the cap before any bot starts, so a restart cannot start more on top of them. Queueing and starting-after-waiting are logged, and a run that waited has `queue_wait_s` in its audit record. A `chi_run` that answers without a run id now fails the start instead of being followed.
