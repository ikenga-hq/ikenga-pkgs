import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MattermostBridge } from './bridge.js';
import { ChannelLookupError } from './client.js';
import { resolveBridgeConfigs } from './config.js';
import type { BridgeFileConfig } from './config.js';
import { minuteFloor } from './cron.js';
import { DaemonError } from './daemon.js';
import type { ChiRunOpts, ChiRunResult } from './daemon.js';
import { MockDaemon } from './mock-daemon.js';
import { MockMattermostServer } from './mock-server.js';
import { ScheduleRunner, ScheduleStore, resolveSchedules, SCHEDULE_NOTE, QUIET_NOTE } from './schedules.js';
import type { ScheduleApi, ScheduleChiApi } from './schedules.js';
import type { MattermostPost, ScheduleConfig } from './types.js';

const FAST = { pollMinMs: 5, pollMaxMs: 10, editIntervalMs: 0, maxWaitMs: 60_000, maxPollFailures: 2 };
const PASSWORD = 'hunter2-very-secret';
const ALLOWED = ['engineering', 'rex-test', 'ruby-test'];
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
// 2026-10-12 is a Monday.
const MON_0759 = utc(2026, 10, 12, 7, 59, 30);

const STANDUP: ScheduleConfig = { name: 'weekly-standup', cron: '0 8 * * 1', channel: 'rex-test', task: 'Post the weekly standup.' };

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── fakes for the unit tests ─────────────────────────────────────────────────

class FakeClient implements ScheduleApi {
  posts: Array<{ id: string; channel: string; message: string; root?: string }> = [];
  resolveCalls: string[] = [];
  resolveError?: Error;
  failPosts = false;
  async reply(channel: string, message: string, root?: string): Promise<MattermostPost> {
    if (this.failPosts) throw new Error('mattermost down');
    const id = `post-${this.posts.length + 1}`;
    this.posts.push({ id, channel, message, root });
    return { id, user_id: 'bot', channel_id: channel, message, root_id: root };
  }
  async resolveChannelId(ref: string): Promise<string> {
    this.resolveCalls.push(ref);
    if (this.resolveError) throw this.resolveError;
    return `id-${ref}`;
  }
}

interface FakeRun {
  status: string;
  output?: string;
  error?: string;
  truncated?: boolean;
}

class FakeDaemon implements ScheduleChiApi {
  calls: ChiRunOpts[] = [];
  runs = new Map<string, FakeRun>();
  /** Applied to each new run. `running` keeps it going until `finish`. */
  next: FakeRun = { status: 'done', output: 'RESULT' };
  startError?: Error;
  statusError?: Error;
  statusCalls = 0;
  async chiRun(opts: ChiRunOpts): Promise<ChiRunResult> {
    if (this.startError) throw this.startError;
    this.calls.push(opts);
    const id = `run-${this.calls.length}`;
    this.runs.set(id, { ...this.next });
    return { run_id: id, status: 'running' };
  }
  async chiStatus(runId: string): Promise<ChiRunResult> {
    this.statusCalls += 1;
    if (this.statusError) throw this.statusError;
    const r = this.runs.get(runId);
    if (!r) throw new DaemonError('chi_status: chi run not found', 'rpc');
    return { run_id: runId, status: r.status, output: r.output ?? null, error: r.error ?? null, output_truncated: r.truncated ?? false };
  }
  finish(runId: string, patch: FakeRun): void {
    this.runs.set(runId, patch);
  }
  redact(text: string): string {
    return text.split(PASSWORD).join('[redacted]');
  }
}

interface Unit {
  client: FakeClient;
  daemon: FakeDaemon;
  clock: { t: number };
  dir: string;
  statePath: string;
  logs: string[];
  store: ScheduleStore;
  make: (over?: { schedules?: ScheduleConfig[]; chi?: object; lateGraceMs?: number }) => ScheduleRunner;
  /** A new runner over the same state file, as after a bridge restart. */
  restart: (over?: { schedules?: ScheduleConfig[]; lateGraceMs?: number }) => ScheduleRunner;
}

let u: Unit;
const dirs: string[] = [];

function unit(): Unit {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mm-b4-'));
  dirs.push(dir);
  const statePath = path.join(dir, 'schedules-rex.json');
  const client = new FakeClient();
  const daemon = new FakeDaemon();
  const clock = { t: MON_0759 };
  const logs: string[] = [];
  const build = (over: { schedules?: ScheduleConfig[]; chi?: object; lateGraceMs?: number } = {}) => {
    const store = new ScheduleStore(statePath);
    out.store = store;
    return new ScheduleRunner({
      bot: 'rex',
      schedules: resolveSchedules(over.schedules ?? [STANDUP], 'bot rex', ALLOWED),
      client,
      daemon,
      store,
      chi: { engine: 'claude-code', cwd: '~/work/royalti', systemPrompt: 'You are Rex.', ...over.chi },
      progress: FAST,
      scheduler: { tickMs: 60_000, lateGraceMs: over.lateGraceMs },
      now: () => clock.t,
      log: (m) => logs.push(m),
    });
  };
  const out: Unit = { client, daemon, clock, dir, statePath, logs, store: new ScheduleStore(statePath), make: build, restart: build };
  return out;
}

beforeEach(() => {
  u = unit();
});

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

// ── config validation ────────────────────────────────────────────────────────

