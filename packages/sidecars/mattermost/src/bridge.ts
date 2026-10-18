import path from 'node:path';
import { AuditChannelOverlapError, AuditLog, AuditMirror, assertAuditChannelWriteOnly, auditPath, resolveAuditConfig } from './audit.js';
import { runAuditCli } from './audit-cli.js';
import type { ResolvedAuditConfig } from './audit.js';
import { ApprovalManager, ApprovalStore, resolveApprovals } from './approvals.js';
import { ChannelLookupError, MattermostClient } from './client.js';
import type { MattermostClientTiming } from './client.js';
import { loadBridgeSetup, defaultDataDir } from './config.js';
import { DaemonClient } from './daemon.js';
import { MattermostGate } from './gate.js';
import { Rails, effectiveMode, resolveBranchPrefix, resolveModeRails } from './rails.js';
import { Redactor } from './secrets.js';
import { RunGate, resolveLimits } from './run-gate.js';
import { ScheduleRunner, ScheduleStore, resolveSchedules } from './schedules.js';
import type { RunOutcome } from './schedules.js';
import { ThreadRouter } from './sessions.js';
import { ThreadStore } from './store.js';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent, MattermostReaction } from './types.js';

export class MattermostBridge {
  readonly config: MattermostBridgeConfig;
  readonly client: MattermostClient;
  readonly gate: MattermostGate;
  readonly echoPrefix: string;
  /** Present when the bot is configured for Chi runs (B2); absent means B1 echo. */
  readonly router?: ThreadRouter;
  readonly daemon?: DaemonClient;
  /** Present when the bot has an `approvals` block (B3). */
  readonly approvals?: ApprovalManager;
  /** Present when the bot has `schedules` (B4). Never given the approval manager: scheduled runs are always read-only. */
  readonly scheduler?: ScheduleRunner;
  /** B5: the bot's audit log. Always present, for echo bots too (gate denials, config load). */
  readonly audit: AuditLog;
  /** B5: mode ceiling + audit choke point for every Chi run. Present when the bot runs Chi (B2+). */
  readonly rails?: Rails;
  /** The bridge-wide cap on Chi runs in flight. One per process, handed to every bot; a bot built alone gets its own. */
  readonly runGate: RunGate;
  private readonly auditCfg: ResolvedAuditConfig;
  private auditMirror?: AuditMirror;
  private running = false;
  /** Bumped by `stop()`: a `start()` that was already in progress notices it and winds down instead of finishing. */
  private epoch = 0;

