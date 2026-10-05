/**
 * Tests for the legacy `ClaudeCodeEngine.startSession` → `HostBridge.spawn`
 * mapping. The system prompt used to be dropped on the way to the shell,
 * whose `ClaudeOpts` reads it as `appendSystemPrompt`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EngineEvent, HostBridge } from '@ikenga/contract/engine';
import { ClaudeCodeEngine, buildSpawnOpts, type ClaudeSpawnOpts } from './index.js';

function recordingHost(): { host: HostBridge; spawned: ClaudeSpawnOpts[] } {
	const spawned: ClaudeSpawnOpts[] = [];
	const host: HostBridge = {
		async spawn(opts) {
			spawned.push(opts as ClaudeSpawnOpts);
		},
		async send() {},
		async kill() {},
		listen(): AsyncIterable<EngineEvent> {
			return { async *[Symbol.asyncIterator]() {} };
		},
		async registerMcp() {},
		async unregisterMcp() {},
	};
	return { host, spawned };
}

test('startSession sends systemPrompt to the host as appendSystemPrompt', async () => {
	const { host, spawned } = recordingHost();
	const session = await new ClaudeCodeEngine(host).startSession({
		cwd: '/work',
		systemPrompt: 'You are a release assistant.',
	});
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].sessionId, session.id);
	assert.equal(spawned[0].cwd, '/work');
	assert.equal(spawned[0].appendSystemPrompt, 'You are a release assistant.');
	assert.equal(spawned[0].systemPrompt, 'You are a release assistant.');
});

test('no system prompt means no appendSystemPrompt key at all', async () => {
	const { host, spawned } = recordingHost();
	await new ClaudeCodeEngine(host).startSession({ cwd: '/work' });
	assert.ok(!('appendSystemPrompt' in spawned[0]));
	assert.ok(!('systemPrompt' in spawned[0]));
	assert.ok(!('role' in spawned[0]));
	assert.ok(!('pluginDirs' in spawned[0]));
	assert.deepEqual(spawned[0], { sessionId: spawned[0].sessionId, cwd: '/work' });
});

test('an empty system prompt is treated as unset', () => {
	assert.ok(!('appendSystemPrompt' in buildSpawnOpts('s', { systemPrompt: '' })));
});

test('model, resumeSessionId, role and pluginDirs pass through when set', () => {
	const out = buildSpawnOpts('s', {
		model: 'claude-opus-5-5',
		resumeSessionId: 'abc',
		role: 'plan',
		pluginDirs: ['/p/a', '', '/p/b'],
	});
	assert.deepEqual(out, {
		sessionId: 's',
		model: 'claude-opus-5-5',
		resumeSessionId: 'abc',
		role: 'plan',
		pluginDirs: ['/p/a', '/p/b'],
	});
});

test('role is never defaulted', () => {
	assert.equal(buildSpawnOpts('s', { systemPrompt: 'x' }).role, undefined);
});
