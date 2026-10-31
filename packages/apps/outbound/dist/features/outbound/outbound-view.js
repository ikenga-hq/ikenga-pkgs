// Outbound main view — Email / Newsletter / Sequences / Social.
//
// Composition follows plans/atelier-design-system/parts/screens/outbound.md §§1–4:
//   - .frame / .frame-head / .frame-body-flush (kit part 30 pkg-pane-frame)
//   - .ob-header — channel name h1 + subtitle (domain-local)
//   - .nl-inner-tabs — Approval queue / Schedule / Sent inner tab strip
//   - .nl-split master/detail (Approval queue views)
//   - .nl-cal-wrap calendar grid (Schedule view for Email/Newsletter/Social)
//   - .ob-seq-list Active sequence list (Schedule view for Sequences — G-11 rule)
//   - .nl-sent-toolbar + table/charts toggle (Sent view)
//   - .nav-group[data-kind] / .nav-item / .nav-item.is-on via setMenu
//   - .atelier-state.is-{loading,empty,error,streaming} (kit part 26)
//   - .ob-chip.* (domain-local channel identity + status chips)
//
// Design reference: plans/atelier/designs/atelier-outbound*.html (locked R10/R12/R13)
// Data: SINGLE SOURCE — pa_action_drafts (approve-gate + mutation-worker seam) via
//       host.dbQuery, mapped per content type by dist/lib/derive.js (G-DERIVE).
//       plans/outbound-pkg/01-plan.md.

import {
  html,
  cn,
  Icon,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useQuery,
  useMutation,
  useQueryClient,
  useAutoGrow,
} from '../../lib/ui.js';
import {
  hostDbQuery,
  hostFetch,
  setMenu,
  isStandalone,
  publishIykeState,
  hostNavigate,
  hostSendToActiveSession,
  hostDbExec,
  hostPaActionsCommit,
  hostPaActionsReject,
  hostPaActionsRetry,
  hostPaActionsUpdate,
} from '../../lib/bridge.js';
import {
  QUEUE_STATUSES,
  SENT_STATUSES,
  SCHEDULE_STATUSES,
  deriveContentType,
  parseDraft,
  countByContentType,
  mapEmailQueue,
  mapEmailSent,
  mapNewsletterQueue,
  mapNewsletterSent,
  mapSocialQueue,
  mapSocialSent,
  mapSequenceQueue,
  newsletterHistorySignals,
  claimsVerdictCell,
  toneVerdictCell,
} from '../../lib/derive.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const CHANNELS = ['email', 'newsletter', 'sequences', 'social'];

const CHANNEL_META = {
  email: {
    label: 'Email',
    icon: 'mail',
    subtitle: 'Transactional · Cold · Drip',
    views: ['queue', 'schedule', 'sent'],
    viewLabels: { queue: 'Approval queue', schedule: 'Schedule', sent: 'Sent' },
  },
  newsletter: {
    label: 'Newsletter',
    icon: 'book-open',
    subtitle: 'Campaigns · Investor updates',
    views: ['queue', 'schedule', 'sent'],
    viewLabels: { queue: 'Approval queue', schedule: 'Schedule', sent: 'Sent' },
  },
  sequences: {
    label: 'Sequences',
    icon: 'git-branch',
    subtitle: 'Per-recipient drip chains',
    views: ['queue', 'schedule', 'sent'],
    // G-11 rule: Sequences "Schedule" tab = "Active" (sequences run per-recipient)
    viewLabels: { queue: 'Approval queue', schedule: 'Active', sent: 'Sent' },
  },
  social: {
    label: 'Social',
    icon: 'share2',
    subtitle: 'Buffer · LinkedIn · X',
    views: ['queue', 'schedule', 'sent'],
    viewLabels: { queue: 'Approval queue', schedule: 'Schedule', sent: 'Sent' },
  },
};

// Agent filter items (By agent group — filter semantics)
const AGENT_ITEMS = [
  { id: 'f:pa',  label: 'PA',  section: 'By agent' },
  { id: 'f:cmo', label: 'CMO', section: 'By agent' },
  { id: 'f:cbo', label: 'CBO', section: 'By agent' },
];

// ─── Initial channel/view resolution (deep-link, WP-07) ─────────────────────────
// The shell deep-links /outbox/{email,newsletter,social,sequences,approvals} into
// this pkg and pre-seeds usePkgMenuStore activeFeature as 'v:<view>' (F9). The
// iframe is also mounted at the matching sub-route (pathname '/email' etc.). We
// honour BOTH: the pre-seeded activeFeature wins, the pathname is the fallback.
// 'approvals' is the cross-channel folded approve-gate; the channels map 1:1 to
// the per-channel Approval queue. Returns { channel, view } where view is one of
// 'queue' | 'approvals' (deep-links only ever land on a queue/approvals surface).

function viewFromToken(token) {
  if (!token) return null;
  // 'approvals' → cross-channel; a channel name → that channel's queue.
  if (token === 'approvals') return { channel: 'newsletter', view: 'approvals' };
  if (CHANNELS.includes(token)) return { channel: token, view: 'queue' };
  return null;
}

function parseInitialTarget(activeFeature) {
  // 1. Pre-seeded activeFeature: 'ch:<channel>' or 'v:<view>'.
  if (typeof activeFeature === 'string') {
    if (activeFeature.startsWith('ch:')) {
      const r = viewFromToken(activeFeature.slice(3));
      if (r) return r;
    }
    if (activeFeature.startsWith('v:')) {
      const r = viewFromToken(activeFeature.slice(2));
      if (r) return r;
    }
  }
  // 2. Pathname fallback: the last segment of /pkg/com.ikenga.outbound/<seg>.
  try {
    const segs = (window.location?.pathname || '').split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    const r = viewFromToken(last);
    if (r) return r;
  } catch {
    /* no window/location in some embeds — fall through to default */
  }
  return null;
}

// ─── Menu builder ───────────────────────────────────────────────────────────────

/**
 * Build the flat menu item list for setMenu.
 * @param {string} channel  current channel (email/newsletter/sequences/social)
 * @param {string} view     current view (queue/schedule/sent)
 * @param {Object} counts   { email, newsletter, sequences, social } queue counts
 * @param {Object} agents   { pa, cmo, cbo } agent counts
 */
function buildOutboundMenu(channel, view, counts = {}, agents = {}, countsError = false, agentsError = false) {
  // Channels group (view kind = mutually exclusive radio)
  const channelItems = CHANNELS.map((ch) => {
    const meta = CHANNEL_META[ch];
    const count = counts?.[ch] ?? 0;
    const badge = countsError ? '—' : (count > 0 ? count : undefined);
    return {
      id: `ch:${ch}`,
      label: meta.label,
      icon: meta.icon,
      section: 'Channels',
      active: ch === channel,
      hot: !countsError && count > 0,
      badge,
    };
  });

  // By-agent group (filter kind = non-exclusive facets)
  // Dims when view !== 'queue' (toolbar-facet-sidebar pattern)
  const isQueueView = view === 'queue';
  const agentItems = AGENT_ITEMS.map((it) => {
    const key = it.id.replace('f:', '');
    const count = agents?.[key] ?? 0;
    const badge = agentsError ? '—' : (count > 0 ? count : undefined);
    return {
      ...it,
      active: false,
      disabled: !isQueueView,
      badge,
    };
  });

  return [...channelItems, ...agentItems];
}

// ─── Queries — single source: pa_action_drafts (approve-gate + worker seam) ──
// All channel surfaces derive from ONE table via dist/lib/derive.js. `channel` is
// the provider; deriveContentType() splits email/newsletter/social/sequences.
// host.dbQuery reads are NOT table-scoped, so no manifest change is needed here.

const SEL_COLS = `id, batch_id, action_id, status, channel, payload_json, edited_json,
  scheduled_at, created_at, committed_at, sent_at, attempts, error_text, external_id, delivery_status`;

let dbQueryFn = hostDbQuery;
export function setDbQueryForTesting(fn) {
  dbQueryFn = fn;
}

let navigateFn = hostNavigate;
export function setNavigateForTesting(fn) {
  navigateFn = fn;
}

export async function loadDrafts(statuses, { limit = 300 } = {}) {
  if (isStandalone()) return [];
  const ph = statuses.map(() => '?').join(',');
  return await dbQueryFn(
    `SELECT ${SEL_COLS} FROM pa_action_drafts WHERE status IN (${ph})
     ORDER BY COALESCE(sent_at, scheduled_at, created_at) DESC LIMIT ${limit}`,
    statuses
  );
}

// Filter loaded rows to one content type + map to the renderer's view shape.
function pick(rows, ct, mapper) {
  const out = [];
  for (const r of rows || []) {
    if (deriveContentType(parseDraft(r).item) === ct) out.push(mapper(r));
  }
  return out;
}
const hasSchedule = (r) => !!r.scheduled_at;

export async function fetchChannelCounts() {
  if (isStandalone()) return { email: 5, newsletter: 2, sequences: 4, social: 4 };
  return countByContentType(await loadDrafts(QUEUE_STATUSES));
}

export async function fetchAgentCounts(channel) {
  if (isStandalone()) return { pa: 4, cmo: 5, cbo: 2 };
  const results = { pa: 0, cmo: 0, cbo: 0 };
  for (const r of await loadDrafts(QUEUE_STATUSES)) {
    const { item, meta } = parseDraft(r);
    if (deriveContentType(item) !== channel) continue;
    const key = String(meta.agent || 'pa').toLowerCase();
    if (key in results) results[key] += 1;
  }
  return results;
}

// ── Email ────────────────────────────────────────────────────────────────────
export async function fetchEmailQueue() {
  if (isStandalone()) return FIXTURE_EMAIL_QUEUE;
  return pick(await loadDrafts(QUEUE_STATUSES), 'email', mapEmailQueue);
}

export async function fetchEmailSchedule() {
  if (isStandalone()) return FIXTURE_EMAIL_SCHEDULE;
  const rows = (await loadDrafts(SCHEDULE_STATUSES)).filter(hasSchedule);
  return pick(rows, 'email', mapEmailQueue);
}

export async function fetchEmailSent() {
  if (isStandalone()) return FIXTURE_EMAIL_SENT;
  return pick(await loadDrafts(SENT_STATUSES), 'email', mapEmailSent);
}

// ── Newsletter ────────────────────────────────────────────────────────────────
export async function fetchNewsletterQueue() {
  if (isStandalone()) return FIXTURE_NL_QUEUE;
  return pick(await loadDrafts(QUEUE_STATUSES), 'newsletter', mapNewsletterQueue);
}

export async function fetchNewsletterSent() {
  if (isStandalone()) return FIXTURE_NL_SENT;
  return pick(await loadDrafts(SENT_STATUSES), 'newsletter', mapNewsletterSent);
}

// ── Newsletter sent-history (WP-11) ──────────────────────────────────────────
// Merges newsletter_sends rows + pa_action_drafts sent listmonk rows into a
// uniform shape: { subject, draft_slug, edition, sent_at, body }.
async function fetchNewsletterHistory() {
  if (isStandalone()) return FIXTURE_NL_HISTORY;
  const sendsRows = await dbQueryFn(
    `SELECT draft_slug, edition, subject, subject_alt, sent_at FROM newsletter_sends ORDER BY sent_at DESC LIMIT 200`,
    []
  );
  let draftsRows = [];
  try {
    draftsRows = await dbQueryFn(
      `SELECT payload_json, sent_at FROM pa_action_drafts
       WHERE channel = 'listmonk' AND status = 'sent'
       ORDER BY sent_at DESC LIMIT 200`,
      []
    );
  } catch (e) {
    if (isPermissionRefusal(e)) throw e;
    /* pa_action_drafts read failure — degrade gracefully only if not permission refusal */
  }

  const out = [];

  // newsletter_sends rows are already normalised.
  for (const r of sendsRows) {
    out.push({
      subject: r.subject || r.subject_alt || null,
      draft_slug: r.draft_slug || null,
      edition: r.edition || null,
      sent_at: r.sent_at || null,
      body: null, // newsletter_sends has no body column
    });
  }

  // pa_action_drafts (listmonk, sent): extract item.subject + item.body from payload_json.
  for (const r of draftsRows) {
    let item = {};
    try {
      const payload = typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json || {};
      item = payload.item || payload || {};
    } catch {
      item = {};
    }
    out.push({
      subject: item.subject || null,
      draft_slug: item.section || null,
      edition: null,
      sent_at: r.sent_at || null,
      body: item.body || null,
    });
  }

  return out;
}

// Fixture history for standalone mode — one repeated subject + one shared link.
// Allows the scorecard cells to demo non-stub values without a live DB.
const FIXTURE_NL_HISTORY = [
  {
    subject: 'You can deliver from Royalti now',
    draft_slug: 'royalti-deliver',
    edition: 'April 2026',
    sent_at: '2026-04-15 10:00:00',
    body: 'Royalti now ships a full delivery pipeline.\n\nhttps://royalti.io/deliver\n\nRuby',
  },
  {
    subject: 'Schema patches that unblocked tenant 590',
    draft_slug: 'schema-patches-590',
    edition: 'May 2026',
    sent_at: '2026-05-06 10:00:00',
    body: 'Tenant 590 hit a wall last month.\nhttps://royalti.io/blog/schema-patches\n\nRuby',
  },
];

// ── Sequences (flat first slice; cohort grid + funnel are Phase 2) ─────────────
// A "sequence" = pa_action_drafts rows whose item.sequence is set, grouped by name.
function seqGroups(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const { item } = parseDraft(r);
    if (deriveContentType(item) !== 'sequences') continue;
    const name = (item.sequence && item.sequence.name) || item.subject || '(sequence)';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ r, item });
  }
  return groups;
}

export async function fetchSequenceDefs() {
  if (isStandalone()) return FIXTURE_SEQ_DEFS;
  const defs = [];
  for (const [name, members] of seqGroups(await loadDrafts([...QUEUE_STATUSES, ...SENT_STATUSES]))) {
    const { r, item } = members[0];
    const seq = item.sequence || {};
    defs.push({ id: r.batch_id || r.id, name, slug: r.batch_id || null, segment: item.recipient || null,
                total_steps: seq.total ?? null, delivery_system: r.channel, status: 'active' });
  }
  return defs;
}

export async function fetchActiveSequences() {
  if (isStandalone()) return FIXTURE_ACTIVE_SEQS;
  const out = [];
  for (const r of await loadDrafts(QUEUE_STATUSES)) {
    const { item } = parseDraft(r);
    if (deriveContentType(item) !== 'sequences') continue;
    const seq = item.sequence || {};
    out.push({ id: r.id, sequence_id: r.batch_id || r.id, contact_email: item.recipientEmail || item.recipient || 'batch',
               segment: item.recipient || null, current_step: seq.step ?? 1, total_steps: seq.total ?? null,
               next_send_date: r.scheduled_at || null, status: 'active', sent_count: seq.recipients ?? 0,
               sequence_name: seq.name || item.subject, sequence_slug: r.batch_id || null, delivery_system: r.channel });
  }
  return out;
}

export async function fetchSequenceQueue() {
  if (isStandalone()) return FIXTURE_SEQ_QUEUE;
  return pick(await loadDrafts(QUEUE_STATUSES), 'sequences', mapSequenceQueue);
}

// Per-step rail + per-recipient cohort are Phase 2 (steps/recipients aren't modeled
// as distinct rows yet) — return empty so the renderer empty-states honestly.
export async function fetchSequenceSteps(sequenceId) {
  return sequenceId ? [] : [];
}

export async function fetchSequenceRecipients(sequenceId) {
  return sequenceId ? [] : [];
}

export async function fetchSentSequences() {
  if (isStandalone()) return FIXTURE_SENT_SEQS;
  const out = [];
  for (const [name, members] of seqGroups(await loadDrafts(SENT_STATUSES))) {
    const { r, item } = members[0];
    const seq = item.sequence || {};
    const enrolled = members.length;
    const bounced = members.filter((m) => m.r.delivery_status === 'bounced').length;
    out.push({ sequence_id: r.batch_id || r.id, sequence_name: name, sequence_slug: r.batch_id || null,
               total_steps: seq.total ?? null, enrolled, completed: enrolled, replied: 0, bounced,
               sent_total: enrolled, closed_at: r.sent_at || null });
  }
  return out;
}

// Relative-age label for the reply-intelligence "last touch" cell.
// compact:true → terse top-right form for email rows ("15m", "6h", "2d", "just now").
function relDays(iso, { compact = false } = {}) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const ms = Date.now() - t;
  if (ms < 0) return compact ? '' : '—'; // future
  const mins = Math.round(ms / 60_000);
  if (compact && mins < 2) return 'just now';
  const d = Math.round(ms / 86_400_000);
  if (compact) {
    if (mins < 60) return `${mins}m`;
    const h = Math.round(ms / 3_600_000);
    if (h < 24) return `${h}h`;
    if (d < 7) return `${d}d`;
    if (d < 30) return `${Math.round(d / 7)}w`;
    if (d < 365) return `${Math.round(d / 30)}mo`;
    return `${Math.round(d / 365)}y`;
  }
  if (d <= 0) return 'today';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

// From-label for email queue grouped rows (spec 01-email-grouping.md §5).
function emailFromLabel(row) {
  if (row.emailGroup === 'sequence') {
    const who = row.drafted_by ?? '—';
    const seq = row.sequence_id ?? '—';
    return `${who} → ${seq}`;
  }
  if (row.emailGroup === 'reply') {
    return row.recipient_name || row.recipient_email || '—';
  }
  // manual
  const who = row.drafted_by ?? '—';
  const recip = row.recipient_name || row.recipient_email;
  return recip ? `${who} → ${recip}` : who;
}

// Reply-intelligence: CRM context for an email recipient (B.5).
//
// WP-07 (trusted-pkg): we now try a LIVE pull from Twenty CRM first via the
// trusted-tier `host.fetch` verb — single-person lookup by primaryEmail, mapped
// Live-only via host.fetch (D-04: local mirror retired, host.fetch live-verified).
// On host.fetch throw (Twenty down / old shell) → null (→ "Unknown sender" empty
// state). On clean no-match → also null. Never crashes the panel.
// NOTE: mirror scripts (twenty-mirror.mjs/.sh, twenty-mirror-drain, jobs.json
// cron entries) are deleted separately on the ops side.
async function fetchReplyIntelligence(email) {
  if (!email) return null;
  try {
    return await fetchReplyIntelligenceLive(email);
  } catch {
    /* host.fetch unavailable (Twenty down / shell without the verb) → graceful null */
    return null;
  }
}

// Twenty REST base + the single-person query the mirror uses
// (twenty-mirror.mjs::fetchPersonByEmail). `depth=1` so the person's company is
// embedded for the organization label. Allowlisted via permissions.net.
const TWENTY_REST_BASE = 'https://twenty.royalti.io/rest';

// Live single-recipient pull from Twenty CRM via host.fetch. Returns the
// reply-intelligence shape, or null if Twenty has no match for this email.
// Throws (caller catches → fallback) when host.fetch is unavailable / errors.
async function fetchReplyIntelligenceLive(email) {
  // Mirror twenty-mirror.mjs::fetchPersonByEmail's filter; depth=1 embeds company.
  const filter = `emails.primaryEmail[eq]:${encodeURIComponent(email)}`;
  const url = `${TWENTY_REST_BASE}/people?filter=${filter}&depth=1&limit=1`;
  const res = await hostFetch({ url, method: 'GET' });
  if (!res || res.ok !== true) {
    throw new Error(res?.reason ?? `host.fetch failed (status ${res?.status ?? '?'})`);
  }
  // `body` is a STRING — JSON.parse it (the auth secret is host-side only).
  let parsed;
  try {
    parsed = JSON.parse(res.body ?? 'null');
  } catch {
    throw new Error('host.fetch: Twenty response body was not JSON');
  }
  const person = parsed?.data?.people?.[0] ?? null;
  if (!person) return null; // no CRM match → null (→ "Unknown sender" empty state)
  return await mapTwentyPersonToReplyIntel(person, email);
}

// Map a Twenty `/rest/people` person (with embedded `company` at depth=1) into
// the exact reply-intelligence return shape. Field derivation mirrors
// twenty-mirror.mjs's mapping helpers (personName/personOrg). Twenty supplies
// person/org/health/last-touch; local `receivables` supplies open_balance (joined
// best-effort — a failure here leaves balance as '—' and never crashes the panel).
async function mapTwentyPersonToReplyIntel(p, email) {
  const first = p?.name?.firstName ?? '';
  const last = p?.name?.lastName ?? '';
  const fullName = [first, last].filter(Boolean).join(' ').trim() || null;
  // depth=1 embeds the related company object on the person.
  const org = p?.company?.name ?? null;
  const lastSeen = p?.updatedAt ?? null;

  const lastMs = lastSeen ? Date.parse(lastSeen) : NaN;
  const ageDays = Number.isFinite(lastMs) ? (Date.now() - lastMs) / 86_400_000 : null;
  const health = ageDays == null ? '—' : ageDays < 30 ? 'Active' : ageDays < 90 ? 'Cooling' : 'Dormant';

  // Join local receivables for open balance + overdue count (same query the
  // former local path used; best-effort so host DB absence degrades gracefully).
  let bal = null;
  let overdue = 0;
  try {
    const br = await hostDbQuery(
      `SELECT SUM(CAST(balance_left AS REAL)) AS bal,
              SUM(CASE WHEN invoice_status = 'overdue' THEN 1 ELSE 0 END) AS od
       FROM receivables WHERE LOWER(customer_email) = LOWER(?)`,
      [email]
    );
    bal = br?.[0]?.bal ?? null;
    overdue = Number(br?.[0]?.od ?? 0);
  } catch {
    /* receivables lookup is best-effort */
  }

  // WP-17 item 7: Catalog + Owner were permanently '—'. Twenty at depth=1 embeds
  // the company but not a catalog link (no such field) and only surfaces an owner
  // if the account-owner relation happens to be embedded. Attempt the owner
  // best-effort; otherwise show an HONEST labeled "Not synced" state instead of a
  // bare em-dash that reads like missing data.
  const ownerRel = p?.company?.accountOwner ?? p?.accountOwner ?? p?.pointOfContact ?? null;
  const ownerName = ownerRel
    ? ([ownerRel?.name?.firstName, ownerRel?.name?.lastName].filter(Boolean).join(' ').trim()
       || ownerRel?.userEmail || ownerRel?.name || null)
    : null;

  return {
    tenant_name: org || fullName || email,
    tenant_sub: 'crm', // Twenty source classification (mirrors contact_type='crm')
    last_touch: lastSeen ? relDays(lastSeen) : '—',
    last_touch_sub: null, // Twenty has no interaction_count on the person record
    health,
    health_sub: ageDays == null ? null : `${Math.round(ageDays)}d since contact`,
    catalog: 'Not synced',
    catalog_sub: 'no catalog field in CRM',
    open_balance: bal == null ? '—' : `$${Math.round(bal).toLocaleString()}`,
    balance_sub: overdue > 0 ? `${overdue} overdue` : bal != null ? 'current' : null,
    owner: ownerName || 'Not synced',
    owner_sub: ownerName ? 'CRM account owner' : 'not in CRM sync (depth=1)',
    risk_flag: overdue > 0 ? 'Overdue invoice' : 'None',
    risk_color: overdue > 0 ? 'var(--danger)' : 'var(--live)',
  };
}

// ─── Social queries ─────────────────────────────────────────────────────────────

export async function fetchSocialQueue() {
  if (isStandalone()) return FIXTURE_SOCIAL_QUEUE;
  return pick(await loadDrafts(QUEUE_STATUSES), 'social', mapSocialQueue);
}

export async function fetchSocialSchedule() {
  if (isStandalone()) return FIXTURE_SOCIAL_SCHEDULE;
  const rows = (await loadDrafts(SCHEDULE_STATUSES)).filter(hasSchedule);
  return pick(rows, 'social', mapSocialQueue);
}

export async function fetchSocialSent() {
  if (isStandalone()) return FIXTURE_SOCIAL_SENT;
  return pick(await loadDrafts(SENT_STATUSES), 'social', mapSocialSent);
}

// ── Approval mutations — the FOLDED approve-gate write path (WP-04, G-PAACTIONS) ──
// SINGLE SOURCE: every channel's approve/reject/retry/edit operates on the
// pa_action_drafts row `id` via the new host.paActions* verbs (Strategy B —
// thin shell wrappers over the tested pa_actions_* Rust commands). The legacy
// `src` branching is GONE: ids are now pa_action_drafts ids, identical across
// channels, so there is one commit path. Approve uses a 10s LOCAL undo window
// (no DB write during the window — see useUndoCommit); these fns fire only after
// the timer elapses (commit) or immediately (reject/retry/edit).
//
//   approve → host.paActions.commit  (status → committed → worker sends)
//   reject  → host.paActions.reject  (will not send)
//   retry   → host.paActions.retry   (failed → committed; clears claim/error + wakes)
//   edit    → host.paActions.update  ({subject,body} → edited_json, awaiting→edited)
//
// NOTE: reject reason text is captured in the pkg UI for the writer-agent training
// set, but the shell pa_actions_reject verb takes only the draftId (it does not
// persist a free-text reason on the row) — the reason is surfaced to chat/handoff,
// not written to pa_action_drafts. So the channel-specific reject fns ignore the
// reason for the write and just call the verb.

