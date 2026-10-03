// Task detail pane — ported from routes/tasks/_components/-task-detail-pane.tsx.

import {
  html,
  cn,
  Icon,
  Button,
  useState,
  useQuery,
  useMutation,
  useQueryClient,
} from '../../lib/ui.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  blockingTaskQuery,
  dependentTasksQuery,
  reassignTask,
  rescheduleTask,
  subtasksQuery,
  taskDetailQuery,
  taskEventsQuery,
  updateTaskStatus,
} from '../../lib/queries.js';
import { actorLabel, assigneeOptions, isAgentActor } from '../../lib/assignees.js';
import { getContext } from '../../lib/bridge.js';
import {
  assigneeIsAgent,
  autoCloseSignal,
  avatarInitial,
  dueLabel,
  isAutoClosed,
  priorityClass,
  relativeAgo,
  shortId,
  statusClass,
} from '../../lib/shared.js';

/** @typedef {import('../../lib/queries.js').Task} Task */
/** @typedef {import('../../lib/queries.js').TaskStatus} TaskStatus */
/** @typedef {import('../../lib/queries.js').TaskEvent} TaskEvent */

/** @type {TaskStatus[]} */
const STATUS_OPTIONS = ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'];

// ─── Activity timeline (B.4) ────────────────────────────────────────────────
// Renders the real task_events audit table (migration 0048), with a defensive
// fallback that derives created/completed from the task row so the timeline is
// never empty for a row that predates the table.

/** @param {string|null|undefined} iso */
function tlWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Event types this app writes on the operator's behalf. An entry of one of these
// types with no actor is the operator's own, recorded while no operator was known.
const USER_EVENT_TYPES = new Set(['created', 'status_changed', 'completed', 'rescheduled', 'assigned']);

/** @param {string|null|undefined} iso */
function tlDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}

/**
 * Merge real task_events with task-row fallbacks, sorted oldest→newest.
 * @param {TaskEvent[]|undefined} events
 * @param {Task} task
 */
function buildTimeline(events, task) {
  const items = (events || []).map((e) => ({
    type: e.event_type,
    when: e.created_at,
    actor: e.actor,
    from: e.from_value,
    to: e.to_value,
    detail: e.detail,
  }));
  const has = (type) => items.some((i) => i.type === type);
  if (!has('created') && task.created_at) {
    items.push({ type: 'created', when: task.created_at, actor: task.created_by ?? task.agent_source ?? null, to: task.status });
  }
  if (task.completed_at && !has('completed')) {
    items.push({ type: 'completed', when: task.completed_at, actor: isAutoClosed(task) ? 'task-health' : (task.assigned_to ?? 'system'), to: 'completed' });
  }
  items.sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime());
  return items;
}

/** Map a timeline item to { cls, label } for rendering. */
function tlDisplay(it, task) {
  switch (it.type) {
    case 'created':
      return { cls: 'is-mark', label: `created${it.to && it.to !== 'pending' ? ` · ${String(it.to).replace('_', ' ')}` : ''}` };
    case 'completed':
      return { cls: 'is-ok', label: isAutoClosed(task) ? 'auto-closed' : 'completed' };
    case 'reopened':
      return { cls: '', label: 'reopened' };
    case 'status_changed':
      return {
        cls: it.to === 'blocked' ? 'is-warn' : '',
        label: `status → ${String(it.to || '').replace('_', ' ')}${it.from ? ` (was ${String(it.from).replace('_', ' ')})` : ''}`,
      };
    case 'rescheduled':
      return { cls: '', label: it.to ? `rescheduled → due ${tlDate(it.to)}` : 'due date cleared' };
    case 'assigned':
      return { cls: '', label: `assigned to ${it.to || 'unassigned'}` };
    case 'progress':
      return { cls: '', label: `progress → ${it.to}%` };
    case 'checked':
      return { cls: '', label: 'reviewed by task-health' };
    default:
      return { cls: '', label: String(it.type).replace(/_/g, ' ') };
  }
}

