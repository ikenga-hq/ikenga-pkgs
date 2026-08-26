/**
 * OpenRouter HTTP engine (WP-20) — a real, self-contained transport.
 *
 * Unlike the CLI-wrapping engine pkgs (claude-code, codex, …) there is no child
 * process here: each `stream()` call opens one streaming HTTPS request to
 * OpenRouter's OpenAI-compatible `/chat/completions` endpoint and normalizes the
 * SSE chunks through `OpenRouterStreamNormalizer` into contract `EngineEvent`s.
 *
 * ── API-key binding ─────────────────────────────────────────────────────────
 * Interim (works today, zero shell changes): this pkg runs as a long-lived
 * sidecar and receives OPENROUTER_API_KEY via the F-9 settings-secret env
 * mechanism — the manifest declares a `type:"secret"` settings field with
 * `env:"OPENROUTER_API_KEY"`, the shell's SidecarSupervisor resolves it from
 * the Stronghold vault (`Scope::pkg`) and injects it into the child env on
 * every (re)spawn (`shell/src-tauri/src/pkg/lifecycle.rs` →
 * `resolve_settings_secret_env`). Hence the default key source below is
 * `process.env.OPENROUTER_API_KEY`.
 *
 * Permanent (first-class chat engine, per the WP-20a spike): the shell grows a
 * Rust HTTP-engine adapter (`engines/openrouter_http/` + an
 * `EngineHandle::OpenRouterHttp` registry variant) that resolves the key with
 * `read_secret_scoped` at prompt time — the key then lives only inside the
 * Rust process for the duration of the request and never enters any child env
 * or TS runtime. When that lands, this module's normalizer semantics
 * (stream.ts) are the porting spec; the constraint that matters is: the key
 * must never be persisted into session state or logged, which is why this
 * class only ever holds it in a private field and never echoes it in errors.
 */

import type {
  Engine,
  EngineEvent,
  EngineMetadata,
  McpServerSpec,
  Session,
  SessionOpts,
} from '@ikenga/contract/engine';

import { OpenRouterStreamNormalizer } from './stream.js';
import {
  DEFAULT_BASE_URL,
  streamChatCompletion,
  type ChatMessage,
  type StreamChatOptions,
} from './transport.js';

const ID = 'com.ikenga.engine-openrouter';
const VERSION = '0.1.0';

/** Fallback default only — model is free text end-to-end (Plan 24 §5.1: no pinned roster). */
// Matches `settings.schema[model].default` in manifest.json. The older
// `anthropic/claude-3.7-sonnet` slug was retired as stale in #100.
export const DEFAULT_MODEL = 'openrouter/auto';

export interface OpenRouterEngineConfig {
  /** Explicit key. Default: `process.env.OPENROUTER_API_KEY` (F-9 injection — see header). */
  apiKey?: string;
  /** Default model for new sessions (free text, forwarded verbatim). */
  model?: string;
  baseUrl?: string;
  /** OpenAI-shape tool definitions offered to the model on every turn. */
  tools?: unknown[];
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface SessionState {
  messages: ChatMessage[];
  model: string;
  abort?: AbortController;
}

class OpenRouterHttpSession implements Session {
  constructor(
    readonly id: string,
    private readonly engine: OpenRouterHttpEngine,
  ) {}

  async cancel(): Promise<void> {
    this.engine.cancelSession(this.id);
  }
}

export class OpenRouterHttpEngine implements Engine {
  readonly id = ID;
  readonly version = VERSION;

  /** Honest capability snapshot — mirrors manifest.json's `engine.capabilities`. */
  readonly metadata: EngineMetadata = {
    agentId: 'openrouter',
    display: 'OpenRouter Unified LLM',
    capabilities: {
      streaming: true,
      toolUse: true,
      thinking: true,
      artifacts: false,
      fileAttachments: false,
      imageInput: false,
      slashCommands: false,
      modelSwitching: true,
      promptCaching: false,
      agenticTools: false,
      mcp: false,
      sessionResume: false,
    },
    onboarding: {
      requiredVaultKeys: ['OPENROUTER_API_KEY'],
      requiredEnvVars: [],
      docsUrl: 'https://openrouter.ai/docs',
    },
  };

  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly config: OpenRouterEngineConfig = {}) {}