  /**
   * `opts.reserveRecovered` (default true) takes slots for runs a restart found still going while the bridge is being
   * built, i.e. for every bot before any of them starts, so the cap holds however the starts interleave. The
   * one-shot operator commands (`--run-schedule`) are a separate process from the running bridge and pass `false`.
   */
  constructor(config: MattermostBridgeConfig, clientTiming?: MattermostClientTiming, runGate?: RunGate, opts: { reserveRecovered?: boolean } = {}) {
    this.config = config;
    this.runGate = runGate ?? new RunGate({ max: resolveLimits(undefined).maxConcurrentRuns });
    this.echoPrefix = config.echoPrefix ?? 'echo: ';
    this.gate = new MattermostGate(config);
    this.client = new MattermostClient(config, clientTiming);

    const botName = config.name ?? 'bot';
    const botWhere = `bot '${botName}'`;
    // B5: refuse, before anything starts, a mode above the ceiling (default `plan`), a bad branch prefix or audit block.
    const modes = resolveModeRails(config, botWhere);
    const branchPrefix = resolveBranchPrefix(config.branchPrefix, botWhere);
    this.auditCfg = resolveAuditConfig(config.audit, botWhere, config.allowedChannels);
    const redactor = new Redactor();
    redactor.add(config.mattermostToken);
    const dAuth = config.daemon?.auth;
    if (dAuth) redactor.add(dAuth.kind === 'session' ? dAuth.password : dAuth.token);
    this.audit = new AuditLog({
      file: auditPath(config.dataDir ?? defaultDataDir(), botName, this.auditCfg.path),
      bot: botName,
      maxBytes: this.auditCfg.maxBytes,
      keep: this.auditCfg.keep,
      redact: (t) => redactor.redact(t),
    });

    if (config.daemon && config.chi) {
      const name = botName;
      this.rails = new Rails({
        bot: name,
        maxMode: modes.maxMode,
        threadMode: modes.threadMode,
        actingMode: modes.actingMode,
        branchPrefix,
        promptHash: this.auditCfg.promptHash,
        audit: this.audit,
      });
      this.daemon = new DaemonClient(config.daemon);
      const store = new ThreadStore(
        config.storePath ?? path.join(config.dataDir ?? defaultDataDir(), `threads-${name}.json`),
        name,
        config.retentionMs,
      );
      let gate: { manager: ApprovalManager; actingMode: string } | undefined;
      if (config.approvals) {
        const where = `bot '${name}'`;
        const resolved = resolveApprovals(config.approvals, where);
        // The daemon takes the mode of a run from `chi.mode`; under approvals the bridge owns it.
        if (config.chi.mode) {
          throw new Error(`${where}: chi.mode is ignored under approvals; set approvals.actingMode instead`);
        }
        this.approvals = new ApprovalManager({
          bot: name,
          client: this.client,
          store: new ApprovalStore(path.join(config.dataDir ?? defaultDataDir(), `approvals-${name}.json`), name),
          approvals: resolved,
          onApproved: (rec, approver) => this.router?.runApproved(rec, approver) ?? Promise.resolve(),
          audit: this.audit,
        });
        // The daemon id of the acting mode (`auto` for acceptEdits), already checked against maxMode above.
        gate = { manager: this.approvals, actingMode: modes.actingMode ?? resolved.actingMode };
      }
      this.router = new ThreadRouter({
        bot: name,
        client: this.client,
        daemon: this.daemon,
        store,
        chi: config.chi,
        rails: this.rails,
        runGate: this.runGate,
        progress: config.progress,
        approvals: gate,
      });
      if (config.schedules?.length) {
        const where = `bot '${name}'`;
        this.scheduler = new ScheduleRunner({
          bot: name,
          schedules: resolveSchedules(config.schedules, where, config.allowedChannels),
          client: this.client,
          daemon: this.daemon,
          store: new ScheduleStore(
            config.schedulesPath ?? path.join(config.dataDir ?? defaultDataDir(), `schedules-${name}.json`),
          ),
          chi: config.chi,
          rails: this.rails,
          runGate: this.runGate,
          progress: config.progress,
          scheduler: config.scheduler,
        });
      }
    } else if (config.approvals) {
      throw new Error(`bot '${config.name ?? 'bot'}': approvals needs daemon and chi (B2) to be configured`);
    } else if (config.schedules?.length) {
      throw new Error(`bot '${config.name ?? 'bot'}': schedules needs daemon and chi (B2) to be configured`);
    }
    if (opts.reserveRecovered !== false) this.reserveRecovered();
  }

  /**
   * Count, against the bridge-wide cap, every run a restart found still going (thread runs and schedule runs). Sync and
   * idempotent. Without this a bot that finishes starting first would find an empty gate and start new runs on top of
   * the ones another bot has not re-attached yet.
   */
  reserveRecovered(): void {
    this.router?.reserveRecovered();
    this.scheduler?.reserveRecovered();
  }

  /**
   * Run one schedule now, by hand (`--run-schedule`). Does not need `start()` (no websocket) and leaves the persisted
   * scheduler state alone, so it never disturbs the real timetable.
   */
  async runScheduleNow(name: string): Promise<RunOutcome> {
    if (!this.scheduler) throw new Error(`bot '${this.config.name ?? 'bot'}' has no schedules`);
    const outcome = await this.scheduler.runNow(name);
    await this.scheduler.whenIdle();
    return outcome;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.reserveRecovered(); // sync, before the first await (a no-op when the constructor already did it)
    // Follow schedule survivors from the very first moment, on their own: their slots must come back when those runs end
    // whatever the other startup steps (a reaction decided while down, an audit-channel lookup) are waiting for.
    void this.scheduler?.followRecovered();
    try {
      await this.startInner(this.epoch);
    } catch (err) {
      // A bot that failed to start follows nothing: its reserved slots must not keep other bots' work queued.
      this.router?.releaseReserved();
      this.scheduler?.releaseReserved();
      throw err;
    }
  }

