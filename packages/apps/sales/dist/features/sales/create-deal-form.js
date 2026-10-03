// Inline "New deal" form. Opens in-pane under the header (the no-build pkg has no
// modal primitive). It writes straight to `sales_deals` through host.dbExec, so a
// deal can be added with no AI engine and no chat open.
//
// Only a company name is required. The stage defaults to Lead (or to the column
// the "+" was clicked in); title, value and expected close date are optional and
// are stored only when filled in. The expected close date is what the Forecast
// view groups by.
//
// "Ask the companion to add it" stays as a secondary route for a deal that needs
// research. It needs an AI engine and an open chat, and says so when it cannot
// run, instead of failing silently.
//
// Styling rides inline styles + @ikenga/tokens vars, so this adds no rules to
// the generated sales-css.js string.

import { html, useState, useMutation, useQueryClient } from '../../lib/ui.js';
import { createDeal } from '../../lib/deals-db.js';
import { askCompanionToAddDeal } from '../../lib/companion.js';
import { toNumber } from '../../lib/forecast.js';

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

const optionalStyle = { textTransform: 'none', letterSpacing: 0 };

/**
 * @param {{
 *   stages: string[],
 *   stageLabels: Record<string, string>,
 *   initialStage?: string,
 *   operatorId?: string | null,
 *   onClose: () => void,
 * }} props
 *   operatorId: who owns a deal added here (hostContext.operator); null when the
 *   shell did not report one, in which case the deal is stored with no owner.
 */
export function CreateDealForm({ stages, stageLabels, initialStage, operatorId = null, onClose }) {
  const queryClient = useQueryClient();
  const [company, setCompany] = useState('');
  const [stage, setStage] = useState(stages.includes(initialStage) ? initialStage : stages[0]);
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [expectedClose, setExpectedClose] = useState('');
  const [ask, setAsk] = useState(/** @type {{ status: string, message?: string } | null} */ (null));

  const valueNumber = toNumber(value);
  const valueInvalid = value.trim() !== '' && (valueNumber == null || valueNumber < 0);

  const create = useMutation({
    mutationFn: () =>
      createDeal({
        company,
        stage,
        title,
        value: valueNumber,
        expectedClose,
        owner: operatorId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      onClose();
    },
  });

  const canSubmit = company.trim().length > 0 && !valueInvalid && !create.isPending;

  /** @param {Event} e */
  function onSubmit(e) {
    e.preventDefault();
    if (canSubmit) create.mutate();
  }

  async function onAsk() {
    setAsk({ status: 'sending' });
    const result = await askCompanionToAddDeal({
      company: company.trim(),
      stageLabel: stageLabels[stage] ?? stage,
    });
    setAsk(result.ok ? { status: 'sent' } : { status: 'failed', message: result.message });
  }

  return html`
    <form
      class="sl-new-deal"
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
      <div style=${{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style=${{ flex: '2 1 220px' }}>
          <label style=${labelStyle} htmlFor="sl-nd-company">Company</label>
          <input
            id="sl-nd-company"
            type="text"
            value=${company}
            autoFocus=${true}
            onInput=${(e) => setCompany(e.target.value)}
            placeholder="Who is the deal with?"
            style=${fieldStyle}
          />
        </div>
        <div style=${{ flex: '1 1 140px' }}>
          <label style=${labelStyle} htmlFor="sl-nd-stage">Stage</label>
          <select id="sl-nd-stage" value=${stage} onChange=${(e) => setStage(e.target.value)} style=${fieldStyle}>
            ${stages.map((s) => html`<option key=${s} value=${s}>${stageLabels[s] ?? s}</option>`)}
          </select>
        </div>
      </div>

      <div style=${{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style=${{ flex: '2 1 220px' }}>
          <label style=${labelStyle} htmlFor="sl-nd-title">Deal <span style=${optionalStyle}>(optional)</span></label>
          <input
            id="sl-nd-title"
            type="text"
            value=${title}
            onInput=${(e) => setTitle(e.target.value)}
            placeholder="What is it for?"
            style=${fieldStyle}
          />
        </div>
        <div style=${{ flex: '1 1 110px' }}>
          <label style=${labelStyle} htmlFor="sl-nd-value">Value, USD <span style=${optionalStyle}>(optional)</span></label>
          <input
            id="sl-nd-value"
            type="number"
            min="0"
            step="any"
            value=${value}
            onInput=${(e) => setValue(e.target.value)}
            style=${fieldStyle}
          />
        </div>
        <div style=${{ flex: '1 1 140px' }}>
          <label style=${labelStyle} htmlFor="sl-nd-close">Expected close <span style=${optionalStyle}>(optional)</span></label>
          <input
            id="sl-nd-close"
            type="date"
            value=${expectedClose}
            onInput=${(e) => setExpectedClose(e.target.value)}
            style=${fieldStyle}
          />
        </div>
      </div>

      ${valueInvalid && html`
        <p role="alert" style=${{ color: 'var(--danger)', fontSize: 11, margin: 0 }}>
          Value must be a number, zero or more.
        </p>
      `}
      ${create.isError && html`
        <p role="alert" style=${{ color: 'var(--danger)', fontSize: 11, margin: 0 }}>
          Could not add the deal: ${(/** @type {Error} */ (create.error)).message}
        </p>
      `}
      ${ask?.status === 'failed' && html`
        <p role="alert" style=${{ color: 'var(--danger)', fontSize: 11, margin: 0 }}>${ask.message}</p>
      `}
      ${ask?.status === 'sent' && html`
        <p role="status" style=${{ color: 'var(--fg-muted)', fontSize: 11, margin: 0 }}>
          Sent to the companion. The deal appears here once it has been added.
        </p>
      `}

      <div style=${{ display: 'flex', gap: 6, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          class="btn btn-sm btn-ghost"
          type="button"
          disabled=${ask?.status === 'sending'}
          title="Needs an AI engine and an open chat session"
          onClick=${onAsk}
        >${ask?.status === 'sending' ? 'Sending…' : 'Ask the companion to add it'}</button>
        <div style=${{ display: 'flex', gap: 6 }}>
          <button class="btn btn-sm btn-outline" type="button" onClick=${onClose}>Cancel</button>
          <button class="btn btn-sm btn-primary" type="submit" disabled=${!canSubmit}>
            ${create.isPending ? 'Adding…' : 'Add deal'}
          </button>
        </div>
      </div>
    </form>
  `;
}
