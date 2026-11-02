---
"@ikenga/pkg-outbound": minor
---

Email attachments and source edits for social-queue posts.

- **Attachments on SMTP and Resend email drafts.**
  - Attach any file by https URL, rename it, or remove it. A saved list wins; otherwise the draft's images are proposed.
  - Whatever is listed when you approve is exactly what gets attached, and the consequence line shows "+ N attachments".
  - The sender fetches the files at send time, with a 10 MB total.
- **Social-queue posts (`item.social`) are now editable:** the text, one image, the first comment (not on X) and the schedule. The shell writes these edits into the queue entry and re-derives the post, so the sender still accepts it. Threads stay read-only.
