/**
 * OpenRouter SSE Streaming Normalizer (WP-20, G-54).
 *
 * Normalizes OpenRouter SSE streaming chunks into standard EngineEvent types:
 *   - `delta.content`                    → `{ type: 'message_delta', text }`
 *   - `delta.reasoning` / `delta.thinking` → `{ type: 'thinking_delta', text }` (G-54, field form)
 *   - inline `<think>…</think>` in `delta.content` → `thinking_delta` (G-54, inline form —
 *     DeepSeek R1 distills / Qwen QwQ emit thinking this way when the provider does not
 *     split it into a `reasoning` field; tags may span chunk boundaries)
 *   - `delta.tool_calls` (OpenAI delta shape: first fragment carries `id` + `function.name`,
 *     later fragments carry only `index` + `function.arguments` pieces) → accumulated and
 *     emitted as `{ type: 'tool_use', tool, input, toolUseId }` when the turn finishes
 *   - `usage`                            → `{ type: 'usage', inputTokens, outputTokens }`
 *   - `finish_reason`                    → `{ type: 'done', reason }`
 *
 * Two surfaces:
 *   - `OpenRouterStreamNormalizer` — stateful, the real transport path. Required for the
 *     inline `<think>` form (tags split across chunks) and for tool-call argument
 *     accumulation, both of which are impossible per-chunk.
 *   - `normalizeOpenRouterChunk` — the original stateless per-chunk generator, kept for
 *     back-compat with existing imports. It cannot handle cross-chunk state; prefer the
 *     class for anything that touches a live stream.
 */

import type { EngineEvent } from '@ikenga/contract/engine';