  private resolveApiKey(): string | undefined {
    // F-9: the shell injects the vault-held key into this sidecar's env on spawn.
    return this.config.apiKey ?? process.env.OPENROUTER_API_KEY ?? undefined;
  }

  async startSession(opts: SessionOpts): Promise<Session> {
    const sessionId = crypto.randomUUID();
    const messages: ChatMessage[] = [];
    if (opts.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    this.sessions.set(sessionId, {
      messages,
      model: opts.model ?? this.config.model ?? DEFAULT_MODEL,
    });
    return new OpenRouterHttpSession(sessionId, this);
  }

  stream(session: Session, input: string): AsyncIterable<EngineEvent> {
    const state = this.sessions.get(session.id);
    const run = (state ? this.runTurn(state, input) : this.missingSession(session.id));
    return { [Symbol.asyncIterator]: () => run };
  }

  /** @internal */
  cancelSession(sessionId: string): void {
    this.sessions.get(sessionId)?.abort?.abort();
  }

  private async *missingSession(id: string): AsyncGenerator<EngineEvent> {
    yield { type: 'done', reason: 'error', error: `Unknown session: ${id}` };
  }

  private async *runTurn(state: SessionState, input: string): AsyncGenerator<EngineEvent> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      yield {
        type: 'done',
        reason: 'error',
        error:
          'OPENROUTER_API_KEY is not set. Add the key in Settings → OpenRouter Engine ' +
          '(stored in the vault and injected via the settings-secret env mechanism).',
      };
      return;
    }

    state.messages.push({ role: 'user', content: input });

    const abort = new AbortController();
    state.abort = abort;

    const normalizer = new OpenRouterStreamNormalizer();
    let assistantText = '';
    let doneEmitted = false;

    const opts: StreamChatOptions = {
      apiKey,
      model: state.model,
      messages: state.messages,
      baseUrl: this.config.baseUrl ?? DEFAULT_BASE_URL,
      tools: this.config.tools,
      extraBody: this.config.extraBody,
      extraHeaders: this.config.extraHeaders,
      signal: abort.signal,
      fetchImpl: this.config.fetchImpl,
    };

    try {
      for await (const chunk of streamChatCompletion(opts)) {
        for (const ev of normalizer.push(chunk)) {
          if (ev.type === 'message_delta') assistantText += ev.text;
          if (ev.type === 'done') doneEmitted = true;
          yield ev;
        }
        if (normalizer.isFinished) break;
      }
      if (!doneEmitted) {
        // Stream ended — drain residue (and the deferred done, if any finish_reason
        // was seen; the normalizer holds it back so trailing usage chunks survive).
        for (const ev of normalizer.flush()) {
          if (ev.type === 'message_delta') assistantText += ev.text;
          if (ev.type === 'done') doneEmitted = true;
          yield ev;
        }
        if (!doneEmitted) {
          yield { type: 'done', reason: 'stop' };
          doneEmitted = true;
        }
      }
    } catch (err) {
      if (!doneEmitted) {
        for (const ev of normalizer.flush()) {
          if (ev.type === 'done') continue; // the catch owns the terminal event
          if (ev.type === 'message_delta') assistantText += ev.text;
          yield ev;
        }
        if (abort.signal.aborted) {
          yield { type: 'done', reason: 'cancel' };
        } else {
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'done', reason: 'error', error: message };
        }
      }
    } finally {
      state.abort = undefined;
      if (assistantText) {
        state.messages.push({ role: 'assistant', content: assistantText });
      }
    }
  }

  /**
   * Tool definitions are supplied at construction (`config.tools`) in this HTTP
   * adapter; MCP server registration requires a process/tool host the pkg does
   * not own. No-op by design — capability flag `mcp` is false.
   */
  async registerMcpServer(_spec: McpServerSpec): Promise<void> {
    /* no-op */
  }

  async unregisterMcpServer(_id: string): Promise<void> {
    /* no-op */
  }

  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    return this.resolveApiKey()
      ? { ok: true }
      : { ok: false, reason: 'OPENROUTER_API_KEY not set' };
  }
}

export function createHttpEngine(config?: OpenRouterEngineConfig): Engine {
  return new OpenRouterHttpEngine(config);
}
