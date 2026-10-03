---
'@ikenga/pkg-tasks': minor
---

Tasks now starts honestly on a fresh install.

- "Me" is the person Ikenga reports as the current user, instead of a built-in
  address. New tasks and activity entries are recorded under that name; if
  Ikenga reports none, they are stored with no name and shown as "You".
- No agents are listed by default. Agents appear in the owner pickers only when
  a roster is provided.
- A true empty state: with no tasks at all, every view says "No tasks yet" and
  offers a New task button. "No tasks match." now appears only when a filter
  matches nothing, and "Nothing open right now." when every task is done.
- The Sweeper explains that proposals come from an assistant; this app does not
  run one.
- Tasks no longer declares a dependency on the unpublished `skill-tasks`
  package, so installing it never reports an unmet requirement.
- The README now describes where tasks are stored (a local SQLite database, no
  account or Supabase), how creating a task works, and which actions need an AI
  engine.
