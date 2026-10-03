// First-run empty state — shown by every view when the `tasks` table has no rows
// at all. It is deliberately separate from the filter-empty copy ("No tasks
// match."): this one means "you have not added anything yet" and carries the
// New task action, so a fresh install is never a dead end.
//
// Styling rides inline styles + @ikenga/tokens vars (same approach as the
// create form), so this adds no rules to the generated tasks-css.js string.

import { html, Icon, Button } from '../../lib/ui.js';

/** One honest line per view about what will appear once there are tasks. */
const HINTS = {
  tasks: 'Your list will appear here.',
  agenda: 'Tasks due today will line up on a time rail here.',
  triage: 'Overdue, stale, unassigned and blocked tasks will be counted here.',
  sweeper: 'Close proposals show up here once an assistant has been reviewing your tasks.',
  done: 'Completed tasks will be listed here.',
};

/**
 * @param {{ view?: keyof typeof HINTS, onCreate: () => void }} props
 */
export function NoTasksYet({ view = 'tasks', onCreate }) {
  return html`
    <div
      class="tk-first-run"
      style=${{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-6)',
        textAlign: 'center',
        color: 'var(--fg-faint)',
      }}
    >
      <${Icon} name="check-square" size=${28} />
      <h3 style=${{ margin: 0, fontSize: 'var(--text-h4)', color: 'var(--fg)' }}>No tasks yet</h3>
      <p
        style=${{
          margin: 0,
          maxWidth: '44ch',
          fontSize: 'var(--text-body-sm)',
          color: 'var(--fg-muted)',
          lineHeight: 1.55,
        }}
      >
        Add your first task. It is saved on this computer.${' '}${HINTS[view] ?? HINTS.tasks}
      </p>
      <${Button} size="sm" type="button" onClick=${onCreate}>
        <${Icon} name="plus" size=${12} />
        New task
      </${Button}>
    </div>
  `;
}
