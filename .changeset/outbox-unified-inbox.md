---
"@ikenga/pkg-outbound": minor
---

Redesign the Outbox as one unified triage inbox.

- **One queue for every channel.** Email, newsletter, social and sequence drafts sit in a single list, ordered by urgency: Needs attention → Overdue → Today → This week → Later → No schedule → Approved. This replaces the four per-channel approval queues and the cross-channel Approvals tab.
- **Filters.** Search, sort, and facets for type, destination (monochrome brand marks), status, agent, has-images and sequence.
- **Keyboard.** J/K, X, /, E, ⌘S, ⌘↵, R, U and ? (shortcut sheet).
- **Bulk approve and reject**, sharing one undo window.
- **Detail view that adapts to the draft's kind:**
  - recipients, sender and provider, reply-to, reschedule, and draft provenance
  - failed, overdue, approved, ledger and outreach callouts
  - quality checks plus CRM reply intelligence
  - sequence step rail with "View sequence"
- **Images.**
  - Thumbnail strips on rows.
  - A lightbox that can reorder, remove and open images.
  - An attached-media editor: drag to reorder, attach by URL.
  - Faithful per-platform previews: LinkedIn and Facebook feed grids, X and Bluesky tile grids and threads, the Instagram square carousel, and first comments.
  - Images inline in email and newsletter bodies are surfaced too.
- **Social fan-out is approved as a whole.** Every platform row commits, not just the first. Each platform can be excluded or edited on its own, and caps, Instagram's image requirement and per-platform image limits block Approve.
- **The editor only offers what the sender actually sends** (`editCaps`).
  - Hashtags live in the text.
  - SMTP and Resend attach no images.
  - listmonk sends no A/B subject or preheader; those fields are shown read-only with a note.
  - Queue-built social posts (`item.social`) take body edits only.
- **Reject reasons are saved.** A new Sent → Rejected view lists drafts with their reasons.
- **Reads go through `host.paActions.list`**, so the inbox works inside a share: commits carry the `seen` row, and broker refusals show on the draft. Shells without the verb fall back to `host.dbQuery`.
- **Manifest:** `img-src https:` so remote media renders; the separate Approvals view is removed (`/approvals` still deep-links to the inbox); `/schedule` and `/sent` routes added.
