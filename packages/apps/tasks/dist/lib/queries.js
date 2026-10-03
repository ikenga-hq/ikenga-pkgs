// Query layer — ported from src/lib/queries/tasks.ts. JSDoc carries the TS
// types. Schema verified against the local ikenga.db `tasks` table (shell
// migration 0025_tasks_domain.sql): every selected column exists.
//
// WP-04 read-swap: reads go through the host's `host.dbQuery` verb (local
// ikenga.db) instead of an in-iframe supabase-js client. Write-path WP: the
// status-update WRITE goes through `host.dbExec` (see `updateTaskStatus`), so
// this pkg no longer depends on supabase-js at all.

import { hostDbExec, hostDbQuery } from './bridge.js';
import { queryKeys } from './query-keys.js';

// ikenga.db stores former Postgres array/json columns as TEXT (the Pg→SQLite
// down-map, shell migration 0025). `tags` arrives as a string, not a JS array
// — normalize it back so the Task shape matches the JSDoc + the detail pane's
// `.map`/`.length` usage. JSON first (the canonical ETL encoding), then a
// comma split as a tolerant fallback, then [].
/** @param {any} row */
function normalizeTaskRow(row) {
  if (!row || typeof row !== 'object') return row;
  const t = row.tags;
  if (typeof t === 'string') {
    const s = t.trim();
    if (!s) {
      row.tags = null;
    } else {
      try {
        const parsed = JSON.parse(s);
        row.tags = Array.isArray(parsed) ? parsed : [String(parsed)];
      } catch {
        row.tags = s.split(',').map((x) => x.trim()).filter(Boolean);
      }
    }
  }
  return row;
}

/** @typedef {'pending'|'in_progress'|'completed'|'cancelled'|'blocked'} TaskStatus */
/** @typedef {'critical'|'high'|'medium'|'low'} TaskPriority */
/** @typedef {'human'|'agent'} AssigneeType */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string|null} description
 * @property {TaskStatus} status
 * @property {TaskPriority} priority
 * @property {string|null} assigned_to
 * @property {AssigneeType|null} assignee_type
 * @property {string|null} category
 * @property {string[]|null} tags
 * @property {string|null} due_date
 * @property {string|null} completed_at
 * @property {string} created_at
 * @property {string} updated_at
 * @property {number|null} progress_pct
 * @property {string|null} outcome_notes
 * @property {string|null} parent_task_id
 * @property {string|null} blocked_by_task_id
 * @property {string|null} source_email_id
 * @property {string|null} agent_source
 * @property {string|null} [created_by]
 * @property {string|null} initiative_id
 * @property {string|null} risk_id
 * @property {string|null} effort_estimate
 * @property {'autonomous'|'report'|'approval_required'|null} execution_mode
 * @property {string|null} task_result
 * @property {string|null} claude_session_id
 * @property {string|null} working_dir
 */

export const TASKS_LIST_COLUMNS =
  'id, title, description, status, priority, assigned_to, assignee_type, category, due_date, created_at, updated_at, progress_pct, outcome_notes, execution_mode';

/** @type {readonly TaskStatus[]} */
const ACTIVE_STATUSES = ['pending', 'in_progress', 'blocked'];
const STALE_DAYS = 7;

/**
 * @typedef {Object} TriageCounts
 * @property {number} overdue
 * @property {number} stale
 * @property {number} unassigned
 * @property {number} blocked
 * @property {number} needsAttention Deduplicated overdue-OR-unassigned badge total.
 */

/**
 * Server-side health counts for the Triage badge (R16-followup: server-side,
 * so the badge is correct independent of the list's filter + 200-row cap).
 * Four `head:true` count() selects, run in parallel (+ the deduped total).
 */
