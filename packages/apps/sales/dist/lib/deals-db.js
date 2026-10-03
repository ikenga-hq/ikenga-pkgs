// Writes (and the one count) that the Sales pane makes against `sales_deals`
// through the host's SQLite verbs. Reads of the pipeline itself stay in
// sales-view.js next to the views that use them.
//
// These all go through host.dbExec / host.dbQuery, which need no AI engine, so
// a deal can be added, moved and removed on a machine with no engine set up.

import { hostDbExec, hostDbQuery } from './bridge.js';
import {
  SAMPLE_SOURCE,
  buildSampleDeals,
  sampleInsertStatement,
} from './sample-pipeline.js';

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `deal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Add one deal. Only `company` and `stage` are needed (with the generated id,
 * they are the table's NOT NULL columns); everything else is written only when
 * the person filled it in, and is otherwise left NULL.
 *
 * @param {{ company: string, stage: string, title?: string, value?: number|null,
 *           expectedClose?: string, owner?: string|null }} input
 * @returns {Promise<string>} the new deal's id
 */
export async function createDeal(input) {
  const id = newId();
  const now = new Date().toISOString();
  const title = input.title?.trim() || null;
  const value = typeof input.value === 'number' && Number.isFinite(input.value) ? String(input.value) : null;
  await hostDbExec(
    'INSERT INTO sales_deals (id, company, title, stage, value, expected_close_date, owner, stage_entered_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.company.trim(),
      title,
      input.stage,
      value,
      input.expectedClose || null,
      input.owner ?? null,
      now,
      now,
      now,
    ],
  );
  return id;
}

/** Move a deal to another stage and restart its time-in-stage. */
export async function setDealStage(dealId, stage) {
  const now = new Date().toISOString();
  await hostDbExec(
    'UPDATE sales_deals SET stage = ?, stage_entered_date = ?, days_in_stage = 0, updated_at = ? WHERE id = ?',
    [stage, now, now, dealId],
  );
}

/** Write the labelled sample pipeline (see sample-pipeline.js). */
export async function loadSamplePipeline() {
  const { sql, params } = sampleInsertStatement(buildSampleDeals());
  await hostDbExec(sql, params);
}

/** Delete every sample row and nothing else. */
export async function removeSampleData() {
  await hostDbExec('DELETE FROM sales_deals WHERE source = ?', [SAMPLE_SOURCE]);
}

/** How many sample rows are in the table right now. */
export async function countSampleDeals() {
  const rows = await hostDbQuery('SELECT count(*) AS n FROM sales_deals WHERE source = ?', [SAMPLE_SOURCE]);
  return Number(rows[0]?.n ?? 0);
}

/** How many deals are at the lost stage (for the win-rate figure). */
export async function countLostDeals() {
  const rows = await hostDbQuery("SELECT count(*) AS n FROM sales_deals WHERE stage = 'lost'", []);
  return Number(rows[0]?.n ?? 0);
}
