// Tasks main view — ported from views/TasksView.tsx. List + filter bar +
// grouped rows + master/detail split. The view switcher (Tasks/Agenda/Triage/
// Sweeper/Done) and the list filters BOTH live in the shell side-menu now (see
// buildTasksMenu + the publish effect); there's no in-pane tab bar. View
// choice persists to localStorage.

import { html, cn, Icon, Button, useState, useMemo, useEffect, useRef, useQuery, useQueryClient } from '../../lib/ui.js';
import {
  hostDbQuery,
  hostSendToActiveSession,
  isStandalone,
  publishIykeState,
  setMenu,
} from '../../lib/bridge.js';
import { queryKeys } from '../../lib/query-keys.js';
import { TASKS_LIST_COLUMNS, totalTasksQuery, triageCountsQuery } from '../../lib/queries.js';
import { ME_LABEL } from '../../lib/assignees.js';
import { groupTasks } from '../../lib/shared.js';
import { TaskRow } from './task-row.js';
import { CreateTaskForm } from './create-task-form.js';
import { TaskDetailPane } from './task-detail-pane.js';
import { AgendaView } from './agenda-view.js';
import { TriageView } from './triage-view.js';
import { SweeperView } from './sweeper-view.js';
import { DoneView } from './done-view.js';
import { NoTasksYet } from './empty-state.js';

// Shell side-menu model. Per the user's call (2026-05-28), the five VIEW modes
// live in the sidebar alongside the list FILTER facets — one nav surface, like
// Ngwa. The filters are List-only, so they render dimmed (disabled) on any
// non-list view (mirrors Ngwa's "Kind dims on Analyze"). `buildTasksMenu`
// computes the flat item list with per-item `active` + `disabled` flags; the
// publish effect re-sends it whenever view / active-filter / triage-badge
// changes. See pkg-mode.tsx for how the shell renders sections + dim + active.
const VIEW_ITEMS = [
  { id: 'v:tasks', label: 'Tasks', icon: 'check-square' },
  { id: 'v:agenda', label: 'Agenda', icon: 'calendar-days' },
  { id: 'v:triage', label: 'Triage', icon: 'stethoscope' },
  { id: 'v:sweeper', label: 'Sweeper', icon: 'broom' },
  { id: 'v:done', label: 'Done', icon: 'check-check' },
];
const FILTER_ITEMS = [
  // Filter section (the implicit-first group in the design's TASKS_SIDEBAR).
  { id: 'f:all', label: 'All tasks', icon: 'list-checks', section: 'Filter' },
  { id: 'f:today', label: 'Today', icon: 'sun', section: 'Filter' },
  { id: 'f:overdue', label: 'Overdue', icon: 'alert-triangle', section: 'Filter' },
  { id: 'f:thisweek', label: 'This week', icon: 'calendar-days', section: 'Filter' },
  { id: 'f:autoclosed', label: 'Auto-closed', icon: 'check-check', section: 'Filter' },
  { id: 'd:finance', label: 'Finance', icon: 'trending-up', section: 'By domain' },
  { id: 'd:mail', label: 'Mail', icon: 'mail', section: 'By domain' },
  { id: 'd:content', label: 'Content', icon: 'pencil', section: 'By domain' },
  { id: 'd:outbound', label: 'Outbound', icon: 'send', section: 'By domain' },
  { id: 'o:me', label: ME_LABEL, icon: 'list-checks', section: 'By owner' },
  { id: 'o:agents', label: 'Agents', icon: 'activity', section: 'By owner' },
];

/**
 * @param {TaskView} view current mounted view
 * @param {string | null} activeFilter last-applied filter id (e.g. 'f:today')
 * @param {number | null} triageBadge needs-attention count for the Triage row
 * @param {boolean} hasOperator whether the shell reported who "Me" is; the Me row is offered only then
 */