async function approveDraft(id) {
  // Defense-in-depth (review G-01): only commit a row that is still awaiting/edited.
  // pa_actions_commit guards on its SELECT (status IN awaiting/edited) but the UPDATE
  // has no status predicate — this FE pre-check closes the TOCTOU window before the
  // verb round-trip. Committing an already committed/sending/sent row would otherwise
  // flip it back to 'committed' and the worker could DOUBLE-SEND. This also closes the
  // 10s-undo-window race (if the row changed while the timer ran).
  const rows = await hostDbQuery('SELECT status FROM pa_action_drafts WHERE id = ?', [id]);
  const st = rows?.[0]?.status;
  if (st !== 'awaiting' && st !== 'edited') {
    throw new Error(`cannot approve: draft is '${st ?? 'missing'}' (only awaiting/edited can be sent)`);
  }
  await hostPaActionsCommit(id);
}

async function rejectDraft(id, _reason = null) {
  await hostPaActionsReject(id);
}

async function retryDraft(id) {
  await hostPaActionsRetry(id);
}

async function updateDraft(id, patch) {
  await hostPaActionsUpdate(id, patch);
}

// ── COMPAT FALLBACK: host.paActions.* on an older shell build ──────────────────
// approve/reject/retry/edit all route through the four host.paActions.* verbs
// above. The shell's dispatchHostCall (pkg-iframe-host.tsx) wired all four as of
// WP-18, so on a current shell these writes land normally from inside the
// iframe. Older shell builds predating WP-18 still hit the `unknown host tool:
// <name>` fallthrough (pkg-iframe-host.tsx:829) — this block is the honest
// degradation for that case, not the everyday path.
//
// Detect the unknown-verb refusal and, instead of dumping a raw "unknown host
// tool" string, steer the operator to the shell's NATIVE approve-gate surface
// at /outbox/approvals, which calls the Rust commands directly
// (paActionsCommit/Reject/Retry/Update) and WORKS. `host.navigate` is a real,
// handled verb (pkg-iframe-host.tsx:426).
function isPaActionsUnavailable(err) {
  const m = String(err?.message ?? err ?? '');
  return /unknown host tool|host\.paActions/i.test(m);
}

// Navigate the focused pane to the shell's native approve-gate. Fire-and-forget.
export function openShellApprovals() {
  return navigateFn('/outbox/approvals').catch(() => {});
}

// ── 10-second undo before commit (WP-04) ──────────────────────────────────────
// Ported from shell/src/shell/atelier/surfaces/approve-gate-panel.tsx:177-197.
// Approve ARMS a countdown (default 10s); NO DB write happens during the window.
// When the counter reaches 0 it calls `onCommit(id)` (→ host.paActions.commit).
// `cancel()` clears the timer so commit never fires. Pure-React, zero host
// involvement during the window. One armed draft at a time (matches the single-
// detail approve UX); arming a new one replaces the prior pending undo.
//
// Returns { armed, secondsLeft, arm, cancel, isArmed }:
//   armed       — the draft id currently counting down (or null)
//   secondsLeft — remaining whole seconds for the armed draft
//   arm(id, ms) — start the countdown for `id` (ms defaults to 10000)
//   cancel()    — abort the pending commit
//   isArmed(id) — convenience predicate for per-row rendering
function useUndoCommit(onCommit) {
  const [undo, setUndo] = useState(null); // { draftId, secondsLeft } | null

  const arm = useCallback((draftId, undoMs = 10000) => {
    setUndo({ draftId, secondsLeft: Math.round((undoMs ?? 10000) / 1000) });
  }, []);

  const cancel = useCallback(() => setUndo(null), []);

  // Drive the countdown; commit (onCommit + clear) at 0. Mirrors approve-gate.
  useEffect(() => {
    if (!undo) return;
    if (undo.secondsLeft <= 0) {
      onCommit(undo.draftId);
      setUndo(null);
      return;
    }
    const t = setTimeout(
      () => setUndo((u) => (u ? { ...u, secondsLeft: u.secondsLeft - 1 } : null)),
      1000
    );
    return () => clearTimeout(t);
  }, [undo, onCommit]);

  return {
    armed: undo?.draftId ?? null,
    secondsLeft: undo?.secondsLeft ?? 0,
    arm,
    cancel,
    isArmed: (id) => undo?.draftId === id,
  };
}

// Inline undo banner — shown while a commit is armed. Cancel aborts the send.
function UndoBar({ secondsLeft, onCancel, label = 'Sending' }) {
  return html`
    <div class="ob-undo-bar" role="status">
      <span class="ob-undo-text">
        ${label} in <strong>${secondsLeft}s</strong> — change your mind?
      </span>
      <button class="ob-btn-sm" onClick=${onCancel}>Undo</button>
    </div>
  `;
}

// C-2: only an awaiting/edited draft can be approved (the verb's SELECT guard).
// committed/sending/sent rows render a disabled status chip instead of Approve.
const isApprovable = (r) => !!r && (r.raw_status === 'awaiting' || r.raw_status === 'edited');

// C-2: disabled status chip shown in the action footer when a row is NOT
// approvable (already committed/sending/etc.) and NOT failed.
const RAW_STATUS_LABEL = {
  committed: 'Queued to send',
  sending: 'Sending…',
  sent: 'Sent',
  rejected: 'Rejected',
};
function StatusChip({ rawStatus }) {
  const label = RAW_STATUS_LABEL[rawStatus] ?? (rawStatus ? `Status · ${rawStatus}` : 'Not approvable');
  return html`
    <div class="ob-status-chip" role="status" aria-disabled="true" title=${label}>
      ${label}
    </div>
  `;
}

// C-5: inline error chip surfaced near the action footer when a commit is refused
// (e.g. "Already committed — nothing sent.").
//
// WP-17: when the refusal is the pre-WP-18-shell compat gap (isPaActionsUnavailable),
// the raw "unknown host tool: host.paActions.commit" string is useless to an
// operator. Render an actionable notice steering them to the shell's native
// approve-gate (/outbox/approvals) — which drives the same pa_actions_* Rust
// commands directly and works — instead of the bare error.
function CommitError({ message }) {
  if (!message) return null;
  if (isPaActionsUnavailable(message)) {
    return html`
      <div class="atelier-state is-error ob-commit-error" role="alert" style=${{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
        <span>In-pane approve / reject / retry isn't wired yet in this shell build. Your draft is safe — approve it from the Approvals surface.</span>
        <button class="ob-btn-sm is-primary" type="button" onClick=${openShellApprovals}>↗ Open Outbox · Approvals</button>
      </div>
    `;
  }
  return html`
    <div class="atelier-state is-error ob-commit-error" role="alert">${message}</div>
  `;
}

// F-7: before-click consequence line populated from the selected draft, shown
// ABOVE the Approve button so the operator sees the effect before committing.
function ConsequenceLine({ recipient, channel, scheduled }) {
  const when = scheduled || 'now';
  const parts = [
    `→ sends to ${recipient || 'segment'}`,
    channel || 'channel',
    when,
    'undo 10s',
  ];
  return html`
    <div class="ob-consequence ob-act-meta">${parts.join(' · ')}</div>
  `;
}

// C-3: FLOATING undo banner — rendered at the view root keyed on the ARMED
// draftId (not the selected row), so an armed send stays cancellable no matter
// which row the operator selects. Arming a new draft replaces the prior pending
// one (single-armed invariant lives in useUndoCommit); the timer is cleaned up
// on unmount there too.
function FloatingUndoBar({ armed, secondsLeft, onCancel, subject, label = 'Sending' }) {
  if (!armed) return null;
  const what = subject ? `“${subject}”` : 'draft';
  return html`
    <div class="ob-undo-bar ob-undo-floating" role="status">
      <span class="ob-undo-text">
        ${label} ${what} in <strong>${secondsLeft}s</strong> — change your mind?
      </span>
      <button class="ob-btn-sm" onClick=${onCancel}>Undo</button>
    </div>
  `;
}

// Edit-in-place panel — patch subject/body, writes via host.paActions.update.
// onSave(patch) receives { subject, body } and resolves to advance edited→.
function EditPanel({ subject, body, onSave, onCancel, pending }) {
  const [subj, setSubj] = useState(subject ?? '');
  const [bod, setBod] = useState(body ?? '');
  const bodRef = useAutoGrow(bod, { minHeight: 160 });
  return html`
    <div class="ob-edit-panel">
      <span class="ob-edit-label">Edit before approving</span>
      <label class="ob-edit-field">
        <span>Subject</span>
        <input type="text" value=${subj} onInput=${(e) => setSubj(e.target.value)} />
      </label>
      <label class="ob-edit-field">
        <span>Body</span>
        <textarea ref=${bodRef} value=${bod} onInput=${(e) => setBod(e.target.value)} style=${{ overflow: 'hidden', resize: 'none' }}></textarea>
      </label>
      <div class="ob-edit-row">
        <button class="ob-btn-sm" onClick=${onCancel}>Cancel</button>
        <button
          class="ob-btn-sm is-primary"
          disabled=${pending}
          onClick=${() => onSave({ subject: subj, body: bod })}
        >${pending ? 'Saving…' : 'Save edit'}</button>
      </div>
    </div>
  `;
}

// Fan-out siblings: pa_action_drafts rows sharing the selected post's batch_id
// (one approved social post fans out to N provider rows). batch_id is the group key.
async function fetchSocialFanout(slug) {
  if (!slug) return [];
  if (isStandalone()) return [];
  const rows = await dbQueryFn(
    `SELECT ${SEL_COLS} FROM pa_action_drafts WHERE batch_id = ? ORDER BY channel ASC`,
    [slug]
  );
  return (rows || []).map(mapSocialSent);
}

// ─── Fixture data (fallback until real rows exist) ──────────────────────────────

export const FIXTURE_EMAIL_QUEUE = [
  // ── Replies group (emailGroup: 'reply') ─────────────────────────────────────
  // eq-r1 recipient is keyed into FIXTURE_CRM → drives the full 8-cell ri-grid
  // in standalone. Auto-selected first (rows[0]) so the showcase opens on it.
  // quality: fully-verified stamp (all claims verified, on-voice) → Claims 2/2 ok,
  // Tone match On-voice ok.
  {
    id: 'eq-r1',
    subject: 'Re: Royalti onboarding · file processing delay',
    body: `Hi,\n\nThanks for flagging this. The delay you saw was caused by a schema mismatch on the ingestion side — we patched it in 0.7.4 and the backfill ran clean this morning.\n\nYour tenant (id 590) should now show all statements. Let me know if anything looks off.\n\nBest,\nRuby`,
    recipient_name: 'Valentim de Carvalho',
    recipient_email: 'valentim@soundlabel.pt',
    channel: 'smtp',
    status: 'pending',
    raw_status: 'awaiting',
    ux_mode: 'approve',
    is_overdue: 1,
    hours_late: 17,
    src: 'approval',
    scheduled_for: null,
    drafted_by: 'pa',
    tenant_id: 590,
    emailGroup: 'reply',
    // ItemQuality stamp — fully verified + on-voice (G-QUALITY / WP-13).
    quality: {
      claims: [
        { text: 'patched in 0.7.4', source: 'https://royalti.io/changelog/0.7.4', verdict: 'verified' },
        { text: 'backfill ran clean this morning', source: 'https://royalti.io/changelog/0.7.4', verdict: 'verified' },
      ],
      tone: { verdict: 'on-voice', basis: 'Direct, no hype terms, first-person Ruby voice.', model: 'claude-sonnet-4-5' },
      verified_at: '2026-06-10T09:15:00.000Z',
      verifier: 'draft-time',
    },
  },
  {
    id: 'eq-r2',
    subject: 'Re: Pricing question for enterprise tier',
    body: `Hi Amara,\n\nGreat question — enterprise pricing is bespoke and based on catalog size and team seats.\n\nHappy to jump on a 20-minute call this week to walk through the numbers. Does Thursday 15:00 WAT work?\n\nBest,\nChinedum`,
    recipient_name: 'Amara Okafor',
    recipient_email: 'amara.okafor@afrobeats-dist.com',
    channel: 'smtp',
    status: 'pending',
    raw_status: 'awaiting',
    ux_mode: 'approve',
    is_overdue: 0,
    src: 'approval',
    scheduled_for: 'Today 16:00',
    drafted_by: 'cbo',
    topic_tag: 'enterprise',
    emailGroup: 'reply',
    // ItemQuality stamp — failed claim + off-voice (G-QUALITY / WP-13).
    // Demonstrates: Claims cell → fail tone; Tone match cell → Off-voice warn.
    quality: {
      claims: [
        { text: 'enterprise pricing is bespoke and based on catalog size and team seats', source: null, verdict: 'failed' },
        { text: 'Thursday 15:00 WAT', source: null, verdict: 'unsourced' },
      ],
      tone: { verdict: 'off-voice', basis: 'Proposal language too casual for an enterprise ask.', model: 'claude-sonnet-4-5' },
      verified_at: '2026-06-10T09:20:00.000Z',
      verifier: 'draft-time',
    },
  },
  // ── Manual outreach group (emailGroup: 'manual') ────────────────────────────
  // eq-m1 has NO quality stamp → Claims '—' + Tone match '—' (honest, D-10).
  {
    id: 'eq-m1',
    subject: 'Welcome — your Royalti tenant is ready',
    body: `Hi {{first_name}},\n\nYour Royalti workspace is live. Here is what you can do in the first 48 hours:\n\n1. Ingest your first statement from the Statements tab.\n2. Set up your split templates under Settings → Splits.\n3. Invite your accountant or distributor contact.\n\nIf anything is unclear the docs are at docs.royalti.io and I am available on this email.\n\nRuby`,
    recipient_name: '{{first_name}}',
    recipient_email: '',
    channel: 'resend',
    status: 'pending',
    raw_status: 'awaiting',
    ux_mode: 'approve',
    is_overdue: 0,
    src: 'approval',
    scheduled_for: 'Today 14:30',
    drafted_by: 'pa',
    emailGroup: 'manual',
    // No quality field — renders '—' for Claims + Tone match (honest, D-10).
  },
  // ── Sequence step group (emailGroup: 'sequence') ────────────────────────────
  {
    id: 'eq-s1',
    subject: 'Following up on the Royalti deck · step 2',
    body: `Hi [first name],\n\nWanted to circle back on the deck I sent last week — if you had a chance to look, happy to walk you through the ingestion demo on a 15-minute call.\n\nAlternatively I can send a Loom if async is easier. Just say the word.\n\nBest,\nChinedum`,
    recipient_name: 'ar@universalmusic.pt',
    recipient_email: 'ar@universalmusic.pt',
    channel: 'smtp',
    status: 'pending',
    raw_status: 'awaiting',
    ux_mode: 'approve',
    is_overdue: 0,
    src: 'approval',
    scheduled_for: 'Mon 09:00',
    drafted_by: 'pa',
    emailGroup: 'sequence',
    sequence_id: 'Cold A&R outreach',
    sequence_step: 2,
    sequence_total: 4,
    // No quality field — renders '—' for Claims + Tone match (honest, D-10).
  },
];

export const FIXTURE_EMAIL_SCHEDULE = [
  { id: 'es-1', subject: 'Q2 product roundup · for label admins', channel: 'listmonk', status: 'scheduled', scheduled_for: 'Today 16:00', ux_mode: 'silent' },
  { id: 'es-2', subject: 'Quick check-in · still using Royalti?', channel: 'listmonk', status: 'scheduled', scheduled_for: 'Mon 09:00', ux_mode: 'silent' },
];

export const FIXTURE_EMAIL_SENT = [
  { id: 'sent-1', subject: 'Royalti tenant welcome', recipient_email: 'batch', channel: 'resend', delivery_system: 'resend', sent_at: '2026-05-15 10:00', open_rate: 0.68, click_rate: 0.21 },
  { id: 'sent-2', subject: 'Q1 product update', recipient_email: 'label admins', channel: 'listmonk', delivery_system: 'listmonk', sent_at: '2026-04-30 14:00', open_rate: 0.55, click_rate: 0.18 },
];

export const FIXTURE_NL_QUEUE = [
  { id: 'nl-1', subject: 'You can deliver from Royalti now', subject_b: null, draft_slug: 'royalti-deliver', status: 'cooling', raw_status: 'awaiting', cooling_until: '47m', quality_score: 92, recipient_count: 2104, delivery_system: 'listmonk', drafted_by: 'cmo', has_ab: 0,
    preheader: 'Send DDEX messages from your workspace — no aggregator required.',
    from_line: 'Ruby <ruby@royalti.io>',
    body: `Royalti now ships a full delivery pipeline.\n\nYou can send DDEX ERN4 messages directly from your workspace to DSPs that accept DDEX — no third-party aggregator account required for the initial batch.\n\nHere is what that means in practice:\n\n## What changed\n\nThe delivery seam was the last piece of the puzzle. Before this release, labels using Royalti could ingest statements and calculate royalties, but the outbound leg still meant exporting a spreadsheet and handing it to a distributor.\n\nNow the loop is closed. A single approval in the Outbound pane sends a DDEX message to your connected DSPs.\n\n## What you need to do\n\nIf you are already on Royalti, your tenant is DDEX-ready. Go to Settings → Delivery, connect your first DSP endpoint, and submit a test release. The confirmation takes 24 hours.\n\nIf you are not on Royalti yet, you can request early access at royalti.io/deliver.\n\n## What is next\n\nWe are working on a MEAD profile for sync licensing and a batch-release scheduler. Both are on the public roadmap.\n\nAs always, reply to this email with questions — Ruby reads every one.\n\nRuby\nRoyalti`,
    // ItemQuality stamp — fully verified + on-voice (G-QUALITY / WP-13).
    quality: {
      claims: [
        { text: 'no third-party aggregator account required for the initial batch', source: 'https://royalti.io/deliver', verdict: 'verified' },
        { text: 'The confirmation takes 24 hours', source: 'https://docs.royalti.io/delivery', verdict: 'verified' },
      ],
      tone: { verdict: 'on-voice', basis: 'Clear, direct, no hype terms, Ruby first-person voice.', model: 'claude-sonnet-4-5' },
      verified_at: '2026-06-10T08:00:00.000Z',
      verifier: 'draft-time',
    },
  },
  { id: 'nl-2', subject: 'Schema patches that unblocked tenant 590', subject_b: 'The shape disparity that was eating royalty data', draft_slug: 'schema-patches-590', status: 'pending', raw_status: 'awaiting', cooling_until: null, quality_score: 86, recipient_count: 2104, delivery_system: 'listmonk', drafted_by: 'cmo', has_ab: 1,
    preheader: 'A two-line migration fix that took three days to find — and how we made it automatic.',
    from_line: 'Ruby <ruby@royalti.io>',
    body: `Tenant 590 hit a wall last month.\n\nWhen they uploaded their first statement batch, the ingestion pipeline rejected 312 rows because the revenue model field was an enum the schema didn't recognise.\n\nThe fix was a two-line migration, but finding it took three days of log triage.\n\nWe are writing about it because the same shape problem shows up across 8% of new tenants in their first month. This is the kind of thing that erodes trust before a product has a chance to prove itself.\n\nThe patch is in 0.7.3. If you are running an older version, the upgrade path is in the docs.\n\nRuby`,
    // No quality field → Claims '—' + honest unstamped state (D-10 backlog rows).
  },
];

export const FIXTURE_NL_SENT = [
  { id: 'ns-1', draft_slug: 'schema-patches-590', edition: 'May 2026', subject: 'Schema patches that unblocked tenant 590', delivery_system: 'listmonk', sent_at: '2026-05-06 10:00', recipient_count: 2104, open_rate: 0.61, click_rate: 0.14 },
  { id: 'ns-2', draft_slug: 'investor-may', edition: 'Investor May 2026', subject: 'Investor Update — May', delivery_system: 'listmonk', sent_at: '2026-05-08 14:00', recipient_count: null, open_rate: null, click_rate: null },
];

export const FIXTURE_SEQ_DEFS = [
  { id: 'seq-1', name: 'Cold A&R outreach', slug: 'seq3-universal-pt', segment: 'ar@universalmusic.pt', total_steps: 4, delivery_system: 'smtp', status: 'active' },
  { id: 'seq-2', name: 'Onboarding welcome', slug: 'onboard-welcome', segment: 'new tenants', total_steps: 3, delivery_system: 'resend', status: 'active' },
  { id: 'seq-3', name: 'L5 winback', slug: 'l5-winback', segment: '388 churned', total_steps: 5, delivery_system: 'listmonk', status: 'active' },
  { id: 'seq-4', name: 'Q2 product roundup', slug: 'q2-product-roundup', segment: 'label admins', total_steps: 2, delivery_system: 'listmonk', status: 'active' },
];

export const FIXTURE_ACTIVE_SEQS = [
  { id: 'os-1', sequence_id: 'seq-1', contact_email: 'ar@universalmusic.pt', segment: 'A&R', current_step: 1, total_steps: 4, next_send_date: '2026-06-07', status: 'active', sent_count: 1, sequence_name: 'Cold A&R outreach', sequence_slug: 'seq3-universal-pt', delivery_system: 'smtp' },
  { id: 'os-2', sequence_id: 'seq-2', contact_email: 'batch', segment: 'new tenants', current_step: 1, total_steps: 3, next_send_date: '2026-06-08', status: 'active', sent_count: 388, sequence_name: 'Onboarding welcome', sequence_slug: 'onboard-welcome', delivery_system: 'resend' },
  { id: 'os-3', sequence_id: 'seq-3', contact_email: 'batch', segment: '388 churned', current_step: 7, total_steps: 5, next_send_date: '2026-06-09', status: 'active', sent_count: 388, sequence_name: 'L5 winback', sequence_slug: 'l5-winback', delivery_system: 'listmonk' },
  { id: 'os-4', sequence_id: 'seq-4', contact_email: 'batch', segment: 'label admins', current_step: 1, total_steps: 2, next_send_date: '2026-06-10', status: 'active', sent_count: 0, sequence_name: 'Q2 product roundup', sequence_slug: 'q2-product-roundup', delivery_system: 'listmonk' },
];

export const FIXTURE_SEQ_QUEUE = [
  { id: 'seq-q1', name: 'distributor-q3', slug: 'distributor-q3', description: 'Cold outbound to 14 distributor leads sourced from Q1 trade-show contacts. 4 steps over 21 days.', segment: 'distributor-leads-q1', total_steps: 4, delivery_system: 'resend', status: 'in_review', raw_status: 'awaiting', created_by: 'vp-sales-agent', created_at: '2026-04-28' },
  { id: 'seq-q2', name: 'label-onboarding-v3', slug: 'label-onboarding-v3', description: 'Replaces v2. New labels get 5 emails over 14 days walking them from signup → first statement ingested.', segment: 'new-labels', total_steps: 5, delivery_system: 'listmonk', status: 'in_review', raw_status: 'awaiting', created_by: 'pa', created_at: '2026-04-27' },
];

export const FIXTURE_SEQ_STEPS = [
  { id: 'st-1', step_number: 1, subject: 'Royalti deck for distributor onboarding', body: '"Hi [first name] — saw we connected at [event]. Royalti is the royalty + rights ops layer label/distributor teams use to get statements ingested in seconds, not days…"', delay_value: 0, delay_unit: 'days', channel: 'resend', status: 'active' },
  { id: 'st-2', step_number: 2, subject: 'Following up on the Royalti deck', body: '"Wanted to circle back on the deck I sent — happy to walk you through it on a 15-min call, or send a Loom if async is easier…"', delay_value: 3, delay_unit: 'days', channel: 'resend', status: 'active' },
  { id: 'st-3', step_number: 3, subject: 'A short Royalti customer story', body: '"Quick story from a Lagos label that ingested 880 contracts in a week — the part that surprised them was [insert]…"', delay_value: 7, delay_unit: 'days', channel: 'resend', status: 'active' },
  { id: 'st-4', step_number: 4, subject: 'Closing the loop · last note', body: '"I\'ll stop here so I\'m not crowding the inbox. If you want to pick this up later, the deck and a 15-min slot are at [link]…"', delay_value: 11, delay_unit: 'days', channel: 'resend', status: 'active' },
];

export const FIXTURE_SENT_SEQS = [
  { sequence_id: 'seq-s1', sequence_name: 'distributor-q2', sequence_slug: 'distributor-q2', total_steps: 4, enrolled: 18, completed: 6, replied: 4, bounced: 1, sent_total: 52, closed_at: '2026-03-30' },
  { sequence_id: 'seq-s2', sequence_name: 'winback-l4', sequence_slug: 'winback-l4', total_steps: 3, enrolled: 240, completed: 88, replied: 31, bounced: 12, sent_total: 612, closed_at: '2026-03-12' },
];

