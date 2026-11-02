// Unit test for outbound queue fallback & error states.
// Run: node tests/queue-fallback.test.mjs
// Or:  node --test tests/queue-fallback.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

// Register ESM loader for https://esm.sh/ imports
register('./test-loader.mjs', import.meta.url);

import {
  setMockQueryConfig,
  getQueryCalls,
  getLastQueryOptions,
  resetMockQuery,
} from './test-loader.mjs';

const {
  loadDrafts,
  setDbQueryForTesting,
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
  fetchChannelCounts,
  fetchAgentCounts,
  EmailScheduleView,
  EmailSentView,
  NewsletterScheduleView,
  NewsletterSentView,
  SequencesActiveView,
  SequencesSentView,
  SocialScheduleView,
  SocialSentView,
  RecipientCohort,
  fetchNewsletterHistory,
  buildOutboundMenu,
  resolveTarget,
  OutboundView,
  isPermissionRefusal,
  queryRetry,
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
} = await import('../dist/features/outbound/outbound-view.js');

const { queryClient } = await import('../dist/app.js');
const { fetchInboxRows, InboxView } = await import('../dist/features/inbox/inbox-view.js');
const { hostDbQuery, setBridgeAppForTesting } = await import('../dist/lib/bridge.js');

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
  const inbox = await fetchInboxRows();
  assert.equal(inbox.source, 'fixture', 'inbox reads demo rows in standalone');
  assert.ok(inbox.rows.length > 0, 'inbox fixture rows are non-empty');

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
    ['fetchChannelCounts', fetchChannelCounts],
    ['fetchAgentCounts', () => fetchAgentCounts('email')],
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
  assert.ok(!vnodeStr.includes("/outbox/approvals"), 'no longer points at the retired shell approve-gate');
  assert.ok(!vnodeStr.includes("Valentim de Carvalho"), 'does not leak fixture names');
  assert.ok(!vnodeStr.includes("Schema patches that unblocked"), 'does not leak fixture subjects');
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
});

test('4. Error-path test for fetchAgentCounts: throws on DB read error when mounted, returns fixtures in standalone', async () => {
  // A. Standalone: always returns fixture agent counts { pa: 4, cmo: 5, cbo: 2 }
  setupStandalone();
  setDbQueryForTesting(() => {
    throw new Error('DB should never be queried in standalone mode');
  });
  for (const ch of ['email', 'newsletter', 'sequences', 'social']) {
    const counts = await fetchAgentCounts(ch);
    assert.deepEqual(counts, { pa: 4, cmo: 5, cbo: 2 }, `standalone returns fixture counts for ${ch}`);
  }

  // B. Mounted in shell + DB error: must throw, never catch and return fixture counts
  setupMounted();
  const READ_ERROR = new Error("Database query refused: owner-only read in shared project (E_OWNER_ONLY)");
  setDbQueryForTesting(() => Promise.reject(READ_ERROR));
  for (const ch of ['email', 'newsletter', 'sequences', 'social']) {
    await assert.rejects(
      () => fetchAgentCounts(ch),
      /E_OWNER_ONLY/,
      `fetchAgentCounts('${ch}') propagates DB read error when mounted`
    );
  }
});

const ALL_ERROR_VIEWS = [
  { name: 'EmailScheduleView', component: EmailScheduleView, channel: 'email', view: 'schedule' },
  { name: 'EmailSentView', component: EmailSentView, channel: 'email', view: 'sent' },
  { name: 'NewsletterScheduleView', component: NewsletterScheduleView, channel: 'newsletter', view: 'schedule' },
  { name: 'NewsletterSentView', component: NewsletterSentView, channel: 'newsletter', view: 'sent' },
  { name: 'SequencesActiveView', component: SequencesActiveView, channel: 'sequences', view: 'schedule' },
  { name: 'SequencesSentView', component: SequencesSentView, channel: 'sequences', view: 'sent' },
  { name: 'SocialScheduleView', component: SocialScheduleView, channel: 'social', view: 'schedule' },
  { name: 'SocialSentView', component: SocialSentView, channel: 'social', view: 'sent' },
];

