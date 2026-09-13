/**
 * Manifest correctness tests for the OpenRouter engine pkg (WP-20).
 *
 * Three things this pkg ships can disagree with each other, and nothing else in
 * CI notices when they do:
 *
 *  1. `manifest.json`'s `engine.capabilities` and `OpenRouterEngine.metadata
 *     .capabilities` in `src/index.ts`. The contract (`EngineMetadata`, see
 *     contract/src/engine/adapter.ts) says `metadata` "mirrors the manifest's
 *     engine block so the shell + wizard can introspect without re-parsing the
 *     manifest" — i.e. both are sanctioned read paths, so both must say the same
 *     thing. `git diff --exit-code` in CI only catches dist-vs-src drift; it
 *     cannot see manifest-vs-src drift.
 *
 *  2. `permissions.net`. Since this pkg declares a non-empty `net`,
 *     `openrouter_http::server::resolve_net_allowlist` uses the manifest glob
 *     *instead of* its built-in `DEFAULT_NET_ALLOWLIST` — so this string is the
 *     sole gate on where the bearer token may be sent. A glob the Rust `glob`
 *     crate rejects silently degrades to a literal `startsWith` that never
 *     matches, and every turn dies. Nothing tested it before.
 *
 *  3. `engine.onboarding.requiredVaultKeys` vs `permissions["vault.keys"]`.
 *     The shell resolves the first entry of `requiredVaultKeys` out of
 *     Stronghold, but builds the install-time trust disclosure (and gates the
 *     host secret path) from `permissions["vault.keys"]`.
 *
 * Reads `../dist/index.js`, so run `pnpm build` first (CI runs `pnpm -r build`
 * before `pnpm -r test`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ManifestSchema } from '@ikenga/contract/manifest';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const distEntry = path.join(pkgRoot, 'dist', 'index.js');

assert.ok(
	existsSync(distEntry),
	`dist/index.js is missing — run \`pnpm build\` in ${pkgRoot} before \`pnpm test\`.`,
);

const manifest = JSON.parse(readFileSync(path.join(pkgRoot, 'manifest.json'), 'utf8'));
const { OpenRouterEngine } = await import(`file://${distEntry.split(path.sep).join('/')}`);

/** The engine only calls `host.*` from `startSession`/`stream`; metadata is static. */
const NOOP_HOST = new Proxy(
	{},
	{
		get() {
			return () => {
				throw new Error('host bridge must not be touched while reading metadata');
			};
		},
	},
);

test('the manifest parses against the contract ManifestSchema', () => {
	const parsed = ManifestSchema.safeParse(manifest);
	assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2));
});

test('manifest engine.capabilities and Engine.metadata.capabilities agree', () => {
	const fromSrc = new OpenRouterEngine(NOOP_HOST).metadata;
	// Deep-equal, not subset: a flag added to one copy and not the other is
	// exactly the drift this test exists to catch.
	assert.deepEqual(fromSrc.capabilities, manifest.engine.capabilities);
	assert.equal(fromSrc.agentId, manifest.engine.agentId);
	assert.equal(fromSrc.display, manifest.engine.display);
	assert.deepEqual(fromSrc.onboarding.requiredVaultKeys, manifest.engine.onboarding.requiredVaultKeys);
	assert.deepEqual(fromSrc.onboarding.requiredEnvVars, manifest.engine.onboarding.requiredEnvVars);
	assert.equal(fromSrc.onboarding.authCommand, manifest.engine.onboarding.authCommand);
	assert.equal(fromSrc.onboarding.docsUrl, manifest.engine.onboarding.docsUrl);
});

test('capabilities claim nothing openrouter_http::server does not implement', () => {
	// Pinned against the adapter on shell@wp20/openrouter-http. Each `false`
	// below has a named reason in src/index.ts; flipping one to `true` without
	// landing the adapter change is the regression this pins.
	assert.deepEqual(manifest.engine.capabilities, {
		streaming: true, // SSE stream → OrEvent::Text chunks
		toolUse: true, // build_request_body sends `tools`; delta.tool_calls comes back
		thinking: true, // OrEvent::Thinking → AgentThoughtChunk
		artifacts: false, // zero occurrences of "artifact" in server.rs
		fileAttachments: false, // extract_prompt_text refuses non-text blocks
		imageInput: false, // PromptCapabilities.image(false)
		slashCommands: false,
		modelSwitching: true, // handle_set_model, sticky per session
		promptCaching: false,
		agenticTools: false, // "the HTTP engine executes no tools itself"
		mcp: false, // McpCapabilities::default(); set_tools is not MCP
		sessionResume: true, // caps.load_session = true; handle_load_session replays
	});
});

