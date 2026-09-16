---
'@ikenga/pkg-engine-openrouter': minor
---

Real streaming HTTP transport for the OpenRouter engine (WP-20): SSE client for
the OpenAI-compatible `/chat/completions` endpoint, a stateful normalizer that
handles both G-54 reasoning forms (`delta.reasoning`/`delta.thinking` and inline
`<think>…</think>` tags split across chunks), OpenAI-shape tool_calls delta
accumulation, post-finish usage accounting, and API-key binding via the F-9
settings-secret env mechanism (`OPENROUTER_API_KEY`). Model stays free text —
no pinned roster.