function buildTasksMenu(view, activeFilter, triageBadge, hasOperator) {
  const filtersInert = view !== 'tasks';
  const viewRows = VIEW_ITEMS.map((it) => ({
    ...it,
    section: 'View',
    active: `v:${view}` === it.id,
    badge: it.id === 'v:triage' && triageBadge ? triageBadge : undefined,
  }));
  const filterRows = FILTER_ITEMS.filter((it) => hasOperator || it.id !== 'o:me').map((it) => ({
    ...it,
    disabled: filtersInert,
    // Highlight the applied filter only while the list is the active view.
    active: !filtersInert && activeFilter === it.id,
  }));
  return [...viewRows, ...filterRows];
}

/** @typedef {import('../../lib/queries.js').Task} Task */
/** @typedef {import('../../lib/queries.js').TaskStatus} TaskStatus */
/** @typedef {import('../../lib/shared.js').GroupKey} GroupKey */
/** @typedef {import('../../lib/shared.js').TaskView} TaskView */

const VIEW_STORAGE_KEY = 'ikenga-tasks-view';

// Owner-filter identities. The sidebar "By owner" facet and the in-pane Owner
// dropdown MUST agree on these values, or selecting one won't reflect in the
// other. "Me" is the operator id the shell reports (hostContext.operator),
// threaded down from app.js as `operatorId`; with no operator there is no Me
// facet and no Me option.
// Sentinel for "any agent" — the query maps it to assignee_type='agent' rather
// than a literal assigned_to (agents aren't a single owner id).
const OWNER_AGENTS = '__agents__';

// Display names for the slim header — the bar reflects the active view (the
// sidebar already says "Tasks", so the in-pane bar holds context + action, not
// the domain name). See the header block in the render.
/** @type {Record<TaskView, string>} */
const VIEW_LABELS = {
  tasks: 'Tasks',
  agenda: 'Agenda',
  triage: 'Triage',
  sweeper: 'Sweeper',
  done: 'Done',
};

/** @returns {TaskView} */
function loadView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === 'tasks' || v === 'agenda' || v === 'triage' || v === 'sweeper' || v === 'done') {
      return v;
    }
  } catch {
    /* localStorage unavailable (sandboxed iframe) — fall through */
  }
  return 'tasks';
}

