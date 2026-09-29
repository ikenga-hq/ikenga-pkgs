/**
 * End-to-end tests for `OpenRouterHttpEngine` (WP-20) against a local mock
 * OpenRouter SSE server (node:http). No real API key or network access needed.
 *
 * The mock replays recorded-shape `/chat/completions` streaming responses —
 * including OpenRouter's `: OPENROUTER PROCESSING` keep-alive comments, CRLF
 * framing, the post-finish usage chunk, and `data: [DONE]` — for three
 * scenarios selected by the request's `model` field:
 *   - `mock/reasoning`     G-54 field form (`delta.reasoning`)
 *   - `mock/think-inline`  G-54 inline form (`<think>` tags split across events)
 *   - `mock/tools`         OpenAI tool_calls delta shape split across events
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { EngineEvent } from '@ikenga/contract/engine';
import { OpenRouterHttpEngine } from './http-engine.js';

// ── Recorded-shape SSE scripts ──────────────────────────────────────────────

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  sse({
    id: 'gen-mock',
    object: 'chat.completion.chunk',
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
const usageChunk = (prompt: number, completion: number) =>
  sse({
    id: 'gen-mock',
    object: 'chat.completion.chunk',
    model: 'mock',
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  });

const SCRIPTS: Record<string, string[]> = {
  'mock/reasoning': [
    ': OPENROUTER PROCESSING\r\n\r\n',
    chunk({ role: 'assistant', reasoning: 'Consider the ' }),
    chunk({ reasoning: 'question carefully. ' }),
    chunk({ content: 'The answer ' }),
    chunk({ content: 'is 42.' }),
    chunk({}, 'stop'),
    usageChunk(11, 7),
    'data: [DONE]\r\n\r\n',
  ],
  'mock/think-inline': [
    ': OPENROUTER PROCESSING\r\n\r\n',
    chunk({ role: 'assistant', content: 'Sure. <thi' }),
    chunk({ content: 'nk>weigh the opt' }),
    chunk({ content: 'ions</th' }),
    chunk({ content: 'ink>Go with B.' }),
    chunk({}, 'stop'),
    usageChunk(9, 12),
    'data: [DONE]\r\n\r\n',
  ],
  'mock/tools': [
    ': OPENROUTER PROCESSING\r\n\r\n',
    chunk({
      role: 'assistant',
      tool_calls: [
        { index: 0, id: 'call_w1', type: 'function', function: { name: 'get_weather', arguments: '' } },
      ],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"Lagos"}' } }] }),
    chunk({}, 'tool_calls'),
    usageChunk(20, 5),
    'data: [DONE]\r\n\r\n',
  ],
};

// ── Mock server ─────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;
let lastAuthHeader: string | undefined;

before(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      lastAuthHeader = req.headers.authorization;
      const parsed = JSON.parse(body) as { model: string; stream: boolean };
      if (lastAuthHeader !== 'Bearer test-key-123') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }));
        return;
      }
      const script = SCRIPTS[parsed.model];
      if (!script) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `not a valid model ID: ${parsed.model}`, code: 400 } }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const piece of script) res.write(piece);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function collect(model: string, apiKey = 'test-key-123'): Promise<EngineEvent[]> {
  const engine = new OpenRouterHttpEngine({ apiKey, baseUrl, model });
  const session = await engine.startSession({ systemPrompt: 'You are terse.' });
  const events: EngineEvent[] = [];
  for await (const ev of engine.stream(session, 'hello')) events.push(ev);
  return events;
}

// ── Scenario assertions ─────────────────────────────────────────────────────

test('scenario A — reasoning delta form → thinking_delta stream, then message, usage, done', async () => {
  const events = await collect('mock/reasoning');
  assert.deepEqual(events, [
    { type: 'thinking_delta', text: 'Consider the ' },
    { type: 'thinking_delta', text: 'question carefully. ' },
    { type: 'message_delta', text: 'The answer ' },
    { type: 'message_delta', text: 'is 42.' },
    { type: 'usage', inputTokens: 11, outputTokens: 7 },
    { type: 'done', reason: 'stop' },
  ]);
  assert.equal(lastAuthHeader, 'Bearer test-key-123');
});

test('scenario B — inline <think> form (tags split across SSE events) → thinking_delta', async () => {
  const events = await collect('mock/think-inline');
  assert.deepEqual(events, [
    { type: 'message_delta', text: 'Sure. ' },
    { type: 'thinking_delta', text: 'weigh the opt' },
    { type: 'thinking_delta', text: 'ions' },
    { type: 'message_delta', text: 'Go with B.' },
    { type: 'usage', inputTokens: 9, outputTokens: 12 },
    { type: 'done', reason: 'stop' },
  ]);
});

test('scenario C — tool-call deltas accumulate into one tool_use with parsed input', async () => {
  const events = await collect('mock/tools');
  assert.deepEqual(events, [
    { type: 'tool_use', tool: 'get_weather', input: { city: 'Lagos' }, toolUseId: 'call_w1' },
    { type: 'usage', inputTokens: 20, outputTokens: 5 },
    { type: 'done', reason: 'stop' },
  ]);
});

test('auth failure surfaces as a done/error event (key never echoed)', async () => {
  const events = await collect('mock/reasoning', 'wrong-key');
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.type, 'done');
  assert.equal((ev as { reason: string }).reason, 'error');
  const msg = (ev as { error?: string }).error ?? '';
  assert.match(msg, /401/);
  assert.ok(!msg.includes('wrong-key'), 'error message must not echo the key');
});

test('missing key short-circuits with a settings hint, no network call', async () => {
  const engine = new OpenRouterHttpEngine({ baseUrl, model: 'mock/reasoning', apiKey: undefined });
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const session = await engine.startSession({});
    const events: EngineEvent[] = [];
    for await (const ev of engine.stream(session, 'hi')) events.push(ev);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'done');
    assert.match((events[0] as { error?: string }).error ?? '', /OPENROUTER_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
});

test('multi-turn: assistant reply (message text only) lands in session history', async () => {
  const engine = new OpenRouterHttpEngine({ apiKey: 'test-key-123', baseUrl, model: 'mock/reasoning' });
  const session = await engine.startSession({ systemPrompt: 'sys' });
  for await (const _ of engine.stream(session, 'first')) {
    /* drain */
  }
  // Second turn hits the mock again; capture the request body via a one-off fetch spy.
  let capturedBody: string | undefined;
  const engine2 = new OpenRouterHttpEngine({
    apiKey: 'test-key-123',
    baseUrl,
    model: 'mock/reasoning',
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return fetch(input, init);
    }) as typeof fetch,
  });
  const s2 = await engine2.startSession({ systemPrompt: 'sys' });
  for await (const _ of engine2.stream(s2, 'first')) {
    /* drain */
  }
  for await (const _ of engine2.stream(s2, 'second')) {
    /* drain */
  }
  const parsed = JSON.parse(capturedBody!) as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(
    parsed.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
  // Assistant history contains only message text — no reasoning tokens.
  assert.equal(parsed.messages[2]!.content, 'The answer is 42.');
});
