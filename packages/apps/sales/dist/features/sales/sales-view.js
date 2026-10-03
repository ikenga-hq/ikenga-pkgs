// Sales main view — Pipeline (list + kanban) / Forecast / Won.
//
// Composition follows plans/atelier-design-system/parts/screens/sales.md §§1–4:
//   Views: ?view=0 Pipeline (list default + kanban toggle) | ?view=1 Forecast | ?view=2 Won
//
//   Kit parts consumed:
//   - .frame / .frame-head / .frame-body-flush (part 30 pkg-pane-frame)
//   - .ip-split / .ip-split-list / .ip-split-divider / .ip-split-pane (part 25 inspector-detail)
//   - .split-row / .split-row-* / .split-group / .split-detail / .split-detail-* (list-detail)
//   - .dense-row.dense-row--pipeline / .dense-row-* (part 20 table-dense-row)
//   - .kb-board / .kb-col / .kb-card / .kb-mini-avatar / .kb-add (part 28 kanban)
//   - .nav-group[data-kind] / .nav-item / .nav-item.is-on / .nav-item.is-hot (part 22)
//   - .seg.nav-view-seg / .seg button.is-on (part 14 segmented-tabs, list-kanban-switch)
//   - .atelier-state.is-{loading,empty,error} / .atelier-spin (part 26 feedback-state)
//   - .stage-chip / .next-chip / .ux-dot / .badge / .tag / .chip (part 11 badge-tag-chip)
//   - .btn / .btn-icon / .btn-sm / .btn.affirmative (part 10 buttons)
//
//   Domain-local (sales.css .sl-*):
//   - .sl-forecast-* / .sl-kpi-* / .sl-funnel-* / .sl-month-* (Forecast view)
//   - .sl-won-* / .sl-won-badge / .sl-won-amt (Won view)
//   - .ux-dot.ux-{confirm,silent,approve} / .next-chip / .stage-chip / .split-* overrides
//
// Data: host.dbQuery + host.dbExec via AppBridge. TanStack Query for caching.
// Migration: 0043_sales_domain.sql — app-layer columns (title, owner, next_action,
//   next_action_mode, win_probability) on sales_deals. Stage enum: lead → qualified →
//   proposal → negotiation → closing → won | lost.
//
// A fresh install has an empty table, and the views say so: no row, field or
// number here is ever invented. An empty or failed load shows the empty or error
// state, never made-up deals.

import {
  html, cn, Icon,
  useState, useEffect, useMemo, useCallback,
  useQuery, useMutation, useQueryClient,
} from '../../lib/ui.js';
import { hostDbQuery, setMenu, isStandalone } from '../../lib/bridge.js';
// dispatch-wire recipe: deal-detail "Approve & run"/"Confirm & run" seed a
// structured next-action turn into the active Chi. buildActionPrompt is the
// shared prompt builder; the send itself goes through lib/companion.js, which
// reports a refusal (no chat open, no engine) instead of swallowing it.
import { buildActionPrompt } from '../../lib/dispatch.js';
// facet-wire recipe: sidebar filter facets (f:*) narrow the pipeline list/kanban.
import { applyFacet } from '../../lib/facet-filter.js';
// operator-identity recipe: hostContext.operator threaded down from app.js —
// "mine" predicates/fallbacks fail safe (empty/unclaimed) when unknown.
import { isMine, initialOf } from '../../lib/operator.js';
import { sendToCompanion, askCompanionToAddDeal } from '../../lib/companion.js';
import {
  setDealStage, loadSamplePipeline, removeSampleData, countSampleDeals, countLostDeals,
} from '../../lib/deals-db.js';
import { SAMPLE_SOURCE } from '../../lib/sample-pipeline.js';
import {
  toNumber, dealValue, winProbability, weightedTotals, monthlyForecast, monthLabel,
} from '../../lib/forecast.js';
import { CreateDealForm } from './create-deal-form.js';

// ─── Stage enum ───────────────────────────────────────────────────────────────
// Per the R-04 Pipeline-stages convention (06-skill-action-contract.md §Pipeline-stages).
// Defined + documented here as the owning pkg (the domain WP defines the enum in README).
// Terminals: won | lost. Won view = sales_deals WHERE stage = 'won'.

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'closing'];
const TERMINAL_STAGES = ['won', 'lost'];

/** Tolerant grouping (founder call 2026-06-06, WP-18b live-verify follow-up):
 *  rows with a non-enum stage render as their own visible group/column (raw
 *  value as label) instead of silently vanishing from the stage-grouped views.
 *  0045_sales_stage_backfill maps known legacy values; this guards the rest. */
function stagesWithExtras(grouped) {
  const extras = Object.keys(grouped)
    .filter((s) => !STAGES.includes(s) && grouped[s].length > 0)
    .sort();
  return [...STAGES, ...extras];
}

const STAGE_LABEL = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  closing: 'Closing',
  won: 'Won',
  lost: 'Lost',
};

// ─── Query keys ───────────────────────────────────────────────────────────────

const QK = {
  openDeals:     ['sales', 'deals', 'open'],
  wonDeals:      ['sales', 'deals', 'won'],
  lostCount:     ['sales', 'deals', 'lost-count'],
  sampleCount:   ['sales', 'sample-count'],
  forecasts:     ['sales', 'forecasts'],
  activities:    (dealId) => ['sales', 'activities', dealId],
};

// ─── Data fetchers ────────────────────────────────────────────────────────────
// A failed read throws, so the view shows its error state with a Retry. An empty
// table returns [] and the view shows the empty state. Neither case is ever
// papered over with made-up rows.

/** Whole days a deal has spent at its current stage: from stage_entered_date when
 *  it parses, else the stored days_in_stage, else unknown (null). */
function ageDays(row) {
  const entered = Date.parse(row.stage_entered_date ?? '');
  if (Number.isFinite(entered)) return Math.max(0, Math.floor((Date.now() - entered) / 86_400_000));
  return row.days_in_stage ?? null;
}