describe('B4 config validation', () => {
  const ok = (over: Partial<ScheduleConfig> = {}) => ({ ...STANDUP, ...over }) as ScheduleConfig;

  it('accepts a good schedule, defaults it, and strips a leading # from the channel', () => {
    const [s] = resolveSchedules([ok({ channel: '#rex-test' })], 'bot rex', ALLOWED);
    assert.equal(s?.channel, 'rex-test');
    assert.equal(s?.enabled, true);
    assert.equal(s?.onMissed, 'once');
    assert.equal(s?.quiet, false);
    assert.deepEqual(resolveSchedules(undefined, 'bot rex', ALLOWED), []);
    assert.deepEqual(resolveSchedules([], 'bot rex', ALLOWED), []);
  });

  it('refuses a bad cron, naming the bot, the schedule and the field', () => {
    assert.throws(() => resolveSchedules([ok({ cron: '61 8 * * 1' })], 'bot rex', ALLOWED), /bot rex: schedule 'weekly-standup': invalid cron: minute: 61 is outside 0-59/);
    assert.throws(() => resolveSchedules([ok({ cron: '0 8 * *' })], 'bot rex', ALLOWED), /exactly 5 fields/);
    assert.throws(() => resolveSchedules([ok({ cron: '0 0 30 2 *' })], 'bot rex', ALLOWED), /never fires/);
    assert.throws(() => resolveSchedules([ok({ cron: undefined as unknown as string })], 'bot rex', ALLOWED), /invalid cron/);
  });

  it('refuses a channel that is not one of the bot\'s allowed channels', () => {
    assert.throws(() => resolveSchedules([ok({ channel: 'off-topic' })], 'bot rex', ALLOWED), /unknown channel 'off-topic'.*allowedChannels/);
    assert.throws(() => resolveSchedules([ok({ channel: '' })], 'bot rex', ALLOWED), /channel is required/);
    assert.throws(() => resolveSchedules([ok()], 'bot rex', []), /unknown channel/);
  });

  it('refuses duplicate names, case-insensitively', () => {
    assert.throws(() => resolveSchedules([ok(), ok({ name: 'Weekly-Standup', cron: '0 9 * * 1' })], 'bot rex', ALLOWED), /duplicate schedule name/);
  });

  it('refuses unknown fields; `mode` gets an explanation', () => {
    assert.throws(() => resolveSchedules([{ ...ok(), mode: 'auto' } as ScheduleConfig], 'bot rex', ALLOWED), /unknown field 'mode'.*always read-only/);
    assert.throws(() => resolveSchedules([{ ...ok(), cronn: 'x' } as ScheduleConfig], 'bot rex', ALLOWED), /unknown field 'cronn'/);
  });

  it('refuses a missing name or task, a bad onMissed, enabled, quiet, timeout', () => {
    assert.throws(() => resolveSchedules([ok({ name: '' })], 'bot rex', ALLOWED), /name is required/);
    assert.throws(() => resolveSchedules([ok({ name: 'has space' })], 'bot rex', ALLOWED), /name is required/);
    assert.throws(() => resolveSchedules([ok({ task: '  ' })], 'bot rex', ALLOWED), /task is required/);
    assert.throws(() => resolveSchedules([ok({ onMissed: 'always' as 'skip' })], 'bot rex', ALLOWED), /onMissed must be 'skip' or 'once'/);
    assert.throws(() => resolveSchedules([ok({ enabled: 'yes' as unknown as boolean })], 'bot rex', ALLOWED), /enabled must be/);
    assert.throws(() => resolveSchedules([ok({ quiet: 1 as unknown as boolean })], 'bot rex', ALLOWED), /quiet must be/);
    assert.throws(() => resolveSchedules([ok({ timeoutSeconds: -5 })], 'bot rex', ALLOWED), /timeoutSeconds/);
    assert.throws(() => resolveSchedules('nope' as unknown as ScheduleConfig[], 'bot rex', ALLOWED), /must be an array/);
    assert.throws(() => resolveSchedules([null as unknown as ScheduleConfig], 'bot rex', ALLOWED), /must be an object/);
  });

  it('validates a disabled schedule too', () => {
    assert.throws(() => resolveSchedules([ok({ enabled: false, cron: 'bogus' })], 'bot rex', ALLOWED), /invalid cron/);
  });

  it('the file loader refuses at load and names the bot', () => {
    const file = (schedules: ScheduleConfig[]): BridgeFileConfig => ({
      mattermostUrl: 'http://mm',
      dataDir: u.dir,
      bots: {
        rex: {
          mattermostToken: { value: 'tok' },
          allowedUsers: ['alice'],
          allowedChannels: ['engineering', 'rex-test'],
          daemon: { url: 'http://d', auth: { kind: 'bearer', token: { value: 'tok-abcdef' } } },
          chi: { engine: 'claude-code' },
          schedules,
        },
      },
    });
    assert.equal(resolveBridgeConfigs(file([STANDUP]))[0]?.schedules?.length, 1);
    assert.throws(() => resolveBridgeConfigs(file([{ ...STANDUP, cron: 'x' }])), /bot 'rex': schedule 'weekly-standup': invalid cron/);
    assert.throws(() => resolveBridgeConfigs(file([{ ...STANDUP, channel: 'nowhere' }])), /bot 'rex': schedule 'weekly-standup': unknown channel 'nowhere'/);
    assert.throws(() => resolveBridgeConfigs(file([STANDUP, STANDUP])), /duplicate schedule name/);
  });

  it('a bot without daemon+chi cannot have schedules', () => {
    assert.throws(
      () =>
        new MattermostBridge({
          mattermostUrl: 'http://mm',
          mattermostToken: 't',
          allowedUsers: ['alice'],
          allowedChannels: ['rex-test'],
          name: 'rex',
          schedules: [STANDUP],
        }),
      /schedules needs daemon and chi/,
    );
  });
});

// ── the runner ───────────────────────────────────────────────────────────────

