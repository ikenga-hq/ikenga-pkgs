import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MattermostBridge } from './bridge.js';
import { resolveBridgeConfigs } from './config.js';
import type { BridgeFileConfig } from './config.js';
import { MattermostGate } from './gate.js';
import { MockDaemon } from './mock-daemon.js';
import { MockMattermostServer } from './mock-server.js';
import { claudeArgsForToolPolicy, policySettingsJson, resolveUserPolicies, POLICY_HARD_DENY } from './policy.js';
import type { PolicyContext, UserPolicy } from './policy.js';
import type { AuditRecord } from './audit.js';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent } from './types.js';
import { sweepTmp, tmpDir } from './test-tmp.js';

/**
 * Per-user policies. The bridge does not start `claude`; it asks the daemon for a Chi run. So "what the bridge passes" is the
 * `chi_run` request, which a fake daemon records here, and `claudeArgsForToolPolicy` is the exact argv the daemon must
 * append for it (also run through a fake `claude` below, to pin the argv across a real exec).
 */

const ADA = 'buay4kf99bbk7cjtbeupd5rxow';
const FOUNDER = '9s65in45np8h98qeatgx7anuoa';
const STRANGER = 'zzzzzzzzzzzzzzzzzzzzzzzzzz';
const WRAPPER = 'Bash(bash scripts/cron/run-social-queue-submit.sh:*)';
const WHERE = "bot 'ruby'";
const PASSWORD = 'daemon-pw-xyz';
const MM_TOKEN = 'mm-token-xyz';
const FAST = { pollMinMs: 10, pollMaxMs: 20, editIntervalMs: 0, maxWaitMs: 60_000, maxPollFailures: 3 };

const adaPolicy = (over: Partial<UserPolicy> = {}): UserPolicy => ({
  label: 'ada-social-queue',
  channels: ['royalti-co'],
  cwd: '~/projects/royalti-co-queue',
  systemPrompt: 'You queue social posts for Ada. Use only the submit wrapper.',
  allowedTools: [WRAPPER, 'Read(./docs/**)'],
  enforcedBy: 'daemon',
  ...over,
});

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  allowedUsers: [FOUNDER],
  maxMode: 'default',
  chi: { engine: 'claude-code', cwd: '~/projects' },
  runsChi: true,
  ...over,
});

const resolve = (policy: object, c: Partial<PolicyContext> = {}) => resolveUserPolicies({ [ADA]: policy }, WHERE, ctx(c));

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  await sweepTmp();
});

// ── validation at load ───────────────────────────────────────────────────────