// ---------------------------------------------------------------------------
// permissions.net
// ---------------------------------------------------------------------------

/**
 * Mirror of `glob_or_prefix_match` (shell/src-tauri/src/pkg/http_proxy.rs) for
 * the pattern shapes a net allowlist can hold. Kept deliberately narrow and
 * fail-closed: anything this mirror cannot model throws, so the test goes red
 * rather than passing on a pattern whose real behaviour is unverified.
 *
 * Semantics copied from the Rust side:
 *  - no wildcard char at all → the raw string is treated as a prefix;
 *  - `glob::Pattern` runs with `MatchOptions::default()`, so
 *    `require_literal_separator` is false and `*` DOES cross `/`;
 *  - `**` must form a whole path component, else `Pattern::new` errors and the
 *    caller falls back to a literal `startsWith(raw)`.
 */
function globOrPrefixMatch(raw, target) {
	const hasWildcard = raw.includes('*') || raw.includes('?') || raw.includes('[');
	if (!hasWildcard) return target.startsWith(raw);
	if (raw.includes('[')) {
		throw new Error(
			`net pattern \`${raw}\` uses a character class, which this mirror does not model — ` +
				'verify it against glob::Pattern in the shell before relying on it.',
		);
	}
	// `**` must be a complete path component (glob crate PatternError otherwise).
	for (let i = 0; i < raw.length - 1; i++) {
		if (raw[i] !== '*' || raw[i + 1] !== '*') continue;
		const before = i === 0 ? '/' : raw[i - 1];
		const after = i + 2 >= raw.length ? '/' : raw[i + 2];
		if (before !== '/' || after !== '/') return target.startsWith(raw); // malformed → prefix fallback
		i++; // consumed both stars
	}
	const re = new RegExp(
		`^${raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]')}$`,
	);
	return re.test(target);
}

/** Mirror of `completions_url` (openrouter_http/server.rs). */
function completionsUrl(baseUrl) {
	const base = baseUrl.trim() === '' ? 'https://openrouter.ai/api/v1' : baseUrl.trim();
	if (base.endsWith('/chat/completions')) return base;
	return `${base.replace(/\/+$/, '')}/chat/completions`;
}

const declaredNet = manifest.permissions.net;
const baseUrlDefault = manifest.settings.schema.find((s) => s.key === 'base_url').default;

test('the declared net allowlist admits the default endpoint', () => {
	assert.ok(declaredNet.length > 0, 'a non-empty net is what replaces DEFAULT_NET_ALLOWLIST');
	const endpoint = completionsUrl(baseUrlDefault);
	assert.equal(endpoint, 'https://openrouter.ai/api/v1/chat/completions');
	assert.ok(
		declaredNet.some((p) => globOrPrefixMatch(p, endpoint)),
		`permissions.net ${JSON.stringify(declaredNet)} does not admit ${endpoint} — every ` +
			'OpenRouter turn would be refused before the request is sent.',
	);
});

test('the declared net allowlist still refuses look-alike hosts', () => {
	for (const hostile of [
		'https://attacker.example/v1/chat/completions',
		'https://openrouter.ai.attacker.example/api/v1/chat/completions',
		'http://openrouter.ai/api/v1/chat/completions', // scheme is part of the pattern
	]) {
		assert.ok(
			!declaredNet.some((p) => globOrPrefixMatch(p, hostile)),
			`permissions.net must not admit ${hostile}`,
		);
	}
});

// ---------------------------------------------------------------------------
// vault keys
// ---------------------------------------------------------------------------

test('every required vault key is declared in permissions["vault.keys"]', () => {
	const declared = manifest.permissions['vault.keys'] ?? [];
	for (const key of manifest.engine.onboarding.requiredVaultKeys) {
		assert.ok(
			declared.includes(key),
			`engine.onboarding.requiredVaultKeys lists \`${key}\` but permissions["vault.keys"] ` +
				`is ${JSON.stringify(declared)} — the install-time trust disclosure would not ` +
				'mention the vault access this engine actually uses.',
		);
	}
});
