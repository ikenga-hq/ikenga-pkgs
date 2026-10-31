// Unit test for outbound queue fallback & error states.
// Run: node tests/queue-fallback.test.mjs
// Or:  node --test tests/queue-fallback.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

// Register ESM loader for https://esm.sh/ imports
register('./test-loader.mjs', import.meta.url);

const {
  loadDrafts,
  setDbQueryForTesting,
  setNavigateForTesting,
  openShellApprovals,
  QueueReadErrorState,
  fetchEmailQueue,
  fetchEmailSchedule,
  fetchEmailSent,
  fetchNewsletterQueue,
  fetchNewsletterSent,
  fetchSequenceDefs,
  fetchActiveSequences,
  fetchSequenceQueue,
  fetchSentSequences,
  fetchSocialQueue,
  fetchSocialSchedule,
  fetchSocialSent,
  fetchAllApprovals,
  fetchChannelCounts,
  fetchAgentCounts,
  FIXTURE_EMAIL_QUEUE,
  FIXTURE_EMAIL_SCHEDULE,
  FIXTURE_EMAIL_SENT,
  FIXTURE_NL_QUEUE,
  FIXTURE_NL_SENT,
  FIXTURE_SEQ_DEFS,
  FIXTURE_ACTIVE_SEQS,
  FIXTURE_SEQ_QUEUE,
  FIXTURE_SENT_SEQS,
  FIXTURE_SOCIAL_QUEUE,
  FIXTURE_SOCIAL_SCHEDULE,
  FIXTURE_SOCIAL_SENT,
  FIXTURE_APPROVALS,
} = await import('../dist/features/outbound/outbound-view.js');

function setupStandalone() {
  globalThis.window = {};
  globalThis.window.parent = globalThis.window;
}

function setupMounted() {
  globalThis.window = {};
  globalThis.window.parent = { postMessage: () => {} };
}

function sampleDbRow(over = {}) {
  const item = {
    id: 'item-1',
    recipient: 'Real Recipient',
    recipientEmail: 'real@example.com',
    subject: 'Real DB Subject',
    body: 'Real DB Body',
    channel: 'resend',
    ...over.item,
  };
  const meta = {
    actionId: 'com.ikenga.skill-outbound/send',
    actionName: 'send',
    agent: 'PA',
    model: 'Claude',
    ...over.meta,
  };
  return {
    id: over.id ?? 'row-1',
    batch_id: over.batch_id ?? 'batch-1',
    action_id: meta.actionId,
    status: over.status ?? 'awaiting',
    channel: over.channel ?? item.channel,
    payload_json: JSON.stringify({ item, meta }),
    edited_json: over.edited_json ?? null,
    scheduled_at: over.scheduled_at ?? null,
    created_at: over.created_at ?? '2026-10-31 10:00:00',
    committed_at: over.committed_at ?? null,
    sent_at: over.sent_at ?? null,
    attempts: over.attempts ?? 0,
    error_text: over.error_text ?? null,
    external_id: over.external_id ?? null,
    delivery_status: over.delivery_status ?? null,
  };
}

test('1. Standalone dev mode: always returns fixtures', async () => {
  setupStandalone();

  // Even if DB query is wired to throw, standalone MUST NOT call DB and MUST return fixtures
  setDbQueryForTesting(() => {
    throw new Error('DB should never be queried in standalone mode');
  });

  assert.deepEqual(await fetchEmailQueue(), FIXTURE_EMAIL_QUEUE, 'email queue returns fixtures');
  assert.deepEqual(await fetchEmailSchedule(), FIXTURE_EMAIL_SCHEDULE, 'email schedule returns fixtures');
  assert.deepEqual(await fetchEmailSent(), FIXTURE_EMAIL_SENT, 'email sent returns fixtures');
  assert.deepEqual(await fetchNewsletterQueue(), FIXTURE_NL_QUEUE, 'newsletter queue returns fixtures');
  assert.deepEqual(await fetchNewsletterSent(), FIXTURE_NL_SENT, 'newsletter sent returns fixtures');
  assert.deepEqual(await fetchSequenceDefs(), FIXTURE_SEQ_DEFS, 'sequence defs return fixtures');
  assert.deepEqual(await fetchActiveSequences(), FIXTURE_ACTIVE_SEQS, 'active sequences return fixtures');
  assert.deepEqual(await fetchSequenceQueue(), FIXTURE_SEQ_QUEUE, 'sequence queue returns fixtures');
  assert.deepEqual(await fetchSentSequences(), FIXTURE_SENT_SEQS, 'sent sequences return fixtures');
  assert.deepEqual(await fetchSocialQueue(), FIXTURE_SOCIAL_QUEUE, 'social queue returns fixtures');
  assert.deepEqual(await fetchSocialSchedule(), FIXTURE_SOCIAL_SCHEDULE, 'social schedule returns fixtures');
  assert.deepEqual(await fetchSocialSent(), FIXTURE_SOCIAL_SENT, 'social sent returns fixtures');
  assert.deepEqual(await fetchAllApprovals(), FIXTURE_APPROVALS, 'cross-channel approvals return fixtures');

  const counts = await fetchChannelCounts();
  assert.deepEqual(counts, { email: 5, newsletter: 2, sequences: 4, social: 4 }, 'channel counts return fixture numbers');

  const agents = await fetchAgentCounts('email');
  assert.deepEqual(agents, { pa: 4, cmo: 5, cbo: 2 }, 'agent counts return fixture numbers');
});

