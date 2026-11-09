/**
 * What a finished paid job cost, as the ledger recorded it (Part A finding A-7).
 *
 * `collect` used to print the provider-reported cost, which is 0 when the
 * provider reports none (fal), while the gate settles such a job at its
 * estimate. The message must agree with the money record, so it reads the
 * ledger entries of that job instead.
 */

import type { AkukoProject } from '../schema/akuko-project.ts';

export function ledgerCostLine(project: AkukoProject, jobId: string, reportedCost: number): string {
  const total = project.ledger
    .filter((e) => e.job === jobId && e.status === 'done')
    .reduce((sum, e) => sum + Math.round((e.actual ?? 0) * 1e6), 0) / 1e6;
  const cur = project.budget?.currency ?? 'USD';
  const text = `${Number(total.toFixed(4))} ${cur}`;
  return reportedCost > 0 ? `cost ${text}` : `cost ${text} (estimate; provider reported no cost)`;
}