/**
 * The shipped pane is always the full-density master/detail pane; the dead
 * `density='side'` variant (no `/tasks/$taskId` route, zero call sites) was
 * removed 2026-07-03 (Section B decision, WP-14). Full is the only mode.
 * @param {{ taskId: string, onNavigateTask?: (id: string) => void, operatorId?: string | null }} props
 *   operatorId: who "Me" is (hostContext.operator); null when unknown — then
 *   edits are logged with no actor and "Me" is not offered as an assignee.
 */
export function TaskDetailPane({ taskId, onNavigateTask, operatorId = null }) {
  const queryClient = useQueryClient();

  const { data: task, isLoading, error } = useQuery(taskDetailQuery(taskId));
  const { data: subtasks } = useQuery(subtasksQuery(taskId));
  const { data: blockingTask } = useQuery(
    blockingTaskQuery(task?.blocked_by_task_id ?? null),
  );
  // Downstream dependents — the "Blocks" lane. Tasks naming this one as their
  // blocker are waiting on it.
  const { data: dependentTasks } = useQuery(dependentTasksQuery(taskId));

  // Activity/audit timeline (B.4) — real task_events rows.
  const { data: taskEvents } = useQuery(taskEventsQuery(taskId));

  const updateStatus = useMutation({
    /** @param {TaskStatus} status */
    mutationFn: async (status) => {
      await updateTaskStatus(taskId, status, operatorId);
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all }),
  });

  // Reschedule — toggled open by the Reschedule button (was a disabled stub, F-07/C.8).
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [dueDateInput, setDueDateInput] = useState('');
  const reschedule = useMutation({
    /** @param {string|null} dueDate */
    mutationFn: async (dueDate) => {
      await rescheduleTask(taskId, dueDate, operatorId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
      setRescheduleOpen(false);
    },
  });

  // Reassign — toggled open by the head's Reassign button (was dead until now).
  const [reassignOpen, setReassignOpen] = useState(false);
  const reassign = useMutation({
    /** @param {string} value picked assigned_to ('' = unassign) */
    mutationFn: async (value) => {
      const picked = assigneeOptions(getContext(), operatorId).find((o) => o.value === value);
      await reassignTask(taskId, value || null, picked ? picked.type : null, operatorId);
    },
    onSuccess: () => {
      // tasks.all covers every list view (assigned_to is shown across them);
      // detail covers this pane's own query.
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      setReassignOpen(false);
    },
  });

  if (isLoading) {
    return html`
      <div class="tk-detail-pane is-full">
        <div class="tk-empty">
          <${Icon} name="loader" size=${16} className="tk-spin" />
        </div>
      </div>
    `;
  }
  if (error instanceof Error) {
    return html`
      <div class="tk-detail-pane is-full">
        <div class="tk-empty" style=${{ color: 'var(--danger)', flexDirection: 'column', gap: 8 }}>
          <${Icon} name="alert-circle" size=${20} />
          <span>${error.message}</span>
        </div>
      </div>
    `;
  }
  if (!task) {
    return html`
      <div class="tk-detail-pane is-full">
        <div class="tk-empty">task not found</div>
      </div>
    `;
  }

  const isAgent = assigneeIsAgent(task);
  const autoClosed = isAutoClosed(task);
  const signal = autoCloseSignal(task.outcome_notes);
  const due = dueLabel(task.due_date);
  const dueDate = task.due_date
    ? new Date(task.due_date).toISOString().slice(0, 10)
    : null;

  return html`
    <div class="tk-detail-pane is-full">
      <div class="ip-head">
        <div class="ip-topline">
          <span class="id">task · ${shortId(task.id)}</span>
          ${html`
            <div class="ip-topline-actions">
              <${Button}
                variant=${rescheduleOpen ? 'default' : 'outline'}
                size="sm"
                type="button"
                onClick=${() => { setDueDateInput(dueDate || ''); setRescheduleOpen((v) => !v); }}
              >Reschedule</${Button}>
              <${Button}
                variant=${reassignOpen ? 'default' : 'outline'}
                size="sm"
                type="button"
                onClick=${() => setReassignOpen((v) => !v)}
              >Reassign</${Button}>
              <${Button}
                variant="affirmative"
                size="sm"
                type="button"
                disabled=${updateStatus.isPending || task.status === 'completed'}
                onClick=${() => updateStatus.mutate('completed')}
              >
                <${Icon} name="check" size=${12} /> Mark complete
              </${Button}>
            </div>
          `}
        </div>

        ${reassignOpen && html`
          <div
            style=${{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 8,
              padding: '8px 10px',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border-soft)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <span
              style=${{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                color: 'var(--fg-faint)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >Assign to</span>
            <select
              value=${task.assigned_to ?? ''}
              disabled=${reassign.isPending}
              onChange=${(e) => reassign.mutate(e.target.value)}
              style=${{
                height: 26,
                fontSize: 11.5,
                padding: '0 6px',
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-xs)',
                color: 'var(--fg)',
                fontFamily: 'inherit',
              }}
            >
              <option value="">Unassigned</option>
              ${task.assigned_to && !assigneeOptions(getContext(), operatorId).some((o) => o.value === task.assigned_to) &&
                html`<option value=${task.assigned_to}>${task.assigned_to} (current)</option>`}
              ${assigneeOptions(getContext(), operatorId).map(
                (o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`,
              )}
            </select>
            ${reassign.isPending && html`<${Icon} name="loader" size=${12} className="tk-spin" />`}
            ${reassign.isError && html`
              <span style=${{ color: 'var(--danger)', fontSize: 11 }}>
                ${(/** @type {Error} */ (reassign.error)).message}
              </span>
            `}
          </div>
        `}

        <h2 class="ip-title">${task.title}</h2>

        <div class="tk-det-meta-row">
          <span class=${cn('tk-badge', statusClass(task.status))}>
            <span class="dot"></span> ${task.status.replace('_', ' ')}
          </span>
          ${task.assigned_to && html`
            <span class=${cn('tk-assignee', isAgent && 'is-agent')}>
              ${isAgent
                ? html`<span class="dot"></span>`
                : html`<span class="avatar">${avatarInitial(task.assigned_to)}</span>`}
              ${task.assigned_to}
            </span>
          `}
          ${task.execution_mode && html`
            <span class=${cn('tk-execmode', `is-${task.execution_mode}`)}>
              ${task.execution_mode === 'approval_required' ? 'approval req' : task.execution_mode}
            </span>
          `}
          ${task.priority && html`
            <span class="sep">priority</span>
            <span class=${cn('pri-label', priorityClass(task.priority))}>
              <span class="dot"></span>
              ${task.priority}
            </span>
          `}
          ${task.category && html`
            <span class="sep">·</span>
            <span style=${{ color: 'var(--fg-muted)' }}>${task.category}</span>
          `}
          ${dueDate && html`
            <span class="sep">·</span>
            <span class=${cn('due-text', due.cls)}>
              due ${dueDate}${due.cls === 'is-overdue' ? ` · ${due.label}` : ''}
            </span>
          `}
        </div>
      </div>

      ${rescheduleOpen && html`
        <div
          style=${{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            margin: '0 var(--space-4) 8px',
            padding: '8px 10px',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span
            style=${{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--fg-faint)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >Due date</span>
          <input
            type="date"
            value=${dueDateInput}
            disabled=${reschedule.isPending}
            onInput=${(e) => setDueDateInput(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') reschedule.mutate(dueDateInput || null); }}
            style=${{
              height: 26,
              fontSize: 11.5,
              padding: '0 6px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-xs)',
              color: 'var(--fg)',
              fontFamily: 'inherit',
              colorScheme: 'dark light',
            }}
          />
          <${Button}
            variant="affirmative"
            size="sm"
            type="button"
            disabled=${reschedule.isPending || !dueDateInput}
            onClick=${() => reschedule.mutate(dueDateInput || null)}
          >Save</${Button}>
          ${task.due_date && html`
            <${Button}
              variant="outline"
              size="sm"
              type="button"
              disabled=${reschedule.isPending}
              onClick=${() => reschedule.mutate(null)}
            >Clear due</${Button}>
          `}
          <${Button}
            variant="ghost"
            size="sm"
            type="button"
            onClick=${() => setRescheduleOpen(false)}
          >Cancel</${Button}>
          ${reschedule.isPending && html`<${Icon} name="loader" size=${12} className="tk-spin" />`}
          ${reschedule.isError && html`
            <span style=${{ color: 'var(--danger)', fontSize: 11 }}>
              ${(/** @type {Error} */ (reschedule.error)).message}
            </span>
          `}
        </div>
      `}

      <div class="ip-body">
        ${autoClosed && task.outcome_notes && html`
          <div class="tk-evidence">
            <div class="tk-evidence-head">
              <span class="rule-chip">
                <${Icon} name="check" size=${10} strokeWidth=${2.5} />
                ${signal ?? 'auto-closed'}
              </span>
              <span class="timestamp">${relativeAgo(task.completed_at)}</span>
            </div>
            <div class="body">${task.outcome_notes}</div>
          </div>
        `}

        ${(task.source_email_id || task.claude_session_id || task.initiative_id) && html`
          <div>
            <div class="tk-section-label">
              <span>Source & context</span>
            </div>
            <div class="tk-source-row">
              ${task.source_email_id && html`
                <button type="button" class="tk-src is-email">
                  <${Icon} name="mail" size=${11} />
                  email · ${shortId(task.source_email_id)}
                </button>
              `}
              ${task.claude_session_id && html`
                <button type="button" class="tk-src is-session" disabled>
                  <${Icon} name="terminal" size=${11} />
                  session · ${shortId(task.claude_session_id)}
                </button>
              `}
              ${task.initiative_id && html`
                <button type="button" class="tk-src is-git">
                  <${Icon} name="git-branch" size=${11} />
                  initiative · ${task.initiative_id}
                </button>
              `}
            </div>
          </div>
        `}

        ${task.description && html`
          <div>
            <div class="tk-section-label"><span>Description</span></div>
            <div class="ip-desc">${task.description}</div>
          </div>
        `}

        <div>
          <div class="tk-section-label"><span>Fields</span></div>
          <dl class="tk-det-grid">
            <dt>Status</dt>
            <dd>
              <select
                value=${task.status}
                disabled=${updateStatus.isPending}
                onChange=${(e) => updateStatus.mutate(/** @type {TaskStatus} */ (e.target.value))}
                style=${{
                  height: 24,
                  fontSize: 11.5,
                  padding: '0 6px',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-xs)',
                  color: 'var(--fg)',
                  fontFamily: 'inherit',
                }}
              >
                ${STATUS_OPTIONS.map((s) => html`
                  <option key=${s} value=${s}>${s.replace('_', ' ')}</option>
                `)}
              </select>
            </dd>
            ${task.progress_pct !== null && html`
              <dt>Progress</dt>
              <dd>
                <div class="ip-progress">
                  <span class="ip-progress-fill" style=${{ width: `${task.progress_pct}%` }}></span>
                </div>
                <span style=${{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-muted)' }}>
                  ${task.progress_pct}%
                </span>
              </dd>
            `}
            ${task.effort_estimate && html`
              <dt>Effort</dt>
              <dd><code>${task.effort_estimate}</code></dd>
            `}
            ${task.tags && task.tags.length > 0 && html`
              <dt>Tags</dt>
              <dd>
                ${task.tags.map((tag) => html`
                  <span
                    key=${tag}
                    style=${{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      background: 'var(--bg-sunken)',
                      border: '1px solid var(--border-soft)',
                      color: 'var(--fg-muted)',
                      padding: '1px 6px',
                      borderRadius: 'var(--radius-xs)',
                    }}
                  >${tag}</span>
                `)}
              </dd>
            `}
            ${task.working_dir && html`
              <dt>Working dir</dt>
              <dd><code>${task.working_dir}</code></dd>
            `}
            <dt>Created</dt>
            <dd style=${{ color: 'var(--fg-muted)' }}>
              ${new Date(task.created_at).toLocaleString()}
              ${task.agent_source && html`
                ${' by '}
                <span style=${{ color: 'var(--agent)', fontFamily: 'var(--font-mono)' }}>
                  ${task.agent_source}
                </span>
              `}
            </dd>
          </dl>
        </div>

        ${(blockingTask || (dependentTasks && dependentTasks.length > 0)) && html`
          <div>
            <div class="tk-section-label"><span>Dependencies</span></div>
            ${blockingTask && html`
              <div class="tk-dep-lane">Blocked by</div>
              <div class="tk-dep-list">
                <button
                  type="button"
                  class=${cn('tk-dep-row', blockingTask.status === 'completed' ? 'is-resolved' : 'is-up')}
                  onClick=${() => onNavigateTask?.(blockingTask.id)}
                >
                  ${blockingTask.status === 'completed'
                    ? html`<${Icon} name="check" size=${13} strokeWidth=${2.2} className="arr" />`
                    : html`<${Icon} name="alert-circle" size=${13} className="arr" />`}
                  <span class="name">${blockingTask.title}</span>
                  <span class=${cn('tk-badge', statusClass(blockingTask.status))}>
                    <span class="dot"></span>
                    ${blockingTask.status === 'completed' ? 'resolved' : blockingTask.status.replace('_', ' ')}
                  </span>
                </button>
              </div>
            `}
            ${dependentTasks && dependentTasks.length > 0 && html`
              <div class="tk-dep-lane">Blocks</div>
              <div class="tk-dep-list">
                ${dependentTasks.map((d) => html`
                  <button
                    type="button"
                    key=${d.id}
                    class=${cn('tk-dep-row', d.status === 'completed' ? 'is-resolved' : 'is-down')}
                    onClick=${() => onNavigateTask?.(d.id)}
                  >
                    ${d.status === 'completed'
                      ? html`<${Icon} name="check" size=${13} strokeWidth=${2.2} className="arr" />`
                      : html`<${Icon} name="arrow-down" size=${13} className="arr" />`}
                    <span class="name">${d.title}</span>
                    <span class=${cn('tk-badge', statusClass(d.status))}>
                      <span class="dot"></span>
                      ${d.status === 'completed'
                        ? 'resolved'
                        : d.status === 'pending'
                          ? 'waiting'
                          : d.status.replace('_', ' ')}
                    </span>
                  </button>
                `)}
              </div>
            `}
          </div>
        `}

        ${subtasks && subtasks.length > 0 && html`
          <div>
            <div class="tk-section-label">
              <span>Subtasks</span>
              <span class="ct">
                ${subtasks.filter((s) => s.status === 'completed').length}/${subtasks.length}
              </span>
            </div>
            <div class="tk-subtasks">
              ${subtasks.map((s) => html`
                <button
                  type="button"
                  key=${s.id}
                  class=${cn('tk-sub-row', s.status === 'completed' && 'is-completed')}
                  onClick=${() => onNavigateTask?.(s.id)}
                >
                  <span class=${cn('tk-badge', statusClass(s.status))}>
                    <span class="dot"></span>
                    ${s.status === 'completed'
                      ? 'done'
                      : s.status === 'in_progress'
                        ? 'now'
                        : s.status.replace('_', ' ')}
                  </span>
                  <span class="name">${s.title}</span>
                  <span class="due">
                    ${s.completed_at
                      ? relativeAgo(s.completed_at)
                      : s.status === 'in_progress'
                        ? 'in flight'
                        : ''}
                  </span>
                </button>
              `)}
            </div>
          </div>
        `}

        ${(() => {
          const timeline = buildTimeline(taskEvents, task);
          return html`
            <div>
              <div class="tk-section-label">
                <span>Activity</span>
                ${timeline.length > 0 && html`<span class="ct">${timeline.length}</span>`}
              </div>
              <div class="tk-timeline">
                ${timeline.map((it, i) => {
                  const d = tlDisplay(it, task);
                  return html`
                    <div class=${cn('tk-tl-item', d.cls)} key=${i}>
                      <span class="when">${tlWhen(it.when)}</span>
                      ${(() => {
                        const who = actorLabel(it.actor, operatorId, USER_EVENT_TYPES.has(it.type));
                        return who && html`<span class=${cn('actor', isAgentActor(it.actor, operatorId) && 'is-agent')}>${who}</span>`;
                      })()}
                      ${d.label}
                    </div>
                  `;
                })}
              </div>
            </div>
          `;
        })()}
      </div>

      ${updateStatus.isError && html`
        <p class="tk-mut-error">
          Failed: ${(/** @type {Error} */ (updateStatus.error)).message}
        </p>
      `}
    </div>
  `;
}