export function triageCountsQuery() {
  return {
    queryKey: queryKeys.tasks.triageCounts(),
    /** @returns {Promise<TriageCounts>} */
    queryFn: async () => {
      // "Overdue" = due before the start of today, matching the app's own
      // convention (groupTasks / dueLabel treat a task due *today* as "Today",
      // not overdue, until the day rolls over).
      const startOfTodayIso = (() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.toISOString();
      })();
      const staleIso = new Date(
        Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      // `?,?,?` placeholders for the active-status set, reused per count.
      const activePlaceholders = ACTIVE_STATUSES.map(() => '?').join(',');
      const countOne = async (where, params) => {
        const rows = await hostDbQuery(
          `SELECT count(*) AS n FROM tasks WHERE ${where}`,
          params,
        );
        return Number(rows[0]?.n ?? 0);
      };

      const [overdue, stale, unassigned, blocked, needsAttention] = await Promise.all([
        countOne(`status IN (${activePlaceholders}) AND due_date < ?`, [
          ...ACTIVE_STATUSES,
          startOfTodayIso,
        ]),
        countOne(`status IN (${activePlaceholders}) AND updated_at < ?`, [
          ...ACTIVE_STATUSES,
          staleIso,
        ]),
        countOne(`status IN (${activePlaceholders}) AND assigned_to IS NULL`, [
          ...ACTIVE_STATUSES,
        ]),
        countOne(`status = ?`, ['blocked']),
        // overdue OR unassigned, counted once (the deduplicated badge total).
        countOne(
          `status IN (${activePlaceholders}) AND (due_date < ? OR assigned_to IS NULL)`,
          [...ACTIVE_STATUSES, startOfTodayIso],
        ),
      ]);

      return {
        overdue,
        stale,
        unassigned,
        blocked,
        needsAttention,
      };
    },
  };
}

/**
 * How many task rows exist at all (any status). Zero means a true first run, as
 * opposed to a list that is merely empty because of a filter or because
 * everything is done. Lives under `tasks.all` so every write invalidates it.
 */
export function totalTasksQuery() {
  return {
    queryKey: queryKeys.tasks.total(),
    // While the table is empty, re-check every few seconds so tasks added from
    // outside this pane (an assistant creating one, say) replace the first-run
    // state without a reload. Stops as soon as there is a row.
    refetchInterval: (/** @type {{ state: { data?: number } }} */ query) =>
      query.state.data === 0 ? 5000 : false,
    /** @returns {Promise<number>} */
    queryFn: async () => {
      const rows = await hostDbQuery('SELECT count(*) AS n FROM tasks', []);
      return Number(rows[0]?.n ?? 0);
    },
  };
}

/** @param {string} id */
export function taskDetailQuery(id) {
  return {
    queryKey: queryKeys.tasks.detail(id),
    /** @returns {Promise<Task|null>} */
    queryFn: async () => {
      const rows = await hostDbQuery('SELECT * FROM tasks WHERE id = ? LIMIT 1', [id]);
      if (rows.length === 0) return null;
      return /** @type {Task} */ (normalizeTaskRow(rows[0]));
    },
  };
}

/** @param {string} parentId */
export function subtasksQuery(parentId) {
  return {
    queryKey: queryKeys.tasks.subtasks(parentId),
    /** @returns {Promise<Task[]>} */
    queryFn: async () => {
      const rows = await hostDbQuery(
        'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC',
        [parentId],
      );
      return /** @type {Task[]} */ (rows.map(normalizeTaskRow));
    },
  };
}

/** @param {string|null} blockingId */
export function blockingTaskQuery(blockingId) {
  return {
    queryKey: queryKeys.tasks.detail(blockingId ?? 'none'),
    /** @returns {Promise<Task|null>} */
    queryFn: async () => {
      if (!blockingId) return null;
      const rows = await hostDbQuery('SELECT * FROM tasks WHERE id = ? LIMIT 1', [
        blockingId,
      ]);
      if (rows.length === 0) return null;
      return /** @type {Task} */ (normalizeTaskRow(rows[0]));
    },
    enabled: !!blockingId,
  };
}

