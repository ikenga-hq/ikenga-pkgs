/**
 * Claude Code Engine adapter.
 *
 * Implements the `Engine` contract from `@ikenga/contract` by wrapping the
 * Claude Code CLI (`claude`) in streaming-input mode:
 *
 *   claude --print --input-format stream-json --output-format stream-json
 *          --verbose [--resume <id>]
 *
 * One long-lived child per session, stdin/stdout pipes (NOT a PTY — claude
 * rejects stream-json over a TTY).
 *
 * Process management is delegated to the host shell via Tauri commands the
 * shell exposes for engine pkgs (`claude_chat_spawn`, `claude_chat_send`,
 * `claude_chat_kill`, `claude_listen_session`). This keeps the adapter
 * portable: a future Codex / Aider engine implements the same `Engine`
 * interface against its own CLI, and the shell's session UI consumes events
 * uniformly.
 */

import type {
	Engine,
	EngineEvent,
	HostBridge,
	McpServerSpec,
	Session,
	SessionOpts,
} from '@ikenga/contract/engine';

const ID = 'com.ikenga.engine-claude-code';
const VERSION = '0.2.0';

/** Launch role the shell maps to a catalog default model (WP-11). */
export type ClaudeRole = 'chi' | 'pane' | 'plan';

/**
 * `SessionOpts` plus the Claude-specific launch options the shell's
 * `ClaudeOpts` accepts (ikenga commit 756b921). Both are optional: callers
 * typed against the plain contract `SessionOpts` keep working unchanged.
 */
export interface ClaudeSessionOpts extends SessionOpts {
	role?: ClaudeRole;
	pluginDirs?: string[];
}

/**
 * The payload handed to `HostBridge.spawn`: the contract's fields plus the
 * shell `ClaudeOpts` names (serde camelCase). The shell reads the system
 * prompt as `appendSystemPrompt` (→ `--append-system-prompt`), so it is sent
 * under that name; the contract's `systemPrompt` is kept for hosts that
 * still implement the contract shape literally.
 */
export type ClaudeSpawnOpts = Parameters<HostBridge['spawn']>[0] & {
	appendSystemPrompt?: string;
	role?: ClaudeRole;
	pluginDirs?: string[];
};

/**
 * Map session options to the spawn payload. Unset or empty options are
 * omitted, so a session without them spawns exactly as before (no
 * `--append-system-prompt`, no `--model`, no plugin dirs).
 *
 * No `role` default: the legacy `Engine` surface serves any caller pkg
 * (`callerPkg`), not specifically a pane, so the role is passed only when
 * the caller states it.
 */
export function buildSpawnOpts(sessionId: string, opts: ClaudeSessionOpts): ClaudeSpawnOpts {
	const out: ClaudeSpawnOpts = { sessionId };
	if (opts.cwd) out.cwd = opts.cwd;
	if (opts.systemPrompt) {
		out.systemPrompt = opts.systemPrompt;
		out.appendSystemPrompt = opts.systemPrompt;
	}
	if (opts.model) out.model = opts.model;
	if (opts.resumeSessionId) out.resumeSessionId = opts.resumeSessionId;
	if (opts.role) out.role = opts.role;
	const dirs = opts.pluginDirs?.filter((d) => d.length > 0);
	if (dirs && dirs.length > 0) out.pluginDirs = dirs;
	return out;
}

class ClaudeSession implements Session {
	constructor(
		readonly id: string,
		private readonly host: HostBridge,
	) {}

	async cancel(): Promise<void> {
		await this.host.kill(this.id);
	}
}

export class ClaudeCodeEngine implements Engine {
	readonly id = ID;
	readonly version = VERSION;

	// Mirrors manifest.json `engine` block. Static — kept in sync manually
	// because the legacy `createEngine` factory is slated for removal; not
	// worth wiring JSON imports just to delete it next release.
	readonly metadata = {
		agentId: 'claude-code',
		display: 'Claude Code',
		capabilities: {
			streaming: true,
			toolUse: true,
			thinking: true,
			artifacts: true,
			fileAttachments: true,
			imageInput: true,
			slashCommands: true,
			modelSwitching: true,
			promptCaching: true,
			agenticTools: true,
			mcp: true,
			sessionResume: true,
		},
		onboarding: {
			requiredVaultKeys: ['ANTHROPIC_API_KEY'],
			requiredEnvVars: [] as string[],
			authCommand: 'claude login',
			docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
		},
	};

	constructor(private readonly host: HostBridge) {}

	async startSession(opts: ClaudeSessionOpts): Promise<Session> {
		const sessionId = crypto.randomUUID();
		await this.host.spawn(buildSpawnOpts(sessionId, opts));
		return new ClaudeSession(sessionId, this.host);
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

	registerMcpServer(spec: McpServerSpec): Promise<void> {
		return this.host.registerMcp(spec);
	}

	unregisterMcpServer(id: string): Promise<void> {
		return this.host.unregisterMcp(id);
	}

	async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
		// The shell's `claude` binary resolution + CLI availability check is
		// the source of truth. The engine kernel is expected to wire
		// `host.healthCheck` through this — for now, the absence of a probe
		// is treated as healthy.
		return { ok: true };
	}
}

/**
 * Default factory used by the engine kernel when loading this pkg.
 * The kernel passes a `HostBridge` constructed from its Tauri command set.
 */
export function createEngine(host: HostBridge): Engine {
	return new ClaudeCodeEngine(host);
}

export default createEngine;

// ACP-shaped engine surface. The legacy `createEngine` + `Engine` above is
// retained for one release; new consumers target `AcpEngine`.
export { createAcpEngine } from './acp-engine.js';
export type { AcpHost, AcpUnlisten, HostBridge } from '@ikenga/contract/engine';

// Portability adapter (ADR-012 Track C) — exported alongside the runtime
// engine. The kernel's `engine_assets` registry resolves both at load time.
export { ClaudeCodeEngineAdapter } from './portability.js';
