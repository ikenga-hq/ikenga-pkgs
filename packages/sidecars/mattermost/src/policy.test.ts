import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MattermostBridge } from './bridge.js';
import { resolveBridgeConfigs } from './config.js';
import type { BridgeFileConfig } from './config.js';
import { MattermostGate } from './gate.js';
import { DaemonClient } from './daemon.js';
import { MockDaemon } from './mock-daemon.js';
import { MockMattermostServer } from './mock-server.js';
import { POLICY_CAPABILITY, POLICY_HARD_DENY, canonicalPath, checkPolicyCwd, claudeArgsForToolPolicy, resolveUserPolicies } from './policy.js';
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
const HUB = '~/projects/royalti-co';
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
  chi: { engine: 'claude-code', cwd: HUB },
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
    for (const t of ['Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'ToolSearch', 'Monitor', 'CronCreate', 'SendMessage', 'AskUserQuestion']) assert.ok(p.toolPolicy.disallowedTools.includes(t), t);
    // disallowedTools defaults to every known tool the session does not have, and never names one it has.
    assert.ok(!p.toolPolicy.disallowedTools.includes('Bash') && !p.toolPolicy.disallowedTools.includes('Read'));
    assert.equal(p.toolPolicy.mode, 'dontAsk');
    assert.deepEqual(p.toolPolicy.settingSources, []);
    assert.equal(p.toolPolicy.strictMcp, true);
    // The exact field names of the protocol, and nothing else.
    assert.deepEqual(Object.keys(p.toolPolicy).sort(), ['allowedTools', 'disallowedTools', 'mode', 'settingSources', 'strictMcp', 'tools']);
    assert.equal(p.enforcedBy, 'daemon');
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
      refuse(adaPolicy({ allowedTools: [bad] }), /is not an allowed Bash rule/);
    }
    refuse(adaPolicy({ allowedTools: ['Bash(bash scripts/a.sh; rm -rf /:*)'] }), /is not an allowed Bash rule/);
    assert.ok(resolve(adaPolicy({ allowedTools: ['Bash(bash scripts/cron/run-social-queue-submit.sh *)'] })).get(ADA));
    assert.ok(resolve(adaPolicy({ allowedTools: ['Bash(bash ./scripts/q.sh)'] })).get(ADA));
  });

  it('refuses writes, network and sub-agents in the allowlist, and an unscoped read', () => {
    for (const t of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      refuse(adaPolicy({ allowedTools: [WRAPPER, t] }), /can never be allowed/);
    }
    for (const t of ['Read', 'Grep', 'Glob']) refuse(adaPolicy({ allowedTools: [WRAPPER, t] }), /no path scope/);
    refuse(adaPolicy({ allowedTools: [WRAPPER, 'TodoWrite(x)'] }), /takes no specifier/);
    assert.ok(resolve(adaPolicy({ allowedTools: [WRAPPER, 'TodoWrite', 'ToolSearch'] })).get(ADA));
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
    refuse(adaPolicy({ cwd: HUB }), /same directory as chi.cwd/);
  });

  it('refuses a bad mode, a mode above maxMode, a missing enforcedBy, unknown fields, no channels', () => {
    refuse(adaPolicy({ mode: 'acceptEdits' }), /mode must be 'default'/);
    refuse(adaPolicy({ mode: 'plan' }), /mode must be 'default'/);
    refuse(adaPolicy({ mode: 'default' }), /above this bot's ceiling/, { maxMode: 'plan' });
    refuse(adaPolicy({ enforcedBy: undefined as never }), /enforcedBy is required/);
    refuse(adaPolicy({ enforcedBy: 'prompt' as never }), /enforcedBy is required/);
    // There is no settings-file mode: a file in the cwd cannot enforce a policy.
    refuse(adaPolicy({ enforcedBy: 'settings-file' as never }), /must be 'daemon'/);
    refuse({ ...adaPolicy(), allowedTool: ['x'] }, /unknown field 'allowedTool'/);
    refuse(adaPolicy({ channels: [] }), /channels must be a non-empty list/);
    // Only "no settings source" is accepted: 'project' would load CLAUDE.md from the cwd's parent directories into the session.
    refuse(adaPolicy({ settingSources: ['user', 'cloud'] }), /settingSources must be omitted or \[\]/);
    refuse(adaPolicy({ settingSources: ['project', 'local'] }), /settingSources must be omitted or \[\]/);
    refuse(adaPolicy({ settingSources: ['project'] }), /'project' loads CLAUDE.md from the cwd's parent directories/);
    refuse(adaPolicy({ settingSources: 'project' as never }), /settingSources must be omitted or \[\]/);
    assert.deepEqual(resolve(adaPolicy({ settingSources: [] })).get(ADA)?.toolPolicy.settingSources, []);
    assert.deepEqual(resolve(adaPolicy()).get(ADA)?.toolPolicy.settingSources, []);
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
          chi: { engine: 'claude-code', cwd: HUB, persistent: true },
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
    assert.throws(() => resolveBridgeConfigs(file({ privateRoots: ['~/projects/royalti-co-queue'] })), /is the same directory as privateRoots/);
    assert.throws(() => resolveBridgeConfigs(file({ privateRoots: ['relative'] })), /privateRoots must be a list/);
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
      '--disallowedTools', ...p.toolPolicy.disallowedTools,
      '--permission-mode', 'dontAsk',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
    ]);
    for (const t of POLICY_HARD_DENY) assert.ok(p.toolPolicy.disallowedTools.includes(t), t);

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

  it('an empty setting-sources list survives an exec as one empty argv element', () => {
    const p = resolve(adaPolicy()).get(ADA)!;
    const args = claudeArgsForToolPolicy(p.toolPolicy);
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.equal(claudeArgsForToolPolicy({ ...p.toolPolicy, settingSources: ['project'] })[args.indexOf('--setting-sources') + 1], 'project');
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
  /** A gate whose policy channels were resolved to ids, as the bridge does at startup. */
  const gateWith = (ids: string[] = ['id-royalti-co']) => {
    const g = new MattermostGate(base, policies);
    g.setPolicyChannelIds(ADA, ids);
    return g;
  };
  const check = (gate: MattermostGate, user: string, channel: string, sender = '@someone', channelId = `id-${channel}`) => {
    const post: MattermostPost = { id: 'p', user_id: user, channel_id: channelId, message: 'hi' };
    const event: MattermostPostEvent = { event: 'posted', data: { channel_name: channel, sender_name: sender, post: JSON.stringify(post) }, seq: 1 };
    return gate.check(event, post);
  };

  it('Ada: allowed in her channel with her policy, refused in the founder channel', () => {
    const gate = gateWith();
    const ok = check(gate, ADA, 'royalti-co');
    assert.equal(ok.allowed, true);
    assert.equal(ok.policy?.userId, ADA);
    const no = check(gate, ADA, 'ruby-test');
    assert.equal(no.allowed, false);
    assert.equal(no.code, 'channel_not_allowed');
  });

  it('founder: allowed where he was, with no policy; refused in the policy channel', () => {
    const gate = gateWith();
    const ok = check(gate, FOUNDER, 'ruby-test');
    assert.equal(ok.allowed, true);
    assert.equal(ok.policy, undefined);
    assert.equal(check(gate, FOUNDER, 'royalti-co').code, 'channel_not_allowed');
  });

  it('an unlisted user is refused everywhere, even by impersonating a username', () => {
    const gate = gateWith();
    assert.equal(check(gate, STRANGER, 'royalti-co').code, 'user_not_allowed');
    assert.equal(check(gate, STRANGER, 'ruby-test').code, 'user_not_allowed');
  });

  it('a policy channel matches by id only: the same name with another id (another team) is refused, and so is an unresolved policy', () => {
    const gate = gateWith();
    const impostor = check(gate, ADA, 'royalti-co', '@ada', 'id-royalti-co-other-team');
    assert.equal(impostor.allowed, false);
    assert.equal(impostor.code, 'channel_not_allowed');
    assert.equal(check(gate, ADA, 'royalti-co').allowed, true);
    // Ids not resolved yet (or unresolvable): refused everywhere, even in the channel by name.
    assert.equal(check(new MattermostGate(base, policies), ADA, 'royalti-co').code, 'channel_not_allowed');
    assert.equal(check(gateWith([]), ADA, 'royalti-co').code, 'channel_not_allowed');
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
    if (!mm.channels.has('royalti-co')) mm.channels.set('royalti-co', 'id-royalti-co');
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
          chi: { engine: 'claude-code', cwd: HUB, systemPrompt: 'You are Ruby, read-only.', persistent: true },
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
    assert.equal(o.cwd, HUB);
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
  const sayIn = (id: string, text: string, user: string, channelId: string, channelName: string, root?: string) =>
    mm.broadcastPost({ id, user_id: user, channel_id: channelId, message: text, root_id: root }, channelName, user === ADA ? '@ada' : '@someone');

  it('capability handshake: a daemon that does not advertise chi.toolPolicy gets no policy run, with a channel message and an audit record; the founder is unaffected', async () => {
    daemon.capabilities = undefined; // an old daemon: no `capabilities` in /api/health
    await boot();
    await waitFor(() => audit().some((r) => r.event === 'policy.capability'), 'startup capability record');
    const startup = audit().find((r) => r.event === 'policy.capability');
    assert.equal(startup?.advertised, false);
    assert.equal(startup?.why, 'startup');

    say('a1', 'queue this', ADA, 'royalti-co');
    await waitFor(() => mm.receivedPosts.some((p) => p.message.includes('does not report that it enforces tool limits')), 'refusal in the channel');
    assert.equal(chiRuns().length, 0, 'no chi_run for a policy user, with or without toolPolicy');
    assert.equal(daemon.rpcCalls('chi_resume').length, 0);
    const refused = audit().find((r) => r.event === 'run.refused');
    assert.equal(refused?.reason, 'policy_capability_missing');
    assert.equal(refused?.policy, 'ada-social-queue');

    // The founder has no policy: his session starts as before, against the same daemon.
    say('f1', 'status?', FOUNDER, 'ruby-test');
    await waitFor(() => chiRuns().length === 1, 'founder run');
    assert.equal('toolPolicy' in (chiRuns()[0] as Record<string, unknown>), false);

    // A daemon that lists other capabilities but not this one is refused the same way.
    daemon.capabilities = ['chi.other'];
    say('a2', 'again', ADA, 'royalti-co');
    await waitFor(() => audit().filter((r) => r.event === 'run.refused').length === 2, 'second refusal');
    assert.equal(chiRuns().length, 1);

    // The daemon is upgraded: the next request is checked live and goes through, with the policy.
    daemon.capabilities = [POLICY_CAPABILITY];
    say('a3', 'now please', ADA, 'royalti-co');
    await waitFor(() => chiRuns().length === 2, 'policy run after the upgrade');
    assert.deepEqual((chiRuns()[1] as { toolPolicy: unknown }).toolPolicy, resolve(adaPolicy()).get(ADA)!.toolPolicy);
    assert.ok(audit().some((r) => r.event === 'policy.capability' && r.advertised === true && r.why === 'run'));
  });

  it('capability handshake: the check is repeated before a resume, so a daemon rolled back mid-thread cannot resume a policy run unrestricted', async () => {
    await boot();
    say('a1', 'queue one', ADA, 'royalti-co');
    await waitFor(() => chiRuns().length === 1, 'Ada run');
    daemon.settle('run-1', 'done', { output: 'queued' });
    await waitFor(() => mm.receivedPosts.some((p) => p.message.startsWith('queued')), 'answer');
    await waitFor(() => bridge!.router!.activeCount() === 0, 'turn closed');
    daemon.capabilities = [];
    say('a2', 'and another', ADA, 'royalti-co', 'a1');
    await waitFor(() => audit().some((r) => r.event === 'run.refused' && r.reason === 'policy_capability_missing'), 'resume refused');
    assert.equal(daemon.rpcCalls('chi_resume').length, 0);
    assert.equal(chiRuns().length, 1);
  });

  it('capability handshake: re-checked on a websocket reconnect, and recorded', async () => {
    await boot();
    const before = audit().filter((r) => r.event === 'policy.capability').length;
    assert.ok(before >= 1);
    const health = daemon.healthCalls;
    daemon.capabilities = [];
    mm.dropClients?.();
    await waitFor(() => audit().some((r) => r.event === 'policy.capability' && r.why === 'reconnect'), 'reconnect record', 15_000);
    assert.ok(daemon.healthCalls > health);
    assert.equal(audit().filter((r) => r.event === 'policy.capability' && r.why === 'reconnect').pop()?.advertised, false);
  });

  it('policy channels match by channel id only: a same-named channel in another team, or a spoofed name, does not match', async () => {
    mm.addTeam('team2', {});
    await boot();
    // Resolved once: royalti-co -> id-royalti-co. Another team's channel of the same name has another id.
    sayIn('x1', 'hi', ADA, 'id-royalti-co-team2', 'royalti-co');
    await waitFor(() => audit().some((r) => r.event === 'gate.denied' && r.channel_id === 'id-royalti-co-team2'), 'denied');
    assert.equal(chiRuns().length, 0);
    sayIn('x2', 'hi', ADA, 'id-royalti-co', 'something-else'); // the real channel: the name in the event is not consulted
    await waitFor(() => chiRuns().length === 1, 'run in the resolved channel');
  });

  it('a channel name that exists in two of the bot teams is refused as ambiguous (give the id); the id works', async () => {
    mm.addTeam('team2', { 'royalti-co': 'id-royalti-co-team2' });
    await boot();
    sayIn('x1', 'hi', ADA, 'id-royalti-co', 'royalti-co');
    sayIn('x2', 'hi', ADA, 'id-royalti-co-team2', 'royalti-co');
    await waitFor(() => audit().filter((r) => r.event === 'gate.denied').length === 2, 'both denied');
    assert.equal(chiRuns().length, 0);
    assert.ok(audit().some((r) => r.event === 'policy.channel_unresolved' && r.channel === 'royalti-co'));
  });

  it('a policy channel given as an id is checked against Mattermost and then matched as that id', async () => {
    const ID = 'abcdefghijklmnopqrstuvwxyz';
    mm.channels.set('royalti-co', ID);
    await boot({ userPolicies: { [ADA]: adaPolicy({ channels: [ID] }) } });
    sayIn('x1', 'hi', ADA, 'id-wrong', 'royalti-co');
    await waitFor(() => audit().some((r) => r.event === 'gate.denied'), 'denied');
    assert.equal(chiRuns().length, 0);
    sayIn('x2', 'hi', ADA, ID, 'whatever');
    await waitFor(() => chiRuns().length === 1, 'run');
  });

  it('a policy channel Mattermost does not know leaves Ada refused and the bridge up', async () => {
    await boot({ userPolicies: { [ADA]: adaPolicy({ channels: ['no-such-channel'] }) } });
    sayIn('x1', 'hi', ADA, 'id-no-such-channel', 'no-such-channel');
    await waitFor(() => audit().some((r) => r.event === 'gate.denied'), 'denied');
    assert.equal(chiRuns().length, 0);
    assert.ok(audit().some((r) => r.event === 'policy.channel_unresolved' && r.reason === 'not_found'));
    say('f1', 'status?', FOUNDER, 'ruby-test');
    await waitFor(() => chiRuns().length === 1, 'founder still served');
  });
});

// ── cwd overlap ──────────────────────────────────────────────────────────────

describe('policy cwd may not touch the hub or a private root', () => {
  const home = tmpDir('mm-policy-home-');
  const hub = path.join(home, 'projects', 'royalti-co');
  mkdirSync(hub, { recursive: true });
  mkdirSync(path.join(home, 'projects', 'royalti-co-queue'), { recursive: true });
  mkdirSync(path.join(home, 'secrets', 'keys'), { recursive: true });
  symlinkSync(hub, path.join(home, 'link-to-hub'));
  const c = (over: Partial<PolicyContext> = {}) => ctx({ home, chi: { engine: 'claude-code', cwd: hub }, ...over });
  const refuseCwd = (cwd: string, re: RegExp, over: Partial<PolicyContext> = {}) => assert.throws(() => resolve(adaPolicy({ cwd }), c(over)), re, cwd);

  it('refuses every spelling of the hub, an ancestor and a descendant', () => {
    refuseCwd('~/projects/royalti-co', /same directory as chi.cwd/);
    refuseCwd('~/projects//royalti-co', /same directory as chi.cwd/);
    refuseCwd('~/projects/royalti-co/', /same directory as chi.cwd/);
    refuseCwd('~/projects/royalti-co/.', /same directory as chi.cwd/);
    refuseCwd('~/projects/./royalti-co/./', /same directory as chi.cwd/);
    refuseCwd(hub, /same directory as chi.cwd/); // the absolute home path
    refuseCwd(`${hub}//`, /same directory as chi.cwd/);
    refuseCwd('~/link-to-hub', /same directory as chi.cwd/); // a symlink to it
    refuseCwd('~/projects', /contains chi.cwd/);
    refuseCwd('~/projects/', /contains chi.cwd/);
    refuseCwd('~/', /contains chi.cwd/);
    refuseCwd('/', /contains chi.cwd/);
    refuseCwd('~/projects/royalti-co/docs', /inside chi.cwd/);
    refuseCwd('~/link-to-hub/docs/deep', /inside chi.cwd/);
    // A `~` the config spells differently from the process home still resolves through the same home.
    assert.ok(resolve(adaPolicy({ cwd: '~/projects/royalti-co-queue' }), c()).get(ADA));
  });

  it('a hub spelled with ~ or with a trailing slash in chi.cwd is compared the same way', () => {
    refuseCwd('~/projects/royalti-co', /same directory as chi.cwd/, { chi: { engine: 'claude-code', cwd: '~/projects//royalti-co/.' } });
    refuseCwd('~/projects/royalti-co/x', /inside chi.cwd/, { chi: { engine: 'claude-code', cwd: '~/projects/royalti-co/' } });
  });

  it('refuses a cwd that overlaps any listed privateRoots entry, and a malformed list', () => {
    const roots = ['~/secrets', '~/projects/royalti-co'];
    refuseCwd('~/secrets', /same directory as privateRoots/, { privateRoots: roots });
    refuseCwd('~/secrets/keys', /inside privateRoots/, { privateRoots: roots });
    refuseCwd('~/', /contains/, { privateRoots: roots });
    assert.ok(resolve(adaPolicy(), c({ privateRoots: roots })).get(ADA));
    refuseCwd('~/projects/royalti-co-queue', /privateRoots must be a list/, { privateRoots: ['secrets'] });
    refuseCwd('~/projects/royalti-co-queue', /privateRoots must be a list/, { privateRoots: ['~/a/../b'] });
  });

  it('needs chi.cwd so there is a hub to compare with', () => {
    assert.throws(() => resolve(adaPolicy(), c({ chi: { engine: 'claude-code' } })), /need chi.cwd/);
  });

  it('canonicalPath resolves ~, normalises, and follows symlinks of what exists', () => {
    assert.equal(canonicalPath('~/projects//royalti-co/.', home), hub);
    assert.equal(canonicalPath('~/link-to-hub/new/dir', home), path.join(hub, 'new', 'dir'));
  });
});

// ── allowedUsers overlap ─────────────────────────────────────────────────────

describe('allowedUsers overlap compares usernames as well as ids', () => {
  it('refuses a username entry on a bot with policies (either spelling), and a policy id that is an allowedUsers id', () => {
    for (const entry of ['ada', '@ada', 'founder']) {
      assert.throws(() => resolve(adaPolicy(), { allowedUsers: [FOUNDER, entry] }), /allowedUsers entry '.+' is a username/, entry);
    }
    assert.throws(() => resolve(adaPolicy(), { allowedUsers: [ADA] }), /also in allowedUsers/);
    assert.throws(() => resolve(adaPolicy(), { allowedUsers: [`@${ADA}`] }), /username/);
    // A bot without policies keeps its username entries (nothing is checked for it).
    assert.equal(resolveUserPolicies(undefined, WHERE, ctx({ allowedUsers: ['@ada'] })).size, 0);
  });
});

// ── read and bash rules ──────────────────────────────────────────────────────

describe('read rules are scoped inside the cwd', () => {
  const refuseRule = (rule: string, re: RegExp = /./) => assert.throws(() => resolve(adaPolicy({ allowedTools: [WRAPPER, rule] })), re, rule);

  it('refuses absolute, home, parent, wildcard-first and unscoped forms', () => {
    for (const bad of ['Read(/**)', 'Read(//..)', 'Read(//etc/**)', 'Read(~/**)', 'Read(~)', 'Read(../**)', 'Read(docs/../../x)', 'Read(./../x)', 'Grep(*)', 'Grep(**)', 'Glob(**/*.md)', 'Read(./**)', 'Read(*.md)', 'LS(.)', 'Read(.)', 'Read(./)', 'Read(docs/{a,b})', 'Read($HOME/x)', 'Read(docs/a b)', 'Read(docs/!x)']) {
      refuseRule(bad);
    }
    refuseRule('Read', /no path scope/);
    refuseRule('Grep', /no path scope/);
    refuseRule('Read()', /no path scope/);
  });

  it('accepts a relative path with a literal first segment', () => {
    for (const ok of ['Read(./docs/**)', 'Read(docs/**)', 'Grep(./docs/**/*.md)', 'Glob(docs/*.md)', 'Read(./notes.md)', 'LS(./docs)']) {
      assert.ok(resolve(adaPolicy({ allowedTools: [WRAPPER, ok] })).get(ADA), ok);
    }
  });

  it('refuses a literal prefix that is a symlink out of the cwd (when it exists)', () => {
    const dir = tmpDir('mm-policy-readlink-');
    const cwd = path.join(dir, 'queue');
    mkdirSync(cwd, { recursive: true });
    symlinkSync('/etc', path.join(cwd, 'etc-link'));
    assert.throws(() => resolve(adaPolicy({ cwd, allowedTools: [WRAPPER, 'Read(./etc-link/**)'] }), { home: dir, chi: { engine: 'claude-code', cwd: HUB } }), /symlink that leaves the policy cwd/);
  });
});

describe('bash rules are an exact allowlist', () => {
  const refuseRule = (rule: string) => assert.throws(() => resolve(adaPolicy({ allowedTools: [rule] })), /is not an allowed Bash rule/, rule);

  it('refuses every hole: other programs, shell characters, absolute and parent paths, flags', () => {
    const holes = [
      'Bash(cat secret.txt)', 'Bash(cat:*)', 'Bash(find . -name x:*)', 'Bash(find:*)', 'Bash(awk:*)', 'Bash(cp a b:*)', 'Bash(tee x:*)',
      'Bash(source scripts/x.sh:*)', 'Bash(. scripts/x.sh:*)', 'Bash(busybox sh:*)', 'Bash(env bash scripts/x.sh:*)', 'Bash(command bash scripts/x.sh:*)',
      'Bash(bash${IFS}scripts/x.sh:*)', 'Bash(bash scripts/x.sh${IFS}a:*)', 'Bash(bash <(cat scripts/x.sh):*)', 'Bash(bash scripts/x.sh > out:*)', 'Bash(bash scripts/x.sh >> out:*)',
      'Bash(bash scripts/x.sh < in:*)', 'Bash(bash scripts/x.sh | sh:*)', 'Bash(bash scripts/x.sh && ls:*)', 'Bash(bash scripts/x.sh; ls:*)', 'Bash(bash scripts/x.sh `id`:*)',
      'Bash(bash scripts/x.sh $(id):*)', 'Bash(bash scripts/x.sh "a":*)', "Bash(bash 'scripts/x.sh':*)", 'Bash(bash scripts/x.sh\nls:*)', 'Bash(bash scripts/x.sh a:*)',
      'Bash(bash /etc/x.sh:*)', 'Bash(bash ~/x.sh:*)', 'Bash(bash ../x.sh:*)', 'Bash(bash scripts/../../x.sh:*)', 'Bash(bash scripts/*.sh:*)', 'Bash(bash scripts/x.sh**)',
      'Bash(bash -c:*)', 'Bash(bash -x scripts/x.sh:*)', 'Bash(bash:*)', 'Bash(bash )', 'Bash( bash scripts/x.sh:*)', 'Bash(bash  scripts/x.sh:*)', 'Bash(bash scripts/x.sh :*)',
      'Bash(zsh scripts/x.sh:*)', 'Bash(perl scripts/x.sh:*)', 'Bash(./scripts/x.sh:*)', 'Bash(scripts/x.sh:*)', 'Bash(bash .hidden/x.sh:*)', 'Bash(bash scripts/.x.sh:*)',
      'Bash(bash scripts//x.sh:*)', 'Bash(bash scripts/:*)', 'Bash(bash scripts/x.sh:*:*)', 'Bash(bash scripts/x.sh:)', 'Bash(*)', 'Bash(bash *)', 'Bash(bash scripts/x.sh ; *)',
    ];
    for (const h of holes) refuseRule(h);
  });

  it('accepts only <interpreter> <relative script>[:*| *]', () => {
    for (const ok of ['Bash(bash scripts/x.sh:*)', 'Bash(sh ./scripts/x.sh *)', 'Bash(node scripts/q.mjs)', 'Bash(python3 q.py:*)', 'Bash(bash scripts/cron/run-social-queue-submit.sh:*)']) {
      assert.ok(resolve(adaPolicy({ allowedTools: [ok] })).get(ADA), ok);
    }
  });

  describe('a script that does not exist yet', () => {
    const dir = tmpDir('mm-policy-bash-missing-');
    const cwd = path.join(dir, 'queue');
    const elsewhere = path.join(dir, 'elsewhere');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, path.join(cwd, 'scripts')); // scripts/ is a symlink out of the cwd
    const load = (rule: string) => resolve(adaPolicy({ cwd, allowedTools: [rule] }), { home: dir, chi: { engine: 'claude-code', cwd: HUB }, botUid: (process.getuid?.() ?? 0) + 1 });

    it('is still refused when a directory on its path is a symlink (it must not return early)', () => {
      assert.throws(() => load('Bash(bash scripts/new.sh:*)'), /'scripts' is a symlink/);
      assert.throws(() => load('Bash(bash scripts/deeper/new.sh:*)'), /'scripts' is a symlink/);
    });
    it('is accepted when nothing on its path exists, or the existing part is a real directory', () => {
      const clean = path.join(dir, 'clean');
      mkdirSync(path.join(clean, 'real'), { recursive: true });
      const ok = (rule: string) => resolve(adaPolicy({ cwd: clean, allowedTools: [rule] }), { home: dir, chi: { engine: 'claude-code', cwd: HUB }, botUid: (process.getuid?.() ?? 0) + 1 });
      assert.ok(ok('Bash(bash nothing/here/new.sh:*)').get(ADA));
      assert.ok(ok('Bash(bash real/new.sh:*)').get(ADA));
    });
  });

  describe('a script that exists at load', () => {
    const dir = tmpDir('mm-policy-bash-');
    const cwd = path.join(dir, 'queue');
    mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    const script = path.join(cwd, 'scripts', 'q.sh');
    writeFileSync(script, '#!/bin/bash\necho ok\n');
    const rule = 'Bash(bash scripts/q.sh:*)';
    const uid = process.getuid?.() ?? 0;
    const load = (botUid: number | undefined) => resolve(adaPolicy({ cwd, allowedTools: [rule] }), { home: dir, chi: { engine: 'claude-code', cwd: HUB }, botUid });
    const fix = () => {
      chmodSync(script, 0o755);
      chmodSync(path.join(cwd, 'scripts'), 0o755);
      chmodSync(cwd, 0o755);
    };

    it('is refused when owned by the bot, and accepted when the bot is someone else', () => {
      fix();
      assert.throws(() => load(uid), /owned by the bot's own account/);
      assert.ok(load(uid + 12345).get(ADA));
    });
    it('is refused when group- or world-writable, whoever the bot is', () => {
      chmodSync(script, 0o775);
      assert.throws(() => load(uid + 1), /'scripts\/q.sh' is group- or world-writable/);
      chmodSync(script, 0o757);
      assert.throws(() => load(uid + 1), /group- or world-writable/);
      fix();
    });
    it('is refused when its directory could be renamed over', () => {
      fix();
      chmodSync(path.join(cwd, 'scripts'), 0o777);
      assert.throws(() => load(uid + 1), /directory 'scripts' is group- or world-writable/);
      fix();
      chmodSync(cwd, 0o775);
      assert.throws(() => load(uid + 1), /directory '.' is group- or world-writable/);
      fix();
    });
    it('is refused when it is a symlink', () => {
      fix();
      const real = path.join(dir, 'outside.sh');
      writeFileSync(real, 'x');
      symlinkSync(real, path.join(cwd, 'scripts', 'l.sh'));
      assert.throws(() => resolve(adaPolicy({ cwd, allowedTools: ['Bash(bash scripts/l.sh:*)'] }), { home: dir, chi: { engine: 'claude-code', cwd: HUB }, botUid: uid + 1 }), /is a symlink/);
    });
  });
});

// ── tools ────────────────────────────────────────────────────────────────────

describe('tool names', () => {
  it('knows the CLI tools a policy must be able to deny, and denies each by default', () => {
    const p = resolve(adaPolicy()).get(ADA)!;
    for (const t of ['ToolSearch', 'Monitor', 'CronCreate', 'CronDelete', 'CronList', 'SendMessage', 'RemoteTrigger', 'PushNotification', 'EnterWorktree', 'TaskStop', 'LSP', 'PowerShell', 'Artifact', 'AskUserQuestion', 'ExitPlanMode']) {
      assert.ok(p.toolPolicy.disallowedTools.includes(t), `${t} is denied by default`);
      assert.ok(resolve(adaPolicy({ disallowedTools: [t] })).get(ADA), `${t} can be listed in disallowedTools`);
    }
    assert.throws(() => resolve(adaPolicy({ disallowedTools: ['NotATool'] })), /unknown tool 'NotATool'/);
    assert.throws(() => resolve(adaPolicy({ allowedTools: [WRAPPER, 'Monitor'] })), /can never be allowed/);
    assert.throws(() => resolve(adaPolicy({ allowedTools: [WRAPPER, 'SendMessage'] })), /can never be allowed/);
    assert.throws(() => resolve(adaPolicy({ tools: ['Bash', 'CronCreate'] })), /never available to a policy user/);
  });

  it('a tool the session has is not in the deny list; adding Grep to tools moves it out', () => {
    const p = resolve(adaPolicy({ tools: ['Bash', 'Read', 'Grep'] })).get(ADA)!;
    assert.ok(!p.toolPolicy.disallowedTools.includes('Grep'));
    assert.ok(resolve(adaPolicy()).get(ADA)!.toolPolicy.disallowedTools.includes('Grep'));
  });
});

// ── the daemon's capability, as the client reads it ──────────────────────────

describe('DaemonClient.capabilities', () => {
  const clientWith = (res: () => Response | Promise<Response>) =>
    new DaemonClient({ url: 'http://d', auth: { kind: 'bearer', token: 't' }, fetch: (async () => res()) as unknown as typeof fetch });

  it('reads the capabilities array of /api/health, and treats anything unclear as none', async () => {
    assert.deepEqual(await clientWith(() => Response.json({ ok: true, capabilities: ['chi.toolPolicy', 7, 'x'] })).capabilities(), ['chi.toolPolicy', 'x']);
    assert.deepEqual(await clientWith(() => Response.json({ ok: true })).capabilities(), []);
    assert.deepEqual(await clientWith(() => Response.json({ capabilities: 'chi.toolPolicy' })).capabilities(), []);
    assert.deepEqual(await clientWith(() => new Response('not json')).capabilities(), []);
    assert.deepEqual(await clientWith(() => new Response('{}', { status: 503 })).capabilities(), []);
    assert.deepEqual(await clientWith(() => { throw new Error('down'); }).capabilities(), []);
  });
});

// ── the cwd tree is the read boundary ────────────────────────────────────────

describe('policy cwd tree: no symlink, special file or hard link anywhere in it', () => {
  const dir = tmpDir('mm-policy-tree-');
  const hub = path.join(dir, 'royalti-co');
  mkdirSync(hub, { recursive: true });
  writeFileSync(path.join(hub, 'notes.txt'), 'HUB-SECRET\n');
  let n = 0;
  /** A fresh, clean policy cwd next to the hub: docs/a.md, scripts/q.sh. */
  const fresh = (): string => {
    const cwd = path.join(dir, `queue-${++n}`);
    mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs', 'a.md'), 'doc\n');
    writeFileSync(path.join(cwd, 'scripts', 'q.sh'), 'echo ok\n');
    return cwd;
  };
  const c = { home: dir, chi: { engine: 'claude-code', cwd: hub } };
  const load = (cwd: string) => resolve(adaPolicy({ cwd, allowedTools: [WRAPPER] }), c);
  const refused = (cwd: string, code: string, rel: string) => {
    const r = checkPolicyCwd(cwd, dir);
    assert.equal(r.ok, false, `${code} ${rel}`);
    if (!r.ok) {
      assert.equal(r.code, code);
      assert.equal(r.path, rel);
    }
    assert.throws(() => load(cwd), new RegExp(`cwd is unsafe: ${JSON.stringify(rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*\\(${code}\\)`));
  };

  it('a clean tree passes, and so does a cwd that does not exist yet', () => {
    const cwd = fresh();
    const r = checkPolicyCwd(cwd, dir);
    assert.deepEqual(r, { ok: true, entries: 4 });
    assert.ok(load(cwd).get(ADA));
    assert.deepEqual(checkPolicyCwd(path.join(dir, 'not-there'), dir), { ok: true, entries: 0 });
  });

  it('refuses a symlink to outside the cwd at depth 1 and deeper', () => {
    const d1 = fresh();
    symlinkSync(hub, path.join(d1, 'hublink')); // hublink -> the hub (the verifier's `cat h*/notes.txt`)
    refused(d1, 'symlink', 'hublink');
    const d2 = fresh();
    symlinkSync(path.join(hub, 'notes.txt'), path.join(d2, 'docs', 'more.txt')); // docs/more.txt -> hub file (`cat d*/m*`)
    refused(d2, 'symlink', 'docs/more.txt');
    const d3 = fresh();
    mkdirSync(path.join(d3, 'docs', 'x', 'y', 'z'), { recursive: true });
    symlinkSync('/etc/hostname', path.join(d3, 'docs', 'x', 'y', 'z', 'deep'));
    refused(d3, 'symlink', 'docs/x/y/z/deep');
  });

  it('refuses a symlink that points INSIDE the cwd too, and a dangling one', () => {
    const d1 = fresh();
    symlinkSync('a.md', path.join(d1, 'docs', 'alias.md'));
    refused(d1, 'symlink', 'docs/alias.md');
    const d2 = fresh();
    symlinkSync('docs', path.join(d2, 'docslink'));
    refused(d2, 'symlink', 'docslink');
    const d3 = fresh();
    symlinkSync('/nonexistent/target', path.join(d3, 'dangling'));
    refused(d3, 'symlink', 'dangling');
  });

  it('refuses a cwd that is itself a symlink, and one that is a file', () => {
    const real = fresh();
    const link = path.join(dir, `queue-link-${++n}`);
    symlinkSync(real, link);
    const r = checkPolicyCwd(link, dir);
    assert.equal(r.ok === false && r.code, 'symlink');
    assert.throws(() => load(link), /cwd is unsafe: "\." .*\(symlink\)/);
    const file = path.join(dir, `queue-file-${++n}`);
    writeFileSync(file, 'x');
    const f = checkPolicyCwd(file, dir);
    assert.equal(f.ok === false && f.code, 'not_a_directory');
  });

  it('refuses a FIFO', () => {
    const cwd = fresh();
    const mk = spawnSync('mkfifo', [path.join(cwd, 'docs', 'pipe')]);
    if (mk.status !== 0) return; // no mkfifo on this machine
    refused(cwd, 'special_file', 'docs/pipe');
  });

  it('refuses a hard link to a file (it may be a file outside the cwd), and says nothing about a lone file', () => {
    const cwd = fresh();
    linkSync(path.join(hub, 'notes.txt'), path.join(cwd, 'docs', 'hard.txt'));
    refused(cwd, 'hardlink', 'docs/hard.txt');
    const same = fresh();
    linkSync(path.join(same, 'docs', 'a.md'), path.join(same, 'scripts', 'copy.md')); // two names inside the cwd: also refused
    const r = checkPolicyCwd(same, dir);
    assert.equal(r.ok === false && r.code, 'hardlink');
    unlinkSync(path.join(same, 'scripts', 'copy.md'));
    assert.ok(checkPolicyCwd(same, dir).ok);
  });

  it('reports the first offender in sorted order, with its path only', () => {
    const cwd = fresh();
    symlinkSync(hub, path.join(cwd, 'zz'));
    symlinkSync(hub, path.join(cwd, 'aa'));
    const r = checkPolicyCwd(cwd, dir);
    assert.equal(r.ok === false && r.path, 'aa');
    assert.ok(!JSON.stringify(r).includes('HUB-SECRET'));
  });

  it('is capped: too many entries and too deep are refused, with a clear error', () => {
    const cwd = fresh();
    for (let i = 0; i < 6; i++) writeFileSync(path.join(cwd, 'docs', `f${i}.md`), String(i));
    const many = checkPolicyCwd(cwd, dir, { maxEntries: 5 });
    assert.equal(many.ok === false && many.code, 'too_many_entries');
    assert.ok(many.ok === false && /more than 10000 entries/.test(many.detail));
    const deep = fresh();
    mkdirSync(path.join(deep, 'a', 'b', 'c'), { recursive: true });
    const tooDeep = checkPolicyCwd(deep, dir, { maxDepth: 2 });
    assert.equal(tooDeep.ok === false && tooDeep.code, 'too_deep');
    assert.equal(tooDeep.ok === false && tooDeep.path, 'a/b/c');
    assert.ok(checkPolicyCwd(deep, dir, { maxDepth: 3 }).ok);
    // Defaults: 20 levels are fine, 21 are not.
    const d20 = fresh();
    mkdirSync(path.join(d20, ...Array.from({ length: 20 }, (_, i) => `d${i}`)), { recursive: true });
    assert.ok(checkPolicyCwd(d20, dir).ok);
    mkdirSync(path.join(d20, ...Array.from({ length: 21 }, (_, i) => `d${i}`)), { recursive: true });
    const r21 = checkPolicyCwd(d20, dir);
    assert.equal(r21.ok === false && r21.code, 'too_deep');
    assert.throws(() => load(d20), /nested deeper than 20 levels/);
  });

  it('glob-escape fixture: the shell really reads the hub through it, and the policy is refused at load', () => {
    // The verifier's tree: hublink -> ../royalti-co and docs/more.txt -> ../../royalti-co/notes.txt.
    const cwd = fresh();
    symlinkSync('../royalti-co', path.join(cwd, 'hublink'));
    symlinkSync('../../royalti-co/notes.txt', path.join(cwd, 'docs', 'more.txt'));
    for (const cmd of ['cat h*/notes.txt', 'cat d*/m*']) {
      const r = spawnSync('sh', ['-c', cmd], { cwd });
      assert.equal(String(r.stdout), 'HUB-SECRET\n', `${cmd} escapes through the symlink`);
    }
    assert.throws(() => load(cwd), /cwd is unsafe: "docs\/more.txt" .*\(symlink\)/); // sorted order: docs/ before hublink
    unlinkSync(path.join(cwd, 'docs', 'more.txt'));
    assert.throws(() => load(cwd), /cwd is unsafe: "hublink" .*\(symlink\)/);
    unlinkSync(path.join(cwd, 'hublink'));
    assert.ok(load(cwd).get(ADA));
  });

  it('is checked through the whole config load, not only resolveUserPolicies', () => {
    const cwd = fresh();
    symlinkSync(hub, path.join(cwd, 'hublink'));
    const file = (): BridgeFileConfig => ({
      mattermostUrl: 'http://127.0.0.1:1',
      bots: {
        ruby: {
          mattermostToken: { env: 'MM_TEST_TOKEN' },
          allowedUsers: [FOUNDER],
          allowedChannels: ['ruby-test'],
          daemon: { url: 'http://127.0.0.1:1', auth: { kind: 'session', username: 'ruby', password: { env: 'DAEMON_TEST_PW' } } },
          chi: { engine: 'claude-code', cwd: hub },
          maxMode: 'default',
          userPolicies: { [ADA]: adaPolicy({ cwd, allowedTools: [WRAPPER] }) },
        },
      },
    });
    process.env.MM_TEST_TOKEN = MM_TOKEN;
    process.env.DAEMON_TEST_PW = PASSWORD;
    assert.throws(() => resolveBridgeConfigs(file()), /cwd is unsafe: "hublink"/);
  });
});

describe('bridge: the cwd is walked again before every policy start and resume', () => {
  let mm: MockMattermostServer;
  let daemon: MockDaemon;
  let dir: string;
  let cwd: string;
  let bridge: MattermostBridge | undefined;
  const audit = (): AuditRecord[] => {
    try {
      return readFileSync(path.join(dir, 'audit-ruby.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
    } catch {
      return [];
    }
  };
  const chiRuns = () => daemon.rpcCalls('chi_run').map((c) => ((c.args.opts ?? c.args) as Record<string, unknown>));
  const say = (id: string, text: string, root?: string) => mm.broadcastPost({ id, user_id: ADA, channel_id: 'id-royalti-co', message: text, root_id: root }, 'royalti-co', '@ada');
  const link = () => symlinkSync('/etc/hostname', path.join(cwd, 'docs', 'sneaky.txt'));
  const unlink = () => unlinkSync(path.join(cwd, 'docs', 'sneaky.txt'));

  beforeEach(async () => {
    mm = new MockMattermostServer();
    daemon = new MockDaemon('t1', { username: 'ruby', password: PASSWORD });
    dir = tmpDir('mm-policy-rewalk-');
    cwd = path.join(dir, 'queue');
    mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs', 'a.md'), 'doc\n');
    mm.channels.set('royalti-co', 'id-royalti-co');
    const mmUrl = await mm.listen();
    const daemonUrl = await daemon.listen();
    process.env.MM_TEST_TOKEN = MM_TOKEN;
    process.env.DAEMON_TEST_PW = PASSWORD;
    const [cfg] = resolveBridgeConfigs({
      mattermostUrl: mmUrl,
      dataDir: dir,
      bots: {
        ruby: {
          mattermostToken: { env: 'MM_TEST_TOKEN' },
          allowedUsers: [FOUNDER],
          allowedChannels: ['ruby-test'],
          daemon: { url: daemonUrl, auth: { kind: 'session', username: 'ruby', password: { env: 'DAEMON_TEST_PW' } } },
          chi: { engine: 'claude-code', cwd: HUB, systemPrompt: 'You are Ruby.', persistent: true },
          maxMode: 'default',
          progress: FAST,
          userPolicies: { [ADA]: adaPolicy({ cwd }) },
        },
      },
    });
    bridge = new MattermostBridge(cfg as MattermostBridgeConfig);
    await bridge.start();
    await pause(60);
  });
  afterEach(async () => {
    bridge?.stop();
    bridge = undefined;
    await mm.close();
    await daemon.close();
  });

  it('a symlink that appears after load stops the next START: no chi_run, a channel message, policy.cwd_unsafe naming the path', async () => {
    link();
    say('a1', 'queue this');
    await waitFor(() => mm.receivedPosts.some((p) => p.message.includes('failed its safety check')), 'refusal in the channel');
    assert.equal(chiRuns().length, 0);
    assert.equal(daemon.rpcCalls('chi_resume').length, 0);
    const rec = audit().find((r) => r.event === 'policy.cwd_unsafe');
    assert.ok(rec);
    assert.equal(rec.reason, 'symlink');
    assert.equal(rec.path, 'docs/sneaky.txt');
    assert.equal(rec.kind, 'thread');
    assert.equal(rec.policy, 'ada-social-queue');
    assert.ok(!mm.receivedPosts.some((p) => p.message.includes('sneaky')), 'the channel message does not name the path');
    // Fixed: the next message starts normally.
    unlink();
    say('a2', 'queue this again');
    await waitFor(() => chiRuns().length === 1, 'run after the fix');
  });

  it('a symlink that appears after the first run stops the RESUME: no chi_resume', async () => {
    say('a1', 'queue one');
    await waitFor(() => chiRuns().length === 1, 'first run');
    daemon.settle('run-1', 'done', { output: 'queued' });
    await waitFor(() => mm.receivedPosts.some((p) => p.message.startsWith('queued')), 'answer');
    await waitFor(() => bridge!.router!.activeCount() === 0, 'turn closed');
    link();
    say('a2', 'and another', 'a1');
    await waitFor(() => audit().some((r) => r.event === 'policy.cwd_unsafe'), 'refused');
    assert.equal(daemon.rpcCalls('chi_resume').length, 0);
    assert.equal(chiRuns().length, 1);
    const rec = audit().find((r) => r.event === 'policy.cwd_unsafe');
    assert.equal(rec?.kind, 'resume');
    assert.equal(rec?.run_id, 'run-1');
    // A FIFO and a hard link are refused the same way.
    unlink();
    linkSync(path.join(cwd, 'docs', 'a.md'), path.join(cwd, 'docs', 'twin.md'));
    say('a3', 'once more', 'a1');
    await waitFor(() => audit().filter((r) => r.event === 'policy.cwd_unsafe').length === 2, 'second refusal');
    assert.equal(audit().filter((r) => r.event === 'policy.cwd_unsafe').pop()?.reason, 'hardlink');
    assert.equal(daemon.rpcCalls('chi_resume').length, 0);
    unlinkSync(path.join(cwd, 'docs', 'twin.md'));
    say('a4', 'finally', 'a1');
    await waitFor(() => daemon.rpcCalls('chi_resume').length === 1, 'resume once the tree is clean');
  });

  it('the founder is not affected by the policy cwd', async () => {
    link();
    mm.broadcastPost({ id: 'f1', user_id: FOUNDER, channel_id: 'c-ruby-test', message: 'status?' }, 'ruby-test', '@founder');
    await waitFor(() => chiRuns().length === 1, 'founder run');
    assert.ok(!audit().some((r) => r.event === 'policy.cwd_unsafe'));
  });
});