  private async startInner(epoch: number): Promise<void> {
    // `stop()` ran while this start was still awaiting something: it has already closed everything it could reach.
    const stopped = () => this.epoch !== epoch;

    // Fetch bot profile to ignore own messages
    try {
      const me = await this.client.getMe();
      if (me?.id) {
        this.gate.setBotUserId(me.id);
        this.approvals?.setBotUserId(me.id);
      }
      if (me?.username) this.router?.setBotUsername(me.username);
    } catch (err) {
      // If getMe fails or botUserId was provided in config, fallback
      if (this.config.botUserId) {
        this.gate.setBotUserId(this.config.botUserId);
        this.approvals?.setBotUserId(this.config.botUserId);
      }
    }

    if (stopped()) return;

    // Websocket health goes in the log: a bot that silently stops hearing Mattermost is the worst failure mode. The
    // client reconnects by itself; these lines are only the record of it. Attached before the first connect so a
    // failed first connect rejects `connect()` instead of throwing an unhandled 'error' event.
    this.attachConnectionLogging();

    // Connect WebSocket. REST calls (replies, schedules, approvals) never go through it, so they keep working while it
    // is down and being re-established.
    await this.client.connect();
    if (stopped()) return;

    // B5: optional off-box copy of the audit trail. A channel Mattermost does not know refuses the start (a mirror that
    // silently goes nowhere is worse than none); a transient error only logs and the lines retry on the next record.
    if (this.auditCfg.channel) {
      const ref = this.auditCfg.channel;
      let channelId: string | undefined;
      const botWhere = `bot '${this.config.name ?? 'bot'}'`;
      const resolve = async () => {
        if (channelId) return channelId;
        const id = await this.client.resolveChannelId(ref);
        // Names are compared at config load; whether two spellings are one channel is only known now.
        await assertAuditChannelWriteOnly(
          id,
          ref,
          this.config.allowedChannels,
          async (r) => {
            try {
              return await this.client.resolveChannelId(r);
            } catch (err) {
              if (err instanceof ChannelLookupError && err.notFound) return undefined;
              throw err;
            }
          },
          botWhere,
        );
        return (channelId = id);
      };
      try {
        await resolve();
      } catch (err) {
        if (err instanceof AuditChannelOverlapError) {
          this.client.close();
          throw err;
        }
        if (err instanceof ChannelLookupError && err.notFound) {
          this.client.close();
          throw new Error(`bot '${this.config.name ?? 'bot'}': audit.channel: ${err.message}`);
        }
        console.error(`[mattermost:${this.config.name ?? 'bot'}] audit channel lookup failed (${(err as Error).message}); will retry`);
      }
      if (stopped()) return;
      this.auditMirror = new AuditMirror(async (text) => {
        await this.client.reply(await resolve(), text);
      });
      const mirror = this.auditMirror;
      this.audit.setSink((rec) => mirror.push(rec));
    }

    // B5: nothing runs unless the audit log is writable. Same rule as every run: no record, no action.
    const cfg = this.config;
    try {
      this.audit.must('config.loaded', {
        max_mode: this.rails?.maxMode,
        // The modes ASKED for. They bind only on an engine that enforces modes (claude-code); `*_effective` is what applies.
        thread_mode: this.rails?.threadMode,
        acting_mode: this.rails?.actingMode,
        engine: cfg.chi?.engine,
        thread_mode_effective: cfg.chi ? effectiveMode(cfg.chi.engine, this.rails?.threadMode) : undefined,
        acting_mode_effective: cfg.chi && this.rails?.actingMode ? effectiveMode(cfg.chi.engine, this.rails.actingMode) : undefined,
        schedule_engines: cfg.schedules?.map((x) => x.engine ?? cfg.chi?.engine ?? ''),
        approvals: Boolean(this.approvals),
        approvers: cfg.approvals?.approvers?.length,
        schedules: cfg.schedules?.map((x) => x.name),
        branch_prefix: this.rails?.branchPrefix,
        allowed_users: cfg.allowedUsers.length,
        allowed_channels: cfg.allowedChannels.length,
        audit_channel: Boolean(this.auditCfg.channel),
        prompt_hash: this.auditCfg.promptHash,
        chi: Boolean(this.router),
      });
    } catch (err) {
      this.audit.setSink(undefined);
      this.client.close();
      throw err;
    }

    this.client.on('post', async (event: MattermostPostEvent, post: MattermostPost) => {
      const gateResult = this.gate.check(event, post);
      if (!gateResult.allowed) {
        // B5: a refusal is recorded (who and where, never what they said). The bot's own posts and system posts are not refusals.
        const code = gateResult.code;
        if (code && code !== 'own_post' && code !== 'system_post') {
          const userName = event.data?.sender_name?.replace(/^@/, '') || undefined;
          const channelName = event.data?.channel_name || undefined;
          this.audit.recordCoalesced(`${code}|${post.user_id}|${post.channel_id}`, 'gate.denied', {
            reason: code,
            user_id: post.user_id,
            user_name: userName,
            channel_id: post.channel_id,
            channel_name: channelName,
          });
        }
        return;
      }

      if (this.router) {
        // The gate has already run: everything below is for allowed users in allowed channels.
        try {
          await this.router.handle(post, { id: post.user_id, name: event.data?.sender_name?.replace(/^@/, '') || undefined });
        } catch (err) {
          console.error('Failed to route post:', err instanceof Error ? err.message : err);
        }
        return;
      }

      try {
        const replyText = `${this.echoPrefix}${post.message}`;
        const targetRootId = post.root_id || post.id;
        await this.client.reply(post.channel_id, replyText, targetRootId);
      } catch (err) {
        console.error('Failed to send echo reply:', err);
      }
    });

    // Reactions are not post events, so the post gate does not see them: the approver
    // list inside the manager is their gate (separate from `allowedUsers`).
    if (this.approvals) {
      const approvals = this.approvals;
      this.client.on('reaction', (reaction: MattermostReaction) => {
        approvals.handleReaction(reaction).catch((err) => {
          console.error('Failed to handle reaction:', err instanceof Error ? err.message : err);
        });
      });
    }

    if (stopped()) {
      this.client.close();
      return;
    }
    this.router?.recover();
    // A decision made while the bridge was down starts its approved run in the background (it may have to queue for a
    // slot), so this never waits on the gate.
    await this.approvals?.recover().catch((err) => {
      console.error('Failed to recover approvals:', err instanceof Error ? err.message : err);
    });
    if (stopped()) return; // no scheduler.start(), no timers
    // B4: refuses to start on an unknown schedule channel; catches up at most one missed occurrence per schedule.
    try {
      await this.scheduler?.start();
    } catch (err) {
      this.stop();
      throw err;
    }
    if (stopped()) return;
    this.running = true;
  }

