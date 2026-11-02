// inbox-model.js — the unified Outbox inbox view-model (outbox redesign D-02).
//
// One list of every draft that needs a decision, across email / newsletter /
// social / sequence. Pure + dependency-free (Node-testable, see
// tests/inbox-model.test.mjs). Rows come from `host.paActions.list` (camelCase,
// broker-routed inside a share) or the legacy `host.dbQuery` read (snake_case);
// `toSnakeRow` folds both onto the snake shape derive.js already speaks.
//
// Plan: plans/outbox-redesign/01-plan.md (meta-repo).

import { parseDraft, deriveContentType, deriveHashtags, socialPlatforms, socialSourceGroup, deriveNewsletterType } from './derive.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const KINDS = ['email', 'newsletter', 'social', 'sequence'];
export const KIND_LABEL = { email: 'Email', newsletter: 'Newsletter', social: 'Social', sequence: 'Sequence' };
export const PROVIDERS = ['smtp', 'resend', 'listmonk', 'buffer'];
export const PROVIDER_LABEL = { smtp: 'SMTP', resend: 'Resend', listmonk: 'listmonk', buffer: 'Buffer' };
export const PLATFORMS = ['linkedin', 'x', 'bluesky', 'instagram', 'facebook'];
export const PLATFORM_LABEL = { linkedin: 'LinkedIn', x: 'X', bluesky: 'Bluesky', instagram: 'Instagram', facebook: 'Facebook' };
/** Hard post caps (chars). */
export const PLATFORM_CAPS = { linkedin: 3000, x: 280, bluesky: 300, instagram: 2200, facebook: 63206 };
/** Max images a single post carries per platform. */
export const PLATFORM_MAX_IMAGES = { linkedin: 9, x: 4, bluesky: 4, instagram: 10, facebook: 10 };
/** Statuses the inbox shows (the active set). */
export const ACTIVE_STATUSES = ['awaiting', 'edited', 'committed', 'sending', 'failed'];

export const SECTIONS = [
  ['failed', 'Needs attention'],
  ['overdue', 'Overdue'],
  ['today', 'Today'],
  ['week', 'This week'],
  ['later', 'Later'],
  ['unscheduled', 'No schedule'],
  ['queued', 'Approved · queued to send'],
];

export const SORTS = [
  ['urgency', 'Urgency'],
  ['scheduled', 'Send time'],
  ['newest', 'Newest draft'],
  ['recipient', 'Recipient A–Z'],
];

const PLAT_ALIAS = { twitter: 'x', bsky: 'bluesky', li: 'linkedin', bs: 'bluesky', ig: 'instagram', fb: 'facebook' };
export function normPlatform(p) {
  const k = String(p ?? '').toLowerCase().trim();
  return PLAT_ALIAS[k] ?? k;
}

// ── Row shape adapters ───────────────────────────────────────────────────────

const CAMEL_TO_SNAKE = {
  batchId: 'batch_id', actionId: 'action_id', payloadJson: 'payload_json', editedJson: 'edited_json',
  scheduledAt: 'scheduled_at', createdAt: 'created_at', committedAt: 'committed_at', sentAt: 'sent_at',
  claimedAt: 'claimed_at', lastAttemptAt: 'last_attempt_at', errorText: 'error_text',
  externalId: 'external_id', deliveryStatus: 'delivery_status', deliveryCheckedAt: 'delivery_checked_at',
  rejectReason: 'reject_reason',
};

/** host.paActions.list rows are camelCase; db rows are snake_case. Returns a
 *  snake row (decorations like ledgerApproval kept as-is) + `_host` = the
 *  verbatim row (the `seen` binding a share commit carries). */
export function toSnakeRow(r) {
  if (!r || typeof r !== 'object') return r;
  const out = { _host: r };
  for (const [k, v] of Object.entries(r)) out[CAMEL_TO_SNAKE[k] ?? k] = v;
  return out;
}

