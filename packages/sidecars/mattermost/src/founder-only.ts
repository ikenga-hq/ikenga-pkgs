/**
 * Drafts that are approved only in the Ikenga Outbox, by the founder, and never appear in Mattermost.
 *
 * The box job `company-update` writes one awaiting draft a month (id `company-update:YYYY-MM`, channel listmonk, investor
 * audience). Its body carries confidential investor figures, and the outbox channel is read by several people, so the card
 * flow skips it the same way it skips outreach (`isOutreachDraft`): never rendered, never stored, never acked. The sender
 * keeps offering it; the bridge simply does not look at it.
 */

/** `company-update`, `company_update`, `company update` and a run of those separators, in any casing. */
const COMPANY_UPDATE = /company[\s_-]*update/i;
const COMPANY_UPDATE_ID = /^company[\s_-]*update/i;

/**
 * Is this announced draft the founder-only company update? Decided on the id, and on `actionId` / `sourceKind` if a
 * sender sends them. The rendered text is never read: it is where the figures are. Every test fails towards "yes", as
 * `isOutreachDraft` does: a missing or oddly typed id or extra field counts as founder-only. The two rules are
 * independent; a draft is carded only when neither of them claims it. `renderedText` is accepted so the announcement can be
 * passed whole, and is never touched.
 */
export function isCompanyUpdateDraft(d: { draftId?: unknown; renderedText?: unknown; actionId?: unknown; sourceKind?: unknown }): boolean {
  if (typeof d.draftId !== 'string') return true;
  if (COMPANY_UPDATE_ID.test(d.draftId.trim())) return true; // `company-update:<YYYY-MM>`
  for (const extra of [d.actionId, d.sourceKind]) {
    if (extra === undefined) continue;
    if (typeof extra !== 'string' || COMPANY_UPDATE.test(extra)) return true;
  }
  return false;
}
