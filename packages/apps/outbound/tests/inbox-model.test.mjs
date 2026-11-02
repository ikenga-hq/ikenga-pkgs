// Unit tests for the unified inbox view-model (outbox redesign).
// Run: node --test tests/inbox-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toSnakeRow, normalizeRow, buildInbox, readMedia, inlineImages, allImages,
  urgencyOf, applyFilter, sortItems, sectionize, facetCounts, buildPatch,
  approveBlockReason, consequence, fixtureRows, EMPTY_FILTER, hashtagsIn, addHashtag, removeHashtag, editCaps,
} from '../dist/lib/inbox-model.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const row = (o = {}) => ({
  id: 'r1', batch_id: null, status: 'awaiting', channel: 'smtp',
  payload_json: JSON.stringify({ item: { kind: 'email', subject: 'Hi', body: 'Body', recipient: 'Ada', ...(o.item || {}) }, meta: { agent: 'PA', ...(o.meta || {}) } }),
  edited_json: o.edited ? JSON.stringify(o.edited) : null,
  scheduled_at: o.at ?? null, created_at: '2026-11-01 10:00:00', attempts: 0, error_text: null, ...(o.row || {}),
});

test('camelCase host rows normalise like snake rows and keep the verbatim row for `seen`', () => {
  const snake = row();
  const camel = { id: 'r1', batchId: null, status: 'awaiting', channel: 'smtp', payloadJson: snake.payload_json, editedJson: null, scheduledAt: null, createdAt: snake.created_at, attempts: 0, errorText: null, rejectReason: 'x' };
  const a = normalizeRow(snake);
  const b = normalizeRow(camel);
  assert.equal(a.subject, b.subject);
  assert.equal(b.rejectReason, 'x');
  assert.equal(b.host, camel);
  assert.equal(toSnakeRow(camel).payload_json, snake.payload_json);
});

test('edited_json overrides subject/body/schedule and flags edited', () => {
  const it = normalizeRow(row({ edited: { subject: 'New', scheduledIso: '2026-11-03T09:00:00Z' }, at: '2026-11-02 08:00:00' }));
  assert.equal(it.subject, 'New');
  assert.equal(it.body, 'Body');
  assert.equal(it.scheduledAt, Date.parse('2026-11-03T09:00:00Z'));
  assert.equal(it.edited, true);
  assert.equal(it.agent, 'pa');
});

test('media: edited override > item.media > legacy media_url; inline images parsed from html + markdown', () => {
  assert.deepEqual(readMedia({ media_url: 'https://a/x.png' }).images, ['https://a/x.png']);
  assert.equal(readMedia({ media: { imageUrls: ['https://a/1.png', 'https://a/2.png'] } }).kind, 'carousel');
  assert.deepEqual(readMedia({ media: { imageUrls: ['https://a/1.png'] } }, { media: { kind: 'single', imageUrls: [] } }).images, []);
  assert.equal(readMedia({ media: { imageUrls: ['javascript:alert(1)'] } }).kind, 'none');
  assert.deepEqual(inlineImages('<p><img alt="x" src="https://cdn/a.jpg"></p> ![b](https://cdn/b.png) <img src="https://cdn/a.jpg">'), ['https://cdn/a.jpg', 'https://cdn/b.png']);
  const it = normalizeRow(row({ item: { body: '<img src="https://cdn/in.jpg">', media: { imageUrls: ['https://cdn/att.jpg'] } } }));
  assert.deepEqual(allImages(it), ['https://cdn/att.jpg', 'https://cdn/in.jpg']);
});

test('social fan-out siblings collapse into one item keeping every row id', () => {
  const mk = (id, platform, status = 'awaiting') => row({ row: { id, batch_id: 'b1', channel: 'buffer', status }, item: { kind: 'social', platform, body: 'Post' } });
  const items = buildInbox([mk('s1', 'x'), mk('s2', 'linkedin'), mk('s3', 'bluesky', 'failed'), row({ row: { id: 'gone', status: 'rejected' } })]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].platforms, ['linkedin', 'x', 'bluesky']);
  assert.deepEqual(items[0].ids.sort(), ['s1', 's2', 's3']);
  assert.equal(items[0].status, 'failed');
});

test('urgency sections: failed > overdue > today > week > later > unscheduled > queued', () => {
  const at = (iso, status = 'awaiting') => normalizeRow(row({ at: iso, row: { status } }));
  assert.equal(urgencyOf(at(null, 'failed'), NOW), 'failed');
  assert.equal(urgencyOf(at('2026-11-02 11:00:00'), NOW), 'overdue');
  assert.equal(urgencyOf(at('2026-11-02 18:00:00'), NOW), 'today');
  assert.equal(urgencyOf(at('2026-11-05 10:00:00'), NOW), 'week');
  assert.equal(urgencyOf(at('2026-12-01 10:00:00'), NOW), 'later');
  assert.equal(urgencyOf(at(null), NOW), 'unscheduled');
  assert.equal(urgencyOf(at(null, 'committed'), NOW), 'queued');
  const secs = sectionize(sortItems([at(null), at(null, 'failed'), at('2026-11-02 11:00:00')], 'urgency', NOW), NOW);
  assert.deepEqual(secs.map((s) => s.key), ['failed', 'overdue', 'unscheduled']);
});

