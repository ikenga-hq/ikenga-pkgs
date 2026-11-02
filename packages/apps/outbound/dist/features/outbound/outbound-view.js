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
  useCallback,
  useQuery,
} from '../../lib/ui.js';
import {
  hostDbQuery,
  hostFetch,
  setMenu,
  isStandalone,
  publishIykeState,
} from '../../lib/bridge.js';
import { InboxView, InboxScheduleList, RejectedList, useInbox } from '../inbox/inbox-view.js';
import { buildInbox, facetCounts } from '../../lib/inbox-model.js';
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
  claimsVerdictCell,
  toneVerdictCell,
} from '../../lib/derive.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

// Top-level surfaces (outbox redesign D-02): ONE triage inbox; Schedule + Sent
// stay as siblings, sliced per channel there.
const TABS = [
  ['inbox', 'Inbox'],
  ['schedule', 'Schedule'],
  ['sent', 'Sent'],
];
const CHANNELS = ['email', 'newsletter', 'social', 'sequences'];
const CHANNEL_LABEL = { email: 'Email', newsletter: 'Newsletter', social: 'Social', sequences: 'Sequences' };
// Inbox kind facet ↔ channel token (deep links + sidebar use channel names).
const KIND_OF_CHANNEL = { email: 'email', newsletter: 'newsletter', social: 'social', sequences: 'sequence' };

// ─── Deep-link + sidebar target resolution ─────────────────────────────────────
// The shell deep-links /outbox/{approvals,email,newsletter,social,sequences,sent}
// into this pkg and pre-seeds activeFeature as 'v:<token>'; sidebar clicks arrive
// as 'v:<tab>' | 'ch:<channel>' | 'f:<agent>'. The mounted sub-route pathname is
// the fallback. Every token resolves to { tab, preset? } where preset is an inbox
// facet patch.
export function resolveTarget(token) {
  if (typeof token !== 'string' || !token) return null;
  const [kind, val] = token.includes(':') ? token.split(/:(.*)/s) : ['v', token];
  if (kind === 'f' && val) return { tab: 'inbox', preset: { agents: [val.toLowerCase()], kinds: [] } };
  if (kind === 'ch' || kind === 'v') {
    if (val === 'inbox' || val === 'approvals' || val === '' || val === 'queue') return { tab: 'inbox', preset: { kinds: [], agents: [] } };
    if (val === 'schedule' || val === 'sent') return { tab: val };
    if (CHANNELS.includes(val)) return { tab: 'inbox', preset: { kinds: [KIND_OF_CHANNEL[val]], agents: [] }, channel: val };
  }
  return null;
}

function initialTarget(activeFeature) {
  const r = resolveTarget(activeFeature);
  if (r) return r;
  try {
    const segs = (window.location?.pathname || '').split('/').filter(Boolean);
    return resolveTarget(segs[segs.length - 1]);
  } catch {
    return null;
  }
}