export const FIXTURE_SEQ_RECIPIENTS = [
  { id: 'r1', contact_email: 'a@dist.pt', current_step: 4, total_steps: 4, status: 'completed', last_reply_at: null },
  { id: 'r2', contact_email: 'b@dist.pt', current_step: 2, total_steps: 4, status: 'active', last_reply_at: '2026-04-28' },
  { id: 'r3', contact_email: 'c@dist.pt', current_step: 3, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r4', contact_email: 'd@dist.pt', current_step: 3, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r5', contact_email: 'e@dist.pt', current_step: 2, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r6', contact_email: 'f@dist.pt', current_step: 2, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r7', contact_email: 'g@dist.pt', current_step: 2, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r8', contact_email: 'h@dist.pt', current_step: 2, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r9', contact_email: 'i@dist.pt', current_step: 1, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r10', contact_email: 'j@dist.pt', current_step: 1, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r11', contact_email: 'k@dist.pt', current_step: 1, total_steps: 4, status: 'active', last_reply_at: null },
  { id: 'r12', contact_email: 'l@dist.pt', current_step: 1, total_steps: 4, status: 'bounced', last_reply_at: null },
  { id: 'r13', contact_email: 'm@dist.pt', current_step: 1, total_steps: 4, status: 'bounced', last_reply_at: null },
  { id: 'r14', contact_email: 'n@dist.pt', current_step: 1, total_steps: 4, status: 'active', last_reply_at: null },
];

export const FIXTURE_SOCIAL_QUEUE = [
  // ── Blog announcement · fan-out batch (LinkedIn + X + Bluesky share blog-01) ──
  // Three siblings collapse to ONE display row carrying all three platform pills.
  { id: 'sq-b1-li', slug: 'blog-01', platform: 'linkedin', account: 'Royalti', source_group: 'blog', blog_slug: 'royalty-calc-overhaul', content: 'The royalty calculator overhaul shipped this week. Statements ingest in ~90s for a 30k-row CSV, and splits recompute live as you edit. #royalti #musicbusiness', status: 'in_review', raw_status: 'awaiting', scheduled_for: '2026-06-10 12:48', source: 'C-07', title: 'Royalty calculator overhaul · launch post', drafted_by: 'pa', thread_index: null, thread_total: null, tone_check: false, media_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=1200&h=627&fit=crop', hashtags: ['#royalti', '#musicbusiness', '#labels'], platforms: ['linkedin'], thread: null },
  { id: 'sq-b1-x', slug: 'blog-01', platform: 'x', account: 'royalti_io', source_group: 'blog', blog_slug: 'royalty-calc-overhaul', content: 'The royalty calculator overhaul shipped this week. Statements ingest in ~90s for a 30k-row CSV…', status: 'in_review', raw_status: 'awaiting', scheduled_for: '2026-06-10 12:48', source: 'C-07', title: 'Royalty calculator overhaul · launch post', drafted_by: 'pa', thread_index: null, thread_total: null, tone_check: false, media_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=1200&h=627&fit=crop', hashtags: ['#royalti', '#musicbusiness', '#labels'], platforms: ['x'], thread: null },
  { id: 'sq-b1-bs', slug: 'blog-01', platform: 'bluesky', account: 'royalti.io', source_group: 'blog', blog_slug: 'royalty-calc-overhaul', content: 'The royalty calculator overhaul shipped this week. Statements ingest in ~90s for a 30k-row CSV…', status: 'in_review', raw_status: 'awaiting', scheduled_for: '2026-06-10 12:48', source: 'C-07', title: 'Royalty calculator overhaul · launch post', drafted_by: 'pa', thread_index: null, thread_total: null, tone_check: false, media_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=1200&h=627&fit=crop', hashtags: ['#royalti', '#musicbusiness', '#labels'], platforms: ['bluesky'], thread: null },
  // ── Blog announcement · singleton (no batch, no blog_slug path) ───────────────
  { id: 'sq-b2', slug: null, platform: 'linkedin', account: 'Royalti', source_group: 'blog', blog_slug: null, content: 'New blog post: "Why we rewrote the splits engine in 6 weeks" — the trade-offs we made on accuracy vs speed, and what we\'d do differently.', status: 'pending', raw_status: 'awaiting', scheduled_for: '2026-06-10 14:00', source: 'C-09', title: 'Splits engine rewrite · explainer', drafted_by: 'pa', thread_index: null, thread_total: null, tone_check: false, media_url: null, hashtags: ['#engineering'], platforms: ['linkedin'], thread: null },
  // ── AI generation · tone-check row (renders the tone-check warn chip) ─────────
  { id: 'sq-ai1', slug: null, platform: 'linkedin', account: 'Royalti', source_group: 'ai', blog_slug: null, content: 'If you\'ve ever fought with split sheets in Excel for a 6-feature track, you\'ll find this familiar. We turned that fight into one ledger.', status: 'in_review', raw_status: 'awaiting', scheduled_for: '2026-06-09 09:00', source: 'C-10', title: 'Split sheet story', drafted_by: 'ruby', thread_index: null, thread_total: null, tone_check: true, media_url: null, hashtags: [], platforms: ['linkedin'], thread: null },
  // ── AI generation · thread row (thread · 4 of 4 chip) ─────────────────────────
  { id: 'sq-ai2', slug: null, platform: 'x', account: 'royalti_io', source_group: 'ai', blog_slug: null, content: 'The least glamorous part of running a label: chasing a $124 cheque across three statement formats. Royalti unifies them into one ledger. 1/4', status: 'in_review', raw_status: 'awaiting', scheduled_for: '2026-06-09 11:00', source: 'C-11', title: 'Thread · chasing the cheque', drafted_by: 'cmo-agent', thread_index: 4, thread_total: 4, tone_check: false, media_url: null, hashtags: ['#royaltyaccounting', '#ddex'], platforms: ['x', 'bluesky'], thread: [
    '2/4: The root cause is the format war. Every distributor sends a different CSV shape — columns named differently, currency sometimes implicit, territory codes inconsistent.',
    '3/4: The fix is not a parser for each distributor. It is a schema all distributors can map to. That is what Royalti does under the hood.',
    '4/4: If you run a label and you are still reconciling by hand — try Royalti. Link in bio.',
  ] },
];

export const FIXTURE_SOCIAL_SCHEDULE = [
  { id: 'sq-2', platform: 'twitter', account: 'royalti_io', content: 'Thread 1/7: The royalty data problem nobody talks about.', status: 'scheduled', scheduled_for: '2026-06-10 09:00', source: 'C-08' },
];

export const FIXTURE_SOCIAL_SENT = [
  { id: 'sq-0', platform: 'linkedin', account: 'Royalti', content: 'We\'ve built a workspace that puts royalty data, outreach, and reporting in one place.', status: 'posted', scheduled_for: '2026-06-01 09:00', posted_at: '2026-06-01 09:01', source: 'C-06', media_url: 'https://royalti.io/og/workspace-card.jpg', hashtags: ['#royalti', '#musicbusiness'] },
];

// Fixture CRM records — keyed by LOWERCASED recipient_email. Provides the 8-cell
// ri-grid data (and the email scorecard's thread/personalization signals) in
// STANDALONE mode only; live mode resolves these from the host DB via
// fetchReplyIntelligence. Shape mirrors fetchReplyIntelligence's return.
// eq-r1 (valentim@soundlabel.pt) is the auto-selected first Replies row, so the
// showcase opens straight onto a populated grid.
const FIXTURE_CRM = {
  'valentim@soundlabel.pt': {
    tenant_name: 'Sound Label Lda.',
    tenant_sub: 'Distributor',
    last_touch: '3d ago',
    last_touch_sub: '14 interactions',
    health: 'Active',
    health_sub: '3d since contact',
    sequence: '— none — (direct reply)',
    sequence_sub: 'not part of a sequence run',
    catalog: '880 tracks',
    catalog_sub: 'Afropop / Fado blend · ingested 2026-03-12',
    open_balance: '$0',
    balance_sub: 'current',
    owner: 'Chinedum O.',
    owner_sub: 'CEO · direct relationship',
    risk_flag: 'None',
    risk_color: 'var(--live)',
    thread_count: 3,
  },
};

// ─── Small helpers ─────────────────────────────────────────────────────────────

function ChannelChip({ channel }) {
  const cls = {
    resend: 'channel-resend',
    listmonk: 'channel-listmonk',
    smtp: 'channel-smtp',
    buffer: 'channel-buffer',
  }[channel?.toLowerCase()] ?? '';
  const label = channel ?? '—';
  return html`<span class=${cn('ob-chip', cls)}>${label}</span>`;
}

function PlatformBadge({ platform }) {
  const label = platform ?? '—';
  return html`<span class=${cn('ob-platform-badge', platform)}>${label}</span>`;
}

function QualityChip({ score }) {
  if (!score) return null;
  const cls = score >= 80 ? 'quality high' : 'quality';
  return html`<span class=${cn('ob-chip', cls)}>${score}/100</span>`;
}

function CoolingChip({ until }) {
  if (!until) return null;
  return html`<span class="ob-chip cooling">cooling ${until}</span>`;
}

function OverdueChip({ hoursLate } = {}) {
  // Honest: only show lateness detail when the worker stamped a real hours_late.
  const detail = hoursLate > 0 ? ` · ${hoursLate}h late` : '';
  return html`<span class="ob-chip overdue">overdue${detail}</span>`;
}

function formatPct(v) {
  if (v == null) return '—';
  return (Number(v) * 100).toFixed(0) + '%';
}

function formatDate(v) {
  if (!v) return '—';
  return String(v);
}

// Compact relative-time for social queue rows ("now" / "12m" / "6h" / "3d").
// Honest: no signal → '—'. Treats the stored "YYYY-MM-DD HH:MM" as UTC.
function relativeTime(v) {
  if (!v) return '—';
  const t = new Date(String(v).replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(t)) return '—';
  const abs = Math.abs(Date.now() - t);
  if (abs < 60e3) return 'now';
  if (abs < 3600e3) return Math.round(abs / 60e3) + 'm';
  if (abs < 86400e3) return Math.round(abs / 3600e3) + 'h';
  return Math.round(abs / 86400e3) + 'd';
}

// Compact platform pill for the social-queue master rows — the design-system
// `.plat` family (mono, tinted, compact), NOT the full-width .ob-platform-badge.
const PLAT_KEY = { linkedin: 'li', twitter: 'x', x: 'x', bluesky: 'bs', bsky: 'bs', instagram: 'ig', facebook: 'fb' };
function PlatPill({ platform }) {
  const k = PLAT_KEY[platform] ?? platform;
  return html`<span class=${'plat plat-' + k}>${String(k).toUpperCase()}</span>`;
}

// Social source-group → verbatim design label + fixed render order (omit empties).
const SOURCE_GROUP_LABEL = { blog: 'Blog announcement', ai: 'AI generation', manual: 'Manual', reply: 'Reply' };
const SOCIAL_GROUP_ORDER = ['blog', 'ai', 'manual', 'reply'];
// Platform badge order within a fan-out row: li → x → bs → ig → fb.
const SOCIAL_PLAT_ORDER = ['linkedin', 'twitter', 'x', 'bluesky', 'bsky', 'instagram', 'facebook'];

function wordCount(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

// ─── Newsletter body text metrics (B.6) ──────────────────────────────────────
// These are computed directly from the draft body — real signals, no external
// pipeline. The remaining cells (Claims verified, Freshness, Previously
// featured) need a claims-verifier / sent-history join and stay honest
// placeholders until those land.

const ANTI_PATTERN_TERMS = [
  'revolutionary', 'game-changer', 'game changer', 'synergy', 'disrupt', 'disruptive',
  'cutting-edge', 'best-in-class', 'world-class', 'seamless', 'leverage', 'unlock',
  'supercharge', 'unprecedented', 'paradigm', 'next-level', 'must-have', 'no-brainer',
  'skyrocket', 'effortless', 'turnkey', 'bleeding-edge',
];

function countAntiPatterns(text) {
  if (!text) return 0;
  const t = String(text).toLowerCase();
  let n = 0;
  for (const term of ANTI_PATTERN_TERMS) {
    const esc = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const m = t.match(new RegExp(`\\b${esc}\\b`, 'g'));
    if (m) n += m.length;
  }
  return n;
}

// Distinct sections — markdown/HTML headings if present, else paragraph blocks.
function countSections(text) {
  if (!text) return 0;
  const headings = (text.match(/^#{1,6}\s/gim) || []).length + (text.match(/<h[1-6][\s>]/gi) || []).length;
  if (headings) return headings;
  return String(text).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).length;
}

function countCtas(text) {
  if (!text) return { ctas: 0, bangs: 0 };
  const bangs = (text.match(/!/g) || []).length;
  const links = (text.match(/https?:\/\/|\]\([^)]+\)|<a[\s>]/gi) || []).length;
  const phrases = (text.match(/\b(read more|learn more|sign up|get started|try it|book a|claim your|subscribe|download|join now|see how|get the)\b/gi) || []).length;
  return { ctas: links + phrases, bangs };
}

// Verifiable factual claims present in the body (percentages, $amounts, counts).
// This counts claims to be checked — it does NOT assert verification.
function countClaims(text) {
  if (!text) return 0;
  return (text.match(/\d+(\.\d+)?\s?%|\$\s?\d|\b\d+x\b|\b\d{2,}\b/gi) || []).length;
}

// ── Anti-pattern FINDINGS (WP-17, item 2) ────────────────────────────────────
// countAntiPatterns() returns a scalar; the design's itemized list (newsletter
// §B, design lines 2278-2296) needs per-finding rows with a location + excerpt so
// each gets a "fix in chat" affordance. This scans the SAME real body content
// (no external pipeline) for two honest categories:
//   • hype phrases — any ANTI_PATTERN_TERMS match (same terms countAntiPatterns uses)
//   • vague metrics — "significantly/substantially/… faster/better/…" with no number nearby
// Returns [{ kind, term, line, excerpt }] — line is 1-indexed body line number.
const VAGUE_METRIC_RE =
  /\b(significantly|substantially|dramatically|considerably|markedly|noticeably|much|far|way|vastly)\s+(faster|slower|better|worse|more|less|cheaper|higher|lower|bigger|smaller|stronger|quicker|greater|improved|reduced)\b/gi;

function findAntiPatterns(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const findings = [];
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const lower = raw.toLowerCase();
    // Hype phrases (dedupe per line/term).
    for (const term of ANTI_PATTERN_TERMS) {
      const esc = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      if (new RegExp(`\\b${esc}\\b`, 'i').test(lower)) {
        findings.push({ kind: 'hype', term, line: lineNo, excerpt: raw.trim().slice(0, 120) });
      }
    }
    // Vague metrics — a qualifier + comparative with no digit on the line.
    if (!/\d/.test(raw)) {
      let m;
      VAGUE_METRIC_RE.lastIndex = 0;
      while ((m = VAGUE_METRIC_RE.exec(raw)) !== null) {
        findings.push({ kind: 'vague-metric', term: m[0], line: lineNo, excerpt: raw.trim().slice(0, 120) });
      }
    }
  });
  return findings;
}

// Per-platform hard character caps (design social §B).
const PLATFORM_CAPS = { linkedin: 3000, twitter: 280, x: 280, bluesky: 300, instagram: 2200 };

// Platforms the editor fans out to, with display handles + cap (design social §B).
const SOCIAL_PLATFORMS = [
  { key: 'linkedin', plat: 'plat-li', mark: 'LI', handle: 'Royalti.io', sub: 'LinkedIn', cap: 3000 },
  { key: 'x', plat: 'plat-x', mark: 'X', handle: '@royalti', sub: 'X', cap: 280 },
  { key: 'bluesky', plat: 'plat-bs', mark: 'BS', handle: '@royalti.io', sub: 'Bluesky', cap: 300 },
];

function charBarClass(len, cap) {
  if (len > cap) return 'is-bad';
  if (len > cap * 0.9) return 'is-warn';
  return '';
}

// Inline reject reason panel — 5 canned chips + freetext. Shared by all queues.
// onConfirm receives the assembled reason string (canned + freetext, joined).
function RejectPanel({ canned, onConfirm, onCancel, pending, placeholder }) {
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');

  const toggle = (c) =>
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  const assemble = () => {
    const parts = [...picked];
    if (note.trim()) parts.push(note.trim());
    return parts.join(' · ') || null;
  };

  return html`
    <div class="ob-reject">
      <span class="ob-reject-label">Reject · why? (feeds the writer-agent training set)</span>
      <div class="ob-reject-canned">
        ${canned.map((c) => html`
          <button
            key=${c}
            class=${cn({ 'is-on': picked.includes(c) })}
            onClick=${() => toggle(c)}
          >${c}</button>
        `)}
      </div>
      <input
        type="text"
        value=${note}
        placeholder=${placeholder ?? 'Optional · add a note'}
        onInput=${(e) => setNote(e.target.value)}
      />
      <div class="ob-reject-row">
        <button class="ob-btn-sm" onClick=${onCancel}>Cancel</button>
        <button
          class="ob-btn-sm is-danger"
          onClick=${() => onConfirm(assemble())}
          disabled=${pending}
        >${pending ? 'Rejecting…' : 'Reject draft'}</button>
      </div>
    </div>
  `;
}

const EMAIL_REJECT_REASONS = ['Wrong recipient', 'Tone is off', 'Misses context', 'Already replied elsewhere', "Don't send · close out"];
const NL_REJECT_REASONS = ['Claim unverified', 'Hype / anti-pattern', 'Off-theme', 'Schedule conflict', 'Weak CTA'];
const SOCIAL_REJECT_REASONS = ['Tone is off', 'Off-message', 'Wrong angle', "Image doesn't match", 'Missing context'];
const SEQ_REJECT_REASONS = ['Cadence too aggressive', 'Wrong segment', 'Copy needs work', 'Timing is off', "Don't enrol · close out"];

// Build the 8 newsletter quality cells from the draft row (B.6). quality_score
// is a stored column; word count, anti-patterns, section variety and CTAs are
// computed directly from the body text (real signals). Claims reads the
// draft-time ItemQuality stamp (G-QUALITY, WP-13) — honest '—' when unstamped.
// Freshness + Previously-featured are real via newsletterHistorySignals (WP-11).
// Each cell: { label, value, sub, pct, tone } (tone = 'ok' | 'warn' | 'fail').
// historySignals = { freshness, previouslyFeatured } from newsletterHistorySignals,
// or null when the query hasn't resolved yet (renders honest '—' placeholders).
function newsletterQualityCells(row, historySignals) {
  const score = row.quality_score;
  const body = row.body;
  const wc = wordCount(body);
  const wcOk = wc === 0 ? null : wc >= 350 && wc <= 500;
  const hasBody = !!body;

  const anti = countAntiPatterns(body);
  const sections = countSections(body);
  const { ctas, bangs } = countCtas(body);

  return [
    {
      label: 'Quality score',
      value: score != null ? `${score}` : '—',
      sub: '/ 100',
      pct: score != null ? Math.min(100, score) : 0,
      tone: score == null ? 'warn' : score >= 80 ? 'ok' : score >= 70 ? 'warn' : 'fail',
    },
    {
      label: 'Word count',
      value: wc ? `${wc}` : '—',
      sub: 'target 350-500',
      pct: wc ? Math.min(100, Math.round((wc / 500) * 100)) : 0,
      tone: wcOk == null ? 'warn' : wcOk ? 'ok' : 'warn',
    },
    // Claims: reads draft-time ItemQuality stamp (G-QUALITY, WP-13).
    // Stamped rows show verified/total counts; unstamped rows show honest '—'.
    claimsVerdictCell(row.quality),
    {
      label: 'Anti-patterns',
      value: hasBody ? `${anti}` : '—',
      sub: hasBody ? (anti === 0 ? 'none detected' : 'hype terms') : 'no body',
      pct: hasBody ? Math.max(0, 100 - anti * 25) : 0,
      tone: !hasBody ? 'warn' : anti === 0 ? 'ok' : anti <= 2 ? 'warn' : 'fail',
    },
    {
      label: 'Section variety',
      value: hasBody ? `${sections}` : '—',
      sub: 'distinct sections',
      pct: hasBody ? Math.min(100, sections * 25) : 0,
      tone: !hasBody ? 'warn' : sections >= 3 ? 'ok' : sections >= 2 ? 'warn' : 'fail',
    },
    // History-dependent — resolved via newsletterHistorySignals + sent-history join (WP-11).
    // Falls back to honest '—' when historySignals is null (query still loading).
    historySignals?.freshness ?? { label: 'Freshness', value: '—', sub: 'loading…', pct: 0, tone: 'warn' },
    // WP-17 item 4 (investor variant, design §H): investor updates drop
    // "Previously featured" (every update is cumulative) and add "Metric clarity"
    // (they live or die on numeric specificity). Computed honestly from the body —
    // numeric-claim count; we do NOT assert sourcing (no verifier for that here).
    row.newsletter_type === 'investor_update'
      ? (() => {
          const metrics = countClaims(body);
          return {
            label: 'Metric clarity',
            value: hasBody ? `${metrics}` : '—',
            sub: hasBody ? (metrics === 0 ? 'no numbers — add specifics' : 'numeric claims') : 'no body',
            pct: hasBody ? Math.min(100, metrics * 20) : 0,
            tone: !hasBody ? 'warn' : metrics >= 4 ? 'ok' : metrics >= 1 ? 'warn' : 'fail',
          };
        })()
      : (historySignals?.previouslyFeatured ?? { label: 'Previously featured', value: '—', sub: 'loading…', pct: 0, tone: 'warn' }),
    {
      label: 'CTAs · exclamations',
      value: hasBody ? `${ctas} · ${bangs}!` : '—',
      sub: hasBody ? (bangs > 3 ? 'too many !' : 'CTAs · !') : 'no body',
      pct: hasBody ? Math.min(100, ctas * 25) : 0,
      tone: !hasBody ? 'warn' : bangs <= 3 && ctas >= 1 ? 'ok' : 'warn',
    },
  ];
}

// ─── Email draft quality cells (5-cell, design §B email) ─────────────────────
// Mirrors newsletterQualityCells shape: { label, value, sub, pct, tone } so the
// cells render through the exact same nl-quality-cell markup. crm = resolved CRM
// record from fetchReplyIntelligence, or null. Every cell is honest about its
// signal limits — '—' value and 'warn' tone when no real data exists.
// Claims + Tone match read the draft-time ItemQuality stamp (G-QUALITY, WP-13);
// unstamped rows show honest '—', never a soft heuristic guess (D-10).
function emailQualityCells(row, crm) {
  const body = row.body ?? '';
  const hasBody = !!body;
  const agent = row.drafted_by ?? null;

  // --- LENGTH --- direct body signal (line count).
  const lines = hasBody ? body.split('\n').filter((s) => s.trim()).length : 0;

  // --- PERSONALIZATION --- merge-field count + CRM presence.
  const mergeCount = hasBody
    ? (body.match(/\{\{[^}]+\}\}|\[first[\s_]name\]/gi) || []).length
    : 0;
  const hasCrm = !!crm;
  const persLevel = mergeCount >= 3 ? 'High' : (mergeCount >= 1 || hasCrm) ? 'Med' : 'Low';
  const crmNote = hasCrm ? ' · via CRM' : (mergeCount ? '' : ' · no CRM');

  // --- THREAD CONTEXT --- CRM thread_count → full; sequence membership → partial;
  // nothing → honest "No thread · —". Never fabricates a count.
  const threadCount = crm?.thread_count;
  const hasSeq = !!row.sequence_id;
  const hasThread = threadCount != null && threadCount > 0;
  const threadLevel = hasThread && threadCount >= 3 ? 'Full'
                    : hasThread                     ? 'Partial'
                    : hasSeq                        ? 'Sequence'
                    :                                 'No thread';
  const priorLabel = hasThread
    ? `${threadCount} prior msg${threadCount !== 1 ? 's' : ''}`
    : '—';

  return [
    {
      label: 'Length',
      value: lines ? `${lines}` : '—',
      sub: lines ? 'lines' : 'no body',
      pct: lines ? Math.min(100, Math.round((lines / 8) * 100)) : 0,
      tone: !lines ? 'warn' : lines >= 2 && lines <= 8 ? 'ok' : 'warn',
    },
    // Claims: reads draft-time ItemQuality stamp (G-QUALITY, WP-13).
    // Stamped rows show verified/total counts; unstamped rows show honest '—'.
    claimsVerdictCell(row.quality),
    {
      label: 'Personalization',
      value: persLevel,
      sub: `${mergeCount} merge field${mergeCount !== 1 ? 's' : ''}${crmNote}`,
      pct: persLevel === 'High' ? 90 : persLevel === 'Med' ? 55 : 20,
      tone: persLevel === 'High' ? 'ok' : 'warn',
    },
    {
      label: 'Thread context',
      value: threadLevel,
      sub: priorLabel,
      pct: threadLevel === 'Full' ? 100 : threadLevel === 'Partial' ? 60 : threadLevel === 'Sequence' ? 40 : 0,
      tone: threadLevel === 'Full' ? 'ok' : 'warn',
    },
    // Tone match: reads draft-time ItemQuality stamp (G-QUALITY, WP-13).
    // Stamped rows show 'On-voice'/'Off-voice' + basis; unstamped rows show honest '—'.
    toneVerdictCell(row.quality),
  ];
}