test('5. View wiring when mounted + isError:true renders QueueReadErrorState and no fixture data for every Schedule/Sent view', () => {
  setupMounted();
  setMockQueryConfig({ isError: true });

  for (const { name, component, channel, view } of ALL_ERROR_VIEWS) {
    // 1. Direct view component rendering
    const vnode = component({ standalone: false });
    const vnodeStr = JSON.stringify(vnode);

    assert.ok(
      vnodeStr.includes("Can't read this project's queue here."),
      `${name} renders exact error state text when isError:true`
    );
    assert.ok(
      vnode.values && vnode.values.includes(QueueReadErrorState),
      `${name} returns QueueReadErrorState element`
    );

    // Verify NO fixture content leaks into the rendered error view
    assert.ok(!vnodeStr.includes("Valentim de Carvalho"), `${name} does not leak fixture names`);
    assert.ok(!vnodeStr.includes("Schema patches that unblocked"), `${name} does not leak fixture subjects`);
    assert.ok(!vnodeStr.includes("Investor Update"), `${name} does not leak fixture newsletter`);
    assert.ok(!vnodeStr.includes("Lead Engineer"), `${name} does not leak fixture sequence roles`);

  }
});

test('6. useQuery options: mounted views have enabled:true and NO fixture placeholderData; standalone allows fixtures', () => {
  for (const { name, component } of ALL_ERROR_VIEWS) {
    // A. Mounted semantics: enabled is true, NO fixture placeholderData
    setupMounted();
    setMockQueryConfig({ isError: false });
    component({ standalone: false });
    const callsMounted = getQueryCalls();
    assert.ok(callsMounted.length > 0, `${name} invoked useQuery when mounted`);
    const primaryMounted = callsMounted[0];
    assert.equal(
      primaryMounted.enabled,
      true,
      `${name} has enabled=true when mounted`
    );
    assert.equal(
      primaryMounted.placeholderData,
      undefined,
      `${name} has NO fixture placeholderData when mounted`
    );

    // B. Standalone semantics: enabled is false (no host DB calls), fixture placeholderData allowed
    setupStandalone();
    setMockQueryConfig({ isError: false });
    component({ standalone: true });
    const callsStandalone = getQueryCalls();
    assert.ok(callsStandalone.length > 0, `${name} invoked useQuery in standalone`);
    const primaryStandalone = callsStandalone[0];
    assert.equal(
      primaryStandalone.enabled,
      false,
      `${name} has enabled=false in standalone`
    );
    if (name !== 'NewsletterScheduleView') {
      assert.ok(
        primaryStandalone.placeholderData !== undefined,
        `${name} allows fixture placeholderData in standalone`
      );
    }
  }
});

test('7. TanStack QueryClient retry predicate & isPermissionRefusal', () => {
  // Permission refusal cases -> true
  assert.equal(isPermissionRefusal({ reason: 'scope-denied' }), true);
  assert.equal(
    isPermissionRefusal(new Error("host.dbQuery: pkg lacks the 'sqlite' capability")),
    true
  );
  assert.equal(
    isPermissionRefusal(new Error("host.dbQuery: table 'pa_action_drafts' not in the pkg's declared sqlite.tables")),
    true
  );

  // Non-refusal cases -> false
  assert.equal(isPermissionRefusal(new Error("network timeout")), false);
  assert.equal(isPermissionRefusal(new Error("database disk image is malformed")), false);
  assert.equal(isPermissionRefusal(null), false);
  assert.equal(isPermissionRefusal(undefined), false);
  assert.equal(isPermissionRefusal(''), false);

  // queryRetry predicate behavior:
  // Immediate abort (0 retries) on permission refusal
  assert.equal(queryRetry(0, { reason: 'scope-denied' }), false);
  assert.equal(
    queryRetry(0, new Error("host.dbQuery: table 'pa_action_drafts' not in the pkg's declared sqlite.tables")),
    false
  );
  // Other transient errors retry once at failureCount=0, stop at failureCount=1
  assert.equal(queryRetry(0, new Error("network timeout")), true);
  assert.equal(queryRetry(1, new Error("network timeout")), false);
  assert.equal(queryRetry(2, new Error("network timeout")), false);

  // queryClient configuration
  assert.equal(queryClient.defaultOptions.queries.retry, queryRetry);
  assert.equal(queryClient.defaultOptions.queries.retry(0, { reason: 'scope-denied' }), false);
  assert.equal(queryClient.defaultOptions.queries.retry(0, new Error("timeout")), true);
});

