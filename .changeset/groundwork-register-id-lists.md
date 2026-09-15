---
"@ikenga/skill-groundwork": patch
---

Store `register-id --field k=[A,B]` as a list, and read the old string form everywhere.

`register-id` parses each `--field` value as JSON and falls back to the raw text. So
`--field depends_on=[WP-01]` (unquoted IDs, not valid JSON) was saved as the string
`"[WP-01]"`, and real anchors carry that shape. Three things broke on it:

- `issue-sync-data` iterated the string character by character, so dependent work
  packages never appeared as children and parent tasklists came out empty.
- `board-data` emitted `deps` as a string.
- The board crashed on `deps.join`.

A bracketed value that isn't JSON is now stored as a list of trimmed IDs. Every
reader of `depends_on` also accepts the legacy string, so existing anchors work
without a rewrite.