// ─── State display ─────────────────────────────────────────────────────────────

function StateDisplay({ state, message, onRetry }) {
  return html`
    <div class=${cn('atelier-state', {
      'is-loading': state === 'loading',
      'is-empty': state === 'empty',
      'is-error': state === 'error',
      'is-streaming': state === 'streaming',
    })}>
      ${state === 'loading' && html`<div class="atelier-spin"></div>`}
      ${state === 'error' && html`<${Icon} name="alert-circle" size=${24} />`}
      ${state === 'empty' && html`<${Icon} name="inbox" size=${24} />`}
      ${state === 'streaming' && html`<div class="atelier-prog"></div>`}
      <p style=${{ color: 'var(--fg-muted)', fontSize: '0.825rem', margin: 0 }}>${message}</p>
      ${state === 'error' && onRetry && html`
        <button class="btn btn-sm" onClick=${onRetry}>Retry</button>
      `}
    </div>
  `;
}

export function QueueReadErrorState({ onRetry }) {
  return html`
    <div class="atelier-state is-error">
      <${Icon} name="alert-circle" size=${24} />
      <p style=${{ color: 'var(--fg-muted)', fontSize: '0.825rem', margin: 0 }}>Can't read this project's queue here.</p>
      <div style=${{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button class="btn btn-sm btn-primary" onClick=${openShellApprovals}>Open Outbox (/outbox/approvals)</button>
        ${onRetry ? html`<button class="btn btn-sm" onClick=${onRetry}>Retry</button>` : null}
      </div>
    </div>
  `;
}