test('filter by kind / destination / agent / status / media / search', () => {
  const items = buildInbox(fixtureRows(NOW));
  const c = facetCounts(items, NOW);
  assert.equal(c.kinds.social, 1);
  assert.ok(c.dests.instagram >= 1 && c.dests.smtp >= 2);
  assert.equal(applyFilter(items, { ...EMPTY_FILTER, kinds: ['social'] }, NOW).length, 1);
  assert.equal(applyFilter(items, { ...EMPTY_FILTER, dests: ['listmonk'] }, NOW)[0].kind, 'newsletter');
  assert.ok(applyFilter(items, { ...EMPTY_FILTER, agents: ['cbo'] }, NOW).every((i) => i.agent === 'cbo'));
  assert.ok(applyFilter(items, { ...EMPTY_FILTER, media: true }, NOW).length >= 3);
  assert.equal(applyFilter(items, { ...EMPTY_FILTER, q: 'valentim tenant' }, NOW).length, 1);
  assert.equal(applyFilter(items, { ...EMPTY_FILTER, statuses: ['failed'] }, NOW)[0].id, 'fx-fail');
  assert.equal(applyFilter(items, { ...EMPTY_FILTER, sequence: 'distributor-q3' }, NOW).length, 1);
});

test('buildPatch sends only changed contract keys', () => {
  const it = normalizeRow(row({ item: { kind: 'social', channel: 'buffer', body: 'B #a', hashtags: ['#a'], media: { imageUrls: ['https://a/1.png'] } }, row: { channel: 'buffer' } }));
  assert.deepEqual(buildPatch(it, { body: 'B #a', hashtags: ['#a'], images: ['https://a/1.png'] }), {});
  const p = buildPatch(it, { body: 'C', hashtags: ['#a', '#b'], images: ['https://a/2.png', 'https://a/1.png'], scheduledAt: Date.parse('2026-11-04T10:00:00Z') });
  assert.deepEqual(p, { body: 'C', hashtags: ['#a', '#b'], media: { kind: 'carousel', imageUrls: ['https://a/2.png', 'https://a/1.png'] }, scheduledIso: '2026-11-04T10:00:00.000Z' });
});

test('approve block reasons: caps, instagram image, excluded platforms, ledger', () => {
  const items = buildInbox(fixtureRows(NOW));
  const so = items.find((i) => i.kind === 'social');
  assert.equal(approveBlockReason(so), null);
  assert.match(approveBlockReason(so, { images: [] }), /Instagram needs/);
  const xId = so.siblings.find((s) => s.platform === 'x').id;
  assert.match(approveBlockReason(so, { bodies: { [xId]: 'y'.repeat(300) } }), /X is over its 280-char cap/);
  assert.equal(approveBlockReason(so, { bodies: { [xId]: 'y'.repeat(300) }, excluded: new Set([xId]) }), null);
  assert.match(approveBlockReason({ ...items[1], ledgerApproval: { at: 'x' } }), /ledger/);
});

test('consequence line names recipients, count, provider, time and undo', () => {
  const it = normalizeRow(row({ item: { recipientsList: [{ name: 'A', email: 'a@x' }, { name: 'B', email: 'b@x' }] } }));
  assert.equal(consequence(it, { when: 'today 17:00' }), 'sends to A +1 · 2 recipients · via SMTP · today 17:00 · undo 10s');
});

test('hashtags live in the text: parse, add, remove; stamped extras become suggestions', () => {
  assert.deepEqual(hashtagsIn('Hi #a and #b_c! #a'), ['#a', '#b_c']);
  assert.equal(addHashtag('Hi there ', 'x'), 'Hi there #x');
  assert.equal(addHashtag('Hi #x', '#x'), 'Hi #x');
  assert.equal(removeHashtag('Hi #a world #ab #a', '#a'), 'Hi world #ab');
  const so = buildInbox(fixtureRows(NOW)).find((i) => i.kind === 'social');
  assert.deepEqual(so.hashtags, ['#royalti']);
  assert.deepEqual(so.suggestedTags, ['#musicbusiness', '#labels']);
});

test('editCaps mirror what the sender sends', () => {
  const items = buildInbox(fixtureRows(NOW));
  const email = items.find((i) => i.provider === 'smtp');
  const nl = items.find((i) => i.kind === 'newsletter');
  const so = items.find((i) => i.kind === 'social');
  assert.equal(editCaps(email).body.edit, true);
  assert.equal(editCaps(email).images.edit, false, 'SMTP attaches no images');
  assert.equal(editCaps(nl).preheader.edit, true, 'listmonk prepends the preheader to HTML bodies');
  assert.equal(editCaps({ ...nl, bodyFormat: 'text' }).preheader.edit, false, 'no preview line on plain text');
  assert.equal(editCaps(nl).subjectB.edit, false, 'A/B subject dropped');
  assert.equal(editCaps(email).preheader.edit, false, 'SMTP has no preheader support');
  assert.equal(editCaps(so).images.edit, true);
  assert.equal(editCaps(so).firstComment.edit, true);
  // Source-bound social draft: only the body is honoured by the sender.
  const bound = normalizeRow(row({ row: { channel: 'buffer' }, item: { kind: 'social', channel: 'buffer', platform: 'linkedin', body: 'B', social: { platform: 'linkedin', account: 'royalti', content: 'B', media_url: null, scheduled_for: null } } }));
  assert.equal(bound.sourceBound, true);
  const c = editCaps(bound);
  assert.equal(c.body.edit, true);
  assert.equal(c.images.edit, false);
  assert.equal(c.firstComment.edit, false);
  assert.equal(c.schedule.edit, false);
  const thread = normalizeRow(row({ row: { channel: 'buffer' }, item: { kind: 'social', channel: 'buffer', body: 'B', media: { kind: 'thread', thread: [{ text: 'a' }, { text: 'b' }] }, social: { platform: 'x', account: 'royalti', content: 'a b', media_url: null, scheduled_for: null } } }));
  assert.equal(editCaps(thread).body.edit, false, 'a thread post ignores edited body');
});