/**
 * Downstream dependents — the "Blocks" lane (D-1). Tasks that name THIS task as
 * their `blocked_by_task_id` are waiting on it. Mirrors the upstream
 * `blockingTaskQuery` but in the other direction. `blocked_by_task_id` is a
 * TEXT soft-link in migration 0025 (no FK), so this is a plain WHERE scan.
 *
 * @param {string|null} taskId the task whose dependents we want
 */
export function dependentTasksQuery(taskId) {
  return {
    queryKey: queryKeys.tasks.dependents(taskId ?? 'none'),
    /** @returns {Promise<Task[]>} */
    queryFn: async () => {
      if (!taskId) return [];
      const rows = await hostDbQuery(
        'SELECT id, title, status, priority FROM tasks WHERE blocked_by_task_id = ? ORDER BY created_at ASC LIMIT 25',
        [taskId],
      );
      return /** @type {Task[]} */ (rows.map(normalizeTaskRow));
    },
    enabled: !!taskId,
  };
}

/**
 * @typedef {Object} TaskEvent
 * @property {number} id
 * @property {string} task_id
 * @property {string} event_type  created | status_changed | completed | reopened | assigned | rescheduled | progress | checked
 * @property {string|null} from_value
 * @property {string|null} to_value
 * @property {string|null} actor
 * @property {string|null} detail
 * @property {string} created_at
 */

/**
 * Task activity/audit timeline (B.4). Reads the real `task_events` audit table
 * (shell migration 0048) — backfilled from existing columns and appended to by
 * the mutation helpers below. The detail pane still derives created/completed
 * from the task row as a fallback, so the timeline is never empty.
 *
 * @param {string} taskId
 */