// ─── Sidebar menu (host.pkg.setMenu) ───────────────────────────────────────────
export function buildOutboundMenu(tab, counts, preset, countsError = false) {
  const badge = (n) => (countsError ? '—' : n > 0 ? n : undefined);
  const kinds = preset?.kinds ?? [];
  const agents = preset?.agents ?? [];
  const plain = tab === 'inbox' && !kinds.length && !agents.length;
  const items = [
    { id: 'v:inbox', label: 'Inbox', icon: 'inbox', section: 'Outbox', active: plain, hot: !countsError && (counts?.total ?? 0) > 0, badge: badge(counts?.total ?? 0) },
    { id: 'v:schedule', label: 'Schedule', icon: 'calendar', section: 'Outbox', active: tab === 'schedule' },
    { id: 'v:sent', label: 'Sent', icon: 'send', section: 'Outbox', active: tab === 'sent' },
  ];
  for (const ch of CHANNELS) {
    const k = KIND_OF_CHANNEL[ch];
    items.push({ id: `ch:${ch}`, label: CHANNEL_LABEL[ch], icon: { email: 'mail', newsletter: 'book-open', social: 'share2', sequences: 'git-branch' }[ch], section: 'Channels',
      active: tab === 'inbox' && kinds.length === 1 && kinds[0] === k, badge: badge(counts?.kinds?.[k] ?? 0) });
  }
  for (const a of Object.keys(counts?.agents ?? { pa: 0, cmo: 0, cbo: 0 })) {
    items.push({ id: `f:${a}`, label: a.toUpperCase(), section: 'Drafted by', active: tab === 'inbox' && agents.length === 1 && agents[0] === a, badge: badge(counts?.agents?.[a] ?? 0) });
  }
  return items;
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

function PlatformBadge({ platform }) {
  const label = platform ?? '—';
  return html`<span class=${cn('ob-platform-badge', platform)}>${label}</span>`;
}

function formatPct(v) {
  if (v == null) return '—';
  return (Number(v) * 100).toFixed(0) + '%';
}

function formatDate(v) {
  if (!v) return '—';
  return String(v);
}

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

// ─── Main OutboundView — Inbox · Schedule · Sent ──────────────────────────────

const SCHEDULE_VIEWS = [['all', 'All'], ['email', 'Email'], ['newsletter', 'Newsletter'], ['social', 'Social'], ['sequences', 'Sequences']];
const SENT_VIEWS = [['email', 'Email'], ['newsletter', 'Newsletter'], ['social', 'Social'], ['sequences', 'Sequences'], ['rejected', 'Rejected']];

function ScheduleBody({ sub, standalone, onOpen }) {
  if (sub === 'email') return html`<${EmailScheduleView} standalone=${standalone} />`;
  if (sub === 'newsletter') return html`<${NewsletterScheduleView} standalone=${standalone} />`;
  if (sub === 'social') return html`<${SocialScheduleView} standalone=${standalone} />`;
  if (sub === 'sequences') return html`<${SequencesActiveView} standalone=${standalone} />`;
  return html`<${InboxScheduleList} standalone=${standalone} onOpen=${onOpen} />`;
}

function SentBody({ sub, standalone }) {
  if (sub === 'newsletter') return html`<${NewsletterSentView} standalone=${standalone} />`;
  if (sub === 'social') return html`<${SocialSentView} standalone=${standalone} />`;
  if (sub === 'sequences') return html`<${SequencesSentView} standalone=${standalone} />`;
  if (sub === 'rejected') return html`<${RejectedList} standalone=${standalone} />`;
  return html`<${EmailSentView} standalone=${standalone} />`;
}

export function OutboundView({ activeFeature }) {
  const standalone = isStandalone();
  const init = initialTarget(activeFeature);
  const [tab, setTab] = useState(() => init?.tab ?? 'inbox');
  const [preset, setPreset] = useState(() => init?.preset ?? null);
  const [scheduleSub, setScheduleSub] = useState('all');
  const [sentSub, setSentSub] = useState(() => init?.channel ?? 'email');
  const [select, setSelect] = useState(null);
  // Same query key as the inbox itself → one request feeds tab badge + sidebar.
  const { data: inboxData, isError: countsError } = useInbox(standalone);
  const counts = useMemo(() => (inboxData ? facetCounts(buildInbox(inboxData.rows ?? [])) : null), [inboxData]);

  // Sidebar clicks / deep-link re-emits (royaltiSuite.activeFeature).
  useEffect(() => {
    const r = resolveTarget(activeFeature);
    if (!r) return;
    setTab(r.tab);
    if (r.preset) setPreset({ ...r.preset });
    if (r.tab === 'sent' && r.channel) setSentSub(r.channel);
  }, [activeFeature]);

  useEffect(() => {
    setMenu(buildOutboundMenu(tab, counts, preset, countsError)).catch(() => { /* standalone */ });
  }, [tab, counts, preset, countsError]);
  useEffect(() => { publishIykeState('outbound.view', tab); }, [tab]);

  const openInInbox = useCallback((id) => { setSelect(id); setPreset({ kinds: [], agents: [] }); setTab('inbox'); }, []);
  const awaiting = counts ? counts.total - (counts.statuses?.queued ?? 0) - (counts.statuses?.sending ?? 0) : null;

  return html`
    <div class="frame ibx-frame">
      <div class="frame-head ibx-frame-head">
        <span class="frame-title-mark" style=${{ color: 'var(--tint-outbox-fg, var(--fg-muted))' }}><${Icon} name="send" size=${14} /></span>
        <span class="frame-title">Outbox</span>
        <nav class="ibx-tabs" role="tablist" aria-label="Outbox views">
          ${TABS.map(([k, label]) => html`
            <button key=${k} role="tab" type="button" aria-selected=${tab === k} class=${cn('ibx-tab', { 'is-on': tab === k })} onClick=${() => setTab(k)}>
              ${label}${k !== 'inbox' ? null : countsError ? html`<span class="ibx-count" title="Can't read this project's queue here">—</span>` : awaiting ? html`<span class="ibx-count">${awaiting}</span>` : null}
            </button>`)}
        </nav>
        <span class="ibx-spacer"></span>
        ${counts?.statuses?.failed ? html`<button type="button" class="ibx-pill is-bad" onClick=${() => { setPreset({ statuses: ['failed'], kinds: [], agents: [] }); setTab('inbox'); }}>${counts.statuses.failed} failed</button>` : null}
        ${counts?.statuses?.overdue ? html`<button type="button" class="ibx-pill is-warn" onClick=${() => { setPreset({ statuses: ['overdue'], kinds: [], agents: [] }); setTab('inbox'); }}>${counts.statuses.overdue} overdue</button>` : null}
      </div>
      ${tab !== 'inbox' ? html`
        <div class="ibx-subtabs" role="tablist">
          ${(tab === 'schedule' ? SCHEDULE_VIEWS : SENT_VIEWS).map(([k, l]) => {
            const on = (tab === 'schedule' ? scheduleSub : sentSub) === k;
            return html`<button key=${k} type="button" role="tab" aria-selected=${on} class=${cn('ibx-facet', { 'is-on': on })}
              onClick=${() => (tab === 'schedule' ? setScheduleSub(k) : setSentSub(k))}>${l}</button>`;
          })}
        </div>` : null}
      <div class="frame-body-flush ibx-frame-body">
        ${tab === 'inbox' ? html`<${InboxView} standalone=${standalone} facetPreset=${preset} initialSelect=${select} />`
          : tab === 'schedule' ? html`<${ScheduleBody} sub=${scheduleSub} standalone=${standalone} onOpen=${openInInbox} />`
          : html`<${SentBody} sub=${sentSub} standalone=${standalone} />`}
      </div>
    </div>
  `;
}

export {
  EmailScheduleView,
  EmailSentView,
  NewsletterScheduleView,
  NewsletterSentView,
  SequencesActiveView,
  SequencesSentView,
  SocialScheduleView,
  SocialSentView,
  RecipientCohort,
  ReplyIntelligence,
  NewsletterBodyPane,
  StateDisplay,
  TwoWeekCalendar,
  emailQualityCells,
  newsletterQualityCells,
  fetchNewsletterHistory,
  FIXTURE_NL_HISTORY,
};
