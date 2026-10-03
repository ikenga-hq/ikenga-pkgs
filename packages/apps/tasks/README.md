# Tasks

Ikenga pkg: a task workspace for your own work. Five views over one local
`tasks` table: **Tasks** (the list), **Agenda** (today on a time rail),
**Triage** (backlog health), **Sweeper** (close proposals) and **Done**.
A multi-file iframe pkg with **no build step for the app itself**. React 19 +
htm + TanStack Query, loaded from esm.sh.

| | |
|---|---|
| Pkg id | `com.ikenga.tasks` |
| Kind | `embedded` (UI iframe) |
| Surface | `/pkg/com.ikenga.tasks/` |
| Data | SQLite: the shell's local `ikenga.db` (capability `sqlite`, db `ikenga.local`). Tables `tasks`, `task_events`, `task_signals`. No Supabase, no account |
| Build | none for the app: `dist/` is served as is. `pnpm build` only re-vendors shared files into `dist/lib/` |
| License | Apache-2.0 |

## Where your tasks live

Everything is read from and written to the local database through the shell's
`host.dbQuery` and `host.dbExec`. Nothing is sent to a server. The shell
creates the three tables empty on first run, so a fresh install starts with
**No tasks yet** and a **New task** button.

The interface libraries (React, htm, TanStack Query) load from
[esm.sh](https://esm.sh) when the pane opens, so the pane needs an internet
connection to start. Your tasks never go there.

## Creating tasks

**New task** (or `Ctrl`/`Cmd` + `Shift` + `T`) opens an inline form: a title
(required), owner, priority (default medium), due date and an optional
description. Saving inserts one row into `tasks` with status `pending`. This
works on its own: no AI engine is involved.

| Field | Stored as |
|---|---|
| `created_by`, and the actor in the activity timeline | the operator the shell reports (the name from onboarding, else your OS username). If the shell reports none, it is stored empty and the timeline reads "You" |
| `assigned_to`, `assignee_type` | the picked owner and whether it is a person or an agent; empty for Unassigned |

## Who "Me" is, and who the agents are

- **Me** is the operator the shell passes in `hostContext.operator`. It is
  optional: with no operator there is no "Me" option or "By owner: Me" row,
  and nothing is ever stored under a made-up identity.
- **Agents**: there is no built-in list. Agents appear in the owner pickers
  only when the shell delivers a roster (`hostContext.royaltiSuite.tasksRoster`,
  read from an optional `.atelier/skill-tasks/roster.json` in the project
  folder). With no roster file you can assign to yourself or leave a task
  unassigned. The "By owner: Agents" filter shows tasks whose `assignee_type`
  is `agent`, whoever wrote them.

## What needs an AI engine, and what does not

Works with no engine at all:

- Creating tasks, editing status, rescheduling, reassigning, marking complete
- The Tasks list and its filters, Agenda, Triage and Done
- The activity timeline (each change is logged to `task_events`)

Needs an AI engine (an active chat session in the shell):

- **Send to your Chi**: hands a "create a task" request to the active
  session, which asks you for the details and adds the row. It is disabled
  when no shell is hosting the pane.
- **Sweeper**: the pane only reads proposals (`task_signals` and the
  `outcome_notes` marker on a task). Nothing in this pkg writes them, so the
  view stays empty until an assistant that reviews your tasks does.

An assistant can also add or update rows in `tasks` directly; the pane shows
them on its next refresh (every few seconds while the table is empty).

## Empty states

- The table has no rows at all: every view shows **No tasks yet** with a
  **New task** button.
- Rows exist, but a filter matches none: **No tasks match.**
- Rows exist and none are open: **Nothing open right now.**
- **Done** and **Sweeper** also explain their own empty case once there are
  tasks.

## Layout

```
tasks/
├── manifest.json             # sqlite capability; tables: tasks, task_events, task_signals
├── package.json
├── README.md
├── scripts/build.mjs         # vendors tokens CSS + shared runtime, generates tasks-css.js
├── tsconfig.dev.json         # dev-only checkJs, never in the publish path
└── dist/                     # kernel convention: iframe sources live here
    ├── index.html            # mount point; imports app.js as an ES module
    ├── app.js                # bridge + QueryClient, passes the operator id down, mounts <TasksView/>
    ├── tasks.css             # domain styles; the source of lib/tasks-css.js
    ├── lib/
    │   ├── bridge.js · pkg-id.js · ui.js · operator.js   # vendored shared runtime (generated)
    │   ├── tokens-css.js · app-kit-css.js · tasks-css.js # CSS as JS strings (generated)
    │   ├── assignees.js      # "Me", the optional roster, timeline actor labels
    │   ├── queries.js        # list/detail/triage/total queries + create/update/reassign writes
    │   ├── query-keys.js     # TanStack cache keys
    │   ├── shared.js         # grouping, agenda and triage helpers, label helpers
    │   └── esm-sh.d.ts       # dev-only ambient decls for the esm.sh URL imports
    └── features/tasks/
        ├── tasks-view.js     # list + filters + master/detail split + view switching
        ├── task-row.js · task-detail-pane.js · create-task-form.js · empty-state.js
        └── agenda-view.js · triage-view.js · sweeper-view.js · done-view.js
```

> **Why `dist/`?** The shell's pkg-content server only serves files under
> `<install_path>/dist/` for iframe routes. For a no-build pkg, your "build
> output" *is* your source: keep editing in `dist/` directly. The files marked
> generated above are overwritten by `pnpm --filter @ikenga/pkg-tasks build`
> and CI fails if a committed copy drifts from a fresh build.

## Views and the side menu

The five views and the list filters (All, Today, Overdue, This week,
Auto-closed, by category, by owner) live in the shell's side menu while the
pane is focused. The chosen view is remembered per viewer in `localStorage`
(`ikenga-tasks-view`).

## Fork in one step

```bash
cp -r ikenga-pkgs/packages/apps/tasks ~/my-tasks
# edit ~/my-tasks/manifest.json (change id), and any dist/features/*
ikenga add ~/my-tasks
```

No install and no bundler: forks are file edits plus a reload. (`pnpm build`
and `tsc -p tsconfig.dev.json` are optional dev-time steps, never part of
what installs.)

## CSP

`manifest.json` declares `ui.csp` overrides allowing `https://esm.sh` for
scripts, styles, fonts and connections (the interface libraries). There is no
other network access.
