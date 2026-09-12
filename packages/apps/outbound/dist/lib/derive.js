// derive.js — the single-source adapter: pa_action_drafts → per-channel view-models.
//
// The outbound pkg reads ONE table — `pa_action_drafts` (the approve-gate +
// mutation-worker seam) — and DERIVES the four content-type surfaces from it.
// `channel` is the PROVIDER (smtp|resend|listmonk|buffer); `payload_json` is
// `{ item: DraftItem, meta: ApproveGateMeta }`; `batch_id` groups a campaign /
// sequence run / social fan-out. These pure functions map a row onto the exact
// field shapes the renderers already consume (see the FIXTURE_* shapes in
// outbound-view.js — that is the contract this module satisfies).
//
// Pure + dependency-free → unit-testable under plain Node (see derive.test.mjs).
// Plan: plans/outbound-pkg/01-plan.md §Schema · G-DERIVE.

export const DRAFT_CHANNELS = ['smtp', 'resend', 'listmonk', 'buffer'];

// Status buckets over pa_action_drafts.status (free-text, code-enforced):
//   awaiting → edited? → committed → sending → sent | failed | rejected
export const QUEUE_STATUSES = ['awaiting', 'edited', 'committed', 'sending', 'failed'];
// Sent = successfully-sent history only. `failed` rows live in the QUEUE (for
// retry, matching the approve-gate model), not in the Sent table.
export const SENT_STATUSES = ['sent'];
export const SCHEDULE_STATUSES = ['committed', 'awaiting', 'edited'];

/**
 * Draft-time quality verdict stamped onto a parked DraftItem by the producing
 * agent (G-QUALITY, outbound-pkg WP-12 / D-10). Lives at `item.quality` inside
 * `pa_action_drafts.payload_json` → `{ item, meta }`. New-drafts-only — backlog
 * rows have no `quality` and render an honest '—' (the UI's coarse tone
 * heuristic is retired; cells show a stamped verdict or '—', never a soft guess).
 *
 * @typedef {Object} QualityClaim
 * @property {string}      text     One factual claim sentence from the draft body.
 * @property {string|null} source   The URL/source checked, or null when none was reachable.
 * @property {'verified'|'failed'|'unsourced'} verdict
 *           'verified'  — claim checked against a reachable source and confirmed.
 *           'failed'    — source contradicts the claim; body must be corrected
 *                         BEFORE parking, then re-verified (a parked 'failed'
 *                         should not survive — correct + re-verify first).
 *           'unsourced' — no reachable source; never silently treated as verified.
 *
 * @typedef {Object} QualityTone
 * @property {'on-voice'|'off-voice'} verdict  Self-assessed voice/tone match.
 * @property {string} basis   One-line rationale for the tone verdict.
 * @property {string} model   The model id that drafted + self-assessed.
 *
 * @typedef {Object} ItemQuality
 * @property {QualityClaim[]} claims      Per-claim verdicts; [] when the draft has zero factual claims.
 * @property {QualityTone}    tone        Voice/tone self-assessment.
 * @property {string}         verified_at ISO-8601 timestamp of the draft-time check.
 * @property {'draft-time'}   verifier    Provenance — always 'draft-time' for the producer-stamped path.
 */

// ── Content-type derive (G-DERIVE) ───────────────────────────────────────────
// `kind` wins (producer/backfill stamp); else the heuristic chain. The one
// unresolvable case (newsletter vs email via resend/smtp without `kind`) falls
// to 'email' — see 03 §F3.
export function deriveContentType(item) {
  if (!item) return 'email';
  // Only honour `kind` when it is one of the four valid stamps; an unknown/typo
  // kind falls through to the heuristic chain rather than returning a bogus type.
  if (item.kind && ['email', 'newsletter', 'social', 'sequence'].includes(item.kind))
    return item.kind === 'sequence' ? 'sequences' : item.kind;
  if (item.channel === 'buffer') return 'social';
  if (item.sequence != null) return 'sequences';
  if (item.channel === 'listmonk') return 'newsletter';
  return 'email';
}