async function fetchOpenDeals() {
  const rows = await hostDbQuery(
    `SELECT id, company, contact_name, contact_email, stage, value, currency, score,
            last_contact, assigned_to, notes, source, loss_reason, description,
            title, owner, next_action, next_action_mode, win_probability,
            days_in_stage, stage_entered_date, expected_close_date
     FROM sales_deals
     WHERE stage NOT IN ('won', 'lost')
     ORDER BY COALESCE(last_contact, updated_at, created_at, '') DESC`
  );
  return rows.map((r) => ({
    ...r,
    title: r.title ?? r.company,
    owner: r.owner ?? r.assigned_to ?? null,
    age_days: ageDays(r),
    value: toNumber(r.value),
    is_sample: r.source === SAMPLE_SOURCE,
  }));
}

async function fetchWonDeals(operatorId) {
  const rows = await hostDbQuery(
    `SELECT id, company, contact_name, stage, value, currency, source, assigned_to,
            last_contact, owner, title
     FROM sales_deals
     WHERE stage = 'won'
     ORDER BY last_contact DESC`
  );
  return rows.map((r) => ({
    ...r,
    title: r.title ?? r.company,
    owner: r.owner ?? r.assigned_to ?? operatorId ?? null,
    closed: r.last_contact ? r.last_contact.substring(0, 10) : '—',
    value: toNumber(r.value),
    is_sample: r.source === SAMPLE_SOURCE,
  }));
}

