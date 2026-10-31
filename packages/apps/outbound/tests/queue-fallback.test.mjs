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
  SocialDetail,
  SequenceStepRail,
  RecipientCohort,
  fetchNewsletterHistory,
  fetchSocialFanout,
  buildOutboundMenu,
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
  FIXTURE_APPROVALS,
} = await import('../dist/features/outbound/outbound-view.js');

const { queryClient } = await import('../dist/app.js');

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
  { name: 'EmailQueueView', component: EmailQueueView, channel: 'email', view: 'queue' },
  { name: 'EmailScheduleView', component: EmailScheduleView, channel: 'email', view: 'schedule' },
  { name: 'EmailSentView', component: EmailSentView, channel: 'email', view: 'sent' },
  { name: 'NewsletterQueueView', component: NewsletterQueueView, channel: 'newsletter', view: 'queue' },
  { name: 'NewsletterScheduleView', component: NewsletterScheduleView, channel: 'newsletter', view: 'schedule' },
  { name: 'NewsletterSentView', component: NewsletterSentView, channel: 'newsletter', view: 'sent' },
  { name: 'SequencesQueueView', component: SequencesQueueView, channel: 'sequences', view: 'queue' },
  { name: 'SequencesActiveView', component: SequencesActiveView, channel: 'sequences', view: 'schedule' },
  { name: 'SequencesSentView', component: SequencesSentView, channel: 'sequences', view: 'sent' },
  { name: 'SocialQueueView', component: SocialQueueView, channel: 'social', view: 'queue' },
  { name: 'SocialScheduleView', component: SocialScheduleView, channel: 'social', view: 'schedule' },
  { name: 'SocialSentView', component: SocialSentView, channel: 'social', view: 'sent' },
  { name: 'CrossChannelApprovalsView', component: CrossChannelApprovalsView, channel: null, view: 'approvals' },
];

test('5. View wiring when mounted + isError:true renders QueueReadErrorState and no fixture data for all 13 views', () => {
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
      vnodeStr.includes("Open Outbox (/outbox/approvals)"),
      `${name} renders Open Outbox button in error state`
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

    // 2. ViewBody dispatcher routing
    const bodyVnode = ViewBody({ channel, view, standalone: false });
    const bodyStr = JSON.stringify(bodyVnode);
    assert.ok(
      bodyStr.includes(name),
      `ViewBody dispatches to ${name} for channel=${channel}, view=${view}`
    );
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
  assert.equal(isPermissionRefusal({ code: 'E_OWNER_ONLY' }), true);
  assert.equal(isPermissionRefusal({ code: 'E_SCOPE_DENIED' }), true);
  assert.equal(isPermissionRefusal({ code: 'E_FORBIDDEN' }), true);
  assert.equal(isPermissionRefusal(new Error("pkg lacks the 'sqlite' capability")), true);
  assert.equal(isPermissionRefusal(new Error("table 'pa_action_drafts' is not in pkg declared sqlite_tables")), true);
  assert.equal(isPermissionRefusal(new Error("permission denied: unauthorized")), true);
  assert.equal(isPermissionRefusal(new Error("E_OWNER_ONLY")), true);
  assert.equal(isPermissionRefusal(new Error("owner-only operation")), true);
  assert.equal(isPermissionRefusal(new Error("access denied")), true);

  // Non-refusal cases -> false
  assert.equal(isPermissionRefusal(new Error("network timeout")), false);
  assert.equal(isPermissionRefusal(new Error("database disk image is malformed")), false);
  assert.equal(isPermissionRefusal(null), false);
  assert.equal(isPermissionRefusal(undefined), false);
  assert.equal(isPermissionRefusal(''), false);

  // queryRetry predicate behavior:
  // Immediate abort (0 retries) on permission refusal
  assert.equal(queryRetry(0, { reason: 'scope-denied' }), false);
  assert.equal(queryRetry(0, { code: 'E_OWNER_ONLY' }), false);
  assert.equal(queryRetry(0, new Error("table is not in pkg declared sqlite_tables")), false);
  // Other transient errors retry once at failureCount=0, stop at failureCount=1
  assert.equal(queryRetry(0, new Error("network timeout")), true);
  assert.equal(queryRetry(1, new Error("network timeout")), false);
  assert.equal(queryRetry(2, new Error("network timeout")), false);

  // queryClient configuration
  assert.equal(queryClient.defaultOptions.queries.retry, queryRetry);
  assert.equal(queryClient.defaultOptions.queries.retry(0, { code: 'E_OWNER_ONLY' }), false);
  assert.equal(queryClient.defaultOptions.queries.retry(0, new Error("timeout")), true);
});

