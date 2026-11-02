// inbox-view.js — the unified Outbox inbox (outbox redesign, plans/outbox-redesign/01-plan.md).
//
// ONE triage list of every draft awaiting a decision across email, newsletter,
// social and sequences — ordered by urgency, filtered by facets (type,
// destination, agent, status, has-images, sequence) + free-text search —
// beside an adaptive detail pane whose editor, previews and checks change with
// the draft's kind. Replaces the shell approve-gate panel and the four
// per-channel approval queues.
//
// Data: host.paActions.list (broker-routed inside a share) with a host.dbQuery
// fallback for shells that predate the verb. Writes: host.paActions.{commit,
// reject, retry, update} — never raw SQL.

import { html, cn, Icon, useState, useEffect, useMemo, useRef, useCallback, useQuery, useQueryClient, useAutoGrow } from '../../lib/ui.js';
import {
  hostPaActionsList, hostPaActionsCommit, hostPaActionsReject, hostPaActionsRetry, hostPaActionsUpdate,
  hostSendToActiveSession, hostDbQuery, isStandalone, publishIykeState,
} from '../../lib/bridge.js';
import { BrandIcon, brandTitle } from '../../lib/brand-icons.js';
import {
  buildInbox, normalizeRow, applyFilter, sortItems, sectionize, facetCounts, buildPatch, approveBlockReason,
  consequence, recipientLabel, displayStatus, urgencyOf, allImages, destinationsOf, isApprovable,
  textForPlatform, hashtagsIn, addHashtag, removeHashtag, editCaps, proposedAttachments, attachmentName, attEq, fixtureRows, EMPTY_FILTER, KINDS, KIND_LABEL, PROVIDERS, PROVIDER_LABEL,
  PLATFORMS, PLATFORM_LABEL, PLATFORM_CAPS, SORTS, ACTIVE_STATUSES,
} from '../../lib/inbox-model.js';
import { newsletterHistorySignals } from '../../lib/derive.js';
import { ThumbStrip, Lightbox, MediaEditor, PlatformPreview, InlineImages, Img } from './inbox-media.js';
// Shared detail parts that predate the redesign (CRM panel, quality scorecards,
// newsletter body pane, sent-history join). Render-time-only use, so the
// import cycle with outbound-view.js is safe under ESM live bindings.
import {
  ReplyIntelligence, emailQualityCells, newsletterQualityCells, NewsletterBodyPane,
  fetchNewsletterHistory, FIXTURE_NL_HISTORY, StateDisplay,
} from '../outbound/outbound-view.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const KIND_ICON = { email: 'email', newsletter: 'newsletter', social: 'social', sequence: 'sequences' };
const REJECT_REASONS = {
  email: ['Wrong recipient', 'Tone is off', 'Misses context', 'Already replied elsewhere', "Don't send · close out"],
  newsletter: ['Claim unverified', 'Hype / anti-pattern', 'Off-theme', 'Schedule conflict', 'Weak CTA'],
  social: ['Tone is off', 'Off-message', 'Wrong angle', "Image doesn't match", 'Missing context'],
  sequence: ['Cadence too aggressive', 'Wrong segment', 'Copy needs work', 'Timing is off', "Don't enrol · close out"],
};
const STATUS_META = {
  failed: { label: 'Failed', tone: 'bad' },
  overdue: { label: 'Overdue', tone: 'bad' },
  sending: { label: 'Sending', tone: 'live' },
  queued: { label: 'Approved', tone: 'live' },
  edited: { label: 'Edited', tone: 'warn' },
  awaiting: { label: 'Awaiting', tone: 'muted' },
};
const AGENT_LABEL = (a) => String(a ?? '').toUpperCase();
const SHARE_NOTE = 'You are reviewing the owner’s drafts. Approving records you as the approver in the box’s approval ledger; the box sends about a minute after the undo window. Edits save to the box first.';
const WORKER_IDLE_MS = 3 * 60_000;

// ─── Time helpers ─────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtWhen(t, now = Date.now()) {
  if (t == null) return 'no schedule';
  const d = new Date(t);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const day = new Date(t); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return `today ${hm(d)}`;
  if (diff === 1) return `tomorrow ${hm(d)}`;
  if (diff === -1) return `yesterday ${hm(d)}`;
  return `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${hm(d)}`;
}

export function fmtRel(t, now = Date.now()) {
  if (t == null) return '';
  const ms = t - now;
  const abs = Math.abs(ms);
  const s = abs < 60_000 ? 'now' : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  if (s === 'now') return 'now';
  return ms < 0 ? `${s} ago` : `in ${s}`;
}