// ─── Shared two-week schedule strip (design newsletter/email/social §E) ──────────
// Label column + 7 weekday columns × 2 week rows, with date numbers, a today
// marker, and a Lagos-timezone annotation. Pills are placed by parsing each
// item's scheduled_for into a real date and bucketing into the matching cell.

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeekMon(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function parseScheduled(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function TwoWeekCalendar({ items, renderPill }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week0 = startOfWeekMon(today);

  // Build 14 day-cells (two weeks starting this Monday).
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(week0);
    d.setDate(week0.getDate() + i);
    days.push(d);
  }

  // Bucket items by day index; un-dated / out-of-range fall into week 0 day 0.
  const buckets = days.map(() => []);
  for (const it of items ?? []) {
    const d = parseScheduled(it.scheduled_for ?? it.sent_at ?? it.posted_at);
    let idx = 0;
    if (d) {
      const dd = new Date(d); dd.setHours(0, 0, 0, 0);
      const found = days.findIndex((x) => sameDay(x, dd));
      idx = found >= 0 ? found : 0;
    }
    buckets[idx].push(it);
  }

  const weekRow = (weekOffset) => {
    const base = days[weekOffset * 7];
    const labelText = `${String(base.getDate()).padStart(2, '0')} ${MONTH_ABBR[base.getMonth()]} · ${weekOffset === 0 ? 'this week' : 'next week'}`;
    return html`
      <div class="nl-cal-grid">
        <div class="gcell label">${labelText}</div>
        ${WEEKDAY_LABELS.map((_, di) => {
          const dayIdx = weekOffset * 7 + di;
          const d = days[dayIdx];
          const isToday = sameDay(d, today);
          return html`
            <div key=${dayIdx} class=${cn('gcell', { 'is-today': isToday })}>
              <div class="g-day-num">${String(d.getDate()).padStart(2, '0')}${isToday ? ' · today' : ''}</div>
              ${buckets[dayIdx].map((it, k) => renderPill(it, k))}
            </div>
          `;
        })}
      </div>
    `;
  };

  return html`
    <div class="nl-cal-wrap">
      <div class="nl-cal-2wk">
        <div class="nl-cal-tz">
          <${Icon} name="clock" size=${12} />
          <span>2 weeks · Lagos (UTC+1) default send window</span>
        </div>
        <div class="nl-cal-grid head">
          <div class="gcell label">Week</div>
          ${WEEKDAY_LABELS.map((d, i) => {
            const isToday = (today.getDay() + 6) % 7 === i;
            return html`<div key=${d} class=${cn('gcell', { 'is-today': isToday })}>${d}</div>`;
          })}
        </div>
        ${weekRow(0)}
        ${weekRow(1)}
      </div>
    </div>
  `;
}

// ─── Email views ────────────────────────────────────────────────────────────────

// Reply-intelligence panel — CRM context for an email recipient (design §B/C).
// Collapses to "unknown sender" when no CRM match (host.fetch live-only, D-04).
// Standalone resolves from FIXTURE_CRM; live pulls Twenty + joins receivables.
function ReplyIntelligence({ email, sequenceId, standalone }) {
  const { data: crm } = useQuery({
    queryKey: ['email', 'ri', email],
    // Standalone resolves synchronously from FIXTURE_CRM (or null → honest empty
    // state); live mode calls the host DB. typeof-guard so the standalone path
    // degrades to null if the fixtures layer is absent. Query runs whenever
    // `email` is truthy in both modes (same dedup key as the email scorecard).
    queryFn: () => {
      if (standalone) {
        const map = typeof FIXTURE_CRM !== 'undefined' ? FIXTURE_CRM : {};
        return Promise.resolve(map[email?.toLowerCase()] ?? null);
      }
      return fetchReplyIntelligence(email);
    },
    enabled: !!email,
    placeholderData: null,
  });

  if (!crm) {
    return html`
      <div class="ri-panel">
        <div class="ri-panel-head"><span>Reply intelligence</span></div>
        <div class="ri-empty">
          <${Icon} name="user" size=${16} />
          <span><b>Unknown sender</b> — no CRM record${email ? html` for ${email}` : ''}. Create contact?</span>
        </div>
      </div>
    `;
  }

  const cell = (label, value, sub, color) => html`
    <div class="ri-cell">
      <div class="ri-cell-label">${label}</div>
      <div class="ri-cell-value" style=${color ? { color } : null}>${value ?? '—'}</div>
      ${sub ? html`<div class="ri-cell-sub">${sub}</div>` : null}
    </div>
  `;

  return html`
    <div class="ri-panel">
      <div class="ri-panel-head">
        <span>Reply intelligence</span>
        <span class="ob-chip seq" style=${{ marginLeft: 'auto' }}>CRM · Twenty</span>
      </div>
      <div class="ri-grid">
        ${cell('Tenant', crm.tenant_name ?? crm.name, crm.tenant_sub)}
        ${cell('Last touch', crm.last_touch, crm.last_touch_sub)}
        ${cell('Health', crm.health, crm.health_sub)}
        ${cell('Sequence', sequenceId ? (crm.sequence ?? sequenceId) : '— none —', crm.sequence_sub ?? 'manual reply · not part of a run')}
        ${cell('Catalog', crm.catalog, crm.catalog_sub)}
        ${cell('Open balance', crm.open_balance, crm.balance_sub)}
        ${cell('Owner', crm.owner, crm.owner_sub)}
        ${cell('Risk flag', crm.risk_flag ?? 'None', crm.risk_sub, crm.risk_color ?? 'var(--live)')}
      </div>
    </div>
  `;
}

function EmailQueueView({ standalone }) {
  const [selected, setSelected] = useState(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [commitError, setCommitError] = useState(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['email', 'queue'],
    queryFn: fetchEmailQueue,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_EMAIL_QUEUE : undefined,
  });

  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['email'] }); qc.invalidateQueries({ queryKey: ['counts'] }); };
  const commitMut = useMutation({
    mutationFn: ({ id }) => approveDraft(id),
    onSuccess: () => { setCommitError(null); invalidate(); },
    onError: (e) => { const m = String(e?.message ?? e); console.error('[outbound] commit refused:', m); setCommitError(m); },
  });
  const undo = useUndoCommit((id) => { setCommitError(null); commitMut.mutate({ id }); });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }) => rejectDraft(id, reason),
    onSuccess: () => { setRejectOpen(false); invalidate(); },
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });
  const retryMut = useMutation({
    mutationFn: ({ id }) => retryDraft(id),
    onSuccess: invalidate,
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });
  const editMut = useMutation({
    mutationFn: ({ id, patch }) => updateDraft(id, patch),
    onSuccess: () => { setEditOpen(false); invalidate(); },
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });

  // Resolved selection (must be computed pre-return so the crm hook can key on it,
  // without violating rules-of-hooks). selected wins; else first queue row.
  const rowsAll = data ?? [];
  const selResolved = selected ?? rowsAll[0] ?? null;
  // Sibling CRM query for the 5-cell email quality scorecard's THREAD/PERSONALIZATION
  // signals. Same queryKey as ReplyIntelligence → request is deduplicated. Standalone
  // resolves synchronously from the email fixture map; live calls the host DB.
  const { data: crm } = useQuery({
    queryKey: ['email', 'ri', selResolved?.recipient_email],
    queryFn: () => {
      const email = selResolved?.recipient_email;
      if (standalone) {
        // FIXTURE_CRM is supplied by the fixtures layer; typeof-guard so the
        // standalone path degrades to null (→ honest empty cells) if it's absent.
        const map = typeof FIXTURE_CRM !== 'undefined' ? FIXTURE_CRM : {};
        return Promise.resolve(map[email?.toLowerCase()] ?? null);
      }
      return fetchReplyIntelligence(email);
    },
    enabled: !!selResolved?.recipient_email,
    placeholderData: null,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading email queue…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No email items awaiting approval" />`;

  const rows = data ?? [];
  const sel = selected ?? rows[0];
  const isFailed = sel?.raw_status === 'failed';
  const canApprove = isApprovable(sel);
  const armedRow = undo.armed ? rows.find((r) => r.id === undo.armed) : null;
  const emailCells = sel ? emailQualityCells(sel, crm ?? null) : [];

  const pick = (row) => { setSelected(row); setRejectOpen(false); setEditOpen(false); };

  const sendToChat = () => {
    if (!sel) return;
    hostSendToActiveSession(
      `Help me edit this outbound email reply before I approve it.\n\nSubject: ${sel.subject}\nTo: ${sel.recipient_name || sel.recipient_email || 'segment'}\nDrafted by: ${sel.drafted_by ?? 'agent'}`,
    ).catch(() => {});
  };

  return html`
    <${FloatingUndoBar} armed=${undo.armed} secondsLeft=${undo.secondsLeft} onCancel=${undo.cancel} subject=${armedRow?.subject ?? sel?.subject} />
    <div class="nl-split">
      <div class="nl-master">
        ${(() => {
          // Grouped master list: REPLIES → MANUAL → SEQUENCE STEP (design email §B).
          // Empty groups are omitted entirely (no empty header). Agent rows surface
          // under their inferred emailGroup; never hard-code a fixed group count.
          const groups = [
            { key: 'reply', label: 'REPLIES' },
            { key: 'manual', label: 'MANUAL' },
            { key: 'sequence', label: 'SEQUENCE STEP' },
          ];
          // Any rows whose emailGroup is missing/unknown fall into MANUAL so they
          // are never silently dropped from the list.
          const known = new Set(groups.map((g) => g.key));
          const bucket = (r) => (known.has(r.emailGroup) ? r.emailGroup : 'manual');
          return groups.map(({ key, label }) => {
            const group = rows.filter((r) => bucket(r) === key);
            if (!group.length) return null;
            return html`
              <div class="nl-master-group-head" key=${'gh-' + key}>
                ${label} · ${group.length}
              </div>
              ${group.map((row) => {
                const fromLabel = emailFromLabel(row);
                const timeLabel = relDays(row.scheduled_for, { compact: true });
                const snip = row.body
                  ? `"${row.body.replace(/\s+/g, ' ').trim().slice(0, 80).trimEnd()}…"`
                  : null;
                return html`
                  <div
                    key=${row.id}
                    class=${cn('nl-row', { 'is-on': sel?.id === row.id })}
                    onClick=${() => pick(row)}
                  >
                    <div class="em-row-line1">
                      <span class="em-row-from">${fromLabel}</span>
                      ${timeLabel && timeLabel !== '—'
                        ? html`<span class="em-row-time">${timeLabel}</span>`
                        : null}
                    </div>
                    <div class="nl-row-subj">${row.subject}</div>
                    ${snip ? html`<div class="em-row-snip">${snip}</div>` : null}
                    <div class="em-row-foot">
                      <${ChannelChip} channel=${row.channel} />
                      ${row.is_overdue ? html`<${OverdueChip} hoursLate=${row.hours_late} />` : null}
                      ${row.tenant_id ? html`<span class="ob-chip seq">tenant ${row.tenant_id}</span>` : null}
                      ${row.topic_tag ? html`<span class="ob-chip tint">${row.topic_tag}</span>` : null}
                      ${key === 'sequence' && row.sequence_step != null
                        ? html`<span class="ob-chip seq">sequence · step ${row.sequence_step}/${row.sequence_total ?? '?'}</span>`
                        : null}
                      ${key === 'sequence' && row.sequence_id
                        ? html`<span class="ob-chip tint">${row.sequence_id}</span>`
                        : null}
                    </div>
                  </div>
                `;
              })}
            `;
          });
        })()}
      </div>
      <div class="nl-detail">
        ${sel ? html`
          <div class="ob-detail-wrap">
            <div class="ip-head">
              <div class="ip-meta-row">
                <${ChannelChip} channel=${sel.channel} />
                ${sel.is_overdue ? html`<${OverdueChip} />` : null}
                <span style=${{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>
                  ${sel.recipient_name || sel.recipient_email || '—'}
                </span>
              </div>
              <h2 style=${{ fontSize: '0.9rem', fontWeight: 600, margin: '0.5rem 0 0', color: 'var(--fg)' }}>
                ${sel.subject}
              </h2>
            </div>

            <${ReplyIntelligence} email=${sel.recipient_email} sequenceId=${sel.sequence_id} standalone=${standalone} />

            ${emailCells.length ? html`
              <div class="nl-quality-grid eq-quality-grid">
                ${emailCells.map((c, i) => html`
                  <div key=${i} class=${cn('nl-quality-cell', c.tone)}>
                    <div class="qlabel">${c.label}</div>
                    <div class="qvalue">${c.value} <span class="qsub">${c.sub}</span></div>
                    <div class="qbar"><div style=${{ width: `${c.pct}%` }}></div></div>
                  </div>
                `)}
              </div>
            ` : null}

            <div class="ip-body" style=${{ flex: 1, padding: '1rem', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
              <p style=${{ margin: 0 }}>
                To: <strong style=${{ color: 'var(--fg)' }}>${sel.recipient_name || sel.recipient_email || 'segment'}</strong>
                ${sel.scheduled_for ? html` · Scheduled: <strong style=${{ color: 'var(--fg)' }}>${sel.scheduled_for}</strong>` : ''}
              </p>
              ${sel.body ? html`
                <p style=${{ marginTop: '0.75rem', color: 'var(--fg)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>${sel.body}</p>
              ` : null}
              <p style=${{ marginTop: '1rem', color: 'var(--fg-muted)' }}>
                Drafted by <strong style=${{ color: 'var(--fg)' }}>${sel.drafted_by ?? 'agent'}</strong>
              </p>
              ${sel.is_overdue ? html`
                <div class="ob-chip overdue" style=${{ display: 'inline-flex', marginTop: '0.5rem' }}>
                  Past scheduled time — approve to send now
                </div>
              ` : null}
            </div>

            ${sel.error_text ? html`
              <div class="ob-chip overdue" style=${{ display: 'inline-flex', margin: '0 1rem' }}>
                Last attempt failed · ${sel.error_text}
              </div>
            ` : null}

            ${editOpen ? html`
              <${EditPanel}
                subject=${sel.subject}
                body=${sel.body}
                pending=${editMut.isPending}
                onCancel=${() => setEditOpen(false)}
                onSave=${(patch) => editMut.mutate({ id: sel.id, patch })}
              />
            ` : null}

            ${rejectOpen ? html`
              <${RejectPanel}
                canned=${EMAIL_REJECT_REASONS}
                pending=${rejectMut.isPending}
                placeholder="Optional · why? (feeds the writer-agent training set)"
                onCancel=${() => setRejectOpen(false)}
                onConfirm=${(reason) => rejectMut.mutate({ id: sel.id, reason })}
              />
            ` : null}

            <${CommitError} message=${commitError} />
            ${canApprove ? html`
              <${ConsequenceLine}
                recipient=${sel.recipient_name || sel.recipient_email}
                channel=${sel.channel}
                scheduled=${sel.scheduled_for}
              />
            ` : null}
            <div class="ob-actions">
              <div class="ob-actions-primary">
                ${isFailed ? html`
                  <button
                    class="btn"
                    style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                    onClick=${() => retryMut.mutate({ id: sel.id })}
                    disabled=${retryMut.isPending}
                  >
                    ${retryMut.isPending ? 'Retrying…' : 'Retry send'}
                  </button>
                ` : canApprove ? html`
                  <button
                    class="btn"
                    style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                    onClick=${() => undo.arm(sel.id)}
                    disabled=${commitMut.isPending || undo.isArmed(sel.id)}
                  >
                    ${commitMut.isPending ? 'Sending…' : undo.isArmed(sel.id) ? 'Sending…' : 'Approve & schedule'}
                  </button>
                ` : html`
                  <${StatusChip} rawStatus=${sel.raw_status} />
                `}
                <button class="btn btn-ghost" onClick=${() => setEditOpen((o) => !o)}>
                  Edit
                </button>
                <button class="btn btn-ghost is-danger" onClick=${() => setRejectOpen((o) => !o)}>
                  Reject
                </button>
              </div>
            </div>
            <div class="ob-actions-secondary">
              <button class="ob-btn-sm" onClick=${sendToChat}>⌘ Send to chat</button>
              <span class="ob-act-spacer"></span>
              <span class="ob-act-meta">${sel.scheduled_for ? `scheduled · ${sel.scheduled_for}` : 'no scheduled time'}</span>
            </div>
          </div>
        ` : html`<${StateDisplay} state="empty" message="Select an item to review" />`}
      </div>
    </div>
  `;
}

function EmailScheduleView({ standalone }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['email', 'schedule'],
    queryFn: fetchEmailSchedule,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_EMAIL_SCHEDULE : undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading schedule…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No scheduled email" />`;

  return html`
    <${TwoWeekCalendar}
      items=${data ?? []}
      renderPill=${(item, k) => html`
        <span key=${item.id ?? k} class="nl-cal-pill" title=${item.subject}>${item.subject}</span>
      `}
    />
  `;
}

// ── Deliverability + Sent-charts shared helpers (WP-17 items 3 + 6) ───────────
// Everything below computes from the REAL sent rows (status / delivery_status /
// error_text / sent_at exist on pa_action_drafts per migration 0051). Engagement
// (opens/clicks) is NOT on the table (mapper leaves open_rate/click_rate null),
// so those series render as an honest em-dash — never a fabricated line.

// Deliverability roll-up from a set of sent rows.
function deliverabilityStats(rows) {
  const total = rows.length;
  let delivered = 0, bounced = 0, complaints = 0, soft = 0;
  for (const r of rows) {
    const d = r.delivery_status;
    if (d === 'bounced') bounced++;
    else if (d === 'complained') complaints++;
    else if (d === 'delivered') delivered++;
    // soft bounce that was retried then delivered: error_text present but delivered
    if (r.error_text && d !== 'bounced' && d !== 'complained') soft++;
  }
  // Rows with status 'sent' but no explicit delivery_status count as delivered
  // (the send succeeded; the provider just didn't report a granular status).
  const deliveredEff = delivered + rows.filter(r => !r.delivery_status && r.delivery_status !== 'bounced').length;
  const deliveredCount = Math.max(delivered, Math.min(total, deliveredEff));
  const deliveredPct = total ? Math.round((deliveredCount / total) * 1000) / 10 : null;
  return { total, delivered: deliveredCount, bounced, complaints, soft, deliveredPct };
}

// Deliverability strip — 3 stat tiles (design email §F, lines 1561-1610).
function DeliverabilityStrip({ rows, windowLabel = 'last 30 days' }) {
  const s = deliverabilityStats(rows);
  const tile = (label, value, color, sub) => html`
    <div style=${{ background: 'var(--bg-base, var(--bg-alt))', border: '1px solid var(--border-soft, var(--border-faint))', borderRadius: 'var(--radius-md, 8px)', padding: '0.75rem' }}>
      <div class="ri-cell-label">${label}</div>
      <div style=${{ fontSize: '22px', fontWeight: 500, color: color ?? 'var(--fg)', marginTop: '4px' }}>${value}</div>
      ${sub ? html`<div class="ri-cell-sub">${sub}</div>` : null}
    </div>
  `;
  return html`
    <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', padding: '0.75rem 1rem' }}>
      ${tile('Delivered', s.deliveredPct != null ? `${s.deliveredPct}%` : '—', 'var(--live, var(--fg))', `${s.delivered} / ${s.total}${s.bounced ? ` · ${s.bounced} bounce${s.bounced === 1 ? '' : 's'}` : ''}`)}
      ${tile('Bounced', `${s.bounced}`, s.bounced ? 'var(--danger)' : 'var(--live, var(--fg))', s.soft ? `${s.soft} soft · retried` : windowLabel)}
      ${tile('Spam complaints', `${s.complaints}`, s.complaints ? 'var(--danger)' : 'var(--live, var(--fg))', windowLabel)}
    </div>
  `;
}

// Status chip for a sent row from delivery_status + error_text (design email §F).
function SentStatusChip({ row }) {
  const d = row.delivery_status;
  let cls = 'seq', label, style = null;
  if (d === 'bounced') { cls = 'overdue'; label = 'hard bounce'; }
  else if (d === 'complained') { cls = 'overdue'; label = 'spam complaint'; }
  else if (row.error_text) { cls = 'tint'; label = 'soft bounce · retried'; }
  else if (d === 'delivered') { cls = 'seq'; label = 'delivered'; style = { color: 'var(--live)' }; }
  else { cls = 'seq'; label = row.status ?? 'sent'; }
  return html`<span class="ob-chip ${cls}" style=${style}>${label}</span>`;
}

// Engagement bar — honest: if open_rate is a number, draw it; else em-dash.
function EngagementBar({ value }) {
  if (value == null) return html`<span style=${{ color: 'var(--fg-faint)' }}>—</span>`;
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return html`
    <div style=${{ height: '6px', background: 'var(--border-faint)', borderRadius: '3px', overflow: 'hidden', minWidth: '48px' }}>
      <div style=${{ height: '100%', width: `${pct}%`, background: 'var(--tint-fg-active, var(--primary))' }}></div>
    </div>
  `;
}

// Group sent rows into ISO-date buckets → [{ date, count }] ascending by date.
function sentSeriesByDay(rows, dateField = 'sent_at') {
  const buckets = new Map();
  for (const r of rows) {
    const raw = r[dateField];
    const t = raw ? Date.parse(String(raw).includes('T') ? raw : String(raw).replace(' ', 'T') + 'Z') : NaN;
    if (!Number.isFinite(t)) continue;
    const key = new Date(t).toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
}

// Honest SVG line chart of send volume over time. Renders from real rows; if a
// requested engagement series (opens/clicks) has no data, its legend entry shows
// an em-dash instead of a fabricated line. Pure SVG, no deps.
function SentLineChart({ rows, title = 'Send volume', extraLegends = [], dateField = 'sent_at' }) {
  const series = sentSeriesByDay(rows, dateField);
  const W = 520, H = 180, padL = 34, padR = 12, padT = 14, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxY = Math.max(1, ...series.map((d) => d.count));
  const n = series.length;
  const x = (i) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => padT + ih - (v / maxY) * ih;
  const linePath = series.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.count).toFixed(1)}`).join(' ');
  const areaPath = n ? `${linePath} L${x(n - 1).toFixed(1)},${(padT + ih).toFixed(1)} L${x(0).toFixed(1)},${(padT + ih).toFixed(1)} Z` : '';
  const yticks = [0, Math.ceil(maxY / 2), maxY];

  return html`
    <div class="chart-card" style=${{ background: 'var(--bg-sunken, var(--bg-alt))', border: '1px solid var(--border-soft, var(--border-faint))', borderRadius: 'var(--radius-md, 8px)', overflow: 'hidden' }}>
      <div style=${{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap', padding: '0.6rem 0.75rem', borderBottom: '1px solid var(--border-soft, var(--border-faint))' }}>
        <h4 style=${{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: '0.9rem', color: 'var(--fg)' }}>${title}</h4>
        <span style=${{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--fg-faint)' }}>per day · ${n} point${n === 1 ? '' : 's'}</span>
        <span style=${{ marginLeft: 'auto', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span style=${{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--fg-muted)' }}>
            <span style=${{ width: '8px', height: '8px', borderRadius: '2px', background: 'var(--tint-fg-active, var(--primary))' }}></span>Sent
          </span>
          ${extraLegends.map((l, i) => html`
            <span key=${i} style=${{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--fg-faint)' }}>
              <span style=${{ width: '8px', height: '8px', borderRadius: '2px', background: 'var(--border-soft, var(--border-faint))' }}></span>${l} —
            </span>
          `)}
        </span>
      </div>
      <div style=${{ padding: '0.5rem 0.75rem' }}>
        ${n === 0 ? html`
          <div class="ri-cell-sub" style=${{ padding: '1.5rem 0', textAlign: 'center' }}>No dated sends to chart yet.</div>
        ` : html`
          <svg viewBox=${`0 0 ${W} ${H}`} style=${{ display: 'block', width: '100%', height: 'auto' }} role="img" aria-label=${`${title} line chart`}>
            ${yticks.map((v, i) => html`
              <g key=${i}>
                <line x1=${padL} y1=${y(v)} x2=${W - padR} y2=${y(v)} stroke="var(--border-soft, var(--border-faint))" stroke-width="1" stroke-dasharray="2 3" opacity="0.6" />
                <text x=${padL - 6} y=${y(v) + 3} text-anchor="end" style=${{ fontFamily: 'var(--font-mono)', fontSize: '9px', fill: 'var(--fg-faint)' }}>${v}</text>
              </g>
            `)}
            ${areaPath ? html`<path d=${areaPath} fill="var(--tint-fg-active, var(--primary))" opacity="0.12" />` : null}
            <path d=${linePath} fill="none" stroke="var(--tint-fg-active, var(--primary))" stroke-width="1.6" />
            ${series.map((d, i) => html`<circle key=${i} cx=${x(i)} cy=${y(d.count)} r="2.4" fill="var(--tint-fg-active, var(--primary))" stroke="var(--bg-sunken, var(--bg-alt))" stroke-width="1.2" />`)}
            ${n <= 8 ? series.map((d, i) => html`<text key=${'x' + i} x=${x(i)} y=${H - 8} text-anchor="middle" style=${{ fontFamily: 'var(--font-mono)', fontSize: '8.5px', fill: 'var(--fg-faint)' }}>${d.date.slice(5)}</text>`) : null}
          </svg>
        `}
      </div>
    </div>
  `;
}

function EmailSentView({ standalone }) {
  const [sentView, setSentView] = useState('table');
  const [typeFilter, setTypeFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['email', 'sent'],
    queryFn: fetchEmailSent,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_EMAIL_SENT : undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading sent…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;

  const rows = (data ?? []).filter(r => {
    if (channelFilter !== 'all' && r.delivery_system !== channelFilter) return false;
    // WP-17 item 5: "Transactional" = per-message send (smtp/resend/API), NOT a
    // bulk listmonk campaign. Honest heuristic — no transactional column exists.
    if (typeFilter === 'transactional' && r.delivery_system === 'listmonk') return false;
    return true;
  });

  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div class="nl-sent-toolbar">
        <button class=${cn('ob-filter-chip', { 'is-on': typeFilter === 'all' })} onClick=${() => setTypeFilter('all')}>All types</button>
        <button class=${cn('ob-filter-chip', { 'is-on': typeFilter === 'transactional' })} onClick=${() => setTypeFilter('transactional')}>Transactional</button>
        <span style=${{ flex: 1 }}></span>
        <button class=${cn('ob-filter-chip', { 'is-on': channelFilter === 'all' })} onClick=${() => setChannelFilter('all')}>All channels</button>
        <button class=${cn('ob-filter-chip', { 'is-on': channelFilter === 'listmonk' })} onClick=${() => setChannelFilter('listmonk')}>listmonk</button>
        <button class=${cn('ob-filter-chip', { 'is-on': channelFilter === 'resend' })} onClick=${() => setChannelFilter('resend')}>resend</button>
        <div class="nl-view-toggle">
          <button class=${cn({ 'is-on': sentView === 'table' })} onClick=${() => setSentView('table')}>Table</button>
          <button class=${cn({ 'is-on': sentView === 'charts' })} onClick=${() => setSentView('charts')}>Charts</button>
        </div>
      </div>
      <div class="nl-sent-body" style=${{ overflow: 'auto' }}>
        ${sentView === 'table' ? html`
          <${DeliverabilityStrip} rows=${rows} />
          <table class="nl-sent-table">
            <thead><tr>
              <th>Sent</th><th>Subject</th><th>To</th><th>Source</th><th>Status</th><th>Engagement</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => html`
                <tr key=${r.id}>
                  <td class="meta">${formatDate(r.sent_at)}</td>
                  <td>${r.subject}</td>
                  <td class="meta">${r.recipient_email ?? '—'}</td>
                  <td class="meta">${r.delivery_system ?? '—'}</td>
                  <td><${SentStatusChip} row=${r} /></td>
                  <td><${EngagementBar} value=${r.open_rate} /></td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`
          <div style=${{ padding: '0.75rem 1rem' }}>
            <${DeliverabilityStrip} rows=${rows} />
            <${SentLineChart} rows=${rows} title="Emails sent" extraLegends=${['Opens', 'Clicks']} />
            <p class="ri-cell-sub" style=${{ marginTop: '0.5rem' }}>
              Opens / clicks aren't captured on the send log yet (Phase 2) — the chart plots real send volume; engagement series show em-dash.
            </p>
          </div>
        `}
      </div>
    </div>
  `;
}

// ─── Newsletter views ───────────────────────────────────────────────────────────

// Strip HTML tags + decode a few common entities → plain text (client-side only).
function toPlainText(s) {
  return String(s ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// WP-17 item 2: newsletter body preview toolbar (Rendered / HTML source / Plain
// text) + the anti-patterns "fix in chat" list. Design newsletter §B lines
// 2278-2330. All three views render the SAME existing body — no external
// pipeline. Anti-pattern findings are computed honestly from the body text and
// each hands its section to chat via recipe-1 dispatch (hostSendToActiveSession).
function NewsletterBodyPane({ body, subject, onFixInChat }) {
  const [mode, setMode] = useState('rendered');
  const text = body ?? '';
  const findings = useMemo(() => findAntiPatterns(text), [text]);
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(text);

  const segBtn = (id, label) => html`
    <button type="button" class=${cn({ 'is-on': mode === id })} onClick=${() => setMode(id)}>${label}</button>
  `;

  let bodyView;
  if (!text) {
    bodyView = html`<div class="nl-body-textarea" style=${{ color: 'var(--fg-faint)' }}>(body not yet generated)</div>`;
  } else if (mode === 'html') {
    bodyView = html`<pre class="nl-body-textarea" style=${{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: '11px', margin: 0 }}>${text}</pre>`;
  } else if (mode === 'plain') {
    bodyView = html`<pre class="nl-body-textarea" style=${{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: '11px', margin: 0 }}>${toPlainText(text)}</pre>`;
  } else if (looksHtml) {
    // Rendered: the draft is the newsletter's own HTML, reviewed in a same-origin
    // srcdoc iframe. Render it so the operator sees what subscribers see.
    bodyView = html`<div class="nl-body-textarea" style=${{ overflow: 'auto' }} dangerouslySetInnerHTML=${{ __html: text }}></div>`;
  } else {
    bodyView = html`<div class="nl-body-textarea" style=${{ whiteSpace: 'pre-wrap', overflow: 'auto', lineHeight: 1.6 }}>${text}</div>`;
  }

  return html`
    <div class="nl-body-pane">
      ${findings.length ? html`
        <div class="ob-ap-list" style=${{ display: 'flex', flexDirection: 'column', gap: '0.375rem', marginBottom: '0.5rem' }}>
          <span class="lbl">Anti-patterns flagged · ${findings.length} · click "fix" to hand the section to chat</span>
          ${findings.map((f, i) => html`
            <div key=${i} style=${{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', padding: '0.375rem 0.5rem', border: '1px solid var(--border-faint)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--bg-alt, transparent)' }}>
              <span style=${{ color: 'var(--achievement, var(--danger))', fontWeight: 700, lineHeight: 1.3 }}>!</span>
              <div style=${{ flex: 1, minWidth: 0 }}>
                <div style=${{ fontSize: '0.8125rem', color: 'var(--fg)' }}>
                  ${f.kind === 'hype'
                    ? html`Hype phrase · "<em>${f.term}</em>" detected`
                    : html`Vague metric · "<em>${f.term}</em>" without a number`}
                </div>
                <div style=${{ fontSize: '0.7rem', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  body line ${f.line} · "${f.excerpt}"
                </div>
              </div>
              <button class="ob-btn-sm" type="button" onClick=${() => onFixInChat?.(f)}>↗ fix in chat</button>
            </div>
          `)}
        </div>
      ` : null}
      <div style=${{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
        <span class="lbl" style=${{ margin: 0 }}>Body</span>
        <div class="nl-view-toggle">
          ${segBtn('rendered', 'Rendered')}
          ${segBtn('html', 'HTML source')}
          ${segBtn('plain', 'Plain text')}
        </div>
      </div>
      ${bodyView}
    </div>
  `;
}

function NewsletterQueueView({ standalone }) {
  const [selected, setSelected] = useState(null);
  const [abChoice, setAbChoice] = useState(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [commitError, setCommitError] = useState(null);
  // WP-17 item 1: operator-editable subject / A·B alt / preheader. Local state,
  // reset when the selected draft changes; persisted via updateDraft on blur
  // (cumulative patch → edited_json) and flushed before Approve arms — mirrors
  // the SocialEditor body-persist pattern so a committed row carries the last
  // edited values, never the stale original.
  const [editSubject, setEditSubject] = useState('');
  const [editSubjectB, setEditSubjectB] = useState('');
  const [editPreheader, setEditPreheader] = useState('');
  const [fieldSaveError, setFieldSaveError] = useState(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['newsletter', 'queue'],
    queryFn: fetchNewsletterQueue,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_NL_QUEUE : undefined,
  });

  // Sent-history query (WP-11): supplies Freshness + Previously-featured cells.
  // Keyed separately from the queue so it doesn't block the queue render.
  // Standalone resolves from FIXTURE_NL_HISTORY; live calls both DB sources.
  const { data: historyRows, isError: historyError } = useQuery({
    queryKey: ['newsletter', 'history'],
    queryFn: () => {
      if (standalone) return Promise.resolve(FIXTURE_NL_HISTORY);
      return fetchNewsletterHistory();
    },
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_NL_HISTORY : undefined,
  });

  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['newsletter'] }); qc.invalidateQueries({ queryKey: ['counts'] }); };
  const commitMut = useMutation({
    mutationFn: ({ id }) => approveDraft(id),
    onSuccess: () => { setCommitError(null); invalidate(); },
    onError: (e) => { const m = String(e?.message ?? e); console.error('[outbound] commit refused:', m); setCommitError(m); },
  });
  const undo = useUndoCommit((id) => { setCommitError(null); commitMut.mutate({ id }); });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }) => rejectDraft(id, reason),
    onSuccess: () => { setRejectOpen(false); invalidate(); },
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });

  // Resolve the active selection PRE-return (rules-of-hooks): the field-reset
  // effect must run unconditionally. Mirrors the `sel` resolution below.
  const nlRows = data ?? [];
  const selEarly = selected
    ?? nlRows.find(r => r.status === 'pending')
    ?? nlRows.find(r => r.status === 'cooling')
    ?? nlRows.find(r => r.status === 'approved')
    ?? nlRows[0] ?? null;
  useEffect(() => {
    setEditSubject(selEarly?.subject ?? '');
    setEditSubjectB(selEarly?.subject_b ?? '');
    setEditPreheader(selEarly?.preheader ?? '');
    setFieldSaveError(null);
  }, [selEarly?.id]);

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading newsletter queue…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No newsletter items awaiting review" />`;

  const rows = data ?? [];
  const cooling = rows.filter(r => r.status === 'cooling');
  const pending = rows.filter(r => r.status === 'pending');
  const approved = rows.filter(r => r.status === 'approved');
  const sel = selEarly;
  const isInvestor = sel?.newsletter_type === 'investor_update';

  // Persist edited subject / A·B alt / preheader as a CUMULATIVE patch (pa_actions_update
  // replaces edited_json wholesale, so send the full set to avoid clobbering).
  // subject rounds-trips via the mapper; subject_b/preheader persist for the worker.
  const fieldsDirty = () =>
    !!sel && (
      editSubject !== (sel.subject ?? '') ||
      editSubjectB !== (sel.subject_b ?? '') ||
      editPreheader !== (sel.preheader ?? '')
    );
  async function persistFields() {
    if (standalone || !sel?.id || !fieldsDirty()) return;
    setFieldSaveError(null);
    try {
      await updateDraft(sel.id, {
        subject: editSubject,
        subject_b: editSubjectB || null,
        preheader: editPreheader || null,
        body: sel.body ?? '',
      });
      invalidate();
    } catch (e) {
      const m = String(e?.message ?? e);
      console.error('[outbound] newsletter field update failed:', m);
      setFieldSaveError(m);
      throw e;
    }
  }
  // Hand one flagged anti-pattern section to the Chi (recipe-1 dispatch).
  const fixInChat = (finding) => {
    if (!sel) return;
    hostSendToActiveSession(
      `Fix this copy issue in the newsletter draft "${editSubject || sel.subject}" before I approve it.\n\n`
      + `Issue: ${finding.kind === 'hype' ? 'hype phrase' : 'vague metric'} — "${finding.term}"\n`
      + `Location: body line ${finding.line}\n`
      + `Excerpt: "${finding.excerpt}"\n\n`
      + `Rewrite that line to remove the ${finding.kind === 'hype' ? 'hype language' : 'vague claim (add a concrete number or cut it)'}, keeping the meaning.`,
      'com.ikenga.outbound',
    ).catch(() => {});
  };

  const isCooling = sel?.status === 'cooling';
  const canApprove = isApprovable(sel) && !isCooling;
  const armedRow = undo.armed ? rows.find((r) => r.id === undo.armed) : null;
  const pick = (row) => { setSelected(row); setAbChoice(null); setRejectOpen(false); };

  // Compute history signals for the selected row (pure, uses historyRows from query).
  const historySignals = historyError
    ? {
        freshness: { label: 'Freshness', value: '—', sub: "Can't read this project's queue here", pct: 0, tone: 'warn' },
        previouslyFeatured: { label: 'Prev. featured', value: '—', sub: "Can't read this project's queue here", pct: 0, tone: 'warn' },
      }
    : sel
      ? newsletterHistorySignals({ subject: sel.subject, body: sel.body, section: sel.draft_slug }, historyRows ?? [])
      : null;
  const qualityCells = sel ? newsletterQualityCells(sel, historySignals) : [];

  const sendToChat = () => {
    if (!sel) return;
    hostSendToActiveSession(
      `Help me edit this newsletter draft before I approve it.\n\nSubject: ${sel.subject}\nEdition: ${sel.edition ?? '—'}\nQuality score: ${sel.quality_score ?? '—'}/100`,
    ).catch(() => {});
  };

  const subjLen = editSubject.length;
  const altLen = editSubjectB.length;

  return html`
    <${FloatingUndoBar} armed=${undo.armed} secondsLeft=${undo.secondsLeft} onCancel=${undo.cancel} subject=${armedRow?.subject ?? sel?.subject} label="Scheduling" />
    <div class="nl-split">
      <div class="nl-master">
        ${cooling.length ? html`
          <div class="nl-master-group-head">Cooling · ${cooling.length}</div>
          ${cooling.map(row => html`
            <div key=${row.id} class=${cn('nl-row', { 'is-on': sel?.id === row.id })} onClick=${() => pick(row)}>
              <div class="nl-row-head">
                <${CoolingChip} until=${row.cooling_until} />
                <${QualityChip} score=${row.quality_score} />
              </div>
              <div class="nl-row-subj">${row.subject}</div>
              <div class="nl-row-pre">${row.recipient_count ? `${row.recipient_count.toLocaleString()} recipients` : ''}</div>
            </div>
          `)}
        ` : null}
        ${html`<div class="nl-master-group-head">Ready to review · ${pending.length}</div>`}
        ${pending.map(row => html`
          <div key=${row.id} class=${cn('nl-row', { 'is-on': sel?.id === row.id })} onClick=${() => pick(row)}>
            <div class="nl-row-head">
              <${QualityChip} score=${row.quality_score} />
              ${row.has_ab ? html`<span class="ob-chip ab">A·B</span>` : null}
            </div>
            <div class="nl-row-subj">${row.subject}</div>
            <div class="nl-row-pre">${row.recipient_count ? `${row.recipient_count.toLocaleString()} recipients` : ''}</div>
          </div>
        `)}
        ${html`<div class="nl-master-group-head">Approved · ${approved.length}</div>`}
        ${approved.map(row => html`
          <div key=${row.id} class=${cn('nl-row', { 'is-on': sel?.id === row.id })} onClick=${() => pick(row)}>
            <div class="nl-row-subj">${row.subject}</div>
          </div>
        `)}
      </div>
      <div class="nl-detail">
        ${sel ? html`
          <div class="ob-detail-wrap">
            <div class="ip-head" style=${{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-faint)' }}>
              <div class="ip-meta-row" style=${{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <${QualityChip} score=${sel.quality_score} />
                ${!isInvestor && editSubjectB ? html`<span class="ob-chip ab">A·B</span>` : null}
                ${isInvestor ? html`<span class="ob-chip seq">Investor update</span>` : null}
                ${isCooling ? html`<${CoolingChip} until=${sel.cooling_until} />` : null}
                ${sel.recipient_count ? html`<span class="ob-chip seq">${sel.recipient_count.toLocaleString()} recipients</span>` : null}
              </div>
            </div>

            <!-- Subject / A·B alt / Preheader card (design §B) — WP-17 item 1: editable.
                 Investor-update variant (design §H): no A/B alt, Resend framing,
                 Twenty CRM list picker instead of the listmonk segment chip. -->
            <div class="nl-subj-card">
              <div class="nl-subj-row">
                <span class="lbl">Subject</span>
                <input
                  value=${editSubject}
                  onInput=${(e) => setEditSubject(e.target.value)}
                  onBlur=${() => { persistFields().catch(() => {}); }}
                />
              </div>
              ${isInvestor ? null : html`
                <div class="nl-subj-row alt">
                  <span class="lbl">A/B alt</span>
                  <input
                    value=${editSubjectB}
                    placeholder="— no alternate subject —"
                    onInput=${(e) => setEditSubjectB(e.target.value)}
                    onBlur=${() => { persistFields().catch(() => {}); }}
                  />
                </div>
              `}
              <div class="nl-subj-row">
                <span class="lbl">Preheader</span>
                <input
                  value=${editPreheader}
                  placeholder="— preheader —"
                  onInput=${(e) => setEditPreheader(e.target.value)}
                  onBlur=${() => { persistFields().catch(() => {}); }}
                />
              </div>
              <div class="pre-row">
                ${isInvestor ? html`
                  <span class="ob-chip seq">Resend${sel.from_line ? ` · ${sel.from_line}` : ' · ned@royalti.io'}</span>
                  <span class="ob-chip ab">Investor list${sel.recipient_count ? ` · ${sel.recipient_count.toLocaleString()}` : ''}</span>
                  <span class="ob-chip seq">via Twenty CRM segment</span>
                ` : html`
                  <span class="ob-chip seq">${sel.delivery_system ?? 'listmonk'}${editSubjectB ? ' · A/B 50/50' : ''}</span>
                  <span class="ob-chip seq">From <strong style=${{ color: 'var(--fg)', marginLeft: '4px' }}>${sel.from_line ?? 'Ruby <ruby@royalti.io>'}</strong></span>
                `}
                <span class="count">subject · ${subjLen} chars${editSubjectB ? ` · alt · ${altLen} chars` : ''}${isInvestor ? ' · no A/B · single subject' : ''}</span>
              </div>
            </div>

            ${!isInvestor && editSubjectB ? html`
              <div style=${{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-faint)' }}>
                <p style=${{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 0.5rem' }}>
                  Select variant to advance
                </p>
                <div class="ob-ab-selector">
                  <button class=${cn('ob-ab-btn', { 'is-on': (abChoice ?? 'A') === 'A' })} onClick=${() => setAbChoice('A')}>
                    <span class="ob-ab-label">A</span>
                    <span class="ob-ab-subject">${editSubject}</span>
                  </button>
                  ${editSubjectB ? html`
                    <button class=${cn('ob-ab-btn', { 'is-on': abChoice === 'B' })} onClick=${() => setAbChoice('B')}>
                      <span class="ob-ab-label">B</span>
                      <span class="ob-ab-subject">${editSubjectB}</span>
                    </button>
                  ` : null}
                </div>
              </div>
            ` : null}

            <!-- 8-cell quality scorecard (design §B) -->
            <div class="nl-quality-grid">
              ${qualityCells.map((c, i) => html`
                <div key=${i} class=${cn('nl-quality-cell', c.tone)}>
                  <div class="qlabel">${c.label}</div>
                  <div class="qvalue">${c.value} <span class="qsub">${c.sub}</span></div>
                  <div class="qbar"><div style=${{ width: `${c.pct}%` }}></div></div>
                </div>
              `)}
            </div>

            <!-- Body pane — WP-17 item 2: Rendered / HTML source / Plain text toggle
                 + anti-patterns "fix in chat" list (design §B lines 2278-2330). -->
            <${NewsletterBodyPane} body=${sel.body} subject=${editSubject} onFixInChat=${fixInChat} />

            ${fieldSaveError ? html`<${CommitError} message=${fieldSaveError} />` : null}

            ${rejectOpen ? html`
              <${RejectPanel}
                canned=${NL_REJECT_REASONS}
                pending=${rejectMut.isPending}
                placeholder="Optional · why? (feeds the writer-agent training set)"
                onCancel=${() => setRejectOpen(false)}
                onConfirm=${(reason) => rejectMut.mutate({ id: sel.id, reason })}
              />
            ` : null}

            <${CommitError} message=${commitError} />
            ${canApprove ? html`
              <${ConsequenceLine}
                recipient=${sel.recipient_count ? `${sel.recipient_count.toLocaleString()} recipients` : 'segment'}
                channel=${sel.delivery_system ?? 'listmonk'}
                scheduled=${sel.scheduled_for}
              />
            ` : null}
            <div class="ob-actions">
              <div class="ob-actions-primary">
                ${sel.raw_status === 'failed' ? html`
                  <button
                    class="btn"
                    style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                    disabled=${commitMut.isPending}
                    onClick=${() => undo.arm(sel.id)}
                  >Retry send</button>
                ` : isApprovable(sel) ? html`
                  <button
                    class="btn"
                    disabled=${isCooling || commitMut.isPending || undo.isArmed(sel.id)}
                    style=${isCooling ? { opacity: 0.5, cursor: 'not-allowed' } : { background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                    onClick=${async () => {
                      if (isCooling) return;
                      // Flush pending subject/preheader edits BEFORE arming — an
                      // unsaved edit must never silently lose to the original on commit.
                      try { await persistFields(); } catch { return; }
                      undo.arm(sel.id);
                    }}
                    title=${isCooling ? `Cooling — send blocked for ${sel.cooling_until}` : 'Approve & Schedule'}
                  >
                    ${commitMut.isPending || undo.isArmed(sel.id) ? 'Scheduling…' : isCooling ? `Cooling ${sel.cooling_until}` : 'Approve & Schedule'}
                  </button>
                ` : html`
                  <${StatusChip} rawStatus=${sel.raw_status} />
                `}
                <button class="btn btn-ghost is-danger" onClick=${() => setRejectOpen((o) => !o)}>
                  Reject…
                </button>
              </div>
            </div>

            <!-- Secondary action footer (design §B): Back · Send-to-chat · Skip month · meta -->
            <div class="ob-actions-secondary">
              <button class="ob-btn-sm" onClick=${() => setSelected(null)}>↩ Back to list</button>
              <button class="ob-btn-sm" onClick=${sendToChat}>⌘ Send to chat</button>
              <!-- WP-17 item 5: "Skip month" was dead. Skip = reject this cycle's
                   send with a canned reason (reuses the reject write path). -->
              <button
                class="ob-btn-sm"
                title="Skip this month's send"
                disabled=${!isApprovable(sel) || rejectMut.isPending}
                onClick=${() => rejectMut.mutate({ id: sel.id, reason: 'Skipped this cycle' })}
              >⏭ ${rejectMut.isPending ? 'Skipping…' : 'Skip month'}</button>
              <span class="ob-act-spacer"></span>
              <span class="ob-act-meta">${isCooling ? `cooling · ${sel.cooling_until}` : `${sel.edition ?? 'draft'} · ${sel.delivery_system ?? 'listmonk'}`}</span>
            </div>
          </div>
        ` : html`<${StateDisplay} state="empty" message="Select a draft to review" />`}
      </div>
    </div>
  `;
}

function NewsletterScheduleView({ standalone }) {
  // Scheduled newsletter sends — single source: pa_action_drafts rows whose
  // derived content type is 'newsletter' and that carry a future scheduled_at.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['newsletter', 'schedule'],
    queryFn: async () => {
      if (standalone) {
        const wk = startOfWeekMon(new Date());
        const at = (offset, h) => { const d = new Date(wk); d.setDate(wk.getDate() + offset); d.setHours(h, 0, 0, 0); return d.toISOString(); };
        return [
          { id: 'ns-cal-1', subject: 'Schema patches that unblocked tenant 590', scheduled_for: at(1, 10), recipient_count: 2104, kind: 'scheduled' },
          { id: 'ns-cal-2', subject: 'Investor Update — May', scheduled_for: at(3, 14), recipient_count: null, kind: 'investor' },
          { id: 'ns-cal-3', subject: 'You can deliver from Royalti now', scheduled_for: at(8, 10), recipient_count: 2104, kind: 'cooling' },
        ];
      }
      const scheduled = (await loadDrafts(SCHEDULE_STATUSES)).filter(hasSchedule);
      const nl = [];
      for (const r of scheduled) {
        const { item } = parseDraft(r);
        if (deriveContentType(item) !== 'newsletter') continue;
        nl.push({
          id: r.id,
          subject: item.subject ?? '(no subject)',
          edition: null,
          status: r.status,
          cooling_until: null,
          recipient_count: item.recipients ?? null,
          scheduled_for: r.scheduled_at,
          kind: 'scheduled',
        });
      }
      return nl;
    },
    enabled: !standalone,
    placeholderData: undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading schedule…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No scheduled newsletter" />`;

  return html`
    <${TwoWeekCalendar}
      items=${data ?? []}
      renderPill=${(item, k) => html`
        <span
          key=${item.id ?? k}
          class=${cn('nl-cal-pill', { cool: item.kind === 'cooling', investor: item.kind === 'investor' })}
          title=${item.subject}
        >${item.subject}</span>
      `}
    />
  `;
}

function NewsletterSentView({ standalone }) {
  const [sentView, setSentView] = useState('table');
  const [typeFilter, setTypeFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['newsletter', 'sent'],
    queryFn: fetchNewsletterSent,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_NL_SENT : undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading sent…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No sent newsletters" />`;

  const allRows = data ?? (standalone ? FIXTURE_NL_SENT : []);
  // WP-17 item 5: type + channel filter chips were decorative. Wire them.
  // Type maps the UI 'investor' chip → newsletter_type 'investor_update'.
  const rows = allRows.filter((r) => {
    if (channelFilter !== 'all' && r.delivery_system !== channelFilter) return false;
    if (typeFilter === 'newsletter' && r.newsletter_type === 'investor_update') return false;
    if (typeFilter === 'investor' && r.newsletter_type !== 'investor_update') return false;
    return true;
  });

  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div class="nl-sent-toolbar">
        <button class=${cn('ob-filter-chip', { 'is-on': typeFilter === 'all' })} onClick=${() => setTypeFilter('all')}>All types</button>
        <button class=${cn('ob-filter-chip', { 'is-on': typeFilter === 'newsletter' })} onClick=${() => setTypeFilter('newsletter')}>Newsletter</button>
        <button class=${cn('ob-filter-chip', { 'is-on': typeFilter === 'investor' })} onClick=${() => setTypeFilter('investor')}>Investor update</button>
        <span style=${{ flex: 1 }}></span>
        <button class=${cn('ob-filter-chip', { 'is-on': channelFilter === 'all' })} onClick=${() => setChannelFilter('all')}>All channels</button>
        <button class=${cn('ob-filter-chip', { 'is-on': channelFilter === 'listmonk' })} onClick=${() => setChannelFilter('listmonk')}>listmonk</button>
        <button class=${cn('ob-filter-chip', { 'is-on': channelFilter === 'resend' })} onClick=${() => setChannelFilter('resend')}>resend</button>
        <div class="nl-view-toggle">
          <button class=${cn({ 'is-on': sentView === 'table' })} onClick=${() => setSentView('table')}>Table</button>
          <button class=${cn({ 'is-on': sentView === 'charts' })} onClick=${() => setSentView('charts')}>Charts</button>
        </div>
      </div>
      <div class="nl-sent-body" style=${{ overflow: 'auto' }}>
        ${sentView === 'table' ? html`
          <table class="nl-sent-table">
            <thead><tr>
              <th>Subject</th><th>Type</th><th>System</th><th>Sent</th>
              <th>Recipients</th><th>Open</th><th>Click</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => html`
                <tr key=${r.id}>
                  <td>${r.subject}</td>
                  <td class="meta">${r.newsletter_type === 'investor_update' ? 'Investor' : 'Newsletter'}</td>
                  <td><span class="ob-chip channel-listmonk">${r.delivery_system}</span></td>
                  <td class="meta">${formatDate(r.sent_at)}</td>
                  <td class="num">${r.recipient_count ? Number(r.recipient_count).toLocaleString() : '—'}</td>
                  <td class="pct">${formatPct(r.open_rate)}</td>
                  <td class="pct">${formatPct(r.click_rate)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`
          <div style=${{ padding: '0.75rem 1rem' }}>
            <${SentLineChart} rows=${rows} title="Newsletters sent" extraLegends=${['Open rate', 'Click rate']} />
            <p class="ri-cell-sub" style=${{ marginTop: '0.5rem' }}>
              Open / click rates aren't captured on the send log yet (Phase 2) — the chart plots real send volume; engagement series show em-dash.
            </p>
          </div>
        `}
      </div>
    </div>
  `;
}

// ─── Sequences views ────────────────────────────────────────────────────────────

// Step-rail for one sequence — vertical step cards + delay labels (design §B).
// outbound_sequence_steps is empty live → falls back to a graceful empty state.
function SequenceStepRail({ sequence, standalone }) {
  const seqId = sequence?.id;
  const [rejectOpen, setRejectOpen] = useState(false);
  const [commitError, setCommitError] = useState(null);
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['sequences'] }); qc.invalidateQueries({ queryKey: ['counts'] }); };
  const commitMut = useMutation({
    mutationFn: ({ id }) => approveDraft(id),
    onSuccess: () => { setCommitError(null); invalidate(); },
    onError: (e) => { const m = String(e?.message ?? e); console.error('[outbound] commit refused:', m); setCommitError(m); },
  });
  const undo = useUndoCommit((id) => { setCommitError(null); commitMut.mutate({ id }); });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }) => rejectDraft(id, reason),
    onSuccess: () => { setRejectOpen(false); invalidate(); },
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });
  const canApprove = isApprovable(sequence);
  const { data: steps, isLoading } = useQuery({
    queryKey: ['sequences', 'steps', seqId],
    queryFn: () => fetchSequenceSteps(seqId),
    enabled: !standalone && !!seqId,
    placeholderData: standalone ? FIXTURE_SEQ_STEPS : undefined,
  });

  const list = steps ?? [];
  const delayLabel = (s) =>
    s.delay_value > 0 ? `+${s.delay_value} ${s.delay_unit ?? 'days'} · skip if recipient replied` : 'day 0 · fires on enrol';

  return html`
    <div class="sq-detail">
      <div class="sq-detail-head">
        <div style=${{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          ${sequence.delivery_system ? html`<span class=${cn('ob-chip', `channel-${sequence.delivery_system}`)}>${sequence.delivery_system}</span>` : null}
          ${sequence.created_by ? html`<span class="ob-chip seq">${sequence.created_by}</span>` : null}
          <span class="ob-chip cooling">awaiting approval</span>
        </div>
        <h2>${sequence.name ?? sequence.slug ?? sequence.id}</h2>
        ${sequence.description ? html`<p style=${{ fontSize: '0.8125rem', color: 'var(--fg-muted)', margin: '0.25rem 0 0', lineHeight: 1.55 }}>${sequence.description}</p>` : null}
        <div class="sq-detail-meta">
          <span><b>Segment</b> ${sequence.segment ?? '—'}</span>
          <span><b>Delivery</b> ${sequence.delivery_system ?? '—'}</span>
          <span><b>Total steps</b> ${sequence.total_steps ?? list.length}</span>
        </div>
      </div>

      ${isLoading ? html`<${StateDisplay} state="loading" message="Loading steps…" />`
        : list.length === 0 ? html`<${StateDisplay} state="empty" message=${standalone ? "No steps defined for this sequence yet" : "Not available yet"} />`
        : html`
          <div class="step-rail">
            ${list.map((s, i) => html`
              ${i > 0 ? html`<div class="step-delay">${delayLabel(s)}</div>` : null}
              <div key=${s.id ?? i} class=${cn('step-card', { 'is-current': i === 0 })}>
                <div class="step-card-head">
                  <span class="step-num">${s.step_number ?? i + 1}</span>
                  <span class="step-subj">${s.subject}</span>
                  <span class="ob-chip seq" style=${{ marginLeft: 'auto' }}>day ${s.delay_value ?? 0}</span>
                </div>
                <div class="step-card-meta">
                  <span>${s.channel ?? sequence.delivery_system ?? 'resend'}</span>
                  <span>tracked open + click</span>
                </div>
                ${s.body ? html`<div class="step-card-body">${s.body}</div>` : null}
              </div>
            `)}
          </div>
          ${rejectOpen ? html`
            <${RejectPanel}
              canned=${SEQ_REJECT_REASONS}
              pending=${rejectMut.isPending}
              placeholder="Optional · why? (feeds the writer-agent training set)"
              onCancel=${() => setRejectOpen(false)}
              onConfirm=${(reason) => rejectMut.mutate({ id: sequence.id, reason })}
            />
          ` : null}
          <${FloatingUndoBar} armed=${undo.armed} secondsLeft=${undo.secondsLeft} onCancel=${undo.cancel} subject=${sequence?.name ?? sequence?.slug} label="Activating" />
          <${CommitError} message=${commitError} />
          ${canApprove ? html`
            <${ConsequenceLine}
              recipient=${sequence?.segment || 'enrolled recipients'}
              channel=${sequence?.delivery_system}
              scheduled="now"
            />
          ` : null}
          <div class="sq-footer">
            <span class="ob-chip seq">enrol on approve</span>
            <span class="ob-chip seq">step 1 fires immediately</span>
            <div class="actions">
              <button class="ob-btn-sm is-danger" onClick=${() => setRejectOpen((o) => !o)}>Reject</button>
              <button class="ob-btn-sm">⌘ Send to chat</button>
              ${sequence?.raw_status === 'failed' ? html`
                <button
                  class="btn"
                  style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                  disabled=${commitMut.isPending}
                  onClick=${() => undo.arm(sequence.id)}
                >Retry send</button>
              ` : canApprove ? html`
                <button
                  class="btn"
                  style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                  disabled=${commitMut.isPending || undo.isArmed(sequence.id)}
                  onClick=${() => undo.arm(sequence.id)}
                >${commitMut.isPending || undo.isArmed(sequence.id) ? 'Activating…' : 'Approve & activate'}</button>
              ` : html`
                <${StatusChip} rawStatus=${sequence?.raw_status} />
              `}
            </div>
          </div>
        `}
    </div>
  `;
}

function SequencesQueueView({ standalone }) {
  const [selected, setSelected] = useState(null);

  // Sequences awaiting approval — master list (left), step rail (detail, right).
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sequences', 'queue'],
    queryFn: fetchSequenceQueue,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_SEQ_QUEUE : undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading sequence approvals…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No sequence items awaiting approval" />`;

  const rows = data ?? [];
  const sel = selected ?? rows[0];

  return html`
    <div class="sq-md">
      <aside class="sq-master">
        <div class="sq-master-head">In review <span class="ct">${rows.length}</span></div>
        ${rows.map(row => html`
          <div key=${row.id} class=${cn('sq-row', { 'is-on': sel?.id === row.id })} onClick=${() => setSelected(row)}>
            <div class="sq-row-name">
              ${row.name ?? row.slug ?? row.id}
              <span class="sq-row-time">${row.status ?? ''}</span>
            </div>
            ${row.description ? html`<div class="sq-row-desc">${row.description}</div>` : null}
            <div class="sq-row-progress">
              ${Array.from({ length: row.total_steps ?? 1 }).map((_, i) => html`
                <span key=${i} class=${cn('sq-row-step', { 'is-active': i === 0 })}></span>
              `)}
            </div>
            <div class="sq-row-meta">
              ${row.delivery_system ? html`<span class=${cn('ob-chip', `channel-${row.delivery_system}`)}>${row.delivery_system}</span>` : null}
              ${row.segment ? html`<span class="ob-chip seq">${row.segment}</span>` : null}
            </div>
          </div>
        `)}
      </aside>
      ${sel ? html`<${SequenceStepRail} sequence=${sel} standalone=${standalone} />`
        : html`<div class="sq-detail"><${StateDisplay} state="empty" message="Select a sequence to review" /></div>`}
    </div>
  `;
}

// Derive a cohort tile state from a recipient row (design §C colour scale).
function recipientTileState(r) {
  if (r.status === 'bounced') return { cls: 'is-bounced', glyph: '!' };
  if (r.status === 'completed' || (r.current_step != null && r.total_steps != null && r.current_step >= r.total_steps)) return { cls: 'is-done', glyph: '✓' };
  if (r.last_reply_at) return { cls: 'is-replied', glyph: '↩' };
  const step = Number(r.current_step) || 1;
  if (step >= 3) return { cls: 'is-step3', glyph: '3' };
  if (step === 2) return { cls: 'is-step2', glyph: '2' };
  return { cls: 'is-step1', glyph: '1' };
}

// Recipient cohort grid for one running sequence (design §C). Tiles coloured by
// derived step; diagnostic chips above; per-recipient detail on tile click.
function RecipientCohort({ sequenceKey, fallback, standalone }) {
  const [picked, setPicked] = useState(null);
  const { data: recips, isLoading } = useQuery({
    queryKey: ['sequences', 'recipients', sequenceKey],
    queryFn: () => fetchSequenceRecipients(sequenceKey),
    enabled: !standalone && !!sequenceKey,
    placeholderData: standalone ? (fallback ?? FIXTURE_SEQ_RECIPIENTS) : undefined,
  });

  const list = (recips && recips.length ? recips : (standalone ? fallback : [])) ?? [];
  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading cohort…" />`;
  if (!list.length) return html`<${StateDisplay} state="empty" message=${standalone ? "No recipients enrolled" : "Not available yet"} />`;

  // Diagnostic counts.
  const stuck = {};
  let bounces = 0, replies = 0;
  for (const r of list) {
    const st = recipientTileState(r);
    if (st.cls === 'is-bounced') bounces++;
    else if (st.cls === 'is-replied') replies++;
    else if (st.cls.startsWith('is-step')) {
      const k = st.cls.replace('is-step', '');
      stuck[k] = (stuck[k] ?? 0) + 1;
    }
  }
  const topStuck = Object.entries(stuck).sort((a, b) => b[1] - a[1])[0];

  return html`
    <div>
      <div class="rec-diag">
        ${topStuck && topStuck[1] >= 2 ? html`<span class="ob-chip seq chip-warn">${topStuck[1]} on step ${topStuck[0]}</span>` : null}
        ${bounces > 0 ? html`<span class="ob-chip seq chip-danger">${bounces} bounce${bounces > 1 ? 's' : ''} · check list hygiene</span>` : null}
        ${replies > 0 ? html`<span class="ob-chip seq">${replies} repl${replies > 1 ? 'ies' : 'y'} · paused</span>` : null}
      </div>
      <div class="rec-grid">
        ${list.map((r, i) => {
          const st = recipientTileState(r);
          return html`<div key=${r.id ?? i} class=${cn('rec-cell', st.cls)} title=${r.contact_email ?? ''} onClick=${() => setPicked(r)}>${st.glyph}</div>`;
        })}
      </div>
      <div class="rec-legend">
        <span><span class="rec-swatch" style=${{ background: 'color-mix(in srgb, var(--tint-outbox-fg, var(--primary)) 25%, var(--bg-sunken))' }}></span> Step 1</span>
        <span><span class="rec-swatch" style=${{ background: 'color-mix(in srgb, var(--tint-outbox-fg, var(--primary)) 50%, var(--bg-sunken))' }}></span> Step 2</span>
        <span><span class="rec-swatch" style=${{ background: 'color-mix(in srgb, var(--tint-outbox-fg, var(--primary)) 75%, var(--bg-sunken))' }}></span> Step 3</span>
        <span><span class="rec-swatch" style=${{ background: 'var(--live)' }}></span> Completed</span>
        <span><span class="rec-swatch" style=${{ background: 'color-mix(in srgb, var(--agent) 60%, var(--bg-sunken))' }}></span> Replied (paused)</span>
        <span><span class="rec-swatch" style=${{ background: 'color-mix(in srgb, var(--danger) 50%, var(--bg-sunken))' }}></span> Bounced</span>
      </div>
      ${picked ? html`
        <div style=${{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border-faint)' }}>
          <p style=${{ fontSize: '0.75rem', color: 'var(--fg-muted)', margin: 0 }}>
            Recipient <strong style=${{ color: 'var(--fg)' }}>${picked.contact_email ?? '—'}</strong>
            · step <strong style=${{ color: 'var(--fg)' }}>${picked.current_step ?? '—'}/${picked.total_steps ?? '—'}</strong>
            · status <strong style=${{ color: 'var(--fg)' }}>${picked.status ?? '—'}</strong>
            ${picked.last_reply_at ? html` · replied ${picked.last_reply_at}` : ''}
          </p>
        </div>
      ` : null}
    </div>
  `;
}

function SequencesActiveView({ standalone }) {
  // G-11 rule: Sequences "Schedule" tab = "Active" list (per-recipient, not per-campaign)
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sequences', 'active'],
    queryFn: fetchActiveSequences,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_ACTIVE_SEQS : undefined,
  });

  const [selected, setSelected] = useState(null);

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading active sequences…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No active sequences" />`;

  const rows = data ?? (standalone ? FIXTURE_ACTIVE_SEQS : []);
  const sel = selected ?? rows[0];

  return html`
    <div class="nl-split">
      <div class="nl-master" style=${{ gridColumn: '1' }}>
        <div class="ob-seq-list">
          ${rows.map(row => html`
            <div key=${row.id} class=${cn('ob-seq-row', { 'is-on': sel?.id === row.id })} onClick=${() => setSelected(row)}>
              <div>
                <div class="ob-seq-name">${row.sequence_name ?? row.sequence_id}</div>
                <div class="ob-seq-meta">${row.contact_email || row.segment || '—'}</div>
                <div class="ob-seq-meta" style=${{ marginTop: '0.125rem' }}>
                  <span class=${cn('ob-chip', 'seq')}>Step ${row.current_step}/${row.total_steps}</span>
                  ${row.delivery_system ? html`<span class=${cn('ob-chip', `channel-${row.delivery_system}`)} style=${{ marginLeft: '0.25rem' }}>${row.delivery_system}</span>` : null}
                </div>
              </div>
              <div class="ob-seq-stats">
                <div class="ob-seq-step">Next: ${formatDate(row.next_send_date)}</div>
                ${row.sent_count > 0 ? html`<div class="ob-seq-step">${row.sent_count} sent</div>` : null}
              </div>
            </div>
          `)}
        </div>
      </div>
      <div class="nl-detail">
        ${sel ? html`
          <div class="ob-detail-wrap">
            <div class="ob-seq-detail" style=${{ overflow: 'visible', borderBottom: '1px solid var(--border-faint)' }}>
              <h2 style=${{ fontSize: '0.9rem', fontWeight: 600, margin: '0 0 0.5rem', color: 'var(--fg)' }}>
                ${sel.sequence_name ?? sel.sequence_id}
              </h2>
              <p style=${{ fontSize: '0.75rem', color: 'var(--fg-muted)', margin: 0 }}>
                Recipient: <strong style=${{ color: 'var(--fg)' }}>${sel.contact_email || sel.segment || '—'}</strong>
              </p>
              <p style=${{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: '0.375rem' }}>
                Step <strong style=${{ color: 'var(--fg)' }}>${sel.current_step}</strong> of ${sel.total_steps}
                · Next send: <strong style=${{ color: 'var(--fg)' }}>${formatDate(sel.next_send_date)}</strong>
              </p>
              <p style=${{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: '0.375rem' }}>
                Delivered: <strong style=${{ color: 'var(--fg)' }}>${sel.sent_count ?? 0}</strong>
                via <span class=${cn('ob-chip', `channel-${sel.delivery_system}`)} style=${{ display: 'inline-flex' }}>${sel.delivery_system}</span>
              </p>
            </div>
            <div style=${{ flex: 1, overflowY: 'auto' }}>
              <p style=${{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-faint)', padding: '0.75rem 1rem 0', margin: 0 }}>
                Recipient cohort · who is on which step
              </p>
              <${RecipientCohort} sequenceKey=${sel.sequence_id} standalone=${standalone} />
            </div>
          </div>
        ` : html`<${StateDisplay} state="empty" message="Select a sequence to inspect" />`}
      </div>
    </div>
  `;
}

function SequencesSentView({ standalone }) {
  const [selected, setSelected] = useState(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sequences', 'sent'],
    queryFn: fetchSentSequences,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_SENT_SEQS : undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading sent sequences…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No completed sequences yet" />`;

  const rows = data ?? [];
  const sel = selected ?? rows[0];

  // Build a per-cohort funnel from aggregate counts (sent → replied → completed → bounced).
  const funnelRows = (c) => {
    const enrolled = Number(c.enrolled) || 0;
    const pct = (n) => (enrolled ? Math.round((n / enrolled) * 100) : 0);
    const replied = Number(c.replied) || 0;
    const completed = Number(c.completed) || 0;
    const bounced = Number(c.bounced) || 0;
    return [
      { label: 'Enrolled', n: enrolled, pct: 100, cls: '' },
      { label: 'Replied', n: replied, pct: pct(replied), cls: 'is-replied' },
      { label: 'Completed', n: completed, pct: pct(completed), cls: '' },
      { label: 'Bounced', n: bounced, pct: pct(bounced), cls: 'is-bounced' },
    ];
  };

  return html`
    <div class="sq-sent-grid">
      <div class="sq-sent-master">
        <div class="sq-master-head">Completed cohorts <span class="ct">${rows.length}</span></div>
        ${rows.map(row => html`
          <div key=${row.sequence_id} class=${cn('sq-row', { 'is-on': sel?.sequence_id === row.sequence_id })} onClick=${() => setSelected(row)}>
            <div class="sq-row-name">${row.sequence_name ?? row.sequence_slug ?? row.sequence_id}<span class="sq-row-time">${formatDate(row.closed_at)}</span></div>
            <div class="sq-row-meta">
              <span class="ob-chip seq">${row.enrolled} enrolled</span>
              <span class="ob-chip quality high">${row.enrolled ? Math.round((Number(row.replied) / Number(row.enrolled)) * 100) : 0}% reply</span>
            </div>
          </div>
        `)}
      </div>
      <div class="funnel">
        ${sel ? html`
          <h2 style=${{ fontFamily: 'var(--font-display)', fontSize: '16px', margin: '0 0 0.75rem', color: 'var(--fg)' }}>
            ${sel.sequence_name ?? sel.sequence_slug ?? sel.sequence_id}
          </h2>
          <p style=${{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--fg-faint)', margin: '0 0 1rem' }}>
            closed ${formatDate(sel.closed_at)} · ${sel.enrolled} enrolled · ${sel.sent_total ?? 0} sends
          </p>
          ${funnelRows(sel).map((f, i) => html`
            <div key=${i} class="funnel-row">
              <span class="funnel-label">${f.label}</span>
              <div class="funnel-bar"><i class=${f.cls} style=${{ width: `${f.pct}%` }}></i></div>
              <span class="funnel-num">${f.n} / ${sel.enrolled}</span>
              <span class="funnel-pct">${f.pct}%</span>
            </div>
          `)}
        ` : html`<${StateDisplay} state="empty" message="Select a cohort" />`}
      </div>
    </div>
  `;
}

// ─── Social views ───────────────────────────────────────────────────────────────

// MediaCard — the OG image card (1200×627) when media_url is present, else a
// tasteful "no media" empty slot with a URL-attach affordance. Writes via the
// parent-provided onUpdate (→ updateDraft → edited_json). No upload (Phase 2).
function MediaCard({ mediaUrl, onUpdate }) {
  const [attachOpen, setAttachOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const hasMedia = Boolean(mediaUrl);
  return html`
    <div class="ob-social-media">
      <div class="ob-social-media-label">Media</div>
      ${hasMedia ? html`
        <div class="ob-social-media-card">
          <img src=${mediaUrl} alt="Post media" class="ob-social-media-img" />
          <button class="ob-social-media-remove" title="Remove media" aria-label="Remove media" onClick=${() => onUpdate(null)}>×</button>
        </div>
      ` : html`
        <div class="ob-social-media-empty" role="button" tabindex="0"
             onClick=${() => setAttachOpen((o) => !o)}
             onKeyDown=${(e) => { if (e.key === 'Enter') setAttachOpen((o) => !o); }}>
          <span class="ob-social-media-empty-icon" aria-hidden="true">▱</span>
          <span>No media · attach URL</span>
        </div>
      `}
      ${attachOpen ? html`
        <div class="ob-social-media-attach">
          <input class="ob-social-media-url-input" type="url"
            placeholder="https://cdn.example.com/image.jpg (1200×627)"
            value=${urlDraft} onInput=${(e) => setUrlDraft(e.target.value)} />
          <button class="ob-btn-sm is-primary" disabled=${!urlDraft}
            onClick=${() => { onUpdate(urlDraft); setAttachOpen(false); setUrlDraft(''); }}>Attach</button>
          <button class="ob-btn-sm" onClick=${() => setAttachOpen(false)}>Cancel</button>
        </div>
      ` : null}
    </div>
  `;
}

// HashtagEditor — parsed/explicit hashtags as removable pill chips + a "+ add"
// inline input. Local state lifts to the parent (onChange) for live preview, and
// every add/remove writes through onUpdate (→ updateDraft → edited_json).
function HashtagEditor({ hashtags, onChange, onUpdate }) {
  const [inputVal, setInputVal] = useState('');
  const [inputOpen, setInputOpen] = useState(false);
  const inputRef = useRef(null);
  const tags = hashtags || [];

  function removeTag(tag) {
    const next = tags.filter((t) => t !== tag);
    onChange(next);
    onUpdate(next);
  }
  function addTag() {
    const raw = inputVal.trim();
    if (!raw) { setInputOpen(false); return; }
    const tag = raw.startsWith('#') ? raw : '#' + raw;
    if (tags.includes(tag)) { setInputVal(''); setInputOpen(false); return; }
    const next = [...tags, tag];
    onChange(next);
    onUpdate(next);
    setInputVal('');
    setInputOpen(false);
  }
  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    if (e.key === 'Escape') { setInputVal(''); setInputOpen(false); }
  }

  return html`
    <div class="ob-hashtags">
      <div class="ob-hashtags-label">Hashtags</div>
      <div class="ob-hashtags-chips">
        ${tags.map((tag) => html`
          <span key=${tag} class="ob-tag-chip">
            ${tag}
            <button class="ob-tag-chip-remove" aria-label=${'Remove ' + tag} onClick=${() => removeTag(tag)}>×</button>
          </span>
        `)}
        ${inputOpen ? html`
          <input ref=${inputRef} class="ob-tag-chip-input" type="text" placeholder="#tag"
            value=${inputVal} onInput=${(e) => setInputVal(e.target.value)}
            onKeyDown=${handleKeyDown} onBlur=${addTag} autoFocus />
        ` : html`
          <button class="ob-tag-chip ob-tag-chip-add" onClick=${() => setInputOpen(true)}>+ add</button>
        `}
      </div>
    </div>
  `;
}

// Per-platform preview editor (design social §B): base body on the left, stacked
// LinkedIn / X / Bluesky previews on the right with per-platform char caps; fan-out
// rows + reject below. Body, media and hashtags all write back to edited_json via
// updateDraft; body persists on blur AND is flushed before Approve arms, so the
// committed row always carries what the user last saw in the editor.
function SocialEditor({ post, standalone, onApprove, approvePending, onReject, rejectPending, onRetry, rawStatus, commitError, armed, undoSecondsLeft, onCancelUndo }) {
  const canApprove = isApprovable({ raw_status: rawStatus });
  const [body, setBody] = useState(post?.content ?? '');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [localHashtags, setLocalHashtags] = useState(post?.hashtags ?? []);
  const [mediaUpdatePending, setMediaUpdatePending] = useState(false);
  const [hashtagUpdatePending, setHashtagUpdatePending] = useState(false);
  const [bodySaveError, setBodySaveError] = useState(null);
  const soBodyRef = useAutoGrow(body, { minHeight: 180 });

  // Reset local state when the selected post changes.
  useEffect(() => {
    setBody(post?.content ?? '');
    setLocalHashtags(post?.hashtags ?? []);
    setRejectOpen(false);
    setBodySaveError(null);
  }, [post?.id]);

  // Persist body edits through edited_json ({body} override wins in baseRow).
  // Called on textarea blur (fire-and-forget) and awaited before Approve arms —
  // an unsaved edit must never silently lose to the original payload on commit.
  const bodyDirty = body !== (post?.content ?? '');
  async function persistBody() {
    if (standalone || !post?.id || !bodyDirty) return;
    setBodySaveError(null);
    try {
      await updateDraft(post.id, { body });
    } catch (e) {
      const m = String(e?.message ?? e);
      console.error('[outbound] body update failed:', m);
      setBodySaveError(`Body edit not saved: ${m}`);
      throw e;
    }
  }

  // Write media_url / hashtags through edited_json (host.paActions.update).
  // In standalone (fixture) mode there is no host write path — keep it a no-op
  // so the chip editor stays interactive without throwing.
  async function handleMediaUpdate(newUrl) {
    if (standalone || !post?.id) return;
    setMediaUpdatePending(true);
    try { await updateDraft(post.id, { media_url: newUrl }); }
    catch (e) { console.error('[outbound] media update failed:', String(e?.message ?? e)); }
    finally { setMediaUpdatePending(false); }
  }
  async function handleHashtagUpdate(tags) {
    if (standalone || !post?.id) return;
    setHashtagUpdatePending(true);
    try { await updateDraft(post.id, { hashtags: tags }); }
    catch (e) { console.error('[outbound] hashtag update failed:', String(e?.message ?? e)); }
    finally { setHashtagUpdatePending(false); }
  }

  const { data: fanout, isError: fanoutError } = useQuery({
    queryKey: ['social', 'fanout', post?.slug],
    queryFn: () => fetchSocialFanout(post?.slug),
    enabled: !standalone && !!post?.slug,
  });

  const len = body.length;
  const anyBlocked = SOCIAL_PLATFORMS.some((p) => len > p.cap);

  // Fan-out rows: live siblings if present, otherwise the three standard targets.
  const fanRows = (fanout && fanout.length)
    ? fanout.map((r) => ({
        plat: ({ linkedin: 'plat-li', x: 'plat-x', twitter: 'plat-x', bluesky: 'plat-bs', instagram: 'plat-ig' }[r.platform] ?? 'plat-x'),
        label: r.platform,
        blocked: (r.content?.length ?? 0) > (PLATFORM_CAPS[r.platform] ?? 280),
        schedule: r.scheduled_for,
      }))
    : SOCIAL_PLATFORMS.map((p) => ({ plat: p.plat, label: p.sub, blocked: len > p.cap, schedule: post?.scheduled_for }));

  return html`
    <div class="ob-detail-wrap">
      <div class="so-detail-head" style=${{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-faint)' }}>
        <div style=${{ flex: 1, minWidth: 0 }}>
          <div style=${{ display: 'flex', gap: '0.375rem', marginBottom: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            ${post?.source ? html`<span class="ob-chip seq">${post.source}</span>` : null}
            ${SOCIAL_PLATFORMS.map((p) => html`<span key=${p.key} class=${cn('plat', p.plat)}>${p.sub}</span>`)}
          </div>
          <h2 style=${{ fontFamily: 'var(--font-display)', fontSize: '18px', margin: 0, color: 'var(--fg)' }}>
            ${post?.title ?? 'Social post'}
          </h2>
          <p style=${{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--fg-muted)', margin: '0.375rem 0 0' }}>
            scheduled · ${formatDate(post?.scheduled_for)}
          </p>
        </div>
      </div>

      <div class="so-editor">
        <div>
          <div class="so-editor-pane-label"><span>Editor · base body</span></div>
          <textarea ref=${soBodyRef} class="so-text" value=${body} onInput=${(e) => setBody(e.target.value)} onBlur=${() => persistBody().catch(() => {})} style=${{ overflow: 'hidden', resize: 'none' }}></textarea>
          <div class="char-rows">
            ${SOCIAL_PLATFORMS.map((p) => {
              const over = len - p.cap;
              return html`
                <div key=${p.key} class="char-row">
                  <span class="clabel">${p.sub} ${len} / ${p.cap}${over > 0 ? html`<span class="over">+${over}</span>` : ''}</span>
                  <div class=${cn('char-bar', charBarClass(len, p.cap))}><i style=${{ width: `${Math.min(100, (len / p.cap) * 100)}%` }}></i></div>
                </div>
              `;
            })}
          </div>
          <${MediaCard} mediaUrl=${post?.media_url} onUpdate=${handleMediaUpdate} />
          <${HashtagEditor} hashtags=${localHashtags} onChange=${setLocalHashtags} onUpdate=${handleHashtagUpdate} />
        </div>

        <div>
          <div class="so-editor-pane-label"><span>Live previews</span><span class="ob-chip seq" style=${{ marginLeft: 'auto' }}>scroll to compare</span></div>
          ${SOCIAL_PLATFORMS.map((p) => {
            const over = len > p.cap;
            return html`
              <div key=${p.key} class="pv-card">
                <div class="pv-head">
                  <div class="pv-avatar"></div>
                  <div class="pv-handle"><b>${p.handle}</b><span>· ${p.sub}</span></div>
                  <span class=${cn('plat', p.plat)} style=${{ marginLeft: 'auto' }}>${p.mark}</span>
                </div>
                ${over ? html`
                  <div class="pv-body is-blocked">⚠ Over ${p.cap}-char cap by ${len - p.cap}. Add an alt-body for ${p.sub}, or split into a thread.</div>
                  <div class="pv-stats"><span style=${{ color: 'var(--danger)' }}>cannot post until resolved</span></div>
                ` : html`
                  <div class="pv-body">${body}${localHashtags.length ? html`<span class="pv-tags"> ${localHashtags.join(' ')}</span>` : null}</div>
                  <div class="pv-stats"><span>♡ 0</span><span>↻ 0</span></div>
                `}
              </div>
            `;
          })}
        </div>
      </div>

      <div class="so-fanout">
        <div class="so-fanout-head">Per-platform fan-out · ${fanoutError ? '—' : `${fanRows.length} row${fanRows.length === 1 ? '' : 's'}`}</div>
        ${fanoutError ? html`
          <div class="so-fanout-error" style=${{ padding: '1.25rem', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
            <span title="Can't read this project's queue here">Can't read this project's queue here.</span>
          </div>
        ` : html`
          <table class="so-fanout-table">
            <thead><tr><th>Platform</th><th>Status</th><th>Schedule</th></tr></thead>
            <tbody>
              ${fanRows.map((r, i) => html`
                <tr key=${i}>
                  <td><span class=${cn('plat', r.plat)}>${r.label}</span></td>
                  <td>${r.blocked ? html`<span class="chip-warn-sm">blocked · over cap</span>` : html`<span class="chip-ok-sm">ready</span>`}</td>
                  <td class="meta">${r.blocked ? '—' : formatDate(r.schedule)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      </div>

      ${rejectOpen ? html`
        <${RejectPanel}
          canned=${SOCIAL_REJECT_REASONS}
          pending=${rejectPending}
          placeholder="Optional · why? (feeds the cmo-agent training set)"
          onCancel=${() => setRejectOpen(false)}
          onConfirm=${(reason) => onReject(reason)}
        />
      ` : null}

      <${CommitError} message=${commitError || bodySaveError} />
      ${canApprove ? html`
        <${ConsequenceLine}
          recipient=${post?.account || 'social accounts'}
          channel=${'LinkedIn · X · Bluesky'}
          scheduled=${post?.scheduled_for}
        />
      ` : null}
      <div class="ob-actions">
        <div class="ob-actions-primary">
          ${rawStatus === 'failed' ? html`
            <button
              class="btn"
              style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
              disabled=${approvePending}
              onClick=${() => onRetry()}
            >Retry send</button>
          ` : canApprove ? html`
            <button
              class="btn"
              style=${anyBlocked ? { opacity: 0.55, cursor: 'not-allowed' } : { background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
              disabled=${anyBlocked || approvePending}
              title=${anyBlocked ? 'Resolve over-cap platforms first' : 'Approve & schedule'}
              onClick=${async () => {
                if (anyBlocked) return;
                // Flush any unsaved body edit BEFORE arming the undo countdown; if
                // the save fails, do NOT arm — approving would ship stale content.
                try { await persistBody(); } catch { return; }
                onApprove();
              }}
            >
              ${approvePending ? 'Scheduling…' : 'Approve & Schedule'}
            </button>
          ` : html`
            <${StatusChip} rawStatus=${rawStatus} />
          `}
          <button class="btn btn-ghost is-danger" onClick=${() => setRejectOpen((o) => !o)}>Reject…</button>
        </div>
      </div>
      <${FloatingUndoBar} armed=${armed} secondsLeft=${undoSecondsLeft} onCancel=${onCancelUndo} subject=${post?.title ?? post?.content} label="Scheduling" />
      <div class="ob-actions-secondary">
        <button
          class="ob-btn-sm"
          onClick=${() => hostSendToActiveSession(`Help me edit this social post before approval.\n\nPlatforms: LinkedIn · X · Bluesky\n\n${body}`).catch(() => {})}
        >⌘ Send to chat</button>
        ${anyBlocked ? html`<span class="chip-warn-sm" style=${{ marginLeft: '0.5rem' }}>1+ platform over cap</span>` : null}
      </div>
    </div>
  `;
}

function SocialQueueView({ standalone }) {
  const [selected, setSelected] = useState(null);
  const [commitError, setCommitError] = useState(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['social', 'queue'],
    queryFn: fetchSocialQueue,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_SOCIAL_QUEUE : undefined,
  });

  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['social'] }); qc.invalidateQueries({ queryKey: ['counts'] }); };
  const commitMut = useMutation({
    mutationFn: ({ id }) => approveDraft(id),
    onSuccess: () => { setCommitError(null); invalidate(); },
    onError: (e) => { const m = String(e?.message ?? e); console.error('[outbound] commit refused:', m); setCommitError(m); },
  });
  const undo = useUndoCommit((id) => { setCommitError(null); commitMut.mutate({ id }); });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }) => rejectDraft(id, reason),
    onSuccess: invalidate,
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading social queue…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No social posts awaiting approval" />`;

  const rows = data ?? [];

  // Collapse fan-out siblings (same batch_id / slug) into one display row carrying
  // a platforms[] array. Rows with no slug are singletons. The first sibling is the
  // representative (_batchRows[0]) handed to the detail editor.
  const batchMap = new Map();
  const displayRows = [];
  for (const row of rows) {
    if (row.slug) {
      if (batchMap.has(row.slug)) {
        batchMap.get(row.slug).platforms.push(row.platform);
      } else {
        const dr = { ...row, platforms: [row.platform], _batchRows: [row] };
        batchMap.set(row.slug, dr);
        displayRows.push(dr);
      }
    } else {
      displayRows.push({ ...row, platforms: [row.platform], _batchRows: [row] });
    }
  }
  // Sort platform badge order within each display row: li → x → bs → ig → fb.
  for (const dr of displayRows) {
    dr.platforms.sort((a, b) => {
      const ai = SOCIAL_PLAT_ORDER.indexOf(a);
      const bi = SOCIAL_PLAT_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }
  // Group into fixed-order sections (omit empties).
  const groupedRows = SOCIAL_GROUP_ORDER.map((key) => ({
    key,
    label: SOURCE_GROUP_LABEL[key],
    rows: displayRows.filter((r) => (r.source_group ?? 'manual') === key),
  })).filter((g) => g.rows.length > 0);

  // Selection: `sel` is a REAL mapSocialQueue row (the representative), not the
  // synthetic display row. Default to the first display row's representative.
  const sel = selected ?? displayRows[0]?._batchRows[0];
  const isArmed = sel ? undo.isArmed(sel.id) : false;
  const armedRow = undo.armed ? rows.find((r) => r.id === undo.armed) : null;

  return html`
    <${FloatingUndoBar} armed=${undo.armed} secondsLeft=${undo.secondsLeft} onCancel=${undo.cancel} subject=${armedRow?.title ?? armedRow?.content ?? sel?.title} label="Scheduling" />
    <div class="nl-split">
      <div class="nl-master">
        ${groupedRows.map((group) => html`
          <div key=${group.key}>
            <div class="nl-master-group-head">${group.label} · ${group.rows.length}</div>
            ${group.rows.map((row) => {
              const isOn = sel?.id === row.id;
              const platformCount = row.platforms.length;
              const blogSlugChip = row.blog_slug
                ? html`<span class="ob-chip">blog · /${row.blog_slug}</span>`
                : (row.source_group === 'blog' ? html`<span class="ob-chip">blog</span>` : null);
              const platformsChip = platformCount >= 2
                ? html`<span class="ob-chip chip-tint">${platformCount} platform${platformCount > 2 ? 's' : ''}</span>`
                : null;
              const agentChip = row.drafted_by && row.drafted_by !== 'pa'
                ? html`<span class="ob-chip">cmo-agent · ${row.drafted_by}</span>`
                : null;
              const threadChip = row.thread_index != null && row.thread_total != null
                ? html`<span class="ob-chip">thread · ${row.thread_index} of ${row.thread_total}</span>`
                : null;
              const toneChip = row.tone_check
                ? html`<span class="ob-chip ob-chip-warn">tone check</span>`
                : null;
              return html`
                <div key=${row.id} class=${cn('so-q-row nl-row', { 'is-on': isOn })} onClick=${() => setSelected(row._batchRows[0])}>
                  <div class="so-q-row-head">
                    ${row.platforms.map((p) => html`<${PlatPill} key=${p} platform=${p} />`)}
                    <span class="so-q-row-time">${relativeTime(row.scheduled_for)}</span>
                  </div>
                  <div class="so-q-row-text">"${(row.content ?? '').substring(0, 100)}${(row.content?.length ?? 0) > 100 ? '…' : ''}"</div>
                  <div class="so-q-row-foot">
                    ${blogSlugChip}
                    ${platformsChip}
                    ${agentChip}
                    ${threadChip}
                    ${toneChip}
                  </div>
                </div>
              `;
            })}
          </div>
        `)}
      </div>
      <div class="nl-detail">
        ${sel ? html`
          <${SocialEditor}
            post=${sel}
            standalone=${standalone}
            onApprove=${() => undo.arm(sel.id)}
            approvePending=${commitMut.isPending || isArmed}
            onReject=${(reason) => rejectMut.mutate({ id: sel.id, reason })}
            rejectPending=${rejectMut.isPending}
            onRetry=${() => undo.arm(sel.id)}
            rawStatus=${sel.raw_status}
            commitError=${commitError}
            armed=${isArmed}
            undoSecondsLeft=${undo.secondsLeft}
            onCancelUndo=${undo.cancel}
          />
        ` : html`<${StateDisplay} state="empty" message="Select a post to review" />`}
      </div>
    </div>
  `;
}

function SocialScheduleView({ standalone }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['social', 'schedule'],
    queryFn: fetchSocialSchedule,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_SOCIAL_SCHEDULE : undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading social schedule…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No scheduled social posts" />`;

  const rows = data ?? (standalone ? FIXTURE_SOCIAL_SCHEDULE : []);

  return html`
    <${TwoWeekCalendar}
      items=${rows}
      renderPill=${(item, k) => html`
        <span key=${item.id ?? k} class="nl-cal-pill" title=${item.content}>
          <${PlatformBadge} platform=${item.platform} />
          ${(item.content ?? '').substring(0, 24)}${(item.content?.length ?? 0) > 24 ? '…' : ''}
        </span>
      `}
    />
  `;
}

function SocialSentView({ standalone }) {
  // WP-17 item 3: the Charts button was inert (no state). Wire it.
  const [sentView, setSentView] = useState('table');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['social', 'sent'],
    queryFn: fetchSocialSent,
    enabled: !standalone,
    placeholderData: standalone ? FIXTURE_SOCIAL_SENT : undefined,
  });

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading sent posts…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;
  if (!data?.length) return html`<${StateDisplay} state="empty" message="No sent social posts" />`;

  const rows = data ?? (standalone ? FIXTURE_SOCIAL_SENT : []);

  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div class="nl-sent-toolbar">
        <span style=${{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>${rows.length} sent posts</span>
        <div class="nl-view-toggle" style=${{ marginLeft: 'auto' }}>
          <button class=${cn({ 'is-on': sentView === 'table' })} onClick=${() => setSentView('table')}>Table</button>
          <button class=${cn({ 'is-on': sentView === 'charts' })} onClick=${() => setSentView('charts')}>Charts</button>
        </div>
      </div>
      <div class="nl-sent-body" style=${{ overflow: 'auto' }}>
        ${sentView === 'table' ? html`
          <table class="nl-sent-table">
            <thead><tr>
              <th>Platform</th><th>Content</th><th>Posted</th><th>Source</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => html`
                <tr key=${r.id}>
                  <td><${PlatformBadge} platform=${r.platform} /></td>
                  <td style=${{ maxWidth: '280px' }}>${r.content?.substring(0, 60)}${r.content?.length > 60 ? '…' : ''}</td>
                  <td class="meta">${formatDate(r.posted_at)}</td>
                  <td class="meta">${r.source ?? '—'}</td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`
          <div style=${{ padding: '0.75rem 1rem' }}>
            <${SentLineChart} rows=${rows} title="Posts published" dateField="posted_at" extraLegends=${['Impressions', 'Engagements']} />
            <p class="ri-cell-sub" style=${{ marginTop: '0.5rem' }}>
              Per-post reach / engagement isn't captured on the send log yet (Phase 2) — the chart plots real post volume; those series show em-dash.
            </p>
          </div>
        `}
      </div>
    </div>
  `;
}

// ─── Cross-channel Approvals view (the folded approve-gate, WP-07) ──────────────
// Mirrors the shell approve-gate: every awaiting/edited/committed/failed row
// ACROSS ALL channels, each tagged with its derived content type, with the same
// approve/reject/retry/edit + 10s undo actions. Single source: pa_action_drafts.

const CT_LABEL = { email: 'Email', newsletter: 'Newsletter', social: 'Social', sequences: 'Sequence' };

// Standalone fixture for CrossChannelApprovalsView — mixed-channel rows at the
// mapApprovalRow output shape (same field contract). One row per channel covers
// the four filter pills; the `edited` row proves the edited-status branch; the
// `quality` field on the email row is a forward-compat exemplar for verdict-cells
// (ItemQuality — see derive.js typedef at §G-QUALITY). Live mode never uses this.
export const FIXTURE_APPROVALS = [
  // ── Email (smtp) — awaiting, carries ItemQuality for verdict-cells WP ──────────
  {
    id: 'ap-em-1',
    ct: 'email',
    ct_label: 'Email',
    status: 'awaiting',
    raw_status: 'awaiting',
    channel: 'smtp',
    subject: 'Re: Royalti onboarding · file processing delay',
    body: 'Hi,\n\nThanks for flagging this. The delay you saw was caused by a schema mismatch on the ingestion side — we patched it in 0.7.4 and the backfill ran clean this morning.\n\nYour tenant (id 590) should now show all statements. Let me know if anything looks off.\n\nBest,\nRuby',
    recipient: 'valentim@soundlabel.pt',
    drafted_by: 'pa',
    scheduled_for: null,
    error_text: null,
    attempts: 0,
    batch_id: null,
    // ItemQuality exemplar (G-QUALITY / derive.js typedef). The Approvals view
    // does not render quality cells yet — this data is forward-compat for WP-12+.
    quality: {
      claims: [
        { text: 'patched in 0.7.4', source: 'https://royalti.io/changelog/0.7.4', verdict: 'verified' },
        { text: 'backfill ran clean this morning', source: null, verdict: 'unsourced' },
      ],
      tone: { verdict: 'on-voice', basis: 'Direct, no hype terms, first-person Ruby voice.', model: 'claude-sonnet-4-5' },
      verified_at: '2026-06-10T09:15:00.000Z',
      verifier: 'draft-time',
    },
  },
  // ── Newsletter (listmonk) — awaiting ─────────────────────────────────────────
  {
    id: 'ap-nl-1',
    ct: 'newsletter',
    ct_label: 'Newsletter',
    status: 'awaiting',
    raw_status: 'awaiting',
    channel: 'listmonk',
    subject: 'You can deliver from Royalti now',
    body: 'Royalti now ships a full delivery pipeline.\n\nYou can send DDEX ERN4 messages directly from your workspace to DSPs that accept DDEX — no third-party aggregator account required for the initial batch.',
    recipient: '2104 subscribers',
    drafted_by: 'cmo',
    scheduled_for: 'Today 10:00',
    error_text: null,
    attempts: 0,
    batch_id: 'nl-deliver-batch-1',
  },
  // ── Social (buffer) — awaiting, carries media_url + hashtags ─────────────────
  {
    id: 'ap-so-1',
    ct: 'social',
    ct_label: 'Social',
    status: 'awaiting',
    raw_status: 'awaiting',
    channel: 'buffer',
    subject: 'Royalty calculator overhaul · launch post',
    body: 'The royalty calculator overhaul shipped this week. Statements ingest in ~90s for a 30k-row CSV, and splits recompute live as you edit. #royalti #musicbusiness',
    recipient: 'LinkedIn · X · Bluesky',
    drafted_by: 'pa',
    scheduled_for: '2026-06-10 12:48',
    error_text: null,
    attempts: 0,
    batch_id: 'blog-01',
    // Social-specific extras (not in mapApprovalRow today but carried so the
    // approvals detail can render them once the Approvals view grows them in).
    media_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=1200&h=627&fit=crop',
    hashtags: ['#royalti', '#musicbusiness', '#labels'],
  },
  // ── Sequence (resend) — awaiting ─────────────────────────────────────────────
  {
    id: 'ap-sq-1',
    ct: 'sequences',
    ct_label: 'Sequence',
    status: 'awaiting',
    raw_status: 'awaiting',
    channel: 'resend',
    subject: 'Cold A&R outreach · distributor-q3',
    body: 'Cold outbound to 14 distributor leads sourced from Q1 trade-show contacts. 4 steps over 21 days.',
    recipient: 'distributor-leads-q1',
    drafted_by: 'vp-sales-agent',
    scheduled_for: null,
    error_text: null,
    attempts: 0,
    batch_id: 'distributor-q3',
  },
  // ── Email (smtp) — edited status (proves the edited branch in the action footer)
  {
    id: 'ap-em-2',
    ct: 'email',
    ct_label: 'Email',
    status: 'edited',
    raw_status: 'edited',
    channel: 'smtp',
    subject: 'Following up on the Royalti deck · step 2 [edited]',
    body: 'Hi [first name],\n\nWanted to circle back on the deck I sent last week — if you had a chance to look, happy to walk you through the ingestion demo on a 15-minute call.\n\nAlternatively I can send a Loom if async is easier. Just say the word.\n\nBest,\nChinedum',
    recipient: 'ar@universalmusic.pt',
    drafted_by: 'pa',
    scheduled_for: 'Mon 09:00',
    error_text: null,
    attempts: 1,
    batch_id: null,
  },
];

// One row → a unified approval-row view-model (channel-agnostic).
function mapApprovalRow(row) {
  const { item, meta, edited } = parseDraft(row);
  const ct = deriveContentType(item);
  return {
    id: row.id,
    ct,
    ct_label: CT_LABEL[ct] ?? ct,
    status: row.status, // raw lifecycle status (awaiting/edited/committed/sending/failed)
    raw_status: row.status, // alias matching the per-channel mappers (C-2 gate)
    channel: row.channel ?? item.channel ?? null, // provider
    subject: edited.subject ?? item.subject ?? '(no subject)',
    body: edited.body ?? item.body ?? '',
    recipient: item.recipient ?? item.recipientEmail ?? null,
    drafted_by: String(meta.agent || 'pa').toLowerCase(),
    scheduled_for: item.scheduledLabel || row.scheduled_at || null,
    error_text: row.error_text || null,
    attempts: row.attempts ?? 0,
    batch_id: row.batch_id || null,
  };
}

// All in-flight approval rows across every channel (newest first).
export async function fetchAllApprovals() {
  if (isStandalone()) return FIXTURE_APPROVALS;
  const rows = await loadDrafts(QUEUE_STATUSES);
  return (rows || []).map(mapApprovalRow);
}

const APPROVAL_REJECT_REASONS = ['Wrong recipient', 'Tone is off', 'Misses context', 'Already handled', "Don't send · close out"];

function CrossChannelApprovalsView({ standalone }) {
  const [selected, setSelected] = useState(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [commitError, setCommitError] = useState(null);
  const [ctFilter, setCtFilter] = useState('all'); // all | email | newsletter | social | sequences
  const [checked, setChecked] = useState(() => new Set()); // WP-17 item 8: bulk-select ids
  // Keyboard J/K prev-next nav (design atelier-approve-gate.html). A ref holds the
  // live nav closure so the listener (attached once) never goes stale, and the
  // effect sits with the other hooks (rules-of-hooks) before the early returns.
  const navRef = useRef(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['approvals', 'all'],
    queryFn: fetchAllApprovals,
    enabled: !standalone,
    refetchInterval: 30_000,
    placeholderData: standalone ? FIXTURE_APPROVALS : undefined,
  });

  const qc = useQueryClient();
  // Invalidate EVERY channel + counts so any view downstream repaints.
  const invalidate = () => {
    for (const k of ['approvals', 'email', 'newsletter', 'sequences', 'social', 'counts']) {
      qc.invalidateQueries({ queryKey: [k] });
    }
  };
  const commitMut = useMutation({
    mutationFn: ({ id }) => approveDraft(id),
    onSuccess: () => { setCommitError(null); invalidate(); },
    onError: (e) => { const m = String(e?.message ?? e); console.error('[outbound] commit refused:', m); setCommitError(m); },
  });
  const undo = useUndoCommit((id) => { setCommitError(null); commitMut.mutate({ id }); });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }) => rejectDraft(id, reason),
    onSuccess: () => { setRejectOpen(false); invalidate(); },
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });
  const retryMut = useMutation({ mutationFn: ({ id }) => retryDraft(id), onSuccess: invalidate, onError: (e) => setCommitError(String(e?.message ?? e)) });
  const editMut = useMutation({
    mutationFn: ({ id, patch }) => updateDraft(id, patch),
    onSuccess: () => { setEditOpen(false); invalidate(); },
    onError: (e) => setCommitError(String(e?.message ?? e)),
  });

  // J/K (and ↑/↓) move the detail selection through the current filtered list.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = navRef.current;
      if (!st || !st.rows.length) return;
      const idx = Math.max(0, st.rows.findIndex((r) => r.id === st.selId));
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        st.pick(st.rows[Math.min(st.rows.length - 1, idx + 1)]);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        st.pick(st.rows[Math.max(0, idx - 1)]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (isLoading) return html`<${StateDisplay} state="loading" message="Loading approvals…" />`;
  if (isError) return html`<${QueueReadErrorState} onRetry=${refetch} />`;

  const all = data ?? [];
  const rows = ctFilter === 'all' ? all : all.filter((r) => r.ct === ctFilter);
  if (!all.length) return html`<${StateDisplay} state="empty" message="Nothing awaiting approval across any channel" />`;

  const sel = (selected && rows.find((r) => r.id === selected.id)) ?? rows[0] ?? null;
  const isFailed = sel?.raw_status === 'failed';
  const canApprove = isApprovable(sel);
  const armedRow = undo.armed ? all.find((r) => r.id === undo.armed) : null;
  const pick = (row) => { setSelected(row); setRejectOpen(false); setEditOpen(false); };
  // Keep the keyboard-nav closure fresh every render.
  navRef.current = { rows, selId: sel?.id, pick };

  // Detail nav position ("N of M").
  const navIdx = sel ? rows.findIndex((r) => r.id === sel.id) : -1;

  // ── Bulk-select (WP-17 item 8) ─────────────────────────────────────────────
  const toggleCheck = (id) => setChecked((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const clearChecked = () => setChecked(new Set());
  const checkedApprovable = rows.filter((r) => checked.has(r.id) && isApprovable(r));
  const checkedRows = rows.filter((r) => checked.has(r.id));
  const bulkApprove = () => {
    // Same per-id commit path as a single approve (no undo window for a batch).
    for (const r of checkedApprovable) commitMut.mutate({ id: r.id });
    clearChecked();
  };
  const bulkReject = () => {
    for (const r of checkedRows) rejectMut.mutate({ id: r.id, reason: 'Bulk rejected' });
    clearChecked();
  };

  // ── Date sectioning (design atelier-approve-gate.html) ─────────────────────
  const nowD = new Date();
  const wkStart = startOfWeekMon(nowD);
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkStart.getDate() + 7);
  const approvalSection = (row) => {
    const d = parseScheduled(row.scheduled_for);
    if (!d) return 'unscheduled';
    if (d < nowD && (row.raw_status === 'awaiting' || row.raw_status === 'edited')) return 'overdue';
    if (sameDay(d, nowD)) return 'today';
    if (d >= wkStart && d < wkEnd) return 'week';
    return 'later';
  };
  const SECTION_ORDER = [
    ['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'],
    ['later', 'Later'], ['unscheduled', 'No schedule'],
  ];

  // Per-content-type counts for the filter strip.
  const ctCounts = all.reduce((acc, r) => { acc[r.ct] = (acc[r.ct] ?? 0) + 1; return acc; }, {});

  const sendToChat = () => {
    if (!sel) return;
    hostSendToActiveSession(
      `Help me review this outbound ${sel.ct_label} before I approve it.\n\nSubject: ${sel.subject}\nTo: ${sel.recipient ?? 'segment'}\nDrafted by: ${sel.drafted_by ?? 'agent'}`,
    ).catch(() => {});
  };

  return html`
    <${FloatingUndoBar} armed=${undo.armed} secondsLeft=${undo.secondsLeft} onCancel=${undo.cancel} subject=${armedRow?.subject ?? sel?.subject} />
    <div style=${{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div class="nl-sent-toolbar">
        <button class=${cn('ob-filter-chip', { 'is-on': ctFilter === 'all' })} onClick=${() => setCtFilter('all')}>All · ${all.length}</button>
        ${CHANNELS.map((ct) => html`
          <button
            key=${ct}
            class=${cn('ob-filter-chip', { 'is-on': ctFilter === ct })}
            onClick=${() => setCtFilter(ct)}
          >${CT_LABEL[ct]}${ctCounts[ct] ? ` · ${ctCounts[ct]}` : ''}</button>
        `)}
      </div>
      ${checked.size > 0 ? html`
        <div style=${{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border-faint)', background: 'var(--bg-alt, transparent)' }}>
          <strong style=${{ fontSize: '0.8125rem' }}>${checked.size} selected</strong>
          <span style=${{ flex: 1 }}></span>
          <button class="ob-btn-sm is-primary" type="button" disabled=${!checkedApprovable.length || commitMut.isPending} onClick=${bulkApprove}>
            Approve ${checkedApprovable.length || ''}
          </button>
          <button class="ob-btn-sm is-danger" type="button" disabled=${rejectMut.isPending} onClick=${bulkReject}>Reject</button>
          <button class="ob-btn-sm" type="button" onClick=${clearChecked}>Clear</button>
        </div>
      ` : null}
      <div class="nl-split" style=${{ flex: 1, minHeight: 0 }}>
        <div class="nl-master">
          ${rows.length ? SECTION_ORDER.map(([key, label]) => {
            const secRows = rows.filter((r) => approvalSection(r) === key);
            if (!secRows.length) return null;
            return html`
              <div key=${key}>
                <div class="nl-master-group-head">${label} · ${secRows.length}</div>
                ${secRows.map(row => html`
                  <div
                    key=${row.id}
                    class=${cn('nl-row', { 'is-on': sel?.id === row.id })}
                    onClick=${() => pick(row)}
                    style=${{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}
                  >
                    <input
                      type="checkbox"
                      checked=${checked.has(row.id)}
                      onClick=${(e) => e.stopPropagation()}
                      onChange=${() => toggleCheck(row.id)}
                      style=${{ marginTop: '3px', cursor: 'pointer' }}
                      aria-label=${'Select ' + row.subject}
                    />
                    <div style=${{ flex: 1, minWidth: 0 }}>
                      <div class="nl-row-head">
                        <span class="ob-chip seq">${row.ct_label}</span>
                        ${row.channel ? html`<${ChannelChip} channel=${row.channel} />` : null}
                        ${row.status === 'failed' ? html`<span class="ob-chip overdue">failed</span>` : null}
                      </div>
                      <div class="nl-row-subj">${row.subject}</div>
                      <div class="nl-row-pre">${row.recipient || '—'} · ${row.drafted_by}</div>
                    </div>
                  </div>
                `)}
              </div>
            `;
          }) : html`<${StateDisplay} state="empty" message="No items for this filter" />`}
        </div>
        <div class="nl-detail">
          ${sel ? html`
            <div class="ob-detail-wrap">
              <div class="ip-head">
                <div class="ip-meta-row" style=${{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <span class="ob-chip seq">${sel.ct_label}</span>
                  ${sel.channel ? html`<${ChannelChip} channel=${sel.channel} />` : null}
                  <span style=${{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>${sel.recipient || '—'}</span>
                  <!-- WP-17 item 8: prev/next detail nav (N of M · J/K keys) -->
                  <span style=${{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <button class="ob-btn-sm" type="button" title="Previous (K)" disabled=${navIdx <= 0}
                      onClick=${() => navIdx > 0 && pick(rows[navIdx - 1])}>↑</button>
                    <span class="ob-act-meta" style=${{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>${navIdx + 1} of ${rows.length}</span>
                    <button class="ob-btn-sm" type="button" title="Next (J)" disabled=${navIdx >= rows.length - 1}
                      onClick=${() => navIdx < rows.length - 1 && pick(rows[navIdx + 1])}>↓</button>
                  </span>
                </div>
                <h2 style=${{ fontSize: '0.9rem', fontWeight: 600, margin: '0.5rem 0 0', color: 'var(--fg)' }}>${sel.subject}</h2>
              </div>

              <div class="ip-body" style=${{ flex: 1, padding: '1rem', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
                ${sel.body ? html`
                  <p style=${{ margin: 0, color: 'var(--fg)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>${sel.body}</p>
                ` : html`<p style=${{ margin: 0 }}>(no body)</p>`}
                <p style=${{ marginTop: '1rem', color: 'var(--fg-muted)' }}>
                  Drafted by <strong style=${{ color: 'var(--fg)' }}>${sel.drafted_by ?? 'agent'}</strong>
                  ${sel.scheduled_for ? html` · scheduled <strong style=${{ color: 'var(--fg)' }}>${sel.scheduled_for}</strong>` : ''}
                </p>
              </div>

              ${sel.error_text ? html`
                <div class="ob-chip overdue" style=${{ display: 'inline-flex', margin: '0 1rem' }}>
                  Last attempt failed · ${sel.error_text}
                </div>
              ` : null}

              ${editOpen ? html`
                <${EditPanel}
                  subject=${sel.subject}
                  body=${sel.body}
                  pending=${editMut.isPending}
                  onCancel=${() => setEditOpen(false)}
                  onSave=${(patch) => editMut.mutate({ id: sel.id, patch })}
                />
              ` : null}

              ${rejectOpen ? html`
                <${RejectPanel}
                  canned=${APPROVAL_REJECT_REASONS}
                  pending=${rejectMut.isPending}
                  placeholder="Optional · why? (feeds the writer-agent training set)"
                  onCancel=${() => setRejectOpen(false)}
                  onConfirm=${(reason) => rejectMut.mutate({ id: sel.id, reason })}
                />
              ` : null}

              <${CommitError} message=${commitError} />
              ${canApprove ? html`
                <${ConsequenceLine}
                  recipient=${sel.recipient}
                  channel=${sel.channel ?? sel.ct_label}
                  scheduled=${sel.scheduled_for}
                />
              ` : null}
              <div class="ob-actions">
                <div class="ob-actions-primary">
                  ${isFailed ? html`
                    <button
                      class="btn"
                      style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                      onClick=${() => retryMut.mutate({ id: sel.id })}
                      disabled=${retryMut.isPending}
                    >${retryMut.isPending ? 'Retrying…' : 'Retry send'}</button>
                  ` : canApprove ? html`
                    <button
                      class="btn"
                      style=${{ background: 'var(--tint-outbox-bg, var(--bg-alt))', color: 'var(--tint-outbox-fg, var(--fg))' }}
                      onClick=${() => undo.arm(sel.id)}
                      disabled=${commitMut.isPending || undo.isArmed(sel.id)}
                    >${commitMut.isPending || undo.isArmed(sel.id) ? 'Sending…' : 'Approve & schedule'}</button>
                  ` : html`
                    <${StatusChip} rawStatus=${sel.raw_status} />
                  `}
                  <button class="btn btn-ghost" onClick=${() => setEditOpen((o) => !o)}>Edit</button>
                  <button class="btn btn-ghost is-danger" onClick=${() => setRejectOpen((o) => !o)}>Reject</button>
                </div>
              </div>
              <div class="ob-actions-secondary">
                <button class="ob-btn-sm" onClick=${sendToChat}>⌘ Send to chat</button>
                <span class="ob-act-spacer"></span>
                <span class="ob-act-meta">${sel.status}${sel.attempts ? ` · ${sel.attempts} attempt${sel.attempts === 1 ? '' : 's'}` : ''}</span>
              </div>
            </div>
          ` : html`<${StateDisplay} state="empty" message="Select an item to review" />`}
        </div>
      </div>
    </div>
  `;
}

// ─── View dispatcher ────────────────────────────────────────────────────────────

function ViewBody({ channel, view, standalone }) {
  // Cross-channel Approvals is a top-level view independent of channel.
  if (view === 'approvals') return html`<${CrossChannelApprovalsView} standalone=${standalone} />`;
  if (channel === 'email') {
    if (view === 'queue') return html`<${EmailQueueView} standalone=${standalone} />`;
    if (view === 'schedule') return html`<${EmailScheduleView} standalone=${standalone} />`;
    if (view === 'sent') return html`<${EmailSentView} standalone=${standalone} />`;
  }
  if (channel === 'newsletter') {
    if (view === 'queue') return html`<${NewsletterQueueView} standalone=${standalone} />`;
    if (view === 'schedule') return html`<${NewsletterScheduleView} standalone=${standalone} />`;
    if (view === 'sent') return html`<${NewsletterSentView} standalone=${standalone} />`;
  }
  if (channel === 'sequences') {
    if (view === 'queue') return html`<${SequencesQueueView} standalone=${standalone} />`;
    if (view === 'schedule') return html`<${SequencesActiveView} standalone=${standalone} />`; // G-11
    if (view === 'sent') return html`<${SequencesSentView} standalone=${standalone} />`;
  }
  if (channel === 'social') {
    if (view === 'queue') return html`<${SocialQueueView} standalone=${standalone} />`;
    if (view === 'schedule') return html`<${SocialScheduleView} standalone=${standalone} />`;
    if (view === 'sent') return html`<${SocialSentView} standalone=${standalone} />`;
  }
  return html`<${StateDisplay} state="empty" message="Unknown view" />`;
}

// ─── Main OutboundView ──────────────────────────────────────────────────────────

export function OutboundView({ activeFeature }) {
  // Initialise channel + view from the deep-link target (pre-seeded activeFeature
  // 'v:<view>' OR the mounted sub-route pathname) directly (lazy init) so the
  // first paint already reflects the deep-link / sidebar selection — closes the
  // mount race where the useEffect relay below lands a frame after the initial
  // render (F-01, WP-07).
  const initial = parseInitialTarget(activeFeature);
  const [channel, setChannel] = useState(() => initial?.channel ?? 'newsletter');
  const [view, setView] = useState(() => initial?.view ?? 'queue');
  const standalone = isStandalone();
  const isApprovals = view === 'approvals';

  // Channel counts query (for sidebar badges)
  const { data: counts, isError: countsError } = useQuery({
    queryKey: ['counts'],
    queryFn: fetchChannelCounts,
    enabled: !standalone,
    refetchInterval: 30_000,
    placeholderData: standalone ? { email: 5, newsletter: 2, sequences: 4, social: 4 } : undefined,
  });

  // Agent counts for the active channel
  const { data: agents, isError: agentsError } = useQuery({
    queryKey: ['agents', channel],
    queryFn: () => fetchAgentCounts(channel),
    enabled: !standalone,
    placeholderData: standalone ? { pa: 4, cmo: 5, cbo: 2 } : undefined,
  });

  // Totals for the in-pane ob-header meta line. The design (F-14) also wanted a
  // sidebar mode line, but host.pkg.setMenu only accepts an items array — there
  // is no statusLine field. Decision (2026-06-07 review, E.10): DROP the sidebar
  // mode line rather than extend the shell setMenu contract; these same totals
  // are surfaced in-pane below (ob-header .meta), so no information is lost.
  const totalAwaiting = countsError ? '—' : ((counts?.email ?? 0) + (counts?.newsletter ?? 0) + (counts?.social ?? 0));
  const activeSeqCount = countsError ? '—' : (counts?.sequences ?? 0);

  // Publish menu whenever channel/view/counts/agents change
  useEffect(() => {
    const items = buildOutboundMenu(channel, view, counts ?? {}, agents ?? {}, countsError, agentsError);
    setMenu(items).catch(() => {/* standalone — ignore */});
  }, [channel, view, counts, agents, countsError, agentsError]);

  // ── activeFeature → channel switching (side-menu item clicks) ──────────────
  // The shell relays sidebar clicks via the host-context re-emit
  // (royaltiSuite.activeFeature) — the same wire tasks/mail/sales use. The
  // original "pkg-menu-click" window-message listener here referenced a relay
  // that never existed (wave-2 live-verify finding: channel switching dead).
  useEffect(() => {
    if (!activeFeature) return;
    // Sidebar channel clicks → 'ch:<channel>' (Channels group).
    if (activeFeature.startsWith('ch:')) {
      const newChannel = activeFeature.slice(3);
      if (CHANNELS.includes(newChannel)) {
        setChannel(newChannel);
        setView('queue'); // reset to queue on channel switch
      }
      return;
    }
    // Deep-link re-emits → 'v:<view>' ('v:approvals' = cross-channel gate;
    // 'v:<channel>' = that channel's queue).
    if (activeFeature.startsWith('v:')) {
      const target = viewFromToken(activeFeature.slice(2));
      if (target) {
        setChannel(target.channel);
        setView(target.view);
      }
      return;
    }
    // Filter clicks (f:pa/f:cmo/f:cbo) — no state change needed in pkg
    // (the shell menu already handles the is-on visual)
  }, [activeFeature]);

  // Dim by-agent group when view is not 'queue' — JS class approach
  useEffect(() => {
    publishIykeState('outbound.view', view);
  }, [view]);

  const meta = CHANNEL_META[channel];

  return html`
    <div class="frame" style=${{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      <!-- Frame header -->
      <div class="frame-head">
        <span class="frame-title-mark" style=${{ color: 'var(--tint-outbox-fg, var(--fg-muted))' }}>
          <${Icon} name="send" size=${14} />
        </span>
        <span class="frame-title">Outbox</span>
      </div>

      <!-- Channel header — design atelier-outbound.html: h1 = [outbox] Outbox · <Channel> -->
      <div class="ob-header">
        <h1 style=${{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style=${{ display: 'inline-flex', color: 'var(--tint-outbox-fg, var(--tint-fg-active, var(--fg)))' }}>
            <${Icon} name=${isApprovals ? 'check-circle' : 'send'} size=${16} />
          </span>
          <span>${isApprovals ? 'Outbox · Approvals' : `Outbox · ${meta.label}`}</span>
        </h1>
        <p class="sub">${isApprovals ? 'Cross-channel approve-gate · every channel' : meta.subtitle}</p>
        <p class="meta" title=${countsError ? "Can't read this project's queue here" : undefined}>${totalAwaiting} awaiting · ${activeSeqCount} sequences active</p>
      </div>

      <!-- Inner-tab strip: Approvals (cross-channel) + per-channel Approval queue / Schedule / Sent -->
      <div class="nl-inner-tabs">
        <button
          key="approvals"
          class=${cn({ 'is-on': isApprovals })}
          onClick=${() => setView('approvals')}
        >
          Approvals
          ${countsError ? html`<span class="nl-tab-count" title="Can't read this project's queue here">—</span>` : (totalAwaiting + activeSeqCount > 0 ? html`<span class="nl-tab-count">${totalAwaiting + activeSeqCount}</span>` : null)}
        </button>
        ${meta.views.map(v => {
          const label = meta.viewLabels[v];
          const cnt = v === 'queue' ? (countsError ? '—' : (counts?.[channel] ?? 0)) : 0;
          return html`
            <button
              key=${v}
              class=${cn({ 'is-on': !isApprovals && view === v })}
              onClick=${() => setView(v)}
            >
              ${label}
              ${v === 'queue' && (countsError || cnt > 0) ? html`<span class="nl-tab-count" title=${countsError ? "Can't read this project's queue here" : undefined}>${countsError ? '—' : cnt}</span>` : null}
            </button>
          `;
        })}
      </div>

      <!-- View body -->
      <div class="frame-body-flush" style=${{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <${ViewBody} channel=${channel} view=${view} standalone=${standalone} />
      </div>

    </div>
  `;
}

export function isPermissionRefusal(error) {
  if (!error) return false;
  if (error.reason === 'scope-denied') return true;
  const msg = String(error.message || error);
  return (
    /scope-denied/i.test(msg) ||
    /pkg lacks the ['"]sqlite['"] capability/i.test(msg) ||
    /not in the pkg's declared sqlite\.tables/i.test(msg)
  );
}

export function queryRetry(failureCount, error) {
  if (isPermissionRefusal(error)) return false;
  return failureCount < 1;
}

export {
  EmailQueueView,
  EmailScheduleView,
  EmailSentView,
  NewsletterQueueView,
  NewsletterScheduleView,
  NewsletterSentView,
  SequencesQueueView,
  SequencesActiveView,
  SequencesSentView,
  SocialQueueView,
  SocialScheduleView,
  SocialSentView,
  CrossChannelApprovalsView,
  ViewBody,
  SocialEditor,
  SocialEditor as SocialDetail,
  SequenceStepRail,
  RecipientCohort,
  fetchNewsletterHistory,
  fetchSocialFanout,
  buildOutboundMenu,
};

