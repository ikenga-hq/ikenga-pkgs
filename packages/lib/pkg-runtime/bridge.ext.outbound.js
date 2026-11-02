
// ── pkg-specific bridge extension: com.ikenga.outbound (WP-19) ──────────────
// CONCATENATION FRAGMENT — appended verbatim after bridge.js (the core) by the
// vendor step. It relies on the core's module-scoped `app` binding and the
// `LOG_TAG` import at the top of the composed file; it is NOT a standalone
// module and must never be imported on its own. Keeps outbound's trusted-tier
// HTTP + approve-gate write surface working after the bridge core was shared.

/**
 * Trusted-tier outbound HTTP via the host's `host.fetch` verb (WP-04/WP-07).
 * The shell attaches the declared auth secret host-side (per the manifest
 * `capabilities.http.auth_secret` → `capabilities.secrets` → Stronghold vault)
 * and enforces the `permissions.net` URL allowlist; the secret is NEVER echoed
 * back in the response. `body` comes back as a STRING — callers JSON.parse it.
 *
 * req: { url, method?, headers?, body?, timeout? }
 * → { ok, status?, headers?, body?, truncated?, bytes?, reason? }
 *
 * Throws if the bridge isn't connected OR the host doesn't implement host.fetch
 * (old/untrusted shell) — callers MUST catch and fall back. We do NOT swallow
 * the error here so callers can distinguish "no host.fetch" from "no match".
 */
export async function hostFetch(req) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — host.fetch unavailable`);
  const res = await app.callServerTool({
    name: 'host.fetch',
    arguments: req,
  });
  const sc = res?.structuredContent;
  if (!sc) {
    throw new Error(res?.content?.[0]?.text ?? 'host.fetch returned no structuredContent');
  }
  return sc;
}

// ── Approve-gate verbs (host.paActions*) — the folded approve-gate write path. ──
// Strategy B (plans/outbound-pkg/01-plan.md §G-PAACTIONS): four thin verbs the
// shell wraps over the existing, tested `pa_actions_*` Rust commands, gated by
// the pkg declaring `capabilities.paActions === true`. The pkg never gets raw
// write access to pa_action_drafts — commit/event/wake/normalization stay
// shell-owned. Each verb operates on the pa_action_drafts row `id` (NOT a legacy
// table id) and resolves only when structuredContent.ok === true.

async function callPaAction(verb, args) {
  if (!app) throw new Error(`[${LOG_TAG}] bridge not connected — host.paActions.${verb} unavailable`);
  const res = await app.callServerTool({
    name: `host.paActions.${verb}`,
    arguments: args,
  });
  const sc = res?.structuredContent;
  if (!sc || sc.ok !== true) {
    throw new Error(sc?.error ?? res?.content?.[0]?.text ?? `host.paActions.${verb} failed`);
  }
  return sc;
}

/** Commit an approved draft → worker sends it for real. Inside a share,
 *  `seen` is the verbatim row the reviewer was shown (from hostPaActionsList);
 *  the box broker binds the ledger approval to exactly those bytes. */
export async function hostPaActionsCommit(draftId, seen) {
  return callPaAction('commit', seen ? { draftId, seen } : { draftId });
}

/** Reject a draft (will not send). `reason` is stored on the row
 *  (reject_reason) for the writer-agent training set. */
export async function hostPaActionsReject(draftId, reason) {
  return callPaAction('reject', reason ? { draftId, reason } : { draftId });
}

/** Retry a failed draft (failed → committed; clears claim/error + wakes worker). */
export async function hostPaActionsRetry(draftId) {
  return callPaAction('retry', { draftId });
}

/** Edit-in-place. `patch` keys (outbox redesign G-CONTRACT): subject, body,
 *  subjectB, preheader, firstComment, hashtags[], media{kind,imageUrls[]},
 *  scheduledIso. The backend shallow-MERGES into edited_json (send only what
 *  changed); scheduledIso also reschedules the row. awaiting → edited. */
export async function hostPaActionsUpdate(draftId, patch) {
  return callPaAction('update', { draftId, patch });
}

/** List drafts through the shell (outbox redesign D-07). Unlike host.dbQuery
 *  this is routed through the box broker inside a share, so an operator sees
 *  the OWNER's drafts there. `status` omitted = the active set.
 *  → { rows: PaActionDraftRow[] (camelCase), inShare: boolean } */
export async function hostPaActionsList(status) {
  const sc = await callPaAction('list', status ? { status } : {});
  return { rows: Array.isArray(sc.rows) ? sc.rows : [], inShare: sc.inShare === true };
}
