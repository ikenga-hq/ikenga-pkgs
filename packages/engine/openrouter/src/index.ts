/**
 * OpenRouter Unified LLM Engine Adapter (WP-20).
 *
 * Implements the Engine and AcpEngine interfaces for OpenRouter.
 * Bridges reasoning tokens (`thinking_delta`), function tool calls, and model tier selection.
 */

import type {
  Engine,
  EngineEvent,
  HostBridge,
  Session,
  SessionOpts,
} from '@ikenga/contract/engine';

export * from './stream.js';
export * from './acp-engine.js';

const ID = 'com.ikenga.engine-openrouter';
const VERSION = '0.1.0';

class OpenRouterSession implements Session {
  constructor(
    readonly id: string,
    private readonly host: HostBridge,
  ) {}

  async cancel(): Promise<void> {
    await this.host.kill(this.id);
  }
}

export class OpenRouterEngine implements Engine {
  readonly id = ID;
  readonly version = VERSION;

  /**
   * Mirrors the `engine` block of this pkg's `manifest.json` — the contract
   * (`EngineMetadata`) says the shell + wizard may read either one, so the two
   * must agree. `src/manifest.test.mjs` asserts they do, field for field.
   *
   * Every flag below is what `openrouter_http::server` actually implements, not
   * what the OpenRouter API could theoretically do:
   *   - `artifacts` / `agenticTools` — the adapter streams text, thinking and
   *     `tool_calls` only; it renders no structured artifacts and executes no
   *     tools itself (a tool-call turn ends and the client runs them).
   *   - `fileAttachments` / `imageInput` — `extract_prompt_text` refuses image
   *     and audio prompt blocks; `PromptCapabilities` declares text +
   *     embedded-text context only.
   *   - `slashCommands` / `promptCaching` — not implemented.
   *   - `mcp` — the adapter connects to no MCP servers; tool defs arrive via
   *     `handle_set_tools`, which is not an MCP transport.
   */
  readonly metadata = {
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
      sessionResume: true,
    },
    onboarding: {
      requiredVaultKeys: ['OPENROUTER_API_KEY'],
      requiredEnvVars: [] as string[],
      authCommand: 'openrouter login',
      docsUrl: 'https://openrouter.ai/docs',
    },
  };

  constructor(private readonly host: HostBridge) {}

  async startSession(opts: SessionOpts): Promise<Session> {
    const sessionId = crypto.randomUUID();
    await this.host.spawn({
      sessionId,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
    });
    return new OpenRouterSession(sessionId, this.host);
  }

  stream(session: Session, input: string): AsyncIterable<EngineEvent> {
    const host = this.host;
    const id = session.id;
    return {
      [Symbol.asyncIterator]() {
        return (async function* () {
          await host.send(id, input);
          for await (const ev of host.listen(id)) {
            yield ev;
            if (ev.type === 'done') return;
          }
        })();
      },
    };
  }

  registerMcpServer(spec: any): Promise<void> {
    return this.host.registerMcp(spec);
  }

  unregisterMcpServer(id: string): Promise<void> {
    return this.host.unregisterMcp(id);
  }

  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
}

export function createEngine(host: HostBridge): Engine {
  return new OpenRouterEngine(host);
}