  private loggingAttached = false;

  private attachConnectionLogging(): void {
    if (this.loggingAttached) return;
    this.loggingAttached = true;
    const tag = `[mattermost:${this.config.name ?? 'bot'}]`;
    this.client.on('error', (err) => console.error(`${tag} websocket error: ${err.message}`));
    this.client.on('close', (code, reason, expected) => {
      if (!expected) console.error(`${tag} websocket closed unexpectedly (code ${code}, reason ${reason ? JSON.stringify(reason) : 'none'}); reconnecting`);
    });
    this.client.on('reconnecting', (attempt, delayMs) => {
      console.error(`${tag} websocket reconnect attempt ${attempt} in ${delayMs} ms`);
    });
    this.client.on('reconnected', (attempt) => {
      console.log(`${tag} websocket reconnected (attempt ${attempt})`);
    });
  }

  stop(): void {
    this.epoch += 1;
    this.running = false;
    this.audit.setSink(undefined);
    this.router?.stop();
    this.approvals?.stop();
    this.scheduler?.stop();
    this.client.close();
  }

  isRunning(): boolean {
    return this.running;
  }
}

interface CliArgs {
  runSchedule?: string;
  listSchedules: boolean;
  /** `--audit <bot>` (B5). */
  audit?: string;
  since?: string;
  verify: boolean;
}

/** `--run-schedule <bot>/<name>`, `--list-schedules` and `--audit <bot>`: operator commands that never start the websocket. */
function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = { listSchedules: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--list-schedules') out.listSchedules = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--audit' || a === '--since') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(`error: ${a} needs a value`);
        process.exit(2);
      }
      if (a === '--audit') out.audit = v;
      else out.since = v;
    } else if (a.startsWith('--audit=')) out.audit = a.slice('--audit='.length);
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a === '--run-schedule') {
      const v = argv[++i];
      if (!v) {
        console.error('error: --run-schedule needs <bot>/<schedule>');
        process.exit(2);
      }
      out.runSchedule = v;
    } else if (a.startsWith('--run-schedule=')) out.runSchedule = a.slice('--run-schedule='.length);
  }
  return out;
}

