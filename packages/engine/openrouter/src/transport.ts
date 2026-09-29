/**
 * OpenRouter streaming HTTP transport (WP-20).
 *
 * Speaks OpenRouter's OpenAI-compatible `POST /chat/completions` endpoint with
 * `stream: true` and parses the SSE response into {@link OpenRouterChunk}s.
 * Pure fetch + web-streams — no Node-only APIs — so the same code runs in a
 * Bun/Node sidecar today and can be ported line-for-line to the shell's Rust
 * adapter later (see the key-binding note in `http-engine.ts`).
 */

import type { OpenRouterChunk } from './stream.js';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** OpenAI-compatible chat message. `content` is a string for our purposes;
 *  tool messages carry `tool_call_id`. Kept deliberately loose — OpenRouter
 *  accepts the full OpenAI vocabulary and we do not want to re-validate it. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface StreamChatOptions {
  apiKey: string;
  /** Free-text OpenRouter model id (e.g. `deepseek/deepseek-r1`). No pinned
   *  roster by design (Plan 24 §5.1) — the string goes to the API verbatim. */
  model: string;
  messages: ChatMessage[];
  baseUrl?: string;
  /** OpenAI-shape tool definitions, passed through verbatim when present. */
  tools?: unknown[];
  /** Extra top-level body params (temperature, max_tokens, provider routing …). */
  extraBody?: Record<string, unknown>;
  /** Extra request headers (e.g. OpenRouter's `HTTP-Referer` / `X-Title` attribution). */
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Non-2xx response from the API. `body` is the (possibly JSON) error payload text. */
export class OpenRouterHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `OpenRouter API error ${status}: ${body.slice(0, 512)}`);
    this.name = 'OpenRouterHttpError';
  }
}

/**
 * POST a streaming chat completion and yield each parsed SSE chunk.
 *
 * Handles the realities of OpenRouter's SSE framing:
 *   - `: OPENROUTER PROCESSING` keep-alive comment lines (skipped per SSE spec)
 *   - one JSON object per `data:` line
 *   - `data: [DONE]` terminator
 *   - CRLF or LF line endings, data lines split across network reads
 *
 * Throws {@link OpenRouterHttpError} for non-2xx responses (auth, quota, bad
 * model id) before any chunk is yielded.
 */
export async function* streamChatCompletion(
  opts: StreamChatOptions,
): AsyncGenerator<OpenRouterChunk, void, void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    // Ask OpenRouter to append a usage-accounting chunk to the stream.
    usage: { include: true },
    ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    ...opts.extraBody,
  };

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter app-attribution headers (optional, override via extraHeaders).
      'HTTP-Referer': 'https://ikenga.dev',
      'X-Title': 'Ikenga',
      ...opts.extraHeaders,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* body unreadable — status alone will have to do */
    }
    throw new OpenRouterHttpError(res.status, text);
  }
  if (!res.body) {
    throw new OpenRouterHttpError(res.status, '', 'OpenRouter response had no body stream');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);

        if (!line || line.startsWith(':')) continue; // blank / SSE comment keep-alive
        if (!line.startsWith('data:')) continue; // ignore other SSE fields (event:, id:)

        const data = line.slice(5).trimStart();
        if (data === '[DONE]') return;

        let chunk: OpenRouterChunk;
        try {
          chunk = JSON.parse(data) as OpenRouterChunk;
        } catch {
          continue; // malformed line — skip rather than kill the stream
        }
        yield chunk;
      }
    }

    // Trailing data without a final newline (non-spec but seen in the wild).
    const tail = buffer.replace(/\r$/, '');
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trimStart();
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data) as OpenRouterChunk;
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
