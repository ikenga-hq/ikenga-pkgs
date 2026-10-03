// Inline create-task form — opens in-pane under the header (no modal primitive
// in this no-build pkg). Collects title / owner / priority / due (+ optional
// description) and INSERTs via the createTask write helper (host.dbExec). On
// success it invalidates the task list cache and closes.
//
// Styling rides inline styles + @ikenga/tokens vars (same approach as the
// detail pane's status <select>), so this adds no rules to the inlined
// tasks-css.js string (which drifts from tasks.css — see project memory).

import {
  html,
  Icon,
  Button,
  useState,
  useMutation,
  useQueryClient,
} from '../../lib/ui.js';
import { queryKeys } from '../../lib/query-keys.js';
import { createTask } from '../../lib/queries.js';
import { assigneeOptions } from '../../lib/assignees.js';
import { getContext } from '../../lib/bridge.js';

/** @type {import('../../lib/queries.js').TaskPriority[]} */
const PRIORITIES = ['critical', 'high', 'medium', 'low'];

const fieldStyle = {
  height: 28,
  fontSize: 11.5,
  padding: '0 8px',
  background: 'var(--bg-base)',
  border: '1px solid var(--border-soft)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--fg)',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};

const labelStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-faint)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: 4,
};

/**
 * @param {{ onClose: () => void, operatorId?: string | null }} props
 *   operatorId: who "Me" is (hostContext.operator); null when the shell did not
 *   report one — then the task is stored with no creator and "Me" is not offered.
 */
export function CreateTaskForm({ onClose, operatorId = null }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(''); // '' = unassigned
  const [priority, setPriority] = useState(/** @type {string} */ ('medium'));
  const [due, setDue] = useState(''); // 'YYYY-MM-DD' from <input type=date>
  const [description, setDescription] = useState('');

  const options = assigneeOptions(getContext(), operatorId);

  const create = useMutation({
    mutationFn: async () => {
      const picked = options.find((o) => o.value === owner);
      await createTask({
        title: title.trim(),
        assignedTo: owner || null,
        assigneeType: picked ? picked.type : null,
        priority: /** @type {import('../../lib/queries.js').TaskPriority} */ (priority),
        // Store an ISO timestamp so it sorts/groups alongside existing rows.
        dueDate: due ? new Date(due).toISOString() : null,
        description: description.trim() || null,
        createdBy: operatorId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      onClose();
    },
  });

  const canSubmit = title.trim().length > 0 && !create.isPending;

  /** @param {Event} e */
  function onSubmit(e) {
    e.preventDefault();
    if (canSubmit) create.mutate();
  }

  return html`
    <form
      onSubmit=${onSubmit}
      style=${{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 'var(--space-4) var(--space-5)',
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--bg-sunken)',
      }}
    >
      <div>
        <label style=${labelStyle}>Title</label>
        <input
          type="text"
          value=${title}
          autofocus
          onInput=${(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          style=${fieldStyle}
        />
      </div>

      <div style=${{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style=${{ flex: '1 1 180px' }}>
          <label style=${labelStyle}>Owner</label>
          <select value=${owner} onChange=${(e) => setOwner(e.target.value)} style=${fieldStyle}>
            <option value="">Unassigned</option>
            ${options.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
          </select>
        </div>
        <div style=${{ flex: '1 1 120px' }}>
          <label style=${labelStyle}>Priority</label>
          <select value=${priority} onChange=${(e) => setPriority(e.target.value)} style=${fieldStyle}>
            ${PRIORITIES.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
          </select>
        </div>
        <div style=${{ flex: '1 1 140px' }}>
          <label style=${labelStyle}>Due</label>
          <input type="date" value=${due} onInput=${(e) => setDue(e.target.value)} style=${fieldStyle} />
        </div>
      </div>

      <div>
        <label style=${labelStyle}>Description <span style=${{ textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
        <textarea
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
          rows=${2}
          placeholder="Context, links, acceptance criteria…"
          style=${{ ...fieldStyle, height: 'auto', padding: '6px 8px', resize: 'vertical' }}
        ></textarea>
      </div>

      ${create.isError && html`
        <p style=${{ color: 'var(--danger)', fontSize: 11, margin: 0 }}>
          Failed: ${(/** @type {Error} */ (create.error)).message}
        </p>
      `}

      <div style=${{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <${Button} variant="outline" size="sm" type="button" onClick=${onClose}>Cancel</${Button}>
        <${Button} size="sm" type="submit" disabled=${!canSubmit}>
          <${Icon} name=${create.isPending ? 'loader' : 'check'} size=${12} className=${create.isPending ? 'tk-spin' : undefined} />
          ${create.isPending ? 'Creating…' : 'Create task'}
        </${Button}>
      </div>
    </form>
  `;
}
