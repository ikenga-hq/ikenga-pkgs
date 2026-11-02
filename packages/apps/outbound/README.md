# @ikenga/pkg-outbound

**Outbox**: the one place outgoing communication waits for a human. Email, newsletter, social and sequence drafts produced by agents park in `pa_action_drafts`. Here they are reviewed, edited, approved, rescheduled or rejected, and the external send worker sends them.

## Overview

`com.ikenga.outbound` is a **no-build srcdoc iframe pkg** built on the `@ikenga/tokens` app-kit. It follows the same build pattern as `com.ikenga.tasks` and `com.ikenga.mail`.

The top-level views are **Inbox · Schedule · Sent**.

### Inbox: unified triage

A single list of every draft that needs a decision, across all channels.

- **Urgency sections.** Needs attention (failed) → Overdue → Today → This week → Later → No schedule → Approved · queued.
- **Facets.**
  - Type: email, newsletter, social, sequence.
  - Destination: brand marks for LinkedIn, X, Bluesky, Instagram, Facebook, SMTP, Resend, listmonk and Buffer.
  - Status, drafted-by agent, has-images and sequence.
  - Free-text search and sort.
- **Rows.** Kind mark, recipient, relative send time, subject, snippet, destination marks, chips, and an image thumbnail strip.
- **Adaptive detail.** It changes with the draft's kind:
  - **Email / sequence:** subject, body (rendered or edited for HTML), attachments, images in the body, quality checks, CRM reply intelligence and the sequence step rail.
  - **Newsletter:** subject, A/B subject, preheader, inbox-line preview, Review/Edit body with anti-pattern "fix in chat", the 8-cell scorecard and Skip cycle.
  - **Social:** a fan-out of platform rows treated as one post.
    - Include or exclude each platform, and edit all platforms at once or each one alone.
    - Character caps, hashtags, first comment and the media editor.
    - Per-platform previews: LinkedIn/Facebook feed grids, X/Bluesky tile grids and threads, and the Instagram carousel.
- **Images.** Thumbnails on rows, a lightbox (reorder, remove, open), drag-to-reorder tiles, and attach by URL. Remote images need the manifest's `img-src https:`.
- **Actions.**
  - Approve (⌘↵) with a 10 s undo window; bulk approve shares one window.
  - Reject with saved reasons, Retry for failed sends, Reschedule, and Send to chat.
  - **Only what the sender sends is editable** (`editCaps` in `inbox-model.js`, mirroring the deployed `ikenga-sender`):
    - Email, sequence and newsletter drafts: subject, body and schedule. SMTP, Resend and listmonk attach no images, and listmonk sends no A/B subject or preheader, so those fields are shown read-only with a note.
    - Social: body, images and first comment. Hashtags are part of the text, because only tags in the text are posted.
    - Social drafts built from the social queue (`item.social`): only the body (and not on threads). Every other field comes from the queue entry, and the sender refuses a post whose fields disagree with it.
  - Edits persist through `host.paActions.update`, which merges them into `edited_json`. On approve, the shell folds them into the payload, except for queue-built social drafts.
- **Keyboard.** J/K move, X selects, / searches, E edits, ⌘S saves, ⌘↵ approves, R rejects, U undoes, ? shows the shortcut sheet.
- **Share mode.** Reads go through `host.paActions.list`, which the box broker answers inside a share. Commits carry the reviewed row (`seen`), and broker refusals appear on the draft.

### Schedule

- **All:** an agenda across every channel; click an entry to open it in the inbox.
- **Per channel:** the two-week calendar (Email, Newsletter, Social) or the Active list (Sequences).

### Sent

History per channel, with deliverability stats and charts. **Rejected** lists rejected drafts with their stored reasons.

### Sidebar (`host.pkg.setMenu`)

| Group | Items | Click |
|---|---|---|
| Outbox | Inbox, Schedule, Sent | `v:<tab>` |
| Channels | Email, Newsletter, Social, Sequences | `ch:<channel>` facets the inbox to that type |
| Drafted by | one item per agent | `f:<agent>` facets the inbox to that agent |

The shell deep-links `/outbox/{approvals,email,newsletter,social,sequences,sent}` into this pkg. `resolveTarget()` maps each token to a tab plus inbox facets.

## Code map

| File | Role |
|---|---|
| `dist/lib/inbox-model.js` | Pure view-model: row normalisation, fan-out grouping, media, urgency, facets, sort, edit patches, approve guards. Unit-tested. |
| `dist/lib/brand-icons.js` | Monochrome destination marks (Simple Icons, CC0), inlined. |
| `dist/features/inbox/inbox-view.js` | Inbox list and adaptive detail, undo, bulk, keyboard, schedule agenda, rejected list. |
| `dist/features/inbox/inbox-media.js` | Thumbnails, lightbox, media editor, per-platform previews. |
| `dist/features/outbound/outbound-view.js` | Frame (tabs, sidebar, deep-links), Schedule and Sent views, shared quality, CRM and newsletter parts. |
| `dist/lib/derive.js` | `pa_action_drafts` → per-channel view-models for Schedule and Sent. |

## Data

Single source: `pa_action_drafts` (`payload_json = { item: DraftItem, meta }`, operator overrides in `edited_json`).

- **Reads:** `host.paActions.list`, falling back to `host.dbQuery` on older shells. `newsletter_sends` and `receivables` are read for the scorecard and CRM cells.
- **Writes:** only through `host.paActions.{commit,reject,retry,update}`.

## Build and test

```bash
# From ikenga-pkgs root
pnpm install
cd packages/apps/outbound && node scripts/build.mjs && pnpm test
```

The build vendors `tokens-css.js` and `app-kit-css.js` from `@ikenga/tokens`, codegens `outbound-css.js` from `dist/outbound.css`, and vendors `bridge.js` and `ui.js` from `@ikenga/pkg-runtime`. CSS rides the script path because WebKitGTK can't load subresources from the shell's `about:srcdoc`.

Open `dist/index.html` directly in a browser (it is standalone when not framed) to see the inbox with demo rows.

## Design reference

- `plans/outbox-redesign/01-plan.md` (meta-repo): locked decisions and the shell↔pkg contract
- `design/shell/concepts/03-screens/1[1-5]-outbox-*.html`: the earlier per-channel concepts this supersedes

## License

Apache-2.0. Brand marks are from Simple Icons (CC0-1.0); the trademarks belong to their owners.