// ── Row parsing ──────────────────────────────────────────────────────────────
// Tolerant: bad JSON → {}, bare-item payloads (harness rows) accepted, edited_json
// overrides merged. Returns { item, meta, edited }.
export function parseDraft(row) {
  let payload = {};
  try {
    payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json || {};
  } catch {
    payload = {};
  }
  const item = (payload && payload.item) || payload || {};
  const meta = (payload && payload.meta) || {};
  let edited = {};
  if (row.edited_json) {
    try {
      edited = typeof row.edited_json === 'string' ? JSON.parse(row.edited_json) : row.edited_json;
    } catch {
      edited = {};
    }
  }
  return { item: item || {}, meta: meta || {}, edited: edited || {} };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// SQLite UTC 'YYYY-MM-DD HH:MM:SS' (or ISO) → epoch ms (or NaN).
function toEpoch(s) {
  if (!s) return NaN;
  const str = String(s).trim();
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  return Date.parse(str.includes('T') ? str : str.replace(' ', 'T') + (hasTz ? '' : 'Z'));
}

function isPast(s) {
  const t = toEpoch(s);
  return Number.isFinite(t) && t < Date.now();
}

function agentOf(meta) {
  const a = String(meta && meta.agent ? meta.agent : 'pa').toLowerCase();
  return a || 'pa';
}

// Buffer DraftItems carry the platform inside `recipient` ("LinkedIn · …").
// Best-effort parse for the social Platform column (fan-out is Phase 2).
function platformOf(item) {
  // Fast-path: the backfill stamps item.platform on every social row.
  if (item.platform) return item.platform;
  const r = `${item.recipient || ''} ${item.fromProvider || ''}`.toLowerCase();
  if (r.includes('linkedin') || /\bli\b/.test(r)) return 'linkedin';
  if (r.includes('bluesky') || r.includes('bsky') || /\bbs\b/.test(r)) return 'bluesky';
  // Return 'x' (the design key), not 'twitter'; broadened to catch '· x' / bare x.
  if (r.includes('twitter') || r.includes('· x') || /\bx\b/.test(r)) return 'x';
  if (r.includes('instagram') || /\big\b/.test(r)) return 'instagram';
  return 'linkedin';
}

// Social source-group: maps (item, meta) → one of four canonical group keys
// ('blog' | 'ai' | 'manual' | 'reply') for the social-queue master grouping.
// Pure + tolerant — undefined args degrade to the 'manual' fallback.
// Priority chain — first match wins:
//   1. item.sourceGroup — explicit stamp by the producer (highest trust).
//   2. meta.agentClass === 'blog-announce'      → 'blog'
//   3. item.blogSlug present (non-empty string)  → 'blog'
//   4. meta.agent present && !== 'pa' (named)    → 'ai'
//   5. item.via === 'manual' || meta.manual      → 'manual'
//   6. item.replyTo (thread reply context)       → 'reply'
//   7. fallback                                  → 'manual'
export function socialSourceGroup(item, meta) {
  const it = item || {};
  const m = meta || {};
  if (it.sourceGroup) return it.sourceGroup;
  if (m.agentClass === 'blog-announce') return 'blog';
  if (it.blogSlug) return 'blog';
  if (m.agent && String(m.agent).toLowerCase() !== 'pa') return 'ai';
  if (it.via === 'manual' || m.manual) return 'manual';
  if (it.replyTo) return 'reply';
  return 'manual';
}

// Hashtags for a social DraftItem: ordered, deduped array of '#'-prefixed strings.
// Precedence: item.hashtags[] (explicit, agent-stamped) > parse /#\w+/g from body.
// Pure + tolerant — non-array hashtags / missing body → []; entries are
// normalised to carry a leading '#'.
export function deriveHashtags(item) {
  const it = item || {};
  if (Array.isArray(it.hashtags) && it.hashtags.length > 0) {
    return it.hashtags.map((t) => (String(t).startsWith('#') ? String(t) : '#' + String(t)));
  }
  const body = String(it.body || it.subject || '');
  const found = body.match(/#\w+/g);
  if (!found) return [];
  // Dedup preserving first-occurrence order.
  return [...new Set(found)];
}

// Platforms set for a social DraftItem: ordered fan-out target list.
// Precedence: item.platforms[] (explicit fan-out) > single platformOf(item).
// Pure + tolerant — non-array / empty platforms → [platformOf(item)].
export function socialPlatforms(item) {
  const it = item || {};
  if (Array.isArray(it.platforms) && it.platforms.length > 0) {
    return it.platforms.slice();
  }
  return [platformOf(it)];
}

// pa_action_drafts.status (+ delivery_status + scheduled_at) → the per-channel
// DESIGN status vocab the renderers chip on. Channel-aware only where the design
// diverges (social uses 'posted'; newsletter groups on cooling/pending/approved).
export function designStatus(row, ct) {
  const s = row.status;
  if (s === 'sent') {
    const d = row.delivery_status;
    if (d === 'bounced' || d === 'complained') return d;
    if (ct === 'social') return 'posted';
    return d === 'delivered' ? 'delivered' : 'sent';
  }
  if (s === 'failed') return 'failed';
  if (s === 'rejected') return 'rejected';
  if (s === 'sending') return 'sending';
  if (s === 'committed') return ct === 'social' ? 'approved' : 'approved';
  if (s === 'edited') return ct === 'newsletter' ? 'pending' : 'edited';
  // awaiting
  if (ct !== 'social' && isPast(row.scheduled_at)) return 'overdue';
  return ct === 'newsletter' ? 'pending' : 'pending';
}

// ── Per-view mappers (produce the FIXTURE_* field shapes) ─────────────────────

// Shared queue/sent base for email + newsletter + social.
function baseRow(row) {
  const { item, meta, edited } = parseDraft(row);
  const ct = deriveContentType(item);
  return {
    item,
    meta,
    edited, // exposed for emailGroup inference (edited "Re:" subject override)
    ct,
    subject: edited.subject ?? item.subject ?? '(no subject)',
    body: edited.body ?? item.body ?? '',
    channel: row.channel ?? item.channel ?? null, // provider
    drafted_by: agentOf(meta),
    scheduled_for: item.scheduledLabel || row.scheduled_at || null,
    sent_at: row.sent_at || null,
    delivery_status: row.delivery_status || null,
    attempts: row.attempts ?? 0,
    error_text: row.error_text || null,
    external_id: row.external_id || null,
  };
}

export function mapEmailQueue(row) {
  const b = baseRow(row);

  // emailGroup: grouping signal for the master list (master grouping spec 01).
  // Sequence test wins over reply test — a sequence follow-up with a "Re:"
  // subject must stay in the SEQUENCE STEP group (sequence context wins).
  let emailGroup;
  if (b.item.sequence != null) {
    emailGroup = 'sequence';
  } else if (
    b.item.kind === 'reply' ||
    b.item.in_reply_to ||
    /^re:/i.test(b.item.subject ?? '') ||
    /^re:/i.test(b.edited?.subject ?? '')
  ) {
    emailGroup = 'reply';
  } else {
    emailGroup = 'manual';
  }

  const seq = b.item.sequence || {};

  return {
    id: row.id,
    subject: b.subject,
    body: b.body,
    recipient_name: b.item.recipient ?? null,
    recipient_email: b.item.recipientEmail ?? null,
    channel: b.channel,
    status: designStatus(row, b.ct),
    raw_status: row.status, // pa_action_drafts lifecycle (awaiting/edited/committed/sending/failed)
    ux_mode: 'approve',
    drafted_by: b.drafted_by,
    sequence_id: seq.name ?? null,
    sequence_step: seq.step ?? null,
    sequence_total: seq.total ?? null,
    emailGroup,
    tenant_id: b.item.tenantId ?? null,
    topic_tag: b.item.topic ?? b.meta.topic ?? null,
    scheduled_for: b.scheduled_for,
    is_overdue: b.ct !== 'social' && isPast(row.scheduled_at) && row.status === 'awaiting' ? 1 : 0,
    src: 'pa', // WP-04 rewires approve/reject through host.paActions* (Strategy B)
    delivery_status: b.delivery_status,
    error_text: b.error_text,
    quality: b.item.quality ?? null, // ItemQuality | null — from payload_json.item.quality (G-QUALITY)
  };
}

export function mapEmailSent(row) {
  const b = baseRow(row);
  return {
    id: row.id,
    subject: b.subject,
    recipient_email: b.item.recipientEmail ?? b.item.recipient ?? null,
    channel: b.channel,
    delivery_system: b.channel,
    status: designStatus(row, b.ct),
    sent_at: b.sent_at,
    delivery_status: b.delivery_status,
    attempts: b.attempts,
    open_rate: null, // engagement metrics are Phase 2 (not on pa_action_drafts)
    click_rate: null,
  };
}

export function mapNewsletterQueue(row) {
  const b = baseRow(row);
  // Operator inline edits round-trip through edited_json (WP-17): subject + body
  // are read by baseRow; subject_b / preheader are read here so a saved edit
  // reflects in the view after refetch (parity with the social body-persist path).
  const subject_b = b.edited.subject_b ?? b.item.subject_b ?? null;
  const preheader = b.edited.preheader ?? b.item.preheader ?? null;
  // Investor-update discriminator (WP-17, item 4). No stamped column exists, so
  // derive honestly: explicit item.newsletterType wins, else a meta.actionName /
  // subject heuristic. Consumed by the NewsletterQueueView investor-variant branch.
  const nlType = deriveNewsletterType(b.item, b.meta, b.subject);
  return {
    id: row.id,
    subject: b.subject,
    subject_b, // A/B alt subject (edited_json override wins)
    preheader, // edited_json override wins
    from_line: b.item.fromLine ?? b.item.from_line ?? b.meta.fromLine ?? null,
    newsletter_type: nlType, // 'newsletter' | 'investor_update' (derived, honest)
    draft_slug: b.item.section ?? null,
    edition: null,
    status: designStatus(row, b.ct),
    raw_status: row.status, // pa_action_drafts lifecycle (awaiting/edited/committed/sending/failed)
    cooling_until: null, // cooling is Phase 2
    quality_score: null, // scorecard is Phase 2
    recipient_count: b.item.recipients ?? b.item.sequence?.recipients ?? null,
    delivery_system: nlType === 'investor_update' ? (b.channel ?? 'resend') : b.channel,
    drafted_by: b.drafted_by,
    has_ab: subject_b ? 1 : 0,
    body: b.body,
    quality: b.item.quality ?? null, // ItemQuality | null — from payload_json.item.quality (G-QUALITY)
  };
}

// Honest investor-update discriminator. No column stamps this today, so:
//   1. explicit item.newsletterType / item.type wins (producer stamp);
//   2. else meta.actionName mentioning "investor";
//   3. else the subject reading like an investor update.
// Anything else → 'newsletter'. Kept pure so it's unit-testable in derive.test.mjs.
export function deriveNewsletterType(item, meta, subject) {
  const it = item || {};
  const m = meta || {};
  const explicit = String(it.newsletterType ?? it.type ?? '').toLowerCase();
  if (explicit === 'investor_update' || explicit === 'investor') return 'investor_update';
  const action = String(m.actionName ?? '').toLowerCase();
  if (action.includes('investor')) return 'investor_update';
  if (/\binvestor(s)?\s+update\b/i.test(String(subject ?? ''))) return 'investor_update';
  return 'newsletter';
}

export function mapNewsletterSent(row) {
  const b = baseRow(row);
  return {
    id: row.id,
    draft_slug: b.item.section ?? null,
    edition: null,
    subject: b.subject,
    delivery_system: b.channel,
    newsletter_type: deriveNewsletterType(b.item, b.meta, b.subject), // 'newsletter' | 'investor_update'
    status: designStatus(row, b.ct),
    sent_at: b.sent_at,
    delivery_status: b.delivery_status,
    recipient_count: b.item.recipients ?? null,
    open_rate: null,
    click_rate: null,
  };
}

export function mapSocialQueue(row) {
  const b = baseRow(row);
  return {
    id: row.id,
    platform: platformOf(b.item),
    account: b.item.senderAddress || b.item.fromProvider || 'Buffer',
    content: b.body || b.subject,
    status: designStatus(row, b.ct),
    raw_status: row.status, // pa_action_drafts lifecycle (awaiting/edited/committed/sending/failed)
    scheduled_for: b.scheduled_for,
    approved_at: row.committed_at || null,
    source: b.meta.actionName || null,
    slug: row.batch_id || null, // batch_id is the fan-out group key
    title: b.subject,
    // Grouping signal for the social master list (spec 04).
    source_group: socialSourceGroup(b.item, b.meta),
    blog_slug: b.item.blogSlug || null,
    // Media + hashtags + fan-out platforms (spec 03 / 04). edited_json overrides
    // win (WP-17 round-trip parity with newsletter): media_url surfaces
    // edited.media_url then item.media_url; hashtags derives from the edited
    // item when the operator has touched hashtags (so a cleared [] doesn't fall
    // back to item.hashtags) else falls back to a /#\w+/ body parse; platforms
    // defaults to [platformOf(item)] when no explicit list.
    media_url: b.edited.media_url ?? b.item.media_url ?? null,
    hashtags: deriveHashtags(b.edited.hashtags !== undefined ? b.edited : b.item),
    platforms: socialPlatforms(b.item),
    thread: b.item.thread ?? null,
  };
}

export function mapSocialSent(row) {
  const b = baseRow(row);
  return {
    id: row.id,
    platform: platformOf(b.item),
    account: b.item.senderAddress || b.item.fromProvider || 'Buffer',
    content: b.body || b.subject,
    status: designStatus(row, b.ct),
    scheduled_for: b.scheduled_for,
    posted_at: b.sent_at,
    delivery_status: b.delivery_status,
    source: b.meta.actionName || null,
    slug: row.batch_id || null,
    // Media + hashtags + fan-out platforms — edited_json overrides win (parity
    // with mapSocialQueue / WP-17 round-trip).
    media_url: b.edited.media_url ?? b.item.media_url ?? null,
    hashtags: deriveHashtags(b.edited.hashtags !== undefined ? b.edited : b.item),
    platforms: socialPlatforms(b.item),
  };
}

// Sequences: a flat list of sequence-step sends, grouped by sequence name.
// The rich cohort grid + funnel (per-recipient state) is Phase 2 — these mappers
// produce the def/queue/sent shapes from the same rows.
export function mapSequenceQueue(row) {
  const b = baseRow(row);
  const seq = b.item.sequence || {};
  return {
    id: row.id,
    name: seq.name || b.subject,
    slug: row.batch_id || null,
    description: b.subject,
    segment: b.item.recipient || null,
    total_steps: seq.total ?? null,
    delivery_system: b.channel,
    status: designStatus(row, b.ct),
    raw_status: row.status, // pa_action_drafts lifecycle (awaiting/edited/committed/sending/failed)
    created_by: b.drafted_by,
    created_at: row.created_at || null,
  };
}

export function mapSequenceSent(row) {
  const b = baseRow(row);
  const seq = b.item.sequence || {};
  return {
    id: row.id,
    sequence_name: seq.name || b.subject,
    subject: b.subject,
    step: seq.step ?? null,
    total_steps: seq.total ?? null,
    recipient_email: b.item.recipientEmail ?? b.item.recipient ?? null,
    delivery_system: b.channel,
    status: designStatus(row, b.ct),
    sent_at: b.sent_at,
    delivery_status: b.delivery_status,
  };
}

// ── Newsletter sent-history signals (WP-11) ──────────────────────────────────
// historyRows = merged rows from newsletter_sends + pa_action_drafts (sent listmonk).
// Expected shape per row: { subject?, draft_slug?, edition?, sent_at?, body? }
// (all fields optional — null/undefined tolerated throughout).
//
// Returns { freshness: cell, previouslyFeatured: cell } where cell =
// { label, value, sub, pct, tone }.  A null cell field signals "cannot compute".

function normalizeSubject(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Extract http/https URLs from a string, stripping query-strings + trailing slashes.
function extractUrls(text) {
  if (!text) return [];
  const raw = String(text).match(/https?:\/\/[^\s"'<>()[\]{}]+/gi) || [];
  return raw.map((u) => {
    try {
      const p = new URL(u);
      // Drop query + hash; strip trailing slash from pathname.
      return (p.origin + p.pathname.replace(/\/+$/, '')).toLowerCase();
    } catch {
      return u.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
  }).filter(Boolean);
}

// Normalise a draft_slug token: lowercase, trim.
function normalizeSlug(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase();
}

// 60-day window in ms.
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

// Format a sent_at epoch as a short date string e.g. '2026-05-06'.
function shortDate(epochMs) {
  const d = new Date(epochMs);
  return d.toISOString().slice(0, 10);
}

/**
 * Derive Freshness + Previously-featured quality cells from sent-history rows.
 *
 * @param {Object} item        - The draft's item object (from parseDraft).
 *   item.subject  - newsletter subject being drafted
 *   item.body     - newsletter body text (may be absent)
 *   item.section  - draft_slug token
 * @param {Array}  historyRows - merged sent history rows, shape:
 *   { subject?, draft_slug?, edition?, sent_at?, body? }
 * @returns {{ freshness: Object, previouslyFeatured: Object }}
 */
export function newsletterHistorySignals(item, historyRows, now = Date.now()) {
  const it = item || {};
  const rows = Array.isArray(historyRows) ? historyRows : [];

  // ── Freshness ─────────────────────────────────────────────────────────────
  // A repeat is a history row whose normalised subject equals this draft's subject
  // AND whose sent_at is within 60 days of now.
  const draftSubj = normalizeSubject(it.subject);

  let freshness;
  if (rows.length === 0) {
    freshness = { label: 'Freshness', value: '—', sub: 'no sent history', pct: 0, tone: 'warn' };
  } else if (!draftSubj) {
    freshness = { label: 'Freshness', value: '—', sub: 'no subject to check', pct: 0, tone: 'warn' };
  } else {
    // Find most recent repeat within 60 days.
    let repeatDate = null;
    for (const r of rows) {
      const histSubj = normalizeSubject(r.subject);
      if (!histSubj || histSubj !== draftSubj) continue;
      const sentMs = toEpoch(r.sent_at);
      if (!Number.isFinite(sentMs)) continue;
      const ageDays = (now - sentMs) / 86_400_000;
      if (ageDays <= 60) {
        if (repeatDate === null || sentMs > repeatDate) repeatDate = sentMs;
      }
    }
    if (repeatDate !== null) {
      freshness = {
        label: 'Freshness',
        value: 'Repeat',
        sub: `same subject sent ${shortDate(repeatDate)}`,
        pct: 10,
        tone: 'warn',
      };
    } else {
      freshness = { label: 'Freshness', value: 'Fresh', sub: 'no repeat <60d', pct: 100, tone: 'ok' };
    }
  }

  // ── Previously featured ───────────────────────────────────────────────────
  // Counts history editions sharing ≥1 link or draft_slug with this draft.
  // Works from: draft body URLs + draft_slug vs history row body URLs + draft_slug.
  // Rows with no body (and no matching slug) simply don't match — honest.

  let previouslyFeatured;
  const draftSlug = normalizeSlug(it.section);
  const draftBody = it.body || '';
  const draftUrls = new Set(extractUrls(draftBody));
  // Add the draft's own slug as a "virtual URL" matchable in history rows.
  if (draftSlug) draftUrls.add('slug:' + draftSlug);

  const rowsWithBody = rows.filter((r) => r.body || r.draft_slug);

  if (rowsWithBody.length === 0) {
    previouslyFeatured = {
      label: 'Previously featured',
      value: '—',
      sub: rows.length === 0 ? 'no sent history' : 'no body in history',
      pct: 0,
      tone: 'warn',
    };
  } else if (draftUrls.size === 0) {
    previouslyFeatured = {
      label: 'Previously featured',
      value: '—',
      sub: 'no links/slug to check',
      pct: 0,
      tone: 'warn',
    };
  } else {
    let matchCount = 0;
    for (const r of rows) {
      const rowUrls = new Set(extractUrls(r.body || ''));
      const rowSlug = normalizeSlug(r.draft_slug);
      if (rowSlug) rowUrls.add('slug:' + rowSlug);
      // Check for any overlap with draftUrls.
      let overlap = false;
      for (const u of draftUrls) {
        if (rowUrls.has(u)) { overlap = true; break; }
      }
      if (overlap) matchCount++;
    }
    if (matchCount === 0) {
      previouslyFeatured = {
        label: 'Previously featured',
        value: 'No',
        sub: 'not previously featured',
        pct: 100,
        tone: 'ok',
      };
    } else {
      previouslyFeatured = {
        label: 'Previously featured',
        value: `${matchCount}`,
        sub: `featured in ${matchCount} prior edition${matchCount !== 1 ? 's' : ''}`,
        pct: Math.max(0, 100 - matchCount * 20),
        tone: 'warn',
      };
    }
  }

  return { freshness, previouslyFeatured };
}

// ── Draft-time quality verdict helpers (G-QUALITY, WP-13) ────────────────────
// Pure, exported so they can be unit-tested in derive.test.mjs without importing
// the full view layer.  Both functions accept the `quality` value from
// `item.quality` (or a mapped row's `quality` field); null/undefined → '—' honest.

/**
 * Build a { label, value, sub, pct, tone } cell for the Claims quality dimension.
 *
 * Stamped: value = "N/M" counts, sub = "X verified · Y unsourced · Z failed",
 *          tone = 'fail' if any 'failed', 'warn' if any 'unsourced', else 'ok'.
 * Unstamped: value = '—', sub = 'not verified at draft', tone = 'warn'.
 *
 * @param {ItemQuality|null|undefined} quality
 * @returns {{ label: string, value: string, sub: string, pct: number, tone: string }}
 */
export function claimsVerdictCell(quality) {
  if (!quality || !Array.isArray(quality.claims)) {
    return { label: 'Claims', value: '—', sub: 'not verified at draft', pct: 0, tone: 'warn' };
  }
  const claims = quality.claims;
  const total = claims.length;
  if (total === 0) {
    // Draft explicitly has zero factual claims — clean slate.
    return { label: 'Claims', value: '0', sub: 'no factual claims', pct: 100, tone: 'ok' };
  }
  const verified = claims.filter((c) => c.verdict === 'verified').length;
  const failed = claims.filter((c) => c.verdict === 'failed').length;
  const unsourced = claims.filter((c) => c.verdict === 'unsourced').length;
  const parts = [];
  if (verified > 0) parts.push(`${verified} verified`);
  if (unsourced > 0) parts.push(`${unsourced} unsourced`);
  if (failed > 0) parts.push(`${failed} failed`);
  const sub = parts.join(' · ') || 'claims checked';
  const tone = failed > 0 ? 'fail' : unsourced > 0 ? 'warn' : 'ok';
  const pct = Math.round((verified / total) * 100);
  return { label: 'Claims', value: `${verified}/${total}`, sub, pct, tone };
}

/**
 * Build a { label, value, sub, pct, tone } cell for the Tone-match quality dimension.
 *
 * Stamped: value = 'On-voice' / 'Off-voice', sub = tone.basis (truncated to 80 chars),
 *          tone = 'ok' if on-voice else 'warn'.
 * Unstamped: value = '—', sub = 'not assessed', tone = 'warn'.
 *
 * @param {ItemQuality|null|undefined} quality
 * @returns {{ label: string, value: string, sub: string, pct: number, tone: string }}
 */
export function toneVerdictCell(quality) {
  if (!quality || !quality.tone) {
    return { label: 'Tone match', value: '—', sub: 'not assessed', pct: 0, tone: 'warn' };
  }
  const t = quality.tone;
  const isOnVoice = t.verdict === 'on-voice';
  const basis = t.basis ? String(t.basis).slice(0, 80) : '';
  return {
    label: 'Tone match',
    value: isOnVoice ? 'On-voice' : 'Off-voice',
    sub: basis,
    pct: isOnVoice ? 90 : 20,
    tone: isOnVoice ? 'ok' : 'warn',
  };
}

// ── Batch loader → per-channel/per-view split ─────────────────────────────────
// One pass over a set of rows: parse + derive + map by (contentType, mapper).
export function splitByContentType(rows, mapper) {
  const out = { email: [], newsletter: [], social: [], sequences: [] };
  for (const row of rows || []) {
    const { item } = parseDraft(row);
    const ct = deriveContentType(item);
    (out[ct] = out[ct] || []).push(mapper(row));
  }
  return out;
}

// Queue counts per channel from a set of queue-status rows.
export function countByContentType(rows) {
  const out = { email: 0, newsletter: 0, social: 0, sequences: 0 };
  for (const row of rows || []) {
    const { item } = parseDraft(row);
    out[deriveContentType(item)] += 1;
  }
  return out;
}