test('8. Secondary query functions error propagation in mounted vs standalone mode', async () => {
  // A. Mounted mode: DB errors must NOT be swallowed; they must propagate / reject
  setupMounted();

  // Simulated permission refusal
  setDbQueryForTesting(() => {
    const err = new Error("E_OWNER_ONLY: table 'pa_action_drafts' is not in pkg declared sqlite_tables");
    err.code = 'E_OWNER_ONLY';
    throw err;
  });

  await assert.rejects(
    () => fetchNewsletterHistory(),
    (err) => err.code === 'E_OWNER_ONLY' || /E_OWNER_ONLY/.test(err.message),
    'fetchNewsletterHistory propagates permission refusal when mounted'
  );

  await assert.rejects(
    () => fetchSocialFanout('test-batch-slug'),
    (err) => err.code === 'E_OWNER_ONLY' || /E_OWNER_ONLY/.test(err.message),
    'fetchSocialFanout propagates permission refusal when mounted'
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

  await assert.rejects(
    () => fetchSocialFanout('test-batch-slug'),
    /database disk I\/O error/,
    'fetchSocialFanout propagates general DB errors when mounted'
  );

  // B. Standalone mode: fallback to fixtures/empty without querying DB
  setupStandalone();
  setDbQueryForTesting(() => {
    throw new Error('Should not call DB in standalone mode');
  });

  const nlHistoryStandalone = await fetchNewsletterHistory();
  assert.ok(Array.isArray(nlHistoryStandalone) && nlHistoryStandalone.length > 0, 'Standalone returns fixture newsletter history');

  const socialFanoutStandalone = await fetchSocialFanout('test-batch-slug');
  assert.deepEqual(socialFanoutStandalone, [], 'Standalone returns empty fanout array without throwing');
});

test('9. SocialDetail fan-out error renders inline notice and NEVER falls back to default platforms', () => {
  // A. Mounted with fanout error
  setupMounted();
  globalThis.__mockUseQuery = (options) => {
    if (options.queryKey[0] === 'social' && options.queryKey[1] === 'fanout') {
      return { data: undefined, isLoading: false, isError: true, error: new Error('E_OWNER_ONLY') };
    }
    return { data: undefined, isLoading: false, isError: false };
  };

  const samplePost = {
    id: 'post-1',
    slug: 'post-batch-1',
    content: 'Draft content for social',
    scheduled_for: '2026-11-01T12:00:00Z',
    source: 'cmo-agent',
  };

  const vnodeMountedErr = SocialDetail({ post: samplePost, standalone: false });
  const strMountedErr = JSON.stringify(vnodeMountedErr);

  // Must show inline error message and title
  assert.ok(
    strMountedErr.includes("Can't read this project's queue here."),
    'SocialDetail renders inline error message when fanout query fails'
  );
  assert.ok(
    strMountedErr.includes('title=\\"Can\'t read this project\'s queue here\\"'),
    'SocialDetail renders tooltip title on fanout error'
  );
  // Must NOT render table or hallucinated default platform fan-out rows
  assert.ok(
    !strMountedErr.includes('so-fanout-table'),
    'SocialDetail does not render fanout table on error'
  );
  assert.ok(
    !strMountedErr.includes('3 rows') && !strMountedErr.includes('2 rows') && !strMountedErr.includes('1 row'),
    'SocialDetail fan-out header does not claim positive rows on error'
  );

  // B. Standalone fallback preserved
  setupStandalone();
  globalThis.__mockUseQuery = (options) => {
    return { data: undefined, isLoading: false, isError: false };
  };

  const vnodeStandalone = SocialDetail({ post: samplePost, standalone: true });
  const strStandalone = JSON.stringify(vnodeStandalone);

  assert.ok(
    strStandalone.includes('so-fanout-table'),
    'Standalone renders fallback platform rows table'
  );
  assert.ok(
    !strStandalone.includes("Can't read this project's queue here."),
    'Standalone does not render error notice'
  );
  resetMockQuery();
});

test('10. NewsletterQueueView history error renders compact indicator in Freshness and Prev. featured', () => {
  setupMounted();

  const mockNewsletterRow = {
    id: 'nl-row-1',
    recipient: 'Subscribers',
    subject: 'Weekly Dispatch #42',
    subject_b: 'Alternative Subject',
    preheader: 'Newsletter preview text',
    body: 'Hello subscribers, this is the newsletter body.',
    status: 'pending',
    channel: 'resend',
    newsletter_type: 'weekly_roundup',
    edition: 42,
    created_at: '2026-10-31T09:00:00Z',
  };

  // Mock: queue succeeds, history query fails with isError: true
  globalThis.__mockUseQuery = (options) => {
    if (options.queryKey[0] === 'newsletter' && options.queryKey[1] === 'history') {
      return { data: undefined, isLoading: false, isError: true, error: new Error('E_OWNER_ONLY') };
    }
    // Main queue query returns 1 item
    return { data: [mockNewsletterRow], isLoading: false, isError: false };
  };

  const vnodeErr = NewsletterQueueView({ standalone: false });
  const strErr = JSON.stringify(vnodeErr);

  // Verify scorecard cells have "Can't read this project's queue here"
  assert.ok(
    strErr.includes("Can't read this project's queue here"),
    'Newsletter quality scorecard renders compact error indicator when history read fails'
  );
  assert.ok(
    strErr.includes('—'),
    'Newsletter scorecard displays dash value for history metrics on error'
  );

  // Verify when history query succeeds
  globalThis.__mockUseQuery = (options) => {
    if (options.queryKey[0] === 'newsletter' && options.queryKey[1] === 'history') {
      return { data: [], isLoading: false, isError: false };
    }
    return { data: [mockNewsletterRow], isLoading: false, isError: false };
  };

  const vnodeOk = NewsletterQueueView({ standalone: false });
  const strOk = JSON.stringify(vnodeOk);
  assert.ok(
    !strOk.includes("Can't read this project's queue here"),
    'Newsletter scorecard does not display error message when history query succeeds'
  );

  resetMockQuery();
});

test('11. SequenceStepRail & RecipientCohort show neutral "Not available yet" when mounted', () => {
  const dummySeq = { id: 'seq-1', name: 'Onboarding Sequence', slug: 'onboarding' };

  // A. SequenceStepRail mounted with empty list
  setupMounted();
  setMockQueryConfig({ isError: false, data: [] });
  const railMounted = SequenceStepRail({ sequence: dummySeq, standalone: false });
  const railMountedStr = JSON.stringify(railMounted);
  assert.ok(
    railMountedStr.includes('Not available yet'),
    'SequenceStepRail renders "Not available yet" when mounted with no steps'
  );
  assert.ok(
    !railMountedStr.includes('No steps defined for this sequence yet'),
    'SequenceStepRail NEVER claims "No steps defined for this sequence yet" when mounted'
  );

  // SequenceStepRail standalone
  setupStandalone();
  const railStandalone = SequenceStepRail({ sequence: dummySeq, standalone: true });
  const railStandaloneStr = JSON.stringify(railStandalone);
  assert.ok(
    railStandaloneStr.includes('No steps defined for this sequence yet'),
    'SequenceStepRail preserves "No steps defined for this sequence yet" in standalone'
  );

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

test('12. Sidebar and tab badges render "—" with tooltip title on counts or agent read errors', () => {
  // A. buildOutboundMenu with countsError and agentsError
  const menuErr = buildOutboundMenu('newsletter', 'queue', { email: 5, newsletter: 2 }, { pa: 3 }, true, true);
  for (const item of menuErr) {
    assert.equal(
      item.badge,
      '—',
      `Menu item ${item.id} has badge "—" on countsError/agentsError`
    );
    assert.equal(
      item.title,
      "Can't read this project's queue here",
      `Menu item ${item.id} has title tooltip on error`
    );
    if (item.hot !== undefined) {
      assert.equal(item.hot, false, `Menu item ${item.id} hot indicator is false on error`);
    }
  }

  // Healthy menu
  const menuOk = buildOutboundMenu('newsletter', 'queue', { email: 5, newsletter: 2 }, { pa: 3 }, false, false);
  const emailItem = menuOk.find((i) => i.id === 'ch:email');
  assert.equal(emailItem.badge, 5);
  assert.equal(emailItem.title, undefined);
  assert.equal(emailItem.hot, true);

  // B. OutboundView rendering with counts query error
  setupMounted();
  globalThis.__mockUseQuery = (options) => {
    if (options.queryKey[0] === 'counts' || options.queryKey[0] === 'agents') {
      return { data: undefined, isLoading: false, isError: true, error: new Error('E_OWNER_ONLY') };
    }
    return { data: [], isLoading: false, isError: false };
  };

  const obView = OutboundView({ activeFeature: 'v:newsletter' });
  const obStr = JSON.stringify(obView);

  assert.ok(
    obStr.includes('title=\\"Can\'t read this project\'s queue here\\"'),
    'OutboundView renders tooltip title when counts error'
  );
  assert.ok(
    obStr.includes('— awaiting · — sequences active'),
    'OutboundView header displays "— awaiting · — sequences active" on counts error'
  );
  assert.ok(
    obStr.includes('nl-tab-count') && obStr.includes('—'),
    'OutboundView inner tabs render "—" badge on counts error'
  );

  resetMockQuery();
});