// SQLite UTC 'YYYY-MM-DD HH:MM:SS' or ISO → epoch ms | null.
export function toEpoch(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const str = String(s).trim();
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(str);
  const t = Date.parse(str.includes('T') ? str : str.replace(' ', 'T') + (hasTz ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}

// ── Media ────────────────────────────────────────────────────────────────────

const isUrl = (u) => typeof u === 'string' && /^(https?:|data:image\/|blob:)/i.test(u.trim());
const urls = (a) => (Array.isArray(a) ? a.filter(isUrl).map((u) => u.trim()) : []);

/** Attached media for a draft: edited override wins, then item.media, then the
 *  legacy single `media_url`. → { kind: 'none'|'single'|'carousel'|'thread', images[], thread[] } */
export function readMedia(item = {}, edited = {}) {
  const src = edited.media ?? item.media ?? null;
  let images = [];
  let thread = [];
  let kind = null;
  if (src && typeof src === 'object') {
    images = urls(src.imageUrls);
    kind = src.kind ?? null;
    if (Array.isArray(src.thread)) {
      thread = src.thread.map((t) => ({ text: String(t?.text ?? ''), images: urls(t?.imageUrls) }));
    }
  }
  if (!images.length && !edited.media) {
    const single = edited.media_url ?? item.media_url ?? item.mediaUrl ?? null;
    if (isUrl(single)) images = [single.trim()];
  }
  if (!kind) kind = thread.length ? 'thread' : images.length > 1 ? 'carousel' : images.length ? 'single' : 'none';
  if (kind !== 'thread' && !images.length) kind = 'none';
  return { kind, images, thread };
}

/** Images embedded in a body: <img src>, markdown ![](url). Deduped, in order. */
export function inlineImages(body) {
  const s = String(body ?? '');
  const out = [];
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']|!\[[^\]]*\]\(\s*([^)\s]+)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const u = (m[1] ?? m[2] ?? '').trim();
    if (isUrl(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** Every image a reviewer should see on the row strip: attached first, then
 *  thread-post images, then images inline in the body. */
export function allImages(it) {
  const seen = new Set();
  const out = [];
  for (const u of [...it.media.images, ...it.media.thread.flatMap((t) => t.images), ...it.inlineImages]) {
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

// ── Normalise ────────────────────────────────────────────────────────────────

const KIND_FROM_CT = { email: 'email', newsletter: 'newsletter', social: 'social', sequences: 'sequence' };

function platformFromItem(item) {
  if (item.platform) return normPlatform(item.platform);
  const r = `${item.recipient || ''} ${item.fromProvider || ''}`.toLowerCase();
  if (r.includes('linkedin')) return 'linkedin';
  if (r.includes('bluesky') || r.includes('bsky')) return 'bluesky';
  if (r.includes('instagram')) return 'instagram';
  if (r.includes('facebook')) return 'facebook';
  if (r.includes('twitter') || /(^|[\s·])x([\s·]|$)/.test(r)) return 'x';
  return null;
}

/** One pa_action_drafts row (snake or camel) → an InboxItem. */
export function normalizeRow(rawRow) {
  const row = rawRow && rawRow.payloadJson !== undefined ? toSnakeRow(rawRow) : rawRow;
  const { item, meta, edited } = parseDraft(row);
  const kind = KIND_FROM_CT[deriveContentType({ ...item, channel: item.channel ?? row.channel })] ?? 'email';
  const provider = String(row.channel ?? item.channel ?? '').toLowerCase() || null;
  const subject = edited.subject ?? item.subject ?? '';
  const body = edited.body ?? item.body ?? '';
  const platform = kind === 'social' ? platformFromItem(item) : null;
  const scheduledIso = edited.scheduledIso !== undefined ? edited.scheduledIso : null;
  const scheduledAt = scheduledIso !== null ? toEpoch(scheduledIso) : toEpoch(row.scheduled_at) ?? toEpoch(item.scheduledIso);
  const media = readMedia(item, edited);
  const hashtags = kind === 'social'
    ? deriveHashtags(edited.hashtags !== undefined ? { hashtags: edited.hashtags, body: '' } : item)
    : (Array.isArray(item.hashtags) ? item.hashtags : []);
  const seq = item.sequence && typeof item.sequence === 'object' ? item.sequence : null;
  const recipientsList = Array.isArray(item.recipientsList)
    ? item.recipientsList.filter(Boolean).map((r) => (typeof r === 'string' ? { name: null, email: r } : { name: r.name ?? null, email: r.email ?? null }))
    : [];
  const emailGroup = kind !== 'email' ? null
    : (item.kind === 'reply' || item.in_reply_to || item.inReplyTo || /^re:/i.test(subject)) ? 'reply' : 'manual';

  const it = {
    id: String(row.id),
    ids: [String(row.id)],
    batchId: row.batch_id ?? null,
    actionId: row.action_id ?? meta.actionId ?? null,
    kind,
    provider,
    platform,
    platforms: kind === 'social' ? [platform ?? normPlatform(socialPlatforms(item)[0]) ?? 'linkedin'] : [],
    status: row.status ?? 'awaiting',
    subject,
    body,
    bodyFormat: item.bodyFormat ?? (/<\/?[a-z][\s\S]*>/i.test(body) ? 'html' : 'text'),
    subjectB: edited.subjectB ?? edited.subject_b ?? item.subjectB ?? item.subject_b ?? null,
    preheader: edited.preheader ?? item.preheader ?? null,
    firstComment: edited.firstComment ?? item.firstComment ?? null,
    hashtags,
    recipient: item.recipient ?? null,
    recipientEmail: item.recipientEmail ?? null,
    // A sequence row is ONE step to ONE contact — seq.recipients is the enrolment size, not this send's audience.
    recipientsCount: Number.isFinite(item.recipients) ? item.recipients : kind === 'sequence' ? (recipientsList.length || 1) : (recipientsList.length || null),
    recipientsList,
    replyTo: item.replyTo ?? null,
    sender: item.senderAddress ?? item.fromLine ?? item.from_line ?? meta.fromLine ?? null,
    fromProvider: item.fromProvider ?? null,
    cold: !!item.cold,
    tenantId: item.tenantId ?? null,
    deal: item.deal ?? null,
    threadCount: item.threadCount ?? null,
    section: item.section ?? null,
    sequence: seq ? { name: seq.name ?? null, step: seq.step ?? null, total: seq.total ?? null, recipients: seq.recipients ?? null } : null,
    emailGroup,
    sourceGroup: kind === 'social' ? socialSourceGroup(item, meta) : null,
    blogSlug: item.blogSlug ?? null,
    topic: item.topic ?? null,
    newsletterType: kind === 'newsletter' ? deriveNewsletterType(item, meta, subject) : null,
    agent: String(meta.agent || 'pa').toLowerCase(),
    model: meta.model ?? null,
    actionName: meta.actionName ?? null,
    undoMs: Number.isFinite(meta.undoMs) ? meta.undoMs : 10_000,
    scheduledAt,
    scheduledLabel: item.scheduledLabel ?? null,
    createdAt: toEpoch(row.created_at),
    committedAt: toEpoch(row.committed_at),
    attempts: row.attempts ?? 0,
    errorText: row.error_text ?? null,
    delivery: row.delivery_status ?? null,
    rejectReason: row.reject_reason ?? null,
    quality: item.quality ?? null,
    media,
    inlineImages: kind === 'social' ? [] : inlineImages(body),
    edited: row.status === 'edited' || (edited && Object.keys(edited).length > 0),
    ledgerApproval: row.ledgerApproval ?? row._host?.ledgerApproval ?? null,
    outreach: item.outreach ?? null,
    outreachStatus: row.outreachStatus ?? row._host?.outreachStatus ?? null,
    outreachPause: row.outreachPause ?? row._host?.outreachPause ?? null,
    siblings: [],
    host: row._host ?? null,
    // Original (pre-edit) values, so the editor can show "edited" and build minimal patches.
    original: { subject: item.subject ?? '', body: item.body ?? '' },
  };
  it.siblings = [{ id: it.id, platform: it.platform, status: it.status, body: it.body, errorText: it.errorText, scheduledAt: it.scheduledAt, host: it.host }];
  return it;
}

/** Collapse social fan-out siblings (same batch_id) into one item. The first
 *  row is the representative; every platform keeps its own row id + body. */
export function groupFanout(items) {
  const out = [];
  const byBatch = new Map();
  for (const it of items) {
    if (it.kind !== 'social' || !it.batchId) { out.push(it); continue; }
    const g = byBatch.get(it.batchId);
    if (!g) {
      const head = { ...it, ids: [...it.ids], siblings: [...it.siblings], platforms: [...it.platforms] };
      byBatch.set(it.batchId, head);
      out.push(head);
      continue;
    }
    g.ids.push(it.id);
    g.siblings.push(...it.siblings);
    for (const p of it.platforms) if (!g.platforms.includes(p)) g.platforms.push(p);
    // The group is as urgent as its most urgent sibling.
    if (it.status === 'failed') { g.status = 'failed'; g.errorText = g.errorText ?? it.errorText; }
    if (it.scheduledAt != null && (g.scheduledAt == null || it.scheduledAt < g.scheduledAt)) g.scheduledAt = it.scheduledAt;
    g.edited = g.edited || it.edited;
    for (const u of it.media.images) if (!g.media.images.includes(u)) g.media.images.push(u);
  }
  for (const g of byBatch.values()) {
    g.platforms.sort((a, b) => PLATFORMS.indexOf(a) - PLATFORMS.indexOf(b));
    g.siblings.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));
    if (g.media.images.length > 1 && g.media.kind === 'single') g.media.kind = 'carousel';
  }
  return out;
}

/** rows → grouped InboxItems (rejected/sent filtered out). */
export function buildInbox(rows) {
  const items = [];
  for (const r of rows || []) {
    try {
      const it = normalizeRow(r);
      if (ACTIVE_STATUSES.includes(it.status)) items.push(it);
    } catch { /* malformed row — skip rather than crash the inbox */ }
  }
  return groupFanout(items);
}

// ── Status / urgency ─────────────────────────────────────────────────────────

export const isApprovable = (it) =>
  !!it && (it.status === 'awaiting' || it.status === 'edited') && !it.ledgerApproval;

/** Why Approve is blocked (string) or null. Social checks need the editor
 *  state, so callers pass it: `live = { bodies: {rowId: text}, hashtags,
 *  images, excluded: Set<rowId> }`. */
export function approveBlockReason(it, live = {}) {
  if (!it) return 'Nothing selected';
  if (it.ledgerApproval) return 'Already approved in the box ledger';
  if (it.status === 'committed') return 'Already approved — queued to send';
  if (it.status === 'sending') return 'Sending now';
  if (it.status === 'failed') return 'Send failed — retry instead';
  if (!isApprovable(it)) return `Not approvable (${it.status})`;
  if (it.kind === 'social') {
    const images = live.images ?? it.media.images;
    const active = it.siblings.filter((s) => !live.excluded?.has(s.id));
    if (!active.length) return 'Every platform is excluded';
    for (const s of active) {
      const p = s.platform;
      const len = textForPlatform(live.bodies?.[s.id] ?? s.body, live.hashtags ?? it.hashtags).length;
      if (PLATFORM_CAPS[p] && len > PLATFORM_CAPS[p]) return `${PLATFORM_LABEL[p] ?? p} is over its ${PLATFORM_CAPS[p]}-char cap by ${len - PLATFORM_CAPS[p]}`;
      if (p === 'instagram' && !images.length) return 'Instagram needs at least one image';
      if (PLATFORM_MAX_IMAGES[p] && images.length > PLATFORM_MAX_IMAGES[p]) return `${PLATFORM_LABEL[p] ?? p} takes at most ${PLATFORM_MAX_IMAGES[p]} images`;
    }
  }
  return null;
}

/** The text a platform actually posts: body + hashtags not already in it. */
export function textForPlatform(body, hashtags = []) {
  const b = String(body ?? '');
  const extra = (hashtags || []).filter((h) => !b.includes(h));
  return extra.length ? `${b}${b ? ' ' : ''}${extra.join(' ')}` : b;
}

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeekMon(t) { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }

export function urgencyOf(it, now = Date.now()) {
  if (it.status === 'failed') return 'failed';
  if (it.status === 'committed' || it.status === 'sending') return 'queued';
  if (it.scheduledAt == null) return 'unscheduled';
  if (it.scheduledAt < now) return 'overdue';
  if (startOfDay(it.scheduledAt) === startOfDay(now)) return 'today';
  if (it.scheduledAt < startOfWeekMon(now) + 7 * 86_400_000) return 'week';
  return 'later';
}

// ── Facets / filter / sort ───────────────────────────────────────────────────

export const EMPTY_FILTER = Object.freeze({ q: '', kinds: [], dests: [], agents: [], statuses: [], media: false, sequence: null });

/** Destination keys an item fans out to (platforms for social, provider otherwise). */
export function destinationsOf(it) {
  return it.kind === 'social' ? it.platforms : it.provider ? [it.provider] : [];
}

export function displayStatus(it, now = Date.now()) {
  if (it.status === 'failed') return 'failed';
  if (it.status === 'sending') return 'sending';
  if (it.status === 'committed') return 'queued';
  if (it.scheduledAt != null && it.scheduledAt < now) return 'overdue';
  return it.edited ? 'edited' : 'awaiting';
}

export function facetCounts(items, now = Date.now()) {
  const c = { total: items.length, kinds: {}, dests: {}, agents: {}, statuses: {}, media: 0, sequences: {} };
  const inc = (o, k) => { if (k) o[k] = (o[k] ?? 0) + 1; };
  for (const it of items) {
    inc(c.kinds, it.kind);
    for (const d of destinationsOf(it)) inc(c.dests, d);
    inc(c.agents, it.agent);
    inc(c.statuses, displayStatus(it, now));
    if (allImages(it).length) c.media += 1;
    if (it.sequence?.name) inc(c.sequences, it.sequence.name);
  }
  return c;
}

function haystack(it) {
  return [
    it.subject, it.body, it.recipient, it.recipientEmail, it.sender, it.agent, it.model, it.provider,
    PROVIDER_LABEL[it.provider], ...it.platforms.map((p) => PLATFORM_LABEL[p] ?? p), KIND_LABEL[it.kind],
    it.sequence?.name, it.deal, it.topic, it.actionName, ...(it.hashtags || []),
    ...it.recipientsList.flatMap((r) => [r.name, r.email]),
  ].filter(Boolean).join(' \u0001 ').toLowerCase();
}

export function applyFilter(items, f = EMPTY_FILTER, now = Date.now()) {
  const terms = String(f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    if (f.kinds?.length && !f.kinds.includes(it.kind)) return false;
    if (f.dests?.length && !destinationsOf(it).some((d) => f.dests.includes(d))) return false;
    if (f.agents?.length && !f.agents.includes(it.agent)) return false;
    if (f.statuses?.length && !f.statuses.includes(displayStatus(it, now))) return false;
    if (f.media && !allImages(it).length) return false;
    if (f.sequence && it.sequence?.name !== f.sequence) return false;
    if (terms.length) {
      const h = haystack(it);
      if (!terms.every((t) => h.includes(t))) return false;
    }
    return true;
  });
}

const SECTION_RANK = Object.fromEntries(SECTIONS.map(([k], i) => [k, i]));

export function sortItems(items, sort = 'urgency', now = Date.now()) {
  const by = {
    urgency: (a, b) => (SECTION_RANK[urgencyOf(a, now)] - SECTION_RANK[urgencyOf(b, now)])
      || ((a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity))
      || ((b.createdAt ?? 0) - (a.createdAt ?? 0)),
    scheduled: (a, b) => ((a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity)) || ((b.createdAt ?? 0) - (a.createdAt ?? 0)),
    newest: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    recipient: (a, b) => recipientLabel(a).localeCompare(recipientLabel(b)),
  }[sort] ?? (() => 0);
  return [...items].sort(by);
}

/** Group a sorted list into urgency sections (omits empties). */
export function sectionize(items, now = Date.now()) {
  const map = new Map();
  for (const it of items) {
    const k = urgencyOf(it, now);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return SECTIONS.filter(([k]) => map.has(k)).map(([key, label]) => ({ key, label, items: map.get(key) }));
}

// ── Labels ───────────────────────────────────────────────────────────────────

export function recipientLabel(it) {
  if (it.kind === 'social') return it.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(' · ') || 'Social';
  if (it.kind === 'newsletter') return it.recipientsCount ? `${it.recipientsCount.toLocaleString('en-US')} subscribers` : (it.recipient || 'Subscribers');
  if (it.recipientsList.length > 1) return `${it.recipientsList[0].name || it.recipientsList[0].email} +${it.recipientsList.length - 1}`;
  return it.recipient || it.recipientEmail || (it.recipientsCount ? `${it.recipientsCount} recipients` : '—');
}

export function audienceCount(it) {
  if (it.kind === 'social') return null;
  return it.recipientsCount ?? (it.recipientsList.length || 1);
}

/** Full consequence sentence (never abbreviated — approve-gate business rule). */
export function consequence(it, { when, undoMs } = {}) {
  const count = audienceCount(it);
  const who = it.kind === 'social'
    ? `posts to ${it.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(', ')}`
    : `sends to ${recipientLabel(it)}`;
  const parts = [who];
  if (count != null && it.kind !== 'newsletter') parts.push(`${count} recipient${count === 1 ? '' : 's'}`);
  parts.push(it.kind === 'social' ? 'via Buffer' : `via ${PROVIDER_LABEL[it.provider] ?? it.provider ?? 'provider'}`);
  parts.push(when ?? 'now');
  parts.push(`undo ${Math.round((undoMs ?? it.undoMs ?? 10_000) / 1000)}s`);
  return parts.join(' · ');
}

// ── Edit patches (G-CONTRACT: subject, body, subjectB, preheader, firstComment, hashtags, media, scheduledIso) ──

const arrEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Minimal patch from the editor `draft` vs the item as loaded. Only changed
 *  keys are sent (the backend shallow-merges into edited_json). */
export function buildPatch(it, draft) {
  const p = {};
  if (draft.subject !== undefined && draft.subject !== it.subject) p.subject = draft.subject;
  if (draft.body !== undefined && draft.body !== it.body) p.body = draft.body;
  if (draft.subjectB !== undefined && (draft.subjectB || null) !== (it.subjectB || null)) p.subjectB = draft.subjectB || null;
  if (draft.preheader !== undefined && (draft.preheader || null) !== (it.preheader || null)) p.preheader = draft.preheader || null;
  if (draft.firstComment !== undefined && (draft.firstComment || null) !== (it.firstComment || null)) p.firstComment = draft.firstComment || null;
  if (draft.hashtags !== undefined && !arrEq(draft.hashtags, it.hashtags)) p.hashtags = draft.hashtags;
  if (draft.images !== undefined && !arrEq(draft.images, it.media.images)) {
    p.media = { kind: draft.images.length > 1 ? 'carousel' : draft.images.length ? 'single' : 'single', imageUrls: draft.images };
    if (it.media.kind === 'thread') p.media.kind = 'thread';
  }
  if (draft.scheduledAt !== undefined && draft.scheduledAt !== it.scheduledAt) {
    p.scheduledIso = draft.scheduledAt == null ? null : new Date(draft.scheduledAt).toISOString();
  }
  return p;
}

// ── Fixture (standalone) — raw pa_action_drafts rows, so the real pipeline runs ──

const H = 3_600_000;
function sqlTime(t) { return new Date(t).toISOString().slice(0, 19).replace('T', ' '); }
function fx(id, status, channel, item, meta, extra = {}) {
  return {
    id, batch_id: extra.batch_id ?? null, action_id: 'fixture', status, channel,
    payload_json: JSON.stringify({ item, meta: { agent: 'pa', model: 'claude-sonnet-4-5', undoMs: 10000, ...meta } }),
    edited_json: extra.edited ? JSON.stringify(extra.edited) : null,
    scheduled_at: extra.at != null ? sqlTime(extra.at) : null,
    created_at: sqlTime(extra.created ?? Date.now() - 2 * H),
    attempts: extra.attempts ?? 0, error_text: extra.error ?? null, delivery_status: null, reject_reason: null,
  };
}

const IMG = (id, w = 1200, h = 627) => `https://images.unsplash.com/${id}?w=${w}&h=${h}&fit=crop&auto=format`;

export function fixtureRows(now = Date.now()) {
  const social = {
    kind: 'social', channel: 'buffer', subject: 'Royalty calculator overhaul · launch post',
    body: 'The royalty calculator overhaul shipped this week. Statements ingest in ~90s for a 30k-row CSV (was ~6 min), and splits recompute live as you edit.',
    hashtags: ['#royalti', '#musicbusiness'], blogSlug: 'royalty-calc-overhaul', sourceGroup: 'blog',
    media: { kind: 'carousel', imageUrls: [IMG('photo-1511671782779-c97d3d27a1d4'), IMG('photo-1493225457124-a3eb161ffa5f'), IMG('photo-1470225620780-dba8ba36b745')] },
    firstComment: 'Full breakdown → royalti.io/blog/royalty-calc-overhaul',
  };
  return [
    fx('fx-fail', 'failed', 'smtp', {
      kind: 'email', subject: 'Statement for Q3 — Afrobeat Collective', recipient: 'Kemi Adebayo', recipientEmail: 'kemi@afrobeatcollective.ng',
      body: 'Hi Kemi,\n\nYour Q3 statement is attached. Net payable is $4,120 after the advance recoup.\n\nBest,\nRuby', senderAddress: 'ruby@royalti.io',
    }, {}, { at: now - 5 * H, attempts: 3, error: 'SMTP 550 5.1.1 mailbox unavailable (kemi@afrobeatcollective.ng)' }),
    fx('fx-reply', 'awaiting', 'smtp', {
      kind: 'reply', subject: 'Re: Royalti onboarding · file processing delay', recipient: 'Valentim de Carvalho', recipientEmail: 'valentim@soundlabel.pt',
      body: 'Hi Valentim,\n\nThanks for flagging this. The delay was a schema mismatch on ingestion — patched in 0.7.4 and the backfill ran clean this morning.\n\nTenant 590 should now show all statements.\n\nBest,\nRuby',
      senderAddress: 'ruby@royalti.io', tenantId: 590, threadCount: 4,
      quality: { claims: [{ text: 'patched in 0.7.4', source: 'https://royalti.io/changelog/0.7.4', verdict: 'verified' }], tone: { verdict: 'on-voice', basis: 'Direct, first-person Ruby voice.', model: 'claude-sonnet-4-5' }, verified_at: new Date(now - H).toISOString(), verifier: 'draft-time' },
    }, {}, { at: now - 30 * 60_000 }),
    fx('fx-so-li', 'awaiting', 'buffer', { ...social, platform: 'linkedin' }, { agent: 'cmo' }, { batch_id: 'blog-01', at: now + 3 * H }),
    fx('fx-so-x', 'awaiting', 'buffer', { ...social, platform: 'x', body: 'Royalty calculator overhaul is live: statements ingest in ~90s for a 30k-row CSV (was ~6 min). Splits recompute as you edit.' }, { agent: 'cmo' }, { batch_id: 'blog-01', at: now + 3 * H }),
    fx('fx-so-bs', 'awaiting', 'buffer', { ...social, platform: 'bluesky' }, { agent: 'cmo' }, { batch_id: 'blog-01', at: now + 3 * H }),
    fx('fx-so-ig', 'awaiting', 'buffer', { ...social, platform: 'instagram' }, { agent: 'cmo' }, { batch_id: 'blog-01', at: now + 3 * H }),
    fx('fx-nl', 'edited', 'listmonk', {
      kind: 'newsletter', subject: 'You can deliver from Royalti now', subjectB: 'DDEX delivery, straight from your workspace', preheader: 'No aggregator account needed for the first batch.',
      recipients: 2104, fromLine: 'Ruby <ruby@royalti.io>',
      body: '<h2>Delivery is here</h2><p>Royalti now ships a full delivery pipeline. Send DDEX ERN4 messages directly to DSPs that accept DDEX.</p><img src="' + IMG('photo-1516280440614-37939bbacd81', 1200, 600) + '" alt="Delivery"/><h2>What it costs</h2><p>It is a paid add-on — a revolutionary change for small labels.</p><p><a href="https://royalti.io/deliver">See how it works</a></p>',
    }, { agent: 'cmo' }, { at: now + 26 * H, edited: { preheader: 'No aggregator account needed for the first batch.' } }),
    fx('fx-seq', 'awaiting', 'resend', {
      kind: 'sequence', subject: 'Following up on the Royalti deck', recipient: 'A&R · Universal Music PT', recipientEmail: 'ar@universalmusic.pt',
      body: 'Hi Rita,\n\nCircling back on the deck from last week — happy to walk you through the ingestion demo on a 15-minute call, or send a Loom if async is easier.\n\nBest,\nChinedum',
      sequence: { name: 'distributor-q3', step: 2, total: 4, recipients: 14 }, cold: true, senderAddress: 'ned@royalti.io', deal: 'UMPT-pilot',
      recipientsList: [{ name: 'Rita Sousa', email: 'ar@universalmusic.pt' }],
    }, { agent: 'cbo' }, { at: now + 4 * 24 * H }),
    fx('fx-queued', 'committed', 'resend', {
      kind: 'email', subject: 'Welcome to Royalti — your workspace is ready', recipient: 'Ade Okafor', recipientEmail: 'ade@okafor.studio',
      body: 'Hi Ade,\n\nYour workspace is live. Start by importing a statement — it takes about 90 seconds.\n\nRuby',
    }, {}, { at: now + 10 * 60_000 }),
    fx('fx-unsched', 'awaiting', 'smtp', {
      kind: 'email', subject: 'Invoice #1042 — friendly reminder', recipient: 'Lagos Sound Ltd', recipientEmail: 'accounts@lagossound.ng',
      recipientsList: [{ name: 'Accounts', email: 'accounts@lagossound.ng' }, { name: 'Tolu Bello', email: 'tolu@lagossound.ng' }], replyTo: 'billing@royalti.io',
      body: 'Hello,\n\nA friendly reminder that invoice #1042 ($1,850) fell due on Oct 28. You can pay from the link in the original invoice.\n\nThanks,\nRuby',
      media: { kind: 'single', imageUrls: [IMG('photo-1554224155-6726b3ff858f', 800, 1000)] },
    }, { agent: 'cbo' }),
  ];
}