/** @type {Array<{ value: '' | TaskStatus, label: string }>} */
const STATUS_OPTIONS = [
  { value: '', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
];

/** @param {{ activeFeature?: string | null, operatorId?: string | null }} props */
export function TasksView({ activeFeature, operatorId = null } = {}) {
  /** @type {[string | null, (v: string | null) => void]} */
  const [selectedId, setSelectedId] = useState(/** @type {string | null} */ (null));
  /** @type {['' | TaskStatus, (v: '' | TaskStatus) => void]} */
  const [statusFilter, setStatusFilter] = useState(/** @type {'' | TaskStatus} */ (''));
  const [ownerFilter, setOwnerFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showAutoClosed, setShowAutoClosed] = useState(true);
  /** @type {[Set<GroupKey>, (f: (prev: Set<GroupKey>) => Set<GroupKey>) => void]} */
  const [collapsed, setCollapsed] = useState(/** @type {Set<GroupKey>} */ (new Set(['later'])));
  const [view, setView] = useState(loadView);
  // Last-applied sidebar filter id (e.g. 'f:today', 'd:finance', 'o:me') — kept
  // so the sidebar can re-highlight it when the List view is active. Defaults
  // to 'f:all' (the unfiltered list).
  const [activeFilter, setActiveFilter] = useState('f:all');
  // Time-bucket narrowing for the Today/Overdue/This week/Auto-closed facets.
  // null = show every group. When set to a GroupKey, the list renders only
  // that group — so those sidebar items actually FILTER, not just scroll.
  /** @type {[GroupKey | null, (v: GroupKey | null) => void]} */
  const [timeBucket, setTimeBucket] = useState(/** @type {GroupKey | null} */ (null));

  /** @param {TaskView} v */
  function changeView(v) {
    setView(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* ignore */
    }
  }

  // Read by the side-menu effect below without making it re-run (and re-apply a
  // stale facet) when the operator resolves a moment after mount.
  const operatorIdRef = useRef(operatorId);
  operatorIdRef.current = operatorId;

  // Shell side-menu selection (host.pkg.setMenu → royaltiSuite.activeFeature).
  // The sidebar carries BOTH the view switcher and the list filters (one nav
  // surface, Ngwa-style). id taxonomy:
  //
  //   v:<view>      — switch the mounted view (tasks|agenda|triage|sweeper|done)
  //   f:all         — list: clear all filters, show open
  //   f:today       — list: expand "today" group + scroll to it
  //   f:overdue     — list: expand "overdue" group + scroll
  //   f:thisweek    — list: expand "week" group + scroll
  //   f:autoclosed  — list: toggle Show auto-closed on + expand "autoclosed"
  //   d:<category>  — list: filter by category column (Finance/Mail/…)
  //   o:me|o:agents — list: filter by owner (me = the operator the shell reports)
  //
  // Filter ids only fire while the list is (or becomes) the active view; the
  // shell already dims them on other views, but we also force view→tasks here
  // so a stray dispatch can't apply a filter the user can't see.
  useEffect(() => {
    if (!activeFeature) return;

    // View switch.
    if (activeFeature.startsWith('v:')) {
      const v = activeFeature.slice(2);
      if (v === 'tasks' || v === 'agenda' || v === 'triage' || v === 'sweeper' || v === 'done') {
        changeView(/** @type {TaskView} */ (v));
      }
      return;
    }

    // Time-bucket facets. These NARROW the list to one group (real filter), not
    // just scroll to it. 'all' resets every filter incl. the bucket.
    if (activeFeature.startsWith('f:')) {
      const sub = activeFeature.slice(2);
      setView('tasks');
      setActiveFilter(activeFeature);
      if (sub === 'all') {
        setTimeBucket(null);
        setStatusFilter('');
        setOwnerFilter('');
        setCategoryFilter('');
        setSearch('');
        return;
      }
      /** @type {Record<string, GroupKey>} */
      const groupKey = { today: 'today', overdue: 'overdue', thisweek: 'week', autoclosed: 'autoclosed' };
      const key = groupKey[sub];
      if (!key) return;
      if (key === 'autoclosed') setShowAutoClosed(true);
      // Make sure the bucket isn't also collapsed (so its rows show once it's
      // the only group on screen).
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setTimeBucket(key);
      return;
    }

    // Category filter (`By domain` section). Maps the design's four facet
    // labels to whatever the row's `category` column actually contains.
    if (activeFeature.startsWith('d:')) {
      setView('tasks');
      setActiveFilter(activeFeature);
      setCategoryFilter(activeFeature.slice(2));
      return;
    }

    // Owner filter (`By owner` section). `me` maps to the operator id the shell
    // reported; with no operator it matches nothing, so it is ignored rather than
    // showing everyone. `agents` is the OWNER_AGENTS sentinel the list query maps
    // to assignee_type = 'agent'.
    if (activeFeature.startsWith('o:')) {
      const who = activeFeature.slice(2);
      if (who === 'me' && !operatorIdRef.current) return;
      setView('tasks');
      setActiveFilter(activeFeature);
      setOwnerFilter(who === 'me' ? operatorIdRef.current : who === 'agents' ? OWNER_AGENTS : '');
      return;
    }
  }, [activeFeature]);

  // Server-side health counts — drive the Triage tab badge (and the Triage
  // view's stat cards), correct independent of the list filter + 200-row cap.
  const { data: triageCounts } = useQuery(triageCountsQuery());
  const triageBadge = triageCounts ? triageCounts.needsAttention : null;

  // How many task rows exist at all. 0 is a true first run (every view shows
  // the "No tasks yet" state with a New task action); a non-zero count with an
  // empty list just means a filter, or nothing open — those say so instead.
  const { data: totalTasks, isError: totalError } = useQuery(totalTasksQuery());
  const noTasksYet = totalTasks === 0;
  const totalSettled = totalTasks !== undefined || totalError;
  // The first row can arrive from outside this pane (the total query polls while
  // empty). Cached lists were fetched when there was nothing, so refresh them the
  // moment the count leaves zero.
  const queryClient = useQueryClient();
  const prevTotalRef = useRef(/** @type {number | undefined} */ (undefined));
  useEffect(() => {
    if (prevTotalRef.current === 0 && typeof totalTasks === 'number' && totalTasks > 0) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    }
    prevTotalRef.current = totalTasks;
  }, [totalTasks, queryClient]);

  // Distinct categories straight from the table (NOT from the filtered list, or
  // the option set would collapse to the active filter). Drives the Category
  // dropdown so it lists real values + always reflects the sidebar's domain pick.
  const { data: categoryRows } = useQuery({
    queryKey: queryKeys.tasks.list('distinct-categories'),
    queryFn: async () => {
      const rows = await hostDbQuery(
        "SELECT DISTINCT category FROM tasks WHERE category IS NOT NULL AND category <> '' ORDER BY category",
        [],
      );
      return /** @type {{ category: string }[]} */ (rows);
    },
  });
  const categoryOptions = useMemo(() => {
    const set = new Set((categoryRows ?? []).map((r) => r.category));
    if (categoryFilter) set.add(categoryFilter); // ensure the active pick is selectable
    return Array.from(set).sort();
  }, [categoryRows, categoryFilter]);

  // Imperatively reflect filter state onto the native <select>s. Preact's
  // controlled `value` doesn't re-apply on external (sidebar-driven) changes in
  // this htm build, so we set each select's .value after render. Runs after the
  // filterbar exists (view==='tasks') and whenever a filter or the option set
  // changes.
  useEffect(() => {
    if (view !== 'tasks') return;
    const fb = document.querySelector('.tk-filterbar');
    if (!fb) return;
    const set = (name, val) => {
      const el = fb.querySelector(`select[data-filter="${name}"]`);
      if (el && el.value !== val) el.value = val;
    };
    set('status', statusFilter);
    set('owner', ownerFilter);
    set('category', categoryFilter);
  }, [view, statusFilter, ownerFilter, categoryFilter, categoryOptions, operatorId, noTasksYet]);

  // Publish (and keep refreshing) the shell side-menu. Re-sends whenever the
  // view, the active filter, or the triage badge changes so the sidebar's
  // active-highlight, filter-dim, and Triage count stay in lockstep with the
  // pane. Skipped in standalone preview (no host to publish to).
  useEffect(() => {
    if (isStandalone()) return;
    setMenu(buildTasksMenu(view, activeFilter, triageBadge, !!operatorId)).catch((e) =>
      console.warn('[tasks] setMenu failed', e),
    );
  }, [view, activeFilter, triageBadge, operatorId]);

  // Publish the mounted view + open-task selection to the shell's iyke
  // iframe-state registry, so external agents can answer "what's open in
  // this pane" from `iyke state` / `iyke iframe-state` instead of guessing
  // from the DB. Fire-and-forget debug surface — no host round-trip.
  useEffect(() => {
    publishIykeState('selection', { view, taskId: selectedId });
  }, [view, selectedId]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.tasks.list(
      `${statusFilter || 'open'}|${ownerFilter}|${categoryFilter}|${showAutoClosed ? 'ac' : 'no-ac'}`,
    ),
    /** @returns {Promise<Task[]>} */
    queryFn: async () => {
      /** @type {string[]} */
      const where = [];
      /** @type {(string|number|null)[]} */
      const params = [];

      if (statusFilter) {
        where.push('status = ?');
        params.push(statusFilter);
      } else if (showAutoClosed) {
        // active OR (completed AND auto-closed by task-health) — the `%` lives
        // in the LIKE pattern param, not the SQL text.
        where.push(
          "(status IN ('pending','in_progress','blocked') OR (status = 'completed' AND outcome_notes LIKE ?))",
        );
        params.push('Auto-closed by task-health%');
      } else {
        where.push("status IN ('pending','in_progress','blocked')");
      }
      if (ownerFilter === OWNER_AGENTS) {
        where.push("assignee_type = 'agent'");
      } else if (ownerFilter) {
        where.push('assigned_to = ?');
        params.push(ownerFilter);
      }
      if (categoryFilter) {
        where.push('category = ?');
        params.push(categoryFilter);
      }
      if (search.trim()) {
        where.push('title LIKE ?'); // SQLite LIKE is case-insensitive (ASCII) ≈ ilike
        params.push(`%${search.trim()}%`);
      }

      const sql =
        `SELECT ${TASKS_LIST_COLUMNS} FROM tasks` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY due_date ASC NULLS LAST, created_at DESC LIMIT 200';

      const rows = await hostDbQuery(sql, params);
      return /** @type {Task[]} */ (rows);
    },
  });

  const groups = useMemo(
    () => (data ? groupTasks(data, showAutoClosed) : []),
    [data, showAutoClosed],
  );

  // When a time facet is active, show only that group (Today/Overdue/This week/
  // Auto-closed actually filter). null → every group.
  const visibleGroups = useMemo(
    () => (timeBucket ? groups.filter((g) => g.key === timeBucket) : groups),
    [groups, timeBucket],
  );

  // The list opens with "Later" collapsed so dated work leads. When it is the
  // ONLY group (the usual first run: tasks with no due date) there is nothing
  // for it to give way to, so it opens expanded — otherwise a new user's first
  // task hides behind a collapsed header — until they collapse or expand a group
  // themselves.
  const [groupsTouched, setGroupsTouched] = useState(false);
  const effectiveCollapsed = useMemo(
    () => (!groupsTouched && visibleGroups.length === 1 ? new Set() : collapsed),
    [groupsTouched, visibleGroups, collapsed],
  );

  // Default selection (F-01): the design shows a populated detail pane on load,
  // not an empty "Select a task". On the first load that yields rows — and any
  // time the current selection drops out of view (filter change) — auto-select
  // the first visible task. We only auto-fill when nothing is selected OR the
  // selected id is no longer present, so a user's explicit pick is never
  // clobbered while it remains visible.
  useEffect(() => {
    if (view !== 'tasks') return;
    const firstId = visibleGroups[0]?.tasks?.[0]?.id ?? null;
    if (!firstId) return;
    const stillVisible =
      selectedId != null &&
      visibleGroups.some((g) => g.tasks.some((t) => t.id === selectedId));
    if (!stillVisible) setSelectedId(firstId);
  }, [view, visibleGroups, selectedId]);

  const openCount = useMemo(
    () => data?.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length ?? 0,
    [data],
  );
  const autoClosedCount = useMemo(
    () =>
      data?.filter(
        (t) =>
          t.status === 'completed' &&
          !!t.outcome_notes &&
          t.outcome_notes.startsWith('Auto-closed by task-health'),
      ).length ?? 0,
    [data],
  );

  const filterActive = !!statusFilter || !!ownerFilter || !!categoryFilter || !!search.trim();

  // Inline create-form visibility. The primary "New task" button toggles this;
  // the form INSERTs directly via host.dbExec (createTask write helper).
  const [showCreate, setShowCreate] = useState(false);

  // F-28: ⌘⇧T (Ctrl+Shift+T) toggles the New-task form, mirroring the chip on
  // the button. Pane-scoped — this iframe IS the tasks pane, so a document-level
  // listener never leaks to sibling panes; preventDefault stops it reaching the
  // host's own shortcut map.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        setShowCreate((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [dispatching, setDispatching] = useState(false);

  // Secondary path: "send to your Chi" — seed a user turn into the shell's
  // active Claude session so the agent creates the task conversationally. This
  // used to be the ONLY create path (anon RLS blocked client-side INSERT); now
  // that host.dbExec permits a real INSERT it's kept as the natural-language
  // alternative alongside the direct form. Disabled in standalone (no host).
  async function dispatchToChi() {
    if (dispatching || isStandalone()) return;
    setDispatching(true);
    try {
      await hostSendToActiveSession(
        'Create a new task. Ask me for the title, owner, priority, and due date, then add it to the tasks table.',
      );
    } catch (e) {
      console.warn('[tasks] create dispatch failed', e);
    } finally {
      setDispatching(false);
    }
  }

  /** @param {GroupKey} key */
  function toggleGroup(key) {
    const next = new Set(effectiveCollapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(() => next);
    setGroupsTouched(true);
  }

  return html`
    <div class="tk-screen">
      <div class="frame" style=${{ flex: 1 }}>
        <div class="frame-head">
          <div class="frame-title-wrap">
            <${Icon} name="check-square" size=${15} className="frame-title-mark" />
            <h2 class="frame-title">
              ${VIEW_LABELS[view] ?? 'Tasks'}
              ${autoClosedCount > 0 &&
              html`<span class="tk-frame-count">· ${autoClosedCount} auto-closed</span>`}
            </h2>
          </div>
          <div style=${{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <${Button}
              variant="outline"
              size="sm"
              type="button"
              disabled=${dispatching || isStandalone()}
              title=${isStandalone() ? 'Dispatch unavailable in standalone preview' : 'Hand the task off to your Chi to create conversationally'}
              onClick=${dispatchToChi}
            >
              <${Icon} name=${dispatching ? 'loader' : 'terminal'} size=${12} className=${dispatching ? 'tk-spin' : undefined} />
              ${dispatching ? 'Dispatching…' : 'Send to your Chi'}
            </${Button}>
            <${Button}
              size="sm"
              type="button"
              onClick=${() => setShowCreate((v) => !v)}
            >
              <${Icon} name=${showCreate ? 'check-square' : 'plus'} size=${12} />
              New task
              <span style=${{ fontFamily: 'var(--font-mono)', fontSize: 9.5, opacity: 0.7, marginLeft: 6 }}>⌘⇧T</span>
            </${Button}>
          </div>
        </div>

        ${showCreate && html`<${CreateTaskForm} operatorId=${operatorId} onClose=${() => setShowCreate(false)} />`}

        ${/* True first run: no task rows at all. Every view shows the same
              "No tasks yet" state with a New task action instead of its own
              (empty or zeroed) layout. While the create form is open the form
              itself is the call to action. */ ''}
        ${noTasksYet && !showCreate && html`<${NoTasksYet} view=${view} onCreate=${() => setShowCreate(true)} />`}

        ${!noTasksYet && view === 'agenda' && html`<${AgendaView} tasks=${data ?? []} filterActive=${filterActive} />`}
        ${!noTasksYet && view === 'triage' && html`<${TriageView} listTasks=${data ?? []} />`}
        ${!noTasksYet && view === 'sweeper' && html`<${SweeperView} />`}
        ${!noTasksYet && view === 'done' && html`<${DoneView} onSelectTask=${(id) => { setSelectedId(id); changeView('tasks'); }} />`}

        ${!noTasksYet && view === 'tasks' && html`
          <div class="tk-filterbar">
            <div class="input-search-wrap">
              <${Icon} name="search" size=${13} />
              <input
                type="text"
                value=${search}
                onInput=${(e) => setSearch(e.target.value)}
                placeholder="Search title…"
              />
            </div>
            <span class="label">Status</span>
            ${/* Preact's controlled <select value> doesn't re-apply its value on
                  an externally-driven state change in this htm build (the option
                  display lags the real filter), so the actual selection is synced
                  imperatively by data-filter in the effect below. */ ''}
            <select
              data-filter="status"
              onChange=${(e) => setStatusFilter(/** @type {'' | TaskStatus} */ (e.target.value))}
            >
              ${STATUS_OPTIONS.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
            </select>
            <span class="label">Owner</span>
            <select data-filter="owner" onChange=${(e) => setOwnerFilter(e.target.value)}>
              <option value="">Anyone</option>
              ${operatorId && html`<option value=${operatorId}>${ME_LABEL}</option>`}
              <option value=${OWNER_AGENTS}>Agents</option>
            </select>
            <span class="label">Category</span>
            <select data-filter="category" onChange=${(e) => setCategoryFilter(e.target.value)}>
              <option value="">All</option>
              ${categoryOptions.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}
            </select>
            <button
              type="button"
              class=${cn('tk-toggle', showAutoClosed && 'is-on')}
              onClick=${() => setShowAutoClosed((v) => !v)}
            >
              <span class="checkbox"></span>
              Show auto-closed
            </button>
            <div class="spacer"></div>
            <span class="label">${openCount} open · ${autoClosedCount} closed</span>
          </div>

          <div class="tk-split">
            <div class="tk-list">
              ${isLoading && html`
                <div class="tk-loading">
                  <${Icon} name="loader" size=${16} className="tk-spin" />
                  Loading…
                </div>
              `}
              ${error instanceof Error && html`
                <div class="tk-error">
                  <${Icon} name="alert-circle" size=${16} />
                  <div>
                    <p class="t">Failed to load tasks</p>
                    <p class="d">${error.message}</p>
                  </div>
                </div>
              `}
              ${/* A filter (or sidebar facet) that matches nothing says so; with no
                    filter and rows that are all done it says nothing is open. The
                    true first run is handled above, not here. */ ''}
              ${!isLoading && !error && totalSettled && visibleGroups.length === 0 && html`
                <div class="tk-empty-box">${filterActive || timeBucket ? 'No tasks match.' : 'Nothing open right now.'}</div>
              `}
              ${visibleGroups.flatMap((g) => {
                const isCollapsed = effectiveCollapsed.has(g.key);
                // Group head + rows are emitted FLAT (direct children of
                // .tk-list), not wrapped in a per-group div — so the head's
                // `position:sticky; top:0` pins to the scroll container and the
                // next head pushes it up (matches the design's .ld-list). A
                // wrapper div would scope each sticky to its own group bounds.
                const head = html`
                  <div
                    key=${`${g.key}:head`}
                    role="button"
                    tabIndex=${0}
                    aria-expanded=${!isCollapsed}
                    data-group=${g.key}
                    class=${cn(
                      'tk-group-head',
                      g.key === 'overdue' && 'is-overdue',
                      g.key === 'autoclosed' && 'is-autoclosed',
                      isCollapsed && 'is-collapsed',
                    )}
                    onClick=${() => toggleGroup(g.key)}
                    onKeyDown=${(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroup(g.key);
                      }
                    }}
                  >
                    <span class="tk-group-label">
                      <${Icon} name="chevron-down" size=${10} className="chev" />
                      ${g.label}
                    </span>
                    <span class="ct">${g.tasks.length}</span>
                  </div>
                `;
                if (isCollapsed) return [head];
                return [
                  head,
                  ...g.tasks.map(
                    (t) => html`
                      <${TaskRow}
                        key=${t.id}
                        task=${t}
                        selected=${selectedId === t.id}
                        onSelect=${setSelectedId}
                      />
                    `,
                  ),
                ];
              })}
            </div>

            <div class="tk-divider"></div>

            <div class="tk-detail">
              ${selectedId
                ? html`<${TaskDetailPane} taskId=${selectedId} operatorId=${operatorId} onNavigateTask=${setSelectedId} />`
                : html`<div class="tk-empty">Select a task</div>`}
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}