async function fetchActivities(dealId) {
  if (isStandalone() || !dealId) return [];
  try {
    return await hostDbQuery(
      `SELECT id, activity_type, title, description, performed_by, activity_date
       FROM sales_activities
       WHERE deal_id = ?
       ORDER BY activity_date DESC
       LIMIT 3`,
      [dealId]
    );
  } catch {
    return [];
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCurrency(v) {
  if (!v && v !== 0) return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(v) {
  if (v == null) return '—';
  return `${Math.round(v * 100)}%`;
}

// ─── dispatch-wire (RECIPE 1) ─────────────────────────────────────────────────
// Map a deal row into the recipe-shared descriptor, then seed a next-action turn
// into the active Chi. A deal is agent-shaped, so "Approve & run"/"Confirm & run"
// dispatch a structured turn (host.sendToActiveSession) rather than committing
// headlessly — there is no domain-run verb today (see lib/dispatch.js APPROVE-RUN GAP).

function dealToDispatchItem(deal) {
  return {
    kind: 'deal',
    title: deal.title ?? deal.company,
    stage: STAGE_LABEL[deal.stage] ?? deal.stage,
    nextAction: deal.next_action,
    facts: [
      ['Company', deal.company],
      ['Owner', deal.owner ?? deal.assigned_to],
      ['Value', deal.value != null ? fmtCurrency(deal.value) : null],
    ],
  };
}

/** Hand the deal's next action to the companion. Resolves with the outcome so
 *  the detail pane can say when nothing was sent (no chat open, no engine). */
function handleAction(deal) {
  const mode = deal.next_action_mode === 'approve' ? 'approve' : 'confirm';
  return sendToCompanion(buildActionPrompt(dealToDispatchItem(deal), mode));
}

// ─── facet-wire (RECIPE 2) ────────────────────────────────────────────────────
// Sales' "all" affordance is 'f:open-pipeline' (not the generic 'f:all'), so the
// reset id is passed explicitly to applyFacet. Each predicate expression MIRRORS
// its badge-count expression in buildSalesMenu so a facet's slice always matches
// the count shown on its row (facet-wire pitfall 2).

const SALES_RESET_FACET = 'f:open-pipeline';

/** operatorId-parameterized so 'f:my-deals' fails safe (matches nothing) when
 *  the operator is unknown — see lib/operator.js. */
function salesFacetPredicates(operatorId) {
  return {
    'f:my-deals':     (d) => isMine(d.owner, operatorId) || isMine(d.assigned_to, operatorId),
    'f:closing-soon': (d) => d.next_action_mode === 'approve',
    'f:agent-run':    (d) => d.owner === 'sales-agent' || d.assigned_to === 'sales-agent',
    ...Object.fromEntries(STAGES.map((s) => [`f:stage:${s}`, (d) => d.stage === s])),
    // 'f:open-pipeline' intentionally ABSENT → SALES_RESET_FACET returns every deal.
  };
}

// ─── Menu builder ─────────────────────────────────────────────────────────────

/**
 * Build the sidebar menu items for setMenu.
 *   activeView: 0 = Pipeline | 1 = Forecast | 2 = Won
 *   pipeMode: 'list' | 'kanban' (only relevant when activeView === 0)
 *   deals: the open deals array (for counts)
 *   operatorId: current known operator id (null when unknown — see lib/operator.js)
 */
function buildSalesMenu(activeView, pipeMode, deals, activeFacet, operatorId) {
  const openCount = deals.length;
  const myDeals = deals.filter((d) => isMine(d.owner, operatorId) || isMine(d.assigned_to, operatorId));
  const closingSoon = deals.filter((d) => d.next_action_mode === 'approve');
  const agentRun = deals.filter((d) => (d.owner === 'sales-agent' || d.assigned_to === 'sales-agent'));
  // A facet only highlights on the Pipeline view (facets dim/inert off it).
  const facetActive = (id) => activeView === 0 && activeFacet === id;

  const viewItems = [
    {
      id: 'v:pipeline',
      label: 'Pipeline',
      icon: 'trending-up',
      section: 'View',
      active: activeView === 0,
      badge: openCount > 0 ? openCount : undefined,
    },
    {
      id: 'v:forecast',
      label: 'Forecast',
      icon: 'dollar-sign',
      section: 'View',
      active: activeView === 1,
    },
    {
      id: 'v:won',
      label: 'Won',
      icon: 'check-circle',
      section: 'View',
      active: activeView === 2,
    },
  ];

  // Seg control injected as a synthetic menu item when activeView === 0.
  // The shell side-menu renders items with kind="seg" as an inline segmented control.
  // We encode it as a special item the shell knows about (list-kanban-switch part §2).
  const segItem = activeView === 0
    ? [{
        id: 'seg:list-kanban',
        kind: 'seg',
        section: 'View',
        options: [
          // Option ids ARE the activeFeature values the shell publishes back
          // (PkgMenuItem kind:'seg' contract — pkg-menu-store.ts).
          { id: 'seg:list',   label: 'List',   active: pipeMode === 'list' },
          { id: 'seg:kanban', label: 'Kanban', active: pipeMode === 'kanban' },
        ],
      }]
    : [];

  const filterItems = [
    {
      id: 'f:open-pipeline',
      label: 'Open pipeline',
      icon: 'layers',
      section: 'Filters',
      active: facetActive('f:open-pipeline'),
      badge: openCount,
      disabled: activeView !== 0,
    },
    {
      id: 'f:my-deals',
      label: 'My deals',
      icon: 'user',
      section: 'Filters',
      active: facetActive('f:my-deals'),
      badge: myDeals.length || undefined,
      disabled: activeView !== 0,
    },
    {
      id: 'f:closing-soon',
      label: 'Closing soon',
      icon: 'zap',
      section: 'Filters',
      active: facetActive('f:closing-soon'),
      hot: closingSoon.length > 0,
      badge: closingSoon.length > 0 ? closingSoon.length : undefined,
      disabled: activeView !== 0,
    },
    {
      id: 'f:agent-run',
      label: 'Agent-run',
      icon: 'cpu',
      section: 'Filters',
      active: facetActive('f:agent-run'),
      badge: agentRun.length || undefined,
      disabled: activeView !== 0,
    },
  ];

  const stageItems = STAGES.map((s) => ({
    id: `f:stage:${s}`,
    label: STAGE_LABEL[s],
    section: 'By stage',
    active: facetActive(`f:stage:${s}`),
    badge: deals.filter((d) => d.stage === s).length || undefined,
    disabled: activeView !== 0,
  }));

  return [...viewItems, ...segItem, ...filterItems, ...stageItems];
}

// ─── Sub-components ────────────────────────────────────────────────────────────

/** The deal that heads the stage-grouped list, so the detail pane opens on the
 *  row the person sees first. */
function firstInListOrder(deals) {
  const grouped = {};
  for (const s of STAGES) grouped[s] = [];
  for (const d of deals) (grouped[d.stage] ??= []).push(d);
  for (const s of stagesWithExtras(grouped)) if (grouped[s].length > 0) return grouped[s][0];
  return null;
}

/** Single deal row in list mode */
function DealRow({ deal, isSelected, onClick }) {
  const isUrgent = (deal.age_days ?? 0) > 30;
  return html`
    <div
      class=${cn('split-row dense-row dense-row--pipeline', isSelected && 'is-selected')}
      role="row"
      tabIndex=${0}
      onClick=${onClick}
      onKeyDown=${(e) => e.key === 'Enter' && onClick()}
    >
      <span class="split-row-accent" aria-hidden="true"></span>
      <div class="split-row-body dense-row-body">
        <div class="split-row-title dense-row-title">${deal.title ?? deal.company}</div>
        <div class="split-row-sub dense-row-sub">
          ${deal.company}
          ${deal.owner ? html` · <span>${deal.owner === 'sales-agent' ? '⚡ sales-agent' : deal.owner}</span>` : null}
          ${deal.is_sample ? html` <span class="tag">Sample</span>` : null}
        </div>
        ${deal.next_action ? html`
          <div class="split-row-sub">
            <span class="next-chip">
              <span class=${cn('ux-dot', `ux-${deal.next_action_mode ?? 'silent'}`)}></span>
              ${deal.next_action}
            </span>
          </div>
        ` : null}
      </div>
      <div class="split-row-right dense-row-right">
        <span class="split-row-amt dense-row-amt">${fmtCurrency(deal.value)}</span>
        <span class=${cn('split-row-when dense-row-due', isUrgent && 'is-urgent')}>
          ${deal.age_days != null ? `${deal.age_days}d` : ''}
        </span>
      </div>
    </div>
  `;
}

/** Deal detail pane */
function DealDetail({ deal, activities }) {
  // dispatch-wire — local feedback. 'sent' only once the host accepted the
  // request, so the same click can't double-seed the session; a refusal (no chat
  // open, no engine) shows its message instead of pretending it landed. Resets
  // when the selected deal changes.
  const [send, setSend] = useState({ status: 'idle' });
  useEffect(() => { setSend({ status: 'idle' }); }, [deal?.id]);
  const sent = send.status === 'sent';

  if (!deal) {
    return html`<div class="ip-split-pane split-detail" style=${{ display:'flex', alignItems:'center', justifyContent:'center', color:'var(--fg-muted)', fontSize:'0.85rem' }}>
      Select a deal
    </div>`;
  }

  const hasApprove = deal.next_action_mode === 'approve';
  const hasConfirm = deal.next_action_mode === 'confirm';
  const showButton = hasApprove || hasConfirm;
  const onAct = async () => {
    setSend({ status: 'sending' });
    const result = await handleAction(deal);
    setSend(result.ok ? { status: 'sent' } : { status: 'failed', message: result.message });
  };

  return html`
    <div class="ip-split-pane split-detail" style=${{ overflowY:'auto' }}>
      <div class="split-detail-wrap">
        <div class="split-detail-eyebrow">
          <span class="stage-chip">${STAGE_LABEL[deal.stage] ?? deal.stage}</span>
          ${deal.is_sample ? html`<span class="tag">Sample</span>` : null}
          ${deal.next_action_mode ? html`
            <span class="next-chip">
              <span class=${cn('ux-dot', `ux-${deal.next_action_mode}`)}></span>
              ux_mode · ${deal.next_action_mode}
            </span>
          ` : null}
        </div>
        <div class="split-detail-title">${deal.title ?? deal.company}</div>
        <div class="split-detail-sub">${deal.company}${deal.owner ? ` · ${deal.owner}` : ''}</div>

        <div class="split-facts">
          <div><div class="split-fact-k">Value</div><div class="split-fact-v">${fmtCurrency(deal.value)}</div></div>
          <div><div class="split-fact-k">Stage</div><div class="split-fact-v">${STAGE_LABEL[deal.stage] ?? deal.stage}</div></div>
          <div><div class="split-fact-k">Win prob.</div><div class="split-fact-v">${fmtPct(deal.win_probability)}</div></div>
          <div><div class="split-fact-k">Age</div><div class="split-fact-v">${deal.age_days != null ? `${deal.age_days}d` : '—'}</div></div>
        </div>

        ${deal.next_action ? html`
          <div class="split-next">
            <div class="split-next-head">
              <span class=${cn('ux-dot', `ux-${deal.next_action_mode ?? 'silent'}`)}></span>
              Next action
            </div>
            <div class="split-next-body">
              ${deal.next_action}
              ${showButton ? html`
                <div style=${{ marginTop: '10px' }}>
                  <button
                    class=${cn('btn', hasApprove ? 'affirmative' : '')}
                    type="button"
                    disabled=${sent || send.status === 'sending'}
                    onClick=${onAct}
                  >
                    ${sent ? 'Sent to your Chi' : send.status === 'sending' ? 'Sending…' : hasApprove ? 'Approve & run' : 'Confirm & run'}
                  </button>
                  ${send.status === 'failed' ? html`
                    <div role="alert" style=${{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--danger)' }}>${send.message}</div>
                  ` : null}
                </div>
              ` : null}
            </div>
          </div>
        ` : null}

        ${activities && activities.length > 0 ? html`
          <div class="split-next-head" style=${{ marginTop:'12px' }}>Activity</div>
          <div class="split-timeline" role="list">
            ${activities.map((a) => html`
              <div class="split-tl-row" role="listitem" key=${a.id}>
                <span class="split-tl-dot" aria-hidden="true"></span>
                <div class="split-tl-body">
                  <div class="split-tl-title">${a.title ?? a.activity_type}</div>
                  <div class="split-tl-when">${a.activity_date ? a.activity_date.substring(0,10) : ''} · ${a.performed_by ?? ''}</div>
                </div>
              </div>
            `)}
          </div>
        ` : null}
      </div>
    </div>
  `;
}

/** Pipeline list mode */
function PipelineList({ deals, selectedDeal, onSelectDeal, activities }) {
  const grouped = useMemo(() => {
    const map = {};
    for (const s of STAGES) map[s] = [];
    for (const d of deals) {
      if (map[d.stage]) map[d.stage].push(d);
      else map[d.stage] = [d];
    }
    return map;
  }, [deals]);

  return html`
    <div class="ip-split" style=${{ height:'100%' }}>
      <div class="ip-split-list" style=${{ overflowY:'auto' }} role="grid" aria-label="Sales pipeline list">
        <div class="sl-list-head">
          <span class="sl-list-title">Sales</span>
          <span class="sl-list-meta">${deals.length} open</span>
        </div>
        ${stagesWithExtras(grouped).map((s) => grouped[s]?.length > 0 ? html`
          <div class="split-group" key=${s}>
            <div class="split-group-head">${STAGE_LABEL[s] ?? s} · ${grouped[s].length}</div>
            ${grouped[s].map((d) => html`
              <${DealRow}
                key=${d.id}
                deal=${d}
                isSelected=${selectedDeal?.id === d.id}
                onClick=${() => onSelectDeal(d)}
              />
            `)}
          </div>
        ` : null)}
      </div>
      <div class="ip-split-divider" role="separator" aria-hidden="true"></div>
      <${DealDetail} deal=${selectedDeal} activities=${activities} />
    </div>
  `;
}

/** Kanban mini-avatar */
function KbAvatar({ owner }) {
  const isAgent = owner === 'sales-agent';
  const initial = isAgent ? 'S' : initialOf(owner);
  return html`<span class=${cn('kb-mini-avatar', isAgent && 'is-agent')} aria-label=${owner ?? ''}>${initial}</span>`;
}

/** Pipeline kanban mode */
function PipelineKanban({ deals, onStageChange, onCreate }) {
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const grouped = useMemo(() => {
    const map = {};
    for (const s of STAGES) map[s] = [];
    for (const d of deals) {
      if (map[d.stage]) map[d.stage].push(d);
      else map[d.stage] = [d];
    }
    return map;
  }, [deals]);

  function onDragStart(d) { setDragging(d); }
  function onDragOver(e, s) { e.preventDefault(); setDropTarget(s); }
  function onDrop(e, s) {
    e.preventDefault();
    if (dragging && dragging.stage !== s) onStageChange(dragging, s);
    setDragging(null);
    setDropTarget(null);
  }
  function onDragEnd() { setDragging(null); setDropTarget(null); }

  return html`
    <div class="kb-board-wrap">
      <div class="kb-board" role="region" aria-label="Sales pipeline board">
        ${stagesWithExtras(grouped).map((s) => {
          const stagDeals = grouped[s] ?? [];
          const totalVal = stagDeals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);
          return html`
            <div
              key=${s}
              class=${cn('kb-col', dropTarget === s && 'is-drop-target')}
              data-stage=${s}
              onDragOver=${(e) => onDragOver(e, s)}
              onDrop=${(e) => onDrop(e, s)}
              role="region"
              aria-label=${'Stage: ' + (STAGE_LABEL[s] ?? s)}
            >
              <div class="kb-col-head">
                <span class="kb-col-dot" aria-hidden="true"></span>
                <span class="kb-col-name">${STAGE_LABEL[s] ?? s}</span>
                <span class="kb-col-meta">${stagDeals.length} · ${fmtCurrency(totalVal)}</span>
              </div>
              <div class="kb-col-body">
                ${stagDeals.map((d) => html`
                  <div
                    key=${d.id}
                    class=${cn('kb-card', dragging?.id === d.id && 'is-dragging')}
                    draggable="true"
                    onDragStart=${() => onDragStart(d)}
                    onDragEnd=${onDragEnd}
                    tabIndex=${0}
                  >
                    <div class="kb-card-title">${d.title ?? d.company}</div>
                    <div class="kb-card-sub">${d.company}${d.is_sample ? html` <span class="tag">Sample</span>` : null}</div>
                    <div class="kb-card-foot">
                      <span class="kb-card-amt">${fmtCurrency(d.value)}</span>
                      <div class="kb-card-owner">
                        <span class=${cn('ux-dot', `ux-${d.next_action_mode ?? 'silent'}`)}></span>
                        <${KbAvatar} owner=${d.owner ?? d.assigned_to} />
                      </div>
                    </div>
                  </div>
                `)}
                <button
                  class="kb-add btn-icon"
                  type="button"
                  aria-label=${'Add deal to ' + (STAGE_LABEL[s] ?? s)}
                  onClick=${() => onCreate?.(s)}
                >+</button>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

/** Forecast view.
 *  Every figure comes from the open deals in the table. A deal with no win
 *  probability is left out of the weighted figures (and the pane says how many
 *  were), and the month chart is built only from expected close dates that are
 *  actually set; with none, it asks for them instead of drawing a chart. */
function ForecastView({ deals }) {
  const kpis = useMemo(() => {
    const openPipeline = deals.reduce((s, d) => s + dealValue(d), 0);
    const { weighted, withProbability } = weightedTotals(deals);
    const commit = deals
      .filter((d) => (d.stage === 'closing' || d.stage === 'negotiation') && (winProbability(d) ?? 0) >= 0.70)
      .reduce((s, d) => s + dealValue(d), 0);
    return { openPipeline, weighted, withProbability, commit };
  }, [deals]);

  const funnelRows = useMemo(() => {
    const byStage = STAGES.map((s) => {
      const inStage = deals.filter((d) => d.stage === s);
      const total = inStage.reduce((sum, d) => sum + dealValue(d), 0);
      const wt = inStage.reduce((sum, d) => sum + dealValue(d) * (winProbability(d) ?? 0), 0);
      return { stage: s, total, wt };
    });
    const maxVal = Math.max(...byStage.map((r) => r.total), 1);
    return byStage.map((r) => ({ ...r, pctTotal: r.total / maxVal, pctWt: r.wt / maxVal }));
  }, [deals]);

  // Expected close by month: derived from expected_close_date, never constants.
  const months = useMemo(() => monthlyForecast(deals), [deals]);
  const maxMonthVal = Math.max(...months.map((m) => m.value), 1);
  const spansYears = months.length > 0 && months[0].year !== months[months.length - 1].year;

  const allWeighted = kpis.withProbability === deals.length;

  return html`
    <div class="sl-forecast-wrap frame-body-flush">
      <div class="sl-forecast-kpis">
        <div class="sl-forecast-kpi">
          <span class="sl-kpi-k">Open pipeline</span>
          <span class="sl-kpi-v">${fmtCurrency(kpis.openPipeline)}</span>
          <span class="sl-kpi-sub">${deals.length} open ${deals.length === 1 ? 'deal' : 'deals'}</span>
        </div>
        <div class="sl-forecast-kpi">
          <span class="sl-kpi-k">Weighted</span>
          <span class="sl-kpi-v">${kpis.withProbability > 0 ? fmtCurrency(kpis.weighted) : '—'}</span>
          <span class="sl-kpi-sub">${
            kpis.withProbability === 0
              ? 'no win probabilities set'
              : allWeighted
                ? 'by win prob.'
                : `by win prob. · ${kpis.withProbability} of ${deals.length} deals`
          }</span>
        </div>
        <div class="sl-forecast-kpi">
          <span class="sl-kpi-k">Commit</span>
          <span class="sl-kpi-v">${fmtCurrency(kpis.commit)}</span>
          <span class="sl-kpi-sub">closing + neg ≥70%</span>
        </div>
      </div>

      <div class="sl-forecast-card">
        <div class="sl-forecast-card-h">Weighted by stage</div>
        ${funnelRows.map((r) => html`
          <div class="sl-funnel-row" key=${r.stage}>
            <span class="sl-funnel-name">${STAGE_LABEL[r.stage]}</span>
            <div class="sl-funnel-bar">
              <div class="sl-funnel-bar-fill" style=${{ width: `${r.pctTotal * 100}%` }}></div>
              <div class="sl-funnel-bar-wt"  style=${{ width: `${r.pctWt * 100}%` }}></div>
            </div>
            <span class="sl-funnel-val">${fmtCurrency(r.total)} · ${fmtCurrency(r.wt)}</span>
          </div>
        `)}
      </div>

      <div class="sl-forecast-card">
        <div class="sl-forecast-card-h">Expected close by month</div>
        ${months.length === 0 ? html`
          <div class="sl-forecast-note">Add expected close dates to see a forecast</div>
        ` : html`
          <div class="sl-months">
            ${months.map((m) => html`
              <div class="sl-month" key=${m.key} title=${`${m.count} ${m.count === 1 ? 'deal' : 'deals'}`}>
                <span class="sl-month-val">${fmtCurrency(m.value)}</span>
                <div class="sl-month-bar-wrap">
                  <div class="sl-month-bar" style=${{ height: `${Math.round((m.value / maxMonthVal) * 100)}%` }}></div>
                </div>
                <span class="sl-month-lab">${monthLabel(m, spansYears)}</span>
              </div>
            `)}
          </div>
          <div class="sl-forecast-note">Weighted by win probability where one is set; deals without an expected close date are not shown.</div>
        `}
      </div>
    </div>
  `;
}

/** Won view */
function WonView({ wonDeals, lostCount }) {
  const kpis = useMemo(() => {
    const total = wonDeals.reduce((s, d) => s + dealValue(d), 0);
    const avg = wonDeals.length ? total / wonDeals.length : 0;
    const decided = wonDeals.length + lostCount;
    const winRate = decided > 0 ? Math.round((wonDeals.length / decided) * 100) : null;
    return { total, avg, winRate };
  }, [wonDeals, lostCount]);

  return html`
    <div class="sl-won-wrap frame-body-flush">
      <div class="sl-won-kpis">
        <div class="sl-forecast-kpi">
          <span class="sl-kpi-k">Total won</span>
          <span class="sl-kpi-v" style=${{ color: 'var(--live)' }}>${fmtCurrency(kpis.total)}</span>
          <span class="sl-kpi-sub">${wonDeals.length} ${wonDeals.length === 1 ? 'deal' : 'deals'}</span>
        </div>
        <div class="sl-forecast-kpi">
          <span class="sl-kpi-k">Avg deal size</span>
          <span class="sl-kpi-v">${wonDeals.length ? fmtCurrency(kpis.avg) : '—'}</span>
        </div>
        <div class="sl-forecast-kpi">
          <span class="sl-kpi-k">Win rate</span>
          <span class="sl-kpi-v">${kpis.winRate == null ? '—' : `${kpis.winRate}%`}</span>
          <span class="sl-kpi-sub">${wonDeals.length} won · ${lostCount} lost</span>
        </div>
      </div>

      <div class="sl-won-table-wrap">
        <table class="sl-won-table" role="grid" aria-label="Won deals">
          <thead>
            <tr>
              <th>Deal</th>
              <th>Company</th>
              <th>Source</th>
              <th>Owner</th>
              <th>Closed</th>
              <th style=${{ textAlign:'right' }}>Value</th>
            </tr>
          </thead>
          <tbody>
            ${wonDeals.map((d) => html`
              <tr key=${d.id}>
                <td>${d.title ?? d.company}</td>
                <td style=${{ color:'var(--fg-muted)' }}>${d.company}</td>
                <td><span class="sl-won-badge">${d.is_sample ? 'Sample' : (d.source ?? '—')}</span></td>
                <td style=${{ color:'var(--fg-muted)', fontSize:'0.75rem' }}>${d.owner ?? d.assigned_to ?? '—'}</td>
                <td style=${{ color:'var(--fg-muted)', fontFamily:'var(--font-mono)', fontSize:'0.72rem' }}>${d.closed ?? d.last_contact ?? '—'}</td>
                <td style=${{ textAlign:'right' }}><span class="sl-won-amt">${fmtCurrency(d.value)}</span></td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ─── Loading / empty / error states ──────────────────────────────────────────

function LoadingState() {
  return html`
    <div class="atelier-state is-loading" id="view-stage">
      <span class="atelier-spin" aria-hidden="true"></span>
      <span>Loading deals…</span>
    </div>
  `;
}

const noteStyle = { margin: 0, maxWidth: '46ch', fontSize: 'var(--text-body-sm, 0.8rem)', color: 'var(--fg-muted)', lineHeight: 1.55 };

/** First run: the table has no deals at all. Offers the manual form first, the
 *  labelled sample pipeline second, and the companion as a third route. While
 *  the form is open (`formOpen`) it is the call to action, so the buttons step
 *  aside. */
function EmptyState({ onCreate, onLoadSample, onAskCompanion, sampleBusy, formOpen }) {
  return html`
    <div class="atelier-state is-empty" id="view-stage">
      <span>No deals yet</span>
      <p style=${noteStyle}>Add your first deal. It is saved on this computer.</p>
      ${formOpen ? null : html`
        <div style=${{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '4px' }}>
          <button class="btn btn-sm btn-primary" type="button" onClick=${() => onCreate?.()}>New deal</button>
          <button class="btn btn-sm btn-outline" type="button" disabled=${sampleBusy} onClick=${() => onLoadSample?.()}>
            ${sampleBusy ? 'Loading…' : 'Load sample pipeline'}
          </button>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" title="Needs an AI engine and an open chat session" onClick=${() => onAskCompanion?.()}>
          Ask the companion to add it
        </button>
        <p style=${{ ...noteStyle, fontSize: '0.72rem' }}>
          The sample pipeline is made-up data. Every sample deal is labelled, and you can remove them all in one click.
        </p>
      `}
    </div>
  `;
}

/** Deals exist, but the active sidebar filter matches none of them. */
function FilterEmptyState({ onShowAll }) {
  return html`
    <div class="atelier-state is-empty" id="view-stage">
      <span>No deals match this filter</span>
      <button class="btn btn-sm" type="button" style=${{ marginTop: '8px' }} onClick=${() => onShowAll?.()}>Show all deals</button>
    </div>
  `;
}

/** Won view with no won deals (deals exist elsewhere in the pipeline). */
function NoWonYet() {
  return html`
    <div class="atelier-state is-empty" id="view-stage">
      <span>No won deals yet</span>
      <p style=${noteStyle}>A deal is listed here once its stage is Won.</p>
    </div>
  `;
}

/** One-line result of an action the person took (a companion request, loading or
 *  removing sample data). Errors read as errors; both can be dismissed. */
function Notice({ notice, onDismiss }) {
  return html`
    <div
      role=${notice.kind === 'error' ? 'alert' : 'status'}
      style=${{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '6px var(--space-5, 16px)',
        fontSize: '0.75rem',
        borderBottom: '1px solid var(--border-soft)',
        color: notice.kind === 'error' ? 'var(--danger)' : 'var(--fg-muted)',
      }}
    >
      <span style=${{ flex: 1 }}>${notice.text}</span>
      <button class="btn btn-sm btn-ghost" type="button" onClick=${onDismiss}>Dismiss</button>
    </div>
  `;
}

/** Shown on every view while any sample deal is in the table. */
function SampleBanner({ count, onRemove, busy }) {
  return html`
    <div
      class="sl-sample-banner"
      style=${{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '6px var(--space-5, 16px)',
        fontSize: '0.75rem',
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--bg-sunken)',
        color: 'var(--fg-muted)',
      }}
    >
      <span class="tag">Sample</span>
      <span style=${{ flex: 1 }}>
        ${count} sample ${count === 1 ? 'deal is' : 'deals are'} loaded. They are made-up and stored only on this computer.
      </span>
      <button class="btn btn-sm btn-outline" type="button" disabled=${busy} onClick=${onRemove}>
        ${busy ? 'Removing…' : 'Remove sample data'}
      </button>
    </div>
  `;
}

// Error state — design STATES.error (atelier-sales-list.html:1877-1879): alert
// icon + heading + explanation + a Retry button that refetches.
function ErrorState({ error, onRetry }) {
  return html`
    <div class="atelier-state is-error" id="view-stage">
      <svg class="ix" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 9v4"/><path d="M12 17h.01"/>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
      </svg>
      <h3>Couldn’t load sales</h3>
      <p>The source didn’t respond. Retry, or ask your Chi to check the connection.</p>
      ${onRetry ? html`<button class="btn btn-sm" type="button" onClick=${onRetry}>Retry</button>` : null}
      ${error ? html`<span style=${{ fontSize:'0.72rem', color:'var(--fg-muted)', marginTop:'4px' }}>${error}</span>` : null}
    </div>
  `;
}

// ─── SalesView root ───────────────────────────────────────────────────────────

export function SalesView({ activeFeature, operatorId }) {
  // View state: 0=Pipeline | 1=Forecast | 2=Won
  const [activeView, setActiveView] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('view');
    const v = parseInt(p ?? '0', 10);
    return [0, 1, 2].includes(v) ? v : 0;
  });
  const [pipeMode, setPipeMode] = useState('list'); // 'list' | 'kanban'
  // The selected deal is kept by id and looked up in the current rows, so a deal
  // that disappears (sample data removed, a row deleted elsewhere) never lingers
  // in the detail pane.
  const [selectedId, setSelectedId] = useState(null);
  // facet-wire — last-applied sidebar filter facet. 'f:open-pipeline' is the
  // reset/"all" affordance (no predicate → applyFacet returns every deal).
  const [activeFacet, setActiveFacet] = useState(SALES_RESET_FACET);
  // In-pane "New deal" form: null when closed, else { stage } with the column the
  // "+" was clicked in (undefined from the header button).
  const [createForm, setCreateForm] = useState(null);
  // Result line for the last companion request / sample-data action.
  const [notice, setNotice] = useState(null);
  const qc = useQueryClient();

  // ── Data queries ────────────────────────────────────────────────────────────
  const openDealsQ = useQuery({
    queryKey: QK.openDeals,
    queryFn: fetchOpenDeals,
    // While the pipeline is empty, re-check every few seconds so a deal added
    // from outside this pane (the companion creating one) replaces the first-run
    // state without a reload. Stops as soon as there is a row.
    refetchInterval: (query) => (query.state.data?.length === 0 ? 5000 : false),
  });
  const wonDealsQ = useQuery({
    queryKey: QK.wonDeals,
    queryFn: () => fetchWonDeals(operatorId),
    enabled: activeView === 2,
  });
  const lostCountQ = useQuery({
    queryKey: QK.lostCount,
    queryFn: countLostDeals,
    enabled: activeView === 2,
  });
  const sampleCountQ = useQuery({ queryKey: QK.sampleCount, queryFn: countSampleDeals });

  const deals = openDealsQ.data ?? [];
  // facet-wire — the visible slice: full list narrowed by the active facet.
  // Feeds the list, kanban AND the empty-state check (so a facet that matches
  // nothing shows the empty pane, not a stale full list). Badges stay live
  // because buildSalesMenu counts the FULL `deals`, not this slice.
  const visibleDeals = useMemo(
    () => applyFacet(deals, activeFacet, salesFacetPredicates(operatorId), SALES_RESET_FACET),
    [deals, activeFacet, operatorId],
  );
  const selectedDeal = visibleDeals.find((d) => d.id === selectedId) ?? firstInListOrder(visibleDeals);

  const activitiesQ = useQuery({
    queryKey: QK.activities(selectedDeal?.id ?? null),
    queryFn: () => fetchActivities(selectedDeal?.id),
    enabled: !!selectedDeal?.id,
    staleTime: 60_000,
  });

  // ── db-updated refresh ──────────────────────────────────────────────────────
  useEffect(() => {
    function onDbUpdated() {
      qc.invalidateQueries({ queryKey: ['sales'] });
    }
    window.addEventListener('db-updated', onDbUpdated);
    return () => window.removeEventListener('db-updated', onDbUpdated);
  }, [qc]);

  // ── activeFeature → view switching (side-menu item clicks) ─────────────────
  useEffect(() => {
    if (!activeFeature) return;
    if (activeFeature === 'v:pipeline') setActiveView(0);
    else if (activeFeature === 'v:forecast') setActiveView(1);
    else if (activeFeature === 'v:won') setActiveView(2);
    else if (activeFeature === 'seg:list') setPipeMode('list');
    else if (activeFeature === 'seg:kanban') setPipeMode('kanban');
    // Filter facets (f:*) — LIST-ONLY: force the Pipeline view so a facet the
    // user can't see can't be silently applied, then record it. 'f:open-pipeline'
    // resets; every other id narrows via applyFacet. (facet-wire Move 2.)
    else if (activeFeature.startsWith('f:')) {
      setActiveView(0);
      setActiveFacet(activeFeature);
    }
  }, [activeFeature]);

  // ── setMenu publish ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (isStandalone()) return;
    const items = buildSalesMenu(activeView, pipeMode, deals, activeFacet, operatorId);
    setMenu(items).catch(() => {/* ignore */});
  }, [activeView, pipeMode, deals, activeFacet, operatorId]);

  // ── Stage change mutation (kanban drag) ─────────────────────────────────────
  const stageChange = useMutation({
    mutationFn: ({ deal, newStage }) => setDealStage(deal.id, newStage),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.openDeals }),
    onError: (e) => setNotice({ kind: 'error', text: `Could not move the deal: ${e?.message ?? e}` }),
  });

  // ── Adding a deal ───────────────────────────────────────────────────────────
  // Manual first: the form writes the row straight to sales_deals, so it works
  // with no AI engine. `stage` is the kanban column's pre-filled context;
  // undefined from the header or empty-state "New deal".
  const openCreate = useCallback((stage) => {
    setNotice(null);
    setCreateForm({ stage });
  }, []);

  // Secondary route: ask the companion to research and add the deal. Needs an AI
  // engine and an open chat, and reports plainly when it cannot run.
  const askCompanion = useCallback(async () => {
    setNotice(null);
    const result = await askCompanionToAddDeal();
    setNotice(
      result.ok
        ? { kind: 'info', text: 'Sent to the companion. The deal appears here once it has been added.' }
        : { kind: 'error', text: result.message },
    );
  }, []);

  // ── Sample data (opt-in, labelled, removable) ───────────────────────────────
  const sampleChange = useMutation({
    mutationFn: ({ action }) => (action === 'load' ? loadSamplePipeline() : removeSampleData()),
    onSuccess: (_data, { action }) => {
      setNotice(null);
      if (action === 'load') setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['sales'] });
    },
    onError: (e, { action }) =>
      setNotice({
        kind: 'error',
        text: `Could not ${action === 'load' ? 'load' : 'remove'} the sample pipeline: ${e?.message ?? e}`,
      }),
  });
  const sampleBusy = sampleChange.isPending;
  const sampleCount = sampleCountQ.data ?? 0;

  // ── Head label ──────────────────────────────────────────────────────────────
  const headLabel = activeView === 0 ? `Sales · ${deals.length} open`
    : activeView === 1 ? 'Forecast'
    : 'Won';

  // ── Render ──────────────────────────────────────────────────────────────────
  // First run = the table has no open deals. Every view then says so, with the
  // same actions, instead of drawing zeroed charts.
  const firstRunEmpty = html`<${EmptyState}
    onCreate=${openCreate}
    onLoadSample=${() => sampleChange.mutate({ action: 'load' })}
    onAskCompanion=${askCompanion}
    sampleBusy=${sampleBusy}
    formOpen=${createForm !== null}
  />`;
  let body;

  if (activeView === 0) {
    // Pipeline view
    if (openDealsQ.isLoading) {
      body = html`<${LoadingState} />`;
    } else if (openDealsQ.isError) {
      body = html`<${ErrorState} error=${openDealsQ.error?.message ?? 'unknown'} onRetry=${() => openDealsQ.refetch()} />`;
    } else if (deals.length === 0) {
      body = firstRunEmpty;
    } else if (visibleDeals.length === 0) {
      body = html`<${FilterEmptyState} onShowAll=${() => setActiveFacet(SALES_RESET_FACET)} />`;
    } else if (pipeMode === 'kanban') {
      body = html`<${PipelineKanban}
        deals=${visibleDeals}
        onStageChange=${(deal, newStage) => stageChange.mutate({ deal, newStage })}
        onCreate=${openCreate}
      />`;
    } else {
      body = html`<${PipelineList}
        deals=${visibleDeals}
        selectedDeal=${selectedDeal}
        onSelectDeal=${(d) => setSelectedId(d.id)}
        activities=${activitiesQ.data ?? []}
      />`;
    }
  } else if (activeView === 1) {
    if (openDealsQ.isLoading) {
      body = html`<${LoadingState} />`;
    } else if (openDealsQ.isError) {
      body = html`<${ErrorState} error=${openDealsQ.error?.message ?? 'unknown'} onRetry=${() => openDealsQ.refetch()} />`;
    } else if (deals.length === 0) {
      body = firstRunEmpty;
    } else {
      body = html`<${ForecastView} deals=${deals} />`;
    }
  } else {
    // Won view
    if (wonDealsQ.isLoading || openDealsQ.isLoading) {
      body = html`<${LoadingState} />`;
    } else if (wonDealsQ.isError) {
      body = html`<${ErrorState} error=${wonDealsQ.error?.message ?? 'unknown'} onRetry=${() => wonDealsQ.refetch()} />`;
    } else if ((wonDealsQ.data ?? []).length === 0) {
      body = deals.length === 0 ? firstRunEmpty : html`<${NoWonYet} />`;
    } else {
      body = html`<${WonView} wonDeals=${wonDealsQ.data ?? []} lostCount=${lostCountQ.data ?? 0} />`;
    }
  }

  return html`
    <div class="frame" style=${{ height:'100%', display:'flex', flexDirection:'column' }}>
      <div class="frame-head" style=${{ display:'flex', alignItems:'center', gap:'8px' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline>
          <polyline points="16 7 22 7 22 13"></polyline>
        </svg>
        <span>${headLabel}</span>
        <button
          class="btn btn-sm"
          type="button"
          style=${{ marginLeft: 'auto' }}
          disabled=${createForm !== null}
          onClick=${() => openCreate()}
        >New deal</button>
      </div>
      ${createForm !== null && html`<${CreateDealForm}
        key=${createForm.stage ?? 'any'}
        stages=${STAGES}
        stageLabels=${STAGE_LABEL}
        initialStage=${createForm.stage}
        operatorId=${operatorId}
        onClose=${() => setCreateForm(null)}
      />`}
      ${notice ? html`<${Notice} notice=${notice} onDismiss=${() => setNotice(null)} />` : null}
      ${sampleCount > 0 ? html`<${SampleBanner}
        count=${sampleCount}
        busy=${sampleBusy}
        onRemove=${() => sampleChange.mutate({ action: 'remove' })}
      />` : null}
      <div class="frame-body-flush" id="view-stage" style=${{ flex:1, overflow:'hidden' }}>
        ${body}
      </div>
    </div>
  `;
}