test('7b. hostDbQuery propagates reason: "scope-denied" and fast-fails retry predicate', async () => {
  setBridgeAppForTesting({
    callServerTool: async () => ({
      content: [{ type: 'text', text: "host.dbQuery: table 'pa_action_drafts' not in the pkg's declared sqlite.tables" }],
      isError: true,
      structuredContent: {
        ok: false,
        reason: 'scope-denied',
        error: "host.dbQuery: table 'pa_action_drafts' not in the pkg's declared sqlite.tables",
      },
    }),
  });

  try {
    await assert.rejects(
      async () => {
        await hostDbQuery('SELECT 1 FROM pa_action_drafts');
      },
      (err) => {
        assert.equal(err.reason, 'scope-denied', 'Error carries reason: "scope-denied"');
        assert.equal(isPermissionRefusal(err), true, 'isPermissionRefusal detects the error');
        assert.equal(queryRetry(0, err), false, 'queryRetry returns false (0 retries)');
        return true;
      },
      'hostDbQuery propagates reason and refuses retries'
    );
  } finally {
    setBridgeAppForTesting(null);
  }
});

test('8. Secondary query functions error propagation in mounted vs standalone mode', async () => {
  // A. Mounted mode: DB errors must NOT be swallowed; they must propagate / reject
  setupMounted();

  // Simulated permission refusal
  setDbQueryForTesting(() => {
    const err = new Error("host.dbQuery: table 'pa_action_drafts' not in the pkg's declared sqlite.tables");
    err.reason = 'scope-denied';
    throw err;
  });

  await assert.rejects(
    () => fetchNewsletterHistory(),
    (err) => err.reason === 'scope-denied' || /sqlite\.tables/.test(err.message),
    'fetchNewsletterHistory propagates permission refusal when mounted'
  );


  // General DB error propagation
  setDbQueryForTesting(() => {
    throw new Error('database disk I/O error');
  });

  await assert.rejects(
    () => fetchNewsletterHistory(),
    /database disk I\/O error/,
    'fetchNewsletterHistory propagates general DB errors when mounted'
  );


  // B. Standalone mode: fallback to fixtures/empty without querying DB
  setupStandalone();
  setDbQueryForTesting(() => {
    throw new Error('Should not call DB in standalone mode');
  });

  const nlHistoryStandalone = await fetchNewsletterHistory();
  assert.ok(Array.isArray(nlHistoryStandalone) && nlHistoryStandalone.length > 0, 'Standalone returns fixture newsletter history');
});

test('11. RecipientCohort shows neutral "Not available yet" when mounted', () => {
  const dummySeq = { id: 'seq-1', name: 'Onboarding Sequence', slug: 'onboarding' };

  // B. RecipientCohort mounted with empty list
  setupMounted();
  setMockQueryConfig({ isError: false, data: [] });
  const cohortMounted = RecipientCohort({ sequenceKey: 'seq-1', fallback: [], standalone: false });
  const cohortMountedStr = JSON.stringify(cohortMounted);
  assert.ok(
    cohortMountedStr.includes('Not available yet'),
    'RecipientCohort renders "Not available yet" when mounted with no recipients'
  );
  assert.ok(
    !cohortMountedStr.includes('No recipients enrolled'),
    'RecipientCohort NEVER claims "No recipients enrolled" when mounted'
  );

  // RecipientCohort standalone
  setupStandalone();
  const cohortStandalone = RecipientCohort({ sequenceKey: 'seq-1', fallback: [], standalone: true });
  const cohortStandaloneStr = JSON.stringify(cohortStandalone);
  assert.ok(
    cohortStandaloneStr.includes('No recipients enrolled'),
    'RecipientCohort preserves "No recipients enrolled" in standalone'
  );
  resetMockQuery();
});