describe('userPolicies validation', () => {
  it('absent or empty resolves to nothing', () => {
    assert.equal(resolveUserPolicies(undefined, WHERE, ctx()).size, 0);
    assert.equal(resolveUserPolicies({}, WHERE, ctx()).size, 0);
  });

  it('resolves the queue-only policy and derives the toolset from the allowlist', () => {
    const p = resolve(adaPolicy()).get(ADA);
    assert.ok(p);
    assert.equal(p.mode, 'default');
    assert.equal(p.cwd, '~/projects/royalti-co-queue');
    assert.deepEqual(p.toolPolicy.tools, ['Bash', 'Read']);
    assert.deepEqual(p.toolPolicy.allowedTools, [WRAPPER, 'Read(./docs/**)']);
    for (const t of ['Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'Agent']) assert.ok(p.toolPolicy.disallowedTools.includes(t), t);
    assert.equal(p.toolPolicy.permissionPrompts, 'none');
    assert.deepEqual(p.toolPolicy.settingSources, ['project']);
    assert.equal(p.toolPolicy.strictMcpConfig, true);
    assert.equal(p.toolPolicy.disableSlashCommands, true);
  });

  const refuse = (policy: object, re: RegExp, c: Partial<PolicyContext> = {}) =>
    assert.throws(() => resolve(policy, c), re);

  it('refuses an empty or missing allowlist', () => {
    refuse(adaPolicy({ allowedTools: [] }), /allowedTools must name at least one tool rule/);
    const { allowedTools: _drop, ...rest } = adaPolicy();
    refuse(rest, /allowedTools must name at least one/);
  });

  it('refuses unknown tool names, in allow and deny lists, and mcp tools in an allowlist', () => {
    refuse(adaPolicy({ allowedTools: [WRAPPER, 'Reed(./docs/**)'] }), /unknown tool 'Reed'/);
    refuse(adaPolicy({ disallowedTools: ['Nope'] }), /unknown tool 'Nope'/);
    refuse(adaPolicy({ allowedTools: [WRAPPER, 'mcp__royalti-cms__list'] }), /MCP tools are not available/);
    refuse(adaPolicy({ allowedTools: [WRAPPER, 'not a rule'] }), /is not a tool rule/);
    assert.ok(resolve(adaPolicy({ disallowedTools: ['mcp__royalti-cms'] })).get(ADA)?.toolPolicy.disallowedTools.includes('mcp__royalti-cms'));
  });

  it('refuses arbitrary Bash: bare, wildcard, interpreter-only, shell operators', () => {
    for (const bad of ['Bash', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash(bash:*)', 'Bash(sh -c:*)', 'Bash(env:*)', 'Bash(node:*)', 'Bash(python3 -c:*)']) {
      refuse(adaPolicy({ allowedTools: [bad] }), /Bash rule|allows any command|lets '.+' run any command/);
    }
    refuse(adaPolicy({ allowedTools: ['Bash(bash scripts/a.sh; rm -rf /:*)'] }), /shell operator/);
    assert.ok(resolve(adaPolicy({ allowedTools: ['Bash(bash scripts/cron/run-social-queue-submit.sh *)'] })).get(ADA));
  });

  it('refuses writes, network and sub-agents in the allowlist, and an unscoped read', () => {
    for (const t of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      refuse(adaPolicy({ allowedTools: [WRAPPER, t] }), /can never be allowed/);
    }
    for (const t of ['Read', 'Grep', 'Glob']) refuse(adaPolicy({ allowedTools: [WRAPPER, t] }), /no path scope/);
    refuse(adaPolicy({ tools: ['Bash', 'Read', 'Write'] }), /never available to a policy user/);
    refuse(adaPolicy({ tools: ['Bash'] }), /tools leaves out/);
    refuse(adaPolicy({ disallowedTools: [WRAPPER] }), /both allowed and disallowed/);
  });

  it('refuses a user who is also in allowedUsers, a username key, and a missing or shared cwd', () => {
    refuse(adaPolicy(), /also in allowedUsers/, { allowedUsers: [ADA] });
    assert.throws(() => resolveUserPolicies({ ada: adaPolicy() }, WHERE, ctx()), /must be a Mattermost user id/);
    refuse(adaPolicy({ cwd: undefined as unknown as string }), /cwd is required/);
    refuse(adaPolicy({ cwd: 'relative/dir' }), /cwd is required/);
    refuse(adaPolicy({ cwd: '/srv/../etc' }), /cwd is required/);
    refuse(adaPolicy({ cwd: '~/projects/' }), /same as chi.cwd/);
  });

  it('refuses a bad mode, a mode above maxMode, a missing enforcedBy, unknown fields, no channels', () => {
    refuse(adaPolicy({ mode: 'acceptEdits' }), /mode must be 'default' or 'plan'/);
    refuse(adaPolicy({ mode: 'default' }), /above this bot's ceiling/, { maxMode: 'plan' });
    refuse(adaPolicy({ enforcedBy: undefined as never }), /enforcedBy is required/);
    refuse(adaPolicy({ enforcedBy: 'prompt' as never }), /enforcedBy is required/);
    refuse({ ...adaPolicy(), allowedTool: ['x'] }, /unknown field 'allowedTool'/);
    refuse(adaPolicy({ channels: [] }), /channels must be a non-empty list/);
    refuse(adaPolicy({ settingSources: ['user', 'cloud'] }), /settingSources must be a list/);
  });

  it('refuses policies on a bot that cannot run them: no chi, other engine, approvals', () => {
    refuse(adaPolicy(), /need daemon and chi/, { runsChi: false });
    refuse(adaPolicy(), /need chi.engine 'claude-code'/, { chi: { engine: 'codex', cwd: '~/projects' } });
    refuse(adaPolicy(), /cannot be combined with approvals/, { approvals: { approvers: ['x'] } });
  });

  it('config load: a policy bot validates, the audit channel may not be a policy channel, no policies = no key', () => {
    const file = (over: Record<string, unknown> = {}): BridgeFileConfig => ({
      mattermostUrl: 'http://mm',
      dataDir: '/tmp/x',
      bots: {
        ruby: {
          mattermostToken: { env: 'PATH' },
          allowedUsers: [FOUNDER],
          allowedChannels: ['ruby-test'],
          daemon: { url: 'http://d', auth: { kind: 'bearer', token: { env: 'PATH' } } },
          chi: { engine: 'claude-code', cwd: '~/projects', persistent: true },
          maxMode: 'default',
          userPolicies: { [ADA]: adaPolicy() },
          ...over,
        },
      },
    });
    const [cfg] = resolveBridgeConfigs(file());
    assert.deepEqual(Object.keys(cfg?.userPolicies ?? {}), [ADA]);
    assert.throws(() => resolveBridgeConfigs(file({ audit: { channel: 'royalti-co' } })), /audit.channel 'royalti-co' is also in allowedChannels/);
    assert.throws(() => resolveBridgeConfigs(file({ maxMode: undefined })), /above this bot's ceiling/);
    // Backward compatible: nothing about the resolved config changes when the field is absent.
    const [plain] = resolveBridgeConfigs(file({ userPolicies: undefined }));
    assert.ok(plain);
    assert.equal('userPolicies' in plain, false);
  });
});

// ── the argv contract, through a fake claude ─────────────────────────────────

describe('claudeArgsForToolPolicy', () => {
  it('is the exact argv, and survives a real exec byte for byte', () => {
    const p = resolve(adaPolicy()).get(ADA)!;
    const args = claudeArgsForToolPolicy(p.toolPolicy);
    assert.deepEqual(args, [
      '--tools', 'Bash,Read',
      '--allowedTools', WRAPPER, 'Read(./docs/**)',
      '--disallowedTools', ...POLICY_HARD_DENY,
      '--permission-prompts', 'none',
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--disable-slash-commands',
    ]);

    const dir = tmpDir('mm-fake-claude-');
    const out = path.join(dir, 'argv.json');
    const fake = path.join(dir, 'claude');
    writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({argv: process.argv.slice(2), env: process.env.IKENGA_AUTH_TOKEN ?? null}));\n`);
    chmodSync(fake, 0o755);
    // The daemon scrubs host-only secrets from the engine's env; a spawn that passes none must hand none on.
    const env = { PATH: process.env.PATH ?? '' };
    const r = spawnSync(fake, args, { env });
    assert.equal(r.status, 0, String(r.stderr));
    const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; env: string | null };
    assert.deepEqual(seen.argv, args);
    assert.equal(seen.env, null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('settings file carries the same allow and deny rules', () => {
    const p = resolve(adaPolicy()).get(ADA)!;
    assert.deepEqual(policySettingsJson(p), { permissions: { defaultMode: 'default', allow: [WRAPPER, 'Read(./docs/**)'], deny: [...POLICY_HARD_DENY] } });
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe('gate with policies', () => {
  const policies = resolve(adaPolicy());
  const base: MattermostBridgeConfig = {
    mattermostUrl: 'http://mm',
    mattermostToken: 't',
    allowedUsers: [FOUNDER],
    allowedChannels: ['ruby-test'],
  };
  const check = (gate: MattermostGate, user: string, channel: string, sender = '@someone') => {
    const post: MattermostPost = { id: 'p', user_id: user, channel_id: `id-${channel}`, message: 'hi' };
    const event: MattermostPostEvent = { event: 'posted', data: { channel_name: channel, sender_name: sender, post: JSON.stringify(post) }, seq: 1 };
    return gate.check(event, post);
  };

  it('Ada: allowed in her channel with her policy, refused in the founder channel', () => {
    const gate = new MattermostGate(base, policies);
    const ok = check(gate, ADA, 'royalti-co');
    assert.equal(ok.allowed, true);
    assert.equal(ok.policy?.userId, ADA);
    const no = check(gate, ADA, 'ruby-test');
    assert.equal(no.allowed, false);
    assert.equal(no.code, 'channel_not_allowed');
  });

  it('founder: allowed where he was, with no policy; refused in the policy channel', () => {
    const gate = new MattermostGate(base, policies);
    const ok = check(gate, FOUNDER, 'ruby-test');
    assert.equal(ok.allowed, true);
    assert.equal(ok.policy, undefined);
    assert.equal(check(gate, FOUNDER, 'royalti-co').code, 'channel_not_allowed');
  });

  it('an unlisted user is refused everywhere, even by impersonating a username', () => {
    const gate = new MattermostGate(base, policies);
    assert.equal(check(gate, STRANGER, 'royalti-co').code, 'user_not_allowed');
    assert.equal(check(gate, STRANGER, 'ruby-test').code, 'user_not_allowed');
  });

  it('raw policies without the resolved map grant nothing; a gate built the old way is unchanged', () => {
    assert.equal(check(new MattermostGate({ ...base, userPolicies: { [ADA]: adaPolicy() } }), ADA, 'royalti-co').code, 'user_not_allowed');
    assert.equal(check(new MattermostGate(base), FOUNDER, 'ruby-test').allowed, true);
    assert.equal(check(new MattermostGate({ ...base, allowedUsers: [] }), ADA, 'royalti-co').code, 'no_allowed_users');
  });
});

// ── through the real bridge: what the daemon is asked for ────────────────────

describe('bridge: the chi_run request for Ada versus the founder', () => {
  let mm: MockMattermostServer;
  let daemon: MockDaemon;
  let dir: string;
  let bridge: MattermostBridge | undefined;
  const auditFile = () => path.join(dir, 'audit-ruby.jsonl');
  const audit = (): AuditRecord[] => {
    try {
      return readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
    } catch {
      return [];
    }
  };

  beforeEach(async () => {
    mm = new MockMattermostServer();
    daemon = new MockDaemon('t1', { username: 'ruby', password: PASSWORD });
    dir = tmpDir('mm-policy-int-');
  });
  afterEach(async () => {
    bridge?.stop();
    bridge = undefined;
    await mm.close();
    await daemon.close();
  });

  async function boot(over: Partial<MattermostBridgeConfig> = {}): Promise<void> {
    const mmUrl = await mm.listen();
    const daemonUrl = await daemon.listen();
    const [cfg] = resolveBridgeConfigs({
      mattermostUrl: mmUrl,
      dataDir: dir,
      bots: {
        ruby: {
          mattermostToken: { env: 'MM_TEST_TOKEN' },
          allowedUsers: [FOUNDER],
          allowedChannels: ['ruby-test'],
          daemon: { url: daemonUrl, auth: { kind: 'session', username: 'ruby', password: { env: 'DAEMON_TEST_PW' } } },
          chi: { engine: 'claude-code', cwd: '~/projects', systemPrompt: 'You are Ruby, read-only.', persistent: true },
          maxMode: 'default',
          progress: FAST,
          userPolicies: { [ADA]: adaPolicy() },
        },
      },
    });
    bridge = new MattermostBridge({ ...(cfg as MattermostBridgeConfig), ...over });
    await bridge.start();
    await pause(60);
  }

  process.env.MM_TEST_TOKEN = MM_TOKEN;
  process.env.DAEMON_TEST_PW = PASSWORD;

  const say = (id: string, text: string, user: string, channel: string, root?: string) =>
    mm.broadcastPost({ id, user_id: user, channel_id: `id-${channel}`, message: text, root_id: root }, channel, user === ADA ? '@ada' : user === FOUNDER ? '@founder' : '@stranger');
  const chiRuns = () => daemon.rpcCalls('chi_run').map((c) => ((c.args.opts ?? c.args) as Record<string, unknown>));

  it('Ada gets the policy session: her cwd, default mode, the toolPolicy, her prompt; nothing else', async () => {
    await boot();
    say('a1', 'queue this: hello world', ADA, 'royalti-co');
    await waitFor(() => chiRuns().length === 1, 'Ada chi_run');
    const o = chiRuns()[0] as Record<string, unknown>;
    assert.equal(o.engineId, 'claude-code');
    assert.equal(o.cwd, '~/projects/royalti-co-queue');
    assert.equal(o.mode, 'default');
    assert.deepEqual(o.toolPolicy, resolve(adaPolicy()).get(ADA)!.toolPolicy);
    const prompt = String(o.prompt);
    assert.ok(prompt.startsWith('You queue social posts for Ada.'));
    assert.ok(!prompt.includes('You are Ruby, read-only.'), "the founder's prompt does not leak into her session");
    assert.ok(prompt.endsWith('queue this: hello world'));
    // The request carries no env and no other tool field.
    assert.deepEqual(Object.keys(o).sort(), ['cwd', 'engineId', 'mode', 'persistent', 'prompt', 'toolPolicy']);
    await waitFor(() => audit().some((r) => r.event === 'run.started'), 'run.started record');
    const started = audit().find((r) => r.event === 'run.started');
    assert.equal(started?.policy, 'ada-social-queue');
    assert.equal(started?.mode, 'default');
    assert.equal(audit().find((r) => r.event === 'config.loaded')?.policy_users, 1);
  });

  it("the founder's session is unchanged: bot cwd, plan mode, his prompt, no toolPolicy", async () => {
    await boot();
    say('f1', 'status?', FOUNDER, 'ruby-test');
    await waitFor(() => chiRuns().length === 1, 'founder chi_run');
    const o = chiRuns()[0] as Record<string, unknown>;
    assert.equal(o.cwd, '~/projects');
    assert.equal(o.mode, 'plan');
    assert.equal('toolPolicy' in o, false);
    assert.ok(String(o.prompt).startsWith('You are Ruby, read-only.'));
    await waitFor(() => audit().some((r) => r.event === 'run.started'), 'run.started record');
    assert.equal(audit().find((r) => r.event === 'run.started')?.policy, undefined);
  });

  it('a user on no list gets nothing: no run, no reply, in either channel; the refusal is audited', async () => {
    await boot();
    say('s1', 'hello', STRANGER, 'royalti-co');
    say('s2', 'hello', STRANGER, 'ruby-test');
    say('a2', 'hello', ADA, 'ruby-test'); // Ada outside her channel
    say('f2', 'hello', FOUNDER, 'royalti-co'); // the founder outside his
    await waitFor(() => audit().filter((r) => r.event === 'gate.denied').length >= 4, 'denials');
    assert.equal(chiRuns().length, 0);
    assert.equal(mm.receivedPosts.length, 0);
    assert.deepEqual(audit().filter((r) => r.event === 'gate.denied').map((r) => r.reason).sort(), ['channel_not_allowed', 'channel_not_allowed', 'user_not_allowed', 'user_not_allowed']);
  });

  it("threads are isolated: Ada cannot resume, cancel or take over the founder's thread, and her own resumes under her policy", async () => {
    // Lift the founder's channel list so both can reach one channel: thread records are keyed by root id alone.
    await boot({ allowedChannels: ['ruby-test', 'royalti-co'] });
    say('f1', 'founder root', FOUNDER, 'royalti-co');
    await waitFor(() => chiRuns().length === 1, 'founder run');
    daemon.settle('run-1', 'done', { output: 'founder answer' });
    await waitFor(() => mm.receivedPosts.some((p) => p.message.includes('founder answer')), 'founder answer');

    await waitFor(() => bridge!.router!.activeCount() === 0, 'founder turn closed');
    say('a1', 'continue please', ADA, 'royalti-co', 'f1');
    await waitFor(() => mm.receivedPosts.some((p) => p.message.includes('different permissions')), 'refusal');
    assert.equal(daemon.rpcCalls('chi_resume').length, 0);
    assert.equal(chiRuns().length, 1);
    assert.ok(audit().some((r) => r.event === 'run.refused' && r.reason === 'thread_policy_mismatch'));

    // Ada's own thread: fresh run under her policy, then a resume of that same run.
    say('a2', 'queue one', ADA, 'royalti-co');
    await waitFor(() => chiRuns().length === 2, 'Ada run');
    daemon.settle('run-2', 'done', { output: 'queued' });
    await waitFor(() => mm.receivedPosts.some((p) => p.message.startsWith('queued')), 'Ada answer');
    await waitFor(() => bridge!.router!.activeCount() === 0, 'Ada turn closed');
    say('a3', 'and another', ADA, 'royalti-co', 'a2');
    await waitFor(() => daemon.rpcCalls('chi_resume').length === 1, 'Ada resume');
    assert.equal(daemon.rpcCalls('chi_resume')[0]?.args.runId, 'run-2');
  });
});