export function taskEventsQuery(taskId) {
  return {
    queryKey: queryKeys.tasks.events(taskId),
    /** @returns {Promise<TaskEvent[]>} */
    queryFn: async () => {
      const rows = await hostDbQuery(
        `SELECT id, task_id, event_type, from_value, to_value, actor, detail, created_at
         FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
        [taskId],
      ).catch(() => []);
      return /** @type {TaskEvent[]} */ (rows);
    },
  };
}

/**
 * Append an audit event. Best-effort: the audit trail must never block the
 * primary mutation, so a failed write (e.g. table absent on an old DB) is
 * swallowed. This is the forward-capture path complementing the 0048 backfill.
 * `actor` is the operator's id, or null when the shell did not report one.
 *
 * @param {string} taskId
 * @param {string} eventType
 * @param {{ fromValue?: string|null, toValue?: string|null, actor?: string|null, detail?: string|null }} [meta]
 */
export async function logTaskEvent(taskId, eventType, meta = {}) {
  try {
    await hostDbExec(
      `INSERT INTO task_events (task_id, event_type, from_value, to_value, actor, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        eventType,
        meta.fromValue ?? null,
        meta.toValue ?? null,
        meta.actor ?? null,
        meta.detail ?? null,
        new Date().toISOString(),
      ],
    );
  } catch {
    /* audit is best-effort */
  }
}

/**
 * Reschedule a task's due date via `host.dbExec` (C.8). Pass `dueDate = null` to
 * clear the due date. `updated_at` is bumped so triage/staleness logic doesn't
 * treat a just-rescheduled task as stale, and the change is recorded in the
 * audit timeline.
 *
 * @param {string} taskId
 * @param {string|null} dueDate ISO timestamp / date, or null to clear
 * @param {string|null} [actor] the operator's id (null when unknown)
 * @returns {Promise<void>}
 */
export async function rescheduleTask(taskId, dueDate, actor = null) {
  let prev = null;
  try {
    const rows = await hostDbQuery('SELECT due_date FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    prev = rows[0]?.due_date ?? null;
  } catch {
    /* prior value is only for the audit trail */
  }
  await hostDbExec('UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?', [
    dueDate,
    new Date().toISOString(),
    taskId,
  ]);
  await logTaskEvent(taskId, 'rescheduled', { fromValue: prev, toValue: dueDate, actor });
}

/**
 * Write a task's status to the local ikenga.db via `host.dbExec` (write-path WP).
 * `completed_at` is set to now when moving to `completed` and cleared to NULL
 * otherwise, so a non-completed task never carries a stale completion stamp.
 * The host scopes this write to the pkg's declared `sqlite.tables` (`tasks`).
 *
 * @param {string} taskId
 * @param {TaskStatus} status
 * @param {string|null} [actor] the operator's id (null when unknown)
 * @returns {Promise<void>}
 */
export async function updateTaskStatus(taskId, status, actor = null) {
  let prev = null;
  try {
    const rows = await hostDbQuery('SELECT status FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    prev = rows[0]?.status ?? null;
  } catch {
    /* prior value is only for the audit trail */
  }
  const completedAt = status === 'completed' ? new Date().toISOString() : null;
  await hostDbExec('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?', [
    status,
    completedAt,
    taskId,
  ]);
  await logTaskEvent(taskId, status === 'completed' ? 'completed' : 'status_changed', {
    fromValue: prev,
    toValue: status,
    actor,
  });
}

/**
 * @typedef {Object} CreateTaskInput
 * @property {string} title                       required (NOT NULL in 0025)
 * @property {string|null} [assignedTo]           email (human) or agent id; null = unassigned
 * @property {'human'|'agent'|null} [assigneeType]
 * @property {TaskPriority} [priority]            defaults 'medium'
 * @property {string|null} [dueDate]              ISO timestamp or null
 * @property {string|null} [description]
 * @property {string|null} [category]
 * @property {string|null} [createdBy]            the operator's id; null/absent when the shell did not report one
 */

/**
 * Insert a new task into the local ikenga.db via `host.dbExec` (write-path WP).
 * Now that `host.dbExec` allows a real INSERT (the table is in the pkg's
 * declared `sqlite.tables`), creation no longer has to round-trip through the
 * agent. The id is a client-generated uuid; created_at/updated_at are stamped
 * now; status defaults to 'pending'. Only `id` + `title` are NOT NULL in
 * migration 0025 — every other column is nullable or DB-defaulted, so we write
 * just what the form collected and let SQLite default the rest.
 *
 * @param {CreateTaskInput} input
 * @returns {Promise<string>} the new task id
 */
export async function createTask(input) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await hostDbExec(
    'INSERT INTO tasks (id, title, description, status, priority, assigned_to, assignee_type, category, due_date, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.title,
      input.description ?? null,
      'pending',
      input.priority ?? 'medium',
      input.assignedTo ?? null,
      input.assigneeType ?? null,
      input.category ?? null,
      input.dueDate ?? null,
      now,
      now,
      input.createdBy ?? null,
    ],
  );
  return id;
}

/**
 * Reassign a task to a different human/agent via `host.dbExec`. `assigned_to`
 * was display-only across every view until now; this is the first write of it.
 * `updated_at` is bumped so the staleness/triage logic (which keys off it)
 * doesn't treat a just-reassigned task as stale. Pass `assignedTo = null` to
 * clear the owner (unassign).
 *
 * @param {string} taskId
 * @param {string|null} assignedTo
 * @param {'human'|'agent'|null} assigneeType
 * @param {string|null} [actor] the operator's id (null when unknown)
 * @returns {Promise<void>}
 */
export async function reassignTask(taskId, assignedTo, assigneeType, actor = null) {
  await hostDbExec(
    'UPDATE tasks SET assigned_to = ?, assignee_type = ?, updated_at = ? WHERE id = ?',
    [assignedTo, assigneeType, new Date().toISOString(), taskId],
  );
  await logTaskEvent(taskId, 'assigned', { toValue: assignedTo ?? 'unassigned', actor });
}