describe('B4 scheduler', () => {
  it('a new schedule is only recorded, never run "for the past"', async () => {
    u.clock.t = utc(2026, 10, 12, 8, 0, 20); // already past this Monday's 08:00
    const r = u.make();
    await r.tick();
    await r.whenIdle();
    assert.equal(u.daemon.calls.length, 0);
    assert.equal(u.client.posts.length, 0);
    assert.equal(u.store.get('weekly-standup')?.last_slot, utc(2026, 10, 12, 8, 0));
  });

  it('runs at the due time: plan mode, persona + task + note, result posted as a new root post with a header', async () => {
    const r = u.make();
    await r.tick(); // 07:59:30, baseline
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r.tick();
    await r.whenIdle();

    assert.equal(u.daemon.calls.length, 1);
    const call = u.daemon.calls[0] as ChiRunOpts;
    assert.equal(call.mode, 'plan');
    assert.equal(call.engineId, 'claude-code');
    assert.equal(call.cwd, '~/work/royalti');
    assert.equal(call.persistent, true);
    assert.equal(call.prompt, `You are Rex.\n\n---\n\nPost the weekly standup.${SCHEDULE_NOTE}`);

    assert.equal(u.client.posts.length, 1);
    const post = u.client.posts[0]!;
    assert.equal(post.channel, 'id-rex-test');
    assert.equal(post.root, undefined, 'a new root post, not a reply');
    assert.equal(post.message, '**Scheduled run: weekly-standup** (2026-10-12 08:00 UTC)\n\nRESULT');
    assert.equal(u.store.get('weekly-standup')?.last_status, 'ok');
    assert.equal(u.store.get('weekly-standup')?.last_run_id, 'run-1');
    assert.equal(u.store.get('weekly-standup')?.in_flight, undefined);
  });

  it('per-schedule cwd and engine override the bot defaults; the model and timeout still come from chi', async () => {
    const r = u.make({
      schedules: [{ ...STANDUP, cwd: '/srv/other', engine: 'codex', timeoutSeconds: 300 }],
      chi: { model: 'sonnet' },
    });
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r.tick();
    await r.whenIdle();
    const call = u.daemon.calls[0] as ChiRunOpts;
    assert.equal(call.cwd, '/srv/other');
    assert.equal(call.engineId, 'codex');
    assert.equal(call.timeoutSeconds, 300);
    assert.equal(call.model, 'sonnet');
    assert.equal(call.mode, 'plan');
  });

  it('PLAN MODE is enforced even when chi.mode says otherwise', async () => {
    const r = u.make({ chi: { mode: 'bypassPermissions' } });
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r.tick();
    await r.whenIdle();
    assert.equal(u.daemon.calls[0]?.mode, 'plan');
    // and a manual run, which is the same run
    await r.runNow('weekly-standup');
    assert.equal(u.daemon.calls[1]?.mode, 'plan');
  });

  it('is not run twice for the same occurrence (same minute, later ticks)', async () => {
    const r = u.make();
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 1);
    await r.tick();
    await r.whenIdle();
    u.clock.t = utc(2026, 10, 12, 8, 0, 40);
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 3, 0);
    await r.tick();
    await r.whenIdle();
    assert.equal(u.daemon.calls.length, 1);
    assert.equal(u.client.posts.length, 1);
  });

  it('a restart does not double-post: the handled slot is on disk before the run starts', async () => {
    const r1 = u.make();
    await r1.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    u.daemon.next = { status: 'running' }; // the run is still going when the bridge dies
    await r1.tick();
    await waitFor(() => u.daemon.calls.length === 1, 'run started');
    await u.store.flushed();
    r1.stop(); // restart

    u.clock.t = utc(2026, 10, 12, 8, 0, 25);
    u.daemon.next = { status: 'done', output: 'RESULT' };
    const r2 = u.restart();
    await r2.tick();
    await r2.whenIdle();
    assert.equal(u.daemon.calls.length, 1, 'the same occurrence is not started again');
    assert.equal(JSON.parse(readFileSync(u.statePath, 'utf8')).schedules['weekly-standup'].last_slot, utc(2026, 10, 12, 8, 0));
  });

  it('the state file is written atomically with mode 0600', async () => {
    const r = u.make();
    await r.tick();
    await u.store.flushed();
    assert.equal(statSync(u.statePath).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${u.statePath}.${process.pid}.tmp`), 'no temp file left behind');
  });

  describe('due-time computation across a restart', () => {
    it('down across the due time but back within the grace: it is on time, so it runs, not "late"', async () => {
      const r1 = u.make();
      await r1.tick(); // baseline at 07:59:30
      r1.stop();
      u.clock.t = utc(2026, 10, 12, 8, 2, 0); // back 2 minutes after 08:00
      const r2 = u.restart();
      await r2.tick();
      await r2.whenIdle();
      assert.equal(u.daemon.calls.length, 1);
      assert.match(u.client.posts[0]?.message ?? '', /^\*\*Scheduled run: weekly-standup\*\* \(2026-10-12 08:00 UTC\)\n/, 'no "late" marker');
    });

    it('onMissed once: a long outage runs the latest missed occurrence once, marked late', async () => {
      const r1 = u.make();
      await r1.tick();
      r1.stop();
      u.clock.t = utc(2026, 10, 12, 11, 30, 0); // down 3.5 h across Monday 08:00
      const r2 = u.restart();
      await r2.start();
      await r2.whenIdle();
      r2.stop();
      assert.equal(u.daemon.calls.length, 1);
      assert.equal(u.client.posts[0]?.message, '**Scheduled run: weekly-standup** (2026-10-12 08:00 UTC, run late after downtime)\n\nRESULT');
      // another restart straight after: nothing more
      const r3 = u.restart();
      await r3.start();
      await r3.whenIdle();
      r3.stop();
      assert.equal(u.daemon.calls.length, 1);
    });

    it('onMissed skip: the missed occurrence is dropped (and stays dropped), the next one runs', async () => {
      const sched = [{ ...STANDUP, onMissed: 'skip' as const }];
      const r1 = u.make({ schedules: sched });
      await r1.tick();
      r1.stop();
      u.clock.t = utc(2026, 10, 12, 11, 30, 0);
      const r2 = u.restart({ schedules: sched });
      await r2.start();
      await r2.whenIdle();
      assert.equal(u.daemon.calls.length, 0);
      assert.ok(u.logs.some((l) => /missed 2026-10-12T08:00:00.000Z.*onMissed is skip/.test(l)));
      u.clock.t = utc(2026, 10, 12, 11, 31, 0);
      await r2.tick();
      assert.equal(u.daemon.calls.length, 0, 'still nothing the next minute');
      u.clock.t = utc(2026, 10, 19, 8, 0, 3);
      await r2.tick();
      await r2.whenIdle();
      r2.stop();
      assert.equal(u.daemon.calls.length, 1, 'next Monday runs');
    });

    it('many missed occurrences collapse into ONE run, never a storm', async () => {
      const daily = [{ name: 'digest', cron: '0 7 * * *', channel: 'ruby-test', task: 'digest' }];
      const r1 = u.make({ schedules: daily });
      await r1.tick();
      r1.stop();
      u.clock.t = utc(2026, 10, 19, 12, 0, 0); // a week later
      const r2 = u.restart({ schedules: daily });
      await r2.start();
      await r2.whenIdle();
      r2.stop();
      assert.equal(u.daemon.calls.length, 1);
      assert.match(u.client.posts[0]?.message ?? '', /\(2026-10-19 07:00 UTC, run late/);
      assert.ok(u.logs.some((l) => /7 occurrences came due; running only the latest/.test(l)));
    });

    it('a corrupt state file is moved aside; the schedule restarts from "now" (no catch-up, no crash)', async () => {
      writeFileSync(u.statePath, '{not json');
      const r = u.make();
      await r.tick();
      await r.whenIdle();
      assert.equal(u.daemon.calls.length, 0);
      assert.ok(existsSync(u.statePath), 'a fresh file was written');
    });
  });

  it('a disabled schedule never runs, and its state is dropped so re-enabling does not catch up', async () => {
    const r1 = u.make();
    await r1.tick();
    r1.stop();
    u.clock.t = utc(2026, 10, 12, 11, 30, 0);
    const r2 = u.restart({ schedules: [{ ...STANDUP, enabled: false }] });
    await r2.start();
    await r2.whenIdle();
    assert.equal(u.daemon.calls.length, 0);
    assert.equal(u.store.get('weekly-standup'), undefined);
    r2.stop();
    // re-enable a week later: first sight, only a baseline
    u.clock.t = utc(2026, 10, 19, 12, 0, 0);
    const r3 = u.restart();
    await r3.start();
    await r3.whenIdle();
    r3.stop();
    assert.equal(u.daemon.calls.length, 0);
  });

  it('state of a schedule that was removed from the config is forgotten', async () => {
    const r1 = u.make();
    await r1.tick();
    r1.stop();
    const r2 = u.restart({ schedules: [{ name: 'other', cron: '0 9 * * *', channel: 'rex-test', task: 't' }] });
    await r2.start();
    r2.stop();
    assert.equal(u.store.get('weekly-standup'), undefined);
    assert.notEqual(u.store.get('other'), undefined);
  });

  describe('overlap', () => {
    it('skips (and logs) an occurrence while the previous run is still going, then resumes the next time', async () => {
      const every5 = [{ name: 'box-alerts', cron: '*/5 * * * *', channel: 'rex-test', task: 'check the box' }];
      const r = u.make({ schedules: every5 });
      u.daemon.next = { status: 'running' };
      await r.tick(); // baseline 07:59:30
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r.tick(); // starts run-1, which stays running
      await waitFor(() => u.daemon.calls.length === 1, 'first run');

      u.clock.t = utc(2026, 10, 12, 8, 5, 5);
      await r.tick(); // 08:05 is due but run-1 is still running
      assert.equal(u.daemon.calls.length, 1, 'no second run');
      assert.ok(u.logs.some((l) => /box-alerts.*previous run is still going; skipping/.test(l)));
      assert.equal(u.store.get('box-alerts')?.last_slot, utc(2026, 10, 12, 8, 5), 'the skipped occurrence is consumed, not queued');

      u.daemon.finish('run-1', { status: 'done', output: 'ALL GOOD' });
      await r.whenIdle();
      assert.equal(u.client.posts.length, 1, 'only the first run posted');

      u.daemon.next = { status: 'done', output: 'ALL GOOD 2' };
      u.clock.t = utc(2026, 10, 12, 8, 10, 5);
      await r.tick();
      await r.whenIdle();
      assert.equal(u.daemon.calls.length, 2);
      assert.equal(u.client.posts.length, 2);
    });

    it('a manual run while a scheduled one is going reports overlap and starts nothing', async () => {
      const r = u.make();
      u.daemon.next = { status: 'running' };
      await r.tick();
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r.tick();
      await waitFor(() => u.daemon.calls.length === 1, 'run started');
      assert.deepEqual(await r.runNow('weekly-standup'), { kind: 'overlap' });
      assert.equal(u.daemon.calls.length, 1);
      u.daemon.finish('run-1', { status: 'done', output: 'x' });
      await r.whenIdle();
    });
  });

  describe('failures', () => {
    const due = async (r: ScheduleRunner) => {
      await r.tick();
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r.tick();
      await r.whenIdle();
    };

    it('a failed run posts a short notice (not a result), and records the failure', async () => {
      u.daemon.next = { status: 'failed', error: `engine crashed; token ${PASSWORD}` };
      await due(u.make());
      assert.equal(u.client.posts.length, 1);
      const msg = u.client.posts[0]?.message ?? '';
      assert.match(msg, /^\*\*Scheduled run: weekly-standup\*\* \(2026-10-12 08:00 UTC\)\n\nThis scheduled run failed after \d+s: engine crashed; token \[redacted\]\. Run `run-1`\.$/);
      assert.ok(!msg.includes(PASSWORD));
      assert.equal(u.store.get('weekly-standup')?.last_status, 'failed');
    });

    it('timed out, cancelled, and "finished with no text" each post a notice', async () => {
      for (const [run, expected] of [
        [{ status: 'timed_out' }, /timed out after \d+s/],
        [{ status: 'cancelled' }, /was cancelled/],
        [{ status: 'done', output: '' }, /finished but returned no result text/],
        [{ status: 'done', output: `You are Rex.\n\n---\n\nPost the weekly standup.${SCHEDULE_NOTE}` }, /finished but returned no result text/],
      ] as Array<[FakeRun, RegExp]>) {
        u = unit();
        u.daemon.next = run;
        await due(u.make());
        assert.equal(u.client.posts.length, 1);
        assert.match(u.client.posts[0]?.message ?? '', expected);
        assert.ok(!(u.client.posts[0]?.message ?? '').includes('RESULT'));
      }
    });

    it('chi_run failing to start posts a notice, and the occurrence is not retried', async () => {
      u.daemon.startError = new DaemonError('chi_run: engine claude-code is not installed', 'rpc');
      const r = u.make();
      await due(r);
      assert.match(u.client.posts[0]?.message ?? '', /This scheduled run could not start: chi_run: engine claude-code is not installed\./);
      assert.equal(u.store.get('weekly-standup')?.last_status, 'failed');
      u.clock.t = utc(2026, 10, 12, 8, 0, 40);
      await r.tick();
      await r.whenIdle();
      assert.equal(u.client.posts.length, 1, 'one notice, no retry storm');
    });

    it('a run the daemon forgot, and a dead daemon, each post a notice', async () => {
      u.daemon.next = { status: 'running' };
      const r = u.make();
      await r.tick();
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r.tick();
      await waitFor(() => u.daemon.calls.length === 1, 'started');
      u.daemon.runs.delete('run-1');
      await r.whenIdle();
      assert.match(u.client.posts[0]?.message ?? '', /no longer has its run/);

      u = unit();
      u.daemon.next = { status: 'running' };
      u.daemon.statusError = new DaemonError('daemon unreachable', 'network');
      await due(u.make());
      assert.match(u.client.posts[0]?.message ?? '', /lost contact with the Ikenga daemon/);
    });

    it('a Mattermost outage on posting is logged and does not throw or retry', async () => {
      u.client.failPosts = true;
      await due(u.make());
      assert.ok(u.logs.some((l) => /could not post to channel id-rex-test: mattermost down/.test(l)));
      assert.equal(u.daemon.calls.length, 1);
    });
  });

  describe('quiet schedules (post only problems)', () => {
    const box = [{ name: 'box-alerts', cron: '0 * * * *', channel: 'rex-test', task: 'check the box', quiet: true }];
    const hour = async (r: ScheduleRunner, y: number, mo: number, d: number, h: number) => {
      u.clock.t = utc(y, mo, d, h, 0, 5);
      await r.tick();
      await r.whenIdle();
    };

    it('tells the run how to say "all OK"', async () => {
      const r = u.make({ schedules: box });
      await r.tick();
      await hour(r, 2026, 10, 12, 8);
      assert.ok(u.daemon.calls[0]?.prompt.endsWith(`${SCHEDULE_NOTE}${QUIET_NOTE}`));
    });

    it('posts the OK line at most once per UTC day, and always posts problems', async () => {
      const r = u.make({ schedules: box });
      await r.tick();
      u.daemon.next = { status: 'done', output: 'ALL_OK disk 41%, mem 55%, no failed runs' };
      await hour(r, 2026, 10, 12, 8);
      await hour(r, 2026, 10, 12, 9);
      await hour(r, 2026, 10, 12, 10);
      assert.equal(u.daemon.calls.length, 3, 'it still checks every hour');
      assert.equal(u.client.posts.length, 1, 'but says OK once');
      assert.equal(u.client.posts[0]?.message, '**Scheduled run: box-alerts** (2026-10-12 08:00 UTC)\n\ndisk 41%, mem 55%, no failed runs');

      u.daemon.next = { status: 'done', output: 'Disk is 93% full on /var/lib/ikenga.' };
      await hour(r, 2026, 10, 12, 11);
      assert.equal(u.client.posts.length, 2, 'a problem is posted even though OK was already said today');
      assert.match(u.client.posts[1]?.message ?? '', /Disk is 93% full/);

      u.daemon.next = { status: 'done', output: 'ALL_OK fine' };
      await hour(r, 2026, 10, 12, 12);
      assert.equal(u.client.posts.length, 2, 'still the same day');
      await hour(r, 2026, 10, 13, 0);
      assert.equal(u.client.posts.length, 3, 'a new UTC day says OK again');
      assert.equal(u.store.get('box-alerts')?.last_status, 'ok');
    });

    it('the once-a-day memory survives a restart', async () => {
      const r1 = u.make({ schedules: box });
      await r1.tick();
      u.daemon.next = { status: 'done', output: 'ALL_OK fine' };
      await hour(r1, 2026, 10, 12, 8);
      r1.stop();
      const r2 = u.restart({ schedules: box });
      await hour(r2, 2026, 10, 12, 9);
      r2.stop();
      assert.equal(u.client.posts.length, 1);
    });

    it('an ALL_OK that is not a single clean line is treated as a problem report and posted', async () => {
      const r = u.make({ schedules: box });
      await r.tick();
      u.daemon.next = { status: 'done', output: 'ALL_OK mostly\nbut backups are 3 days overdue' };
      await hour(r, 2026, 10, 12, 8);
      assert.match(u.client.posts[0]?.message ?? '', /backups are 3 days overdue/);
    });

    it('a manual run always posts, even an OK line, and does not use up the day', async () => {
      const r = u.make({ schedules: box });
      u.daemon.next = { status: 'done', output: 'ALL_OK fine' };
      const o = await r.runNow('box-alerts');
      assert.equal(o.kind, 'posted');
      assert.match(u.client.posts[0]?.message ?? '', /^\*\*Scheduled run: box-alerts\*\* \(manual run, 2026-10-12 07:59 UTC\)\n\nALL_OK fine$/);
      assert.equal(u.store.get('box-alerts'), undefined, 'manual leaves the state alone');
    });
  });

  describe('manual trigger', () => {
    it('runs now, in plan mode, waits for the outcome, and leaves the persisted schedule untouched', async () => {
      const r = u.make();
      await r.tick();
      const before = JSON.stringify(u.store.get('weekly-standup'));
      u.clock.t = utc(2026, 10, 12, 7, 59, 50);
      const o = await r.runNow('weekly-standup');
      assert.deepEqual(o, { kind: 'posted', runId: 'run-1' });
      assert.equal(u.daemon.calls[0]?.mode, 'plan');
      assert.match(u.client.posts[0]?.message ?? '', /\(manual run, 2026-10-12 07:59 UTC\)/);
      assert.equal(JSON.stringify(u.store.get('weekly-standup')), before);
    });

    it('works on a disabled schedule (that is how you test one) and refuses an unknown name', async () => {
      const r = u.make({ schedules: [{ ...STANDUP, enabled: false }] });
      assert.equal((await r.runNow('weekly-standup')).kind, 'posted');
      await assert.rejects(r.runNow('nope'), /no schedule named 'nope'; this bot has: weekly-standup/);
    });
  });

  describe('start()', () => {
    it('refuses to start on a channel the bot cannot see, naming the schedule', async () => {
      u.client.resolveError = new ChannelLookupError("channel '#rex-test' not found in any team the bot belongs to (is the bot a member?)", true);
      await assert.rejects(u.make().start(), /bot 'rex': schedule 'weekly-standup': channel '#rex-test' not found/);
    });

    it('a transient lookup failure does not stop the bridge; the channel is looked up again when due', async () => {
      u.client.resolveError = new ChannelLookupError('channel lookup failed: HTTP 500', false);
      const r = u.make();
      await r.start();
      assert.ok(u.logs.some((l) => /channel lookup failed.*will retry when it is due/.test(l)));
      u.client.resolveError = undefined;
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r.tick();
      await r.whenIdle();
      r.stop();
      assert.equal(u.client.posts.length, 1);
    });

    it('a channel that cannot be resolved when due logs a failure and does not run anything', async () => {
      const r = u.make();
      await r.tick();
      u.client.resolveError = new Error('mattermost down');
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      await r.tick();
      await r.whenIdle();
      assert.equal(u.daemon.calls.length, 0);
      assert.equal(u.store.get('weekly-standup')?.last_status, 'failed');
    });

    it('resolves a channel once and reuses it', async () => {
      const r = u.make();
      await r.start();
      await r.runNow('weekly-standup');
      await r.runNow('weekly-standup');
      r.stop();
      assert.deepEqual(u.client.resolveCalls, ['rex-test']);
    });

    it('a run a restart cut short is reported once and not retried', async () => {
      const r1 = u.make();
      await r1.tick();
      u.clock.t = utc(2026, 10, 12, 8, 0, 5);
      u.daemon.next = { status: 'running' };
      await r1.tick();
      await waitFor(() => u.daemon.calls.length === 1, 'started');
      await u.store.flushed();
      r1.stop(); // the bridge dies with in_flight on disk
      await r1.whenIdle();
      assert.equal(u.client.posts.length, 0);
      assert.equal(JSON.parse(readFileSync(u.statePath, 'utf8')).schedules['weekly-standup'].in_flight.run_id, 'run-1');

      u.clock.t = utc(2026, 10, 12, 8, 1, 0);
      const r2 = u.restart();
      await r2.start();
      await r2.whenIdle();
      r2.stop();
      assert.equal(u.client.posts.length, 1);
      assert.match(u.client.posts[0]?.message ?? '', /restarted while this run was in progress.*`run-1`.*not retried/s);
      assert.equal(u.daemon.calls.length, 1, 'not retried');
      assert.equal(u.store.get('weekly-standup')?.in_flight, undefined);
      assert.equal(u.store.get('weekly-standup')?.last_status, 'interrupted');
    });
  });

  it('a long result is chunked: the first part is the root post, the rest reply to it', async () => {
    u.daemon.next = { status: 'done', output: `${'line of text\n'.repeat(2000)}` };
    const r = u.make();
    await r.tick();
    u.clock.t = utc(2026, 10, 12, 8, 0, 5);
    await r.tick();
    await r.whenIdle();
    assert.ok(u.client.posts.length >= 2);
    assert.equal(u.client.posts[0]?.root, undefined);
    assert.ok(u.client.posts.slice(1).every((p) => p.root === 'post-1'));
    assert.ok(u.client.posts.every((p) => p.message.length <= 15_000));
  });
});

// ── through the real bridge, against the mocks ───────────────────────────────

describe('B4 through the bridge (mock Mattermost + mock daemon)', () => {
  let mm: MockMattermostServer;
  let daemon: MockDaemon;
  let dir: string;
  let mmUrl: string;
  let daemonUrl: string;
  const bridges: MattermostBridge[] = [];

  beforeEach(async () => {
    mm = new MockMattermostServer();
    daemon = new MockDaemon('t1', { username: 'rex', password: PASSWORD });
    mmUrl = await mm.listen();
    daemonUrl = await daemon.listen();
    dir = mkdtempSync(path.join(os.tmpdir(), 'mm-b4-int-'));
  });

  afterEach(async () => {
    for (const b of bridges.splice(0)) b.stop();
    await mm.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed the state so a `* * * * *` schedule has five missed minutes, and let the start-up catch-up fire it. */
  function seed(name = 'check'): void {
    writeFileSync(
      path.join(dir, 'schedules-rex.json'),
      JSON.stringify({ version: 1, schedules: { [name]: { last_slot: minuteFloor(Date.now()) - 5 * 60_000 } } }),
    );
  }

  const bridgeConfig = (over: Record<string, unknown> = {}) => ({
    name: 'rex',
    mattermostUrl: mmUrl,
    mattermostToken: 'mm-token',
    allowedUsers: ['alice'],
    allowedChannels: ['engineering', 'rex-test'],
    dataDir: dir,
    daemon: { url: daemonUrl, auth: { kind: 'session' as const, username: 'rex', password: PASSWORD } },
    chi: { engine: 'claude-code', cwd: '~/work/rex', systemPrompt: 'You are Rex.' },
    progress: FAST,
    scheduler: { tickMs: 600_000, lateGraceMs: 3_600_000 },
    schedules: [{ name: 'check', cron: '* * * * *', channel: 'rex-test', task: 'Check the box.' }],
    ...over,
  });

  const settleRuns = (output = 'The box is healthy.') => {
    const t = setInterval(() => {
      for (const run of daemon.runs.values()) if (run.status === 'running') daemon.settle(run.run_id, 'done', { output });
    }, 15);
    t.unref();
    return () => clearInterval(t);
  };

  const channelPosts = (id: string) => mm.receivedPosts.filter((p) => p.channel_id === id);

  it('plan mode and NO approval flow, even with approvals on (and a bypassPermissions acting mode)', async () => {
    seed();
    const stop = settleRuns();
    const b = new MattermostBridge(
      bridgeConfig({ approvals: { approvers: ['alice'], actingMode: 'bypassPermissions' } }) as never,
    );
    bridges.push(b);
    await b.start();
    await waitFor(() => channelPosts('c-rex-test').length >= 1, 'scheduled post');
    stop();
    await b.scheduler?.whenIdle();

    assert.equal(daemon.rpcCalls('chi_run').length, 1);
    assert.equal(daemon.runs.get('run-1')?.mode, 'plan');
    const posts = channelPosts('c-rex-test');
    assert.equal(posts.length, 1);
    assert.match(posts[0]?.message ?? '', /^\*\*Scheduled run: check\*\* \(.* UTC\)\n\nThe box is healthy\.$/);
    assert.equal(posts[0]?.root_id, undefined, 'a new root post');
    assert.ok(!mm.receivedPosts.some((p) => /Approval needed/i.test(p.message)), 'no approval post');
    assert.equal(b.approvals?.pendingCount(), 0, 'nothing is waiting for approval');
    const approvalsFile = path.join(dir, 'approvals-rex.json');
    if (existsSync(approvalsFile)) assert.deepEqual(JSON.parse(readFileSync(approvalsFile, 'utf8')).approvals, {});
    assert.ok(!existsSync(path.join(dir, 'threads-rex.json')), 'no thread record: nothing in the thread router can resume this run with other rights');
    // reaction on the post does nothing
    mm.broadcastReaction({ user_id: 'alice', post_id: posts[0]?.id as string, emoji_name: '+1' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(daemon.rpcCalls('chi_run').length, 1);
  });

  it('plan mode when approvals are off and chi.mode asks for more', async () => {
    seed();
    const stop = settleRuns();
    const b = new MattermostBridge(bridgeConfig({ chi: { engine: 'claude-code', mode: 'bypassPermissions' } }) as never);
    bridges.push(b);
    await b.start();
    await waitFor(() => channelPosts('c-rex-test').length >= 1, 'scheduled post');
    stop();
    assert.equal(daemon.runs.get('run-1')?.mode, 'plan');
  });

  it('a failed run posts a failure notice with the daemon error redacted', async () => {
    seed();
    const t = setInterval(() => {
      for (const run of daemon.runs.values()) {
        if (run.status === 'running') daemon.settle(run.run_id, 'failed', { error: `boom ${PASSWORD}` });
      }
    }, 15);
    const b = new MattermostBridge(bridgeConfig() as never);
    bridges.push(b);
    await b.start();
    await waitFor(() => channelPosts('c-rex-test').length >= 1, 'failure notice');
    clearInterval(t);
    const msg = channelPosts('c-rex-test')[0]?.message ?? '';
    assert.match(msg, /This scheduled run failed after/);
    assert.match(msg, /boom \[redacted\]/);
    assert.ok(!msg.includes(PASSWORD));
  });

  it('refuses to start when a schedule channel does not exist for the bot', async () => {
    mm.channels.delete('rex-test');
    const b = new MattermostBridge(bridgeConfig() as never);
    bridges.push(b);
    await assert.rejects(b.start(), /bot 'rex': schedule 'check': channel '#rex-test' not found/);
    assert.equal(b.isRunning(), false);
  });

  it('refuses at construction: bad cron, channel outside allowedChannels, duplicates', () => {
    assert.throws(() => new MattermostBridge(bridgeConfig({ schedules: [{ name: 'a', cron: 'nope', channel: 'rex-test', task: 't' }] }) as never), /invalid cron/);
    assert.throws(() => new MattermostBridge(bridgeConfig({ schedules: [{ name: 'a', cron: '* * * * *', channel: 'ruby-test', task: 't' }] }) as never), /unknown channel 'ruby-test'/);
    const dup = { name: 'a', cron: '* * * * *', channel: 'rex-test', task: 't' };
    assert.throws(() => new MattermostBridge(bridgeConfig({ schedules: [dup, dup] }) as never), /duplicate schedule name/);
  });
});

// ── the operator commands ────────────────────────────────────────────────────

describe('B4 CLI: --run-schedule and --list-schedules', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, 'bridge.ts');
  let mm: MockMattermostServer;
  let daemon: MockDaemon;
  let dir: string;
  let cfgPath: string;
  let timer: NodeJS.Timeout;

  beforeEach(async () => {
    mm = new MockMattermostServer();
    daemon = new MockDaemon('t1', { username: 'rex', password: PASSWORD });
    const mmUrl = await mm.listen();
    const daemonUrl = await daemon.listen();
    dir = mkdtempSync(path.join(os.tmpdir(), 'mm-b4-cli-'));
    cfgPath = path.join(dir, 'bridge.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mattermostUrl: mmUrl,
        dataDir: dir,
        bots: {
          rex: {
            mattermostToken: { value: 'mm-token' },
            allowedUsers: ['alice'],
            allowedChannels: ['engineering', 'rex-test'],
            daemon: { url: daemonUrl, auth: { kind: 'session', username: 'rex', password: { value: PASSWORD } } },
            chi: { engine: 'claude-code' },
            progress: FAST,
            schedules: [{ name: 'weekly', cron: '0 8 * * 1', channel: 'rex-test', task: 'Standup.' }],
          },
        },
      }),
    );
    timer = setInterval(() => {
      for (const run of daemon.runs.values()) if (run.status === 'running') daemon.settle(run.run_id, 'done', { output: 'cli result' });
    }, 15);
  });

  afterEach(async () => {
    clearInterval(timer);
    await mm.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function cli(...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
        cwd: path.join(here, '..'),
        env: { ...process.env, MATTERMOST_BRIDGE_CONFIG: cfgPath },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }

  it('--run-schedule posts once in plan mode, exits 0, and writes no scheduler state', async () => {
    const r = await cli('--run-schedule', 'rex/weekly');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /rex\/weekly: posted/);
    assert.equal(daemon.rpcCalls('chi_run').length, 1);
    assert.equal(daemon.runs.get('run-1')?.mode, 'plan');
    const posts = mm.receivedPosts.filter((p) => p.channel_id === 'c-rex-test');
    assert.equal(posts.length, 1);
    assert.match(posts[0]?.message ?? '', /^\*\*Scheduled run: weekly\*\* \(manual run, .* UTC\)\n\ncli result$/);
    assert.ok(!existsSync(path.join(dir, 'schedules-rex.json')), 'the real timetable is untouched');
  });

  it('--run-schedule with an unknown schedule or bot exits 2 and posts nothing', async () => {
    const a = await cli('--run-schedule', 'rex/nope');
    assert.equal(a.code, 2);
    assert.match(a.err, /no schedule named 'nope'/);
    const b = await cli('--run-schedule', 'ruby/weekly');
    assert.equal(b.code, 2);
    assert.match(b.err, /expects <bot>\/<schedule>; bots: rex/);
    assert.equal(mm.receivedPosts.length, 0);
  });

  it('--list-schedules prints each schedule with its next due time and runs nothing', async () => {
    const r = await cli('--list-schedules');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^rex\/weekly\tnext 20\d\d-\d\d-\d\dT08:00:00\.000Z$/m);
    assert.equal(daemon.rpcCalls('chi_run').length, 0);
  });
});

// ── the shipped example ──────────────────────────────────────────────────────

describe('B4 bridge.example.json', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  /** Swap every `{env}` / `{file}` secret for a literal, so the example loads without the host's secrets. */
  const literal = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(literal);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (('env' in o || 'file' in o) && Object.keys(o).length === 1) return { value: 'example-secret' };
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, literal(x)]));
    }
    return v;
  };

  it('loads, and carries the three duties on the side-by-side test channels', () => {
    const raw = JSON.parse(readFileSync(path.join(here, '..', 'bridge.example.json'), 'utf8')) as BridgeFileConfig;
    const cfgs = resolveBridgeConfigs(literal(raw) as BridgeFileConfig);
    const by = (bot: string, name: string) => cfgs.find((c) => c.name === bot)?.schedules?.find((s) => s.name === name);

    assert.equal(by('rex', 'weekly-standup')?.cron, '0 8 * * 1');
    assert.equal(by('ruby', 'daily-reply-digest')?.cron, '0 7 * * *');
    assert.equal(by('rex', 'box-alerts')?.quiet, true);
    assert.equal(by('rex', 'weekly-standup')?.channel, 'rex-test');
    assert.equal(by('rex', 'box-alerts')?.channel, 'rex-test');
    assert.equal(by('ruby', 'daily-reply-digest')?.channel, 'ruby-test');
    // Rex has approvals on AND schedules: the schedules still never use them (see the bridge tests above)
    assert.ok(cfgs.find((c) => c.name === 'rex')?.approvals);

    // the old yaml's digest text, kept as is
    assert.ok(by('ruby', 'daily-reply-digest')?.task.startsWith('Produce the daily Ruby re-engagement digest. Query email_drafts for the last 24h'));
    assert.match(by('rex', 'box-alerts')?.task ?? '', /chi_list/);
  });
});