export interface OpenRouterDelta {
  content?: string | null;
  reasoning?: string | null;
  thinking?: string | null;
  tool_calls?: Array<{
    id?: string;
    index?: number;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface OpenRouterChoice {
  index: number;
  delta: OpenRouterDelta;
  finish_reason?: string | null;
}

export interface OpenRouterChunk {
  id?: string;
  choices?: OpenRouterChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: number | string;
  };
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Longest suffix of `s` that is a proper prefix of `tag` (possible partial tag at a chunk boundary). */
function partialTagSuffix(s: string, tag: string): string {
  const max = Math.min(tag.length - 1, s.length);
  for (let k = max; k >= 1; k--) {
    if (tag.startsWith(s.slice(s.length - k))) return s.slice(s.length - k);
  }
  return '';
}

interface PendingToolCall {
  id?: string;
  name?: string;
  args: string;
}

function mapFinishReason(reason: string): 'stop' | 'cancel' | 'error' {
  return reason === 'cancelled' || reason === 'canceled' ? 'cancel' : 'stop';
}

/**
 * Stateful normalizer for one OpenRouter streaming response.
 *
 * Feed every parsed SSE chunk through {@link push}; call {@link flush} once when the
 * stream ends (`data: [DONE]` or connection close) to release any held-back partial
 * `<think>` tag text and any tool call the provider never closed with a
 * `finish_reason`.
 */
export class OpenRouterStreamNormalizer {
  /** 'text' outside think tags, 'thinking' inside. */
  private mode: 'text' | 'thinking' = 'text';
  /** Held-back content suffix that may be the start of a split `<think>` / `</think>` tag. */
  private carry = '';
  /** Tool-call fragments accumulated by OpenAI delta `index`. */
  private readonly pendingToolCalls = new Map<number, PendingToolCall>();
  /**
   * `done` held back until {@link flush}: OpenRouter (with `usage:{include:true}`)
   * sends its usage-accounting chunk AFTER the `finish_reason` chunk, so emitting
   * `done` eagerly would drop the usage event on consumers that stop at `done`.
   */
  private pendingDone: EngineEvent | null = null;
  /** True once a terminal error `done` has been emitted — normalizer stops after that. */
  private errored = false;

  /** Normalize one parsed chunk into zero or more EngineEvents. */
  push(chunk: OpenRouterChunk): EngineEvent[] {
    if (this.errored) return [];
    const out: EngineEvent[] = [];

    if (chunk.error) {
      out.push(...this.drainContentCarry());
      out.push(...this.drainToolCalls());
      out.push({
        type: 'done',
        reason: 'error',
        error: chunk.error.message || 'OpenRouter API stream error',
      });
      this.errored = true;
      this.pendingDone = null;
      return out;
    }

    if (chunk.usage) {
      out.push({
        type: 'usage',
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      });
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta) {
        // Reasoning field form (G-54): DeepSeek R1 emits `delta.reasoning`,
        // Anthropic thinking models via some providers emit `delta.thinking`.
        const reasoningText = delta.reasoning ?? delta.thinking;
        if (reasoningText) {
          out.push({ type: 'thinking_delta', text: reasoningText });
        }

        // Content, with inline <think> splitting (G-54 inline form).
        if (delta.content) {
          out.push(...this.pushContent(delta.content));
        }

        // OpenAI-shape tool-call deltas: accumulate by index.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            let entry = this.pendingToolCalls.get(index);
            if (!entry) {
              entry = { args: '' };
              this.pendingToolCalls.set(index, entry);
            }
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        out.push(...this.drainContentCarry());
        out.push(...this.drainToolCalls());
        // Hold the done until flush() — a usage chunk may still follow.
        this.pendingDone = { type: 'done', reason: mapFinishReason(choice.finish_reason) };
      }
    }

    return out;
  }

  /**
   * End-of-stream drain (`data: [DONE]` or connection close). Returns any residual
   * events — held-back partial tag text, unclosed tool calls — followed by the
   * deferred `done` if the provider sent a `finish_reason`. When it returns no
   * `done`, the caller owns termination (synthesize `{type:'done', reason:'stop'}`).
   */
  flush(): EngineEvent[] {
    if (this.errored) return [];
    const out: EngineEvent[] = [];
    out.push(...this.drainContentCarry());
    out.push(...this.drainToolCalls());
    if (this.pendingDone) {
      out.push(this.pendingDone);
      this.pendingDone = null;
    }
    return out;
  }

  /** Whether a terminal error `done` has already been emitted. */
  get isFinished(): boolean {
    return this.errored;
  }

  /** Split a content delta on inline `<think>` / `</think>` tags, tolerating tags that span chunks. */
  private pushContent(content: string): EngineEvent[] {
    const out: EngineEvent[] = [];
    let s = this.carry + content;
    this.carry = '';

    for (;;) {
      const tag = this.mode === 'text' ? THINK_OPEN : THINK_CLOSE;
      const i = s.indexOf(tag);
      if (i !== -1) {
        const before = s.slice(0, i);
        if (before) out.push(this.contentEvent(before));
        this.mode = this.mode === 'text' ? 'thinking' : 'text';
        s = s.slice(i + tag.length);
        continue;
      }
      // No full tag: hold back a suffix that could be the start of one.
      const partial = partialTagSuffix(s, tag);
      if (partial) {
        this.carry = partial;
        s = s.slice(0, s.length - partial.length);
      }
      if (s) out.push(this.contentEvent(s));
      return out;
    }
  }

  private contentEvent(text: string): EngineEvent {
    return this.mode === 'thinking'
      ? { type: 'thinking_delta', text }
      : { type: 'message_delta', text };
  }

  /** Release a held-back suffix that turned out not to be a tag after all. */
  private drainContentCarry(): EngineEvent[] {
    if (!this.carry) return [];
    const ev = this.contentEvent(this.carry);
    this.carry = '';
    return [ev];
  }

  /** Emit accumulated tool calls (index order) with fully-assembled JSON arguments. */
  private drainToolCalls(): EngineEvent[] {
    if (this.pendingToolCalls.size === 0) return [];
    const out: EngineEvent[] = [];
    const indices = [...this.pendingToolCalls.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const entry = this.pendingToolCalls.get(index)!;
      if (!entry.name) continue; // fragment stream never carried a name — nothing callable
      let input: unknown = entry.args;
      try {
        input = entry.args ? JSON.parse(entry.args) : {};
      } catch {
        // keep raw string if the provider sent unparseable/truncated JSON
      }
      out.push({
        type: 'tool_use',
        tool: entry.name,
        input,
        toolUseId: entry.id ?? `toolcall_${index}`,
      });
    }
    this.pendingToolCalls.clear();
    return out;
  }
}

/**
 * Normalizes a parsed OpenRouter SSE chunk into zero or more standard EngineEvents.
 *
 * @deprecated Stateless per-chunk view kept for back-compat. It cannot handle the
 * G-54 inline `<think>` form (tags span chunks) nor multi-chunk tool-call argument
 * deltas — use {@link OpenRouterStreamNormalizer} on live streams.
 */
export function* normalizeOpenRouterChunk(chunk: OpenRouterChunk): Generator<EngineEvent> {
  if (chunk.error) {
    yield {
      type: 'done',
      reason: 'error',
      error: chunk.error.message || 'OpenRouter API stream error',
    };
    return;
  }

  // 1. Token usage reporting
  if (chunk.usage) {
    yield {
      type: 'usage',
      inputTokens: chunk.usage.prompt_tokens ?? 0,
      outputTokens: chunk.usage.completion_tokens ?? 0,
    };
  }

  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (!delta) continue;

    // 2. Reasoning / Thinking delta (G-54)
    const reasoningText = delta.reasoning ?? delta.thinking;
    if (reasoningText) {
      yield { type: 'thinking_delta', text: reasoningText };
    }

    // 3. Message delta
    if (delta.content) {
      yield { type: 'message_delta', text: delta.content };
    }

    // 4. Tool call delta (only complete-in-one-chunk calls are visible statelessly)
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name && tc.id) {
          let parsedInput: unknown = tc.function.arguments;
          try {
            if (tc.function.arguments) {
              parsedInput = JSON.parse(tc.function.arguments);
            }
          } catch {
            // Keep raw string if partial
          }
          yield {
            type: 'tool_use',
            tool: tc.function.name,
            input: parsedInput,
            toolUseId: tc.id,
          };
        }
      }
    }

    // 5. Completion
    if (choice.finish_reason) {
      yield { type: 'done', reason: mapFinishReason(choice.finish_reason) };
    }
  }
}