test('2. Mounted in shell + DB read error: throws, never returns fixture rows, shows error state', async () => {
  setupMounted();

  const READ_ERROR = new Error("Database query refused: owner-only read in shared project (E_OWNER_ONLY)");
  setDbQueryForTesting(() => Promise.reject(READ_ERROR));

  // Verify loadDrafts propagates the error
  await assert.rejects(
    () => loadDrafts(['awaiting']),
    /E_OWNER_ONLY/,
    'loadDrafts propagates the database read error'
  );

  // Verify NO fetch function silently falls back to fixture rows
  const fetchers = [
    ['fetchEmailQueue', fetchEmailQueue],
    ['fetchEmailSchedule', fetchEmailSchedule],
    ['fetchEmailSent', fetchEmailSent],
    ['fetchNewsletterQueue', fetchNewsletterQueue],
    ['fetchNewsletterSent', fetchNewsletterSent],
    ['fetchSequenceDefs', fetchSequenceDefs],
    ['fetchActiveSequences', fetchActiveSequences],
    ['fetchSequenceQueue', fetchSequenceQueue],
    ['fetchSentSequences', fetchSentSequences],
    ['fetchSocialQueue', fetchSocialQueue],
    ['fetchSocialSchedule', fetchSocialSchedule],
    ['fetchSocialSent', fetchSocialSent],
    ['fetchAllApprovals', fetchAllApprovals],
    ['fetchChannelCounts', fetchChannelCounts],
  ];

  for (const [name, fn] of fetchers) {
    await assert.rejects(
      () => fn(),
      /E_OWNER_ONLY/,
      `${name} throws on DB read error instead of returning fixture rows`
    );
  }

  // Verify Error State UI component rendering
  let retried = false;
  const vnode = QueueReadErrorState({ onRetry: () => { retried = true; } });

  // Inspect the rendered error state vnode
  const vnodeStr = JSON.stringify(vnode);
  assert.ok(vnodeStr.includes("Can't read this project's queue here."), 'contains exact error message');
  assert.ok(vnodeStr.includes("Open Outbox (/outbox/approvals)"), 'contains open outbox button/link');
  assert.ok(!vnodeStr.includes("Valentim de Carvalho"), 'does not leak fixture names');
  assert.ok(!vnodeStr.includes("Schema patches that unblocked"), 'does not leak fixture subjects');

  // Verify host navigation to /outbox/approvals
  let navigatedTo = null;
  setNavigateForTesting((path) => {
    navigatedTo = path;
    return Promise.resolve();
  });

  await openShellApprovals();
  assert.equal(navigatedTo, '/outbox/approvals', 'openShellApprovals navigates host to /outbox/approvals');
});

test('3. Mounted in shell + DB read success: returns real rows (or empty array), never fixtures', async () => {
  setupMounted();

  const realEmailRow = sampleDbRow({
    id: 'real-draft-1',
    item: {
      recipient: 'Tenant Admin',
      recipientEmail: 'admin@tenant590.com',
      subject: 'Real production email',
      body: 'Your statement has processed.',
      channel: 'resend',
    },
  });

  setDbQueryForTesting((sql) => {
    return Promise.resolve([realEmailRow]);
  });

  const emailRows = await fetchEmailQueue();
  assert.equal(emailRows.length, 1, 'returns 1 real row');
  assert.equal(emailRows[0].id, 'real-draft-1', 'mapped real draft id');
  assert.equal(emailRows[0].subject, 'Real production email', 'mapped real subject');
  assert.notDeepEqual(emailRows, FIXTURE_EMAIL_QUEUE, 'not fixture rows');

  // When database has 0 rows, it MUST return [] honestly, never fixtures
  setDbQueryForTesting(() => Promise.resolve([]));

  const emptyEmail = await fetchEmailQueue();
  assert.deepEqual(emptyEmail, [], 'empty database returns [] for email queue, not fixtures');

  const emptyNl = await fetchNewsletterQueue();
  assert.deepEqual(emptyNl, [], 'empty database returns [] for newsletter queue, not fixtures');

  const emptySocial = await fetchSocialQueue();
  assert.deepEqual(emptySocial, [], 'empty database returns [] for social queue, not fixtures');

  const emptySeq = await fetchSequenceQueue();
  assert.deepEqual(emptySeq, [], 'empty database returns [] for sequence queue, not fixtures');

  const emptyApprovals = await fetchAllApprovals();
  assert.deepEqual(emptyApprovals, [], 'empty database returns [] for approvals, not fixtures');
});