test('12. Sidebar + Inbox tab render "—" on a counts read error', () => {
  const counts = { total: 6, kinds: { email: 3, newsletter: 1, social: 1, sequence: 1 }, agents: { pa: 3, cmo: 2, cbo: 1 } };
  const menuErr = buildOutboundMenu('inbox', counts, null, true);
  for (const item of menuErr.filter((i) => i.section !== 'Outbox' || i.id === 'v:inbox')) {
    assert.equal(item.badge, '—', `Menu item ${item.id} has badge "—" on countsError`);
    assert.equal(item.title, undefined, `Menu item ${item.id} has no title field (not supported by PkgMenuItem)`);
    if (item.hot !== undefined) assert.equal(item.hot, false, `Menu item ${item.id} hot indicator is false on error`);
  }
  const menuOk = buildOutboundMenu('inbox', counts, { kinds: ['email'], agents: [] }, false);
  const emailItem = menuOk.find((i) => i.id === 'ch:email');
  assert.equal(emailItem.badge, 3);
  assert.equal(emailItem.active, true, 'channel item is active when the inbox is faceted to it');
  assert.equal(menuOk.find((i) => i.id === 'v:inbox').active, false, 'plain Inbox is not active while faceted');
  assert.equal(menuOk.find((i) => i.id === 'f:cmo').badge, 2);

  setupMounted();
  globalThis.__mockUseQuery = (options) => {
    if (options.queryKey[0] === 'inbox') return { data: undefined, isLoading: false, isError: true, error: new Error('scope-denied') };
    return { data: [], isLoading: false, isError: false };
  };
  const obStr = JSON.stringify(OutboundView({ activeFeature: 'v:newsletter' }));
  assert.ok(obStr.includes('title=\\"Can\'t read this project\'s queue here\\"'), 'Inbox tab badge carries the read-error title');
  resetMockQuery();
});

test('13. Deep-link + sidebar tokens resolve to tab + inbox facets', () => {
  assert.deepEqual(resolveTarget('v:approvals'), { tab: 'inbox', preset: { kinds: [], agents: [] } });
  assert.deepEqual(resolveTarget('newsletter'), { tab: 'inbox', preset: { kinds: ['newsletter'], agents: [] }, channel: 'newsletter' });
  assert.deepEqual(resolveTarget('ch:sequences').preset.kinds, ['sequence']);
  assert.deepEqual(resolveTarget('f:CMO').preset.agents, ['cmo']);
  assert.deepEqual(resolveTarget('v:sent'), { tab: 'sent' });
  assert.deepEqual(resolveTarget('v:schedule'), { tab: 'schedule' });
  assert.equal(resolveTarget('v:nonsense'), null);
  assert.equal(resolveTarget(undefined), null);
});

test('14. Inbox reads through host.paActions.list; falls back to host.dbQuery only on an old shell', async () => {
  setupMounted();
  const row = sampleDbRow({ id: 'r-host' });
  const camel = { id: row.id, batchId: row.batch_id, status: row.status, channel: row.channel, payloadJson: row.payload_json, editedJson: null };
  const calls = [];
  setBridgeAppForTesting({
    callServerTool: async ({ name, arguments: args }) => {
      calls.push([name, args]);
      return { structuredContent: { ok: true, rows: [camel], inShare: true } };
    },
  });
  try {
    const res = await fetchInboxRows();
    assert.equal(res.source, 'host');
    assert.equal(res.inShare, true, 'share flag carried through');
    assert.equal(res.rows[0].id, 'r-host');
    assert.equal(calls[0][0], 'host.paActions.list');

    // A real refusal propagates (no silent DB fallback that would bypass the broker).
    setBridgeAppForTesting({ callServerTool: async () => ({ isError: true, structuredContent: { ok: false, error: 'not an Operator in this share' } }) });
    await assert.rejects(() => fetchInboxRows(), /not an Operator/);

    // Old shell: unknown verb → local DB read.
    setBridgeAppForTesting({
      callServerTool: async ({ name }) => (name === 'host.paActions.list'
        ? { isError: true, content: [{ type: 'text', text: 'unknown host tool: host.paActions.list' }] }
        : { structuredContent: { ok: true, rows: [row] } }),
    });
    const legacy = await fetchInboxRows();
    assert.equal(legacy.source, 'db');
    assert.equal(legacy.inShare, false);
  } finally {
    setBridgeAppForTesting(null);
  }
});

test('15. InboxView mounted + read error renders an error state, never fixture rows', () => {
  setupMounted();
  setMockQueryConfig({ isError: true });
  const str = JSON.stringify(InboxView({ standalone: false }));
  assert.ok(str.includes("Can't read the outbox queue here."), 'renders error copy');
  assert.ok(!str.includes('Valentim'), 'no fixture leakage');
  resetMockQuery();
});