/** Operator commands. Returns the process exit code. */
async function runOperatorCommand(bridges: MattermostBridge[], cli: CliArgs): Promise<number> {
  if (cli.listSchedules) {
    for (const b of bridges) {
      for (const name of b.scheduler?.names() ?? []) {
        const next = b.scheduler?.nextDue(name);
        console.log(`${b.config.name ?? 'bot'}/${name}\tnext ${next ? new Date(next).toISOString() : 'never'}`);
      }
    }
    return 0;
  }
  const [botName, ...rest] = (cli.runSchedule as string).split('/');
  const schedule = rest.join('/');
  const bridge = bridges.find((b) => (b.config.name ?? 'bot') === botName);
  if (!bridge || !schedule) {
    console.error(`error: --run-schedule expects <bot>/<schedule>; bots: ${bridges.map((b) => b.config.name ?? 'bot').join(', ')}`);
    return 2;
  }
  try {
    const outcome = await bridge.runScheduleNow(schedule);
    console.log(`${botName}/${schedule}: ${outcome.kind}${'reason' in outcome ? ` (${outcome.reason})` : ''}`);
    return outcome.kind === 'posted' || outcome.kind === 'quiet' ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
}

/**
 * Never exit 0 silently while the bridge should be running. The websocket client reconnects forever and holds a timer
 * while it does, so an empty event loop means something is badly wrong (this is how the 2026-10-16 incident ended: the
 * bots had gone deaf, nothing held the loop, node exited 0 and `Restart=on-failure` did not restart it). `beforeExit`
 * fires exactly when the loop has drained; a deliberate shutdown calls `process.exit()` and never gets here.
 */
export function installExitGuard(proc: Pick<NodeJS.Process, 'on' | 'exitCode'>, log: (line: string) => void = console.error): void {
  proc.on('beforeExit', () => {
    log('Mattermost bridge: nothing left to wait on but it should still be running (all bots gave up?); exiting non-zero so the supervisor restarts it');
    proc.exitCode = 1;
  });
}

// Sidecar CLI entry point when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const bridges: MattermostBridge[] = [];
  let runGate: RunGate | undefined;
  const configFile = process.env.MATTERMOST_BRIDGE_CONFIG;
  const cli = parseCli(process.argv.slice(2));
  const operator = Boolean(cli.runSchedule) || cli.listSchedules;

  if (cli.audit) {
    // Reads the audit file only: no secrets resolved, no bridge constructed, nothing written.
    process.exit(runAuditCli(configFile, { bot: cli.audit, since: cli.since, verify: cli.verify }, { out: (l) => console.log(l), err: (l) => console.error(l) }));
  }

  try {
    if (configFile) {
      // One gate for the whole process: every bot's runs count against the same cap.
      const setup = loadBridgeSetup(configFile);
      runGate = new RunGate({ max: setup.limits.maxConcurrentRuns });
      for (const cfg of setup.bots) bridges.push(new MattermostBridge(cfg, undefined, runGate, { reserveRecovered: !operator }));
    } else if (operator) {
      console.error('error: --run-schedule and --list-schedules need MATTERMOST_BRIDGE_CONFIG');
      process.exit(2);
    } else {
      // B1 fallback: a single echo bot configured from the environment.
      const token = process.env.MATTERMOST_TOKEN || '';
      if (!token) {
        console.error('error: set MATTERMOST_BRIDGE_CONFIG (B2) or MATTERMOST_TOKEN (B1 echo)');
        process.exit(1);
      }
      bridges.push(
        new MattermostBridge({
          mattermostUrl: process.env.MATTERMOST_URL || 'http://localhost:8065',
          mattermostToken: token,
          allowedUsers: (process.env.MATTERMOST_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
          allowedChannels: (process.env.MATTERMOST_ALLOWED_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean),
        }),
      );
    }
  } catch (err) {
    console.error('Bridge config error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (operator) {
    runOperatorCommand(bridges, cli).then((code) => process.exit(code));
  } else {
    Promise.all(bridges.map((b) => b.start()))
      .then(() => console.log(`Mattermost bridge started (${bridges.length} bot${bridges.length === 1 ? '' : 's'})`))
      .catch((err) => {
        console.error('Bridge failed to start:', err instanceof Error ? err.message : err);
        process.exit(1);
      });

    installExitGuard(process);

    const shutdown = () => {
      runGate?.close();
      for (const b of bridges) b.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
