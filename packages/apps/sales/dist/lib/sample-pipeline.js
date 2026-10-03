// Opt-in sample pipeline. Nothing in this file runs on its own: the "Load sample
// pipeline" button in the empty state calls it, and the "Remove sample data"
// button undoes it.
//
// Marker: every sample row is written with source = 'sample'. The app does not
// use the `extra` column at all (it never reads or writes it), so there is no
// JSON in it to extend; `source` is a plain text column the app already reads,
// and the Won table shows it as the Source badge, so a sample row is labelled
// wherever it appears. Removal is a single DELETE on that marker, so a deal the
// person added themselves is never touched.
//
// Companies are invented. They are not real businesses and not tied to any
// industry. Dates are relative to the moment of loading, so the forecast
// always looks forward from today.

export const SAMPLE_SOURCE = 'sample';

const DAY_MS = 86_400_000;

// [id, company, title, stage, value, win_probability, next_action, next_action_mode, days_in_stage, expected_close_in_days]
const OPEN_SAMPLES = [
  ['sample-01', 'Fernhill Studio',    'Annual licence',          'lead',        6000,  0.10, 'Intro call',                  'confirm', 4,  75],
  ['sample-02', 'Larkspur & Co',      'Team workspace rollout',  'lead',        12000, 0.15, 'Qualify fit',                 'silent',  9,  90],
  ['sample-03', 'Tidewater Goods',    'Pilot programme',         'qualified',   18000, 0.35, 'Schedule demo',               'silent',  7,  60],
  ['sample-04', 'Quillon Works',      'Platform migration',      'qualified',   24000, 0.40, 'Send pilot scope',            'confirm', 13, 55],
  ['sample-05', 'Brightwater Labs',   'Multi-site agreement',    'proposal',    48000, 0.55, 'Send proposal for review',    'approve', 18, 40],
  ['sample-06', 'Harbor & Pine',      'Renewal and expansion',   'negotiation', 72000, 0.70, 'Pricing call',                'confirm', 16, 25],
  ['sample-07', 'Copperleaf Supply',  'Reseller terms',          'negotiation', 36000, 0.65, 'Review contract terms',       'approve', 28, 30],
  ['sample-08', 'Mosswood Trading',   'Enterprise onboarding',   'closing',     54000, 0.85, 'Countersign and provision',   'approve', 33, 10],
];

// [id, company, title, value, closed_days_ago]
const WON_SAMPLES = [
  ['sample-09', 'Juniper Row',      'Starter plan',      9000,  14],
  ['sample-10', 'Ardent Foundry',   'Annual plan',       22000, 35],
  ['sample-11', 'Kestrel Partners', 'Pilot conversion',  15000, 60],
];

const isoAt = (now, offsetDays) => new Date(now.getTime() + offsetDays * DAY_MS).toISOString();
const dateAt = (now, offsetDays) => isoAt(now, offsetDays).slice(0, 10);

/**
 * The sample rows, as plain objects keyed by column name.
 * @param {Date} [now]
 */
export function buildSampleDeals(now = new Date()) {
  const created = isoAt(now, 0);
  const open = OPEN_SAMPLES.map(
    ([id, company, title, stage, value, prob, nextAction, mode, daysInStage, closeIn]) => ({
      id,
      company,
      title,
      stage,
      value: String(value),
      currency: 'USD',
      source: SAMPLE_SOURCE,
      next_action: nextAction,
      next_action_mode: mode,
      win_probability: prob,
      expected_close_date: dateAt(now, closeIn),
      days_in_stage: daysInStage,
      stage_entered_date: isoAt(now, -daysInStage),
      last_contact: null,
      created_at: created,
      updated_at: created,
    }),
  );
  const won = WON_SAMPLES.map(([id, company, title, value, closedAgo]) => ({
    id,
    company,
    title,
    stage: 'won',
    value: String(value),
    currency: 'USD',
    source: SAMPLE_SOURCE,
    next_action: null,
    next_action_mode: null,
    win_probability: null,
    expected_close_date: null,
    days_in_stage: 0,
    stage_entered_date: isoAt(now, -closedAgo),
    // The Won view reads its "Closed" column from last_contact.
    last_contact: isoAt(now, -closedAgo),
    created_at: created,
    updated_at: created,
  }));
  return [...open, ...won];
}

const COLUMNS = [
  'id', 'company', 'title', 'stage', 'value', 'currency', 'source',
  'next_action', 'next_action_mode', 'win_probability', 'expected_close_date',
  'days_in_stage', 'stage_entered_date', 'last_contact', 'created_at', 'updated_at',
];

/**
 * One INSERT for every sample row, so loading is all-or-nothing. OR IGNORE
 * makes a second click harmless: the fixed ids already exist and are skipped.
 */
export function sampleInsertStatement(rows) {
  const placeholders = `(${COLUMNS.map(() => '?').join(', ')})`;
  const sql =
    `INSERT OR IGNORE INTO sales_deals (${COLUMNS.join(', ')}) VALUES ` +
    rows.map(() => placeholders).join(', ');
  const params = rows.flatMap((r) => COLUMNS.map((c) => r[c] ?? null));
  return { sql, params };
}