const toLocalInput = (t) => {
  if (t == null) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hm(d)}`;
};

// ─── Data ─────────────────────────────────────────────────────────────────────

const LEGACY_COLS = `id, batch_id, action_id, status, channel, payload_json, edited_json, scheduled_at,
  created_at, committed_at, sent_at, attempts, error_text, external_id, delivery_status`;
const isUnknownVerb = (e) => /unknown host tool|host\.paActions\.list/i.test(String(e?.message ?? e));

/** → { rows, inShare, source } */
export async function fetchInboxRows(status) {
  if (isStandalone()) return { rows: status ? [] : fixtureRows(), inShare: false, source: 'fixture' };
  try {
    const { rows, inShare } = await hostPaActionsList(status);
    return { rows, inShare, source: 'host' };
  } catch (e) {
    if (!isUnknownVerb(e)) throw e;
    // Older shell (pre-redesign): read the local DB directly. No share support.
    const st = status ? [status] : ACTIVE_STATUSES;
    const rows = await hostDbQuery(
      `SELECT ${LEGACY_COLS} FROM pa_action_drafts WHERE status IN (${st.map(() => '?').join(',')})
       ORDER BY COALESCE(scheduled_at, created_at) ASC LIMIT 500`, st);
    return { rows: rows ?? [], inShare: false, source: 'db' };
  }
}

export function useInbox(standalone) {
  return useQuery({
    queryKey: ['inbox'],
    queryFn: () => fetchInboxRows(),
    refetchInterval: standalone ? false : 15_000,
    placeholderData: standalone ? { rows: fixtureRows(), inShare: false, source: 'fixture' } : undefined,
  });
}

// ─── Multi-draft undo ─────────────────────────────────────────────────────────
// Approve ARMS a countdown; nothing is written until it elapses. One window at
// a time — arming a new one FLUSHES (commits) the pending one rather than
// silently dropping it, so an operator never believes something was approved
// that wasn't.

function useUndo() {
  const [st, setSt] = useState(null); // { ids, label, left, fire }
  const ref = useRef(null);
  ref.current = st;
  useEffect(() => {
    if (!st) return;
    if (st.left <= 0) { const f = st.fire; setSt(null); f(); return; }
    const t = setTimeout(() => setSt((s) => (s ? { ...s, left: s.left - 1 } : null)), 1000);
    return () => clearTimeout(t);
  }, [st]);
  const arm = useCallback((ids, label, ms, fire) => {
    const prev = ref.current;
    if (prev) prev.fire();
    setSt({ ids, label, left: Math.max(1, Math.round((ms ?? 10_000) / 1000)), fire });
  }, []);
  const cancel = useCallback(() => setSt(null), []);
  const flush = useCallback(() => { const p = ref.current; if (p) { setSt(null); p.fire(); } }, []);
  return { state: st, arm, cancel, flush, isArmed: (id) => !!st?.ids.includes(id) };
}

// ─── Small parts ──────────────────────────────────────────────────────────────

function KindMark({ kind, size = 14 }) {
  return html`<span class=${cn('ibx-kind', `is-${kind}`)} title=${KIND_LABEL[kind]}><${BrandIcon} name=${KIND_ICON[kind]} size=${size} /></span>`;
}

function DestMarks({ item, size = 13, tint = false }) {
  const dests = destinationsOf(item);
  return html`<span class="ibx-dests">${dests.map((d) => html`<span key=${d} class="ibx-dest" title=${brandTitle(d)}><${BrandIcon} name=${d} size=${size} tint=${tint} /></span>`)}</span>`;
}

function StatusPill({ status, armed, left }) {
  if (armed) return html`<span class="ibx-pill is-live">Sending in ${left}s</span>`;
  const m = STATUS_META[status] ?? STATUS_META.awaiting;
  return html`<span class=${cn('ibx-pill', `is-${m.tone}`)}>${m.label}</span>`;
}

function Chip({ children, tone, title, icon }) {
  return html`<span class=${cn('ibx-chip', tone && `is-${tone}`)} title=${title}>${icon ? html`<${Icon} name=${icon} size=${11} />` : null}${children}</span>`;
}

function Callout({ tone = 'info', icon = 'alert-circle', title, children, actions }) {
  return html`<div class=${cn('ibx-callout', `is-${tone}`)} role=${tone === 'bad' ? 'alert' : 'status'}>
    <${Icon} name=${icon} size=${15} />
    <div class="ibx-callout-body">${title ? html`<b>${title}</b>` : null}<div>${children}</div></div>
    ${actions ? html`<div class="ibx-callout-actions">${actions}</div>` : null}
  </div>`;
}

function Kbd({ children }) { return html`<kbd class="ibx-kbd">${children}</kbd>`; }

// ─── Facet bar ────────────────────────────────────────────────────────────────

function toggleIn(arr, v) { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]; }

function FacetBar({ filter, setFilter, counts, sort, setSort, searchRef }) {
  const [more, setMore] = useState(false);
  const activeCount = filter.kinds.length + filter.dests.length + filter.agents.length + filter.statuses.length + (filter.media ? 1 : 0) + (filter.sequence ? 1 : 0);
  const destKeys = [...PLATFORMS, ...PROVIDERS].filter((d) => counts.dests[d]);
  return html`
    <div class="ibx-toolbar">
      <label class="ibx-search">
        <${Icon} name="search" size=${14} />
        <input ref=${searchRef} type="search" placeholder="Search drafts, recipients, #tags…" value=${filter.q}
          onInput=${(e) => setFilter({ ...filter, q: e.target.value })}
          onKeyDown=${(e) => { if (e.key === 'Escape') { setFilter({ ...filter, q: '' }); e.target.blur(); } }} />
        <${Kbd}>/</${Kbd}>
      </label>
      <select class="ibx-select" value=${sort} onChange=${(e) => setSort(e.target.value)} aria-label="Sort">
        ${SORTS.map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
      </select>
      <button type="button" class=${cn('ibx-btn', { 'is-on': more || activeCount })} onClick=${() => setMore((m) => !m)} aria-expanded=${more}>
        <${Icon} name="sliders" size=${13} /> Filters${activeCount ? html` <span class="ibx-count">${activeCount}</span>` : null}
      </button>
    </div>
    <div class="ibx-facets" role="toolbar" aria-label="Filter by type">
      <button type="button" class=${cn('ibx-facet', { 'is-on': !filter.kinds.length })} onClick=${() => setFilter({ ...filter, kinds: [] })}>All <span>${counts.total}</span></button>
      ${KINDS.filter((k) => counts.kinds[k]).map((k) => html`
        <button key=${k} type="button" class=${cn('ibx-facet', { 'is-on': filter.kinds.includes(k) })} onClick=${() => setFilter({ ...filter, kinds: toggleIn(filter.kinds, k) })}>
          <${BrandIcon} name=${KIND_ICON[k]} size=${12} />${KIND_LABEL[k]} <span>${counts.kinds[k]}</span>
        </button>`)}
    </div>
    <div class="ibx-facets is-dests" role="toolbar" aria-label="Filter by destination">
      <span class="ibx-facets-label">Via</span>
      ${destKeys.map((d) => html`
        <button key=${d} type="button" class=${cn('ibx-facet is-icon', { 'is-on': filter.dests.includes(d) })} title=${`${brandTitle(d)} · ${counts.dests[d]}`}
          aria-pressed=${filter.dests.includes(d)} onClick=${() => setFilter({ ...filter, dests: toggleIn(filter.dests, d) })}>
          <${BrandIcon} name=${d} size=${13} tint=${filter.dests.includes(d)} /><span>${counts.dests[d]}</span>
        </button>`)}
      ${counts.media ? html`
        <button type="button" class=${cn('ibx-facet is-icon', { 'is-on': filter.media })} title="Has images" onClick=${() => setFilter({ ...filter, media: !filter.media })}>
          <${Icon} name="image" size=${13} /><span>${counts.media}</span>
        </button>` : null}
    </div>
    ${more ? html`
      <div class="ibx-filter-panel">
        <div class="ibx-filter-group"><span class="ibx-filter-label">Status</span>
          ${Object.keys(STATUS_META).filter((s) => counts.statuses[s]).map((s) => html`
            <button key=${s} type="button" class=${cn('ibx-facet', { 'is-on': filter.statuses.includes(s) })} onClick=${() => setFilter({ ...filter, statuses: toggleIn(filter.statuses, s) })}>${STATUS_META[s].label} <span>${counts.statuses[s]}</span></button>`)}
        </div>
        <div class="ibx-filter-group"><span class="ibx-filter-label">Drafted by</span>
          ${Object.keys(counts.agents).map((a) => html`
            <button key=${a} type="button" class=${cn('ibx-facet', { 'is-on': filter.agents.includes(a) })} onClick=${() => setFilter({ ...filter, agents: toggleIn(filter.agents, a) })}>${AGENT_LABEL(a)} <span>${counts.agents[a]}</span></button>`)}
        </div>
        ${Object.keys(counts.sequences).length ? html`
          <div class="ibx-filter-group"><span class="ibx-filter-label">Sequence</span>
            ${Object.keys(counts.sequences).map((s) => html`
              <button key=${s} type="button" class=${cn('ibx-facet', { 'is-on': filter.sequence === s })} onClick=${() => setFilter({ ...filter, sequence: filter.sequence === s ? null : s })}>${s} <span>${counts.sequences[s]}</span></button>`)}
          </div>` : null}
        <div class="ibx-filter-group"><span class="ibx-spacer"></span>
          <button type="button" class="ibx-btn is-ghost" disabled=${!activeCount && !filter.q} onClick=${() => setFilter({ ...EMPTY_FILTER })}>Clear all</button>
        </div>
      </div>` : null}
    ${filter.sequence && !more ? html`<div class="ibx-active-filter">Sequence <b>${filter.sequence}</b> <button type="button" class="ibx-btn is-ghost" onClick=${() => setFilter({ ...filter, sequence: null })}>× clear</button></div>` : null}`;
}

// ─── List row ─────────────────────────────────────────────────────────────────

function Row({ item, selected, checked, onPick, onCheck, undoLeft, error, onOpenImage, now }) {
  const st = displayStatus(item, now);
  const imgs = allImages(item);
  const snippet = String(item.kind === 'newsletter' ? item.body.replace(/<[^>]+>/g, ' ') : item.body).replace(/\s+/g, ' ').trim().slice(0, 140);
  const when = item.scheduledAt != null ? fmtRel(item.scheduledAt, now) : '';
  return html`
    <div role="option" aria-selected=${selected} tabindex="-1" data-id=${item.id}
      class=${cn('ibx-row', `is-${st}`, { 'is-on': selected, 'is-checked': checked, 'is-armed': undoLeft != null })}
      onClick=${() => onPick(item.id)}>
      <span class="ibx-row-tick" aria-hidden="true"></span>
      <input type="checkbox" class="ibx-row-check" checked=${checked} aria-label=${`Select ${item.subject || 'draft'}`}
        onClick=${(e) => e.stopPropagation()} onChange=${() => onCheck(item.id)} />
      <div class="ibx-row-main">
        <div class="ibx-row-l1">
          <${KindMark} kind=${item.kind} size=${12} />
          <span class="ibx-row-who">${recipientLabel(item)}</span>
          <span class="ibx-spacer"></span>
          ${undoLeft != null ? html`<span class="ibx-pill is-live">${undoLeft}s</span>`
            : st === 'failed' || st === 'overdue' || st === 'queued' || st === 'sending' ? html`<${StatusPill} status=${st} />`
            : html`<span class=${cn('ibx-row-when', { 'is-soon': urgencyOf(item, now) === 'today' })} title=${fmtWhen(item.scheduledAt, now)}>${when}</span>`}
        </div>
        <div class="ibx-row-subj">${item.subject || (item.kind === 'social' ? snippet.slice(0, 70) : '(no subject)')}</div>
        ${snippet && (item.kind !== 'social' || item.subject) ? html`<div class="ibx-row-snip">${snippet}</div>` : null}
        <div class="ibx-row-foot">
          <${DestMarks} item=${item} size=${12} />
          ${item.edited && st !== 'failed' ? html`<${Chip} tone="warn">edited</${Chip}>` : null}
          ${item.sequence ? html`<${Chip} icon="git-branch">${item.sequence.step ?? '?'}/${item.sequence.total ?? '?'}</${Chip}>` : null}
          ${item.cold ? html`<${Chip} tone="warn" title="Cold sender — reputational risk">cold</${Chip}>` : null}
          ${item.outreach?.send_rank != null ? html`<${Chip}>#${item.outreach.send_rank}${item.outreach.assignee ? ` · ${item.outreach.assignee}` : ''}</${Chip}>` : null}
          ${item.ledgerApproval ? html`<${Chip} tone="live">approved · ${item.ledgerApproval.approver?.username ?? 'ledger'}</${Chip}>` : null}
          ${error ? html`<${Chip} tone="bad" title=${error}>action failed</${Chip}>` : null}
          <span class="ibx-row-agent">${AGENT_LABEL(item.agent)}</span>
          ${imgs.length ? html`<${ThumbStrip} images=${imgs} onOpen=${(i) => onOpenImage(imgs, i)} />` : null}
        </div>
      </div>
    </div>`;
}

// ─── Envelope (who / from / when) ─────────────────────────────────────────────

function Recipients({ item }) {
  const [open, setOpen] = useState(false);
  const list = item.recipientsList;
  if (item.kind === 'newsletter') {
    return html`<span>${item.recipientsCount ? html`<b>${item.recipientsCount.toLocaleString('en-US')}</b> subscribers` : (item.recipient || 'Subscriber list')}${item.recipient && item.recipientsCount ? html` <span class="ibx-muted">· ${item.recipient}</span>` : null}</span>`;
  }
  if (list.length <= 1) {
    const r = list[0] ?? { name: item.recipient, email: item.recipientEmail };
    return html`<span><b>${r.name || r.email || '—'}</b>${r.name && r.email ? html` <span class="ibx-muted">${r.email}</span>` : null}${item.tenantId ? html` <${Chip}>tenant ${item.tenantId}</${Chip}>` : null}</span>`;
  }
  return html`<span class="ibx-recips">
    ${(open ? list : list.slice(0, 3)).map((r, i) => html`<span key=${i} class="ibx-recip" title=${r.email}>${r.name || r.email}</span>`)}
    ${list.length > 3 ? html`<button type="button" class="ibx-btn is-ghost" onClick=${() => setOpen((o) => !o)}>${open ? 'less' : `+${list.length - 3} more`}</button>` : null}
  </span>`;
}

function WhenField({ item, value, onChange, readOnly, now }) {
  const [editing, setEditing] = useState(false);
  const overdue = value != null && value < now && isApprovable(item);
  if (editing && !readOnly) {
    return html`<span class="ibx-when-edit">
      <input type="datetime-local" value=${toLocalInput(value)} autoFocus
        onChange=${(e) => { const t = e.target.value ? new Date(e.target.value).getTime() : null; onChange(Number.isFinite(t) ? t : null); }}
        onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }} />
      <button type="button" class="ibx-btn is-ghost" onClick=${() => { onChange(null); setEditing(false); }} title="Send as soon as approved">Send on approve</button>
      <button type="button" class="ibx-btn" onClick=${() => setEditing(false)}>Done</button>
    </span>`;
  }
  return html`<span class=${cn('ibx-when', { 'is-bad': overdue })}>
    <b>${value == null ? 'On approve' : fmtWhen(value, now)}</b>
    ${value != null ? html`<span class="ibx-muted">${fmtRel(value, now)}</span>` : null}
    ${readOnly ? null : html`<button type="button" class="ibx-btn is-ghost" onClick=${() => setEditing(true)}><${Icon} name="calendar-clock" size=${12} /> Reschedule</button>`}
  </span>`;
}

// ─── Social: platform scope + include toggles ─────────────────────────────────

function PlatformToggles({ item, excluded, setExcluded, readOnly }) {
  return html`<span class="ibx-plat-toggles">
    ${item.siblings.map((s) => {
      const off = excluded.has(s.id);
      return html`<button key=${s.id} type="button" disabled=${readOnly || !isApprovable({ ...item, status: s.status })}
        class=${cn('ibx-plat-toggle', { 'is-off': off, 'is-failed': s.status === 'failed' })} aria-pressed=${!off}
        title=${off ? `Include ${PLATFORM_LABEL[s.platform]}` : `Exclude ${PLATFORM_LABEL[s.platform]} (won't post there)`}
        onClick=${() => { const n = new Set(excluded); off ? n.delete(s.id) : n.add(s.id); setExcluded(n); }}>
        <${BrandIcon} name=${s.platform} size=${13} tint=${!off} />${PLATFORM_LABEL[s.platform]}${off ? html`<span class="ibx-muted"> · off</span>` : null}
      </button>`;
    })}
  </span>`;
}

// ─── Reject panel ─────────────────────────────────────────────────────────────

function RejectPanel({ kind, onConfirm, onCancel, pending, many }) {
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');
  const reason = [...picked, note.trim()].filter(Boolean).join(' · ') || null;
  return html`<div class="ibx-reject" role="group" aria-label="Reject draft">
    <div class="ibx-section-head"><${Icon} name="x-circle" size=${13} /><span>${many ? `Reject ${many} drafts` : 'Reject'} — why?</span><span class="ibx-muted">saved with the draft · trains the writer agent</span></div>
    <div class="ibx-reject-reasons">${(REJECT_REASONS[kind] ?? REJECT_REASONS.email).map((r) => html`
      <button key=${r} type="button" class=${cn('ibx-facet', { 'is-on': picked.includes(r) })} onClick=${() => setPicked(toggleIn(picked, r))}>${r}</button>`)}</div>
    <input type="text" class="ibx-input" placeholder="Optional note" value=${note} onInput=${(e) => setNote(e.target.value)} autoFocus
      onKeyDown=${(e) => { if (e.key === 'Enter') onConfirm(reason); if (e.key === 'Escape') onCancel(); }} />
    <div class="ibx-row-actions">
      <button type="button" class="ibx-btn" onClick=${onCancel}>Cancel</button>
      <button type="button" class="ibx-btn is-danger" disabled=${pending} onClick=${() => onConfirm(reason)}>${pending ? 'Rejecting…' : many ? `Reject ${many}` : 'Reject draft'}</button>
    </div>
  </div>`;
}

// ─── Checks (quality, CRM, sequence) ──────────────────────────────────────────

function QualityGrid({ cells }) {
  if (!cells?.length) return null;
  return html`<div class="nl-quality-grid ibx-quality">${cells.map((c, i) => html`
    <div key=${i} class=${cn('nl-quality-cell', c.tone)}>
      <div class="qlabel">${c.label}</div>
      <div class="qvalue">${c.value} <span class="qsub">${c.sub}</span></div>
      <div class="qbar"><div style=${{ width: `${c.pct}%` }}></div></div>
    </div>`)}</div>`;
}

function SequenceRail({ seq, onView }) {
  const total = seq.total ?? 0;
  return html`<div class="ibx-seq">
    <div class="ibx-section-head"><${Icon} name="git-branch" size=${13} /><span>Sequence · ${seq.name ?? 'unnamed'}</span>
      <span class="ibx-muted">step ${seq.step ?? '?'} of ${seq.total ?? '?'}${seq.recipients ? ` · ${seq.recipients} enrolled` : ''}</span>
      <span class="ibx-spacer"></span>
      ${seq.name ? html`<button type="button" class="ibx-btn is-ghost" onClick=${onView}>View sequence</button>` : null}
    </div>
    ${total ? html`<div class="ibx-seq-steps">${Array.from({ length: total }).map((_, i) => html`
      <span key=${i} class=${cn('ibx-seq-step', { 'is-done': i + 1 < (seq.step ?? 0), 'is-now': i + 1 === seq.step })}>${i + 1}</span>`)}</div>` : null}
  </div>`;
}

function Checks({ item, draft, standalone }) {
  const [open, setOpen] = useState(true);
  const { data: history } = useQuery({
    queryKey: ['newsletter', 'history'],
    queryFn: () => (standalone ? Promise.resolve(FIXTURE_NL_HISTORY) : fetchNewsletterHistory()),
    enabled: item.kind === 'newsletter',
    staleTime: 60_000,
  });
  let cells = [];
  const row = { body: draft.body, quality: item.quality, drafted_by: item.agent, sequence_id: item.sequence?.name ?? null, newsletter_type: item.newsletterType, quality_score: null };
  if (item.kind === 'newsletter') {
    const sig = history ? newsletterHistorySignals({ subject: draft.subject, body: draft.body, section: item.section }, history) : null;
    cells = newsletterQualityCells(row, sig);
  } else if (item.kind === 'email' || item.kind === 'sequence') {
    cells = emailQualityCells(row, null);
  }
  if (!cells.length && !(item.kind === 'email' && item.recipientEmail)) return null;
  return html`<section class="ibx-checks">
    <button type="button" class="ibx-section-head is-toggle" onClick=${() => setOpen((o) => !o)} aria-expanded=${open}>
      <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${13} /><span>Checks</span>
      <span class="ibx-muted">${item.quality ? `verified at draft time${item.quality.tone?.model ? ` · ${item.quality.tone.model}` : ''}` : 'computed from the body · no draft-time verdict'}</span>
    </button>
    ${open ? html`
      <${QualityGrid} cells=${cells} />
      ${(item.kind === 'email' || item.kind === 'sequence') && item.recipientEmail ? html`<${ReplyIntelligence} email=${item.recipientEmail} sequenceId=${item.sequence?.name} standalone=${standalone} />` : null}` : null}
  </section>`;
}

// ─── Detail ───────────────────────────────────────────────────────────────────

function initialDraft(it) {
  const bodies = {};
  for (const s of it.siblings) bodies[s.id] = s.body;
  return {
    subject: it.subject, body: it.body, bodies, subjectB: it.subjectB ?? '', preheader: it.preheader ?? '',
    firstComment: it.firstComment ?? '', images: it.media.images.slice(), scheduledAt: it.scheduledAt,
    attachments: proposedAttachments(it),
  };
}

/** Patches to persist per row id. Social: each sibling gets its own body;
 *  shared fields (hashtags, images, first comment, schedule) go to all. */
function patchesFor(it, d, { approve = false } = {}) {
  const out = {};
  if (it.kind !== 'social') {
    const caps = editCaps(it);
    // D-16: attachments shown in the Outbox go out on approve; before that they
    // only count as an edit when the operator changed the proposed list.
    const att = caps.attachments.edit && (!attEq(d.attachments, proposedAttachments(it)) || (approve && d.attachments.length))
      ? { attachments: d.attachments } : {};
    const p = buildPatch(it, {
      ...att,
      subject: d.subject, body: d.body,
      ...(caps.subjectB.edit ? { subjectB: d.subjectB } : {}),
      ...(caps.preheader.edit ? { preheader: d.preheader } : {}),
      ...(caps.images.edit ? { images: d.images } : {}),
      ...(caps.schedule.edit ? { scheduledAt: d.scheduledAt } : {}),
    });
    if (Object.keys(p).length) out[it.id] = p;
    return out;
  }
  // Only fields the send path honours for this draft (editCaps) are ever sent.
  const caps = editCaps(it);
  const shared = buildPatch(it, {
    ...(caps.images.edit ? { images: d.images } : {}),
    ...(caps.firstComment.edit ? { firstComment: d.firstComment } : {}),
    ...(caps.schedule.edit ? { scheduledAt: d.scheduledAt } : {}),
  });
  for (const s of it.siblings) {
    if (s.sourceBound && s.thread) continue; // not editable this round (D-15)
    const p = { ...shared };
    if (s.sourceBound && s.platform === 'x') delete p.firstComment; // X has no first comment
    if (d.bodies[s.id] !== undefined && d.bodies[s.id] !== s.body) p.body = d.bodies[s.id];
    if (Object.keys(p).length) out[s.id] = p;
  }
  return out;
}

// Hashtags are part of the text (that is the only way they post), so this
// edits the text: adding appends "#tag", removing strips it.
function HashtagEditor({ text, onText, suggested = [], readOnly }) {
  const [val, setVal] = useState('');
  const tags = hashtagsIn(text);
  const add = (raw = val) => {
    const t = String(raw).trim().replace(/\s+/g, '');
    if (t && t !== '#') onText(addHashtag(text, t));
    setVal('');
  };
  const sugg = suggested.filter((t) => !tags.includes(t));
  return html`<div class="ibx-tags">
    ${tags.map((t) => html`<span key=${t} class="ibx-tag">${t}${readOnly ? null : html`<button type="button" aria-label=${`Remove ${t}`} onClick=${() => onText(removeHashtag(text, t))}>×</button>`}</span>`)}
    ${readOnly ? (tags.length ? null : html`<span class="ibx-muted">none in the text</span>`) : html`<input class="ibx-tag-input" placeholder="+ #tag" value=${val} onInput=${(e) => setVal(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(); } }} onBlur=${() => add()} />`}
    ${!readOnly && sugg.length ? html`<span class="ibx-tag-sugg"><span class="ibx-muted">suggested</span>${sugg.map((t) => html`<button key=${t} type="button" class="ibx-facet" onClick=${() => add(t)}>+ ${t}</button>`)}</span>` : null}
  </div>`;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;

// D-16 — files attached to an SMTP / Resend email. Whatever this list shows
// when you approve is exactly what the sender attaches (fetched over https at
// send time, any type, 10 MB total).
function AttachmentEditor({ list, onChange, readOnly, openImages }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState(null);
  const add = () => {
    const u = url.trim();
    if (!/^https:\/\//i.test(u)) { setErr('Use an https URL — the sender only fetches https'); return; }
    if (list.some((a) => a.url === u)) { setErr('Already attached'); return; }
    if (list.length >= 20) { setErr('At most 20 attachments'); return; }
    onChange([...list, name.trim() ? { url: u, name: name.trim() } : { url: u }]);
    setUrl(''); setName(''); setErr(null); setAdding(false);
  };
  const imgs = list.filter((a) => IMG_EXT.test(a.url)).map((a) => a.url);
  return html`<section class="ibx-media">
    <div class="ibx-section-head"><${Icon} name="link" size=${13} /><span>Attachments</span>
      <span class="ibx-muted">${list.length ? `${list.length} · sent with the email when you approve · 10 MB total` : 'none'}</span>
      <span class="ibx-spacer"></span>
      ${readOnly ? null : html`<button type="button" class="ibx-btn is-ghost" onClick=${() => setAdding((a) => !a)}><${Icon} name="plus" size=${13} /> Attach by URL</button>`}
    </div>
    ${list.length ? html`<ul class="ibx-att-list">${list.map((a, i) => html`
      <li key=${a.url} class="ibx-att">
        ${IMG_EXT.test(a.url)
          ? html`<button type="button" class="ibx-att-thumb" onClick=${() => openImages(imgs, imgs.indexOf(a.url))}><${Img} src=${a.url} /></button>`
          : html`<span class="ibx-att-icon"><${Icon} name="file-text" size=${16} /></span>`}
        <span class="ibx-att-main">
          ${readOnly ? html`<b>${attachmentName(a, i)}</b>` : html`<input class="ibx-att-name" value=${a.name ?? ''} placeholder=${attachmentName({ url: a.url }, i)}
            aria-label="File name" onChange=${(e) => onChange(list.map((x, k) => (k === i ? (e.target.value.trim() ? { url: x.url, name: e.target.value.trim() } : { url: x.url }) : x)))} />`}
          <span class="ibx-muted" title=${a.url}>${(() => { try { return new URL(a.url).hostname; } catch { return a.url; } })()}</span>
        </span>
        ${readOnly ? null : html`<button type="button" class="ibx-btn is-ghost" aria-label=${`Remove ${attachmentName(a, i)}`} onClick=${() => onChange(list.filter((_, k) => k !== i))}><${Icon} name="x" size=${13} /></button>`}
      </li>`)}</ul>` : html`<div class="ibx-media-empty"><${Icon} name="link" size=${16} /> No attachments${readOnly ? '' : ' — attach any file by https URL'}</div>`}
    ${adding && !readOnly ? html`<div class="ibx-media-attach">
      <input type="url" placeholder="https://… (any file)" value=${url} autoFocus onInput=${(e) => { setUrl(e.target.value); setErr(null); }}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') setAdding(false); }} />
      <input type="text" placeholder="File name (optional)" value=${name} onInput=${(e) => setName(e.target.value)} style=${{ maxWidth: '200px' }} />
      <button type="button" class="ibx-btn is-primary" disabled=${!url.trim()} onClick=${add}>Attach</button>
      <button type="button" class="ibx-btn" onClick=${() => { setAdding(false); setErr(null); }}>Cancel</button>
      ${err ? html`<div class="ibx-field-err">${err}</div>` : null}
    </div>` : null}
  </section>`;
}

function CapNote({ cap }) {
  return cap?.note ? html`<div class="ibx-cap-note"><${Icon} name="alert-circle" size=${12} />${cap.note}</div>` : null;
}

function Field({ label, children, hint }) {
  return html`<label class="ibx-field"><span class="ibx-field-label">${label}${hint ? html`<span class="ibx-muted">${hint}</span>` : null}</span>${children}</label>`;
}

function BodyEditor({ value, onChange, onBlur, editorRef, minHeight = 200, placeholder }) {
  const ref = useAutoGrow(value, { minHeight });
  const setRef = (el) => { ref.current = el; if (editorRef) editorRef.current = el; };
  return html`<textarea ref=${setRef} class="ibx-body" value=${value} placeholder=${placeholder} spellcheck="true"
    onInput=${(e) => onChange(e.target.value)} onBlur=${onBlur} style=${{ overflow: 'hidden', resize: 'none' }}></textarea>`;
}

function InboxDetail({ item, pos, total, onNav, ctl, now, standalone, inShare, error, undo, api, onViewSequence, openImages }) {
  const [draft, setDraft] = useState(() => initialDraft(item));
  const [excluded, setExcluded] = useState(() => new Set());
  const [scope, setScope] = useState('all'); // social edit scope: 'all' | sibling row id
  const [panel, setPanel] = useState(null); // 'reject' | null
  const [nlMode, setNlMode] = useState('preview'); // newsletter: preview | edit
  const [emailMode, setEmailMode] = useState(item.bodyFormat === 'html' ? 'preview' : 'edit');
  const [pvPlat, setPvPlat] = useState(null);
  const [saveState, setSaveState] = useState({ state: 'idle' }); // idle | saving | saved | error
  const editorRef = useRef(null);
  const loadedRef = useRef(item);

  // Reset when the selection changes; refresh from the server copy when it
  // changes underneath us and the operator has no unsaved edits.
  useEffect(() => {
    const prev = loadedRef.current;
    const dirtyNow = Object.keys(patchesFor(prev, draft)).length > 0;
    if (prev.id !== item.id || !dirtyNow) setDraft(initialDraft(item));
    if (prev.id !== item.id) {
      setExcluded(new Set()); setScope('all'); setPanel(null); setPvPlat(null); setSaveState({ state: 'idle' });
      setNlMode('preview'); setEmailMode(item.bodyFormat === 'html' ? 'preview' : 'edit');
    }
    loadedRef.current = item;
  }, [item]);

  const readOnly = !isApprovable(item) || undo.isArmed(item.id);
  const patches = patchesFor(item, draft);
  const dirty = Object.keys(patches).length > 0;
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));

  const save = useCallback(async ({ approve = false } = {}) => {
    const ps = patchesFor(loadedRef.current, draft, { approve });
    if (!Object.keys(ps).length) return true;
    if (standalone) { setSaveState({ state: 'saved', at: Date.now(), note: 'preview only — not persisted' }); return true; }
    setSaveState({ state: 'saving' });
    try {
      for (const [id, p] of Object.entries(ps)) await api.update(id, p);
      setSaveState({ state: 'saved', at: Date.now() });
      await api.refresh();
      return true;
    } catch (e) {
      setSaveState({ state: 'error', message: String(e?.message ?? e) });
      return false;
    }
  }, [draft, standalone, api]);

  const caps = editCaps(item);
  const socialLive = { bodies: draft.bodies, images: draft.images, excluded };
  const blocked = approveBlockReason(item, socialLive);
  const activeIds = item.kind === 'social' ? item.siblings.filter((s) => !excluded.has(s.id) && isApprovable({ ...item, status: s.status })).map((s) => s.id) : [item.id];
  const excludedIds = item.kind === 'social' ? item.siblings.filter((s) => excluded.has(s.id)).map((s) => s.id) : [];

  const approve = useCallback(async () => {
    if (blocked || undo.isArmed(item.id)) return;
    if (!(await save({ approve: true }))) return;
    api.approve(item, activeIds, excludedIds);
  }, [blocked, save, api, item, activeIds.join(','), excludedIds.join(',')]);

  const reject = (reason) => { setPanel(null); api.reject(item, item.ids, reason); };

  // Expose to the view-level keyboard handler.
  ctl.current = {
    save, approve,
    openReject: () => { if (item.status !== 'sending') setPanel('reject'); },
    closePanel: () => setPanel(null),
    focusEditor: () => editorRef.current?.focus(),
    hasPanel: () => panel != null,
  };

  const fixInChat = (f) => hostSendToActiveSession(
    `Fix this copy issue in the newsletter draft "${draft.subject}" before I approve it.\n\nIssue: ${f.kind === 'hype' ? 'hype phrase' : 'vague metric'} — "${f.term}"\nLocation: body line ${f.line}\nExcerpt: "${f.excerpt}"\n\nRewrite that line, keeping the meaning.`,
  ).catch(() => {});
  const sendToChat = () => hostSendToActiveSession(
    `Help me review this outbound ${KIND_LABEL[item.kind].toLowerCase()} before I approve it.\n\n`
    + `To: ${recipientLabel(item)}\nVia: ${destinationsOf(item).map(brandTitle).join(', ')}\nWhen: ${fmtWhen(draft.scheduledAt, now)}\nDrafted by: ${AGENT_LABEL(item.agent)}${item.model ? ` (${item.model})` : ''}\n`
    + (item.subject ? `Subject: ${draft.subject}\n` : '') + `\n${item.kind === 'social' ? (draft.bodies[scope] ?? draft.body) : draft.body}`,
  ).catch(() => {});

  const st = displayStatus(item, now);
  const armed = undo.isArmed(item.id);
  const editBodyId = item.kind === 'social' ? (scope === 'all' ? item.id : scope) : item.id;
  const socialBody = draft.bodies[editBodyId] ?? '';
  const setSocialBody = (v) => setDraft((d) => {
    const bodies = { ...d.bodies };
    if (scope === 'all') {
      // Base edit: apply to every platform that still mirrors the base body.
      const base = d.bodies[item.id];
      for (const s of item.siblings) if (s.id === item.id || bodies[s.id] === base) bodies[s.id] = v;
    } else bodies[scope] = v;
    return { ...d, bodies, body: scope === 'all' || scope === item.id ? v : d.body };
  });
  const customIds = item.kind === 'social' ? item.siblings.filter((s) => s.id !== item.id && draft.bodies[s.id] !== draft.bodies[item.id]).map((s) => s.id) : [];
  const previewPlats = item.kind === 'social' ? item.siblings : [];
  const shownPv = pvPlat ? previewPlats.filter((s) => s.id === pvPlat) : previewPlats;

  return html`
    <div class="ibx-detail" aria-label="Draft detail">
      <div class="ibx-detail-bar">
        <${KindMark} kind=${item.kind} />
        <span class="ibx-detail-kind">${KIND_LABEL[item.kind]}${item.kind === 'newsletter' && item.newsletterType === 'investor_update' ? ' · investor update' : ''}${item.emailGroup === 'reply' ? ' · reply' : ''}</span>
        <${DestMarks} item=${item} size=${14} tint=${true} />
        <${StatusPill} status=${st} armed=${armed} left=${undo.state?.left} />
        ${dirty ? html`<${Chip} tone="warn">unsaved edits</${Chip}>` : item.edited && st !== 'edited' ? html`<${Chip} tone="warn">edited</${Chip}>` : null}
        <span class="ibx-spacer"></span>
        <span class="ibx-nav">
          <button type="button" class="ibx-btn is-ghost" disabled=${pos <= 0} onClick=${() => onNav(-1)} title="Previous (K)" aria-label="Previous draft"><${Icon} name="chevron-up" size=${14} /></button>
          <span class="ibx-nav-pos">${pos + 1} of ${total}</span>
          <button type="button" class="ibx-btn is-ghost" disabled=${pos >= total - 1} onClick=${() => onNav(1)} title="Next (J)" aria-label="Next draft"><${Icon} name="chevron-down" size=${14} /></button>
        </span>
      </div>

      <div class="ibx-detail-scroll">
        ${inShare ? html`<${Callout} tone="info" icon="users">${SHARE_NOTE}</${Callout}>` : null}
        ${error ? html`<${Callout} tone="bad" title="That didn't go through">${error}</${Callout}>` : null}
        ${item.status === 'failed' ? html`<${Callout} tone="bad" icon="alert-triangle" title=${`Send failed${item.attempts ? ` after ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}` : ''}`}
            actions=${html`
              ${item.errorText ? html`<button type="button" class="ibx-btn" onClick=${() => navigator.clipboard?.writeText(item.errorText).catch(() => {})}><${Icon} name="copy" size=${13} /> Copy error</button>` : null}`}>
            <code class="ibx-err">${item.errorText ?? 'No error text recorded by the send worker.'}</code></${Callout}>` : null}
        ${st === 'overdue' ? html`<${Callout} tone="warn" icon="clock" title="Past its send time">Was due ${fmtWhen(item.scheduledAt, now)} (${fmtRel(item.scheduledAt, now)}). Approving sends it right away — or reschedule below.</${Callout}>` : null}
        ${item.status === 'committed' ? html`<${Callout} tone="live" icon="check-circle" title="Approved — waiting for the send worker">${item.scheduledAt && item.scheduledAt > now ? `Goes out ${fmtWhen(item.scheduledAt, now)}.` : 'Goes out on the worker’s next pass (about a minute).'} You can still cancel it.</${Callout}>` : null}
        ${item.ledgerApproval ? html`<${Callout} tone="live" icon="check-circle" title="Approved in the box ledger">By ${item.ledgerApproval.approver?.username ?? 'a reviewer'} · ${item.ledgerApproval.at ?? ''}</${Callout}>` : null}
        ${item.outreachPause ? html`<${Callout} tone="warn" icon="pause" title="Outreach paused">Paused after ${item.outreachPause.sentCount} sends (threshold ${item.outreachPause.threshold}). Resume from Mattermost.</${Callout}>` : null}
        ${item.outreachStatus?.state ? html`<${Callout} tone="info" icon="send" title=${`Outreach · ${item.outreachStatus.state}`}>${item.outreachStatus.reason ?? ''}</${Callout}>` : null}

        <dl class="ibx-env">
          <dt>${item.kind === 'social' ? 'Posts to' : 'To'}</dt>
          <dd>${item.kind === 'social' ? html`<${PlatformToggles} item=${item} excluded=${excluded} setExcluded=${setExcluded} readOnly=${readOnly} />` : html`<${Recipients} item=${item} />`}</dd>
          ${item.kind !== 'social' ? html`<dt>From</dt><dd>
            <b>${item.sender ?? '—'}</b> <span class="ibx-muted">via</span> <span class="ibx-via"><${BrandIcon} name=${item.provider} size=${12} /> ${PROVIDER_LABEL[item.provider] ?? item.provider}</span>
            ${item.cold ? html` <${Chip} tone="warn" title="This sender domain is used for cold outreach — reputational risk">cold sender</${Chip}>` : null}
          </dd>` : html`<dt>Via</dt><dd><span class="ibx-via"><${BrandIcon} name="buffer" size=${12} /> Buffer</span>${item.blogSlug ? html` <${Chip} icon="link">/${item.blogSlug}</${Chip}>` : null}</dd>`}
          ${item.replyTo ? html`<dt>Reply-to</dt><dd>${item.replyTo}</dd>` : null}
          <dt>When</dt><dd><${WhenField} item=${item} value=${draft.scheduledAt} onChange=${set('scheduledAt')} readOnly=${readOnly || !caps.schedule.edit} now=${now} />${isApprovable(item) && !caps.schedule.edit && caps.schedule.note ? html`<span class="ibx-muted" title=${caps.schedule.note}>· set in the social queue</span>` : null}</dd>
          <dt>Drafted by</dt><dd><b>${AGENT_LABEL(item.agent)}</b>${item.model ? html` <span class="ibx-muted">· ${item.model}</span>` : null}${item.actionName ? html` <span class="ibx-muted">· ${item.actionName}</span>` : null}${item.createdAt ? html` <span class="ibx-muted">· ${fmtRel(item.createdAt, now)}</span>` : null}</dd>
          ${item.deal || item.threadCount || item.topic ? html`<dt>Context</dt><dd>
            ${item.deal ? html`<${Chip} icon="tag">${item.deal}</${Chip}>` : null}
            ${item.threadCount ? html`<${Chip} icon="message-square">${item.threadCount} in thread</${Chip}>` : null}
            ${item.topic ? html`<${Chip}>${item.topic}</${Chip}>` : null}
          </dd>` : null}
        </dl>

        ${item.sequence ? html`<${SequenceRail} seq=${item.sequence} onView=${() => onViewSequence(item.sequence.name)} />` : null}

        ${item.kind === 'email' || item.kind === 'sequence' ? html`
          <section class="ibx-editor">
            <${Field} label="Subject" hint=${`${draft.subject.length} chars`}>
              <input class="ibx-input is-subject" value=${draft.subject} readOnly=${readOnly} onInput=${(e) => set('subject')(e.target.value)} onBlur=${save} />
            </${Field}>
            <div class="ibx-field-label">Body
              ${item.bodyFormat === 'html' ? html`<span class="ibx-seg">
                <button type="button" class=${cn({ 'is-on': emailMode === 'preview' })} onClick=${() => setEmailMode('preview')}>Rendered</button>
                <button type="button" class=${cn({ 'is-on': emailMode === 'edit' })} onClick=${() => setEmailMode('edit')}>Edit HTML</button>
              </span>` : html`<span class="ibx-muted">${draft.body.split(/\s+/).filter(Boolean).length} words</span>`}
            </div>
            ${item.bodyFormat === 'html' && emailMode === 'preview'
              ? html`<div class="ibx-rendered" dangerouslySetInnerHTML=${{ __html: draft.body }}></div>`
              : html`<${BodyEditor} value=${draft.body} onChange=${set('body')} onBlur=${save} editorRef=${editorRef} />`}
          </section>
          <${InlineImages} images=${item.inlineImages} onOpen=${(i) => openImages(item.inlineImages, i)} />
          ${caps.attachments.edit || draft.attachments.length ? html`<${AttachmentEditor} list=${draft.attachments} onChange=${set('attachments')} readOnly=${readOnly || !caps.attachments.edit} openImages=${openImages} />` : null}
        ` : null}

        ${item.kind === 'newsletter' ? html`
          <section class="ibx-editor">
            <${Field} label="Subject" hint=${`${draft.subject.length} chars`}>
              <input class="ibx-input is-subject" value=${draft.subject} readOnly=${readOnly} onInput=${(e) => set('subject')(e.target.value)} onBlur=${save} />
            </${Field}>
            ${caps.preheader.edit || draft.preheader ? html`
              <${Field} label="Preheader" hint=${draft.preheader ? `${draft.preheader.length} chars · aim for 40–90` : 'the preview line shown after the subject in most inboxes'}>
                <input class="ibx-input" value=${draft.preheader} placeholder="—" readOnly=${readOnly || !caps.preheader.edit} onInput=${(e) => set('preheader')(e.target.value)} onBlur=${save} />
                <${CapNote} cap=${caps.preheader} />
              </${Field}>` : null}
            <div class="ibx-inbox-pv" aria-label="Inbox preview">
              <span class="ibx-inbox-pv-from">${item.sender ?? 'Royalti'}</span>
              <span class="ibx-inbox-pv-subj">${draft.subject || '(no subject)'}</span>
              <span class="ibx-inbox-pv-pre">— ${draft.preheader || String(draft.body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)}</span>
            </div>
            <div class="ibx-field-label">Body <span class="ibx-seg">
              <button type="button" class=${cn({ 'is-on': nlMode === 'preview' })} onClick=${() => setNlMode('preview')}>Review</button>
              <button type="button" class=${cn({ 'is-on': nlMode === 'edit' })} disabled=${readOnly} onClick=${() => setNlMode('edit')}>Edit</button>
            </span></div>
            ${nlMode === 'edit' && !readOnly
              ? html`<${BodyEditor} value=${draft.body} onChange=${set('body')} onBlur=${save} editorRef=${editorRef} minHeight=${280} />`
              : html`<${NewsletterBodyPane} body=${draft.body} subject=${draft.subject} onFixInChat=${fixInChat} />`}
          </section>
          <${InlineImages} images=${item.inlineImages} onOpen=${(i) => openImages(item.inlineImages, i)} />
        ` : null}

        ${item.kind === 'social' ? html`
          <section class="ibx-editor">
            <div class="ibx-field-label">Post text
              <span class="ibx-seg" role="tablist" aria-label="Edit scope">
                <button type="button" class=${cn({ 'is-on': scope === 'all' })} onClick=${() => setScope('all')}>All platforms</button>
                ${item.siblings.length > 1 ? item.siblings.map((s) => html`
                  <button key=${s.id} type="button" class=${cn({ 'is-on': scope === s.id })} onClick=${() => setScope(s.id)} title=${`Edit just ${PLATFORM_LABEL[s.platform]}`}>
                    <${BrandIcon} name=${s.platform} size=${11} />${customIds.includes(s.id) ? html`<span class="ibx-dot" title="Has its own text"></span>` : null}
                  </button>`) : null}
              </span>
            </div>
            ${item.sourceBound && caps.note && isApprovable(item) ? html`<${CapNote} cap=${{ note: caps.note }} />` : null}
            ${scope !== 'all' ? html`<div class="ibx-muted ibx-scope-note">Editing ${PLATFORM_LABEL[item.siblings.find((s) => s.id === scope)?.platform]} only. "All platforms" edits update every platform that still shares the base text.</div>` : customIds.length ? html`<div class="ibx-muted ibx-scope-note">${customIds.map((id) => PLATFORM_LABEL[item.siblings.find((s) => s.id === id).platform]).join(', ')} ${customIds.length === 1 ? 'has' : 'have'} custom text — not changed by base edits.</div>` : null}
            ${readOnly || !caps.body.edit ? html`<div class="ibx-body is-ro">${socialBody}</div><${CapNote} cap=${isApprovable(item) ? caps.body : null} />` : html`<${BodyEditor} value=${socialBody} onChange=${setSocialBody} onBlur=${save} editorRef=${editorRef} minHeight=${140} />`}
            <div class="ibx-caps">
              ${item.siblings.filter((s) => !excluded.has(s.id)).map((s) => {
                const len = textForPlatform(draft.bodies[s.id]).length;
                const cap = PLATFORM_CAPS[s.platform];
                const pct = cap ? Math.min(100, (len / cap) * 100) : 0;
                return html`<div key=${s.id} class=${cn('ibx-cap', { 'is-bad': cap && len > cap, 'is-warn': cap && len <= cap && len > cap * 0.9 })}>
                  <${BrandIcon} name=${s.platform} size=${11} /><span>${len}/${cap}</span><i><b style=${{ width: `${pct}%` }}></b></i>
                </div>`;
              })}
            </div>
            <${Field} label="Hashtags" hint="part of the text — only tags in the text are posted"><${HashtagEditor} text=${socialBody} onText=${setSocialBody} suggested=${item.suggestedTags} readOnly=${readOnly || !caps.body.edit} /></${Field}>
            ${item.siblings.some((s) => ['linkedin', 'instagram', 'facebook'].includes(s.platform)) && (caps.firstComment.edit || draft.firstComment) ? html`
              <${Field} label="First comment" hint="LinkedIn · Instagram · Facebook">
                <input class="ibx-input" value=${draft.firstComment} placeholder="Optional — e.g. the link, to keep reach up" readOnly=${readOnly || !caps.firstComment.edit} onInput=${(e) => set('firstComment')(e.target.value)} onBlur=${save} />
                ${isApprovable(item) ? html`<${CapNote} cap=${caps.firstComment} />` : null}
              </${Field}>` : null}
          </section>
          <${MediaEditor} images=${draft.images} max=${caps.maxImages} readOnly=${readOnly || !caps.images.edit} platforms=${item.siblings.filter((s) => !excluded.has(s.id)).map((s) => s.platform)} onChange=${set('images')} onOpen=${(i) => openImages(draft.images, i, !readOnly && caps.images.edit && set('images'))} />
          ${isApprovable(item) ? html`<${CapNote} cap=${caps.images} />` : null}
          <section class="ibx-previews">
            <div class="ibx-section-head"><${Icon} name="eye" size=${13} /><span>How it will look</span>
              <span class="ibx-spacer"></span>
              <span class="ibx-seg">
                <button type="button" class=${cn({ 'is-on': !pvPlat })} onClick=${() => setPvPlat(null)}>All</button>
                ${previewPlats.map((s) => html`<button key=${s.id} type="button" class=${cn({ 'is-on': pvPlat === s.id })} onClick=${() => setPvPlat(s.id)} title=${PLATFORM_LABEL[s.platform]}><${BrandIcon} name=${s.platform} size=${11} /></button>`)}
              </span>
            </div>
            <div class=${cn('ibx-pv-list', { 'is-single': shownPv.length === 1 })}>
              ${shownPv.map((s) => html`<${PlatformPreview} key=${s.id} platform=${s.platform} body=${draft.bodies[s.id]}
                images=${draft.images} thread=${item.media.thread} firstComment=${draft.firstComment} excluded=${excluded.has(s.id)}
                onOpen=${(i) => openImages(draft.images, i)} />`)}
            </div>
          </section>
        ` : null}

        <${Checks} item=${item} draft=${draft} standalone=${standalone} />

        ${panel === 'reject' ? html`<${RejectPanel} kind=${item.kind} onConfirm=${reject} onCancel=${() => setPanel(null)} />` : null}
      </div>

      <footer class="ibx-footer">
        <div class="ibx-consequence" title="What approving does">
          ${isApprovable(item) && !armed ? html`<${Icon} name="send" size=${12} /> ${consequence({ ...item, platforms: item.kind === 'social' ? item.siblings.filter((s) => !excluded.has(s.id)).map((s) => s.platform) : item.platforms }, { when: draft.scheduledAt == null || draft.scheduledAt < now ? 'now' : fmtWhen(draft.scheduledAt, now), attachments: caps.attachments.edit ? draft.attachments.length : 0 })}`
            : armed ? html`<${Icon} name="clock" size=${12} /> Sending in ${undo.state?.left}s — undo from the bar below` : null}
          <span class="ibx-spacer"></span>
          <span class=${cn('ibx-save', `is-${saveState.state}`)}>
            ${saveState.state === 'saving' ? 'Saving…' : saveState.state === 'error' ? html`<span title=${saveState.message}>Not saved — ${saveState.message}</span>`
              : dirty ? html`Unsaved · <${Kbd}>⌘S</${Kbd}>` : saveState.state === 'saved' ? `Saved ${hm(new Date(saveState.at))}${saveState.note ? ` · ${saveState.note}` : ''}` : ''}
          </span>
        </div>
        <div class="ibx-actions">
          <button type="button" class="ibx-btn" onClick=${sendToChat} title="Hand this draft to your Chi"><${Icon} name="message-square" size=${13} /> Send to chat</button>
          ${item.kind === 'newsletter' && isApprovable(item) ? html`<button type="button" class="ibx-btn" onClick=${() => api.reject(item, item.ids, 'Skipped this cycle')} title="Skip this cycle's send"><${Icon} name="skip-forward" size=${13} /> Skip cycle</button>` : null}
          <span class="ibx-spacer"></span>
          ${item.status !== 'sending' && !armed ? html`<button type="button" class="ibx-btn is-danger-ghost" onClick=${() => setPanel(panel === 'reject' ? null : 'reject')}>
            ${item.status === 'committed' ? 'Cancel send' : 'Reject…'} <${Kbd}>R</${Kbd}></button>` : null}
          ${dirty && !readOnly ? html`<button type="button" class="ibx-btn" onClick=${save}>Save</button>` : null}
          ${item.status === 'failed' && !inShare ? html`<button type="button" class="ibx-btn is-primary" onClick=${() => api.retry(item, item.siblings.filter((s) => s.status === 'failed').map((s) => s.id))}><${Icon} name="rotate-ccw" size=${13} /> Retry send</button>`
            : isApprovable(item) ? html`<button type="button" class="ibx-btn is-primary is-lg" disabled=${!!blocked || armed} title=${blocked ?? 'Approve (⌘↵)'} onClick=${approve}>
                ${armed ? 'Sending…' : draft.scheduledAt != null && draft.scheduledAt > now ? 'Approve & schedule' : item.kind === 'sequence' ? 'Approve step' : 'Approve & send'} <${Kbd}>⌘↵</${Kbd}></button>`
            : null}
        </div>
        ${blocked && isApprovable(item) && !armed ? html`<div class="ibx-blocked"><${Icon} name="alert-triangle" size=${12} /> ${blocked}</div>` : null}
      </footer>
    </div>`;
}

// ─── Inbox view ───────────────────────────────────────────────────────────────

export function InboxView({ standalone, facetPreset, onCounts, initialSelect }) {
  const qc = useQueryClient();
  const { data, isLoading, isError, error: loadError, refetch } = useInbox(standalone);
  const [filter, setFilter] = useState(() => ({ ...EMPTY_FILTER, ...(facetPreset ?? {}) }));
  const [sort, setSort] = useState('urgency');
  const [selId, setSelId] = useState(initialSelect ?? null);
  const [checked, setChecked] = useState(() => new Set());
  const [bulkReject, setBulkReject] = useState(false);
  const [errors, setErrors] = useState({});
  const [lightbox, setLightbox] = useState(null);
  const [help, setHelp] = useState(false);
  const [now, setNow] = useState(Date.now());
  const undo = useUndo();
  const ctl = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const rowsRef = useRef(new Map());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  // Sidebar / deep-link presets replace the facets (search text survives).
  useEffect(() => { if (facetPreset) setFilter((f) => ({ ...EMPTY_FILTER, q: f.q, ...facetPreset })); }, [facetPreset]);
  useEffect(() => { if (initialSelect) setSelId(initialSelect); }, [initialSelect]);

  const inShare = !!data?.inShare;
  const all = useMemo(() => buildInbox(data?.rows ?? []), [data]);
  useEffect(() => {
    const m = new Map();
    for (const it of all) for (const s of it.siblings) m.set(s.id, s.host);
    rowsRef.current = m;
  }, [all]);
  const counts = useMemo(() => facetCounts(all, now), [all, now]);
  useEffect(() => { onCounts?.(counts); }, [counts]);
  const visible = useMemo(() => sortItems(applyFilter(all, filter, now), sort, now), [all, filter, sort, now]);
  const sections = useMemo(() => (sort === 'urgency' ? sectionize(visible, now) : [{ key: 'all', label: SORTS.find(([k]) => k === sort)?.[1], items: visible }]), [visible, sort, now]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const sel = flat.find((i) => i.id === selId || i.ids.includes(selId)) ?? flat[0] ?? null;
  const pos = sel ? flat.indexOf(sel) : -1;

  useEffect(() => { publishIykeState('outbound.inbox', { selected: sel?.id ?? null, visible: flat.length, total: all.length, filter, sort }); }, [sel?.id, flat.length, all.length, filter, sort]);
  useEffect(() => {
    if (!sel) return;
    listRef.current?.querySelector(`[data-id="${CSS.escape(sel.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel?.id]);

  // ── writes ──
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['inbox'] });
    for (const k of ['email', 'newsletter', 'sequences', 'social', 'counts', 'schedule', 'sent']) qc.invalidateQueries({ queryKey: [k] });
  }, [qc]);
  const setErr = (id, e) => setErrors((p) => ({ ...p, [id]: String(e?.message ?? e) }));
  const clearErr = (ids) => setErrors((p) => { const n = { ...p }; for (const id of ids) delete n[id]; return n; });

  const commitNow = useCallback(async (ids, rejectIds = []) => {
    if (standalone) return;
    for (const id of rejectIds) await hostPaActionsReject(id, 'Excluded platform').catch((e) => setErr(id, e));
    for (const id of ids) {
      const seen = inShare ? rowsRef.current.get(id) ?? undefined : undefined;
      await hostPaActionsCommit(id, seen).catch((e) => setErr(id, e));
    }
    await refresh();
  }, [standalone, inShare, refresh]);

  const api = useMemo(() => ({
    refresh,
    update: (id, patch) => hostPaActionsUpdate(id, patch),
    approve: (item, ids, rejectIds = []) => {
      clearErr(item.ids);
      const label = item.subject || recipientLabel(item);
      undo.arm([...ids, item.id], `“${label.slice(0, 60)}”`, item.undoMs, () => commitNow(ids, rejectIds));
      // Move on to the next draft — the armed one keeps its countdown in the bar.
      const next = flat[flat.indexOf(item) + 1] ?? flat[flat.indexOf(item) - 1];
      if (next) setSelId(next.id);
    },
    reject: async (item, ids, reason) => {
      clearErr(ids);
      if (standalone) return;
      for (const id of ids) await hostPaActionsReject(id, reason).catch((e) => setErr(id, e));
      await refresh();
    },
    retry: async (item, ids) => {
      clearErr(ids);
      if (standalone) return;
      for (const id of ids) await hostPaActionsRetry(id).catch((e) => setErr(id, e));
      await refresh();
    },
  }), [refresh, commitNow, flat, standalone]);

  // ── bulk ──
  const checkedItems = flat.filter((i) => checked.has(i.id));
  const bulkApprovable = checkedItems.filter((i) => isApprovable(i) && !i.outreach && !approveBlockReason(i));
  const toggleCheck = (id) => setChecked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const bulkApprove = () => {
    const ids = bulkApprovable.flatMap((i) => i.ids);
    undo.arm(ids, `${bulkApprovable.length} drafts`, 10_000, () => commitNow(ids));
    setChecked(new Set());
  };
  const doBulkReject = async (reason) => {
    setBulkReject(false);
    const items = checkedItems;
    setChecked(new Set());
    for (const it of items) await api.reject(it, it.ids, reason ?? 'Bulk rejected');
  };

  // ── keyboard ──
  const nav = (d) => { if (!flat.length) return; const i = Math.min(flat.length - 1, Math.max(0, pos + d)); setSelId(flat[i].id); };
  const navRef = useRef(nav);
  navRef.current = { nav, sel, toggleCheck, setHelp };
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      const { nav: go, sel: cur, toggleCheck: tc, setHelp: sh } = navRef.current;
      if (mod && e.key === 'Enter') { e.preventDefault(); ctl.current?.approve(); return; }
      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); ctl.current?.save(); return; }
      if (e.key === 'Escape') {
        if (ctl.current?.hasPanel()) { ctl.current.closePanel(); return; }
        if (typing) { t.blur(); return; }
        sh(false); return;
      }
      if (typing || mod || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); go(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
      else if (e.key === 'x' && cur) { e.preventDefault(); tc(cur.id); }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'r') { e.preventDefault(); ctl.current?.openReject(); }
      else if (e.key === 'e') { e.preventDefault(); ctl.current?.focusEditor(); }
      else if (e.key === 'u' && undo.state) { e.preventDefault(); undo.cancel(); }
      else if (e.key === '?') { e.preventDefault(); sh((h) => !h); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo.state]);

  const openImages = (images, index = 0, onChange) => setLightbox({ images, index, onChange: onChange || null });
  const workerIdle = all.filter((i) => i.status === 'committed' && i.committedAt && now - i.committedAt > WORKER_IDLE_MS && (i.scheduledAt == null || i.scheduledAt < now));

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading outbox…" />`;
  if (isError) {
    return html`<div class="atelier-state is-error"><${Icon} name="alert-circle" size=${24} />
      <p>${inShare ? 'Drafts are not available in this share' : "Can't read the outbox queue here."}</p>
      <p class="ibx-muted">${String(loadError?.message ?? loadError ?? '')}</p>
      <button class="ibx-btn" onClick=${() => refetch()}>Retry</button></div>`;
  }

  return html`
    <div class="ibx" data-share=${inShare ? 'true' : undefined}>
      <div class="ibx-list" aria-label="Outbox queue">
        <${FacetBar} filter=${filter} setFilter=${setFilter} counts=${counts} sort=${sort} setSort=${setSort} searchRef=${searchRef} />
        ${workerIdle.length ? html`<div class="ibx-health"><${Icon} name="alert-triangle" size=${12} /> ${workerIdle.length} approved draft${workerIdle.length === 1 ? '' : 's'} waiting on the send worker for ${fmtRel(Math.min(...workerIdle.map((i) => i.committedAt)), now).replace(' ago', '')} — is <code>mutation:send-worker</code> running?</div>` : null}
        ${checked.size ? html`
          <div class="ibx-bulk" role="region" aria-label="Bulk actions">
            <b>${checked.size} selected</b>
            <button type="button" class="ibx-btn is-ghost" onClick=${() => setChecked(new Set(flat.map((i) => i.id)))}>Select all ${flat.length}</button>
            <span class="ibx-spacer"></span>
            <button type="button" class="ibx-btn is-primary" disabled=${!bulkApprovable.length} title=${bulkApprovable.length < checked.size ? 'Outreach, blocked and non-awaiting drafts are skipped' : ''} onClick=${bulkApprove}>Approve ${bulkApprovable.length}</button>
            <button type="button" class="ibx-btn is-danger-ghost" onClick=${() => setBulkReject(true)}>Reject…</button>
            <button type="button" class="ibx-btn is-ghost" onClick=${() => setChecked(new Set())}>Clear</button>
          </div>
          ${bulkReject ? html`<div class="ibx-bulk-reject"><${RejectPanel} kind=${checkedItems[0]?.kind ?? 'email'} many=${checked.size} onConfirm=${doBulkReject} onCancel=${() => setBulkReject(false)} /></div>` : null}` : null}
        <div class="ibx-rows" role="listbox" aria-label="Drafts" ref=${listRef}>
          ${!all.length ? html`<div class="ibx-empty"><${Icon} name="check-check" size=${28} /><b>Outbox is clear</b><span>Nothing is waiting for your approval. New drafts from your agents land here.</span></div>`
            : !flat.length ? html`<div class="ibx-empty"><${Icon} name="filter" size=${24} /><b>No drafts match</b><button type="button" class="ibx-btn" onClick=${() => setFilter({ ...EMPTY_FILTER })}>Clear filters</button></div>`
            : sections.map((s) => html`
              <div key=${s.key} class=${cn('ibx-section', `is-${s.key}`)}>
                <div class="ibx-section-title"><span>${s.label}</span><span class="ibx-muted">${s.items.length}</span></div>
                ${s.items.map((it) => html`<${Row} key=${it.id} item=${it} now=${now} selected=${sel?.id === it.id} checked=${checked.has(it.id)}
                  onPick=${setSelId} onCheck=${toggleCheck} error=${it.ids.map((id) => errors[id]).find(Boolean)}
                  undoLeft=${undo.isArmed(it.id) ? undo.state.left : null} onOpenImage=${openImages} />`)}
              </div>`)}
        </div>
        <div class="ibx-list-foot">
          <button type="button" class="ibx-btn is-ghost" onClick=${() => setHelp((h) => !h)}><${Icon} name="keyboard" size=${13} /> Shortcuts <${Kbd}>?</${Kbd}></button>
          <span class="ibx-spacer"></span>
          <span class="ibx-muted">${flat.length === all.length ? `${all.length} drafts` : `${flat.length} of ${all.length}`}${data?.source === 'db' ? ' · legacy read' : ''}${standalone ? ' · demo data' : ''}</span>
        </div>
      </div>

      <div class="ibx-detail-wrap">
        ${sel ? html`<${InboxDetail} key=${sel.id} item=${sel} pos=${pos} total=${flat.length} onNav=${nav} ctl=${ctl} now=${now}
            standalone=${standalone} inShare=${inShare} error=${sel.ids.map((id) => errors[id]).find(Boolean)} undo=${undo} api=${api}
            onViewSequence=${(name) => setFilter({ ...EMPTY_FILTER, sequence: name })} openImages=${openImages} />`
          : html`<div class="ibx-empty is-detail"><${Icon} name="inbox" size=${28} /><span>${all.length ? 'Select a draft to review' : 'All caught up'}</span></div>`}
      </div>

      ${undo.state ? html`
        <div class="ibx-undo" role="status" aria-live="polite">
          <span class="ibx-undo-ring" style=${{ '--p': undo.state.left / 10 }}>${undo.state.left}</span>
          <span>Sending ${undo.state.label} in <b>${undo.state.left}s</b></span>
          <button type="button" class="ibx-btn" onClick=${undo.cancel}>Undo <${Kbd}>U</${Kbd}></button>
          <button type="button" class="ibx-btn is-ghost" onClick=${undo.flush} title="Skip the countdown">Send now</button>
        </div>` : null}

      ${help ? html`
        <div class="ibx-help" role="dialog" aria-label="Keyboard shortcuts" onClick=${() => setHelp(false)}>
          <div class="ibx-help-card" onClick=${(e) => e.stopPropagation()}>
            <div class="ibx-section-head"><${Icon} name="keyboard" size=${13} /><span>Keyboard</span><span class="ibx-spacer"></span><button type="button" class="ibx-btn is-ghost" onClick=${() => setHelp(false)}>×</button></div>
            <dl>
              ${[['J / ↓', 'Next draft'], ['K / ↑', 'Previous draft'], ['X', 'Select for bulk'], ['/', 'Search'], ['E', 'Edit body'], ['⌘S', 'Save edits'], ['⌘↵', 'Approve'], ['R', 'Reject…'], ['U', 'Undo send'], ['Esc', 'Close / leave field']]
                .map(([k, l]) => html`<div key=${k}><dt><${Kbd}>${k}</${Kbd}></dt><dd>${l}</dd></div>`)}
            </dl>
          </div>
        </div>` : null}

      ${lightbox ? html`<${Lightbox} images=${lightbox.images} index=${lightbox.index} editable=${!!lightbox.onChange}
          onChange=${(next) => { lightbox.onChange?.(next); setLightbox((l) => (l ? { ...l, images: next } : l)); }}
          onClose=${() => setLightbox(null)} />` : null}
    </div>`;
}

// ─── Schedule · All (unified calendar over the same rows) ─────────────────────

export function InboxScheduleList({ standalone, onOpen }) {
  const { data, isLoading } = useInbox(standalone);
  const now = Date.now();
  const items = useMemo(() => sortItems(buildInbox(data?.rows ?? []).filter((i) => i.scheduledAt != null), 'scheduled', now), [data]);
  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading schedule…" />`;
  if (!items.length) return html`<${StateDisplay} state="empty" message="Nothing scheduled" />`;
  const days = new Map();
  for (const it of items) {
    const d = new Date(it.scheduledAt); d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(it);
  }
  return html`<div class="ibx-agenda">
    ${[...days.entries()].map(([k, list]) => html`
      <section key=${k} class="ibx-agenda-day">
        <h3>${fmtWhen(k, now).replace(/ 00:00$/, '')}<span class="ibx-muted">${list.length}</span></h3>
        ${list.map((it) => html`
          <button key=${it.id} type="button" class=${cn('ibx-agenda-item', `is-${displayStatus(it, now)}`)} onClick=${() => onOpen(it.id)}>
            <span class="ibx-agenda-time">${hm(new Date(it.scheduledAt))}</span>
            <${KindMark} kind=${it.kind} size=${12} />
            <span class="ibx-agenda-subj">${it.subject || it.body.slice(0, 80)}</span>
            <span class="ibx-muted">${recipientLabel(it)}</span>
            <${DestMarks} item=${it} size=${12} />
            ${allImages(it).length ? html`<${ThumbStrip} images=${allImages(it)} max=${2} />` : null}
            <${StatusPill} status=${displayStatus(it, now)} />
          </button>`)}
      </section>`)}
  </div>`;
}

// ─── Rejected history (reasons surfaced) ──────────────────────────────────────

export function RejectedList({ standalone }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sent', 'rejected'],
    queryFn: () => fetchInboxRows('rejected'),
    enabled: !standalone,
    placeholderData: standalone ? { rows: [] } : undefined,
  });
  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading rejected drafts…" />`;
  if (isError) return html`<${StateDisplay} state="error" message="Can't read rejected drafts here." />`;
  const rows = (data?.rows ?? []).map((r) => { try { return { r, it: normalizeRow(r) }; } catch { return null; } }).filter(Boolean);
  if (!rows.length) return html`<${StateDisplay} state="empty" message="No rejected drafts" />`;
  return html`<table class="ibx-table">
    <thead><tr><th>Draft</th><th>To</th><th>Via</th><th>Reason</th></tr></thead>
    <tbody>${rows.map(({ r, it }) => html`<tr key=${it.id}>
      <td><${KindMark} kind=${it.kind} size=${12} /> ${it.subject || it.body.slice(0, 60)}</td>
      <td>${recipientLabel(it)}</td>
      <td><${DestMarks} item=${it} size=${12} /></td>
      <td>${r.rejectReason ?? r.reject_reason ?? html`<span class="ibx-muted">no reason given</span>`}</td>
    </tr>`)}</tbody>
  </table>`;
}

export { Img };
