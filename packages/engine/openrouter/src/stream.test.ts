/**
 * Unit tests for `OpenRouterStreamNormalizer` (WP-20, G-54).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EngineEvent } from '@ikenga/contract/engine';
import { OpenRouterStreamNormalizer, type OpenRouterChunk } from './stream.js';

function run(chunks: OpenRouterChunk[]): EngineEvent[] {
  const n = new OpenRouterStreamNormalizer();
  const out: EngineEvent[] = [];
  for (const c of chunks) out.push(...n.push(c));
  out.push(...n.flush());
  return out;
}

function delta(d: Record<string, unknown>, finish?: string): OpenRouterChunk {
  return { choices: [{ index: 0, delta: d, finish_reason: finish ?? null }] };
}

test('reasoning field form (G-54): delta.reasoning and delta.thinking → thinking_delta', () => {
  const events = run([
    delta({ reasoning: 'step one. ' }),
    delta({ thinking: 'step two. ' }),
    delta({ content: 'The answer is 42.' }),
    delta({}, 'stop'),
  ]);
  assert.deepEqual(events, [
    { type: 'thinking_delta', text: 'step one. ' },
    { type: 'thinking_delta', text: 'step two. ' },
    { type: 'message_delta', text: 'The answer is 42.' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('inline <think> form (G-54): tags split across chunk boundaries', () => {
  const events = run([
    delta({ content: 'Hi. <thi' }),
    delta({ content: 'nk>secret pl' }),
    delta({ content: 'an</th' }),
    delta({ content: 'ink> Done.' }),
    delta({}, 'stop'),
  ]);
  assert.deepEqual(events, [
    { type: 'message_delta', text: 'Hi. ' },
    { type: 'thinking_delta', text: 'secret pl' },
    { type: 'thinking_delta', text: 'an' },
    { type: 'message_delta', text: ' Done.' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('inline <think>: partial-tag lookalike is released as content', () => {
  const events = run([
    delta({ content: 'a < b and <th' }),
    delta({ content: 'ree more' }),
    delta({}, 'stop'),
  ]);
  assert.deepEqual(events, [
    { type: 'message_delta', text: 'a < b and ' },
    { type: 'message_delta', text: '<three more' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('inline <think>: unclosed tag at stream end drains via flush', () => {
  const events = run([delta({ content: 'ok <think>half a thought' })]);
  assert.deepEqual(events, [
    { type: 'message_delta', text: 'ok ' },
    { type: 'thinking_delta', text: 'half a thought' },
  ]);
});

test('tool-call deltas (OpenAI shape) accumulate across chunks and emit once on finish', () => {
  const events = run([
    delta({
      tool_calls: [
        { index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } },
      ],
    }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":"La' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'gos","unit":"c"}' } }] }),
    delta({}, 'tool_calls'),
  ]);
  assert.deepEqual(events, [
    {
      type: 'tool_use',
      tool: 'get_weather',
      input: { city: 'Lagos', unit: 'c' },
      toolUseId: 'call_abc',
    },
    { type: 'done', reason: 'stop' },
  ]);
});

test('parallel tool calls keep separate accumulators per index', () => {
  const events = run([
    delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{"x"' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{"y"' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: ':2}' } }] }),
    delta({}, 'tool_calls'),
  ]);
  assert.deepEqual(events, [
    { type: 'tool_use', tool: 'a', input: { x: 1 }, toolUseId: 'c0' },
    { type: 'tool_use', tool: 'b', input: { y: 2 }, toolUseId: 'c1' },
    { type: 'done', reason: 'stop' },
  ]);
});

test('usage chunk AFTER finish_reason still surfaces before the deferred done', () => {
  const events = run([
    delta({ content: 'hi' }),
    delta({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } },
  ]);
  assert.deepEqual(events, [
    { type: 'message_delta', text: 'hi' },
    { type: 'usage', inputTokens: 12, outputTokens: 34 },
    { type: 'done', reason: 'stop' },
  ]);
});

test('error chunk terminates immediately with done/error', () => {
  const n = new OpenRouterStreamNormalizer();
  const events = n.push({ error: { message: 'rate limited', code: 429 } });
  assert.deepEqual(events, [{ type: 'done', reason: 'error', error: 'rate limited' }]);
  assert.equal(n.isFinished, true);
  assert.deepEqual(n.push(delta({ content: 'late' })), []);
  assert.deepEqual(n.flush(), []);
});
